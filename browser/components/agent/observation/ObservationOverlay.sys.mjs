/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const STYLE = `
  :host { all: initial; }
  .overlay { position: fixed; inset: 0; overflow: hidden; pointer-events: none !important; }
  .box { position: absolute; box-sizing: border-box; border: 2px solid #2563eb;
    background: rgb(37 99 235 / 12%); border-radius: 3px; pointer-events: none !important; }
  .box.selected { border: 3px solid #c2410c; background: rgb(234 88 12 / 23%); z-index: 1; }
  .number { position: absolute; top: 0; left: 0; background: #1d4ed8; color: white;
    padding: 1px 3px; font: bold 10px/13px system-ui; border-radius: 2px; }
  .selected .number { background: #9a3412; }
  @media (forced-colors: active) {
    .box { border-color: Highlight; background: transparent; }
    .box.selected { border-style: dashed; border-color: CanvasText; }
    .number { background: Highlight; color: HighlightText; }
  }
`;

/** Paints diagnostic boxes without modifying or intercepting page content. */
export class ObservationOverlay {
  constructor(document) {
    this.document = document;
  }

  show(items, selected = null) {
    this.clear();
    if (!items.length) {
      return;
    }
    const fragment = this.document.createDocumentFragment();
    const style = this.document.createElementNS(HTML_NS, "style");
    style.textContent = STYLE;
    const container = this.document.createElementNS(HTML_NS, "div");
    container.className = "overlay";
    container.setAttribute("aria-hidden", "true");
    for (const item of items) {
      const box = this.document.createElementNS(HTML_NS, "div");
      box.className = item.nodeId === selected ? "box selected" : "box";
      const { x, y, width, height } = item.rect;
      Object.assign(box.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      const number = this.document.createElementNS(HTML_NS, "span");
      number.className = "number";
      number.textContent = item.index;
      box.append(number);
      container.append(box);
    }
    fragment.append(style, container);
    this.content = this.document.insertAnonymousContent();
    this.content.root.append(fragment);
  }

  clear() {
    if (this.content) {
      try {
        this.document.removeAnonymousContent(this.content);
      } catch {
        // A navigation may already have destroyed the document's canvas frame.
      }
      this.content = null;
    }
  }
}
