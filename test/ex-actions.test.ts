/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  runExAction,
  type ExActionApi,
} from "../src/ex-actions.ts";

function fakeApi(calls: string[]): ExActionApi {
  return {
    compose: {
      saveMessage(tabId, options) {
        calls.push(`save:${tabId}:${options.mode}`);
        return Promise.resolve();
      },
      sendMessage(tabId, options) {
        calls.push(`send:${tabId}:${options.mode}`);
        return Promise.resolve();
      },
    },
    tabs: {
      remove(tabId) {
        calls.push(`close:${tabId}`);
        return Promise.resolve();
      },
    },
  };
}

test(":w saves the current message as a draft", async () => {
  const calls: string[] = [];
  await runExAction(fakeApi(calls), 42, "save");
  assert.deepStrictEqual(calls, ["save:42:draft"]);
});

test(":q closes the current compose tab", async () => {
  const calls: string[] = [];
  await runExAction(fakeApi(calls), 42, "quit");
  assert.deepStrictEqual(calls, ["close:42"]);
});

test(":wq saves before closing the compose tab", async () => {
  const calls: string[] = [];
  await runExAction(fakeApi(calls), 42, "save-quit");
  assert.deepStrictEqual(calls, ["save:42:draft", "close:42"]);
});

test(":wq does not close when saving the draft fails", async () => {
  const calls: string[] = [];
  const api = fakeApi(calls);
  api.compose.saveMessage = () => {
    calls.push("save-failed");
    return Promise.reject(new Error("draft unavailable"));
  };
  await assert.rejects(
    runExAction(api, 42, "save-quit"),
    /draft unavailable/,
  );
  assert.deepStrictEqual(calls, ["save-failed"]);
});

test(":send uses Thunderbird's normal online/offline send behavior", async () => {
  const calls: string[] = [];
  await runExAction(fakeApi(calls), 42, "send");
  assert.deepStrictEqual(calls, ["send:42:default"]);
});

test("the manifest grants the permissions required by save and send", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  ) as { permissions?: string[] };
  assert.ok(manifest.permissions?.includes("compose.save"));
  assert.ok(manifest.permissions?.includes("compose.send"));
});
