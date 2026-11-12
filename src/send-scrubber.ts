export interface ComposeDetails {
  isPlainText?: boolean;
  plainTextBody?: string;
  body?: string;
}

interface ParsedHtmlDocument {
  body: { innerHTML: string; readonly textContent?: string | null } | null;
  getElementById(id: string): { remove(): void } | null;
}

export interface HtmlParser {
  parseFromString(body: string, type: "text/html"): ParsedHtmlDocument;
}

const STATUS_MARKER = "\u2063\u200c\u200d\u2063";
// Older builds could serialize their text-bearing status element directly after
// the message. Keep removing its unique marker without deleting the whole line.
const MARKED_STATUS_LINE_RE = new RegExp(
  String.raw`(?:\r?\n)*[ \t]*${STATUS_MARKER}[^\r\n]*$`,
  "u",
);
const LEGACY_STATUS_LINE_RE =
  /(?:^|(?:\r?\n)+)(?:--\s*(?:INSERT|NORMAL|VISUAL(?: LINE)?|vim off)\s*--|[/?][^\r\n]*)(?:\s*\d+,\S+\s+(?:Top|Bot|All|\d+%))?\s*$/;

export function scrubPlainTextBody(body: string): string {
  return body
    .replace(MARKED_STATUS_LINE_RE, "")
    .replace(LEGACY_STATUS_LINE_RE, "");
}

export function scrubHtmlBody(
  body: string,
  parser: HtmlParser = new DOMParser(),
): string {
  const doc = parser.parseFromString(body, "text/html");
  // Never scrub doc.body.textContent: assigning it would flatten all HTML
  // structure, including the elements that preserve visible line breaks.
  let changed = false;
  for (const id of [
    "thundervim-status",
    "thundervim-status-host",
    "thundervim-dump",
  ]) {
    const node = doc.getElementById(id);
    if (node) {
      node.remove();
      changed = true;
    }
  }
  return changed && doc.body ? doc.body.innerHTML : body;
}

export function scrubDetails(details: ComposeDetails): ComposeDetails | null {
  const usePlainTextBody =
    details.isPlainText === true ||
    (details.isPlainText === undefined &&
      typeof details.plainTextBody === "string" &&
      typeof details.body !== "string");
  const useHtmlBody =
    details.isPlainText === false ||
    (details.isPlainText === undefined &&
      typeof details.body === "string" &&
      typeof details.plainTextBody !== "string");

  if (usePlainTextBody && typeof details.plainTextBody === "string") {
    const plainTextBody = scrubPlainTextBody(details.plainTextBody);
    return plainTextBody === details.plainTextBody
      ? null
      : { isPlainText: true, plainTextBody };
  }

  if (useHtmlBody && typeof details.body === "string") {
    const body = scrubHtmlBody(details.body);
    return body === details.body ? null : { isPlainText: false, body };
  }

  return null;
}
