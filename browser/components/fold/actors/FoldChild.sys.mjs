/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FOLD_PREFS: "resource:///modules/fold/FoldRules.sys.mjs",
  findRule: "resource:///modules/fold/FoldRules.sys.mjs",
  isFoldEnabled: "resource:///modules/fold/FoldRules.sys.mjs",
  hidingStyle: "resource:///modules/fold/FoldTranscriber.sys.mjs",
  transcribe: "resource:///modules/fold/FoldTranscriber.sys.mjs",
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
 * Folds a page's sidebar away and reads it for the Fold menu.
 *
 * With Fold on for the site, the sidebar is hidden as soon as the document
 * starts, before anything is drawn, and is shown again if it can't be read.
 * It stays in the document, hidden by a stylesheet, so the site's scripts keep
 * working and its elements can be clicked for the user. While the Mono
 * sidebar shows the Fold menu, changes to the page's sidebar are sent to it.
 */
export class FoldChild extends JSWindowActorChild {
  #rule = undefined;
  #folded = false;
  #active = false;
  #destroyed = false;
  #generation = 0;
  #checkGeneration = 0;
  #elements = new Map();
  #observer = null;
  #sheet = null;
  #timer = null;
  #pending = null;
  #sent = "";

  receiveMessage({ name, data }) {
    switch (name) {
      case "Fold:Activate":
        return this.#activate();
      case "Fold:Deactivate":
        this.#deactivate();
        break;
      case "Fold:Run":
        this.#run(data);
        break;
    }
    return null;
  }

  handleEvent(event) {
    if (event.target != this.document) {
      return;
    }
    switch (event.type) {
      case "DOMDocElementInserted":
        if (lazy.isFoldEnabled(this.#getRule())) {
          this.#fold();
        }
        break;
      case "DOMContentLoaded":
        if (this.#folded) {
          this.#check();
        }
        break;
      // A page brought back from back/forward navigation follows the current
      // setting.
      case "pageshow":
        if (event.persisted) {
          this.#syncFold();
        }
        break;
      case "pagehide":
        this.#generation++;
        this.#stopWatching();
        break;
    }
  }

  observe() {
    this.#syncFold();
  }

  /**
   * The site rule for the page, looked up once. Pages with a rule follow
   * changes of the Fold setting.
   */
  #getRule() {
    if (this.#rule === undefined) {
      this.#rule = lazy.findRule(this.document.URL);
      if (this.#rule) {
        for (let pref of lazy.FOLD_PREFS) {
          Services.prefs.addObserver(pref, this);
        }
      }
    }
    return this.#rule;
  }

  #syncFold() {
    if (this.#destroyed) {
      return;
    }
    if (lazy.isFoldEnabled(this.#getRule())) {
      if (!this.#folded) {
        this.#fold();
        if (this.document.readyState != "loading") {
          this.#check();
        }
      }
    } else {
      this.#unfold();
    }
  }

  #fold() {
    this.#folded = true;
    this.#applySheet(this.#rule);
  }

  /**
   * Shows the page's own sidebar again and stops reading it.
   */
  #unfold() {
    this.#checkGeneration++;
    this.#folded = false;
    this.#stopWatching();
    this.#removeSheet();
  }

  /**
   * Gives the page its sidebar back if the rule can't read it in time, so a
   * changed site never loses its navigation.
   */
  async #check() {
    let generation = ++this.#checkGeneration;
    let rule = this.#rule;
    let deadline = Date.now() + (rule.ready?.timeoutMs ?? 0);
    while (!this.#read(rule)) {
      if (Date.now() >= deadline) {
        this.#read(rule, { report: true });
        this.#unfold();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, READY_INTERVAL));
      if (this.#destroyed || generation != this.#checkGeneration) {
        return;
      }
    }
  }

  /**
   * Shows the page's own sidebar while a function runs, for Capture Fold to
   * measure it. Nothing is drawn in between.
   *
   * @param {Function} callback
   * @returns {*} What the function returns.
   */
  withSidebarShown(callback) {
    if (!this.#sheet) {
      return callback();
    }
    this.#removeSheet();
    try {
      return callback();
    } finally {
      this.#applySheet(this.#rule);
    }
  }

  didDestroy() {
    this.#destroyed = true;
    this.#stopWatching();
    if (this.#rule) {
      for (let pref of lazy.FOLD_PREFS) {
        Services.prefs.removeObserver(pref, this);
      }
    }
  }

  /**
   * Reads the sidebar and hides it on the page. The Mono sidebar asks again
   * after clicks and navigations, so requests made while a reading waits for
   * the page share it.
   */
  #activate() {
    this.#pending ??= this.#start().finally(() => (this.#pending = null));
    return this.#pending;
  }

  /**
   * @returns {Promise<?{model: ?object}>} null when a newer reading, closing
   *   the menu or leaving the page replaced this one.
   */
  async #start() {
    let generation = ++this.#generation;
    let rule = this.#getRule();
    if (!rule) {
      return { model: null };
    }
    let deadline = Date.now() + (rule.ready?.timeoutMs ?? 0);
    let result = this.#read(rule);
    while (!result && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, READY_INTERVAL));
      if (this.#destroyed || generation != this.#generation) {
        return null;
      }
      result = this.#read(rule);
    }
    if (!result) {
      this.#read(rule, { report: true });
      this.#unfold();
      return { model: null };
    }
    this.#active = true;
    this.#fold();
    this.#watch(result.watched);
    this.#sent = JSON.stringify(result.model);
    return { model: result.model };
  }

  #read(rule, { report = false } = {}) {
    let result;
    try {
      result = lazy.transcribe(this.document, rule);
    } catch (e) {
      console.error(`Fold: reading ${rule.id} failed`, e);
      return null;
    }
    let minItems = rule.ready?.minItems ?? 1;
    if (!result || result.count < minItems) {
      if (report) {
        console.warn(
          result
            ? `Fold: ${rule.id} found ${result.count} of ${minItems} items`
            : `Fold: ${rule.id} found no sidebar root`
        );
      }
      return null;
    }
    this.#elements = result.elements;
    return result;
  }

  /**
   * Stops sending the Fold menu. The sidebar stays folded while Fold is on
   * for the site.
   */
  #deactivate() {
    this.#generation++;
    this.#stopWatching();
    if (!lazy.isFoldEnabled(this.#getRule())) {
      this.#unfold();
    }
  }

  #stopWatching() {
    this.#active = false;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#observer?.disconnect();
    this.#elements = new Map();
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

  async #update() {
    this.#timer = null;
    if (!this.#active || this.#destroyed) {
      return;
    }
    let result = this.#read(this.#rule);
    if (!result) {
      // The site may be drawing its sidebar again. Wait for it as on load,
      // and give the page its own sidebar back only if it doesn't come.
      let answer = await this.#activate();
      if (answer && !this.#destroyed) {
        this.sendAsyncMessage("Fold:Update", answer);
      }
      return;
    }
    this.#watch(result.watched);
    let json = JSON.stringify(result.model);
    if (json != this.#sent) {
      this.#sent = json;
      this.sendAsyncMessage("Fold:Update", { model: result.model });
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
    // The user clicked in the Mono sidebar, so the page may act as on its
    // own click, such as opening a new window.
    this.document.notifyUserGestureActivation();
    element.click();
  }
}
