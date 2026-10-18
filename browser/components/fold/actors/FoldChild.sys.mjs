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
const KEEP = "data-mono-fold-keep";
const UNRELAY_DELAY = 500;
const DIALOGS = "[role='dialog'], [role='alertdialog'], dialog[open]";
const MENU_ITEMS = "[role^='menuitem'], [role='option']";
const POPUPS =
  "[role='menu'], [role='listbox'], [role='dialog'], dialog[open], [popover]";
const OPENED = `${POPUPS}, [role='alertdialog']`;
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
  #opening = null;
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
    this.#stopOpening();
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
    this.#stopOpening();
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
      lazy.log.debug(`run ${id}: no element`);
      return null;
    }
    if (this.#opensOnPage(element)) {
      lazy.log.debug(`run ${id}: opens on the page`);
      this.document.notifyUserGestureActivation();
      element.click();
      return null;
    }
    let before = this.#visible(element, DIALOGS);
    let opening = this.#startOpening(element);
    try {
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
          lazy.log.debug(`run ${id}: opened a dialog`);
          return {
            dialog: this.#relayDialog(dialog, this.#openedOverlays(element)),
          };
        }
      }
      lazy.log.debug(
        `run ${id}: clicked <${element.localName}>, no dialog opened` +
          (this.#dialog
            ? `; the relayed dialog is ${
                this.#dialog.element.isConnected &&
                this.#dialog.element.checkVisibility()
                  ? "still open"
                  : "closed"
              }`
            : "")
      );
      return null;
    } finally {
      this.#endOpening(opening);
    }
  }

  /**
   * Conceals what the page opens from now on, until #endOpening, so a menu
   * or dialog opened from the Mono sidebar is never drawn on the page, not
   * even before it's found and relayed. What's open already stays shown.
   *
   * @param {Element} element The element about to be clicked.
   * @returns {object} The opening to end.
   */
  #startOpening(element) {
    if (this.#opening) {
      this.#opening.count++;
      return this.#opening;
    }
    let selector = this.#openedSelector();
    let kept = [...this.#visible(element, selector)];
    for (let node of kept) {
      node.setAttribute(KEEP, "");
    }
    let style = `:is(${selector}):not([${KEEP}]) {
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
:is(dialog, [popover]):not([${KEEP}])::backdrop {
  background: transparent !important;
}
`;
    let uri = `data:text/css;charset=utf-8,${encodeURIComponent(style)}`;
    try {
      this.contentWindow.windowUtils.loadSheetUsingURIString(
        uri,
        Ci.nsIDOMWindowUtils.USER_SHEET
      );
    } catch (e) {
      lazy.log.error("concealing what opens failed", e);
      uri = null;
    }
    this.#opening = { count: 1, uri, kept };
    return this.#opening;
  }

  /**
   * @param {object} opening What #startOpening returned.
   */
  #endOpening(opening) {
    if (opening === this.#opening && --opening.count == 0) {
      this.#stopOpening();
    }
  }

  #stopOpening() {
    let opening = this.#opening;
    if (!opening) {
      return;
    }
    this.#opening = null;
    for (let node of opening.kept) {
      node.removeAttribute(KEEP);
    }
    if (!opening.uri) {
      return;
    }
    try {
      this.contentWindow?.windowUtils.removeSheetUsingURIString(
        opening.uri,
        Ci.nsIDOMWindowUtils.USER_SHEET
      );
    } catch {
      // The document is already gone.
    }
  }

  /**
   * Whether the rule has the menus and dialogs an element opens show on the
   * page as the site draws them.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  #opensOnPage(element) {
    let selector = this.#getRule()?.onPage;
    try {
      return !!selector && element.matches(selector);
    } catch {
      return false;
    }
  }

  #openedSelector() {
    let overlays = this.#getRule()?.overlays;
    return overlays ? `${OPENED}, ${overlays}` : OPENED;
  }

  /**
   * The rule's overlay layers, such as backdrops, that the page opened since
   * #startOpening.
   *
   * @param {Element} element
   * @returns {Element[]}
   */
  #openedOverlays(element) {
    let overlays = this.#getRule()?.overlays;
    if (!overlays) {
      return [];
    }
    return [...this.#visible(element, overlays)].filter(
      node => !node.hasAttribute(KEEP)
    );
  }

  /**
   * Shows nodes concealed for a relay again, a little later so what the site
   * animates away after closing it isn't drawn.
   *
   * @param {Element[]} nodes
   */
  #unrelay(nodes) {
    setTimeout(() => {
      let current = new Set([
        ...(this.#dialog?.concealed ?? []),
        ...(this.#popup?.concealed ?? []),
      ]);
      for (let node of nodes) {
        if (!current.has(node)) {
          node.removeAttribute(RELAY);
        }
      }
    }, UNRELAY_DELAY);
  }

  /**
   * Conceals a dialog the site opened, and what dims the page behind it,
   * and reads it for the Mono sidebar.
   *
   * @param {Element} element The site's dialog.
   * @param {Element[]} [overlays] The rule's overlays opened with it.
   * @returns {object} The dialog as readDialog reads it.
   */
  #relayDialog(element, overlays = []) {
    this.#endDialog();
    this.#dialog = { element, concealed: [], ids: [] };
    let dialog = this.#readDialogNow();
    // One with nothing to act on stays on the page as the site shows it.
    if (!dialog.items.length) {
      lazy.log.debug("the dialog has no controls; it shows on the page");
      this.#endDialog();
      return null;
    }
    this.#dialog.concealed = [
      ...new Set([element, ...this.#backdrops(element), ...overlays]),
    ];
    for (let node of this.#dialog.concealed) {
      node.setAttribute(RELAY, "");
    }
    return dialog;
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
    this.#unrelay(relay.concealed);
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
    let target = this.#controlled(trigger);
    if (target?.checkVisibility()) {
      found.add(target);
    }
    return found;
  }

  #controlled(trigger) {
    let controlled = trigger.getAttribute("aria-controls")?.split(/\s+/)[0];
    return controlled
      ? (trigger.getRootNode().getElementById?.(controlled) ??
          this.document.getElementById(controlled))
      : null;
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
      lazy.log.debug(`menu ${id}: no element`);
      return null;
    }
    this.#closePopup();
    if (this.#opensOnPage(trigger)) {
      lazy.log.debug(`menu ${id}: opens on the page`);
      this.document.notifyUserGestureActivation();
      trigger.click();
      return null;
    }
    let before = this.#openPopups(trigger);
    let expanded = trigger.getAttribute("aria-expanded") == "true";
    let opening = this.#startOpening(trigger);
    try {
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
          [...this.#openPopups(trigger)].find(
            element => !before.has(element)
          ) ?? null;
        // A menu kept in the document while closed, hidden in a way that
        // still counts as shown, opens when its button says it's expanded.
        if (
          !popup &&
          !expanded &&
          trigger.getAttribute("aria-expanded") == "true"
        ) {
          popup = this.#controlled(trigger);
        }
      }
      if (!popup) {
        lazy.log.debug(`no menu opened from ${id}`);
        return null;
      }
      let overlays = this.#openedOverlays(trigger);
      // A button may open a dialog with fields rather than a menu.
      if (popup.matches(DIALOGS) && !popup.querySelector(MENU_ITEMS)) {
        let dialog = this.#relayDialog(popup, overlays);
        return dialog && { dialog };
      }
      let { items, elements } = lazy.readMenu(this.document, popup);
      lazy.log.debug(`menu ${id}: read ${items.length} items`);
      // One with nothing to read stays on the page as the site shows it.
      if (!items.length) {
        return null;
      }
      let concealed = [...new Set([popup, ...overlays])];
      for (let node of concealed) {
        node.setAttribute(RELAY, "");
      }
      for (let [itemId, entry] of elements) {
        this.#elements.set(itemId, entry);
      }
      this.#popup = { popup, trigger, concealed, ids: [...elements.keys()] };
      return { items };
    } finally {
      this.#endOpening(opening);
    }
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
    this.#unrelay(relay.concealed);
  }
}
