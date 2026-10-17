/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Fold: "resource:///modules/fold/Fold.sys.mjs",
});

/**
 * Passes a page's site menu to the window showing that page, and tells a
 * newly loaded page whether its tab shows the site menu.
 */
export class FoldParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    let browser = this.browsingContext.top.embedderElement;
    switch (name) {
      case "Fold:Wanted":
        return !!browser && lazy.Fold.isWanted(browser);
      case "Fold:Update":
        browser?.ownerGlobal?.CustomFoldUI?.onUpdate(
          browser,
          data?.model ?? null
        );
        break;
    }
    return null;
  }
}
