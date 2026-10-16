/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var MonoPreferences = {
  get enabled() {
    return Services.prefs.getBoolPref("browser.customUI.enabled", false);
  },

  getPanes(panes) {
    if (!this.enabled) {
      return panes;
    }

    const retained = new Set([
      "general",
      "search",
      "privacy",
      "passwordsAutofill",
      "downloads",
      "languages",
      "ai",
      "permissionsData",
      "moreFromMozilla",
    ]);
    let configs = {};
    for (let [id, config] of Object.entries(panes)) {
      let rootId = id;
      while (panes[rootId].parent) {
        rootId = panes[rootId].parent;
      }
      if (retained.has(rootId)) {
        configs[id] = { ...config, visible: () => true };
      }
    }

    const module =
      "chrome://browser/content/preferences/custom-ui/settings-config.mjs";
    configs.general = {
      l10nId: "custom-ui-settings-general-heading",
      iconSrc: "chrome://browser/skin/preferences/category-general.svg",
      groupIds: ["monoDefaultBrowser", "monoStartup", "importBrowserData"],
      module,
      visible: () => true,
    };
    configs.search = {
      ...configs.search,
      l10nId: "custom-ui-settings-search-heading",
      groupIds: ["searchSuggestions"],
    };
    configs.downloads = {
      ...configs.downloads,
      l10nId: "custom-ui-settings-downloads-heading",
      groupIds: ["monoDownloadFolder"],
      module,
    };
    configs.moreFromMozilla = {
      ...configs.moreFromMozilla,
      l10nId: "custom-ui-settings-about-heading",
      iconSrc:
        "chrome://browser/content/custom-ui/resources/mono/logo/mono-glyph-small.svg",
      groupIds: ["monoAbout"],
      module,
    };
    this.panes = configs;
    return configs;
  },

  resolveCategory(category, subcategory) {
    if (!this.enabled) {
      return { category, subcategory };
    }
    if (category === "paneSearchResults") {
      return { category, subcategory };
    }
    if (category === "paneSync" || category === "paneHome") {
      category = "paneGeneral";
      subcategory = [
        "importBrowserData",
        "migrate",
        "migrate-autoclose",
      ].includes(subcategory)
        ? "importBrowserData"
        : null;
    }
    let id = category[4].toLowerCase() + category.slice(5);
    if (!this.panes?.[id]) {
      return { category: "paneGeneral", subcategory: null };
    }
    if (["general", "search", "downloads", "moreFromMozilla"].includes(id)) {
      const anchors = {
        general: new Set(["importBrowserData"]),
        search: new Set(["searchSuggestions"]),
      };
      if (!anchors[id]?.has(subcategory)) {
        subcategory = null;
      }
    }
    return { category, subcategory };
  },

  initialize() {
    if (!this.enabled) {
      return;
    }
    document.l10n.setAttributes(
      document.querySelector("title"),
      "custom-ui-settings-title"
    );
    document.l10n.setAttributes(
      document.getElementById("categories"),
      "custom-ui-settings-navigation"
    );
    for (let button of document.querySelectorAll(
      "#categories moz-page-nav-button[view]"
    )) {
      const category = button.getAttribute("view");
      const id = category[4].toLowerCase() + category.slice(5);
      if (!this.panes[id]) {
        button.remove();
      }
    }
    for (let [id, l10nId] of [
      ["category-general", "custom-ui-settings-general-navigation"],
      ["category-search", "custom-ui-settings-search-navigation"],
      ["category-downloads", "custom-ui-settings-downloads-navigation"],
      ["category-more-from-mozilla", "custom-ui-settings-about-navigation"],
    ]) {
      document.l10n.setAttributes(document.getElementById(id), l10nId);
    }
    document.getElementById("nav-separator").remove();
    document.getElementById("helpButton").remove();
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
  const enabledAtLoad = MonoPreferences.enabled;

  function applyCustomUI(doc) {
    doc.documentElement?.toggleAttribute(
      "custom-ui",
      Services.prefs.getBoolPref(PREF, false)
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
  window.addEventListener(
    "unload",
    () => Services.prefs.removeObserver(PREF, syncCustomUI),
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
      await customElements.whenDefined("moz-page-nav");
      let navigation = document.getElementById("categories");
      await navigation.updateComplete;
      let stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href =
        "chrome://browser/content/preferences/custom-ui/navigation.css";
      navigation.shadowRoot.append(stylesheet);
    },
    { once: true }
  );
})();
