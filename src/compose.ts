// Thundervim compose-window adapter.
//
// This is the only part of the extension that touches Thunderbird / the DOM.
// It bridges the pure vim engine to the plain-text compose editor, which is a
// contenteditable document (`document.body`) whose newlines are <br> elements.
//
// Design:
//   * In INSERT mode the native editor owns typing (IME, spellcheck, quoting
//     all keep working); we only intercept the exit-to-normal keys.
//   * In NORMAL / VISUAL mode we intercept keys, run the engine, and write the
//     resulting text + caret back into the DOM.
//   * The mode status bar is attached to <html> (outside <body>) so it is
//     never serialized into the outgoing message.

import {
  MODE,
  createState,
  handleKey,
  finishInsert,
  setSearch,
  computeMatches,
  syncFromEditor,
  rebaseFromEditor,
  clampNormal,
  lineStartAt,
  lineEndAt,
} from "./engine.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import {
  nativeEditorCommand,
  vimHistoryCommand,
} from "./shortcuts.ts";
import type { State, Mode, SearchInfo } from "./engine.ts";
import type { ThundervimConfig } from "./config.ts";

// Diagnostic hook exposed on the window for manual bug reports (Ctrl-Alt-D).
declare global {
  interface Window {
    thundervim_dump?: (label?: string) => unknown;
  }
}

interface RuntimeApi {
  onMessage?: {
    addListener(listener: (message: unknown) => void | Promise<void>): void;
  };
  sendMessage(message: unknown): Promise<unknown>;
}

interface BrowserApi {
  runtime?: RuntimeApi;
}

function extensionApi(): BrowserApi | null {
  const globals = globalThis as typeof globalThis & {
    browser?: BrowserApi;
    messenger?: BrowserApi;
  };
  return globals.messenger ?? globals.browser ?? null;
}

// ------------------------------------------------------------------ config
let config: ThundervimConfig = DEFAULT_CONFIG;

function applyConfig(next: ThundervimConfig): void {
  config = next;
  state.shiftwidth = config.shiftWidth;
  state.textwidth = config.textWidth;
}

// The adapter's normalized key event: a structural superset of the engine's
// KeyEvent (it also carries `code`, used by the macOS debug chord).
interface NormKey {
  key: string;
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

const state: State = createState("", 0);
state.shiftwidth = config.shiftWidth;
state.textwidth = config.textWidth;
state.mode = config.defaultMode === "normal" ? MODE.NORMAL : MODE.INSERT;
let enabled = config.enableOnStart;
let lastInsert: { key: string | null; time: number } = { key: null, time: 0 };
// Snapshot of the buffer at the moment Insert mode is entered from a command,
// used to recover the typed text for dot-repeat when Insert mode exits.
let insertStart: { text: string; cursor: number } | null = null;
// Active `/` or `?` prompt: { dir: 1|-1, query: string }, or null.
let searching: { dir: number; query: string } | null = null;
// Transient status-bar note (e.g. "pattern not found"), shown until next key.
let searchMsg = "";
// Set when we consume a key; used to cancel the editor's resulting text-input
// edit. Thunderbird's editor inserts characters via `beforeinput`, which a
// content-script `keydown` preventDefault() does not cancel on its own.
let suppressInput = false;
// Vim edits use Gecko transactions when available so native and Vim history
// keys traverse one timeline. A failed transaction disables the bridge for the
// rest of the compose session and falls back to the safe split-history path.
let sharedNativeHistory = true;
let applyingVimTransaction = false;
// Extra cursor offsets for multi-cursor Insert-mode mirroring. The primary
// cursor remains `state.cursor` so existing vim motions/operators keep working.
let extraCursors: number[] = [];

function allCursors(): number[] {
  return Array.from(new Set([state.cursor, ...extraCursors])).sort(
    (a, b) => a - b,
  );
}

function normalizeExtraCursors(): void {
  extraCursors = Array.from(new Set(extraCursors))
    .filter((pos) => pos !== state.cursor)
    .sort((a, b) => a - b);
}

function clearExtraCursors(): void {
  if (!extraCursors.length) return;
  extraCursors = [];
  render();
  updateBar();
}

function multiCursorCount(): number {
  return 1 + extraCursors.length;
}

// ---------------------------------------------------------- DOM <-> text

const BLOCK: Record<string, number> = {
  DIV: 1,
  P: 1,
  BLOCKQUOTE: 1,
  PRE: 1,
  LI: 1,
  H1: 1,
  H2: 1,
  H3: 1,
  H4: 1,
  H5: 1,
  H6: 1,
  TR: 1,
};

// Narrowing helpers that mirror the original numeric nodeType checks.
function isText(node: Node): node is Text {
  return node.nodeType === 3;
}
function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

// A serialized read of the editor body: linear text plus the caret offset.
interface ReadResult {
  text: string;
  caret: number;
}
// A resolved DOM position. `br` marks a point that sits on a <br> newline.
interface DomPoint {
  node: Node;
  offset: number;
  br?: boolean;
}
// A DOM boundary suitable for Range.setStart / setEnd.
interface Boundary {
  node: Node;
  offset: number;
}
// A [start, end) linear span of one top-level body child.
interface Span {
  node: ChildNode;
  start: number;
  end: number;
  leadingBreak: boolean;
}
// A [start, end) linear selection span.
interface LinearRange {
  start: number;
  end: number;
}

// A <br> that is the body's last child is Gecko's padding/bogus node, not a
// real line break. Our own writeBuffer never emits one, so skipping it avoids
// reading a phantom trailing newline from the editor's native markup.
function isBogusTrailingBr(node: Node): boolean {
  return (
    node instanceof Element &&
    node.tagName === "BR" &&
    node.parentNode === document.body &&
    node.parentNode.lastChild === node
  );
}

function isChromeOverlay(node: Node): boolean {
  return (
    isElement(node) &&
    (node.id === "thundervim-status" ||
      node.id === "thundervim-cursor" ||
      node.id === "thundervim-multi-cursors" ||
      node.id === "thundervim-highlights" ||
      node.id === "thundervim-dump")
  );
}

// A block followed by raw text or an inline element has a rendered line break
// that cannot be discovered by looking only at the following node. Block-to-
// block and block-to-<br> boundaries are already emitted when those nodes are
// visited, and literal leading newlines must not be doubled.
function hasBlockBreakAfter(node: Element): boolean {
  if (!BLOCK[node.tagName]) return false;
  let next = node.nextSibling;
  while (next) {
    if (isText(next)) {
      if (!next.data.length) {
        next = next.nextSibling;
        continue;
      }
      return next.data.charAt(0) !== "\n";
    }
    if (!isElement(next) || isChromeOverlay(next)) {
      next = next.nextSibling;
      continue;
    }
    if (next.tagName === "BR") return false;
    return !BLOCK[next.tagName];
  }
  return false;
}

// Serialize the editor body to a linear string and locate the caret offset.
function readBuffer(): ReadResult | null {
  const body = document.body;
  if (!body) return null;
  const sel = window.getSelection();
  const focusNode: Node | null = sel && sel.rangeCount ? sel.focusNode : null;
  const focusOffset = sel && sel.rangeCount ? sel.focusOffset : 0;

  let text = "";
  let caret: number | null = null;

  function visit(node: Node): void {
    if (isText(node)) {
      if (node === focusNode) caret = text.length + focusOffset;
      text += node.data;
      return;
    }
    if (!isElement(node) || isChromeOverlay(node)) return;
    const tag = node.tagName;
    if (tag === "BR") {
      if (node === focusNode) caret = text.length;
      if (isBogusTrailingBr(node)) return; // padding node, not a newline
      text += "\n";
      return;
    }
    if (BLOCK[tag] && text.length > 0 && text[text.length - 1] !== "\n")
      text += "\n";
    const children = node.childNodes;
    const recordAt = node === focusNode ? focusOffset : -1;
    for (let i = 0; i < children.length; i++) {
      if (recordAt === i) caret = text.length;
      visit(children[i]);
    }
    if (recordAt === children.length) caret = text.length;
    if (
      hasBlockBreakAfter(node) &&
      text.length > 0 &&
      text[text.length - 1] !== "\n"
    )
      text += "\n";
  }
  visit(body);
  if (caret == null) caret = text.length;
  return { text: text, caret: caret };
}

const DEBUG_TRACE_LIMIT = 200;

interface DebugTraceEntry {
  seq: number;
  ms: number;
  event: string;
  mode: Mode;
  history: "native" | "split";
  cursor: number;
  model: string;
  dom: string | null;
  caret: number | null;
  structure: string;
  details: Record<string, string | number | boolean | null>;
}

let debugTraceStarted = Date.now();
const debugTrace: DebugTraceEntry[] = [];
let debugTraceSeq = 0;
let debugTracing = false;
let tracingDebugEvent = false;

function textFingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function domStructure(): string {
  const body = document.body;
  if (!body) return "";
  function describe(node: Node, depth: number): string {
    if (isText(node)) return `#text(${node.data.length})`;
    if (!isElement(node) || isChromeOverlay(node)) return "";
    if (depth >= 4) return `<${node.tagName.toLowerCase()}>`;
    const children = Array.from(node.childNodes)
      .map((child) => describe(child, depth + 1))
      .filter(Boolean)
      .join("");
    return `<${node.tagName.toLowerCase()}>${children}</${node.tagName.toLowerCase()}>`;
  }
  return Array.from(body.childNodes)
    .map((node) => describe(node, 0))
    .filter(Boolean)
    .join("");
}

// Bounded, memory-only flight recorder. It intentionally stores fingerprints
// and DOM shape rather than message text; the explicit dump already carries the
// current text/HTML when the user chooses to copy it.
function traceDebug(
  event: string,
  details: Record<string, string | number | boolean | null> = {},
  captureDom = true,
): void {
  if (!debugTracing || tracingDebugEvent) return;
  tracingDebugEvent = true;
  try {
    const dom = captureDom ? readBuffer() : null;
    debugTrace.push({
      seq: ++debugTraceSeq,
      ms: Date.now() - debugTraceStarted,
      event,
      mode: state.mode,
      history: sharedNativeHistory ? "native" : "split",
      cursor: state.cursor,
      model: textFingerprint(state.text),
      dom: dom ? textFingerprint(dom.text) : null,
      caret: dom ? dom.caret : null,
      structure: captureDom ? domStructure() : "",
      details,
    });
    if (debugTrace.length > DEBUG_TRACE_LIMIT) debugTrace.shift();
  } finally {
    tracingDebugEvent = false;
  }
}

// Rich drafts may contain pretty-printing whitespace that normal HTML layout
// collapses (including indentation between blocks and wrapped source lines).
// Canonicalize only that collapsible whitespace before our exact DOM walkers
// take over; otherwise enabling pre-wrap would expose source indentation as
// visible mail content. Explicitly preformatted regions remain untouched.
function normalizeCollapsibleWhitespace(): void {
  const body = document.body;
  if (!body) return;
  const texts: Text[] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent || isChromeOverlay(parent)) continue;
    const whiteSpace = window.getComputedStyle(parent).whiteSpace;
    if (whiteSpace !== "normal" && whiteSpace !== "nowrap") continue;
    text.data = text.data.replace(/[\t\n\f\r ]+/g, " ");
    texts.push(text);
  }

  function hasLineBoundary(node: Node, before: boolean): boolean {
    let current: Node | null = node;
    while (current && current !== body) {
      let sibling = before ? current.previousSibling : current.nextSibling;
      while (sibling && isText(sibling) && !sibling.data.length)
        sibling = before ? sibling.previousSibling : sibling.nextSibling;
      if (sibling)
        return (
          isElement(sibling) &&
          (sibling.tagName === "BR" || !!BLOCK[sibling.tagName])
        );
      const parent: ParentNode | null = current.parentNode;
      if (!parent || parent === body) return true;
      if (isElement(parent) && BLOCK[parent.tagName]) return true;
      current = parent;
    }
    return true;
  }

  // Collapsed spaces at block/BR edges have no rendered width. Remove them so
  // the serialized model matches what Thunderbird displays.
  for (const text of texts) {
    if (text.data.startsWith(" ") && hasLineBoundary(text, true))
      text.data = text.data.slice(1);
    if (text.data.endsWith(" ") && hasLineBoundary(text, false))
      text.data = text.data.slice(0, -1);
  }
}

