/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shows a new-feature notice card under the search box of the new tab screen
 * and, on other pages, at the bottom of the expanded sidebar. The notice is
 * the JSON value of `browser.customUI.notice`: { id, title, description,
 * label }. Closing the card adds its id to `browser.customUI.noticeDismissed`,
 * so a notice stays until it is closed. Nothing shows while the pref is empty.
 */
var CustomNotice = {
  pref: "browser.customUI.notice",
  dismissedPref: "browser.customUI.noticeDismissed",
  maxDismissed: 50,

  notice: null,

  init() {
    this.newtabCard = document.getElementById("custom-notice-newtab");
    this.cards = [
      this.newtabCard,
      document.getElementById("custom-notice-sidebar"),
    ];
    for (let card of this.cards) {
      card
        .querySelector(".custom-notice-close")
        .addEventListener("click", this);
    }
    Services.prefs.addObserver(this.pref, this);
    Services.prefs.addObserver(this.dismissedPref, this);
    this.urlbarObserver = new MutationObserver(() => this.syncUrlbarOpen());
    this.urlbarObserver.observe(gURLBar, {
      attributes: true,
      attributeFilter: ["open"],
    });
    window.addEventListener("unload", this, { once: true });
    this.update();
  },

  readNotice() {
    let value = Services.prefs.getStringPref(this.pref, "");
    if (!value) {
      return null;
    }
    try {
      let { id, title, description, label } = JSON.parse(value);
      if (typeof id != "string" || typeof title != "string") {
        throw new Error("id and title must be strings");
      }
      return {
        id,
        title,
        description: description ?? "",
        label: label ?? "",
      };
    } catch (e) {
      console.error(`${this.pref} is not a valid notice: ${e}`);
      return null;
    }
  },

  readDismissed() {
    try {
      let ids = JSON.parse(
        Services.prefs.getStringPref(this.dismissedPref, "[]")
      );
      return Array.isArray(ids) ? ids : [];
    } catch (e) {
      return [];
    }
  },

  update() {
    let notice = this.readNotice();
    if (notice && this.readDismissed().includes(notice.id)) {
      notice = null;
    }
    this.notice = notice;
    for (let card of this.cards) {
      card.hidden = !notice;
      if (!notice) {
        continue;
      }
      let label = card.querySelector(".custom-notice-label");
      if (notice.label) {
        label.removeAttribute("data-l10n-id");
        label.textContent = notice.label;
      } else {
        document.l10n.setAttributes(label, "custom-ui-notice-label");
      }
      card.querySelector(".custom-notice-title").textContent = notice.title;
      card.querySelector(".custom-notice-description").textContent =
        notice.description;
    }
  },

  dismiss() {
    if (!this.notice) {
      return;
    }
    let hadFocus = this.cards.some(card =>
      card.contains(document.activeElement)
    );
    let ids = [...this.readDismissed(), this.notice.id];
    Services.prefs.setStringPref(
      this.dismissedPref,
      JSON.stringify(ids.slice(-this.maxDismissed))
    );
    if (hadFocus) {
      let onNewTab = document.documentElement.hasAttribute("custom-newtab");
      (onNewTab ? gURLBar : gBrowser.selectedBrowser).focus();
    }
  },

  syncUrlbarOpen() {
    this.newtabCard.toggleAttribute(
      "urlbar-open",
      gURLBar.hasAttribute("open")
    );
  },

  observe() {
    this.update();
  },

  handleEvent(event) {
    switch (event.type) {
      case "click":
        this.dismiss();
        break;
      case "unload":
        Services.prefs.removeObserver(this.pref, this);
        Services.prefs.removeObserver(this.dismissedPref, this);
        this.urlbarObserver.disconnect();
        break;
    }
  },
};

delayedStartupPromise.then(() => CustomNotice.init());
