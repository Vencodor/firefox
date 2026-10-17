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
  readDialog: "resource:///modules/fold/FoldTranscriber.sys.mjs",
  readMenu: "resource:///modules/fold/FoldTranscriber.sys.mjs",
  transcribe: "resource:///modules/fold/FoldTranscriber.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () =>
  console.createInstance({
    prefix: "Fold",
    maxLogLevelPref: "browser.customUI.fold.loglevel",
  })
);

const READY_INTERVAL = 200;
const UPDATE_DELAY = 150;
const POPUP_INTERVAL = 50;
const POPUP_TIMEOUT = 1500;
const DIALOG_TIMEOUT = 1000;
const RELAY = "data-mono-fold-relay";
const DIALOGS = "[role='dialog'], [role='alertdialog'], dialog[open]";
const MENU_ITEMS = "[role^='menuitem'], [role='option']";
const POPUPS =
  "[role='menu'], [role='listbox'], [role='dialog'], dialog[open], [popover]";
const WATCHED_ATTRIBUTES = [
  "aria-checked",
  "aria-current",
  "aria-expanded",
  "aria-label",
  "aria-pressed",
  "aria-selected",
  "class",
  "checked",
  "hidden",
  "href",
  "icon-name",
  "open",
  "src",
];

/**
 * Folds a page's sidebar away and reads it for the Fold menu.
 *
 * With Fold on for the site, the sidebar is concealed as soon as the document
 * starts, before anything is drawn, and is shown again if it can't be read.
 * The browser also asks every page of a Fold site to fold when it's loaded
 * or selected, in case the document started before Fold was ready. The
 * sidebar stays in the document, concealed by a user stylesheet, so the
 * site's scripts keep working and its elements can be used for the user.
 * While the Mono sidebar shows the Fold menu, changes to the page's sidebar
 * are sent to it.
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
  #popup = null;
  #dialog = null;
  #sent = "";

  receiveMessage({ name, data }) {
    switch (name) {
      case "Fold:Activate":
        return this.#activate();
      case "Fold:Deactivate":
        this.#deactivate();
        break;
      case "Fold:Sync":
        this.#sync(data);
        break;
      case "Fold:Run":
        return this.#run(data);
      case "Fold:Input":
        this.#input(data);
        break;
      case "Fold:OpenPopup":
        return this.#openPopup(data);
      case "Fold:ClosePopup":
        this.#closePopup();
        break;
      case "Fold:ReadDialog":
        return this.#readDialog();
      case "Fold:CloseDialog":
        this.#closeDialog();
        break;
    }
    return null;
  }

  handleEvent(event) {
    switch (event.type) {
      case "DOMDocElementInserted": {
        let rule = this.#getRule();
        let enabled = lazy.isFoldEnabled(rule);
        lazy.log.debug(`${rule?.id} at ${this.document.URL}: on ${enabled}`);
        if (enabled) {
          this.#fold();
        }
        break;
      }
      case "DOMContentLoaded":
        if (event.target == this.document && this.#folded) {
          this.#check();
        }
        break;
      // A page brought back from back/forward navigation follows the current
      // setting.
      case "pageshow":
        if (event.target == this.document && event.persisted) {
          this.#syncFold();
        }
        break;
      case "pagehide":
        if (event.target == this.document) {
          this.#generation++;
          this.#stopWatching();
        }
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

  #syncFold(enabled = lazy.isFoldEnabled(this.#getRule())) {
    if (this.#destroyed || !this.#getRule()) {
      return;
    }
    if (enabled) {
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

  /**
   * Follows the browser's Fold setting for the page, which knows it even
   * when this document started before Fold was ready.
   *
   * @param {{enabled: boolean}} data
   */
  #sync({ enabled }) {
    lazy.log.debug(`sync ${this.#getRule()?.id}: on ${enabled}`);
    this.#syncFold(!!enabled);
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
   * Shows or conceals the page's own sidebar while a function runs, for
   * Capture Fold to measure the page both ways. Nothing is drawn in between.
   *
   * @param {boolean} folded
   * @param {Function} callback
   * @returns {*} What the function returns.
   */
  withSheet(folded, callback) {
    let had = !!this.#sheet;
    if (had == folded || !this.#getRule()) {
      return callback();
    }
    if (folded) {
      this.#applySheet(this.#rule);
    } else {
      this.#removeSheet();
    }
    try {
      return callback();
    } finally {
      if (had) {
        this.#applySheet(this.#rule);
      } else {
        this.#removeSheet();
      }
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
      lazy.log.error(`reading ${rule.id} failed`, e);
      return null;
    }
    let minItems = rule.ready?.minItems ?? 1;
    if (!result || result.count < minItems) {
      if (report) {
        lazy.log.warn(
          result
            ? `${rule.id} found ${result.count} of ${minItems} items; showing the page's sidebar`
            : `${rule.id} found no sidebar root; showing the page's sidebar`
        );
      }
      return null;
    }
    // A reading replaces the element map; the open menu's and dialog's
    // items stay.
    for (let id of [
      ...(this.#popup?.ids ?? []),
      ...(this.#dialog?.ids ?? []),
    ]) {
      let entry = this.#elements.get(id);
      if (entry) {
        result.elements.set(id, entry);
      }
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
    this.#closePopup();
    this.#endDialog();
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
        Ci.nsIDOMWindowUtils.USER_SHEET
      );
      this.#sheet = uri;
    } catch (e) {
      lazy.log.error("concealing the sidebar failed", e);
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
        Ci.nsIDOMWindowUtils.USER_SHEET
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

  #element(id) {
    let element = this.#active ? this.#elements.get(id)?.element : null;
    if (element && !element.isConnected) {
      this.#scheduleUpdate(0);
      return null;
    }
    return element;
  }

  /**
   * Clicks the page element behind an item, action, section title, menu
   * item or dialog button, as the user would. A dialog the click opens is
   * read for the Mono sidebar and concealed on the page.
   *
   * @param {{id: string}} data
   * @returns {Promise<?{dialog: object}>} The dialog the click opened, if
   *   any.
   */
  async #run({ id }) {
    let element = this.#element(id);
    if (!element) {
      return null;
    }
    let before = this.#visible(element, DIALOGS);
    // The user clicked in the Mono sidebar, so the page may act as on its
    // own click, such as opening a new window.
    this.document.notifyUserGestureActivation();
    element.click();
    if (id.startsWith("popup/")) {
      this.#closePopup({ dismiss: false });
    }
    let deadline = Date.now() + DIALOG_TIMEOUT;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POPUP_INTERVAL));
      if (this.#destroyed || !this.#active) {
        return null;
      }
      let dialog = [...this.#visible(element, DIALOGS)].find(
        candidate => !before.has(candidate)
      );
      if (dialog) {
        return { dialog: this.#relayDialog(dialog) };
      }
    }
    return null;
  }

  /**
   * Conceals a dialog the site opened, and what dims the page behind it,
   * and reads it for the Mono sidebar.
   *
   * @param {Element} element The site's dialog.
   * @returns {object} The dialog as readDialog reads it.
   */
  #relayDialog(element) {
    this.#endDialog();
    let concealed = [element, ...this.#backdrops(element)];
    for (let node of concealed) {
      node.setAttribute(RELAY, "");
    }
    this.#dialog = { element, concealed, ids: [] };
    return this.#readDialogNow();
  }

  #readDialogNow() {
    let relay = this.#dialog;
    for (let id of relay.ids) {
      this.#elements.delete(id);
    }
    let { dialog, elements } = lazy.readDialog(this.document, relay.element);
    for (let [id, entry] of elements) {
      this.#elements.set(id, entry);
    }
    relay.ids = [...elements.keys()];
    return dialog;
  }

  /**
   * The relayed dialog as it is now, for the Mono sidebar to follow it.
   *
   * @returns {{dialog: ?object}} null once the site closed it.
   */
  #readDialog() {
    let relay = this.#dialog;
    if (!relay) {
      return { dialog: null };
    }
    if (!relay.element.isConnected || !relay.element.checkVisibility()) {
      this.#endDialog();
      return { dialog: null };
    }
    return { dialog: this.#readDialogNow() };
  }

  #closeDialog() {
    this.#dialog?.element.dispatchEvent(
      new this.contentWindow.KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
  }

  /**
   * Stops relaying the dialog; one still open shows on the page again.
   */
  #endDialog() {
    let relay = this.#dialog;
    if (!relay) {
      return;
    }
    this.#dialog = null;
    for (let id of relay.ids) {
      this.#elements.delete(id);
    }
    for (let node of relay.concealed) {
      node.removeAttribute(RELAY);
    }
  }

  /**
   * The empty layers covering the page next to a dialog, which sites use to
   * dim the page behind it.
   *
   * @param {Element} dialog
   * @returns {Element[]}
   */
  #backdrops(dialog) {
    let win = this.contentWindow;
    let found = [];
    let node = dialog;
    for (let depth = 0; depth < 4; depth++) {
      let parent = node.parentNode;
      if (!parent) {
        break;
      }
      for (let sibling of parent.children) {
        if (sibling === node) {
          continue;
        }
        let rect = sibling.getBoundingClientRect();
        if (
          rect.width >= win.innerWidth * 0.9 &&
          rect.height >= win.innerHeight * 0.9 &&
          !sibling.textContent.trim()
        ) {
          found.push(sibling);
        }
      }
      node =
        parent.nodeType == parent.DOCUMENT_FRAGMENT_NODE ? parent.host : parent;
      if (!node || node.localName == "body") {
        break;
      }
    }
    return found;
  }

  /**
   * Types into the page's text field behind a field item, and submits it
   * like pressing Enter there.
   *
   * @param {{id: string, value: string, submit: boolean}} data
   */
  #input({ id, value, submit }) {
    let element = this.#element(id);
    if (!element || !("value" in element)) {
      return;
    }
    let win = this.contentWindow;
    if (typeof value == "string" && element.value != value) {
      if (element.setUserInput) {
        element.setUserInput(value);
      } else {
        element.value = value;
        element.dispatchEvent(new win.Event("input", { bubbles: true }));
      }
    }
    if (!submit) {
      return;
    }
    this.document.notifyUserGestureActivation();
    let init = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    let proceed = element.dispatchEvent(new win.KeyboardEvent("keydown", init));
    element.dispatchEvent(new win.KeyboardEvent("keyup", init));
    if (proceed && element.form) {
      element.form.requestSubmit();
    }
  }

  /**
   * The shown elements matching a selector in the document and in the tree
   * of an element, where sites put their menus and dialogs.
   *
   * @param {Element} element
   * @param {string} selector
   * @returns {Set<Element>}
   */
  #visible(element, selector) {
    let found = new Set();
    for (let root of new Set([this.document, element.getRootNode()])) {
      if (!root.querySelectorAll) {
        continue;
      }
      for (let candidate of root.querySelectorAll(selector)) {
        if (candidate.checkVisibility()) {
          found.add(candidate);
        }
      }
    }
    return found;
  }

  #openPopups(trigger) {
    let found = this.#visible(trigger, POPUPS);
    let controlled = trigger.getAttribute("aria-controls");
    let target =
      controlled &&
      (trigger.getRootNode().getElementById?.(controlled) ??
        this.document.getElementById(controlled));
    if (target?.checkVisibility()) {
      found.add(target);
    }
    return found;
  }

  /**
   * Clicks a button that opens the site's menu and reads that menu, which
   * the Mono sidebar shows in its place. The site's menu stays concealed
   * while it's open.
   *
   * @param {{id: string}} data
   * @returns {Promise<?object>} { items } of the menu, { dialog } when a
   *   dialog opened instead, or null when nothing opened.
   */
  async #openPopup({ id }) {
    let trigger = this.#element(id);
    if (!trigger) {
      return null;
    }
    this.#closePopup();
    let before = this.#openPopups(trigger);
    this.document.notifyUserGestureActivation();
    trigger.click();
    let popup = null;
    let deadline = Date.now() + POPUP_TIMEOUT;
    while (!popup && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POPUP_INTERVAL));
      if (this.#destroyed || !this.#active) {
        return null;
      }
      popup =
        [...this.#openPopups(trigger)].find(element => !before.has(element)) ??
        null;
    }
    if (!popup) {
      lazy.log.debug(`no menu opened from ${id}`);
      return null;
    }
    // A button may open a dialog with fields rather than a menu.
    if (popup.matches(DIALOGS) && !popup.querySelector(MENU_ITEMS)) {
      return { dialog: this.#relayDialog(popup) };
    }
    popup.setAttribute(RELAY, "");
    let { items, elements } = lazy.readMenu(this.document, popup);
    for (let [itemId, entry] of elements) {
      this.#elements.set(itemId, entry);
    }
    this.#popup = { popup, trigger, ids: [...elements.keys()] };
    return { items };
  }

  /**
   * Closes the site's menu opened by #openPopup.
   *
   * @param {object} [options]
   * @param {boolean} [options.dismiss] False when choosing one of its items
   *   already closed it.
   */
  #closePopup({ dismiss = true } = {}) {
    let relay = this.#popup;
    if (!relay) {
      return;
    }
    this.#popup = null;
    for (let id of relay.ids) {
      this.#elements.delete(id);
    }
    let { popup, trigger } = relay;
    if (dismiss && popup.isConnected && popup.checkVisibility()) {
      popup.dispatchEvent(
        new this.contentWindow.KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
      if (
        popup.checkVisibility() &&
        trigger.getAttribute("aria-expanded") == "true"
      ) {
        trigger.click();
      }
    }
    // Shown again only once the site has closed it.
    setTimeout(() => popup.removeAttribute(RELAY), 500);
  }
}
