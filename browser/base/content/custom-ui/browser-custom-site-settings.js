/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var CustomSiteSettings = {
  init({ onOpen, onClose } = {}) {
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.panels = new Set();
    this.resizeObserver = new ResizeObserver(() => this.center());
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    window.addEventListener("resize", this);
    this.progressListener = {
      onLocationChange: browser => {
        if (browser === gBrowser.selectedBrowser) {
          this.close({ restoreFocus: false });
        }
      },
    };
    gBrowser.addTabsProgressListener(this.progressListener);
  },

  uninit() {
    this.close({ restoreFocus: false });
    this.resizeObserver.disconnect();
    gBrowser.tabContainer.removeEventListener("TabSelect", this);
    window.removeEventListener("resize", this);
    gBrowser.removeTabsProgressListener(this.progressListener);
    for (let panel of this.panels) {
      panel.removeEventListener("popupshown", this);
      panel.removeEventListener("popuppositioned", this);
      panel.removeEventListener("popuphidden", this);
    }
  },

  open(event) {
    if (
      !document.documentElement.hasAttribute("custom-ui") ||
      document.fullscreenElement
    ) {
      return;
    }
    if (this.currentPanel) {
      this.close();
      return;
    }
    gIdentityHandler._initializePopup();
    let panel = document.getElementById("identity-popup");
    this.prepare(panel);
    gIdentityHandler._openPopup(
      event,
      document.getElementById("custom-page-settings-button")
    );
  },

  openPermissions(event) {
    gPermissionPanel._initializePopup();
    let panel = document.getElementById("permission-popup");
    this.prepare(panel);
    gPermissionPanel.openPopup(
      event,
      document.getElementById("custom-page-settings-button")
    );
  },

  prepare(panel) {
    if (!this.panels.has(panel)) {
      this.panels.add(panel);
      panel.addEventListener("popupshown", this);
      panel.addEventListener("popuppositioned", this);
      panel.addEventListener("popuphidden", this);
      this.addControls(panel);
    }
    panel.setAttribute("custom-centered-site-panel", "true");
    panel.setAttribute("animate", "false");
    panel.removeAttribute("custom-site-panel-ready");
    for (let control of panel.querySelectorAll("[data-custom-site-settings]")) {
      control.hidden = false;
    }
    this.currentPanel = panel;
    this.onOpen?.();
  },

  addControls(panel) {
    let isIdentity = panel.id === "identity-popup";
    let mainView = panel.querySelector("panelview");
    let header = mainView.querySelector(".panel-header");
    let addButton = (parent, id, l10nId, onCommand, className = "") => {
      let button = document.createXULElement("toolbarbutton");
      button.id = id;
      button.className = `subviewbutton ${className}`;
      button.setAttribute("data-custom-site-settings", "true");
      document.l10n.setAttributes(button, l10nId);
      button.addEventListener("command", onCommand);
      parent.append(button);
      return button;
    };

    if (!isIdentity) {
      let back = addButton(
        header,
        "custom-site-settings-back",
        "custom-ui-site-settings-back",
        event => this.switchPanel(() => this.open(event)),
        "custom-site-settings-back"
      );
      header.prepend(back);
    }
    addButton(
      header,
      `${panel.id}-custom-close`,
      "custom-ui-site-settings-close",
      () => this.close(),
      "custom-site-settings-close"
    );
    if (isIdentity) {
      addButton(
        mainView.querySelector(".panel-subview-body"),
        "custom-site-settings-permissions",
        "custom-ui-site-permissions",
        event => this.switchPanel(() => this.openPermissions(event)),
        "subviewbutton-nav"
      );
    }
    addButton(
      mainView,
      `${panel.id}-custom-more-info`,
      "custom-ui-site-settings-more-info",
      () => {
        this.close({ restoreFocus: false });
        BrowserCommands.pageInfo(null, isIdentity ? "securityTab" : "permTab");
      },
      "panel-subview-footer-button"
    );
  },

  async switchPanel(openPanel) {
    let browser = gBrowser.selectedBrowser;
    let uri = browser.currentURI.spec;
    let panel = this.currentPanel;
    if (panel && panel.state !== "closed") {
      let hidden = new Promise(resolve => {
        let onHidden = event => {
          if (this.panelForEvent(event) === panel) {
            panel.removeEventListener("popuphidden", onHidden);
            resolve();
          }
        };
        panel.addEventListener("popuphidden", onHidden);
      });
      this.close({ restoreFocus: false });
      await hidden;
    }
    if (browser === gBrowser.selectedBrowser && browser.currentURI.spec === uri) {
      openPanel();
    }
  },

  close({ restoreFocus = true } = {}) {
    let panel = this.currentPanel;
    if (!panel) {
      return;
    }
    this.currentPanel = null;
    this.onClose?.();
    if (!restoreFocus) {
      panel.setAttribute("norestorefocus", "true");
    }
    PanelMultiView.hidePopup(panel);
    this.resizeObserver.unobserve(panel);
  },

  panelForEvent(event) {
    return event.target.localName === "panelmultiview"
      ? event.target.parentElement
      : event.target;
  },

  async center() {
    let panel = this.currentPanel;
    if (
      !panel ||
      !["showing", "open"].includes(panel.state) ||
      this.centerPending === panel
    ) {
      return;
    }
    this.centerPending = panel;
    try {
      let { x, y } = await window.promiseDocumentFlushed(() => {
        let bounds = panel.getOuterScreenRect();
        return {
          x: window.mozInnerScreenX + (window.innerWidth - bounds.width) / 2,
          y: window.mozInnerScreenY + (window.innerHeight - bounds.height) / 2,
        };
      });
      if (
        panel !== this.currentPanel ||
        !["showing", "open"].includes(panel.state)
      ) {
        return;
      }
      panel.moveTo(Math.round(x), Math.round(y));
      if (!panel.hasAttribute("custom-site-panel-ready")) {
        panel.setAttribute("custom-site-panel-ready", "true");
      }
    } finally {
      if (this.centerPending === panel) {
        this.centerPending = null;
      }
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "TabSelect":
        this.close({ restoreFocus: false });
        break;
      case "resize":
        this.center();
        break;
      case "popuppositioned":
        if (
          event.target === this.currentPanel &&
          !event.target.hasAttribute("custom-site-panel-ready")
        ) {
          this.center();
        }
        break;
      case "popupshown":
        if (event.target === this.currentPanel) {
          this.resizeObserver.observe(event.target);
          this.center();
          event.target
            .querySelector("panelview .subviewbutton:not([hidden])")
            ?.focus();
        }
        break;
      case "popuphidden": {
        let panel = this.panelForEvent(event);
        if (!this.panels.has(panel)) {
          break;
        }
        this.resizeObserver.unobserve(panel);
        panel.removeAttribute("custom-centered-site-panel");
        panel.removeAttribute("animate");
        panel.removeAttribute("custom-site-panel-ready");
        panel.removeAttribute("norestorefocus");
        for (let control of panel.querySelectorAll(
          "[data-custom-site-settings]"
        )) {
          control.hidden = true;
        }
        if (panel === this.currentPanel) {
          this.currentPanel = null;
          this.onClose?.();
        }
        break;
      }
    }
  },
};
