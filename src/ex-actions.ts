import type { ExAction } from "./ex.ts";

export interface ExActionApi {
  compose: {
    saveMessage(
      tabId: number,
      options: { mode: "draft" },
    ): Promise<unknown>;
    sendMessage(
      tabId: number,
      options: { mode: "default" },
    ): Promise<unknown>;
  };
  tabs: {
    remove(tabId: number): Promise<unknown>;
  };
}

export async function runExAction(
  api: ExActionApi,
  tabId: number,
  action: ExAction,
): Promise<void> {
  switch (action) {
    case "save":
      await api.compose.saveMessage(tabId, { mode: "draft" });
      return;
    case "quit":
      await api.tabs.remove(tabId);
      return;
    case "save-quit":
      await api.compose.saveMessage(tabId, { mode: "draft" });
      await api.tabs.remove(tabId);
      return;
    case "send":
      await api.compose.sendMessage(tabId, { mode: "default" });
      return;
  }
}
