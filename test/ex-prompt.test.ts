/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import {
  beginExPrompt,
  updateExPrompt,
  type ExPromptKey,
} from "../src/ex-prompt.ts";

function key(value: string, modifiers: Partial<ExPromptKey> = {}): ExPromptKey {
  return {
    key: value,
    ctrl: false,
    alt: false,
    meta: false,
    ...modifiers,
  };
}

test("normal-mode : starts an empty command line", () => {
  assert.deepStrictEqual(beginExPrompt(false), { query: "" });
});

test("visual-mode : prefills the visual line range", () => {
  assert.deepStrictEqual(beginExPrompt(true), { query: "'<,'>" });
});

test("printable keys append to the command line", () => {
  assert.deepStrictEqual(updateExPrompt({ query: "%s/a/b/" }, key("g")), {
    kind: "continue",
    prompt: { query: "%s/a/b/g" },
  });
});

test("Backspace edits and eventually cancels an empty command line", () => {
  assert.deepStrictEqual(updateExPrompt({ query: "w" }, key("Backspace")), {
    kind: "continue",
    prompt: { query: "" },
  });
  assert.deepStrictEqual(updateExPrompt({ query: "" }, key("Backspace")), {
    kind: "cancel",
  });
});

test("Escape cancels and Enter submits", () => {
  assert.deepStrictEqual(updateExPrompt({ query: "w" }, key("Escape")), {
    kind: "cancel",
  });
  assert.deepStrictEqual(updateExPrompt({ query: "w" }, key("Enter")), {
    kind: "submit",
    command: "w",
  });
});

test("modified and non-text keys leave the prompt open unchanged", () => {
  for (const event of [key("x", { ctrl: true }), key("ArrowLeft")]) {
    assert.deepStrictEqual(updateExPrompt({ query: "set " }, event), {
      kind: "continue",
      prompt: { query: "set " },
    });
  }
});
