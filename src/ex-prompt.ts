export interface ExPrompt {
  query: string;
}

export interface ExPromptKey {
  key: string;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export type ExPromptUpdate =
  | { kind: "continue"; prompt: ExPrompt }
  | { kind: "cancel" }
  | { kind: "submit"; command: string };

export function beginExPrompt(visual: boolean): ExPrompt {
  return { query: visual ? "'<,'>" : "" };
}

export function updateExPrompt(
  prompt: ExPrompt,
  event: ExPromptKey,
): ExPromptUpdate {
  if (event.key === "Escape") return { kind: "cancel" };
  if (event.key === "Enter") {
    return { kind: "submit", command: prompt.query };
  }
  if (event.key === "Backspace") {
    if (!prompt.query) return { kind: "cancel" };
    return {
      kind: "continue",
      prompt: { query: prompt.query.slice(0, -1) },
    };
  }
  if (
    !event.ctrl &&
    !event.alt &&
    !event.meta &&
    event.key.length === 1
  ) {
    return {
      kind: "continue",
      prompt: { query: prompt.query + event.key },
    };
  }
  return { kind: "continue", prompt };
}