// Ensure the flat fallback renders literal newlines stored in one text node.
function ensurePreWrap(): void {
  const body = document.body;
  if (body && body.style.whiteSpace !== "pre-wrap")
    body.style.whiteSpace = "pre-wrap";
}

// Rebuild the editor body from a linear string and place the caret.
//
// The buffer is written as a SINGLE text node containing real "\n"
// characters. Combined with white-space:pre-wrap this makes every caret
// offset a valid position (including empty lines and trailing newlines),
// which avoids the editor snapping the caret off <br>/empty-node boundaries.
function writeBuffer(text: string, caret: number): void {
  const body = document.body;
  if (!body) return;
  ensurePreWrap();
  while (body.firstChild) body.removeChild(body.firstChild);
  const tn = document.createTextNode(text);
  body.appendChild(tn);
  // In a pre-wrap contenteditable a trailing "\n" does not yield a reachable
  // empty last line on its own. Append a padding <br> (skipped by readBuffer /
  // domPointAt as a trailing bogus node) so the caret can land there.
  if (text.length === 0 || text.charAt(text.length - 1) === "\n") {
    body.appendChild(document.createElement("br"));
  }
  const off = caret < 0 ? 0 : caret > text.length ? text.length : caret;
  const range = document.createRange();
  range.setStart(tn, off);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

// ------------------------------------------------ formatting-preserving write

function commonPrefixLen(a: string, b: string): number {
  const m = Math.min(a.length, b.length);
  let i = 0;
  while (i < m && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
function commonSuffixLen(a: string, b: string, prefix: number): number {
  const m = Math.min(a.length, b.length) - prefix;
  let s = 0;
  while (
    s < m &&
    a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)
  )
    s++;
  return s;
}

// Gecko may preserve an inserted space at a block join as NBSP. That is the
// same rendered edit and must not disable the native history bridge. Keep the
// actual DOM spelling in the model after accepting this equivalence.
function nativeTextEquivalent(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const a = expected.charAt(i);
    const b = actual.charAt(i);
    if (a === b) continue;
    if ((a === " " && b === "\u00a0") || (a === "\u00a0" && b === " "))
      continue;
    return false;
  }
  return true;
}

function disableNativeHistoryBridge(reason = "unavailable"): void {
  if (!sharedNativeHistory) return;
  sharedNativeHistory = false;
  traceDebug("history:split", { reason });
  if (typeof console !== "undefined" && console.warn) {
    console.warn(
      "thundervim: native undo bridge unavailable; using split history",
    );
  }
}

// Submit a Vim text change to Gecko as one editor transaction. Unlike direct
// DOM mutation, execCommand preserves contenteditable's native undo buffer.
// The API is deprecated on the open web, but remains the only transaction API
// exposed by Thunderbird's compose editor to a content script.
function applyNativeTransaction(
  oldText: string,
  newText: string,
  caret: number,
  placeCaret: boolean,
): boolean {
  if (!sharedNativeHistory || oldText === newText) return false;
  const p = commonPrefixLen(oldText, newText);
  const sfx = commonSuffixLen(oldText, newText, p);
  const qOld = oldText.length - sfx;
  const repl = newText.slice(p, newText.length - sfx);
  traceDebug("native-edit:start", {
    start: p,
    oldEnd: qOld,
    replacementLength: repl.length,
    old: textFingerprint(oldText),
    next: textFingerprint(newText),
  });
  if (!selectRangeInDom(p, qOld)) {
    disableNativeHistoryBridge("range-selection-failed");
    return false;
  }

  let applied = false;
  applyingVimTransaction = true;
  try {
    applied = repl
      ? document.execCommand("insertText", false, repl)
      : document.execCommand("delete", false);
  } catch {
    applied = false;
  } finally {
    applyingVimTransaction = false;
  }

  const current = readBuffer();
  const exact = !!current && current.text === newText;
  const equivalent = !!current && nativeTextEquivalent(newText, current.text);
  traceDebug("native-edit:end", {
    applied,
    exact,
    equivalent,
    current: current ? textFingerprint(current.text) : null,
  });
  if (!applied || !equivalent) {
    disableNativeHistoryBridge("native-result-mismatch");
    return false;
  }
  if (!exact) state.text = current.text;
  if (placeCaret) setNativeCaret(caret);
  return true;
}

// Collapse the native selection to a single linear offset.
function setNativeCaret(offset: number): void {
  const b = domBoundary(offset);
  if (!b) return;
  try {
    const range = document.createRange();
    range.setStart(b.node, b.offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* boundary went stale; ignore */
  }
}

// Replace linear span [start, end) with `repl` via DOM range surgery. Used
// when the edit crosses a text-node / <br> / block boundary. Newlines in
// `repl` are kept as literal "\n" characters, which white-space:pre-wrap
// renders as breaks and readBuffer/domPointAt both count consistently.
function generalReplace(start: number, end: number, repl: string): boolean {
  const bs = domBoundary(start);
  const be = domBoundary(end);
  if (!bs || !be) return false;
  try {
    const range = document.createRange();
    range.setStart(bs.node, bs.offset);
    range.setEnd(be.node, be.offset);
    range.deleteContents();
    if (repl) range.insertNode(document.createTextNode(repl));
    return true;
  } catch {
    return false;
  }
}

// Nearest ancestor block element (stops at body). Text nodes resolve to their
// parent's block. Returns null if the node lives directly under body with no
// block wrapper.
function nearestBlock(node: Node): Element | null {
  let n: Node | null = node && isText(node) ? node.parentNode : node;
  while (n && n !== document.body) {
    if (isElement(n) && BLOCK[n.tagName]) return n;
    n = n.parentNode;
  }
  return null;
}

// True if the changed span [p, qOld) crosses a block boundary, i.e. the block
// holding the last unchanged char before the edit differs from the one holding
// the first unchanged char after it. A stray body-level node (whitespace, an
// inserted separator) resolves to a null block, which also counts as crossing.
function editCrossesBlock(p: number, qOld: number, oldLen: number): boolean {
  const pa = domPointAt(p > 0 ? p - 1 : 0);
  const pb = domPointAt(qOld < oldLen ? qOld : oldLen);
  const ba = pa ? nearestBlock(pa.node) : null;
  const bb = pb ? nearestBlock(pb.node) : null;
  return ba !== bb;
}

// Linear [start, end) span of every direct child of body, serialized exactly
// like readBuffer (synthetic block-boundary newlines included; status/cursor/
// highlight overlays and the bogus trailing <br> excluded). Lets a structural
// edit target just the touched top-level blocks instead of the whole body.
function topLevelSpans(): Span[] | null {
  const body = document.body;
  if (!body) return null;
  let acc = 0;
  let lastCh = "";
  function measure(node: Node): void {
    if (isText(node)) {
      acc += node.data.length;
      if (node.data.length) lastCh = node.data.charAt(node.data.length - 1);
      return;
    }
    if (!isElement(node) || isChromeOverlay(node)) return;
    if (node.tagName === "BR") {
      if (isBogusTrailingBr(node)) return;
      acc += 1;
      lastCh = "\n";
      return;
    }
    if (BLOCK[node.tagName] && acc > 0 && lastCh !== "\n") {
      acc += 1;
      lastCh = "\n";
    }
    const ch = node.childNodes;
    for (let i = 0; i < ch.length; i++) measure(ch[i]);
    if (hasBlockBreakAfter(node) && acc > 0 && lastCh !== "\n") {
      acc += 1;
      lastCh = "\n";
    }
  }
  const spans: Span[] = [];
  const kids = body.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    const over = isChromeOverlay(node);
    const s = acc;
    const leadingBreak =
      isElement(node) && !!BLOCK[node.tagName] && acc > 0 && lastCh !== "\n";
    measure(node);
    if (!over)
      spans.push({ node: node, start: s, end: acc, leadingBreak });
  }
  return spans;
}

// Index of the span whose [start, end) contains offset o, else the last span
// starting at or before o.
function childIndexContaining(spans: Span[], o: number): number {
  let best = -1;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].start <= o && o < spans[i].end) return i;
    if (spans[i].start <= o) best = i;
  }
  return best;
}

