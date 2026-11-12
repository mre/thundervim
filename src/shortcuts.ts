export interface ShortcutKey {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export type NativeEditorCommand = "selection" | "history";
export type VimHistoryCommand = "undo" | "redo";

// Native commands that either depend on the editor selection or can change its
// text/history. Other application shortcuts (Send, Save, Find, etc.) pass
// through untouched and need no post-command editor reconciliation.
export function nativeEditorCommand(
  ev: ShortcutKey,
  isMac: boolean,
): NativeEditorCommand | null {
  const primary = isMac ? ev.meta : ev.ctrl;
  const secondary = isMac ? ev.ctrl : ev.meta;
  if (!primary || secondary || ev.alt) return null;

  const key = ev.key.toLowerCase();
  if (key === "z" || (!isMac && key === "y")) return "history";
  if (["b", "i", "u", "c", "v", "x"].includes(key)) return "selection";
  return null;
}

// Vim's history keys are routed to Gecko when the compose adapter is using the
// native editor's undo manager. Mode and pending-command checks remain the
// adapter's responsibility because plain `u` is also a Visual command.
export function nativeHistoryCommand(
  ev: ShortcutKey,
  isMac: boolean,
): VimHistoryCommand | null {
  const primary = isMac ? ev.meta : ev.ctrl;
  const secondary = isMac ? ev.ctrl : ev.meta;
  if (!primary || secondary || ev.alt) return null;

  const key = ev.key.toLowerCase();
  if (key === "z") return ev.shift ? "redo" : "undo";
  if (!isMac && key === "y") return "redo";
  return null;
}

export function vimHistoryCommand(
  ev: ShortcutKey,
): VimHistoryCommand | null {
  if (ev.alt || ev.meta) return null;
  if (!ev.ctrl && !ev.shift && ev.key === "u") return "undo";
  if (ev.ctrl && ev.key.toLowerCase() === "r") return "redo";
  return null;
}
