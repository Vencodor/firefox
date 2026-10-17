/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from browser-custom-switch.js */

/**
 * Fold: on a site with a site rule, the page's own sidebar is folded away as
 * the page loads, and the switch under the address swaps the tab list for
 * that sidebar's menu, transcribed into Mono rows. The page reads and clicks
 * its elements through the Fold actor. Fold is on by default and can be
 * turned off per site from the page settings panel.
 */
var CustomFoldUI = {
  pref: "browser.customUI.fold.enabled",
  sitesPref: "browser.customUI.fold.disabledSites",
  open: false,
  slideDistance: 24,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  // Sites update their sidebar a moment after a click or a navigation, and a
  // newly loaded page takes a moment to draw it.
  reloadDelays: [0, 400, 1200],
  iconBase: "chrome://browser/content/custom-ui/resources/fold/",

  lazy: {},

  init() {
    ChromeUtils.defineESModuleGetters(this.lazy, {
      Fold: "resource:///modules/fold/Fold.sys.mjs",
      ICON_NAMES: "resource:///modules/fold/FoldRules.sys.mjs",
      getMozRemoteImageURL: "moz-src:///toolkit/modules/FaviconUtils.sys.mjs",
    });
    this.root = document.documentElement;
    this.container = document.getElementById("sidebar-container");
    this.section = document.getElementById("custom-fold");
    this.menu = document.getElementById("custom-fold-menu");
    this.switchElement = document.getElementById("custom-fold-switch");
    this.siteTab = document.getElementById("custom-fold-switch-site");
    this.siteIcon = document.getElementById("custom-fold-switch-icon");
    this.tabList = this.container.querySelector(":scope > sidebar-main");
    this.tabLayer = [
      this.tabList,
      ...this.container.querySelectorAll(":scope > #custom-notice-sidebar"),
    ];
    this.rule = null;
    this.browser = null;
    this.model = null;
    this.modelJSON = null;
    this.generation = 0;
    this.reloadTimers = [];
    this.reloadGeneration = 0;
    this.items = new Map();
    this.collapsed = new Map();
    this.slideAnimations = [];
    this.switchVisible = false;
    this.switchAnimation = null;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    // The tab list joins the swipe areas while the switch shows.
    this.switch = new CustomSwitch({
      tablist: this.switchElement,
      areas: [this.switchElement, this.section],
      onSelect: index => this.setOpen(index == 1),
    });
    this.menu.addEventListener("click", this);
    this.menu.addEventListener("auxclick", this);
    PanelUI.panel.addEventListener("ViewShowing", this);
    this.section.addEventListener("keydown", this);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    gBrowser.tabContainer.addEventListener("TabAttrModified", this);
    this.progressListener = {
      onLocationChange: (browser, webProgress) =>
        this.onLocationChange(browser, webProgress),
    };
    gBrowser.addTabsProgressListener(this.progressListener);
    Services.prefs.addObserver("sidebar.verticalTabs", this);
    Services.prefs.addObserver(this.pref, this);
    Services.prefs.addObserver(this.sitesPref, this);
    window.addEventListener("unload", this, { once: true });
    this.rootObserver = new MutationObserver(() => this.updateAvailable());
    this.rootObserver.observe(this.root, {
      attributes: true,
      attributeFilter: [
        "custom-ui",
        "customizing",
        "inDOMFullscreen",
        "fullscreenNavToolboxHidden",
      ],
    });

    this.lazy.Fold.ensureRegistered();
    this.updateSwitch({ animate: false });
  },

  get available() {
    return (
      this.root.hasAttribute("custom-ui") &&
      !this.root.hasAttribute("customizing") &&
      !this.root.hasAttribute("inDOMFullscreen") &&
      !this.root.hasAttribute("fullscreenNavToolboxHidden") &&
      this.lazy.Fold.isAvailable()
    );
  },

  updateAvailable() {
    this.updateSwitch();
    if (this.open && (!this.available || !this.rule)) {
      this.setOpen(false, { animate: false });
    }
  },

  observe() {
    this.updateAvailable();
  },

  /**
   * The site rule of the selected page while Fold is on for it.
   *
   * @returns {?{id: string, name: string}}
   */
  get selectedRule() {
    let rule = this.lazy.Fold.ruleFor(gBrowser.selectedBrowser.currentURI);
    return rule && this.lazy.Fold.isEnabledFor(rule.id) ? rule : null;
  },

  /**
   * Shows the switch while Fold is on for the selected page's site.
   */
  updateSwitch({ animate = true } = {}) {
    let rule = this.available ? this.selectedRule : null;
    let changed = rule?.id != this.rule?.id;
    this.rule = rule;
    this.setSwitchVisible(!!rule, { animate });
    if (!rule) {
      return;
    }
    if (changed) {
      let args = { site: rule.name };
      document.l10n.setAttributes(
        this.siteTab,
        "custom-ui-fold-switch-site",
        args
      );
      document.l10n.setAttributes(this.menu, "custom-ui-fold-menu", args);
    }
    this.updateSiteIcon();
  },

  /**
   * Shows or hides the switch. Its height folds with it, so the rows below
   * slide into place instead of jumping.
   */
  setSwitchVisible(visible, { animate = true } = {}) {
    if (visible == this.switchVisible) {
      return;
    }
    this.switchVisible = visible;
    if (visible) {
      this.switch.addArea(this.tabList);
    } else {
      this.switch.removeArea(this.tabList);
    }
    let element = this.switchElement;
    let from = element.hidden ? null : this.switchFrame();
    this.switchAnimation?.cancel();
    this.switchAnimation = null;
    element.removeAttribute("animating");
    element.hidden = false;
    if (!animate || this.reducedMotion.matches || !element.checkVisibility()) {
      element.hidden = !visible;
      return;
    }
    let folded = {
      height: "0px",
      paddingBlock: "0px",
      marginBlockEnd: "0px",
      opacity: 0,
    };
    let to = visible ? this.switchFrame() : folded;
    element.setAttribute("animating", "");
    let animation = element.animate([from ?? folded, to], {
      duration: 200,
      easing: this.easing,
    });
    animation.onfinish = () => {
      this.switchAnimation = null;
      element.removeAttribute("animating");
      element.hidden = !this.switchVisible;
    };
    this.switchAnimation = animation;
  },

  /**
   * The switch's current size, as a keyframe.
   */
  switchFrame() {
    let element = this.switchElement;
    let style = window.getComputedStyle(element);
    return {
      height: `${element.getBoundingClientRect().height}px`,
      paddingBlock: `${style.paddingBlockStart} ${style.paddingBlockEnd}`,
      marginBlockEnd: style.marginBlockEnd,
      opacity: style.opacity,
    };
  },

  updateSiteIcon() {
    this.siteIcon.src =
      gBrowser.selectedTab.getAttribute("image") ||
      "chrome://global/skin/icons/defaultFavicon.svg";
  },

  handleEvent(event) {
    switch (event.type) {
      case "click":
        this.onMenuClick(event);
        break;
      case "auxclick":
        if (event.button == 1) {
          this.onMenuClick(event);
        }
        break;
      case "keydown":
        this.onKeyDown(event);
        break;
      case "ViewShowing":
        if (event.target.id == "appmenu-moreTools") {
          this.addCaptureItem(event.target);
        }
        break;
      case "command":
        PanelUI.hide();
        this.capture();
        break;
      case "TabSelect":
        this.onTabSelect();
        break;
      case "TabAttrModified":
        if (
          event.target == gBrowser.selectedTab &&
          event.detail.changed.includes("image") &&
          this.rule
        ) {
          this.updateSiteIcon();
        }
        break;
      case "unload":
        this.uninit();
        break;
    }
  },

  setOpen(open, { animate = true } = {}) {
    open = open && !!this.rule && this.available;
    if (open == this.open) {
      this.switch.select(open ? 1 : 0, { animate });
      return;
    }
    if (open && window.CustomArchiveUI?.open) {
      window.CustomArchiveUI.setOpen(false, { animate: false });
    }
    this.open = open;
    let hadFocus = this.section.contains(document.activeElement);
    this.container.toggleAttribute("custom-fold", open);
    for (let element of this.tabLayer) {
      element.inert = open;
    }
    this.section.inert = !open;
    this.switch.select(open ? 1 : 0, { animate });
    if (open) {
      this.connect(gBrowser.selectedBrowser);
    } else {
      this.disconnect();
      if (hadFocus && this.switchVisible) {
        this.siteTab.focus();
      }
    }
    if (animate) {
      this.slide(open);
    } else {
      this.cancelSlide();
    }
  },

  /**
   * Asks the page to hand its sidebar over. While the site menu stays open,
   * it's asked again after clicks and navigations in the tab.
   */
  connect(browser) {
    this.cancelReload();
    let generation = ++this.generation;
    this.browser = browser;
    this.model = null;
    this.modelJSON = null;
    this.render();
    this.lazy.Fold.activate(browser).then(model => {
      if (generation == this.generation) {
        this.show(model);
      }
    });
  },

  disconnect() {
    this.cancelReload();
    this.generation++;
    if (this.browser) {
      this.lazy.Fold.deactivate(this.browser);
    }
    this.browser = null;
    this.model = null;
    this.modelJSON = null;
  },

  show(model) {
    let json = JSON.stringify(model);
    if (json == this.modelJSON) {
      return;
    }
    this.modelJSON = json;
    this.model = model;
    this.render({ failed: !model });
  },

  /**
   * Reads the site menu again a few times. The menu shown stays until a
   * reading comes back, and a failed reading only shows if the last one
   * fails too, as while a page is replaced the old one can't answer. A newer
   * round of readings drops the answers of older ones.
   */
  reload() {
    this.cancelReload();
    let { browser, reloadGeneration } = this;
    let last = this.reloadDelays.length - 1;
    this.reloadTimers = this.reloadDelays.map((delay, index) =>
      setTimeout(async () => {
        let model = await this.lazy.Fold.activate(browser);
        if (
          reloadGeneration == this.reloadGeneration &&
          (model || index == last)
        ) {
          this.show(model);
        }
      }, delay)
    );
  },

  cancelReload() {
    this.reloadGeneration++;
    for (let timer of this.reloadTimers) {
      clearTimeout(timer);
    }
    this.reloadTimers = [];
  },

  /**
   * Clicks the page element behind an item, then reads the menu again for
   * what the click changed.
   *
   * @param {string} id The item id.
   * @param {string} [part] "secondary" for the item's toggle.
   */
  run(id, part) {
    this.lazy.Fold.run(this.browser, id, part);
    this.reload();
  },

  /**
   * A change of the site menu reported by the page as it happens.
   */
  onUpdate(browser, model) {
    if (this.open && browser == this.browser) {
      this.show(model);
    }
  },

  onTabSelect() {
    this.updateSwitch();
    if (!this.open || gBrowser.selectedBrowser == this.browser) {
      return;
    }
    if (!this.rule) {
      this.setOpen(false);
      return;
    }
    this.disconnect();
    this.connect(gBrowser.selectedBrowser);
  },

  onLocationChange(browser, webProgress) {
    if (!webProgress.isTopLevel || browser != gBrowser.selectedBrowser) {
      return;
    }
    let ruleId = this.rule?.id;
    this.updateSwitch();
    if (!this.open) {
      return;
    }
    if (this.rule?.id != ruleId) {
      this.setOpen(false);
    } else {
      this.reload();
    }
  },

  render({ failed = false } = {}) {
    let focused = document.activeElement;
    let focusKey = this.menu.contains(focused) ? this.keyOf(focused) : null;
    this.items.clear();
    let fragment = document.createDocumentFragment();
    if (this.model) {
      for (let section of this.model.sections) {
        fragment.append(this.createSection(section));
      }
    } else {
      let message = document.createElement("p");
      message.className = "custom-archive-empty";
      document.l10n.setAttributes(
        message,
        failed ? "custom-ui-fold-unavailable" : "custom-ui-fold-loading"
      );
      fragment.append(message);
    }
    this.menu.replaceChildren(fragment);
    if (focusKey) {
      let target = [...this.menu.querySelectorAll("button")].find(
        button => this.keyOf(button) == focusKey
      );
      (target ?? this.menu.querySelector("button"))?.focus();
    }
  },

  /**
   * Identifies a menu button across renders, so focus stays on it.
   */
  keyOf(element) {
    if (element.dataset.section) {
      return `section|${element.dataset.section}`;
    }
    let part = element.classList.contains("custom-fold-secondary")
      ? "secondary"
      : "row";
    return `${part}|${element.dataset.itemId ?? ""}`;
  },

  /**
   * A collapsible section starts as the site shows it. Toggling it here also
   * toggles it on the page, so the site loads what it holds and keeps the
   * choice as its own.
   */
  createSection(section) {
    let element = document.createElement("section");
    element.className = "custom-archive-section";
    let list = document.createElement("ul");
    list.className = "custom-archive-list";
    if (section.heading) {
      let heading;
      if (section.collapsible) {
        let key = `${this.rule?.id}:${section.id}`;
        let collapsed = this.collapsed.get(key) ?? !!section.collapsed;
        heading = document.createElement("button");
        heading.type = "button";
        heading.className = "custom-archive-heading custom-fold-toggle";
        heading.dataset.section = key;
        if (section.toggleId) {
          heading.dataset.toggleId = section.toggleId;
        }
        heading.setAttribute("aria-expanded", String(!collapsed));
        list.hidden = collapsed;
      } else {
        heading = document.createElement("h3");
        heading.className = "custom-archive-heading";
      }
      heading.textContent = section.heading;
      element.append(heading);
    }
    for (let item of section.items) {
      list.append(this.createItem(item));
    }
    element.append(list);
    return element;
  },

  createItem(item) {
    let entry = document.createElement("li");
    entry.className = "custom-fold-item";
    let row = document.createElement("button");
    row.type = "button";
    row.className = "custom-archive-row custom-fold-row";
    row.dataset.itemId = item.id;
    row.title = item.label;
    if (item.current) {
      row.classList.add("custom-fold-current");
      row.setAttribute("aria-current", "page");
    }
    let label = document.createElement("span");
    label.className = "custom-archive-label";
    label.textContent = item.label;
    row.append(this.createIcon(item), label);
    if (item.badge) {
      let badge = document.createElement("span");
      badge.className = "custom-fold-badge";
      badge.textContent = item.badge;
      row.append(badge);
    }
    entry.append(row);
    if (item.secondary) {
      let toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "custom-fold-secondary";
      toggle.dataset.itemId = item.id;
      toggle.setAttribute("aria-pressed", String(!!item.secondary.pressed));
      toggle.setAttribute("aria-label", item.secondary.label);
      toggle.title = item.secondary.label;
      entry.classList.add("custom-fold-has-secondary");
      entry.classList.toggle("custom-fold-pressed", !!item.secondary.pressed);
      entry.append(toggle);
    }
    this.items.set(item.id, item);
    return entry;
  },

  createIcon(item) {
    let { icon = {} } = item;
    let image = icon.image && URL.parse(icon.image);
    if (image && /^https?:$/.test(image.protocol)) {
      let img = document.createElement("img");
      img.className = "custom-archive-icon custom-fold-avatar";
      img.alt = "";
      img.src = this.lazy.getMozRemoteImageURL(image.href, {
        size: Math.ceil(16 * window.devicePixelRatio),
      });
      return img;
    }
    if (icon.letter != undefined || item.kind == "entity") {
      let letter = document.createElement("span");
      letter.className = "custom-fold-letter";
      letter.setAttribute("aria-hidden", "true");
      letter.textContent = (icon.letter ?? item.label.charAt(0)).slice(0, 1);
      return letter;
    }
    let img = document.createElement("img");
    img.className = "custom-archive-icon";
    img.alt = "";
    let name = this.lazy.ICON_NAMES.includes(icon.name) ? icon.name : "link";
    img.src = `${this.iconBase}${name}.svg`;
    return img;
  },

  /**
   * A plain click acts on the page element, so the site handles it as its
   * own; a modified or middle click on a link opens it where Firefox would.
   */
  onMenuClick(event) {
    let target = event.target.closest("button");
    if (!target || !this.menu.contains(target)) {
      return;
    }
    if (target.classList.contains("custom-fold-toggle")) {
      if (event.button == 0) {
        this.toggleSection(target);
      }
      return;
    }
    let item = this.items.get(target.dataset.itemId);
    if (!item || !this.browser) {
      return;
    }
    if (target.classList.contains("custom-fold-secondary")) {
      if (event.button == 0) {
        this.run(item.id, "secondary");
      }
      return;
    }
    let where = BrowserUtils.whereToOpenLink(event, false, true);
    let href = item.href && URL.parse(item.href);
    if (where != "current" && href && /^https?:$/.test(href.protocol)) {
      openLinkIn(href.href, where, {
        triggeringPrincipal: this.browser.contentPrincipal,
      });
    } else if (event.button == 0) {
      this.run(item.id);
    }
  },

  toggleSection(heading) {
    let expanded = heading.getAttribute("aria-expanded") != "true";
    heading.setAttribute("aria-expanded", String(expanded));
    heading.nextElementSibling.hidden = !expanded;
    this.collapsed.set(heading.dataset.section, !expanded);
    if (heading.dataset.toggleId && this.browser) {
      this.run(heading.dataset.toggleId);
    }
  },

  onKeyDown(event) {
    if (event.key == "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.setOpen(false);
      return;
    }
    if (event.key != "ArrowDown" && event.key != "ArrowUp") {
      return;
    }
    let buttons = [...this.menu.querySelectorAll("button")].filter(button =>
      button.checkVisibility()
    );
    let index = buttons.indexOf(document.activeElement);
    let next =
      event.key == "ArrowDown"
        ? Math.min(index + 1, buttons.length - 1)
        : Math.max(index - 1, 0);
    if (buttons[next]) {
      event.preventDefault();
      buttons[next].focus();
    }
  },

  isRTL() {
    return window.getComputedStyle(this.container).direction == "rtl";
  },

  cancelSlide() {
    for (let animation of this.slideAnimations) {
      animation.cancel();
    }
    this.slideAnimations = [];
  },

  /**
   * Pushes the tab list and the site menu past each other like the archive
   * does. The address row and the switch stay in place.
   */
  slide(open) {
    this.cancelSlide();
    if (this.reducedMotion.matches) {
      return;
    }
    let shift = (open ? -1 : 1) * this.slideDistance * (this.isRTL() ? -1 : 1);
    let outgoing = open ? this.tabLayer : [this.section];
    let incoming = open ? [this.section] : this.tabLayer;
    for (let element of outgoing) {
      this.slideAnimations.push(
        element.animate(
          [
            { opacity: 1, translate: "0 0" },
            { opacity: 0, translate: `${shift}px 0` },
          ],
          { duration: 160, easing: "ease-in" }
        )
      );
    }
    for (let element of incoming) {
      this.slideAnimations.push(
        element.animate(
          [
            { opacity: 0, translate: `${-shift}px 0` },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 280, delay: 40, easing: this.easing, fill: "backwards" }
        )
      );
    }
  },

  /**
   * Adds Capture Fold to the app menu's More Tools view the first time it
   * opens.
   *
   * @param {Element} view
   */
  addCaptureItem(view) {
    if (view.querySelector("#custom-fold-capture-button")) {
      return;
    }
    let item = document.createXULElement("toolbarbutton");
    item.id = "custom-fold-capture-button";
    item.className = "subviewbutton";
    document.l10n.setAttributes(item, "custom-ui-fold-capture");
    item.addEventListener("command", this);
    let body = view.querySelector(".panel-subview-body");
    body.querySelector(":scope > toolbarseparator").before(item);
  },

  /**
   * Copies the selected page's navigation, for an AI to write or fix the
   * site's Fold rule (see mono/skills/fold-site).
   */
  async capture() {
    let text = await this.lazy.Fold.capture(gBrowser.selectedBrowser);
    let brand = document.getElementById("custom-brand-button");
    let anchor = brand?.checkVisibility() ? brand : PanelUI.menuButton;
    if (!text) {
      ConfirmationHint.show(anchor, "custom-ui-fold-capture-failed", {
        hideCheckmark: true,
      });
      return;
    }
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(text);
    ConfirmationHint.show(anchor, "custom-ui-fold-capture-copied");
  },

  /**
   * The Fold state of the selected page's site, for the page settings panel.
   *
   * @returns {?{id: string, enabled: boolean}} null when Fold is off or
   *   can't show here, or the site has no rule.
   */
  getSiteState() {
    if (!this.lazy.Fold.isAvailable()) {
      return null;
    }
    let rule = this.lazy.Fold.ruleFor(gBrowser.selectedBrowser.currentURI);
    return rule
      ? { id: rule.id, enabled: this.lazy.Fold.isEnabledFor(rule.id) }
      : null;
  },

  setSiteEnabled(id, enabled) {
    this.lazy.Fold.setEnabledFor(id, enabled);
  },

  uninit() {
    Services.prefs.removeObserver("sidebar.verticalTabs", this);
    Services.prefs.removeObserver(this.pref, this);
    Services.prefs.removeObserver(this.sitesPref, this);
    gBrowser.tabContainer.removeEventListener("TabSelect", this);
    gBrowser.tabContainer.removeEventListener("TabAttrModified", this);
    gBrowser.removeTabsProgressListener(this.progressListener);
    PanelUI.panel.removeEventListener("ViewShowing", this);
    this.rootObserver.disconnect();
    this.cancelReload();
  },
};

delayedStartupPromise.then(() => CustomFoldUI.init());
