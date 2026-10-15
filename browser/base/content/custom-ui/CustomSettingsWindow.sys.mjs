/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const WINDOW_TYPE = "mono:settings";
const READY_EVENT = "MonoSettingsWindowReady";
let openingWindow = null;
let navigationRequest = 0;

function waitForWindow(win) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      win.removeEventListener(READY_EVENT, onReady);
      Services.obs.removeObserver(onClosed, "domwindowclosed");
    };
    const onReady = () => {
      win.delayedStartupPromise.then(() => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(win);
        }
      });
    };
    const onClosed = subject => {
      if (subject == win && !settled) {
        settled = true;
        cleanup();
        reject(new Error("The settings window closed before startup finished"));
      }
    };
    win.addEventListener(READY_EVENT, onReady, { once: true });
    Services.obs.addObserver(onClosed, "domwindowclosed");
    if (win.CustomSettingsWindowController?.ready) {
      onReady();
    }
  });
}

export const CustomSettingsWindow = {
  async open(paneID, extraArgs) {
    const request = ++navigationRequest;
    let win = Services.wm.getMostRecentWindow(WINDOW_TYPE);
    if (openingWindow) {
      win = await openingWindow;
    } else if (!win || win.closed) {
      const args = Cc["@mozilla.org/array;1"].createInstance(
        Ci.nsIMutableArray
      );
      const initialURL = Cc["@mozilla.org/supports-string;1"].createInstance(
        Ci.nsISupportsString
      );
      initialURL.data = "";
      const options = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
        Ci.nsIWritablePropertyBag2
      );
      options.setPropertyAsBool("custom-settings-window", true);
      args.appendElement(initialURL);
      args.appendElement(options);

      win = Services.ww.openWindow(
        null,
        AppConstants.BROWSER_CHROME_URL,
        "_blank",
        "chrome,dialog=no,resizable,centerscreen,non-private,toolbar=no,location=no,menubar=no,status=no,width=1100,height=800",
        args
      );
      const pending = waitForWindow(win);
      openingWindow = pending;
      const clearPending = () => {
        if (openingWindow == pending) {
          openingWindow = null;
        }
      };
      pending.then(clearPending, clearPending);
      win = await pending;
    } else {
      win = await waitForWindow(win);
    }

    if (request == navigationRequest) {
      win.CustomSettingsWindowController.navigate(paneID, extraArgs);
    }
    if (win.windowState == win.STATE_MINIMIZED) {
      win.restore();
    }
    win.focus();
    return win;
  },
};
