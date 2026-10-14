/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var CustomBrowserUI = {
  pref: "browser.customUI.enabled",

  init() {
    this.panel = document.getElementById("custom-ai-panel");
    this.brandButton = document.getElementById("custom-brand-button");
    this.brandButton.addEventListener("click", this);
    this.brandButton.addEventListener("keydown", this);
    PanelUI.panel.addEventListener("popupshown", this);
    PanelUI.panel.addEventListener("popuphidden", this);
    this.sidebarToggle = document.getElementById("custom-sidebar-toggle");
    this.button = document.getElementById("custom-ai-button");
    this.closeButton = document.getElementById("custom-ai-close");
    this.button.addEventListener("click", this);
    this.closeButton.addEventListener("click", this);
    this.sidebarToggle.addEventListener("click", this);
    document
      .getElementById("custom-sidebar-newtab")
      .addEventListener("click", this);
    document
      .getElementById("custom-settings-button")
      .addEventListener("click", this);
    this.panel.addEventListener("keydown", this);
    this.sidebarObserver = new MutationObserver(() =>
      this.updateSidebarToggle()
    );
    this.sidebarObserver.observe(SidebarController.sidebarContainer, {
      attributes: true,
      attributeFilter: ["sidebar-launcher-expanded", "hidden"],
    });
    document.getElementById("custom-newtab-shortcut").textContent =
      ShortcutUtils.prettifyShortcut(
        document.getElementById("key_newNavigatorTab")
      );
    Services.prefs.addObserver(this.pref, this);
    Services.prefs.addObserver("sidebar.verticalTabs", this);
    Services.prefs.addObserver("browser.newtabpage.enabled", this);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
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
    this.updateSidebarToggle();
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
        (isEmptyNewTab || isEmptyStart)
    );
  },

  updateSidebarToggle() {
    let expanded = SidebarController.sidebarMain.expanded;
    this.sidebarToggle.setAttribute("aria-expanded", String(expanded));
    document.l10n.setAttributes(
      this.sidebarToggle,
      expanded ? "custom-ui-sidebar-collapse" : "custom-ui-sidebar-expand"
    );
  },

  handleEvent(event) {
    switch (event.type) {
      case "TabSelect":
        this.updateNewTab();
        break;
      case "click":
        if (event.currentTarget === this.brandButton) {
          PanelUI.toggle(event);
        } else if (event.currentTarget.id === "custom-sidebar-newtab") {
          BrowserCommands.openTab({ event });
        } else if (event.currentTarget === this.sidebarToggle) {
          SidebarController.handleToolbarButtonClick();
        } else if (event.currentTarget.id === "custom-settings-button") {
          openPreferences();
        } else if (event.currentTarget === this.closeButton) {
          this.setPanelOpen(false);
        } else {
          this.togglePanel();
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
        gBrowser.removeTabsProgressListener(this.progressListener);
        this.sidebarObserver.disconnect();
        PanelUI.panel.removeEventListener("popupshown", this);
        PanelUI.panel.removeEventListener("popuphidden", this);
        break;
    }
  },

  togglePanel() {
    this.setPanelOpen(this.panel.hidden);
  },

  setPanelOpen(open, restoreFocus = true) {
    open = open && this.enabled;
    let wasOpen = !this.panel.hidden;
    this.panel.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    document.documentElement.toggleAttribute("custom-ai-open", open);
    if (open) {
      this.closeButton.focus();
    } else if (wasOpen && restoreFocus) {
      if (this.enabled && !this.button.closest("#sidebar-container").hidden) {
        this.button.focus();
      } else {
        gBrowser.selectedBrowser.focus();
      }
    }
  },
};

document.documentElement.toggleAttribute(
  "custom-ui",
  Services.prefs.getBoolPref(CustomBrowserUI.pref, false)
);
delayedStartupPromise.then(() => CustomBrowserUI.init());
