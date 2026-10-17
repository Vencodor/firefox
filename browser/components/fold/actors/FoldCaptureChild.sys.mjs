/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  capturePage: "resource:///modules/fold/FoldCapture.sys.mjs",
  findRule: "resource:///modules/fold/FoldRules.sys.mjs",
});

/**
 * Captures a page's navigation for Tools > Capture Fold. On a page whose
 * sidebar Fold hides, the sidebar is shown while it's measured.
 */
export class FoldCaptureChild extends JSWindowActorChild {
  receiveMessage({ name }) {
    if (name != "FoldCapture:Capture") {
      return null;
    }
    let capture = () =>
      lazy.capturePage(this.contentWindow, lazy.findRule(this.document.URL));
    let fold = this.manager.getExistingActor("Fold");
    return fold ? fold.withSidebarShown(capture) : capture();
  }
}
