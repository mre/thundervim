export type ExAction = "save" | "quit" | "save-quit" | "send";

export interface ExRange {
  start: number;
  end: number;
}

export interface ExContext {
  text: string;
  cursor: number;
  textwidth: number;
  shiftwidth: number;
  hlsearch: boolean;
  visualRange?: ExRange;
}

export interface ExEdit {
  start: number;
  end: number;
  replacement: string;
}

export interface ExSuccess extends ExContext {
  ok: true;
  action: ExAction | null;
  message: string;
  substitutions: number;
  edits: ExEdit[];
}

export interface ExFailure {
  ok: false;
  message: string;
}

export type ExResult = ExSuccess | ExFailure;

type RangeKind = "current" | "all" | "visual";

interface Substitution {
  range: RangeKind;
  pattern: string;
  replacement: string;
  global: boolean;
  ignoreCase: boolean;
}

function success(
  context: ExContext,
  overrides: Partial<ExSuccess> = {},
): ExSuccess {
  return {
    ...context,
    ok: true,
    action: null,
    message: "",
    substitutions: 0,
    edits: [],
    ...overrides,
  };
}

function failure(message: string): ExFailure {
  return { ok: false, message };
}

function lineStartAt(text: string, pos: number): number {
  return text.lastIndexOf("\n", Math.max(0, pos) - 1) + 1;
}

function lineEndAt(text: string, pos: number): number {
  const end = text.indexOf("\n", Math.max(0, pos));
  return end === -1 ? text.length : end;
}

function commandRange(
  context: ExContext,
  range: RangeKind,
): ExRange | ExFailure {
  if (range === "all") return { start: 0, end: context.text.length };
  if (range === "visual") {
    if (!context.visualRange) return failure("E20: Mark not set");
    const lo = Math.max(
      0,
      Math.min(context.visualRange.start, context.visualRange.end),
    );
    const hi = Math.min(
      context.text.length,
      Math.max(context.visualRange.start, context.visualRange.end),
    );
    const lastSelected = Math.max(lo, hi - 1);
    return {
      start: lineStartAt(context.text, lo),
      end: lineEndAt(context.text, lastSelected),
    };
  }
  return {
    start: lineStartAt(context.text, context.cursor),
    end: lineEndAt(context.text, context.cursor),
  };
}

function readDelimited(
  input: string,
  start: number,
  delimiter: string,
  allowEnd = false,
): { value: string; next: number; terminated: boolean } | null {
  let value = "";
  for (let index = start; index < input.length; index++) {
    const char = input[index];
    if (char === delimiter) {
      return { value, next: index + 1, terminated: true };
    }
    if (char === "\\" && index + 1 < input.length) {
      const next = input[index + 1];
      if (next === delimiter) {
        value += delimiter;
        index++;
        continue;
      }
      value += char + next;
      index++;
      continue;
    }
    value += char;
  }
  return allowEnd
    ? { value, next: input.length, terminated: false }
    : null;
}