// Structural edit that re-renders only the top-level blocks the change spans,
// replacing them with a single pre-wrap <div> of the corresponding slice of
// newText. Sibling nodes (quoted reply, signature blocks below) are untouched,
// so a cross-block join no longer flattens the whole body. Returns true once
// the DOM matches newText.
function scopedRewrite(
  oldText: string,
  newText: string,
  p: number,
  qOld: number,
  caret: number,
  placeCaret: boolean,
): boolean {
  const body = document.body;
  if (!body) return false;
  const spans = topLevelSpans();
  if (!spans || !spans.length) return false;
  const i0 = childIndexContaining(spans, p > 0 ? p - 1 : p);
  const lastOld = oldText.length > 0 ? oldText.length - 1 : 0;
  const i1 = childIndexContaining(
    spans,
    qOld < oldText.length ? qOld : lastOld,
  );
  if (i0 < 0 || i1 < 0 || i1 < i0) return false;
  const startOff = spans[i0].start;
  const endOff = spans[i1].end;
  const newEndOff = endOff + (newText.length - oldText.length);
  if (newEndOff < startOff) return false;
  // A top-level block span owns the synthetic newline emitted when entering
  // that block. The replacement block emits it too, so do not duplicate it in
  // the replacement text node.
  const sliceStart = startOff + (spans[i0].leadingBreak ? 1 : 0);
  const slice = newText.slice(sliceStart, newEndOff);
  const parent = spans[i0].node.parentNode!;
  const stop = spans[i1].node.nextSibling;
  const anchor = spans[i0].node;
  if (slice.length > 0) {
    const div = document.createElement("div");
    div.style.whiteSpace = "pre-wrap";
    div.appendChild(document.createTextNode(slice));
    parent.insertBefore(div, anchor);
  }
  let cur: ChildNode | null = anchor;
  while (cur && cur !== stop) {
    const next: ChildNode | null = cur.nextSibling;
    parent.removeChild(cur);
    cur = next;
  }
  const chk = readBuffer();
  if (!chk || chk.text !== newText) return false;
  if (placeCaret) setNativeCaret(caret);
  return true;
}

// Bring the DOM in line with `newText` by applying only the changed span, so
// untouched markup (quote levels, bold, links, ...) is preserved. Falls back
// to a full flat rewrite only if a general edit can't reproduce newText.
function applyEdit(
  oldText: string,
  newText: string,
  caret: number,
  placeCaret: boolean,
): void {
  if (oldText === newText) {
    if (placeCaret) setNativeCaret(caret);
    return;
  }
  const p = commonPrefixLen(oldText, newText);
  const sfx = commonSuffixLen(oldText, newText, p);
  const qOld = oldText.length - sfx;
  const repl = newText.slice(p, newText.length - sfx);

  // Fast path: the whole changed span lives inside one text node. Splicing its
  // character data touches nothing else, so it is exact and formatting-safe
  // (literal newlines are fine under pre-wrap).
  const a = domPointAt(p);
  const b = domPointAt(qOld);
  if (
    a &&
    b &&
    !a.br &&
    !b.br &&
    a.node === b.node &&
    isText(a.node) &&
    a.offset <= b.offset
  ) {
    const d = a.node.data;
    a.node.data = d.slice(0, a.offset) + repl + d.slice(b.offset);
    if (placeCaret) setNativeCaret(caret);
    traceDebug("dom-edit:text-splice", { start: p, oldEnd: qOld });
    return;
  }

  // A cross-block edit (e.g. J joining two <p>) can't be spliced: deleting
  // across the boundary strands two blocks and leaves a synthetic newline that
  // no longer matches the model. Re-render just the affected top-level blocks,
  // leaving quoted-reply and other siblings intact. Decide before mutating the
  // DOM so scopedRewrite reads a clean tree.
  if (editCrossesBlock(p, qOld, oldText.length)) {
    const rewritten = scopedRewrite(
      oldText,
      newText,
      p,
      qOld,
      caret,
      placeCaret,
    );
    traceDebug("dom-edit:scoped-rewrite", { rewritten });
    if (rewritten) return;
  } else if (generalReplace(p, qOld, repl)) {
    // Within-block cross-boundary edit (e.g. spanning a <br> or inline tag).
    // The range surgery preserves surrounding formatting when it reproduces
    // newText exactly.
    const check = readBuffer();
    const matched = !!check && check.text === newText;
    traceDebug("dom-edit:range", { matched });
    if (matched) {
      if (placeCaret) setNativeCaret(caret);
      return;
    }
    // The splice didn't reproduce newText; try the scoped re-render before the
    // last-resort flat writer.
    const rewritten = scopedRewrite(
      oldText,
      newText,
      p,
      qOld,
      caret,
      placeCaret,
    );
    traceDebug("dom-edit:scoped-after-range", { rewritten });
    if (rewritten) return;
  }
  if (typeof console !== "undefined" && console.warn) {
    console.warn(
      "thundervim: flat-render fallback for a structural edit\n" +
        "oldText=" +
        JSON.stringify(oldText) +
        "\nnewText=" +
        JSON.stringify(newText) +
        "\nbodyHTML=" +
        (document.body ? document.body.innerHTML : ""),
    );
  }
  traceDebug("dom-edit:flat-rewrite", {
    old: textFingerprint(oldText),
    next: textFingerprint(newText),
  });
  writeBuffer(newText, caret);
}

// Render the engine's buffer into the live DOM, preserving formatting.
// `placeCaret` positions the native caret (needed when entering Insert mode).
function syncDom(placeCaret: boolean): void {
  if (!document.body) return;
  const cur = readBuffer();
  const oldText = cur ? cur.text : "";
  const attemptedNative = sharedNativeHistory && oldText !== state.text;
  if (
    oldText !== state.text &&
    !applyNativeTransaction(oldText, state.text, state.cursor, placeCaret)
  ) {
    // Re-read after a failed native attempt in case Gecko partially changed the
    // DOM, then repair it through the existing formatting-preserving writer.
    const latest = readBuffer();
    applyEdit(
      latest ? latest.text : oldText,
      state.text,
      state.cursor,
      placeCaret,
    );
    // applyNativeTransaction materializes a real DOM selection before calling
    // Gecko. Do not leave that failed edit range active in Normal mode.
    if (attemptedNative && !placeCaret) setNativeCaret(state.cursor);
  } else if (oldText === state.text && placeCaret) {
    setNativeCaret(state.cursor);
  }
  ensureTrailingPad(state.text);
}

