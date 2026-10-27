/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var MonoPreferences = {
  get enabled() {
    return Services.prefs.getBoolPref("browser.customUI.enabled", false);
  },

  module: "chrome://browser/content/preferences/custom-ui/settings-config.mjs",

  // The categories in the navigation, in order. Settings are grouped by what
  // the user wants to change rather than by Firefox's panes.
  categories: [
    "general",
    "appearance",
    "tabsBrowsing",
    "fold",
    "connect",
    "privacy",
  ],

  icons: {
    general: "fold/settings.svg",
    appearance: "settings/appearance.svg",
    tabsBrowsing: "settings/tabs.svg",
    fold: "fold/sidebar.svg",
    connect: "fold/link.svg",
    privacy: "settings/privacy.svg",
    extensions: "settings/extensions.svg",
  },

  iconSrc(id) {
    return `chrome://browser/content/custom-ui/resources/${this.icons[id]}`;
  },

  // Firefox panes that open as sub-pages of a category, with the name of
  // their Mono heading (custom-ui-settings-<name>-heading).
  subPanes: {
    languages: ["general", "languages"],
    passwordsAutofill: ["privacy", "passwords"],
    permissionsData: ["privacy", "permissions"],
    ai: ["privacy", "ai"],
  },

  // Categories Firefox code may still link to, and where they live now.
  movedCategories: {
    paneSync: ["paneGeneral", null],
    paneHome: ["paneGeneral", null],
    paneSearch: ["paneGeneral", "searchSuggestions"],
    paneDownloads: ["paneGeneral", null],
    paneMoreFromMozilla: ["paneGeneral", null],
    paneExperimental: ["paneGeneral", null],
    paneAccessibility: ["paneAppearance", null],
  },

  getPanes(panes) {
    if (!this.enabled) {
      return panes;
    }

    let configs = {};
    for (let [id, config] of Object.entries(panes)) {
      let rootId = id;
      while (panes[rootId].parent) {
        rootId = panes[rootId].parent;
      }
      if (this.categories.includes(rootId) || rootId in this.subPanes) {
        configs[id] = { ...config, iconSrc: undefined, visible: () => true };
      }
    }
    for (let [id, [parent, name]] of Object.entries(this.subPanes)) {
      if (configs[id]) {
        configs[id] = {
          ...configs[id],
          parent,
          l10nId: `custom-ui-settings-${name}-heading`,
        };
      }
    }

    let module = this.module;
    configs.general = {
      l10nId: "custom-ui-settings-general-heading",
      groupIds: [
        "monoDefaultBrowser",
        "monoStartup",
        "monoDownloadFolder",
        "searchSuggestions",
        "monoGeneralLinks",
        "importBrowserData",
      ],
      module,
      visible: () => true,
    };
    configs.appearance = {
      ...configs.appearance,
      l10nId: "custom-ui-settings-appearance-heading",
      groupIds: ["monoTheme", "zoom", "fonts", "contrast"],
      module,
    };
    configs.tabsBrowsing = {
      ...configs.tabsBrowsing,
      l10nId: "custom-ui-settings-tabs-heading",
      groupIds: [
        "monoTabGroups",
        "monoContainers",
        "monoPageNavigation",
        "keyboardAndScrolling",
        "motionAndLink",
        "media",
        "performance",
      ],
      module,
    };
    configs.fold = {
      l10nId: "custom-ui-settings-fold-heading",
      groupIds: ["monoFold"],
      module,
      visible: () => true,
    };
    configs.connect = {
      l10nId: "custom-ui-settings-connect-heading",
      groupIds: ["monoConnect"],
      module,
      visible: () => true,
    };
    configs.privacy = {
      ...configs.privacy,
      l10nId: "custom-ui-settings-privacy-heading",
      groupIds: [...configs.privacy.groupIds, "monoPrivacyLinks"],
    };
    this.panes = configs;
    return configs;
  },

  resolveCategory(category, subcategory) {
    if (!this.enabled || category === "paneSearchResults") {
      return { category, subcategory };
    }
    let moved = this.movedCategories[category];
    if (moved) {
      let importing = [
        "importBrowserData",
        "migrate",
        "migrate-autoclose",
      ].includes(subcategory);
      [category, subcategory] = importing
        ? ["paneGeneral", "importBrowserData"]
        : moved;
    }
    let id = category[4].toLowerCase() + category.slice(5);
    if (!this.panes?.[id]) {
      return { category: "paneGeneral", subcategory: null };
    }
    return { category, subcategory };
  },

  /**
   * Adds Mono's styles for the parts of a Firefox widget that CSS outside its
   * shadow root can't reach.
   *
   * @param {HTMLElement} element A Lit element.
   */
  async styleShadow(element) {
    await customElements.whenDefined(element.localName);
    await element.updateComplete;
    if (
      !element.shadowRoot ||
      element.shadowRoot.querySelector(".mono-shadow")
    ) {
      return;
    }
    let stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.className = "mono-shadow";
    stylesheet.href =
      "chrome://browser/content/preferences/custom-ui/navigation.css";
    element.shadowRoot.append(stylesheet);
  },

  /**
   * The category in the navigation that a pane belongs to.
   *
   * @param {string} id A pane's friendly id.
   * @returns {string}
   */
  categoryOf(id) {
    while (this.panes[id]?.parent) {
      id = this.panes[id].parent;
    }
    return id;
  },

  initialize() {
    if (!this.enabled) {
      return;
    }
    document.l10n.setAttributes(
      document.querySelector("title"),
      "custom-ui-settings-title"
    );
    // Groups are reshaped for Mono before any pane renders them.
    ChromeUtils.importESModule(this.module, { global: "current" });
    let navigation = document.getElementById("categories");
    document.l10n.setAttributes(navigation, "custom-ui-settings-navigation");
    // Sub-pages keep the hidden buttons they make for themselves; Firefox's
    // own buttons give way to one button per Mono category.
    for (let button of navigation.querySelectorAll(
      "moz-page-nav-button[view]:not(.hidden-category)"
    )) {
      button.remove();
    }
    let addons = document.getElementById("addonsButton");
    for (let id of this.categories) {
      let button = document.createElement("moz-page-nav-button");
      button.id = `category-${id}`;
      button.setAttribute("view", `pane${id[0].toUpperCase()}${id.slice(1)}`);
      button.setAttribute("iconsrc", this.iconSrc(id));
      document.l10n.setAttributes(
        button,
        `custom-ui-settings-${id == "tabsBrowsing" ? "tabs" : id}-navigation`
      );
      navigation.insertBefore(button, addons);
      this.styleShadow(button);
    }
    addons.setAttribute("iconsrc", this.iconSrc("extensions"));
    this.styleShadow(addons);
    document.l10n.setAttributes(
      addons,
      "custom-ui-settings-extensions-navigation"
    );
    document.getElementById("nav-separator").remove();
    document.getElementById("helpButton").remove();
    // A sub-page keeps its category marked in the navigation.
    document.addEventListener("paneshown", event => {
      let { category } = event.detail;
      let current =
        category == "paneSearchResults"
          ? null
          : this.categoryOf(category[4].toLowerCase() + category.slice(5));
      for (let id of this.categories) {
        document
          .getElementById(`category-${id}`)
          ?.toggleAttribute("custom-current", id == current);
      }
    });
    let searchInput = document.getElementById("searchInput");
    searchInput.slot = "subheading";
    document.getElementById("categories").append(searchInput);
    for (let template of document.querySelectorAll(
      "#mainPrefPane > template"
    )) {
      template.setAttribute("data-hidden-from-search", "true");
    }
  },
};

