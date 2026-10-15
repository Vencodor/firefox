/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarProviderHeuristicFallback:
    "moz-src:///browser/components/urlbar/UrlbarProviderHeuristicFallback.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "l10n", () => {
  return new Localization(["browser/customUI.ftl"], true);
});

const DYNAMIC_RESULT_TYPE = "mono-run";

function viewTemplate(selectable) {
  return {
    attributes: { selectable },
    children: [
      {
        name: "content",
        tag: "span",
        children: [
          {
            name: "icon",
            tag: "span",
            attributes: { class: "urlbarView-favicon" },
          },
          { name: "title", tag: "span" },
          { name: "pill", tag: "span" },
        ],
      },
    ],
  };
}

/**
 * Offers the typed text to the agent as the second suggestion. Without a
 * connected agent the row is shown but cannot be selected.
 */
export class UrlbarProviderMonoRun extends UrlbarProvider {
  get type() {
    return lazy.UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext, controller) {
    return (
      queryContext.sapName == "urlbar" &&
      !!queryContext.trimmedSearchString &&
      !queryContext.restrictInSearchMode() &&
      !!controller?.browserWindow?.CustomAgentUI?.enabled &&
      !lazy.UrlbarProviderHeuristicFallback.matchUnknownUrl(queryContext)
    );
  }

  startQuery(queryContext, addCallback, controller) {
    addCallback(
      this,
      new lazy.UrlbarResult({
        type: lazy.UrlbarShared.RESULT_TYPE.DYNAMIC,
        source: lazy.UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
        suggestedIndex: 1,
        payload: {
          dynamicType: DYNAMIC_RESULT_TYPE,
          query: queryContext.trimmedSearchString,
          available: !!controller.browserWindow.CustomAgentUI.canRun,
        },
      })
    );
  }

  getViewTemplate(result) {
    return viewTemplate(result.payload.available);
  }

  getViewUpdate(result) {
    let { query, available } = result.payload;
    return {
      content: { attributes: { "data-unavailable": !available } },
      title: { textContent: query },
      pill: {
        textContent: available
          ? "Run"
          : lazy.l10n.formatValueSync("custom-ui-run-row-unavailable"),
      },
    };
  }

  onEngagement(queryContext, controller, details) {
    let { query, available } = details.result.payload;
    if (available) {
      controller.browserWindow?.CustomAgentUI?.run(query);
    }
  }
}

let gProvider = null;

export function ensureRegistered() {
  let manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
  gProvider ??= new UrlbarProviderMonoRun();
  if (!manager.getProvider(gProvider.name)) {
    manager.registerProvider(gProvider);
  }
}