// After the app handled a native paste/cut/undo in Normal mode, pull the
// engine's buffer back in line with the DOM. Gecko's undo manager is separate
// from Vim's, so a native text change starts a fresh Vim-history baseline. A
// formatting or copy command leaves the text unchanged and preserves history.
function resyncFromDom(): void {
  const b = readBuffer();
  if (!b || b.text === state.text) {
    traceDebug("native-command:resync", { changed: false });
    return;
  }
  rebaseFromEditor(state, b.text, b.caret);
  state.mode = MODE.NORMAL;
  extraCursors = [];
  syncDom(false);
  updateBar();
  traceDebug("native-command:resync", { changed: true });
}

// After a native command applied to the Vim visual selection: formatting/copy
// leaves the text intact (land on the selection start, like a Vim operator),
// while paste/cut replaces it and rebases history. Either way, return to Normal
// mode and collapse the native selection.
function afterVisualNativeCommand(caretOffset: number): void {
  const b = readBuffer();
  if (!b) return;
  if (b.text !== state.text) {
    rebaseFromEditor(state, b.text, b.caret);
  } else {
    state.text = b.text;
    const last = b.text.length > 0 ? b.text.length - 1 : 0;
    state.cursor = caretOffset < last ? caretOffset : last;
  }
  state.mode = MODE.NORMAL;
  state.anchor = null;
  extraCursors = [];
  setNativeCaret(state.cursor);
  syncDom(false);
  updateBar();
}

// A buffer ending in "\n" (or empty) needs a trailing padding <br> so the last
// empty line is reachable under pre-wrap; readBuffer/domPointAt skip it as a
// bogus node. Mirrors the invariant the flat writeBuffer used to maintain.
function ensureTrailingPad(text: string): void {
  const body = document.body;
  if (!body) return;
  const needs = text.length === 0 || text.charAt(text.length - 1) === "\n";
  const last = body.lastChild;
  const lastIsBr = last instanceof Element && last.tagName === "BR";
  if (needs && !lastIsBr) {
    body.appendChild(document.createElement("br"));
  } else if (!needs && lastIsBr && isBogusTrailingBr(last)) {
    body.removeChild(last);
  }
}

// ---------------------------------------------------- block cursor overlay

// Map a linear buffer offset to a DOM point { node, offset, br } by walking
// the body exactly the way readBuffer serializes it -- including the synthetic
// newline inserted at a block-element boundary. Keeping this walk in lockstep
// with readBuffer is what lets offsets stay correct in a rich (non-flat) DOM.
function domPointAt(target: number, preferNext = false): DomPoint | null {
  const body = document.body;
  if (!body) return null;
  let acc = 0;
  let lastCh = ""; // last emitted character ("" = nothing emitted yet)
  let lastLeaf: Boundary | null = null; // DOM point just after the last emitted character
  let boundaryAtTarget: Boundary | null = null;
  let result: DomPoint | null = null;
  function visit(node: Node): void {
    if (result) return;
    if (isText(node)) {
      const data = node.data;
      const len = data.length;
      if (target < acc + len || (!preferNext && target === acc + len)) {
        result = { node: node, offset: target - acc, br: false };
        return;
      }
      if (target === acc + len)
        boundaryAtTarget = { node: node, offset: len };
      acc += len;
      if (len) {
        lastCh = data.charAt(len - 1);
        lastLeaf = { node: node, offset: len };
      }
      return;
    }
    if (!isElement(node)) return;
    if (isChromeOverlay(node)) return;
    if (node.tagName === "BR") {
      if (isBogusTrailingBr(node)) return; // padding node, not a newline
      if (target === acc) {
        result = { node: node, offset: 0, br: true };
        return;
      }
      acc += 1;
      lastCh = "\n";
      const p = node.parentNode!;
      lastLeaf = {
        node: p,
        offset: Array.from<Node>(p.childNodes).indexOf(node) + 1,
      };
      // Keep the point after a final <br>: an empty last line has no following
      // text node that can otherwise resolve its cursor position.
      if (target === acc) boundaryAtTarget = lastLeaf;
      return;
    }
    // Entering a block element emits a newline (unless one is already there),
    // mirroring readBuffer. Its DOM point is the end of the previous line.
    if (BLOCK[node.tagName] && acc > 0 && lastCh !== "\n") {
      if (target === acc) {
        result = lastLeaf || { node: node, offset: 0, br: false };
        return;
      }
      acc += 1;
      lastCh = "\n";
      if (preferNext && target === acc) boundaryAtTarget = lastLeaf;
    }
    const children = node.childNodes;
    for (let i = 0; i < children.length && !result; i++) visit(children[i]);
    if (
      !result &&
      hasBlockBreakAfter(node) &&
      acc > 0 &&
      lastCh !== "\n"
    ) {
      if (target === acc) {
        result = lastLeaf || { node: node, offset: children.length, br: false };
        return;
      }
      acc += 1;
      lastCh = "\n";
      if (preferNext && target === acc) boundaryAtTarget = lastLeaf;
    }
  }
  visit(body);
  return result || boundaryAtTarget;
}

// A DOM boundary { node, offset } suitable for Range.setStart/setEnd. Unlike a
// domPointAt result, a `br` newline is expressed as its index in the parent so
// a range can span (and thus delete) the break itself.
function domBoundary(offset: number): Boundary | null {
  const p = domPointAt(offset);
  if (!p) return null;
  if (p.br) {
    const parent = p.node.parentNode!;
    return {
      node: parent,
      offset: Array.from<Node>(parent.childNodes).indexOf(p.node),
    };
  }
  return { node: p.node, offset: p.offset };
}

// Rect of the character the Normal-mode cursor sits on (viewport coords).
// Returns { rect, collapsed } where `collapsed` means there is no character
// under the cursor (empty line / end of line) so a default width is used.
function cursorRectAt(
  pos: number,
): { rect: DOMRect; collapsed: boolean } | null {
  const p = domPointAt(pos);
  if (!p) return null;
  const ch =
    !p.br && isText(p.node) && p.offset < p.node.data.length
      ? p.node.data[p.offset]
      : null;
  const onChar = ch !== null && ch !== "\n";
  const range = document.createRange();
  try {
    if (onChar && isText(p.node)) {
      range.setStart(p.node, p.offset);
      range.setEnd(p.node, p.offset + 1);
      const rects = range.getClientRects();
      const rect = rects.length
        ? rects[rects.length - 1]
        : range.getBoundingClientRect();
      return { rect: rect, collapsed: false };
    }
    // Empty line / end of line / newline char: a collapsed range at a line
    // boundary is ambiguous and Gecko often reports the previous line's end,
    // so always measure via an inserted marker which sits in the correct
    // line's flow.
    if (p.br) range.setStartBefore(p.node);
    else range.setStart(p.node, p.offset);
    range.collapse(true);
    return { rect: markerRect(range), collapsed: true };
  } catch {
    return null;
  }
}

// Insert a zero-width span at the (collapsed) range, measure it, remove it.
// Inserting mid-text splits the node, so normalize afterward to restore the
// single-text-node form. The disturbed native selection does not matter in
// Normal/Visual mode (we drive the cursor from engine state, not the DOM).
function markerRect(range: Range): DOMRect {
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  range.insertNode(marker);
  const rect = marker.getBoundingClientRect();
  if (marker.parentNode) marker.parentNode.removeChild(marker);
  if (document.body) document.body.normalize();
  return rect;
}

function cursorRect(): { rect: DOMRect; collapsed: boolean } | null {
  return cursorRectAt(state.cursor);
}

function ensureCursor(): HTMLElement {
  let el = document.getElementById("thundervim-cursor");
  if (!el) {
    el = document.createElement("div");
    el.id = "thundervim-cursor";
    el.setAttribute("contenteditable", "false");
    (document.documentElement || document.body).appendChild(el);
  }
  return el;
}

function ensureMultiCursors(): HTMLElement {
  let el = document.getElementById("thundervim-multi-cursors");
  if (!el) {
    el = document.createElement("div");
    el.id = "thundervim-multi-cursors";
    el.setAttribute("contenteditable", "false");
    (document.documentElement || document.body).appendChild(el);
  }
  return el;
}

