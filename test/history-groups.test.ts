/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import {
  clearHistoryGroups,
  createHistoryGroups,
  hasHistoryGroup,
  recordHistoryGroup,
  takeHistoryGroup,
} from "../src/history-groups.ts";

test("one undo consumes every native transaction in an Ex command", () => {
  const groups = createHistoryGroups();
  assert.strictEqual(hasHistoryGroup(groups, "undo"), false);
  recordHistoryGroup(groups, 3);
  assert.strictEqual(hasHistoryGroup(groups, "undo"), true);
  assert.strictEqual(takeHistoryGroup(groups, "undo"), 3);
  assert.strictEqual(hasHistoryGroup(groups, "undo"), false);
  assert.strictEqual(hasHistoryGroup(groups, "redo"), true);
  assert.strictEqual(takeHistoryGroup(groups, "redo"), 3);
});

test("history groups preserve Vim command boundaries", () => {
  const groups = createHistoryGroups();
  recordHistoryGroup(groups, 4);
  recordHistoryGroup(groups, 1);
  assert.strictEqual(takeHistoryGroup(groups, "undo"), 1);
  assert.strictEqual(takeHistoryGroup(groups, "undo"), 4);
  assert.strictEqual(takeHistoryGroup(groups, "redo"), 4);
  assert.strictEqual(takeHistoryGroup(groups, "redo"), 1);
});

test("a new edit clears grouped redo history", () => {
  const groups = createHistoryGroups();
  recordHistoryGroup(groups, 3);
  takeHistoryGroup(groups, "undo");
  recordHistoryGroup(groups, 1);
  assert.strictEqual(takeHistoryGroup(groups, "redo"), 1);
});

test("untracked native history falls back to one transaction", () => {
  const groups = createHistoryGroups();
  assert.strictEqual(takeHistoryGroup(groups, "undo"), 1);
  assert.strictEqual(takeHistoryGroup(groups, "redo"), 1);
});

test("clearing history forgets stale transaction widths", () => {
  const groups = createHistoryGroups();
  recordHistoryGroup(groups, 5);
  clearHistoryGroups(groups);
  assert.strictEqual(takeHistoryGroup(groups, "undo"), 1);
});
