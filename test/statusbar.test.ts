/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import { renderStatusBar } from "../src/statusbar.ts";

class FakeElement {
  id = "";
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private readonly ownText: string;

  constructor(ownText = "") {
    this.ownText = ownText;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  readonly documentElement = new FakeElement();
  readonly body = new FakeElement();

  constructor() {
    this.documentElement.appendChild(this.body);
  }

  createElement(_tagName: string): FakeElement {
    return new FakeElement();
  }

  getElementById(id: string): FakeElement | null {
    function find(element: FakeElement): FakeElement | null {
      if (element.id === id) return element;
      for (const child of element.children) {
        const match = find(child);
        if (match) return match;
      }
      return null;
    }
    return find(this.documentElement);
  }
}

function asDocument(doc: FakeDocument): Document {
  return doc as unknown as Document;
}

test("status labels never become DOM text", () => {
  const doc = new FakeDocument();

  renderStatusBar(asDocument(doc), "-- NORMAL --", "10,1 Bot", "normal");

  const bar = doc.getElementById("thundervim-status");
  assert.ok(bar);
  assert.strictEqual(bar.textContent, "");
  assert.strictEqual(bar.getAttribute("data-left"), "-- NORMAL --");
  assert.strictEqual(bar.getAttribute("data-right"), "10,1 Bot");
  assert.strictEqual(bar.getAttribute("data-mode"), "normal");
});

test("updating a legacy status bar removes its text children", () => {
  const doc = new FakeDocument();
  const bar = doc.createElement("div");
  bar.id = "thundervim-status";
  bar.appendChild(new FakeElement("legacy status text"));
  doc.documentElement.appendChild(bar);

  renderStatusBar(asDocument(doc), "-- INSERT --", "1,1 Top", "insert");

  assert.strictEqual(bar.textContent, "");
  assert.strictEqual(bar.firstChild, null);
  assert.strictEqual(bar.getAttribute("data-left"), "-- INSERT --");
  assert.strictEqual(bar.getAttribute("data-right"), "1,1 Top");
});
