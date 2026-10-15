/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var CustomBrowserUI = {
  pref: "browser.customUI.enabled",

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
    window.addEventListener("unload", this, { once: true });
    this.updateEnabled();
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
    if (!this.enabled) {
      this.setPanelOpen(false);
    }
    this.updateNewTab();
    this.updateNewTabButtons();
    this.scheduleTabGroupUpdate();
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
    document.documentElement.toggleAttribute(
      "custom-newtab",
      this.enabled &&
        Services.prefs.getBoolPref("sidebar.verticalTabs", false) &&
        !PrivateBrowsingUtils.isWindowPrivate(window) &&
        !window.CustomAgentUI?.hasState(gBrowser.selectedTab) &&
        (isEmptyNewTab || isEmptyStart)
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
        Services.prefs.removeObserver("sidebar.verticalTabs", this);
        Services.prefs.removeObserver("browser.newtabpage.enabled", this);
        gBrowser.tabContainer.removeEventListener("TabSelect", this);
        for (let type of this.tabStripEvents) {
          gBrowser.tabContainer.removeEventListener(type, this);
        }
        gBrowser.removeTabsProgressListener(this.progressListener);
        PanelUI.panel.removeEventListener("popupshown", this);
        PanelUI.panel.removeEventListener("popuphidden", this);
        break;
    }
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
