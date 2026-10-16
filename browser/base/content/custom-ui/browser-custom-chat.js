/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global delayedStartupPromise, gBrowser, gURLBar, PanelUI */

var CustomAgentChatUI = {
  pageURI: "chrome://browser/content/custom-ui/agent-chat.html",
  pref: "browser.customUI.enabled",
  initialQueries: new WeakMap(),

  get enabled() {
    return (
      Services.prefs.getBoolPref(this.pref, false) &&
      !document.documentElement.hasAttribute("custom-settings-window")
    );
  },

  get agent() {
    let agent = window.CustomAgentUI?.agent;
    return this.enabled && typeof agent?.chat === "function" ? agent : null;
  },

  init() {
    this.command = document.createXULElement("command");
    this.command.id = "Browser:AgentChat";
    this.command.addEventListener("command", () => this.startChat());
    document.getElementById("mainCommandSet").append(this.command);
    this.menuItem = document.createXULElement("toolbarbutton");
    this.menuItem.id = "custom-agent-chat-menuitem";
    this.menuItem.className = "subviewbutton";
    document.l10n.setAttributes(this.menuItem, "agent-chat-open");
    this.menuItem.addEventListener("command", () => {
      PanelUI.hide();
      this.openChat();
    });
    let newTabItem = document.getElementById("appMenu-new-tab-button2");
    if (newTabItem) {
      newTabItem.after(this.menuItem);
    } else {
      PanelUI.mainView
        .querySelector(".panel-subview-body")
        .append(this.menuItem);
    }
    Services.prefs.addObserver(this.pref, this);
    window.addEventListener("EndSwapDocShells", this, true);
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(this.pref, this);
        window.removeEventListener("EndSwapDocShells", this, true);
      },
      { once: true }
    );
    this.observe();
    for (let browser of gBrowser.browsers) {
      this.rebindChatPage(browser);
    }
  },

  handleEvent(event) {
    this.rebindChatPage(event.target);
  },

  rebindChatPage(browser) {
    if (browser.currentURI?.spec === this.pageURI) {
      browser.contentWindow?.AgentChatPage?.rebindWindow();
    }
  },

  observe() {
    this.menuItem.hidden = !this.enabled;
    this.command.toggleAttribute("disabled", !this.enabled);
    window.dispatchEvent(new CustomEvent("CustomAgentConnectionChanged"));
  },

  startChat(query = gURLBar.value) {
    if (!this.enabled) {
      return null;
    }
    query = query.trim();
    gURLBar.view.close();
    gURLBar.handleRevert();
    return this.openChat(query);
  },

  takeInitialQuery(browser) {
    let query = this.initialQueries.get(browser) ?? "";
    this.initialQueries.delete(browser);
    return query;
  },

  openChat(query = "") {
    if (!this.enabled) {
      return null;
    }
    let tab = gBrowser.addTrustedTab(this.pageURI, {
      relatedToCurrent: true,
    });
    if (query) {
      this.initialQueries.set(tab.linkedBrowser, query);
    }
    gBrowser.selectedTab = tab;
    return tab;
  },
};

delayedStartupPromise.then(() => CustomAgentChatUI.init());
