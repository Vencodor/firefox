/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var CustomBrowserUI = {
  pref: "browser.customUI.enabled",

  init() {
    this.panel = document.getElementById("custom-ai-panel");
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
      case "click":
        if (event.currentTarget.id === "custom-sidebar-newtab") {
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
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.setPanelOpen(false);
        }
        break;
      case "unload":
        Services.prefs.removeObserver(this.pref, this);
        this.sidebarObserver.disconnect();
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
