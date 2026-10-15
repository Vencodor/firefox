/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

(() => {
  const PREF = "browser.customUI.enabled";

  function applyCustomUI(doc) {
    doc.documentElement?.toggleAttribute(
      "custom-ui",
      Services.prefs.getBoolPref(PREF, false)
    );
  }

  function syncCustomUI() {
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
