/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  capturePage: "resource:///modules/fold/FoldCapture.sys.mjs",
  findRule: "resource:///modules/fold/FoldRules.sys.mjs",
  measureFold: "resource:///modules/fold/FoldCapture.sys.mjs",
});

/**
 * Captures a page's navigation for Tools > Capture Fold. On a page with a
 * site rule, the sidebar is shown while it's read, and the page is measured
 * folded too.
 */
export class FoldCaptureChild extends JSWindowActorChild {
  receiveMessage({ name }) {
    if (name != "FoldCapture:Capture") {
      return null;
    }
    let window = this.contentWindow;
    let rule = lazy.findRule(this.document.URL);
    let fold = rule && this.manager.getExistingActor("Fold");
    if (!fold) {
      return lazy.capturePage(window, rule);
    }
    let capture = fold.withSheet(false, () => lazy.capturePage(window, rule));
    if (capture.rule) {
      capture.rule.folded = fold.withSheet(true, () =>
        lazy.measureFold(window, rule)
      );
    }
    return capture;
  }
}
