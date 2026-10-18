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
// How long a menu is watched once one opened, for another one the site opens
// a moment later, such as a second copy of the menu.
const POPUP_SETTLE = 150;
// Delays between readings while the Fold menu shows, short after the page
// loads or the user acts and longer while nothing happens.
const REFRESH_DELAYS = [300, 600, 1200, 2500, 5000, 10000];
const RELAY = "data-mono-fold-relay";
const KEEP = "data-mono-fold-keep";
const UNRELAY_DELAY = 500;
const DIALOGS = "[role='dialog'], [role='alertdialog'], dialog[open]";
const MENU_ITEMS = "[role^='menuitem'], [role='option']";
const POPUPS = `[role='menu'], [role='listbox'], [popover], ${DIALOGS}`;
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
  #refreshTimer = null;
  #refreshStep = 0;
  #pending = null;
  #opening = null;
  #popup = null;
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
        this.#run(data);
        break;
      case "Fold:Input":
        this.#input(data);
        break;
      case "Fold:OpenPopup":
        return this.#openPopup(data);
      case "Fold:ClosePopup":
        this.#closePopup();
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
        this.#refreshSoon();
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
    this.#refreshSoon();
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
    // A reading replaces the element map; the open menu's items stay.
    for (let id of this.#popup?.ids ?? []) {
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
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
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
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#update();
    }, delay);
  }

  /**
   * Reads the sidebar again and again while the Fold menu shows, often at
   * first and less and less often after, for what the page changes without
   * the observer seeing it, such as a sidebar the site draws anew. Loading
   * and acting on the page start over from short delays.
   */
  #refreshSoon() {
    if (!this.#active || this.#destroyed) {
      return;
    }
    this.#refreshStep = 0;
    this.#scheduleRefresh();
  }

  #scheduleRefresh() {
    clearTimeout(this.#refreshTimer);
    let delay =
      REFRESH_DELAYS[Math.min(this.#refreshStep, REFRESH_DELAYS.length - 1)];
    this.#refreshStep++;
    this.#refreshTimer = setTimeout(async () => {
      this.#refreshTimer = null;
      await this.#update();
      if (this.#active && !this.#destroyed && !this.#refreshTimer) {
        this.#scheduleRefresh();
      }
    }, delay);
  }

  async #update() {
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
   * Clicks the page element behind an item, action, section title or menu
   * item, as the user would. What the click opens, such as a dialog, shows on
   * the page as the site draws it.
   *
   * @param {{id: string}} data
   */
  #run({ id }) {
    let element = this.#element(id);
    if (!element) {
      lazy.log.debug(`run ${id}: no element`);
      return;
    }
    // Choosing a menu item closes the site's menu, and what the item opens,
    // or what a click right after a menu closed opens, isn't concealed.
    if (id.startsWith("popup/")) {
      this.#closePopup({ dismiss: false });
    }
    let opening = this.#opening;
    for (let timer of opening?.lingering ?? []) {
      clearTimeout(timer);
      opening.lingering.delete(timer);
      this.#endOpening(opening);
    }
    lazy.log.debug(`run ${id}: clicking <${element.localName}>`);
    // The user clicked in the Mono sidebar, so the page may act as on its
    // own click, such as opening a new window.
    this.document.notifyUserGestureActivation();
    element.click();
    this.#refreshSoon();
  }

  /**
   * Conceals the menus the page opens from now on, until #endOpening, so a
   * menu opened from the Mono sidebar is never drawn on the page, not even
   * before it's found, nor a copy of it the site opens a moment later. What's
   * open already stays shown.
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
    this.#opening = { count: 1, uri, kept, lingering: new Set() };
    return this.#opening;
  }

  /**
   * @param {object} opening What #startOpening returned.
   * @param {number} [delay] For what the site animates away to stay
   *   concealed.
   */
  #endOpening(opening, delay = 0) {
    if (delay) {
      let timer = setTimeout(() => {
        opening.lingering.delete(timer);
        this.#endOpening(opening);
      }, delay);
      opening.lingering.add(timer);
      return;
    }
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

  #openedSelector() {
    let overlays = this.#getRule()?.overlays;
    return overlays ? `${POPUPS}, ${overlays}` : POPUPS;
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
      let current = new Set(this.#popup?.concealed);
      for (let node of nodes) {
        if (!current.has(node)) {
          node.removeAttribute(RELAY);
        }
      }
    }, UNRELAY_DELAY);
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
    this.#refreshSoon();
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
   * the Mono sidebar shows in its place. The site's menu, and any other the
   * site opens while the Mono one is open, stays concealed. A dialog the
   * button opens instead, or a menu with nothing to read, shows on the page.
   *
   * @param {{id: string}} data
   * @returns {Promise<?{items: object[]}>} The menu's items, or null when
   *   no menu opened.
   */
  async #openPopup({ id }) {
    let trigger = this.#element(id);
    if (!trigger) {
      lazy.log.debug(`menu ${id}: no element`);
      return null;
    }
    this.#closePopup();
    let before = this.#openPopups(trigger);
    let expanded = trigger.getAttribute("aria-expanded") == "true";
    let opening = this.#startOpening(trigger);
    let relayed = false;
    try {
      this.document.notifyUserGestureActivation();
      trigger.click();
      this.#refreshSoon();
      let opened = [];
      let deadline = Date.now() + POPUP_TIMEOUT;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, POPUP_INTERVAL));
        if (this.#destroyed || !this.#active) {
          return null;
        }
        opened = [...this.#openPopups(trigger)].filter(
          element => !before.has(element)
        );
        // A menu kept in the document while closed, hidden in a way that
        // still counts as shown, opens when its button says it's expanded.
        let controlled = this.#controlled(trigger);
        if (
          !opened.length &&
          controlled &&
          !expanded &&
          trigger.getAttribute("aria-expanded") == "true"
        ) {
          opened = [controlled];
        }
        if (opened.length) {
          deadline = Math.min(deadline, Date.now() + POPUP_SETTLE);
        }
      }
      // The menu is the one with the most to read; others are copies of it
      // or what it's drawn in.
      let menus = opened
        .filter(
          element => !element.matches(DIALOGS) || this.#hasMenuItems(element)
        )
        .map(element => ({
          element,
          ...lazy.readMenu(this.document, element),
        }))
        .filter(menu => menu.items.length)
        .sort((a, b) => b.items.length - a.items.length);
      if (!menus.length) {
        lazy.log.debug(
          opened.length
            ? `menu ${id}: opened a dialog or nothing to read; it shows on the page`
            : `menu ${id}: nothing opened`
        );
        return null;
      }
      let [{ element: popup, items, elements }] = menus;
      lazy.log.debug(`menu ${id}: read ${items.length} items`);
      let concealed = [
        ...new Set([
          ...menus.map(menu => menu.element),
          ...this.#openedOverlays(trigger),
        ]),
      ];
      for (let node of concealed) {
        node.setAttribute(RELAY, "");
      }
      for (let [itemId, entry] of elements) {
        this.#elements.set(itemId, entry);
      }
      this.#popup = {
        popup,
        trigger,
        concealed,
        opening,
        ids: [...elements.keys()],
      };
      relayed = true;
      return { items };
    } finally {
      if (!relayed) {
        this.#endOpening(opening);
      }
    }
  }

  #hasMenuItems(element) {
    return !!element.querySelector(MENU_ITEMS);
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
    // Shown again only once the site has closed it. What an item opens isn't
    // concealed.
    this.#unrelay(relay.concealed);
    this.#endOpening(relay.opening, dismiss ? UNRELAY_DELAY : 0);
  }
}
