/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectDOMObservation } from "resource:///modules/agent/observation/DOMObservation.sys.mjs";
import { ObservationOverlay } from "resource:///modules/agent/observation/ObservationOverlay.sys.mjs";

/** Keeps DOM references and diagnostic overlays inside their owning document. */
export class AgentObservationChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    switch (name) {
      case "AgentObservation:Capture":
        return this.capture(data);
      case "AgentObservation:Show":
        return this.show(data);
      case "AgentObservation:Clear":
        if (this.id === data.id) {
          this.clear();
        }
        return true;
    }
    return null;
  }

  capture({ id, options }) {
    this.clear();
    const { snapshot, targets } = collectDOMObservation(
      this.contentWindow,
      options
    );
    this.id = id;
    this.targets = targets;
    this.capturedWidth = this.contentWindow.innerWidth;
    this.capturedHeight = this.contentWindow.innerHeight;
    this.overlay = new ObservationOverlay(this.document);
    this.mutationObserver = new this.contentWindow.MutationObserver(() =>
      this.invalidate("mutation")
    );
    const roots = [this.document];
    for (let i = 0; i < roots.length; i++) {
      this.mutationObserver.observe(roots[i], {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      for (const element of roots[i].querySelectorAll("*")) {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
        }
      }
    }
    for (const type of [
      "scroll",
      "resize",
      "input",
      "change",
      "pagehide",
      "hashchange",
      "popstate",
    ]) {
      this.contentWindow.addEventListener(type, this, true);
    }
    return { ...snapshot, documentId: this.manager.innerWindowId };
  }

  show({ id, documentId, items, selected = null }) {
    if (
      id !== this.id ||
      documentId !== this.manager.innerWindowId ||
      this.mutationObserver?.takeRecords().length
    ) {
      this.invalidate("stale");
      return false;
    }
    const boxes = [];
    for (const item of items) {
      const reference = this.targets.get(item.nodeId);
      if (!reference?.element.isConnected || !reference.target.isConnected) {
        this.invalidate("detached");
        return false;
      }
      const rect = reference.target.getBoundingClientRect();
      if (
        ["x", "y", "width", "height"].some(
          key => Math.abs(rect[key] - item.rect[key]) > 2
        )
      ) {
        this.invalidate("geometry");
        return false;
      }
      boxes.push(item);
    }
    this.overlay.show(boxes, selected);
    return true;
  }

  handleEvent(event) {
    if (
      event.type === "resize" &&
      this.contentWindow.innerWidth === this.capturedWidth &&
      this.contentWindow.innerHeight === this.capturedHeight
    ) {
      return;
    }
    this.invalidate(event.type);
  }

  invalidate(reason) {
    if (!this.id) {
      return;
    }
    const id = this.id;
    this.clear();
    this.sendAsyncMessage("AgentObservation:Invalidated", { id, reason });
  }

  clear() {
    this.id = null;
    this.targets = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.overlay?.clear();
    this.overlay = null;
    for (const type of [
      "scroll",
      "resize",
      "input",
      "change",
      "pagehide",
      "hashchange",
      "popstate",
    ]) {
      this.contentWindow.removeEventListener(type, this, true);
    }
  }

  didDestroy() {
    this.mutationObserver?.disconnect();
    this.overlay?.clear();
    this.targets = null;
  }
}
