/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Passes changes of a page's site menu to the window showing that page.
 */
export class SiteSidebarParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name != "SiteSidebar:Update") {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    browser?.ownerGlobal?.CustomSiteSidebarUI?.onUpdate(
      browser,
      data?.model ?? null
    );
  }
}
