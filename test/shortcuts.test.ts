/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import {
  nativeEditorCommand,
  nativeHistoryCommand,
  vimHistoryCommand,
  type ShortcutKey,
} from "../src/shortcuts.ts";

function key(
  value: string,
  modifiers: Partial<Omit<ShortcutKey, "key">> = {},
): ShortcutKey {
  return {
    key: value,
    shift: false,
    ctrl: false,
    alt: false,
    meta: false,
    ...modifiers,
  };
}

test("recognizes native undo and redo shortcuts", () => {
  assert.strictEqual(nativeEditorCommand(key("z", { meta: true }), true), "history");
  assert.strictEqual(nativeEditorCommand(key("z", { ctrl: true }), false), "history");
  assert.strictEqual(
    nativeEditorCommand(key("z", { meta: true, shift: true }), true),
    "history",
  );
  assert.strictEqual(
    nativeEditorCommand(key("z", { ctrl: true, shift: true }), false),
    "history",
  );
  assert.strictEqual(nativeEditorCommand(key("y", { ctrl: true }), false), "history");
});

test("identifies the direction of native history shortcuts", () => {
  assert.strictEqual(
    nativeHistoryCommand(key("z", { meta: true }), true),
    "undo",
  );
  assert.strictEqual(
    nativeHistoryCommand(key("z", { meta: true, shift: true }), true),
    "redo",
  );
  assert.strictEqual(
    nativeHistoryCommand(key("z", { ctrl: true }), false),
    "undo",
  );
  assert.strictEqual(
    nativeHistoryCommand(key("z", { ctrl: true, shift: true }), false),
    "redo",
  );
  assert.strictEqual(
    nativeHistoryCommand(key("y", { ctrl: true }), false),
    "redo",
  );
  assert.strictEqual(nativeHistoryCommand(key("y", { meta: true }), true), null);
});

test("reserves Ctrl-r for Vim redo", () => {
  assert.strictEqual(nativeEditorCommand(key("r", { ctrl: true }), false), null);
});

test("recognizes Vim history keys without stealing modified commands", () => {
  assert.strictEqual(vimHistoryCommand(key("u")), "undo");
  assert.strictEqual(vimHistoryCommand(key("r", { ctrl: true })), "redo");
  assert.strictEqual(
    vimHistoryCommand(key("R", { ctrl: true, shift: true })),
    "redo",
  );
  assert.strictEqual(vimHistoryCommand(key("u", { shift: true })), null);
  assert.strictEqual(vimHistoryCommand(key("u", { ctrl: true })), null);
  assert.strictEqual(
    vimHistoryCommand(key("r", { ctrl: true, alt: true })),
    null,
  );
  assert.strictEqual(
    vimHistoryCommand(key("r", { ctrl: true, meta: true })),
    null,
  );
});

test("recognizes native selection and formatting shortcuts", () => {
  for (const value of ["b", "i", "u", "c", "v", "x"]) {
    assert.strictEqual(
      nativeEditorCommand(key(value, { meta: true }), true),
      "selection",
    );
    assert.strictEqual(
      nativeEditorCommand(key(value, { ctrl: true }), false),
      "selection",
    );
  }
});

test("ignores unrelated application shortcuts", () => {
  for (const value of ["Enter", "s", "f"]) {
    assert.strictEqual(nativeEditorCommand(key(value, { meta: true }), true), null);
    assert.strictEqual(nativeEditorCommand(key(value, { ctrl: true }), false), null);
  }
});

test("rejects alternate and conflicting platform modifiers", () => {
  assert.strictEqual(
    nativeEditorCommand(key("z", { meta: true, alt: true }), true),
    null,
  );
  assert.strictEqual(
    nativeEditorCommand(key("z", { meta: true, ctrl: true }), true),
    null,
  );
  assert.strictEqual(
    nativeEditorCommand(key("z", { ctrl: true, meta: true }), false),
    null,
  );
  assert.strictEqual(nativeEditorCommand(key("z", { ctrl: true }), true), null);
  assert.strictEqual(nativeEditorCommand(key("z", { meta: true }), false), null);
});
