/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  findRule: "resource:///modules/sitesidebar/SiteSidebarRules.sys.mjs",
  hidingStyle: "resource:///modules/sitesidebar/SiteSidebarTranscriber.sys.mjs",
  transcribe: "resource:///modules/sitesidebar/SiteSidebarTranscriber.sys.mjs",
});

const READY_INTERVAL = 200;
const UPDATE_DELAY = 150;
const WATCHED_ATTRIBUTES = [
  "aria-current",
  "aria-expanded",
  "aria-label",
  "aria-pressed",
  "hidden",
  "href",
  "icon-name",
  "open",
  "src",
];

/**
 * Reads the page's sidebar for the site menu while the Mono sidebar shows it.
 * The page's own sidebar stays in the document, hidden by a stylesheet, so the
 * site's scripts keep working and its elements can be clicked for the user.
 */
export class SiteSidebarChild extends JSWindowActorChild {
  #active = false;
  #destroyed = false;
  #generation = 0;
  #rule = null;
  #elements = new Map();
  #observer = null;
  #sheet = null;
  #timer = null;
  #sent = "";

  receiveMessage({ name, data }) {
    switch (name) {
      case "SiteSidebar:Activate":
        return this.#activate();
      case "SiteSidebar:Deactivate":
        this.#deactivate();
        break;
      case "SiteSidebar:Run":
        this.#run(data);
        break;
      case "SiteSidebar:Refresh":
        if (this.#active) {
          this.#scheduleUpdate(0);
        }
        break;
    }
    return null;
  }

  handleEvent(event) {
    // A page kept for back/forward navigation comes back as it was before the
    // site menu took its sidebar; the sidebar asks again if it's still shown.
    if (event.type == "pagehide") {
      this.#deactivate();
    }
  }

  didDestroy() {
    this.#destroyed = true;
    this.#stop();
  }

  async #activate() {
    let generation = ++this.#generation;
    let rule = lazy.findRule(this.document.documentURI);
    if (!rule) {
      return { model: null };
    }
    let deadline = Date.now() + (rule.ready?.timeoutMs ?? 0);
    let result = this.#read(rule);
    while (!result && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, READY_INTERVAL));
      if (this.#destroyed || generation != this.#generation) {
        return { model: null };
      }
      result = this.#read(rule);
    }
    if (!result) {
      return { model: null };
    }
    this.#rule = rule;
    this.#active = true;
    this.#applySheet(rule);
    this.#watch(result.watched);
    this.#sent = JSON.stringify(result.model);
    return { model: result.model };
  }

  #read(rule) {
    let result = lazy.transcribe(this.document, rule);
    if (!result || result.count < (rule.ready?.minItems ?? 1)) {
      return null;
    }
    this.#elements = result.elements;
    return result;
  }

  #deactivate() {
    this.#generation++;
    this.#stop();
  }

  #stop() {
    this.#active = false;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#observer?.disconnect();
    this.#elements = new Map();
    this.#removeSheet();
  }

  #applySheet(rule) {
    if (this.#sheet) {
      return;
    }
    let uri = `data:text/css;charset=utf-8,${encodeURIComponent(
      lazy.hidingStyle(rule)
    )}`;
    try {
      this.contentWindow.windowUtils.loadSheetUsingURIString(
        uri,
        Ci.nsIDOMWindowUtils.AUTHOR_SHEET
      );
      this.#sheet = uri;
    } catch (e) {
      console.error(e);
    }
  }

  #removeSheet() {
    if (!this.#sheet) {
      return;
    }
    let uri = this.#sheet;
    this.#sheet = null;
    try {
      this.contentWindow?.windowUtils.removeSheetUsingURIString(
        uri,
        Ci.nsIDOMWindowUtils.AUTHOR_SHEET
      );
    } catch {
      // The document is already gone.
    }
  }

  /**
   * Watches the sidebar and the shadow trees inside it, which a single
   * subtree observer doesn't reach.
   *
   * @param {Node[]} nodes
   */
  #watch(nodes) {
    this.#observer ??= new this.contentWindow.MutationObserver(() =>
      this.#scheduleUpdate()
    );
    this.#observer.disconnect();
    for (let node of nodes) {
      this.#observer.observe(node, {
        attributes: true,
        attributeFilter: WATCHED_ATTRIBUTES,
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
  }

  #scheduleUpdate(delay = UPDATE_DELAY) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#update(), delay);
  }

  #update() {
    this.#timer = null;
    if (!this.#active || this.#destroyed) {
      return;
    }
    let result = this.#read(this.#rule);
    if (!result) {
      // The sidebar is gone or no longer readable: give the page its own
      // sidebar back.
      this.#deactivate();
      this.sendAsyncMessage("SiteSidebar:Update", { model: null });
      return;
    }
    this.#watch(result.watched);
    let json = JSON.stringify(result.model);
    if (json != this.#sent) {
      this.#sent = json;
      this.sendAsyncMessage("SiteSidebar:Update", { model: result.model });
    }
  }

  #run({ id, part }) {
    if (!this.#active) {
      return;
    }
    let entry = this.#elements.get(id);
    let element = part == "secondary" ? entry?.secondary : entry?.element;
    if (!element?.isConnected) {
      this.#scheduleUpdate(0);
      return;
    }
    element.click();
    this.#scheduleUpdate();
  }
}
