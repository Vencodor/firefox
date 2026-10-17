/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The sidebar's site menu: on a page with a site rule, the site button next
 * to the archive button swaps the tab list for the page's own sidebar,
 * transcribed into Mono rows, and hides that sidebar on the page. The page
 * reads and clicks its elements through the SiteSidebar actor.
 */
var CustomSiteSidebarUI = {
  pref: "browser.customUI.siteSidebar.enabled",
  open: false,
  slideDistance: 24,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  iconBase: "chrome://browser/content/custom-ui/resources/site-sidebar/",
  iconNames: new Set([
    "add",
    "all",
    "answers",
    "explore",
    "home",
    "link",
    "more",
    "settings",
    "trending",
  ]),

  lazy: {},

  init() {
    ChromeUtils.defineESModuleGetters(this.lazy, {
      SiteSidebar: "resource:///modules/sitesidebar/SiteSidebar.sys.mjs",
      getMozRemoteImageURL: "resource://gre/modules/FaviconUtils.sys.mjs",
    });
    this.root = document.documentElement;
    this.container = document.getElementById("sidebar-container");
    this.section = document.getElementById("custom-site-sidebar");
    this.title = document.getElementById("custom-site-sidebar-title");
    this.menu = document.getElementById("custom-site-sidebar-menu");
    this.button = document.getElementById("custom-site-sidebar-button");
    this.buttonIcon = document.getElementById(
      "custom-site-sidebar-button-icon"
    );
    this.tabLayer = [
      ...this.container.querySelectorAll(
        ":scope > :is(sidebar-main, #custom-notice-sidebar)"
      ),
    ];
    this.rule = null;
    this.browser = null;
    this.model = null;
    this.generation = 0;
    this.items = new Map();
    this.collapsed = new Map();
    this.slideAnimations = [];
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.button.addEventListener("click", this);
    this.menu.addEventListener("click", this);
    this.menu.addEventListener("auxclick", this);
    this.section.addEventListener("keydown", this);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    gBrowser.tabContainer.addEventListener("TabAttrModified", this);
    this.progressListener = {
      onLocationChange: (browser, webProgress, request, location, flags) =>
        this.onLocationChange(browser, webProgress, flags),
    };
    gBrowser.addTabsProgressListener(this.progressListener);
    Services.prefs.addObserver("sidebar.verticalTabs", this);
    Services.prefs.addObserver(this.pref, this);
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

    this.lazy.SiteSidebar.ensureRegistered();
    this.updateButton();
  },

  get available() {
    return (
      this.root.hasAttribute("custom-ui") &&
      !this.root.hasAttribute("customizing") &&
      !this.root.hasAttribute("inDOMFullscreen") &&
      !this.root.hasAttribute("fullscreenNavToolboxHidden") &&
      Services.prefs.getBoolPref("sidebar.verticalTabs", false) &&
      Services.prefs.getBoolPref(this.pref, false)
    );
  },

  updateAvailable() {
    this.updateButton();
    if (this.open && !this.available) {
      this.setOpen(false, { animate: false });
    }
  },

  observe() {
    this.updateAvailable();
  },

  /**
   * Shows the site button while the selected page has a site rule.
   */
  updateButton() {
    let rule = this.available
      ? this.lazy.SiteSidebar.ruleFor(gBrowser.selectedBrowser.currentURI)
      : null;
    this.rule = rule;
    this.button.hidden = !rule;
    if (!rule) {
      return;
    }
    let args = { site: rule.name };
    document.l10n.setAttributes(
      this.button,
      "custom-ui-site-sidebar-button",
      args
    );
    document.l10n.setAttributes(this.menu, "custom-ui-site-sidebar-menu", args);
    this.updateButtonIcon();
  },

  updateButtonIcon() {
    this.buttonIcon.src =
      gBrowser.selectedTab.getAttribute("image") ||
      "chrome://global/skin/icons/defaultFavicon.svg";
  },

  handleEvent(event) {
    switch (event.type) {
      case "click":
        if (event.currentTarget === this.button) {
          this.setOpen(!this.open);
        } else {
          this.onMenuClick(event);
        }
        break;
      case "auxclick":
        if (event.button == 1) {
          this.onMenuClick(event);
        }
        break;
      case "keydown":
        this.onKeyDown(event);
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
          this.updateButtonIcon();
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
      return;
    }
    if (open && window.CustomArchiveUI?.open) {
      window.CustomArchiveUI.setOpen(false, { animate: false });
    }
    this.open = open;
    let hadFocus = this.section.contains(document.activeElement);
    this.container.toggleAttribute("custom-site-sidebar", open);
    for (let element of this.tabLayer) {
      element.inert = open;
    }
    this.section.inert = !open;
    this.button.setAttribute("aria-pressed", String(open));
    if (open) {
      this.connect(gBrowser.selectedBrowser);
    } else {
      this.disconnect();
      if (hadFocus) {
        this.button.focus();
      }
    }
    if (animate) {
      this.slide(open);
    } else {
      this.cancelSlide();
    }
  },

  /**
   * Asks the page to hand its sidebar over. A menu already shown for the same
   * site stays until the new one arrives, so moving between the site's pages
   * doesn't blank it.
   */
  connect(browser) {
    let generation = ++this.generation;
    let keep = this.model && this.model.ruleId == this.rule?.id;
    this.browser = browser;
    if (!keep) {
      this.model = null;
      this.render();
    }
    this.lazy.SiteSidebar.activate(browser).then(model => {
      if (generation != this.generation) {
        return;
      }
      this.show(model);
    });
  },

  disconnect() {
    this.generation++;
    if (this.browser) {
      this.lazy.SiteSidebar.deactivate(this.browser);
    }
    this.browser = null;
    this.model = null;
  },

  show(model) {
    if (model) {
      model.ruleId = this.rule?.id;
    }
    this.model = model;
    this.render({ failed: !model });
  },

  /**
   * A change of the site menu reported by the page.
   */
  onUpdate(browser, model) {
    if (this.open && browser == this.browser) {
      this.show(model);
    }
  },

  onTabSelect() {
    this.updateButton();
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

  onLocationChange(browser, webProgress, flags) {
    if (!webProgress.isTopLevel || browser != gBrowser.selectedBrowser) {
      return;
    }
    let ruleId = this.rule?.id;
    this.updateButton();
    if (!this.open) {
      return;
    }
    if (!this.rule) {
      this.setOpen(false);
    } else if (
      flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT &&
      this.rule.id == ruleId
    ) {
      this.lazy.SiteSidebar.refresh(browser);
    } else {
      this.generation++;
      this.connect(browser);
    }
  },

  render({ failed = false } = {}) {
    let focused = document.activeElement;
    let focusKey = this.menu.contains(focused) ? this.keyOf(focused) : null;
    this.title.textContent = this.model?.site.name ?? this.rule?.name ?? "";
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
        failed
          ? "custom-ui-site-sidebar-unavailable"
          : "custom-ui-site-sidebar-loading"
      );
      fragment.append(message);
    }
    fragment.append(this.createRestoreSection());
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
    if (element.classList.contains("custom-site-sidebar-restore-row")) {
      return "restore";
    }
    let part = element.classList.contains("custom-site-sidebar-secondary")
      ? "secondary"
      : "row";
    return `${part}|${element.dataset.itemId ?? ""}`;
  },

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
        heading.className = "custom-archive-heading custom-site-sidebar-toggle";
        heading.dataset.section = key;
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
    entry.className = "custom-site-sidebar-item";
    let row = document.createElement("button");
    row.type = "button";
    row.className = "custom-archive-row custom-site-sidebar-row";
    row.dataset.itemId = item.id;
    row.title = item.label;
    if (item.current) {
      row.classList.add("custom-site-sidebar-current");
      row.setAttribute("aria-current", "page");
    }
    let label = document.createElement("span");
    label.className = "custom-archive-label";
    label.textContent = item.label;
    row.append(this.createIcon(item), label);
    if (item.badge) {
      let badge = document.createElement("span");
      badge.className = "custom-site-sidebar-badge";
      badge.textContent = item.badge;
      row.append(badge);
    }
    entry.append(row);
    if (item.secondary) {
      let toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "custom-site-sidebar-secondary";
      toggle.dataset.itemId = item.id;
      toggle.setAttribute("aria-pressed", String(!!item.secondary.pressed));
      toggle.setAttribute("aria-label", item.secondary.label);
      toggle.title = item.secondary.label;
      entry.classList.add("custom-site-sidebar-has-secondary");
      entry.classList.toggle(
        "custom-site-sidebar-pressed",
        !!item.secondary.pressed
      );
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
      img.className = "custom-archive-icon custom-site-sidebar-avatar";
      img.alt = "";
      img.src = this.lazy.getMozRemoteImageURL(image.href, {
        size: Math.ceil(16 * window.devicePixelRatio),
      });
      return img;
    }
    if (icon.letter != undefined || item.kind == "entity") {
      let letter = document.createElement("span");
      letter.className = "custom-site-sidebar-letter";
      letter.setAttribute("aria-hidden", "true");
      letter.textContent = (icon.letter ?? item.label.charAt(0)).slice(0, 1);
      return letter;
    }
    let img = document.createElement("img");
    img.className = "custom-archive-icon";
    img.alt = "";
    let name = this.iconNames.has(icon.name) ? icon.name : "link";
    img.src = `${this.iconBase}${name}.svg`;
    return img;
  },

  createRestoreSection() {
    let section = document.createElement("section");
    section.className = "custom-archive-section custom-site-sidebar-restore";
    let row = document.createElement("button");
    row.type = "button";
    row.className =
      "custom-archive-row custom-site-sidebar-row custom-site-sidebar-restore-row";
    let icon = document.createElement("img");
    icon.className = "custom-archive-icon";
    icon.alt = "";
    icon.src = `${this.iconBase}sidebar.svg`;
    let label = document.createElement("span");
    label.className = "custom-archive-label";
    document.l10n.setAttributes(label, "custom-ui-site-sidebar-restore");
    row.append(icon, label);
    section.append(row);
    return section;
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
    if (target.classList.contains("custom-site-sidebar-toggle")) {
      if (event.button == 0) {
        this.toggleSection(target);
      }
      return;
    }
    if (target.classList.contains("custom-site-sidebar-restore-row")) {
      if (event.button == 0) {
        this.setOpen(false);
      }
      return;
    }
    let item = this.items.get(target.dataset.itemId);
    if (!item || !this.browser) {
      return;
    }
    if (target.classList.contains("custom-site-sidebar-secondary")) {
      if (event.button == 0) {
        this.lazy.SiteSidebar.run(this.browser, item.id, "secondary");
      }
      return;
    }
    let where = BrowserUtils.whereToOpenLink(event, false, true);
    if (where != "current" && item.href) {
      openLinkIn(item.href, where, {
        triggeringPrincipal: this.browser.contentPrincipal,
      });
    } else if (event.button == 0) {
      this.lazy.SiteSidebar.run(this.browser, item.id);
    }
  },

  toggleSection(heading) {
    let expanded = heading.getAttribute("aria-expanded") != "true";
    heading.setAttribute("aria-expanded", String(expanded));
    heading.nextElementSibling.hidden = !expanded;
    this.collapsed.set(heading.dataset.section, !expanded);
  },

  onKeyDown(event) {
    if (event.key == "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.setOpen(false);
      this.button.focus();
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
   * does. The address row stays in place.
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

  uninit() {
    Services.prefs.removeObserver("sidebar.verticalTabs", this);
    Services.prefs.removeObserver(this.pref, this);
    gBrowser.tabContainer.removeEventListener("TabSelect", this);
    gBrowser.tabContainer.removeEventListener("TabAttrModified", this);
    gBrowser.removeTabsProgressListener(this.progressListener);
    this.rootObserver.disconnect();
  },
};

delayedStartupPromise.then(() => CustomSiteSidebarUI.init());