function drawCursor(
  el: HTMLElement,
  cr: { rect: DOMRect; collapsed: boolean },
): void {
  const r = cr.rect;
  el.style.display = "block";
  el.style.left = r.left + "px";
  el.style.top = r.top + "px";
  el.style.width = (!cr.collapsed && r.width > 0 ? r.width : 8) + "px";
  const height = cr.collapsed ? Math.max(r.height, 16) : r.height || 16;
  el.style.height = height + "px";
}

function updateExtraCursors(): void {
  const cont = ensureMultiCursors();
  while (cont.firstChild) cont.removeChild(cont.firstChild);
  if (!enabled || !extraCursors.length) {
    cont.style.display = "none";
    return;
  }
  cont.style.display = "block";
  for (const pos of extraCursors) {
    const cr = cursorRectAt(pos);
    if (!cr) continue;
    const el = document.createElement("div");
    el.className = "thundervim-extra-cursor";
    drawCursor(el, cr);
    cont.appendChild(el);
  }
}

function updateCursor(): void {
  const el = ensureCursor();
  const normalish = enabled && state.mode !== MODE.INSERT;
  // Hide the native thin caret while the block cursor is shown.
  if (document.body)
    document.body.style.caretColor = normalish ? "transparent" : "";
  if (!normalish) {
    el.style.display = "none";
    updateExtraCursors();
    return;
  }
  const cr = cursorRect();
  if (!cr || !cr.rect) {
    el.style.display = "none";
    updateExtraCursors();
    return;
  }
  drawCursor(el, cr);
  updateExtraCursors();
}

// Keep a Vim motion's fake cursor inside the compose viewport. The cursor is a
// fixed overlay, so it cannot rely on native selection scrolling.
function scrollCursorIntoView(): void {
  const point = domPointAt(state.cursor);
  const block = point ? nearestBlock(point.node) : null;
  block?.scrollIntoView({ block: "nearest", inline: "nearest" });

  const cr = cursorRect();
  if (!cr) return;

  const margin = 8;
  const statusHeight =
    document.getElementById("thundervim-status")?.getBoundingClientRect()
      .height ?? 0;
  const visibleTop = margin;
  const visibleBottom = window.innerHeight - statusHeight - margin;
  let delta = 0;
  if (cr.rect.top < visibleTop) delta = cr.rect.top - visibleTop;
  else if (cr.rect.bottom > visibleBottom)
    delta = cr.rect.bottom - visibleBottom;
  if (delta) window.scrollBy(0, delta);
}

// ------------------------------------------------ visual selection overlay

// The selected linear range [start, end) for the current visual mode.
function selectionRange(): LinearRange | null {
  if (state.anchor == null) return null;
  if (state.mode === MODE.VISUAL) {
    return {
      start: Math.min(state.anchor, state.cursor),
      end: Math.max(state.anchor, state.cursor) + 1,
    };
  }
  if (state.mode === MODE.VLINE) {
    const text = state.text;
    const lo = Math.min(state.anchor, state.cursor);
    const hi = Math.max(state.anchor, state.cursor);
    return {
      start: lineStartAt(text, lo),
      end: lineEndAt(text, hi),
    };
  }
  return null;
}

function buildDomRange(start: number, end: number): Range | null {
  const ps = domPointAt(start);
  // At a text-node boundary, the start belongs to the preceding content while
  // the end belongs to the following content. This distinction matters for a
  // native cross-block edit: selecting a line break must reach into the next
  // block so Gecko can merge the two blocks as one undoable transaction.
  const pe = domPointAt(end, end > start);
  if (!ps || !pe) return null;
  const r = document.createRange();
  try {
    r.setStart(ps.node, ps.br ? 0 : ps.offset);
    r.setEnd(pe.node, pe.br ? 0 : pe.offset);
  } catch {
    return null;
  }
  return r;
}

// Put the real DOM selection over [start, end) so a native command issued next
// (Cmd+B/I/U, copy, cut, paste) acts on the vim visual selection -- which is
// otherwise only an overlay while the native selection stays collapsed.
function selectRangeInDom(start: number, end: number): boolean {
  const r = buildDomRange(start, end);
  if (!r) return false;
  try {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  } catch {
    return false;
  }
}

function ensureHighlights(): HTMLElement {
  let el = document.getElementById("thundervim-highlights");
  if (!el) {
    el = document.createElement("div");
    el.id = "thundervim-highlights";
    el.setAttribute("contenteditable", "false");
    (document.documentElement || document.body).appendChild(el);
  }
  return el;
}

function updateHighlights(): void {
  const cont = ensureHighlights();
  while (cont.firstChild) cont.removeChild(cont.firstChild);
  if (!enabled) {
    cont.style.display = "none";
    return;
  }

  const ranges: { start: number; end: number; cls: string }[] = [];
  // Search matches: live preview while typing a query, else persisted hits.
  const sq = searching
    ? searching.query
    : state.hlsearch
      ? state.search.query
      : "";
  if (sq) {
    // A live query being typed is always a plain substring; a committed
    // search may be whole-word (from `*` / `#`).
    const whole = searching ? false : state.search.wholeWord;
    const matches = computeMatches(state.text, sq, whole);
    for (let mi = 0; mi < matches.length; mi++) {
      ranges.push({
        start: matches[mi].start,
        end: matches[mi].end,
        cls: "thundervim-search-hl",
      });
    }
  }
  // Visual selection.
  const visual = state.mode === MODE.VISUAL || state.mode === MODE.VLINE;
  if (visual) {
    const sr = selectionRange();
    if (sr) ranges.push({ start: sr.start, end: sr.end, cls: "thundervim-hl" });
  }

  if (!ranges.length) {
    cont.style.display = "none";
    return;
  }
  cont.style.display = "block";
  for (let ri = 0; ri < ranges.length; ri++) {
    const range = buildDomRange(ranges[ri].start, ranges[ri].end);
    if (!range) continue;
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.height <= 0) continue;
      const d = document.createElement("div");
      d.className = ranges[ri].cls;
      d.style.left = r.left + "px";
      d.style.top = r.top + "px";
      d.style.width = (r.width > 0 ? r.width : 8) + "px";
      d.style.height = r.height + "px";
      cont.appendChild(d);
    }
  }
}

function render(): void {
  updateCursor();
  updateHighlights();
}

function removeChromeOverlays(): void {
  for (const id of [
    "thundervim-status",
    "thundervim-status-host",
    "thundervim-cursor",
    "thundervim-multi-cursors",
    "thundervim-highlights",
    "thundervim-dump",
  ]) {
    document.getElementById(id)?.remove();
  }
}

function beforeSendCleanup(): void {
  removeChromeOverlays();
  window.setTimeout(() => {
    if (document.body?.isConnected) updateBar();
  }, 1000);
}

// ----------------------------------------------------------- mode indicator

function ensureStatusBar(): HTMLElement {
  document.getElementById("thundervim-status-host")?.remove();
  let bar = document.getElementById("thundervim-status");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "thundervim-status";
    bar.setAttribute("contenteditable", "false");
    bar.setAttribute("role", "status");
    (document.documentElement || document.body).appendChild(bar);
  }
  if (bar.firstChild) bar.replaceChildren();
  return bar;
}

function setStatusText(
  leftText: string,
  rightText: string,
  mode: string,
): void {
  const bar = ensureStatusBar();
  bar.setAttribute("data-mode", mode);
  bar.setAttribute("data-left", leftText);
  bar.setAttribute("data-right", rightText);
}

function sendModeUpdate(
  leftText: string,
  rightText: string,
  mode: string,
): void {
  const runtime = extensionApi()?.runtime;
  if (!runtime) return;
  void runtime.sendMessage({
    type: "thundervim:mode",
    mode,
    left: leftText,
    right: rightText,
  });
}

