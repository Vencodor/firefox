/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var CustomSidebarNavigation = {
  init() {
    this.root = document.documentElement;
    this.domain = document.getElementById("custom-sidebar-domain");
    this.settings = document.getElementById("custom-page-settings-button");
    this.backdrop = document.getElementById("custom-address-backdrop");
    this.back = document.getElementById("custom-back-button");
    this.forward = document.getElementById("custom-forward-button");
    this.reload = document.getElementById("custom-reload-button");
    this.originalTabIndex = gURLBar.inputField.getAttribute("tabindex");
    this.buttons = [
      this.domain,
      this.settings,
      this.back,
      this.forward,
      this.reload,
      ...document.querySelectorAll("#custom-window-controls > button"),
    ];
    for (let button of this.buttons) {
      button.addEventListener("click", this);
    }
    for (let button of [this.back, this.forward, this.reload]) {
      button.addEventListener("auxclick", this);
    }
    this.backdrop.addEventListener("mousedown", this);
    this.windowControls = document.getElementById("custom-window-controls");
    this.windowControlsListener = event => this.onWindowControlsEvent(event);
    for (let element of [
      this.windowControls,
      document.getElementById("custom-window-controls-hotspot"),
    ]) {
      element.addEventListener("mouseenter", this.windowControlsListener);
      element.addEventListener("mouseleave", this.windowControlsListener);
    }
    this.windowControls.addEventListener(
      "focusin",
      this.windowControlsListener
    );
    this.windowControls.addEventListener(
      "focusout",
      this.windowControlsListener
    );
    gURLBar.addEventListener("focusin", this);
    gURLBar.addEventListener("focusout", this);
    window.addEventListener("keydown", this, true);
    window.addEventListener("unload", this, { once: true });
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    Services.prefs.addObserver("sidebar.verticalTabs", this);
    this.rootObserver = new MutationObserver(() => this.updateMode());
    this.rootObserver.observe(this.root, {
      attributes: true,
      attributeFilter: [
        "custom-ui",
        "custom-newtab",
        "custom-settings-window",
        "customizing",
        "inFullscreen",
        "inDOMFullscreen",
        "chromehidden",
        "sizemode",
      ],
    });
    this.commandObserver = new MutationObserver(() => this.updateButtons());
    for (let id of [
      "Browser:Back",
      "Browser:Forward",
      "Browser:Stop",
      "Browser:Reload",
    ]) {
      this.commandObserver.observe(document.getElementById(id), {
        attributes: true,
        attributeFilter: ["disabled"],
      });
    }
    this.viewObserver = new ResizeObserver(entries => {
      this.viewHeight = entries[0].borderBoxSize[0]?.blockSize || 0;
      this.root.style.setProperty(
        "--custom-address-view-height",
        `${Math.ceil(this.viewHeight)}px`
      );
    });
    this.viewObserver.observe(gURLBar.querySelector(".urlbarView"));
    this.progressListener = {
      onLocationChange: browser => {
        if (browser === gBrowser.selectedBrowser) {
          this.updateDomain();
          this.updateButtons();
        }
      },
    };
    gBrowser.addTabsProgressListener(this.progressListener);
    CustomSiteSettings.init({
      onOpen: () => {
        this.closeAddress({ restoreFocus: false });
        this.settings.setAttribute("aria-expanded", "true");
      },
      onClose: () => this.settings.setAttribute("aria-expanded", "false"),
    });
    this.updateMode();
    this.updateDomain();
    this.updateButtons();
  },

  observe() {
    this.updateMode();
  },

  updateMode() {
    let wasEnabled = this.enabled;
    this.enabled =
      this.root.hasAttribute("custom-ui") &&
      Services.prefs.getBoolPref("sidebar.verticalTabs", false) &&
      !this.root.getAttribute("chromehidden") &&
      ![
        "custom-settings-window",
        "customizing",
        "inFullscreen",
        "inDOMFullscreen",
      ].some(name => this.root.hasAttribute(name));
    this.root.toggleAttribute("custom-sidebar-navigation", this.enabled);
    if (!this.enabled) {
      this.closeAddress({ restoreFocus: false });
      CustomSiteSettings.close({ restoreFocus: false });
    } else if (
      !wasEnabled &&
      gURLBar.focused &&
      !this.root.hasAttribute("custom-newtab")
    ) {
      this.openAddress({ select: false });
    }
    this.updateInputTabOrder();
    document.l10n.setAttributes(
      document.getElementById("custom-window-maximize"),
      this.root.getAttribute("sizemode") === "maximized"
        ? "custom-ui-settings-window-restore"
        : "custom-ui-settings-window-maximize"
    );
  },

  updateInputTabOrder() {
    if (this.enabled && !this.open && !this.root.hasAttribute("custom-newtab")) {
      gURLBar.inputField.setAttribute("tabindex", "-1");
    } else if (this.originalTabIndex === null) {
      gURLBar.inputField.removeAttribute("tabindex");
    } else {
      gURLBar.inputField.setAttribute("tabindex", this.originalTabIndex);
    }
  },

  updateDomain() {
    let uri = gBrowser.selectedBrowser.currentURI;
    if (isInitialPage(uri)) {
      document.l10n.setAttributes(this.domain, "custom-ui-address-new-tab");
      this.domain.removeAttribute("title");
      return;
    }
    document.l10n.setAttributes(this.domain, "custom-ui-address-input");
    let label;
    try {
      label = uri.displayHostPort;
    } catch {}
    if (!label) {
      label = uri.schemeIs("about")
        ? uri.spec.split(/[?#]/)[0]
        : `${uri.scheme}:`;
    }
    this.domain.textContent = label;
    this.domain.title = label;
  },

  updateButtons() {
    this.back.disabled = document
      .getElementById("Browser:Back")
      .hasAttribute("disabled");
    this.forward.disabled = document
      .getElementById("Browser:Forward")
      .hasAttribute("disabled");
    let loading = !document
      .getElementById("Browser:Stop")
      .hasAttribute("disabled");
    this.reload.toggleAttribute("loading", loading);
    this.reload.disabled =
      !loading &&
      document.getElementById("Browser:Reload").hasAttribute("disabled");
    document.l10n.setAttributes(
      this.reload,
      loading ? "custom-ui-navigation-stop" : "custom-ui-navigation-reload"
    );
  },

  openAddress({ select = true } = {}) {
    if (!this.enabled || this.open) {
      return;
    }
    CustomSiteSettings.close({ restoreFocus: false });
    this.open = true;
    this.root.setAttribute("custom-address-open", "");
    this.backdrop.hidden = false;
    this.domain.setAttribute("aria-expanded", "true");
    this.updateInputTabOrder();
    if (
      gURLBar.userTypedValue === null ||
      gURLBar.hasAttribute("persistsearchterms")
    ) {
      gURLBar.setURI({ hideSearchTerms: true });
      gURLBar.setValue(gURLBar.untrimmedValue, { allowTrim: false });
      select = true;
    }
    if (select) {
      gURLBar.select();
    }
    gURLBar.setUnifiedSearchButtonAvailability(true);
  },

  closeAddress({ restoreFocus = true } = {}) {
    if (!this.open) {
      return;
    }
    this.open = false;
    gURLBar.view.close();
    gURLBar.searchModeSwitcher.closePanel();
    this.root.removeAttribute("custom-address-open");
    this.backdrop.hidden = true;
    this.domain.setAttribute("aria-expanded", "false");
    this.updateInputTabOrder();
    if (restoreFocus) {
      this.domain.focus();
    }
  },

  /**
   * Shows the window controls while the pointer is in the window's top-right
   * margin or over the controls, or while a control has focus. Showing waits
   * briefly so passing over the margin doesn't flash them, and hiding waits so
   * the pointer can move from the margin onto the controls.
   *
   * @param {Event} event
   */
  onWindowControlsEvent(event) {
    switch (event.type) {
      case "mouseenter":
        this.windowControlsHovered = true;
        break;
      case "mouseleave":
        this.windowControlsHovered = false;
        break;
      case "focusin":
        this.windowControlsFocused = true;
        break;
      case "focusout":
        this.windowControlsFocused = this.windowControls.contains(
          event.relatedTarget
        );
        break;
    }
    clearTimeout(this.windowControlsTimer);
    let reveal = this.windowControlsHovered || this.windowControlsFocused;
    if (reveal === this.windowControls.hasAttribute("revealed")) {
      return;
    }
    if (this.windowControlsFocused) {
      this.windowControls.setAttribute("revealed", "");
      return;
    }
    this.windowControlsTimer = setTimeout(
      () => this.windowControls.toggleAttribute("revealed", reveal),
      reveal ? this.windowControlsRevealDelayMs : this.windowControlsHideDelayMs
    );
  },

  windowControlsRevealDelayMs: 80,
  windowControlsHideDelayMs: 300,

  handleEvent(event) {
    switch (event.type) {
      case "click":
      case "auxclick": {
        if (!this.enabled || (event.button !== 0 && event.button !== 1)) {
          return;
        }
        let button = event.currentTarget;
        if (button.disabled) {
          return;
        }
        if (button === this.domain) {
          this.openAddress();
        } else if (button === this.settings) {
          CustomSiteSettings.open(event);
        } else if (button === this.back) {
          BrowserCommands.back(event);
        } else if (button === this.forward) {
          BrowserCommands.forward(event);
        } else if (button === this.reload) {
          if (button.hasAttribute("loading")) {
            BrowserCommands.stop();
          } else {
            BrowserCommands.reloadOrDuplicate(event);
          }
        } else {
          let command = button.dataset.windowCommand;
          if (
            command === "cmd_maximizeWindow" &&
            window.windowState === window.STATE_MAXIMIZED
          ) {
            command = "cmd_restoreWindow";
          }
          document.getElementById(command)?.doCommand();
        }
        break;
      }
      case "mousedown":
        event.preventDefault();
        this.closeAddress();
        break;
      case "focusin":
        if (!this.root.hasAttribute("custom-newtab")) {
          queueMicrotask(() => {
            if (gURLBar.focused) {
              this.openAddress({ select: false });
            }
          });
        }
        break;
      case "focusout":
        queueMicrotask(() => {
          if (!gURLBar.contains(document.activeElement)) {
            this.closeAddress({ restoreFocus: false });
          }
        });
        break;
      case "keydown":
        if (
          this.open &&
          event.key === "Escape" &&
          !event.isComposing &&
          !["open", "showing"].includes(
            gURLBar.querySelector(".searchmode-switcher-panel")?.state
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          gURLBar.handleRevert();
          this.closeAddress();
        }
        break;
      case "TabSelect":
        if (this.open && gURLBar.focused) {
          gBrowser.selectedBrowser.focus();
        }
        this.closeAddress({ restoreFocus: false });
        this.updateDomain();
        this.updateButtons();
        break;
      case "unload":
        this.rootObserver.disconnect();
        this.commandObserver.disconnect();
        this.viewObserver.disconnect();
        clearTimeout(this.windowControlsTimer);
        Services.prefs.removeObserver("sidebar.verticalTabs", this);
        gBrowser.removeTabsProgressListener(this.progressListener);
        gBrowser.tabContainer.removeEventListener("TabSelect", this);
        window.removeEventListener("keydown", this, true);
        CustomSiteSettings.uninit();
        break;
    }
  },
};

delayedStartupPromise.then(() => CustomSidebarNavigation.init());
