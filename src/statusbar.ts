export function renderStatusBar(
  doc: Document,
  leftText: string,
  rightText: string,
  mode: string,
): void {
  doc.getElementById("thundervim-status-host")?.remove();
  let bar = doc.getElementById("thundervim-status");
  if (!bar) {
    bar = doc.createElement("div");
    bar.id = "thundervim-status";
    (doc.documentElement || doc.body).appendChild(bar);
  }

  bar.setAttribute("contenteditable", "false");
  bar.setAttribute("role", "status");
  if (bar.firstChild) bar.replaceChildren();
  bar.setAttribute("data-mode", mode);
  bar.setAttribute("data-left", leftText);
  bar.setAttribute("data-right", rightText);
}
