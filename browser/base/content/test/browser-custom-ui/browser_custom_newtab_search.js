/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  PlacesTestUtils: "resource://testing-common/PlacesTestUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(this, "UrlbarTestUtils", () => {
  const { UrlbarTestUtils: module } = ChromeUtils.importESModule(
    "resource://testing-common/UrlbarTestUtils.sys.mjs"
  );
  module.init(this);
  return module;
});

const QUERY = "mono newtab";

async function waitForNewTabSearch() {
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("custom-newtab"),
    "The empty new tab shows the search screen"
  );
}

add_setup(async function () {
  await TestUtils.waitForCondition(
    () => window.CustomBrowserUI?.enabled,
    "The custom UI has initialized"
  );
  await SidebarController.waitUntilStable();
  await PlacesTestUtils.addVisits({
    uri: "https://example.com/mono-newtab",
    title: QUERY,
  });
  registerCleanupFunction(async () => {
    gURLBar.view.close();
    gBrowser.selectedBrowser.focus();
    await PlacesUtils.history.clear();
  });
});

add_task(async function test_composer_layout() {
  await BrowserTestUtils.withNewTab("about:newtab", async () => {
    await waitForNewTabSearch();
    ok(
      !document.getElementById("custom-newtab-run"),
      "The search screen has no agent Run button"
    );
    ok(
      BrowserTestUtils.isHidden(
        document.getElementById("custom-sidebar-navigation")
      ),
      "The sidebar hides back, forward and reload on the search screen"
    );
    let background = gURLBar.querySelector(".urlbar-background");
    let closed = background.getBoundingClientRect();
    Assert.lessOrEqual(
      Math.abs(closed.height - 96),
      1,
      "The composer is 96px tall"
    );
    let goButton = gURLBar.querySelector(".urlbar-go-button");
    ok(
      BrowserTestUtils.isVisible(goButton),
      "The go button shows before anything is typed"
    );
    is(
      getComputedStyle(goButton).pointerEvents,
      "none",
      "The go button is inert until something is typed"
    );
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: QUERY,
      waitForFocus,
    });
    isnot(
      getComputedStyle(goButton).pointerEvents,
      "none",
      "The go button searches once something is typed"
    );
    let open = background.getBoundingClientRect();
    for (let side of ["top", "left", "width"]) {
      Assert.lessOrEqual(
        Math.abs(open[side] - closed[side]),
        1,
        `The composer keeps its ${side} while suggestions are shown`
      );
    }
    await UrlbarTestUtils.promisePopupClose(window);
  });
});

add_task(async function test_empty_input_opens_no_suggestions() {
  await BrowserTestUtils.withNewTab("about:newtab", async () => {
    await waitForNewTabSearch();
    gURLBar.focus();
    gURLBar.startQuery();
    let context = await gURLBar.lastQueryContextPromise;
    is(context.results.length, 0, "Nothing is suggested before typing");
    ok(!gURLBar.view.isOpen, "The suggestion list stays closed");
  });
});

add_task(async function test_typed_input_offers_searches_only() {
  await BrowserTestUtils.withNewTab("about:newtab", async () => {
    await waitForNewTabSearch();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: QUERY,
      waitForFocus,
    });
    let context = await gURLBar.lastQueryContextPromise;
    is(
      context.maxResults,
      (window.CustomAgentChatUI?.enabled ? 2 : 1) + 4,
      "At most four suggestions follow the typed search and the chat row"
    );
    let first = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
    ok(first.heuristic, "The first row is the typed text");
    ok(first.searchParams, "The first row searches for the typed text");
    for (let i = 1; i < UrlbarTestUtils.getResultCount(window); i++) {
      let details = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
      ok(
        details.searchParams ||
          details.result.payload.dynamicType == "mono-run",
        `Row ${i} is a search suggestion or the agent chat row`
      );
    }
    await UrlbarTestUtils.promisePopupClose(window);
  });
});

add_task(async function test_new_tab_from_page_shows_newtab_search() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    let root = document.documentElement;
    ok(!root.hasAttribute("custom-newtab"), "A page is not the search screen");
    let tabOpened = BrowserTestUtils.waitForNewTab(
      gBrowser,
      "about:newtab",
      true
    );
    EventUtils.synthesizeKey("t", { accelKey: true });
    let tab = await tabOpened;
    await waitForNewTabSearch();
    await TestUtils.waitForTick();
    ok(
      !root.hasAttribute("custom-address-open"),
      "The centered address editor is not left open over the new tab"
    );
    ok(!gURLBar.view.isOpen, "No suggestions are shown before typing");
    BrowserTestUtils.removeTab(tab);
  });
});
