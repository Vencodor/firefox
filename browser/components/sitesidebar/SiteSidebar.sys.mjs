/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  allMatches: "resource:///modules/sitesidebar/SiteSidebarRules.sys.mjs",
  findRule: "resource:///modules/sitesidebar/SiteSidebarRules.sys.mjs",
});

const ACTOR = "SiteSidebar";

let registered = false;

function getActor(browser) {
  try {
    return browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR);
  } catch {
    // The page doesn't match any site rule, or it's being torn down.
    return null;
  }
}

/**
 * The browser side of the site menu: which pages have a site rule, and the
 * messages that ask a page to show, update or act on its site menu.
 */
export const SiteSidebar = {
  ensureRegistered() {
    if (registered) {
      return;
    }
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: {
        esModuleURI: "resource:///actors/SiteSidebarParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///actors/SiteSidebarChild.sys.mjs",
        events: { pagehide: { createActor: false } },
      },
      matches: lazy.allMatches(),
      messageManagerGroups: ["browsers"],
    });
    registered = true;
  },

  /**
   * @param {nsIURI} uri
   * @returns {?{id: string, name: string}} The site rule for a page, if any.
   */
  ruleFor(uri) {
    let rule = lazy.findRule(uri?.spec);
    return rule ? { id: rule.id, name: rule.name } : null;
  },

  /**
   * Hides the page's sidebar and reads its site menu, waiting for the page to
   * render it.
   *
   * @param {Element} browser
   * @returns {Promise<?object>} The site menu model, or null when the page's
   *   sidebar couldn't be read and was left as it is.
   */
  async activate(browser) {
    let actor = getActor(browser);
    if (!actor) {
      return null;
    }
    try {
      let result = await actor.sendQuery("SiteSidebar:Activate");
      return result?.model ?? null;
    } catch {
      return null;
    }
  },

  deactivate(browser) {
    this.send(browser, "SiteSidebar:Deactivate");
  },

  refresh(browser) {
    this.send(browser, "SiteSidebar:Refresh");
  },

  /**
   * Clicks the page element behind an item.
   *
   * @param {Element} browser
   * @param {string} id The item id.
   * @param {string} [part] "secondary" for the item's toggle.
   */
  run(browser, id, part) {
    this.send(browser, "SiteSidebar:Run", { id, part });
  },

  send(browser, name, data) {
    try {
      getActor(browser)?.sendAsyncMessage(name, data);
    } catch {
      // The page went away.
    }
  },
};
