/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var CustomBrowserUI = {
  pref: "browser.customUI.enabled",
  themePref: "browser.customUI.theme",

  // The new tab search only offers the typed search, the agent chat row and
  // a few search engine suggestions.
  newTabProviders: [
    "UrlbarProviderHeuristicFallback",
    "UrlbarProviderMonoRun",
    "UrlbarProviderSearchSuggestions",
  ],
  newTabMaxSuggestions: 4,

  selectionSlideDuration: 240,
  // Farther jumps switch in place; a long glide would sweep across the list.
  selectionSlideMaxDistance: 360,

  tabStripEvents: [
    "TabOpen",
    "TabClose",
    "TabMove",
    "TabAttrModified",
    "TabGrouped",
    "TabUngrouped",
    "TabGroupCreate",
    "TabGroupCollapse",
    "TabGroupExpand",
  ],

  init() {
    document.getElementById("custom-sidebar-footer")?.remove();
    this.panel = document.getElementById("custom-ai-panel");
    this.brandButton = document.getElementById("custom-brand-button");
    this.brandButton.addEventListener("click", this);
    this.brandButton.addEventListener("keydown", this);
    PanelUI.panel.addEventListener("popupshown", this);
    PanelUI.panel.addEventListener("popuphidden", this);
    this.closeButton = document.getElementById("custom-ai-close");
    this.closeButton.addEventListener("click", this);
    this.panel.addEventListener("keydown", this);
    Services.prefs.addObserver(this.pref, this);
    Services.prefs.addObserver(this.themePref, this);
    Services.prefs.addObserver("sidebar.verticalTabs", this);
    Services.prefs.addObserver("browser.newtabpage.enabled", this);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    for (let type of this.tabStripEvents) {
      gBrowser.tabContainer.addEventListener(type, this);
    }
    this.progressListener = {
      onLocationChange: browser => {
        if (browser === gBrowser.selectedBrowser) {
          this.updateNewTab();
        }
      },
    };
    gBrowser.addTabsProgressListener(this.progressListener);
    this.visualTab = gBrowser.selectedTab;
    // The pinned tile grid balances its columns by the number of tiles.
    this.pinnedTabs = document.getElementById("pinned-tabs-container");
    this.pinnedObserver = new MutationObserver(() => this.updatePinCount());
    this.pinnedObserver.observe(this.pinnedTabs, { childList: true });
    this.updatePinCount();
    this.urlbarListener = {
      onQueryStarted: queryContext => this.limitNewTabQuery(queryContext),
    };
    gURLBar.controller.addListener(this.urlbarListener);
    window.addEventListener("unload", this, { once: true });
    this.updateEnabled();
    this.ensureDefaultTheme().catch(console.error);
    if (
      this.enabled &&
      CustomizableUI.getPlacementOfWidget("stop-reload-button")?.area !==
        CustomizableUI.AREA_NAVBAR
    ) {
      CustomizableUI.addWidgetToArea(
        "stop-reload-button",
        CustomizableUI.AREA_NAVBAR,
        CustomizableUI.getPlacementOfWidget("forward-button").position + 1
      );
    }
  },

  observe() {
    this.updateEnabled();
  },

  updateEnabled() {
    this.enabled = Services.prefs.getBoolPref(this.pref, false);
    document.documentElement.toggleAttribute("custom-ui", this.enabled);
    document.documentElement.setAttribute(
      "custom-theme",
      Services.prefs.getStringPref(this.themePref, "mono")
    );
    if (!this.enabled) {
      this.setPanelOpen(false);
    }
    this.updateNewTab();
    this.updateNewTabButtons();
    this.scheduleTabGroupUpdate();
  },

  /**
   * Mono has its own themes (browser.customUI.theme). A Firefox theme left on
   * from before paints its colors over them and keeps the window opaque, off
   * the acrylic, so Firefox's default theme is put back.
   */
  async ensureDefaultTheme() {
    const DEFAULT_THEME = "default-theme@mozilla.org";
    if (
      !this.enabled ||
      Services.prefs.getStringPref("extensions.activeThemeID", DEFAULT_THEME) ==
        DEFAULT_THEME
    ) {
      return;
    }
    let { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs"
    );
    let theme = await AddonManager.getAddonByID(DEFAULT_THEME);
    await theme?.enable();
  },

  updateNewTab() {
    let browser = gBrowser.selectedBrowser;
    let uri = browser.currentURI.spec;
    let isEmptyNewTab =
      uri === "about:newtab" &&
      !Services.prefs.getBoolPref("browser.newtabpage.enabled", true);
    let isEmptyStart =
      !browser.browsingContext.opener &&
      (uri === "chrome://browser/content/blanktab.html" ||
        (uri === "about:blank" && browser.contentPrincipal?.isNullPrincipal));
    let wasNewTab = document.documentElement.hasAttribute("custom-newtab");
    let isNewTab = document.documentElement.toggleAttribute(
      "custom-newtab",
      this.enabled &&
        Services.prefs.getBoolPref("sidebar.verticalTabs", false) &&
        !PrivateBrowsingUtils.isWindowPrivate(window) &&
        !window.CustomAgentUI?.hasState(gBrowser.selectedTab) &&
        (isEmptyNewTab || isEmptyStart)
    );
    // A tab opened from a page focuses the address field while the page is
    // still shown, which queues opening the centered address editor; the new
    // tab search replaces it after that queued work.
    if (isNewTab && !wasNewTab) {
      this.playNewTabLogo();
    }
    if (isNewTab) {
      queueMicrotask(() => {
        if (
          document.documentElement.hasAttribute("custom-newtab") &&
          window.CustomSidebarNavigation?.open
        ) {
          window.CustomSidebarNavigation.closeAddress({ restoreFocus: false });
        }
      });
    }
  },

  /**
   * Draws the new tab logo stroke by stroke the first time a new tab screen
   * appears after startup. Later new tab screens, in this or any other open
   * window, keep the static logo.
   */
  playNewTabLogo() {
    for (let win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.CustomBrowserUI?.newTabLogoPlayed) {
        return;
      }
    }
    this.newTabLogoPlayed = true;
    document.getElementById("custom-newtab-logo").src =
      "chrome://browser/content/custom-ui/resources/mono/animation/mono-glyph-draw.svg";
  },

  limitNewTabQuery(queryContext) {
    if (
      queryContext.sapName != "urlbar" ||
      !document.documentElement.hasAttribute("custom-newtab")
    ) {
      return;
    }
    if (!queryContext.trimmedSearchString) {
      queryContext.providers = [];
      return;
    }
    queryContext.providers = this.newTabProviders;
    queryContext.maxResults =
      1 +
      (window.CustomAgentChatUI?.enabled ? 1 : 0) +
      this.newTabMaxSuggestions;
  },

  updatePinCount() {
    this.pinnedTabs.setAttribute(
      "custom-pin-count",
      this.pinnedTabs.querySelectorAll(":scope > .tabbrowser-tab").length
    );
  },

  updateNewTabButtons() {
    let l10nId =
      this.enabled && Services.prefs.getBoolPref("sidebar.verticalTabs", false)
        ? "custom-ui-tabstrip-new-tab"
        : "tabs-toolbar-new-tab";
    for (let id of ["tabs-newtab-button", "vertical-tabs-newtab-button"]) {
      document.l10n.setAttributes(document.getElementById(id), l10nId);
    }
  },

  scheduleTabGroupUpdate() {
    if (!this.enabled || this.tabGroupUpdatePending) {
      return;
    }
    this.tabGroupUpdatePending = true;
    requestAnimationFrame(() => {
      this.tabGroupUpdatePending = false;
      for (let group of gBrowser.tabGroups) {
        this.updateTabGroup(group);
      }
    });
  },

  updateTabGroup(group) {
    let highlight = group.querySelector(".tab-group-label-hover-highlight");
    if (!highlight) {
      return;
    }
    let summary = highlight.querySelector(".custom-tab-group-summary");
    if (!summary) {
      summary = document.createElement("span");
      summary.className = "custom-tab-group-summary";
      summary.setAttribute("aria-hidden", "true");
      let icons = document.createElement("span");
      icons.className = "custom-tab-group-icons";
      for (let i = 0; i < 3; i++) {
        let icon = document.createElement("img");
        icon.className = "custom-tab-group-icon";
        icon.alt = "";
        icons.append(icon);
      }
      let count = document.createElement("span");
      count.className = "custom-tab-group-count";
      summary.append(icons, count);
      highlight.append(summary);
    }
    let tabs = group.tabs.filter(tab => !tab.closing);
    summary.querySelector(".custom-tab-group-count").textContent = tabs.length;
    summary.querySelectorAll(".custom-tab-group-icon").forEach((icon, i) => {
      let tab = tabs[i];
      icon.hidden = !tab;
      if (!tab) {
        return;
      }
      let src =
        tab.getAttribute("image") ||
        "chrome://global/skin/icons/defaultFavicon.svg";
      if (icon.getAttribute("src") !== src) {
        icon.setAttribute("src", src);
      }
    });
  },

  /**
   * Glides the selected tab's surface over from the tab that was shown
   * before, so selection travels along the list instead of jumping. Runs when
   * the tab switcher shows the new tab, between tabs of the same list.
   *
   * @param {MozTabbrowserTab} tab The tab now shown as selected.
   * @param {MozTabbrowserTab} previousTab The tab shown as selected before.
   */
  slideSelection(tab, previousTab) {
    let container = gBrowser.tabContainer;
    if (
      !this.enabled ||
      window.gReduceMotion ||
      !container.verticalMode ||
      !Services.prefs.getBoolPref("sidebar.animation.enabled", true) ||
      !previousTab?.isConnected ||
      previousTab == tab ||
      previousTab.closing ||
      previousTab.pinned != tab.pinned ||
      tab.multiselected ||
      container.hasAttribute("movingtab")
    ) {
      return;
    }
    container.setAttribute("custom-selection-sliding", "");
    let surface = tab.querySelector(".tab-background");
    // Read the previous surface before cancelling its own slide, so a quick
    // second switch starts from where the surface is on screen.
    let from = previousTab
      .querySelector(".tab-background")
      .getBoundingClientRect();
    let to = surface.getBoundingClientRect();
    this.selectionSlide?.cancel();
    let dx = from.x + from.width / 2 - (to.x + to.width / 2);
    let dy = from.y + from.height / 2 - (to.y + to.height / 2);
    if (
      !from.height ||
      !to.height ||
      Math.hypot(dx, dy) > this.selectionSlideMaxDistance
    ) {
      container.removeAttribute("custom-selection-sliding");
      return;
    }
    tab.setAttribute("custom-sliding", "");
    let animation = surface.animate(
      [
        {
          translate: `${dx}px ${dy}px`,
          scale: `${from.width / to.width} ${from.height / to.height}`,
        },
        { translate: "0 0", scale: "1 1" },
      ],
      {
        duration: this.selectionSlideDuration,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      }
    );
    this.selectionSlide = animation;
    let done = () => {
      tab.removeAttribute("custom-sliding");
      if (this.selectionSlide == animation) {
        this.selectionSlide = null;
        container.removeAttribute("custom-selection-sliding");
      }
    };
    animation.finished.then(done, done);
  },

  animate(element, attribute) {
    if (
      !this.enabled ||
      !gBrowser.tabContainer.verticalMode ||
      !Services.prefs.getBoolPref("sidebar.animation.enabled", true)
    ) {
      return;
    }
    element.setAttribute(attribute, "");
    setTimeout(() => element.removeAttribute(attribute), 400);
  },

  handleEvent(event) {
    switch (event.type) {
      case "TabSelect":
        this.updateNewTab();
        break;
      case "TabOpen":
        this.animate(event.target, "custom-opening");
        this.scheduleTabGroupUpdate();
        break;
      case "TabGroupExpand":
        this.animate(event.target, "custom-expanding");
        this.scheduleTabGroupUpdate();
        break;
      case "TabAttrModified":
        if (event.target.group && event.detail.changed.includes("image")) {
          this.scheduleTabGroupUpdate();
        }
        if (
          event.detail.changed.includes("visuallyselected") &&
          event.target.hasAttribute("visuallyselected")
        ) {
          this.slideSelection(event.target, this.visualTab);
          this.visualTab = event.target;
        }
        break;
      case "TabClose":
      case "TabMove":
      case "TabGrouped":
      case "TabUngrouped":
      case "TabGroupCreate":
      case "TabGroupCollapse":
        this.scheduleTabGroupUpdate();
        break;
      case "click":
        if (event.currentTarget === this.brandButton) {
          PanelUI.toggle(event);
        } else if (event.currentTarget === this.closeButton) {
          this.setPanelOpen(false);
        }
        break;
      case "keydown":
        if (
          event.currentTarget === this.brandButton &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) {
            PanelUI.toggle(event);
          }
        } else if (
          event.currentTarget === this.panel &&
          event.key === "Escape"
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.setPanelOpen(false);
        }
        break;
      case "popupshown":
      case "popuphidden":
        if (event.target === PanelUI.panel) {
          this.brandButton.setAttribute(
            "aria-expanded",
            String(event.type === "popupshown")
          );
        }
        break;
      case "unload":
        Services.prefs.removeObserver(this.pref, this);
        Services.prefs.removeObserver(this.themePref, this);
        Services.prefs.removeObserver("sidebar.verticalTabs", this);
        Services.prefs.removeObserver("browser.newtabpage.enabled", this);
        gBrowser.tabContainer.removeEventListener("TabSelect", this);
        for (let type of this.tabStripEvents) {
          gBrowser.tabContainer.removeEventListener(type, this);
        }
        gBrowser.removeTabsProgressListener(this.progressListener);
        this.pinnedObserver.disconnect();
        gURLBar.controller.removeListener(this.urlbarListener);
        PanelUI.panel.removeEventListener("popupshown", this);
        PanelUI.panel.removeEventListener("popuphidden", this);
        break;
    }
  },

  /**
   * Sets the sidebar's width in one step, so the page is laid out once at its
   * new size instead of on every frame of a width animation. The page area's
   * edge then moves from its old to its new place over the live sidebar,
   * clipping its old snapshot or revealing its new one, and the old snapshot
   * gives way to the new layout near the end. Not for dragging, where a
   * transition per width step would fight the splitter.
   *
   * @param {string} width A CSS width for the sidebar container.
   */
  resizeSidebar(width) {
    let container = document.getElementById("sidebar-container");
    if (container.style.width == width) {
      return;
    }
    let update = () => {
      container.style.width = width;
    };
    if (
      !this.enabled ||
      window.gReduceMotion ||
      !document.startViewTransition ||
      SidebarController._activeViewTransition
    ) {
      update();
      return;
    }
    let root = document.documentElement;
    let grows =
      !width || parseFloat(width) > container.getBoundingClientRect().width;
    root.setAttribute("custom-sidebar-resize", grows ? "grow" : "shrink");
    let transition = document.startViewTransition(update);
    this.resizeTransition = transition;
    // Starting another transition skips this one and rejects its ready promise.
    transition.ready.catch(() => {});
    transition.finished.finally(() => {
      if (this.resizeTransition == transition) {
        this.resizeTransition = null;
        root.removeAttribute("custom-sidebar-resize");
      }
    });
  },

  setPanelOpen(open, restoreFocus = true) {
    open = open && this.enabled;
    let wasOpen = !this.panel.hidden;
    this.panel.hidden = !open;
    document.documentElement.toggleAttribute("custom-ai-open", open);
    if (open) {
      this.closeButton.focus();
    } else if (wasOpen && restoreFocus) {
      gBrowser.selectedBrowser.focus();
    }
  },
};

document.documentElement.toggleAttribute(
  "custom-ui",
  Services.prefs.getBoolPref(CustomBrowserUI.pref, false)
);
delayedStartupPromise.then(() => CustomBrowserUI.init());