(() => {
  const PREF = "browser.customUI.enabled";
  const THEME_PREF = "browser.customUI.theme";
  const enabledAtLoad = MonoPreferences.enabled;

  function applyCustomUI(doc) {
    doc.documentElement?.toggleAttribute(
      "custom-ui",
      Services.prefs.getBoolPref(PREF, false)
    );
    doc.documentElement?.setAttribute(
      "custom-theme",
      Services.prefs.getStringPref(THEME_PREF, "mono")
    );
  }

  function syncCustomUI() {
    if (MonoPreferences.enabled !== enabledAtLoad) {
      window.location.reload();
      return;
    }
    applyCustomUI(document);
    document
      .getElementById("categories")
      ?.toggleAttribute(
        "custom-ui",
        document.documentElement.hasAttribute("custom-ui")
      );
    for (let frame of document.querySelectorAll("#dialogStack .dialogFrame")) {
      if (frame.contentDocument) {
        applyCustomUI(frame.contentDocument);
      }
    }
  }

  syncCustomUI();
  Services.prefs.addObserver(PREF, syncCustomUI);
  Services.prefs.addObserver(THEME_PREF, syncCustomUI);
  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(PREF, syncCustomUI);
      Services.prefs.removeObserver(THEME_PREF, syncCustomUI);
    },
    { once: true }
  );
  window.addEventListener(
    "DOMFrameContentLoaded",
    event => {
      let frame = event.target;
      if (
        frame.matches?.("#dialogStack .dialogFrame") &&
        frame.contentDocument
      ) {
        applyCustomUI(frame.contentDocument);
      }
    },
    true
  );
  window.addEventListener(
    "DOMContentLoaded",
    async () => {
      syncCustomUI();
      if (!MonoPreferences.enabled) {
        return;
      }
      await customElements.whenDefined("moz-page-nav");
      MonoPreferences.styleShadow(document.getElementById("categories"));
      // Panes render their groups as they are first shown.
      new MutationObserver(records => {
        for (let record of records) {
          for (let node of record.addedNodes) {
            let cards =
              node.localName == "security-privacy-card"
                ? [node]
                : (node.querySelectorAll?.("security-privacy-card") ?? []);
            for (let card of cards) {
              MonoPreferences.styleShadow(card);
            }
          }
        }
      }).observe(document.getElementById("mainPrefPane"), {
        childList: true,
        subtree: true,
      });
      for (let card of document.querySelectorAll("security-privacy-card")) {
        MonoPreferences.styleShadow(card);
      }
    },
    { once: true }
  );
})();
