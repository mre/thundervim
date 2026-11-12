/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import {
  executeEx,
  type ExContext,
  type ExSuccess,
} from "../src/ex.ts";

function context(overrides: Partial<ExContext> = {}): ExContext {
  return {
    text: "one two one\nthree two three\nfour two four",
    cursor: 0,
    textwidth: 72,
    shiftwidth: 4,
    hlsearch: true,
    ...overrides,
  };
}

function success(command: string, ctx = context()): ExSuccess {
  const result = executeEx(command, ctx);
  assert.strictEqual(result.ok, true, result.message);
  return result;
}

test(":s replaces the first match on the current line", () => {
  const result = success("s/one/ONE/", context({ cursor: 4 }));
  assert.strictEqual(result.text, "ONE two one\nthree two three\nfour two four");
  assert.strictEqual(result.substitutions, 1);
});

test(":s with g replaces every match on the current line as discrete edits", () => {
  const result = success("s/one/ONE/g");
  assert.strictEqual(result.text, "ONE two ONE\nthree two three\nfour two four");
  assert.strictEqual(result.substitutions, 2);
  assert.deepStrictEqual(result.edits, [
    { start: 0, end: 3, replacement: "ONE" },
    { start: 8, end: 11, replacement: "ONE" },
  ]);
});

test(":%s without g replaces the first match on every line", () => {
  const result = success("%s/two/TWO/");
  assert.strictEqual(result.text, "one TWO one\nthree TWO three\nfour TWO four");
  assert.strictEqual(result.substitutions, 3);
});

test(":'<,'>s applies to every line touched by the visual selection", () => {
  const result = success(
    "'<,'>s/two/TWO/g",
    context({ visualRange: { start: 5, end: 28 } }),
  );
  assert.strictEqual(result.text, "one TWO one\nthree TWO three\nfour two four");
  assert.strictEqual(result.substitutions, 2);
});

test("substitution supports escaped delimiters and replacement groups", () => {
  const result = success(
    String.raw`s/https:\/\/(\w+)/[\1]/g`,
    context({ text: "https://one https://two", cursor: 0 }),
  );
  assert.strictEqual(result.text, "[one] [two]");
});

test("substitution supports an alternate delimiter", () => {
  const result = success(
    "s#one/two#done#",
    context({ text: "one/two", cursor: 0 }),
  );
  assert.strictEqual(result.text, "done");
});

test("substitution accepts an omitted trailing delimiter", () => {
  const result = success(
    "s/one/ONE",
    context({ text: "one two", cursor: 0 }),
  );
  assert.strictEqual(result.text, "ONE two");
});

test("substitution can insert a literal backslash", () => {
  const result = success(
    String.raw`s#x#\\#`,
    context({ text: "x", cursor: 0 }),
  );
  assert.strictEqual(result.text, "\\");
});

test("substitution rejects duplicate flags without throwing", () => {
  const result = executeEx("s/one/ONE/gg", context());
  assert.deepStrictEqual(result, {
    ok: false,
    message: "E488: Trailing characters: gg",
  });
});

test("substitution reports invalid patterns without changing text", () => {
  const ctx = context();
  const result = executeEx("s/[/x/", ctx);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /^Invalid pattern:/);
  assert.strictEqual(ctx.text, context().text);
});

test("substitution reports a missing visual range", () => {
  const result = executeEx("'<,'>s/two/TWO/", context());
  assert.deepStrictEqual(result, {
    ok: false,
    message: "E20: Mark not set",
  });
});

test("substitution reports when the pattern was not found", () => {
  const result = success("%s/missing/replacement/");
  assert.strictEqual(result.text, context().text);
  assert.strictEqual(result.substitutions, 0);
  assert.strictEqual(result.message, "Pattern not found: missing");
});

test(":set changes compose-local textwidth and shiftwidth", () => {
  const tw = success("set textwidth=80");
  assert.strictEqual(tw.textwidth, 80);
  assert.strictEqual(tw.message, "textwidth=80");

  const sw = success("set sw=2", { ...context(), ...tw });
  assert.strictEqual(sw.shiftwidth, 2);
  assert.strictEqual(sw.message, "shiftwidth=2");
});

test(":set queries settings using long and short names", () => {
  assert.strictEqual(success("set tw?").message, "textwidth=72");
  assert.strictEqual(success("set shiftwidth?").message, "shiftwidth=4");
  assert.strictEqual(
    success("set").message,
    "textwidth=72  shiftwidth=4",
  );
});

test(":set rejects unsupported options and out-of-range values", () => {
  assert.deepStrictEqual(executeEx("set number", context()), {
    ok: false,
    message: "E518: Unknown option: number",
  });
  assert.deepStrictEqual(executeEx("set tw=10", context()), {
    ok: false,
    message: "textwidth must be between 20 and 200",
  });
  assert.deepStrictEqual(executeEx("set sw=20", context()), {
    ok: false,
    message: "shiftwidth must be between 1 and 16",
  });
});

test(":noh clears search highlighting", () => {
  const result = success("noh");
  assert.strictEqual(result.hlsearch, false);
  assert.strictEqual(result.message, "");
});

test("lifecycle commands produce adapter actions without changing text", () => {
  const cases = [
    ["w", "save", "Draft saved"],
    ["write", "save", "Draft saved"],
    ["q", "quit", ""],
    ["quit", "quit", ""],
    ["wq", "save-quit", ""],
    ["send", "send", ""],
  ] as const;

  for (const [command, action, message] of cases) {
    const result = success(command);
    assert.strictEqual(result.action, action);
    assert.strictEqual(result.message, message);
    assert.strictEqual(result.text, context().text);
  }
});

test("leading colon and surrounding whitespace are accepted", () => {
  assert.strictEqual(success("  :set tw=80  ").textwidth, 80);
});

test("unknown and empty commands produce useful errors", () => {
  assert.deepStrictEqual(executeEx("", context()), {
    ok: false,
    message: "E492: Not an editor command",
  });
  assert.deepStrictEqual(executeEx("write file.txt", context()), {
    ok: false,
    message: "E488: Trailing characters: file.txt",
  });
  assert.deepStrictEqual(executeEx("nope", context()), {
    ok: false,
    message: "E492: Not an editor command: nope",
  });
});
