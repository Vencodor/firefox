/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  cleanModel: "resource:///modules/fold/Fold.sys.mjs",
});

/**
 * Passes changes of a page's site menu, and a newly loaded page being ready
 * to be read, to the window showing that page.
 */
export class FoldParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    let browser = this.browsingContext.top.embedderElement;
    let ui = browser?.ownerGlobal?.CustomFoldUI;
    switch (name) {
      case "Fold:Update":
        ui?.onUpdate(browser, lazy.cleanModel(data?.model));
        break;
      case "Fold:Ready":
        ui?.onPageReady(browser);
        break;
    }
    return null;
  }
}