function setBar(leftText: string, rightText: string, mode: string): void {
  setStatusText(leftText, rightText || "", mode);
  sendModeUpdate(leftText, rightText || "", mode);
  render();
}
function modeLabel(): string {
  switch (state.mode) {
    case MODE.NORMAL:
      return "NORMAL";
    case MODE.INSERT:
      return "INSERT";
    case MODE.VISUAL:
      return "VISUAL";
    case MODE.VLINE:
      return "VISUAL LINE";
    default:
      return state.mode;
  }
}
function pendingHint(): string {
  const p = state.pending;
  let s = (p.count || "") + (p.op || "") + (p.opCount || "");
  if (p.g) s += "g";
  if (p.replace) s += "r";
  return s ? "  " + s : "";
}
// vim-style ruler: 1-based line and column of `pos`, plus a Top/Bot/All/
// percentage indicator of how far that line sits through `text`.
function rulerFor(text: string, pos: number): string {
  if (pos < 0) pos = 0;
  if (pos > text.length) pos = text.length;
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  const nlEnd = text.indexOf("\n", pos);
  const le = nlEnd === -1 ? text.length : nlEnd;
  const lineNum = text.slice(0, pos).split("\n").length;
  const totalLines = text.split("\n").length;
  // vim shows `0-1` on an empty line (byte col 0, virtual col 1).
  const colText = le - ls === 0 ? "0-1" : String(pos - ls + 1);
  let pos3: string;
  if (totalLines <= 1) pos3 = "All";
  else if (lineNum === 1) pos3 = "Top";
  else if (lineNum === totalLines) pos3 = "Bot";
  else pos3 = Math.floor(((lineNum - 1) * 100) / (totalLines - 1)) + "%";
  return lineNum + "," + colText + "   " + pos3;
}
function ruler(): string {
  return rulerFor(state.text, state.cursor);
}
// In Insert mode the engine's cursor is stale (the native editor owns the
// caret), so recompute the ruler from the live DOM caret on every caret move.
function updateRulerLive(): void {
  if (!enabled || state.mode !== MODE.INSERT) return;
  const b = readBuffer();
  if (!b) return;
  setBar("-- INSERT --", rulerFor(b.text, b.caret), MODE.INSERT);
}
function updateBar(): void {
  if (!enabled) {
    setBar("-- vim off --", "", "off");
    return;
  }
  if (searching) {
    setBar((searching.dir > 0 ? "/" : "?") + searching.query, "", "search");
    return;
  }
  const left =
    "-- " +
    modeLabel() +
    " --" +
    pendingHint() +
    (multiCursorCount() > 1 ? "  " + multiCursorCount() + " cursors" : "") +
    (searchMsg ? "  " + searchMsg : "");
  setBar(left, ruler(), state.mode);
}

interface MultiEditOp {
  start: number;
  end: number;
  repl: string;
  primary: boolean;
}


function targetColumn(pos: number): number {
  return pos - lineStartAt(state.text, pos);
}

function cursorLine(pos: number): number {
  return state.text.slice(0, pos).split("\n").length - 1;
}

function lineSpanAtIndex(line: number): { start: number; end: number } | null {
  if (line < 0) return null;
  let start = 0;
  let current = 0;
  for (let i = 0; i <= state.text.length; i++) {
    if (i === state.text.length || state.text[i] === "\n") {
      if (current === line) return { start, end: i };
      start = i + 1;
      current++;
    }
  }
  return null;
}

function offsetAtLineColumn(line: number, col: number): number | null {
  const span = lineSpanAtIndex(line);
  if (!span) return null;
  return clampNormal(state.text, Math.min(span.start + col, span.end));
}

function addVerticalCursor(delta: -1 | 1): boolean {
  if (!enabled) return false;
  const cursors = allCursors();
  const base = delta > 0 ? cursors[cursors.length - 1] : cursors[0];
  const target = offsetAtLineColumn(
    cursorLine(base) + delta,
    targetColumn(base),
  );
  if (target == null) return false;
  extraCursors = cursors.filter((pos) => pos !== target);
  state.cursor = target;
  normalizeExtraCursors();
  setNativeCaret(state.cursor);
  render();
  updateBar();
  return true;
}

