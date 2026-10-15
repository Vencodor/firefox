/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var CustomSettingsWindowController = {
  ready: false,

  init() {
    this.ready = true;
    window.onclose = () => this.canClose();
    window.addEventListener("command", this, true);
    window.addEventListener("click", this, true);
    window.addEventListener("sizemodechange", this);
    window.addEventListener("unload", this, { once: true });
    this.updateWindowState();
    this.setTitle().catch(console.error);
    window.dispatchEvent(new CustomEvent("MonoSettingsWindowReady"));
  },

  async setTitle() {
    document.l10n.setAttributes(
      document.querySelector("title"),
      "custom-ui-settings-window-title"
    );
    const title = await document.l10n.formatValue(
      "custom-ui-settings-window-title"
    );
    if (window.closed) {
      return;
    }
    const updateTitle = () => {
      if (document.title != title) {
        document.title = title;
      }
    };
    this.titleObserver = new MutationObserver(updateTitle);
    this.titleObserver.observe(document.querySelector("title"), {
      childList: true,
      characterData: true,
      subtree: true,
    });
    updateTitle();
  },

  navigate(paneID, extraArgs) {
    const browser = window.gBrowser.selectedBrowser;
    const currentURL = browser.currentURI.spec;
    const isSettings = /^about:(preferences|settings)([?#]|$)/.test(currentURL);
    if (isSettings && !paneID && !extraArgs?.urlParams) {
      browser.focus();
      return;
    }

    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(extraArgs?.urlParams || {})) {
      if (value !== undefined) {
        params.set(name, value);
      }
    }
    const category = (paneID || "").replace(/^pane./, match =>
      match[4].toLowerCase()
    );
    const query = params.size ? `?${params}` : "";
    if (
      isSettings &&
      currentURL.split("#")[0] == `about:preferences${query}` &&
      browser.contentDocument?.readyState == "complete" &&
      browser.contentWindow?.gotoPref
    ) {
      if (paneID) {
        browser.contentWindow.gotoPref(paneID);
      }
    } else {
      window.gBrowser.loadURI(
        Services.io.newURI(
          `about:preferences${query}${category ? `#${category}` : ""}`
        ),
        {
          loadFlags: isSettings
            ? Ci.nsIWebNavigation.LOAD_FLAGS_NONE
            : Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        }
      );
    }
    browser.focus();
  },

  updateWindowState() {
    if (window.windowState == window.STATE_MINIMIZED) {
      return;
    }
    let sizeMode = "normal";
    if (window.fullScreen) {
      sizeMode = "fullscreen";
    } else if (window.windowState == window.STATE_MAXIMIZED) {
      sizeMode = "maximized";
    }
    document.documentElement.setAttribute("sizemode", sizeMode);
  },

  canClose() {
    if (!window.CanCloseWindow()) {
      return false;
    }
    window.skipNextCanClose = true;
    return true;
  },

  async forwardCommand(id) {
    let target = window.BrowserWindowTracker.getTopWindow({ private: false });
    if (!target) {
      target = await window.BrowserWindowTracker.promiseOpenWindow();
    }
    if (target.windowState == target.STATE_MINIMIZED) {
      target.restore();
    }
    target.focus();
    target.document.getElementById(id)?.doCommand();
  },

  handleEvent(event) {
    switch (event.type) {
      case "sizemodechange":
        this.updateWindowState();
        break;
      case "command":
        switch (event.target.id) {
          case "cmd_close":
          case "cmd_closeWindow":
            event.preventDefault();
            event.stopImmediatePropagation();
            if (this.canClose()) {
              window.close();
            }
            break;
          case "Browser:OpenLocation":
          case "cmd_newNavigatorTab":
          case "Browser:SearchTabs":
          case "Browser:DuplicateTab":
          case "Browser:AddTabSplitView":
          case "Browser:ShowAllTabs":
          case "History:UndoCloseTab":
          case "History:RestoreLastClosedTabOrWindowOrSession":
          case "cmd_CustomizeToolbars":
            event.preventDefault();
            event.stopImmediatePropagation();
            this.forwardCommand(event.target.id).catch(console.error);
            break;
        }
        break;
      case "click": {
        const control = event.target.closest?.(
          "button[data-settings-window-command]"
        );
        if (control?.closest("#custom-settings-window-controls")) {
          if (event.button == 0) {
            document
              .getElementById(control.dataset.settingsWindowCommand)
              ?.doCommand();
          }
          return;
        }
        const link = event
          .composedPath()
          .find(node => node.matches?.("a[href]"));
        if (
          event.defaultPrevented ||
          event.button > 1 ||
          !link ||
          !/^about:(preferences|settings)([?#]|$)/.test(
            link.ownerDocument.documentURI
          ) ||
          !/^https?:/.test(link.href) ||
          link.target == "_blank"
        ) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const where = window.BrowserUtils.whereToOpenLink(event);
        window.openTrustedLinkIn(link.href, where == "current" ? "tab" : where);
        break;
      }
      case "unload":
        this.titleObserver?.disconnect();
        this.titlebarObserver?.disconnect();
        break;
    }
  },
};

{
  const options = window.arguments?.[1];
  if (
    options instanceof Ci.nsIPropertyBag2 &&
    options.hasKey("custom-settings-window") &&
    options.getPropertyAsBool("custom-settings-window")
  ) {
    const root = document.documentElement;
    root.setAttribute("custom-settings-window", "true");
    root.setAttribute("windowtype", "mono:settings");
    root.setAttribute("customtitlebar", "true");
    root.removeAttribute("retargetdocumentfocus");
    root.removeAttribute("persist");
    root.setAttribute("sizemode", "normal");
    root.setAttribute("width", Math.min(screen.availWidth, 1100));
    root.setAttribute("height", Math.min(screen.availHeight, 800));
    window.CustomTitlebar.allowedBy("custom-settings-window", true);
    const ensureCustomTitlebar = () => {
      if (root.getAttribute("customtitlebar") != "true") {
        root.setAttribute("customtitlebar", "true");
      }
    };
    CustomSettingsWindowController.titlebarObserver = new MutationObserver(
      ensureCustomTitlebar
    );
    CustomSettingsWindowController.titlebarObserver.observe(root, {
      attributes: true,
      attributeFilter: ["customtitlebar"],
    });
    window.addEventListener("MozBeforeInitialXULLayout", ensureCustomTitlebar, {
      once: true,
    });
    window.addEventListener(
      "DOMContentLoaded",
      () => CustomSettingsWindowController.init(),
      { once: true }
    );
  }
}
