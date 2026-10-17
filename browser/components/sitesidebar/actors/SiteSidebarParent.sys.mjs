/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SiteSidebar: "resource:///modules/sitesidebar/SiteSidebar.sys.mjs",
});

/**
 * Passes a page's site menu to the window showing that page, and tells a
 * newly loaded page whether its tab shows the site menu.
 */
export class SiteSidebarParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    let browser = this.browsingContext.top.embedderElement;
    switch (name) {
      case "SiteSidebar:Wanted":
        return !!browser && lazy.SiteSidebar.isWanted(browser);
      case "SiteSidebar:Update":
        browser?.ownerGlobal?.CustomSiteSidebarUI?.onUpdate(
          browser,
          data?.model ?? null
        );
        break;
    }
    return null;
  }
}