function isMacOS(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function primaryModifier(ev: NormKey): boolean {
  return isMacOS() ? ev.meta : ev.ctrl;
}

function nonPrimaryModifier(ev: NormKey): boolean {
  return isMacOS() ? ev.ctrl : ev.meta;
}

function isAddCursorBelow(ev: NormKey): boolean {
  return (
    primaryModifier(ev) &&
    ev.alt &&
    !ev.shift &&
    !nonPrimaryModifier(ev) &&
    (ev.key === "ArrowDown" || ev.code === "ArrowDown")
  );
}

function isAddCursorAbove(ev: NormKey): boolean {
  return (
    primaryModifier(ev) &&
    ev.alt &&
    !ev.shift &&
    !nonPrimaryModifier(ev) &&
    (ev.key === "ArrowUp" || ev.code === "ArrowUp")
  );
}

function multiEditOps(input: InputEvent): MultiEditOp[] | null {
  const cursors = allCursors();
  if (cursors.length <= 1) return null;
  const data = input.data ?? "";
  switch (input.inputType) {
    case "insertText":
    case "insertCompositionText":
    case "insertReplacementText":
      return data
        ? cursors.map((pos) => ({
            start: pos,
            end: pos,
            repl: data,
            primary: pos === state.cursor,
          }))
        : null;
    case "insertLineBreak":
    case "insertParagraph":
      return cursors.map((pos) => ({
        start: pos,
        end: pos,
        repl: "\n",
        primary: pos === state.cursor,
      }));
    case "deleteContentBackward":
      return cursors
        .filter((pos) => pos > 0)
        .map((pos) => ({
          start: pos - 1,
          end: pos,
          repl: "",
          primary: pos === state.cursor,
        }));
    case "deleteContentForward":
      return cursors
        .filter((pos) => pos < state.text.length)
        .map((pos) => ({
          start: pos,
          end: pos + 1,
          repl: "",
          primary: pos === state.cursor,
        }));
    default:
      return null;
  }
}

function cloneStateForCursor(
  text: string,
  cursor: number,
  source: State,
): State {
  const clone = createState(text, cursor);
  clone.mode = source.mode;
  clone.desiredCol = source.desiredCol;
  clone.anchor = source.anchor;
  clone.lastFind = source.lastFind ? { ...source.lastFind } : null;
  clone.shiftwidth = source.shiftwidth;
  clone.textwidth = source.textwidth;
  clone.search = { ...source.search };
  clone.hlsearch = source.hlsearch;
  clone.lastSearchInfo = source.lastSearchInfo
    ? { ...source.lastSearchInfo }
    : null;
  clone.pending = { ...source.pending };
  return clone;
}

function mirrorExtraCursorMotion(
  ev: NormKey,
  before: State,
  beforeExtraCursors: number[],
): void {
  if (!beforeExtraCursors.length || state.text !== before.text) return;
  const next: number[] = [];
  for (const cursor of beforeExtraCursors) {
    const clone = cloneStateForCursor(before.text, cursor, before);
    const result = handleKey(clone, ev);
    if (!result.handled || clone.text !== before.text) return;
    next.push(clone.cursor);
  }
  extraCursors = next;
  normalizeExtraCursors();
}

function applyMultiEdit(ops: MultiEditOp[]): void {
  const ordered = ops
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter((op, idx, arr) => idx === 0 || op.start >= arr[idx - 1].end);
  let out = "";
  let last = 0;
  let delta = 0;
  const nextPositions: number[] = [];
  let primary = state.cursor;
  for (const op of ordered) {
    out += state.text.slice(last, op.start) + op.repl;
    const next = op.start + delta + op.repl.length;
    nextPositions.push(next);
    if (op.primary) primary = next;
    delta += op.repl.length - (op.end - op.start);
    last = op.end;
  }
  out += state.text.slice(last);
  state.text = out;
  state.cursor = primary;
  extraCursors = nextPositions.filter((pos) => pos !== primary);
  normalizeExtraCursors();
  syncDom(true);
  updateBar();
}

// --------------------------------------------------------- key handling

function normalize(e: KeyboardEvent): NormKey {
  return {
    key: e.key,
    code: e.code,
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}
function swallow(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  suppressInput = true;
  // Clear on the next tick so ONLY the input events synchronously produced by
  // this key (keypress + beforeinput) are cancelled. Otherwise the flag would
  // linger and cancel unrelated input in the window before the next keydown
  // (e.g. clicking the Bold/Italic toolbar button, paste, or IME), which
  // silently breaks those actions.
  setTimeout(function () {
    suppressInput = false;
  }, 0);
}

// Input types produced by the plain character insertion / deletion that a
// swallowed vim key would otherwise cause. Only these are cancelled while
// `suppressInput` is set. Everything else (formatBold/Italic/Underline,
// historyUndo/Redo, insertFromPaste, ...) must always go through, so Cmd+B/I/U
// and the formatting toolbar keep working.
const TEXT_EDIT_INPUT_TYPES: Record<string, number> = {
  insertText: 1,
  insertCompositionText: 1,
  insertReplacementText: 1,
  insertLineBreak: 1,
  insertParagraph: 1,
  deleteContent: 1,
  deleteContentBackward: 1,
  deleteContentForward: 1,
  deleteWordBackward: 1,
  deleteWordForward: 1,
};

// Cancel the editor edit that a swallowed key would otherwise produce. This
// fires after our keydown handler ran and set `suppressInput`. The flag stays
// set only for the current tick (see `swallow`), so both keypress and
// beforeinput for the same key are cancelled without affecting later,
// unrelated input events.
function onInputEvent(e: Event): void {
  if (e.type === "beforeinput") {
    const input = e as InputEvent;
    traceDebug(
      "beforeinput",
      {
        inputType: input.inputType || "",
        nativeTransaction: applyingVimTransaction,
      },
      false,
    );
  }
  if (applyingVimTransaction) return;

  if (
    e.type === "beforeinput" &&
    enabled &&
    state.mode === MODE.INSERT &&
    extraCursors.length > 0
  ) {
    const ops = multiEditOps(e as InputEvent);
    if (ops) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      applyMultiEdit(ops);
      return;
    }
  }

  if (!suppressInput) return;
  // A `beforeinput` carries an inputType; only suppress genuine text edits.
  // Formatting/clipboard/history commands (which have no keypress) pass.
  if (
    e.type === "beforeinput" &&
    (e as InputEvent).inputType &&
    !TEXT_EDIT_INPUT_TYPES[(e as InputEvent).inputType]
  ) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}

function onInputCommitted(e: Event): void {
  if (!debugTracing || applyingVimTransaction) return;
  const inputType = (e as InputEvent).inputType || "";
  setTimeout(() => traceDebug("input", { inputType }), 0);
}

function isToggle(ev: NormKey): boolean {
  const t = config.toggle;
  return (
    !!t.ctrl === primaryModifier(ev) &&
    !!t.alt === ev.alt &&
    !!t.shift === !!ev.shift &&
    !nonPrimaryModifier(ev) &&
    ev.key.toLowerCase() === t.key.toLowerCase()
  );
}

// The net text inserted between two buffer snapshots (common prefix/suffix).
function diffInsert(before: string, after: string): string {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let sfx = 0;
  while (
    sfx < max - p &&
    before.charCodeAt(before.length - 1 - sfx) ===
      after.charCodeAt(after.length - 1 - sfx)
  )
    sfx++;
  return after.slice(p, after.length - sfx);
}

// Report the text typed during the just-ended Insert session to the engine so
// `.` can replay it, then clear the snapshot.
function finalizeInsert(finalText: string): void {
  if (insertStart) {
    finishInsert(state, diffInsert(insertStart.text, finalText));
    insertStart = null;
  }
}

// Handle the "jk" style escape sequence while in Insert mode. Returns true if
// the event was consumed.
function handleInsertEscape(e: KeyboardEvent, ev: NormKey): boolean {
  const seq = config.insertEscapeSequence;
  if (!seq || seq.length !== 2) return false;
  if (ev.ctrl || ev.alt || ev.meta || ev.key.length !== 1) {
    lastInsert = { key: null, time: 0 };
    return false;
  }
  const now = Date.now();
  if (
    ev.key === seq[1] &&
    lastInsert.key === seq[0] &&
    now - lastInsert.time < config.escapeTimeoutMs
  ) {
    // The first key (seq[0]) was already typed natively; remove it, then exit.
    swallow(e);
    const buf = readBuffer()!;
    let text = buf.text;
    let caret = buf.caret;
    if (caret > 0 && text[caret - 1] === seq[0]) {
      text = text.slice(0, caret - 1) + text.slice(caret);
      caret = caret - 1;
    }
    finalizeInsert(text);
    syncFromEditor(state, text, caret);
    state.mode = MODE.NORMAL;
    state.cursor = clampNormal(text, caret - 1);
    syncDom(false);
    updateBar();
    lastInsert = { key: null, time: 0 };
    return true;
  }
  lastInsert = { key: ev.key, time: now };
  return false;
}

// ------------------------------------------------------------ search prompt

function beginSearch(dir: number): void {
  searching = { dir: dir, query: "" };
  searchMsg = "";
  updateBar();
}

function searchMessage(info: SearchInfo | null): string {
  if (!info || !info.found) {
    return "Pattern not found: " + (state.search.query || "");
  }
  if (info.wrapped) {
    return state.search.dir > 0
      ? "search hit BOTTOM, continuing at TOP"
      : "search hit TOP, continuing at BOTTOM";
  }
  return "";
}

// Consume a key while the `/`|`?` prompt is open. Returns nothing; always
// swallows the event.
function handleSearchKey(e: KeyboardEvent, ev: NormKey): void {
  const s = searching;
  if (!s) return;
  swallow(e);
  if (ev.key === "Escape") {
    searching = null;
    searchMsg = "";
    updateBar();
    return;
  }
  if (ev.key === "Enter") {
    const q = s.query;
    const dir = s.dir;
    searching = null;
    const info = setSearch(state, q, dir);
    searchMsg = searchMessage(info);
    syncDom(false);
    updateBar();
    return;
  }
  if (ev.key === "Backspace") {
    if (s.query.length > 0) {
      s.query = s.query.slice(0, -1);
    } else {
      searching = null; // backspace past the prompt cancels
    }
    updateBar();
    return;
  }
  if (!ev.ctrl && !ev.meta && !ev.alt && ev.key.length === 1) {
    s.query += ev.key;
    updateBar();
    return;
  }
  // Ignore anything else (arrows, function keys) but keep the prompt open.
}

function toggleEnabled(): void {
  enabled = !enabled;
  if (enabled) {
    const b = readBuffer();
    rebaseFromEditor(state, b ? b.text : "", b ? b.caret : 0);
    state.mode = MODE.NORMAL;
    syncDom(false);
  } else {
    extraCursors = [];
    render();
  }
  updateBar();
}

function messageType(message: unknown): string | null {
  return typeof message === "object" && message !== null
    ? (((message as { type?: unknown }).type as string | undefined) ?? null)
    : null;
}

extensionApi()?.runtime?.onMessage?.addListener((message) => {
  switch (messageType(message)) {
    case "thundervim:toggle":
      toggleEnabled();
      break;
    case "thundervim:before-send":
      removeChromeOverlays();
      break;
  }
});

function canRunNativeVimUndo(): boolean {
  const p = state.pending;
  return !p.op && !p.g && !p.replace && !p.textobj && !p.find;
}

function toggleDebugTrace(): void {
  if (debugTracing) {
    traceDebug("trace:stop");
    debugTracing = false;
    dumpState("manual");
    return;
  }

  debugTrace.length = 0;
  debugTraceSeq = 0;
  debugTraceStarted = Date.now();
  debugTracing = true;
  traceDebug("trace:start");
  const chord = isMacOS() ? "Ctrl-Option-D" : "Ctrl-Alt-D";
  setBar(`-- thundervim: trace recording (${chord} to stop) --`, "", "normal");
}

function resyncInsertAfterNativeHistory(): void {
  const b = readBuffer();
  if (!b) return;
  state.text = b.text;
  state.cursor = b.caret;
  // Native undo may change text lengths independently at every cursor. Keep the
  // primary native caret and drop offsets that can no longer be reconstructed.
  extraCursors = [];
  updateBar();
  traceDebug("insert-history:resync");
}

function runNativeHistory(command: "undo" | "redo", count: number): void {
  traceDebug("native-history:start", { command, count });
  applyingVimTransaction = true;
  try {
    for (let i = 0; i < count; i++) {
      if (!document.execCommand(command)) break;
    }
  } catch {
    // A failed native history command is a no-op. Once native Vim edits have
    // succeeded, falling back to the engine stack would traverse a stale copy.
  } finally {
    applyingVimTransaction = false;
  }

  const b = readBuffer();
  if (b) rebaseFromEditor(state, b.text, b.caret);
  state.mode = MODE.NORMAL;
  state.anchor = null;
  state.desiredCol = null;
  state.pending.count = "";
  state.pending.op = null;
  state.pending.opCount = "";
  state.pending.g = false;
  state.pending.replace = false;
  state.pending.textobj = null;
  state.pending.find = null;
  state._hadCount = false;
  state._seq = [];
  extraCursors = [];
  ensureTrailingPad(state.text);
  setNativeCaret(state.cursor);
  updateBar();
  traceDebug("native-history:end", { command, count });
}

function onKeydown(e: KeyboardEvent): void {
  suppressInput = false;
  const ev = normalize(e);

  const redactInsertKey =
    state.mode === MODE.INSERT &&
    ev.key.length === 1 &&
    !ev.ctrl &&
    !ev.alt &&
    !ev.meta;
  traceDebug("keydown", {
    key: redactInsertKey ? "<text>" : ev.key,
    code: redactInsertKey ? "" : ev.code,
    ctrl: ev.ctrl,
    alt: ev.alt,
    shift: ev.shift,
    meta: ev.meta,
  });

  // The enable/disable toggle works even while Thundervim is off.
  if (isToggle(ev)) {
    swallow(e);
    toggleEnabled();
    return;
  }

  if (
    enabled &&
    state.mode !== MODE.INSERT &&
    (isAddCursorBelow(ev) || isAddCursorAbove(ev))
  ) {
    swallow(e);
    const added = addVerticalCursor(isAddCursorBelow(ev) ? 1 : -1);
    // Gecko cannot group disjoint cursor ranges into one undo transaction.
    // Switch only after a cursor was actually activated, before any
    // multi-cursor command can mix the native and snapshot histories.
    if (added && sharedNativeHistory) {
      state.undoStack = [];
      state.redoStack = [];
      disableNativeHistoryBridge("multi-cursor-enabled");
    }
    traceDebug("multi-cursor", { added });
    return;
  }

  // Ctrl-Alt-D toggles the opt-in flight recorder. The first press starts a
  // fresh trace; the second stops it and opens the copyable dump. Match on the
  // physical key because macOS Option rewrites the logical key value.
  if (
    ev.ctrl &&
    ev.alt &&
    !ev.meta &&
    (ev.code === "KeyD" || ev.key.toLowerCase() === "d")
  ) {
    swallow(e);
    toggleDebugTrace();
    return;
  }

  if (!enabled) return;

  // Ignore standalone modifier presses. Their keydown fires between a prefix
  // key (r, i, a, ...) and the real character, and must not disturb pending
  // engine state (e.g. `rH` or `ci(` where the char needs Shift).
  if (
    ev.key === "Shift" ||
    ev.key === "Control" ||
    ev.key === "Alt" ||
    ev.key === "Meta" ||
    ev.key === "CapsLock" ||
    ev.key === "AltGraph"
  ) {
    return;
  }

  // The search prompt owns every key while it is open.
  if (searching) {
    handleSearchKey(e, ev);
    return;
  }

  // Reconcile native editor commands afterward so Gecko's independent undo
  // manager cannot leave stale Vim snapshots behind. Other primary-modifier
  // shortcuts (Send, Save, Find, etc.) pass through without mode side effects.
  const nativeCommand = nativeEditorCommand(ev, isMacOS());
  if (nativeCommand) {
    const vis = state.mode === MODE.VISUAL || state.mode === MODE.VLINE;
    if (vis) {
      const sr = selectionRange();
      const caret = sr ? sr.start : state.cursor;
      // Formatting and clipboard commands act on the Vim Visual range. Native
      // history commands operate on the editor history and need no selection.
      if (nativeCommand === "selection" && sr)
        selectRangeInDom(sr.start, sr.end);
      setTimeout(function () {
        afterVisualNativeCommand(caret);
      }, 0);
    } else if (state.mode === MODE.INSERT) {
      if (nativeCommand === "history")
        setTimeout(resyncInsertAfterNativeHistory, 0);
    } else {
      setTimeout(resyncFromDom, 0);
    }
    return;
  }

  const historyCommand = vimHistoryCommand(ev);
  const canRunHistory =
    historyCommand &&
    state.mode === MODE.NORMAL &&
    (historyCommand === "redo" || canRunNativeVimUndo());
  if (sharedNativeHistory && canRunHistory) {
    const count = Math.max(1, Number.parseInt(state.pending.count, 10) || 1);
    runNativeHistory(historyCommand, count);
    swallow(e);
    return;
  }

  if (state.mode === MODE.INSERT) {
    if (ev.key === "Escape") {
      const buf = readBuffer()!;
      finalizeInsert(buf.text);
      // Keep the raw insert caret (it may sit past the last char); the engine's
      // Escape handler performs the single Normal-mode "move left".
      state.text = buf.text;
      state.cursor = buf.caret;
      const insertCursors = extraCursors.slice();
      const r = handleKey(state, ev); // -> Normal, cursor left once
      if (r.handled) {
        extraCursors = insertCursors.map((pos) =>
          clampNormal(state.text, pos - 1),
        );
        normalizeExtraCursors();
        swallow(e);
        syncDom(false);
        updateBar();
        traceDebug("insert:escape");
      }
      return;
    }
    if (handleInsertEscape(e, ev)) return;
    return; // let the native editor type
  }

  if (
    state.mode === MODE.NORMAL &&
    ev.key === "Escape" &&
    extraCursors.length
  ) {
    swallow(e);
    clearExtraCursors();
    return;
  }

  // Open the search prompt (`/` forward, `?` backward) from Normal mode.
  if (state.mode === MODE.NORMAL && (ev.key === "/" || ev.key === "?")) {
    swallow(e);
    beginSearch(ev.key === "/" ? 1 : -1);
    return;
  }
  // A fresh action clears any lingering search message.
  searchMsg = "";

  // Normal / Visual: the engine's state is authoritative here (we are the only
  // thing editing the buffer), so we do NOT re-read the caret from the DOM per
  // key — doing so lets Gecko's caret normalization on empty lines desync
  // vertical motion. Mouse repositioning is handled by the mouseup listener.
  const before = cloneStateForCursor(state.text, state.cursor, state);
  const beforeExtraCursors = extraCursors.slice();
  const res = handleKey(state, ev);
  if (!res.handled) {
    updateBar(); // reflect pending count/operator
    return; // modifier chords etc. pass through to Thunderbird
  }
  swallow(e);
  // n/N surface a wrap / not-found note in the status bar.
  if (ev.key === "n" || ev.key === "N") {
    searchMsg = searchMessage(state.lastSearchInfo);
  }
  // A command just entered Insert mode: snapshot the buffer so the typed text
  // can be recovered for dot-repeat when Insert mode exits. handleKey may have
  // switched the mode; cast past the stale narrowing from the earlier Insert
  // check above, which TS can't know handleKey invalidated.
  mirrorExtraCursorMotion(ev, before, beforeExtraCursors);
  const enteredInsert = (state.mode as Mode) === MODE.INSERT;
  if (enteredInsert) {
    insertStart = { text: state.text, cursor: state.cursor };
  }
  syncDom(enteredInsert);
  updateBar();
  if (!enteredInsert) scrollCursorIntoView();
  traceDebug("vim-command:end", {
    key: ev.key,
    enteredInsert,
    textChanged: before.text !== state.text,
  });
}

// ---------------------------------------------------------------- init

// Diagnostic: dump the live DOM and linear model into an extension-owned
// popup. It must never be mounted in the compose body: Thunderbird can autosave
// that body at any moment and would persist diagnostic UI as message content.
function dumpState(label?: string) {
  const b = readBuffer();
  const info = {
    label: label || "",
    mode: state.mode,
    history: sharedNativeHistory ? "native" : "split",
    cursor: state.cursor,
    text: b ? b.text : null,
    caret: b ? b.caret : null,
    html: document.body ? document.body.innerHTML : null,
    traceRecording: debugTracing,
    trace: debugTrace.slice(),
  };
  const json = JSON.stringify(info, null, 2);
  if (typeof console !== "undefined" && console.log)
    console.log("thundervim dump", info);
  void showDumpWindow(json);
  return info;
}

async function showDumpWindow(text: string): Promise<void> {
  const runtime = extensionApi()?.runtime;
  if (!runtime) {
    window.prompt("Copy the Thundervim diagnostic dump:", text);
    return;
  }
  try {
    await runtime.sendMessage({ type: "thundervim:debug-dump", text });
    setBar("-- thundervim: dump opened in a separate window --", "", "normal");
  } catch {
    // A native prompt is less convenient but still cannot be serialized into
    // the draft, unlike an element mounted in the compose body.
    window.prompt("Copy the Thundervim diagnostic dump:", text);
  }
}
if (typeof window !== "undefined") window.thundervim_dump = dumpState;

async function init(): Promise<void> {
  applyConfig(await loadConfig());
  state.mode = config.defaultMode === "normal" ? MODE.NORMAL : MODE.INSERT;
  enabled = config.enableOnStart;
  // Remove a diagnostic overlay persisted by older development builds before
  // Thunderbird gets another chance to autosave it.
  document.getElementById("thundervim-dump")?.remove();
  normalizeCollapsibleWhitespace();
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("keypress", onInputEvent, true);
  document.addEventListener("beforeinput", onInputEvent, true);
  document.addEventListener("input", onInputCommitted, true);
  // While typing in Insert mode the engine cursor is stale, so keep the ruler
  // live from the DOM caret. `selectionchange` covers typing, arrows and clicks.
  document.addEventListener("selectionchange", updateRulerLive);
  // Last line of defense: remove all Thundervim chrome before Thunderbird
  // serializes the compose document for sending. If sending is canceled, the
  // status bar is recreated shortly after.
  window.addEventListener("compose-send-message", beforeSendCleanup, true);
  window.addEventListener("beforeunload", removeChromeOverlays, true);
  window.addEventListener("pagehide", removeChromeOverlays, true);
  // Keep the block cursor and selection aligned when the view moves without
  // a keystroke.
  window.addEventListener("scroll", render, true);
  window.addEventListener("resize", render, true);
  document.addEventListener(
    "mouseup",
    function () {
      if (enabled && state.mode !== MODE.INSERT) {
        const b = readBuffer();
        if (b) syncFromEditor(state, b.text, b.caret);
        render();
        traceDebug("mouseup:resync");
      }
    },
    true,
  );
  updateBar();
  traceDebug("init");
}
if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      void init();
    },
    { once: true },
  );
} else {
  void init();
}
