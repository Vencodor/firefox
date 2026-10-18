/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Fold: on a site with a site rule, the page's own sidebar is folded away as
 * the page loads, and its menu, transcribed into Mono rows, shows in a column
 * docked beside the tab list. The button after the reload button turns Fold
 * on or off for the site, as the page settings panel does; with Fold off, or
 * without room for the column, the page keeps its own sidebar. The page
 * reads and clicks its elements through the Fold actor.
 */
var CustomFoldUI = {
  pref: "browser.customUI.fold.enabled",
  sitesPref: "browser.customUI.fold.disabledSites",
  dockWidthPref: "browser.customUI.fold.dockWidth",
  // Whether the menu shows in its column beside the tab list.
  docked: false,
  minDockWidth: 200,
  maxDockWidth: 420,
  // The page keeps at least this width beside a docked menu.
  minPageWidth: 560,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  // Sites update their sidebar a moment after a click or a navigation, and a
  // newly loaded page takes a moment to draw it.
  reloadDelays: [0, 400, 1200],
  // After a failed reading the menu asks again a few times, for a site that
  // fills its sidebar late.
  retryDelays: [2000, 5000, 15000],
  inputDelay: 250,
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
    this.dock = document.getElementById("custom-fold-dock");
    this.menu = document.getElementById("custom-fold-menu");
    this.dockTitle = document.getElementById("custom-fold-dock-title");
    this.dockIcon = document.getElementById("custom-fold-dock-icon");
    this.button = document.getElementById("custom-fold-button");
    this.splitter = document.getElementById("custom-fold-splitter");
    this.sidebarBox = document.getElementById("sidebar-box");
    this.rule = null;
    this.room = null;
    this.browser = null;
    this.model = null;
    this.modelJSON = null;
    this.generation = 0;
    this.reloadTimers = [];
    this.reloadGeneration = 0;
    this.retryTimer = null;
    this.retryStep = 0;
    this.items = new Map();
    this.collapsed = new Map();
    this.buttonVisible = false;
    this.buttonAnimation = null;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.menu.addEventListener("click", this);
    this.menu.addEventListener("auxclick", this);
    this.menu.addEventListener("input", this);
    PanelUI.panel.addEventListener("ViewShowing", this);
    this.dock.addEventListener("keydown", this);
    this.button.addEventListener("click", this);
    this.applyDockWidth();
    this.dockFrame = 0;
    this.dockResized = false;
    this.dockObserver = new MutationObserver(() => this.onDockResize());
    this.dockObserver.observe(this.dock, {
      attributes: true,
      attributeFilter: ["width"],
    });
    // The room left for a docked menu changes with the window, the tab
    // sidebar's width and Firefox's own sidebar panel, which takes its place.
    this.layoutObserver = new ResizeObserver(() => this.scheduleDockUpdate());
    this.layoutObserver.observe(this.container);
    this.sidebarBoxObserver = new MutationObserver(() =>
      this.scheduleDockUpdate()
    );
    this.sidebarBoxObserver.observe(this.sidebarBox, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    window.addEventListener("resize", this);
    window.addEventListener("mouseup", this, true);
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
    Services.prefs.addObserver(this.dockWidthPref, this);
    window.addEventListener("unload", this, { once: true });
    this.rootObserver = new MutationObserver(() => this.updateAvailable());
    this.rootObserver.observe(this.root, {
      attributes: true,
      attributeFilter: [
        "custom-ui",
        "customizing",
        "inDOMFullscreen",
        "fullscreenNavToolboxHidden",
        "sidebar-positionend",
      ],
    });

    this.lazy.Fold.ensureRegistered();
    this.update({ animate: false });
    // Pages loaded before Fold was ready, such as restored tabs.
    this.syncAll();
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
    this.syncAll();
    this.update();
  },

  observe(subject, topic, data) {
    if (data == this.dockWidthPref) {
      this.applyDockWidth();
    }
    this.updateAvailable();
  },

  /**
   * Docks the menu while Fold is on for the selected page's site and the
   * window has room for it, and shows the button that turns Fold on or off
   * on any Fold site with room.
   */
  update({ animate = true } = {}) {
    let rule = this.available
      ? this.lazy.Fold.ruleFor(gBrowser.selectedBrowser.currentURI)
      : null;
    if (rule && rule.id != this.rule?.id) {
      document.l10n.setAttributes(this.menu, "custom-ui-fold-menu", {
        site: rule.name,
      });
      this.dockTitle.textContent = rule.name;
    }
    this.rule = rule;
    let room = this.hasRoom();
    if (room != this.room) {
      // Pages keep their own sidebar while there's no room for the column.
      this.room = room;
      this.syncAll();
    }
    let enabled = !!rule && this.lazy.Fold.isEnabledFor(rule.id);
    this.setDocked(enabled && room);
    this.setButtonVisible(!!rule && room, { animate });
    this.button.classList.toggle("custom-fold-off", !enabled);
    document.l10n.setAttributes(
      this.button,
      enabled ? "custom-ui-fold-turn-off" : "custom-ui-fold-turn-on"
    );
    if (rule) {
      this.updateSiteIcon();
    }
  },

  /**
   * Whether the window has room for the menu beside the tab list: Firefox's
   * own sidebar panel isn't open in its place, the tab sidebar is on the
   * left, and the page keeps its minimum width.
   */
  hasRoom() {
    return (
      !this.root.hasAttribute("sidebar-positionend") &&
      this.sidebarBox.hidden &&
      this.maxDockWidthHere() >= this.minDockWidth
    );
  },

  /**
   * The widest the docked menu may be in the window as it is.
   */
  maxDockWidthHere() {
    let room =
      window.innerWidth -
      this.container.getBoundingClientRect().width -
      this.minPageWidth;
    return Math.min(this.maxDockWidth, room);
  },

  /**
   * Shows or hides the Fold button. Its width unfolds or folds with it, so
   * the navigation buttons before it slide aside instead of jumping.
   */
  setButtonVisible(visible, { animate = true } = {}) {
    if (visible == this.buttonVisible) {
      return;
    }
    this.buttonVisible = visible;
    let button = this.button;
    this.buttonAnimation?.cancel();
    this.buttonAnimation = null;
    button.removeAttribute("animating");
    button.hidden = false;
    if (!animate || this.reducedMotion.matches || !button.checkVisibility()) {
      button.hidden = !visible;
      return;
    }
    let shown = { width: window.getComputedStyle(button).width, opacity: 1 };
    let folded = { width: "0px", opacity: 0 };
    button.setAttribute("animating", "");
    let animation = button.animate(
      visible ? [folded, shown] : [shown, folded],
      {
        duration: 200,
        easing: this.easing,
      }
    );
    animation.onfinish = () => {
      this.buttonAnimation = null;
      button.removeAttribute("animating");
      button.hidden = !this.buttonVisible;
    };
    this.buttonAnimation = animation;
  },

  scheduleDockUpdate() {
    if (this.dockFrame) {
      return;
    }
    this.dockFrame = requestAnimationFrame(() => {
      this.dockFrame = 0;
      this.applyDockWidth();
      this.update();
    });
  },

  setDocked(docked) {
    if (docked == this.docked) {
      return;
    }
    if (!docked) {
      this.disconnect();
    }
    let hadFocus = this.dock.contains(document.activeElement);
    this.docked = docked;
    this.dock.hidden = !docked;
    this.splitter.hidden = !docked;
    if (docked) {
      this.applyDockWidth();
      this.connect(gBrowser.selectedBrowser);
    } else {
      this.menu.replaceChildren();
      if (hadFocus) {
        gBrowser.selectedBrowser.focus();
      }
    }
  },

  /**
   * Turns Fold on or off for the selected page's site, for every window, as
   * the page settings panel's switch does.
   */
  toggle() {
    if (this.rule) {
      this.lazy.Fold.setEnabledFor(
        this.rule.id,
        !this.lazy.Fold.isEnabledFor(this.rule.id)
      );
    }
  },

  get dockWidth() {
    let width = Services.prefs.getIntPref(this.dockWidthPref, 240);
    return Math.max(
      this.minDockWidth,
      Math.min(width, this.maxDockWidthHere())
    );
  },

  applyDockWidth() {
    this.dock.style.width = `${this.dockWidth}px`;
  },

  /**
   * Follows the splitter while it's dragged, within the widths the window
   * allows, and covers the page as the tab sidebar's resizing does.
   */
  onDockResize() {
    if (this.splitter.getAttribute("state") != "dragging") {
      return;
    }
    let width = parseFloat(this.dock.getAttribute("width"));
    if (!Number.isFinite(width)) {
      return;
    }
    this.dockResized = true;
    this.root.toggleAttribute("custom-sidebar-resizing", true);
    this.dock.style.width = `${Math.max(
      this.minDockWidth,
      Math.min(width, this.maxDockWidthHere())
    )}px`;
  },

  onDockResizeEnd() {
    if (!this.dockResized) {
      return;
    }
    this.dockResized = false;
    this.root.toggleAttribute("custom-sidebar-resizing", false);
    Services.prefs.setIntPref(
      this.dockWidthPref,
      Math.round(this.dock.getBoundingClientRect().width)
    );
  },

  updateSiteIcon() {
    this.dockIcon.src =
      gBrowser.selectedTab.getAttribute("image") ||
      "chrome://global/skin/icons/defaultFavicon.svg";
  },

  handleEvent(event) {
    switch (event.type) {
      case "click":
        if (event.currentTarget == this.button) {
          this.toggle();
        } else {
          this.onMenuClick(event);
        }
        break;
      case "resize":
        this.scheduleDockUpdate();
        break;
      case "mouseup":
        this.onDockResizeEnd();
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
      case "input":
        this.onInput(event);
        break;
      case "command":
        if (event.target.closest("#custom-fold-popup")) {
          this.onPopupCommand(event);
        } else {
          PanelUI.hide();
          this.capture();
        }
        break;
      case "popuphidden":
        if (event.target == this._popup) {
          this.onPopupHidden();
        }
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

  /**
   * Asks the page to hand its sidebar over. While the site menu stays open,
   * it's asked again after clicks and navigations in the tab.
   */
  connect(browser) {
    this.cancelReload();
    this.cancelRetry();
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
    this.cancelRetry();
    this.pendingInput = null;
    clearTimeout(this.inputTimer);
    this.generation++;
    if (this.browser) {
      this.lazy.Fold.deactivate(this.browser);
    }
    this.browser = null;
    this.model = null;
    this.modelJSON = null;
  },

  show(model) {
    if (model) {
      this.cancelRetry();
    } else {
      this.scheduleRetry();
      // While it asks again, what's shown stays: the menu or the loading
      // message.
      if (this.retryTimer) {
        return;
      }
    }
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

  scheduleRetry() {
    if (
      this.retryTimer ||
      !this.docked ||
      this.retryStep >= this.retryDelays.length
    ) {
      return;
    }
    let { browser, generation } = this;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      this.retryStep++;
      let model = await this.lazy.Fold.activate(browser);
      if (generation == this.generation) {
        this.show(model);
      }
    }, this.retryDelays[this.retryStep]);
  },

  cancelRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryStep = 0;
  },

  cancelReload() {
    this.reloadGeneration++;
    for (let timer of this.reloadTimers) {
      clearTimeout(timer);
    }
    this.reloadTimers = [];
  },

  /**
   * Clicks the page element behind an item, an action or a section title,
   * then reads the menu again for what the click changed.
   *
   * @param {string} id
   */
  run(id) {
    let browser = this.browser;
    this.flushInput();
    this.lazy.Fold.run(browser, id);
    this.reload();
  },

  /**
   * A page of the tab finished loading, such as after a reload. The menu
   * asks it for its sidebar, which also has it keep reading the sidebar
   * while it fills in.
   */
  onPageReady(browser) {
    if (this.docked && browser == this.browser) {
      this.reload();
    }
  },

  /**
   * A change of the site menu reported by the page as it happens.
   */
  onUpdate(browser, model) {
    if (this.docked && browser == this.browser) {
      this.show(model);
    }
  },

  /**
   * Has a page fold or unfold its sidebar as Fold is set for its site, also
   * in background tabs. Without room for the column it keeps its sidebar.
   *
   * @param {Element} browser
   */
  syncFold(browser) {
    let rule = this.lazy.Fold.ruleFor(browser.currentURI);
    if (rule) {
      this.lazy.Fold.sync(
        browser,
        this.lazy.Fold.isEnabledFor(rule.id) && this.room !== false
      );
    }
  },

  syncAll() {
    for (let browser of gBrowser.browsers) {
      this.syncFold(browser);
    }
  },

  onTabSelect() {
    this.syncFold(gBrowser.selectedBrowser);
    this.update();
    if (!this.docked || gBrowser.selectedBrowser == this.browser) {
      return;
    }
    this.disconnect();
    this.connect(gBrowser.selectedBrowser);
  },

  onLocationChange(browser, webProgress) {
    if (!webProgress.isTopLevel) {
      return;
    }
    this.syncFold(browser);
    if (browser != gBrowser.selectedBrowser) {
      return;
    }
    let ruleId = this.rule?.id;
    this.update();
    if (!this.docked) {
      return;
    }
    if (this.rule?.id == ruleId) {
      this.reload();
    } else {
      // Another Fold site in the same tab.
      this.connect(browser);
    }
  },

  render({ failed = false } = {}) {
    let focused = document.activeElement;
    let focusKey = this.menu.contains(focused) ? this.keyOf(focused) : null;
    let typing =
      focused?.localName == "input" && this.menu.contains(focused)
        ? {
            value: focused.value,
            start: focused.selectionStart,
            end: focused.selectionEnd,
          }
        : null;
    this.items.clear();
    let fragment = document.createDocumentFragment();
    if (this.model) {
      let pinned = document.createElement("div");
      pinned.className = "custom-fold-pinned";
      for (let section of this.model.sections) {
        (section.pinned ? pinned : fragment).append(
          this.createSection(section)
        );
      }
      if (pinned.hasChildNodes()) {
        fragment.append(pinned);
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
      let target = [...this.menu.querySelectorAll("button, input")].find(
        element => this.keyOf(element) == focusKey
      );
      (target ?? this.menu.querySelector("button, input"))?.focus();
      // What the user is typing wins over the page's value read meanwhile.
      if (typing && target?.localName == "input") {
        target.value = typing.value;
        target.setSelectionRange(typing.start, typing.end);
      }
    }
  },

  /**
   * Identifies a menu control across renders, so focus stays on it.
   */
  keyOf(element) {
    if (element.dataset.section) {
      return `section|${element.dataset.section}`;
    }
    if (element.dataset.actionId) {
      return `action|${element.dataset.actionId}`;
    }
    let part = "row";
    if (element.classList.contains("custom-fold-more")) {
      part = "more";
    } else if (element.localName == "input") {
      part = "field";
    }
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
    if (section.actions) {
      let row = document.createElement("div");
      row.className = "custom-fold-heading-row";
      if (element.firstChild) {
        row.append(element.firstChild);
      }
      row.append(
        ...section.actions.map(action => this.createHeadingAction(action))
      );
      element.append(row);
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
    entry.append(
      item.kind == "field" ? this.createField(item) : this.createRow(item)
    );
    if (item.actions?.length) {
      entry.append(this.createActions(item, entry));
    }
    this.items.set(item.id, item);
    return entry;
  },

  createRow(item) {
    let row = document.createElement("button");
    row.type = "button";
    row.className = "custom-archive-row custom-fold-row";
    row.dataset.itemId = item.id;
    row.title = item.label;
    if (item.current) {
      row.classList.add("custom-fold-current");
      row.setAttribute("aria-current", "page");
    }
    if (item.kind == "toggle") {
      row.setAttribute("role", "switch");
      row.setAttribute("aria-checked", String(!!item.checked));
    }
    let label = document.createElement("span");
    label.className = "custom-archive-label";
    label.textContent = item.label;
    row.append(this.createIcon(item.icon, item), label);
    if (item.badge) {
      let badge = document.createElement("span");
      badge.className = "custom-fold-badge";
      badge.textContent = item.badge;
      row.append(badge);
    }
    if (item.kind == "toggle") {
      let check = document.createElement("span");
      check.className = "custom-fold-check";
      check.setAttribute("aria-hidden", "true");
      row.append(check);
    }
    return row;
  },

  /**
   * A text field typed into in the Mono sidebar types into the page's own
   * field, and Enter submits it there.
   */
  createField(item) {
    let row = document.createElement("div");
    row.className = "custom-archive-row custom-fold-field-row";
    let icon = document.createElement("span");
    icon.className = "custom-archive-icon custom-fold-search-icon";
    icon.setAttribute("aria-hidden", "true");
    let input = document.createElement("input");
    input.className = "custom-fold-field";
    input.type = item.inputType == "text" ? "text" : "search";
    input.autocomplete = "off";
    input.dataset.itemId = item.id;
    input.value = item.value ?? "";
    input.placeholder = item.placeholder ?? item.label;
    input.setAttribute("aria-label", item.label);
    row.append(icon, input);
    return row;
  },

  /**
   * The other controls of an item's row: a single one shows at the row end
   * like the tab close button, several, or one that opens the site's menu,
   * behind a menu button.
   */
  createActions(item, entry) {
    let [first] = item.actions;
    let button = document.createElement("button");
    button.type = "button";
    button.className = "custom-fold-action";
    button.dataset.itemId = item.id;
    entry.classList.add("custom-fold-has-action");
    if (item.actions.length == 1 && !first.popup) {
      button.dataset.actionId = first.id;
      button.setAttribute("aria-label", first.label);
      button.title = first.label;
      if (first.pressed != undefined) {
        button.setAttribute("aria-pressed", String(first.pressed));
        entry.classList.toggle("custom-fold-pressed", first.pressed);
      }
      if (first.icon && Object.values(first.icon).some(Boolean)) {
        button.classList.add("custom-fold-action-icon");
        button.append(this.createIcon(first.icon, first));
      }
    } else {
      button.classList.add("custom-fold-more");
      button.setAttribute("aria-haspopup", "menu");
      document.l10n.setAttributes(button, "custom-ui-fold-more", {
        item: item.label,
      });
    }
    return button;
  },

  /**
   * A section's own button, like a filter, as an icon at the end of its
   * title. Unlike a row's actions it's always shown.
   *
   * @param {object} action
   * @returns {Element}
   */
  createHeadingAction(action) {
    let button = document.createElement("button");
    button.type = "button";
    button.className = "custom-fold-heading-action";
    button.dataset.actionId = action.id;
    button.setAttribute("aria-label", action.label);
    button.title = action.label;
    if (action.popup) {
      button.dataset.popup = "true";
      button.setAttribute("aria-haspopup", "menu");
    }
    if (action.pressed != undefined) {
      button.setAttribute("aria-pressed", String(action.pressed));
    }
    let icon = action.icon && Object.values(action.icon).some(Boolean);
    button.append(
      this.createIcon(icon ? action.icon : { name: "more" }, action)
    );
    return button;
  },

  /**
   * @param {?object} icon The model's icon.
   * @param {object} owner The item or action it belongs to.
   * @returns {Element}
   */
  createIcon(icon, owner) {
    if (icon?.svg) {
      // The site's or the rule's icon, drawn in the Mono text color.
      let span = document.createElement("span");
      span.className = "custom-archive-icon custom-fold-svg";
      span.setAttribute("aria-hidden", "true");
      span.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(icon.svg)}")`;
      return span;
    }
    let image = icon?.image && URL.parse(icon.image);
    if (image && /^https?:$/.test(image.protocol)) {
      let img = document.createElement("img");
      img.className = "custom-archive-icon custom-fold-avatar";
      img.alt = "";
      img.src = this.lazy.getMozRemoteImageURL(image.href, {
        size: Math.ceil(16 * window.devicePixelRatio),
      });
      return img;
    }
    if (icon?.letter || owner.kind == "entity") {
      let letter = document.createElement("span");
      letter.className = "custom-fold-letter";
      letter.setAttribute("aria-hidden", "true");
      letter.textContent = (icon?.letter || owner.label.charAt(0)).slice(0, 1);
      return letter;
    }
    if (!icon?.name) {
      let space = document.createElement("span");
      space.className = "custom-archive-icon";
      space.setAttribute("aria-hidden", "true");
      return space;
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
    if (target.classList.contains("custom-fold-heading-action")) {
      if (event.button == 0 && this.browser) {
        if (target.dataset.popup) {
          this.relay(target.dataset.actionId, target);
        } else {
          this.run(target.dataset.actionId);
        }
      }
      return;
    }
    let item = this.items.get(target.dataset.itemId);
    if (!item || !this.browser) {
      return;
    }
    if (target.classList.contains("custom-fold-more")) {
      if (event.button == 0) {
        this.showActions(item, target);
      }
      return;
    }
    if (target.dataset.actionId) {
      if (event.button == 0) {
        this.run(target.dataset.actionId);
      }
      return;
    }
    if (item.popup) {
      if (event.button == 0) {
        this.relay(item.id, target);
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

  onInput(event) {
    let input = event.target;
    if (input.localName != "input" || !this.browser) {
      return;
    }
    this.pendingInput = {
      id: input.dataset.itemId,
      value: input.value,
    };
    clearTimeout(this.inputTimer);
    this.inputTimer = setTimeout(() => this.flushInput(), this.inputDelay);
  },

  /**
   * Sends what was typed but not sent yet, before a click that may use it.
   */
  flushInput() {
    clearTimeout(this.inputTimer);
    let pending = this.pendingInput;
    this.pendingInput = null;
    if (pending && this.browser) {
      this.lazy.Fold.input(this.browser, pending.id, pending.value);
    }
  },

  submitField(input) {
    clearTimeout(this.inputTimer);
    this.pendingInput = null;
    this.lazy.Fold.input(this.browser, input.dataset.itemId, input.value, {
      submit: true,
    });
    this.reload();
  },

  toggleSection(heading) {
    let expanded = heading.getAttribute("aria-expanded") != "true";
    heading.setAttribute("aria-expanded", String(expanded));
    heading
      .closest(".custom-archive-section")
      .querySelector(":scope > .custom-archive-list").hidden = !expanded;
    this.collapsed.set(heading.dataset.section, !expanded);
    if (heading.dataset.toggleId && this.browser) {
      this.run(heading.dataset.toggleId);
    }
  },

  /**
   * The popup that lists a row's actions, or the items of a menu the site
   * opened, in the Mono sidebar.
   */
  get popup() {
    if (!this._popup) {
      let popup = document.createXULElement("menupopup");
      popup.id = "custom-fold-popup";
      popup.addEventListener("command", this);
      popup.addEventListener("popuphidden", this);
      document.getElementById("mainPopupSet").append(popup);
      this._popup = popup;
    }
    return this._popup;
  },

  async openPopup(anchor, entries, kind) {
    let popup = this.popup;
    if (popup.state != "closed") {
      let hidden = new Promise(resolve =>
        popup.addEventListener("popuphidden", resolve, { once: true })
      );
      popup.hidePopup();
      await hidden;
    }
    popup.replaceChildren(
      ...entries.map(entry => {
        let menuitem = document.createXULElement("menuitem");
        menuitem.setAttribute("label", entry.label);
        menuitem.dataset.id = entry.id;
        menuitem.dataset.kind = kind;
        if (entry.popup) {
          menuitem.dataset.popup = "true";
        }
        let checked = entry.pressed ?? entry.checked;
        if (checked != undefined) {
          menuitem.setAttribute("type", "checkbox");
          if (checked) {
            menuitem.setAttribute("checked", "true");
          }
        }
        if (entry.disabled) {
          menuitem.setAttribute("disabled", "true");
        }
        return menuitem;
      })
    );
    this.relaying = kind == "relay";
    this.relayChosen = false;
    popup.openPopup(anchor, "after_end");
  },

  showActions(item, anchor) {
    let actions = item.actions ?? [];
    if (actions.length == 1 && actions[0].popup) {
      this.relay(actions[0].id, anchor);
    } else {
      this.openPopup(anchor, actions, "action");
    }
  },

  /**
   * Opens the site's own menu behind an item or action and shows its items
   * here. A dialog it opens instead shows on the page.
   */
  async relay(id, anchor) {
    let browser = this.browser;
    let result = await this.lazy.Fold.openPopup(browser, id);
    if (browser != this.browser || !this.docked) {
      return;
    }
    if (result?.items?.length) {
      this.openPopup(anchor, result.items, "relay");
    } else {
      this.reload();
    }
  },

  onPopupCommand(event) {
    let { id, kind, popup } = event.target.dataset;
    if (!id || !this.browser) {
      return;
    }
    if (kind == "relay") {
      this.relayChosen = true;
      this.run(id);
    } else if (popup) {
      this.relay(id, this.popup.anchorNode);
    } else {
      this.run(id);
    }
  },

  onPopupHidden() {
    if (this.relaying && !this.relayChosen && this.browser) {
      this.lazy.Fold.closePopup(this.browser);
      this.reload();
    }
    this.relaying = false;
  },

  onKeyDown(event) {
    let field = event.target.localName == "input";
    if (field && event.key == "Enter") {
      event.preventDefault();
      this.submitField(event.target);
      return;
    }
    if (event.key == "Escape") {
      event.preventDefault();
      event.stopPropagation();
      gBrowser.selectedBrowser.focus();
      return;
    }
    if (event.key != "ArrowDown" && event.key != "ArrowUp") {
      return;
    }
    let controls = [...this.menu.querySelectorAll("button, input")].filter(
      control => control.checkVisibility()
    );
    let index = controls.indexOf(document.activeElement);
    let next =
      event.key == "ArrowDown"
        ? Math.min(index + 1, controls.length - 1)
        : Math.max(index - 1, 0);
    if (controls[next]) {
      event.preventDefault();
      controls[next].focus();
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
    Services.prefs.removeObserver(this.dockWidthPref, this);
    window.removeEventListener("resize", this);
    window.removeEventListener("mouseup", this, true);
    cancelAnimationFrame(this.dockFrame);
    this.dockObserver.disconnect();
    this.layoutObserver.disconnect();
    this.sidebarBoxObserver.disconnect();
    gBrowser.tabContainer.removeEventListener("TabSelect", this);
    gBrowser.tabContainer.removeEventListener("TabAttrModified", this);
    gBrowser.removeTabsProgressListener(this.progressListener);
    PanelUI.panel.removeEventListener("ViewShowing", this);
    this.rootObserver.disconnect();
    this.cancelReload();
    this.cancelRetry();
    clearTimeout(this.inputTimer);
  },
};

delayedStartupPromise.then(() => CustomFoldUI.init());