function parseSubstitution(command: string): Substitution | ExFailure | null {
  let range: RangeKind = "current";
  let rest = command;
  if (rest.startsWith("%")) {
    range = "all";
    rest = rest.slice(1);
  } else if (rest.startsWith("'<,'>")) {
    range = "visual";
    rest = rest.slice(5);
  }

  if (!rest.startsWith("s")) return null;
  const delimiter = rest[1];
  if (!delimiter || /[A-Za-z0-9\\"|\s]/.test(delimiter)) return null;

  const pattern = readDelimited(rest, 2, delimiter);
  if (!pattern) return failure("E488: Trailing characters");
  const replacement = readDelimited(rest, pattern.next, delimiter, true);
  if (!replacement) return failure("E488: Trailing characters");

  const flags = replacement.terminated ? rest.slice(replacement.next) : "";
  if (
    /[^gi]/.test(flags) ||
    new Set(flags).size !== flags.length
  ) {
    return failure(`E488: Trailing characters: ${flags}`);
  }
  return {
    range,
    pattern: pattern.value,
    replacement: replacement.value,
    global: flags.includes("g"),
    ignoreCase: flags.includes("i"),
  };
}

function expandReplacement(
  replacement: string,
  match: RegExpExecArray,
): string {
  let result = "";
  for (let index = 0; index < replacement.length; index++) {
    const char = replacement[index];
    if (char === "\\" && index + 1 < replacement.length) {
      const next = replacement[index + 1];
      if (next === "\\") {
        result += "\\";
        index++;
        continue;
      }
      if (/[0-9]/.test(next)) {
        result += match[Number.parseInt(next, 10)] ?? "";
        index++;
        continue;
      }
      if (next === "&") {
        result += "&";
        index++;
        continue;
      }
    }
    result += char === "&" ? match[0] : char;
  }
  return result;
}

function collectLineEdits(
  line: string,
  lineStart: number,
  substitution: Substitution,
): ExEdit[] {
  const flags = "g" + (substitution.ignoreCase ? "i" : "");
  const regex = new RegExp(substitution.pattern, flags);
  const edits: ExEdit[] = [];
  for (const match of line.matchAll(regex)) {
    const index = match.index;
    edits.push({
      start: lineStart + index,
      end: lineStart + index + match[0].length,
      replacement: expandReplacement(substitution.replacement, match),
    });
    if (!substitution.global) break;
  }
  return edits;
}

function runSubstitution(
  substitution: Substitution,
  context: ExContext,
): ExResult {
  if (!substitution.pattern) return failure("E486: Pattern not found");
  try {
    new RegExp(substitution.pattern);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(`Invalid pattern: ${detail}`);
  }

  const range = commandRange(context, substitution.range);
  if ("ok" in range) return range;

  const selected = context.text.slice(range.start, range.end);
  const edits: ExEdit[] = [];
  let lineStart = range.start;
  for (const line of selected.split("\n")) {
    edits.push(...collectLineEdits(line, lineStart, substitution));
    lineStart += line.length + 1;
  }

  let text = context.text;
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index];
    text =
      text.slice(0, edit.start) +
      edit.replacement +
      text.slice(edit.end);
  }
  const substitutions = edits.length;
  const message =
    substitutions === 0
      ? `Pattern not found: ${substitution.pattern}`
      : substitutions === 1
        ? "1 substitution"
        : `${substitutions} substitutions`;
  return success(context, {
    text,
    cursor: Math.min(context.cursor, text.length),
    message,
    substitutions,
    edits,
  });
}

function setOption(command: string, context: ExContext): ExResult {
  const argument = command.slice(3).trim();
  if (!argument) {
    return success(context, {
      message: `textwidth=${context.textwidth}  shiftwidth=${context.shiftwidth}`,
    });
  }

  const query = /^(textwidth|tw|shiftwidth|sw)\?$/.exec(argument);
  if (query) {
    const option = query[1] === "tw" ? "textwidth" : query[1] === "sw" ? "shiftwidth" : query[1];
    const value = option === "textwidth" ? context.textwidth : context.shiftwidth;
    return success(context, { message: `${option}=${value}` });
  }

  const assignment = /^(textwidth|tw|shiftwidth|sw)=(\d+)$/.exec(argument);
  if (!assignment) return failure(`E518: Unknown option: ${argument}`);
  const option = assignment[1] === "tw" ? "textwidth" : assignment[1] === "sw" ? "shiftwidth" : assignment[1];
  const value = Number.parseInt(assignment[2], 10);
  if (option === "textwidth" && (value < 20 || value > 200)) {
    return failure("textwidth must be between 20 and 200");
  }
  if (option === "shiftwidth" && (value < 1 || value > 16)) {
    return failure("shiftwidth must be between 1 and 16");
  }
  return success(context, {
    [option]: value,
    message: `${option}=${value}`,
  });
}

export function executeEx(rawCommand: string, context: ExContext): ExResult {
  const command = rawCommand.trim().replace(/^:/, "").trim();
  if (!command) return failure("E492: Not an editor command");

  const actions: Record<string, { action: ExAction; message: string }> = {
    w: { action: "save", message: "Draft saved" },
    write: { action: "save", message: "Draft saved" },
    q: { action: "quit", message: "" },
    quit: { action: "quit", message: "" },
    wq: { action: "save-quit", message: "" },
    send: { action: "send", message: "" },
  };
  const action = actions[command];
  if (action) return success(context, action);
  if (/^write\s+/.test(command)) {
    return failure(`E488: Trailing characters: ${command.slice(6).trim()}`);
  }
  if (command === "noh" || command === "nohlsearch") {
    return success(context, { hlsearch: false });
  }
  if (command === "set" || command.startsWith("set ")) {
    return setOption(command, context);
  }

  const substitution = parseSubstitution(command);
  if (substitution) {
    if ("ok" in substitution) return substitution;
    return runSubstitution(substitution, context);
  }

  return failure(`E492: Not an editor command: ${command}`);
}
