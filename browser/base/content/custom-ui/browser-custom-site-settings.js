/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var CustomSiteSettings = {
  init({ onOpen, onClose } = {}) {
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.button = document.getElementById("custom-page-settings-button");
    this.panel = document.getElementById("custom-page-panel");
    this.panel.setAttribute("consumeoutsideclicks", "false");
    this.multiView = document.getElementById("custom-page-multiview");
    this.mainView = document.getElementById("custom-page-main-view");
    this.siteView = document.getElementById("custom-page-site-view");
    this.extensions = document.getElementById("custom-page-extensions");
    this.bookmark = document.getElementById("custom-page-bookmark");
    this.translate = document.getElementById("custom-page-translate");
    this.zoomOut = document.getElementById("custom-page-zoom-out");
    this.zoomReset = document.getElementById("custom-page-zoom-reset");
    this.zoomIn = document.getElementById("custom-page-zoom-in");
    this.fold = document.getElementById("custom-page-fold");
    this.connection = document.getElementById("custom-page-connection");
    this.siteInfo = document.getElementById("custom-page-site-info");
    this.tracking = document.getElementById("custom-page-tracking");
    this.permissions = document.getElementById("custom-page-permissions");
    this.permissionList = document.getElementById(
      "custom-page-permission-list"
    );
    this.clearData = document.getElementById("custom-page-clear-data");

    for (let type of ["popupshowing", "popuphidden", "click"]) {
      this.panel.addEventListener(type, this);
    }
    this.mainView.addEventListener("ViewShowing", this);
    this.siteView.addEventListener("ViewShowing", this);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
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
    gBrowser.tabContainer.removeEventListener("TabSelect", this);
    gBrowser.removeTabsProgressListener(this.progressListener);
    gBrowser.removeEventListener("FullZoomChange", this);
  },

  get isOpen() {
    return ["open", "showing"].includes(this.panel.state);
  },

  open(event) {
    if (
      !document.documentElement.hasAttribute("custom-ui") ||
      document.fullscreenElement
    ) {
      return;
    }
    if (this.isOpen) {
      this.close();
      return;
    }
    PanelMultiView.openPopup(this.panel, this.button, {
      position: "end_before",
      triggerEvent: event,
    }).catch(console.error);
  },

  close({ restoreFocus = true } = {}) {
    if (this.panel.state === "closed") {
      return;
    }
    this.panel.toggleAttribute("norestorefocus", !restoreFocus);
    PanelMultiView.hidePopup(this.panel);
  },

  /**
   * Moves a browser popup whose anchor is hidden by the custom UI, such as a
   * toolbar or address bar button, next to the page settings button.
   *
   * @param {Element} anchor
   * @param {object|string} options
   *   The position options passed to openPopup.
   * @returns {Array} The anchor and options to open the popup with.
   */
  redirectPopup(anchor, options) {
    if (
      !anchor ||
      !this.button?.checkVisibility() ||
      (anchor !== this.button && anchor.checkVisibility())
    ) {
      return [anchor, options];
    }
    let position = "end_before";
    return [
      this.button,
      options && typeof options === "object"
        ? { ...options, position }
        : position,
    ];
  },

  updateMainView() {
    this.updateExtensions();
    let starred = BookmarkingUI.star?.hasAttribute("starred");
    this.bookmark.toggleAttribute("starred", starred);
    document.l10n.setAttributes(
      this.bookmark,
      starred ? "custom-ui-page-bookmark-edit" : "custom-ui-page-bookmark"
    );
    let translations = document.getElementById("translations-button");
    this.translate.disabled = !translations || translations.hidden;
    this.translate.toggleAttribute(
      "translationsactive",
      !!translations?.hasAttribute("translationsactive")
    );
    this.updateZoom();
    this.updateFold();
  },

  updateFold() {
    let state = window.CustomFoldUI?.getSiteState();
    this.fold.hidden = !state;
    if (state) {
      this.fold.dataset.site = state.id;
      this.fold.setAttribute("aria-checked", String(state.enabled));
    }
  },

  updateExtensions() {
    let buttons = [];
    for (let id of CustomizableUI.getWidgetIdsInArea(
      CustomizableUI.AREA_NAVBAR
    )) {
      if (!CustomizableUI.isWebExtensionWidget(id)) {
        continue;
      }
      let node = CustomizableUI.getWidget(id)?.forWindow(window).node;
      let action = node?.querySelector(
        ".unified-extensions-item-action-button"
      );
      if (!action) {
        continue;
      }
      let label =
        node.querySelector(".unified-extensions-item-name")?.textContent ||
        action.getAttribute("label");
      let button = document.createElement("button");
      button.type = "button";
      button.className = "custom-page-extension";
      button.dataset.widgetId = id;
      button.disabled = action.hasAttribute("disabled");
      button.setAttribute("aria-label", label);
      button.title = label;
      button.setAttribute("style", action.getAttribute("style") || "");
      let badge = action.getAttribute("badge");
      if (badge) {
        let badgeNode = document.createElement("span");
        badgeNode.className = "custom-page-extension-badge";
        badgeNode.textContent = badge;
        button.append(badgeNode);
      }
      buttons.push(button);
    }
    this.extensions.replaceChildren(...buttons);
    this.extensions.hidden = !buttons.length;
  },

  updateZoom() {
    let zoom = ZoomManager.getZoomForBrowser(gBrowser.selectedBrowser);
    document.l10n.setAttributes(this.zoomReset, "custom-ui-page-zoom-reset", {
      zoom: Math.round(zoom * 100),
    });
    this.zoomOut.disabled = zoom <= ZoomManager.MIN;
    this.zoomIn.disabled = zoom >= ZoomManager.MAX;
  },

  updateSiteView(event) {
    let connection = gIdentityHandler.getConnectionSecurityInformation();
    let secure = connection.startsWith("secure");
    let notSecure = [
      "not-secure",
      "cert-error-page",
      "https-only-error-page",
      "net-error-page",
    ].includes(connection);
    if (secure || notSecure) {
      let state = secure ? "secure" : "not-secure";
      this.siteInfo.setAttribute("connection", state);
      document.l10n.setAttributes(
        this.connection,
        `custom-ui-page-connection-${state}`
      );
    } else {
      this.siteInfo.setAttribute("connection", "other");
      this.connection.removeAttribute("data-l10n-id");
      this.connection.textContent = "";
    }

    this.tracking.hidden = !ContentBlockingAllowList.canHandle(
      gBrowser.selectedBrowser
    );
    this.tracking.setAttribute(
      "aria-checked",
      String(!gProtectionsHandler.hasException)
    );

    this.updatePermissions();

    this.clearData.hidden = true;
    if (
      !PrivateBrowsingUtils.isWindowPrivate(window) &&
      gIdentityHandler._uriHasHost &&
      !gIdentityHandler._pageExtensionPolicy
    ) {
      event.detail.addBlocker(
        SiteDataManager.hasSiteData(gIdentityHandler._uri.asciiHost).then(
          hasData => {
            this.clearData.hidden = !hasData;
            return true;
          },
          () => true
        )
      );
    }
  },

  updatePermissions() {
    let browser = gBrowser.selectedBrowser;
    let items = [];
    for (let permission of SitePermissions.getAllForBrowser(browser)) {
      let label = SitePermissions.getPermissionLabel(permission.id);
      if (label === null) {
        continue;
      }
      let [id] = permission.id.split(SitePermissions.PERM_KEY_DELIMITER);
      let item = document.createElement("li");
      item.className = "custom-page-permission";

      let icon = document.createXULElement("image");
      icon.classList.add("custom-page-permission-icon", `${id}-icon`);
      icon.classList.toggle(
        "blocked-permission-icon",
        permission.state === SitePermissions.BLOCK ||
          permission.state === SitePermissions.AUTOPLAY_BLOCKED_ALL
      );

      let name = document.createElement("span");
      name.className = "custom-page-row-label";
      name.textContent = label;

      let state = document.createElement("span");
      state.className = "custom-page-row-value";
      state.textContent = SitePermissions.getCurrentStateLabel(
        permission.state,
        id,
        permission.scope
      );
      item.append(icon, name, state);

      if (
        ![SitePermissions.SCOPE_POLICY, SitePermissions.SCOPE_GLOBAL].includes(
          permission.scope
        )
      ) {
        let clear = document.createElement("button");
        clear.type = "button";
        clear.className =
          "custom-page-icon-button custom-page-permission-clear";
        clear.dataset.permission = permission.id;
        document.l10n.setAttributes(clear, "custom-ui-page-permission-clear", {
          permission: label,
        });
        item.append(clear);
      }
      items.push(item);
    }
    this.permissionList.replaceChildren(...items);
    this.permissions.hidden = !items.length;
  },

  clearPermission(button) {
    let browser = gBrowser.selectedBrowser;
    let next = button.closest("li").nextElementSibling?.querySelector("button");
    SitePermissions.removeFromPrincipal(
      browser.contentPrincipal,
      button.dataset.permission,
      browser
    );
    gPermissionPanel.refreshPermissionIcons();
    this.updatePermissions();
    let fallback = this.tracking.hidden ? this.siteInfo : this.tracking;
    (next?.isConnected ? next : fallback).focus();
  },

  onClick(event) {
    let button = event.target.closest("button");
    if (!button || button.disabled || event.button !== 0) {
      return;
    }
    switch (button.id) {
      case "custom-page-bookmark":
        this.close({ restoreFocus: false });
        BookmarkingUI.onStarCommand(event);
        return;
      case "custom-page-translate":
        this.close({ restoreFocus: false });
        FullPageTranslationsPanel.open(event);
        return;
      case "custom-page-extensions-manage":
        this.close({ restoreFocus: false });
        gUnifiedExtensions.togglePanel(event);
        return;
      case "custom-page-zoom-out":
        FullZoom.reduce();
        return;
      case "custom-page-zoom-reset":
        FullZoom.reset();
        return;
      case "custom-page-zoom-in":
        FullZoom.enlarge();
        return;
      case "custom-page-fold": {
        let enabled = button.getAttribute("aria-checked") != "true";
        button.setAttribute("aria-checked", String(enabled));
        window.CustomFoldUI?.setSiteEnabled(button.dataset.site, enabled);
        return;
      }
      case "custom-page-site-settings":
        this.multiView.showSubView(this.siteView.id, button);
        return;
      case "custom-page-site-info":
        this.close({ restoreFocus: false });
        BrowserCommands.pageInfo(null, "securityTab");
        return;
      case "custom-page-tracking": {
        let enable = gProtectionsHandler.hasException;
        this.close({ restoreFocus: false });
        if (enable) {
          gProtectionsHandler.enableForCurrentPage();
        } else {
          gProtectionsHandler.disableForCurrentPage();
        }
        return;
      }
      case "custom-page-clear-data":
        this.close({ restoreFocus: false });
        gIdentityHandler.clearSiteData(event);
        return;
    }
    if (button.dataset.widgetId) {
      this.activateExtension(button.dataset.widgetId);
    } else if (button.dataset.permission) {
      this.clearPermission(button);
    }
  },

  activateExtension(widgetId) {
    let node = CustomizableUI.getWidget(widgetId)?.forWindow(window).node;
    let action = node?.querySelector(".unified-extensions-item-action-button");
    this.close({ restoreFocus: false });
    action?.dispatchEvent(
      new CustomEvent("command", { bubbles: true, cancelable: true })
    );
  },

  handleEvent(event) {
    switch (event.type) {
      case "ViewShowing":
        if (event.target === this.mainView) {
          this.updateMainView();
        } else if (event.target === this.siteView) {
          this.updateSiteView(event);
        }
        break;
      case "click":
        this.onClick(event);
        break;
      case "FullZoomChange":
        this.updateZoom();
        break;
      case "TabSelect":
        this.close({ restoreFocus: false });
        break;
      case "popupshowing":
        if (event.target === this.panel) {
          gBrowser.addEventListener("FullZoomChange", this);
          this.onOpen?.();
        }
        break;
      case "popuphidden":
        if (event.target === this.panel || event.target === this.multiView) {
          gBrowser.removeEventListener("FullZoomChange", this);
          this.panel.removeAttribute("norestorefocus");
          this.onClose?.();
        }
        break;
    }
  },
};
