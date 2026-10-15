/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(async function () {
  await TestUtils.waitForCondition(
    () => window.CustomBrowserUI?.enabled,
    "Custom browser UI has initialized"
  );
  await SidebarController.waitUntilStable();
  await TestUtils.waitForCondition(
    () => gBrowser.tabContainer.getAttribute("orient") === "vertical",
    "The native tab strip is vertical"
  );
  registerCleanupFunction(() => {
    window.CustomBrowserUI.setPanelOpen(false, false);
    gURLBar.view.close();
    gBrowser.selectedBrowser.focus();
  });
});

add_task(async function test_basic_browser_layout() {
  await BrowserTestUtils.withNewTab("about:mozilla", async () => {
    let sidebar = document
      .getElementById("sidebar-container")
      .getBoundingClientRect();
    let navigation = document
      .getElementById("navigator-toolbox")
      .getBoundingClientRect();
    let page = document
      .getElementById("tabbrowser-tabbox")
      .getBoundingClientRect();
    Assert.lessOrEqual(
      sidebar.top,
      navigation.top,
      "The sidebar starts at the top of the window"
    );
    Assert.greaterOrEqual(
      navigation.left,
      sidebar.right - 1,
      "Navigation starts after the sidebar"
    );
    Assert.greaterOrEqual(
      page.top,
      navigation.bottom - 1,
      "The page starts below navigation"
    );
    Assert.lessOrEqual(
      Math.abs(page.right - window.innerWidth),
      20,
      "The page fills the window apart from the outer margin"
    );
    let input = gURLBar.inputField;
    let inputRect = input.getBoundingClientRect();
    let target = document.elementFromPoint(
      inputRect.x + inputRect.width / 2,
      inputRect.y + inputRect.height / 2
    );
    ok(input.contains(target), "The navigation input receives pointer events");
    ok(
      BrowserTestUtils.isVisible(
        document.getElementById("custom-sidebar-header")
      ),
      "The basic sidebar header is visible"
    );
  });
});

add_task(async function test_blank_homepage_uses_main_screen() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.startup.homepage", "about:blank"]],
  });
  try {
    await BrowserTestUtils.withNewTab(HomePage.get(window), async () => {
      await TestUtils.waitForCondition(
        () => document.documentElement.hasAttribute("custom-newtab"),
        "The normalized blank homepage displays the main search screen"
      );
      ok(
        BrowserTestUtils.isVisible(
          document.getElementById("custom-newtab-logo")
        ),
        "The main screen logo is visible on the configured startup homepage"
      );
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_newtab_search_and_navigation() {
  await BrowserTestUtils.withNewTab("about:newtab", async browser => {
    let root = document.documentElement;
    await TestUtils.waitForCondition(
      () => root.hasAttribute("custom-newtab"),
      "An empty new tab uses the centered native address field"
    );
    ok(
      BrowserTestUtils.isVisible(document.getElementById("custom-newtab-logo")),
      "The temporary brand icon is visible"
    );
    ok(
      BrowserTestUtils.isHidden(document.getElementById("back-button")),
      "New tabs hide the navigation controls"
    );
    let page = document
      .getElementById("tabbrowser-tabbox")
      .getBoundingClientRect();
    let search = gURLBar.getBoundingClientRect();
    Assert.lessOrEqual(
      Math.abs(search.x + search.width / 2 - page.x - page.width / 2),
      2,
      "The real address field is horizontally centered in the page"
    );
    Assert.lessOrEqual(
      Math.abs(search.y + search.height / 2 - page.y - page.height / 2),
      2,
      "The search card is vertically centered in the page"
    );
    let input = gURLBar.inputField.getBoundingClientRect();
    is(
      document.elementFromPoint(
        input.x + input.width / 2,
        input.y + input.height / 2
      ),
      gURLBar.inputField,
      "The decoration does not intercept search input"
    );

    EventUtils.synthesizeKey("l", { accelKey: true });
    await TestUtils.waitForCondition(
      () => document.activeElement === gURLBar.inputField,
      "The address shortcut finishes transferring focus from content"
    );
    is(
      document.activeElement,
      gURLBar.inputField,
      "Ctrl+L focuses native search"
    );
    EventUtils.sendString("about:robots");
    let loaded = BrowserTestUtils.browserLoaded(browser, false, "about:robots");
    EventUtils.synthesizeKey("KEY_Enter");
    await loaded;
    ok(
      !root.hasAttribute("custom-newtab"),
      "Navigating restores the normal layout"
    );
    ok(
      BrowserTestUtils.isVisible(document.getElementById("back-button")),
      "Navigation controls return on a page"
    );

    await BrowserTestUtils.withNewTab("about:newtab", async () => {
      let newTab = gBrowser.selectedTab;
      await BrowserTestUtils.switchTab(
        gBrowser,
        gBrowser.getTabForBrowser(browser)
      );
      ok(
        !root.hasAttribute("custom-newtab"),
        "Selecting a page restores navigation"
      );
      await BrowserTestUtils.switchTab(gBrowser, newTab);
      ok(
        root.hasAttribute("custom-newtab"),
        "Selecting the new tab restores search"
      );
    });
  });
});

add_task(async function test_panel_controls_and_keyboard() {
  let panel = document.getElementById("custom-ai-panel");
  let closeButton = document.getElementById("custom-ai-close");
  let page = document.getElementById("tabbrowser-tabbox");

  ok(BrowserTestUtils.isHidden(panel), "The assistant starts closed");
  ok(
    document.getElementById("custom-ai-pause").disabled,
    "Pause is unavailable"
  );
  ok(document.getElementById("custom-ai-stop").disabled, "Stop is unavailable");

  let pageWidth = page.getBoundingClientRect().width;
  window.CustomBrowserUI.setPanelOpen(true);
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(panel),
    "The assistant can be opened programmatically"
  );
  Assert.lessOrEqual(
    Math.abs(page.getBoundingClientRect().width - pageWidth),
    1,
    "Opening the floating card preserves the page width"
  );
  is(document.activeElement, closeButton, "Focus enters the panel");

  EventUtils.synthesizeMouseAtCenter(closeButton, {});
  ok(BrowserTestUtils.isHidden(panel), "The close button closes the assistant");
  is(
    document.activeElement,
    gBrowser.selectedBrowser,
    "Closing returns focus to the page"
  );

  window.CustomBrowserUI.setPanelOpen(true);
  await TestUtils.waitForCondition(
    () => document.activeElement === closeButton,
    "Focus enters the reopened panel"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  ok(BrowserTestUtils.isHidden(panel), "Escape closes the assistant");
  is(
    document.activeElement,
    gBrowser.selectedBrowser,
    "Escape returns focus to the page"
  );
});

add_task(async function test_window_state_and_pref_toggle() {
  let panel = document.getElementById("custom-ai-panel");
  window.CustomBrowserUI.setPanelOpen(true);
  let newWindow = await BrowserTestUtils.openNewBrowserWindow();
  let prefEnvPushed = false;
  try {
    await TestUtils.waitForCondition(
      () => newWindow.CustomBrowserUI?.enabled,
      "The new window initializes its custom UI"
    );
    await newWindow.SidebarController.waitUntilStable();
    let newPanel = newWindow.document.getElementById("custom-ai-panel");
    ok(
      BrowserTestUtils.isVisible(panel),
      "The original window keeps its open panel"
    );
    ok(
      BrowserTestUtils.isHidden(newPanel),
      "A new window starts with its own closed panel"
    );

    newWindow.CustomBrowserUI.setPanelOpen(true);
    ok(
      BrowserTestUtils.isVisible(newPanel),
      "The second window can open its panel"
    );
    EventUtils.synthesizeMouseAtCenter(
      newWindow.document.getElementById("custom-ai-close"),
      {},
      newWindow
    );
    ok(
      BrowserTestUtils.isHidden(newPanel),
      "The second window closes its own panel"
    );
    ok(
      BrowserTestUtils.isVisible(panel),
      "Closing another window's panel leaves this one open"
    );

    await SpecialPowers.pushPrefEnv({
      set: [["browser.customUI.enabled", false]],
    });
    prefEnvPushed = true;
    for (let win of [window, newWindow]) {
      await TestUtils.waitForCondition(
        () => !win.CustomBrowserUI.enabled,
        "The window responds to disabling custom UI"
      );
      ok(
        BrowserTestUtils.isHidden(
          win.document.getElementById("custom-ai-panel")
        ),
        "Disabling custom UI closes the assistant"
      );
      ok(
        BrowserTestUtils.isHidden(
          win.document.getElementById("custom-sidebar-header")
        ),
        "Disabling custom UI hides its sidebar header"
      );
    }

    await SpecialPowers.popPrefEnv();
    prefEnvPushed = false;
    for (let win of [window, newWindow]) {
      await TestUtils.waitForCondition(
        () => win.CustomBrowserUI.enabled,
        "The window responds to enabling custom UI"
      );
      ok(
        BrowserTestUtils.isVisible(
          win.document.getElementById("custom-sidebar-header")
        ),
        "Enabling custom UI restores the sidebar header"
      );
      ok(
        BrowserTestUtils.isHidden(
          win.document.getElementById("custom-ai-panel")
        ),
        "Enabling custom UI keeps the assistant closed"
      );
    }
  } finally {
    if (prefEnvPushed) {
      await SpecialPowers.popPrefEnv();
    }
    window.CustomBrowserUI.setPanelOpen(false, false);
    await BrowserTestUtils.closeWindow(newWindow);
  }
});

add_task(async function test_native_tabs_and_sidebar_toggle() {
  let originalExpanded = SidebarController.sidebarMain.expanded;
  let tabs = [];
  try {
    let newTabPromise = BrowserTestUtils.waitForNewTab(gBrowser);
    EventUtils.synthesizeMouseAtCenter(
      document.getElementById("tabs-newtab-button"),
      {}
    );
    tabs.push(await newTabPromise);
    tabs.push(
      await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank")
    );
    let [firstTab, secondTab] = tabs;
    let verticalTabs = document.getElementById("vertical-tabs");
    ok(
      verticalTabs.contains(firstTab),
      "New tabs use the native vertical tab strip"
    );
    is(gBrowser.selectedTab, secondTab, "Opening a tab selects it");

    EventUtils.synthesizeMouseAtCenter(firstTab, {});
    await TestUtils.waitForCondition(
      () => gBrowser.selectedTab === firstTab,
      "Clicking a native tab selects it"
    );
    gBrowser.pinTab(firstTab);
    ok(firstTab.pinned, "Native tabs can be pinned");
    is(gBrowser.selectedTab, firstTab, "Pinning keeps the selected tab");
    gBrowser.unpinTab(firstTab);
    ok(!firstTab.pinned, "Native tabs can be unpinned");
    gBrowser.moveTabTo(firstTab, { tabIndex: gBrowser.tabs.length - 1 });
    is(
      gBrowser.tabs[gBrowser.tabs.length - 1],
      firstTab,
      "Native tabs can change order"
    );

    window.CustomBrowserUI.setPanelOpen(true);
    await SidebarController.handleToolbarButtonClick();
    await SidebarController.waitUntilStable();
    is(
      SidebarController.sidebarMain.expanded,
      !originalExpanded,
      "The existing sidebar command toggles its expanded state"
    );
    ok(
      verticalTabs.contains(firstTab),
      "Collapsing keeps the native tab strip"
    );
    ok(
      BrowserTestUtils.isVisible(document.getElementById("custom-ai-panel")),
      "Sidebar state is independent of the assistant panel"
    );

    await BrowserTestUtils.removeTab(firstTab);
    ok(!firstTab.isConnected, "Native tabs can be closed");
    is(
      gBrowser.selectedTab,
      secondTab,
      "Closing the selected tab selects the remaining tab"
    );
  } finally {
    window.CustomBrowserUI.setPanelOpen(false, false);
    if (SidebarController.sidebarMain.expanded !== originalExpanded) {
      await SidebarController.handleToolbarButtonClick();
      await SidebarController.waitUntilStable();
    }
    for (let tab of tabs) {
      if (tab.isConnected) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  }
});

add_task(async function test_tab_strip_design() {
  let originalExpanded = SidebarController.sidebarMain.expanded;
  let tabs = [];
  let group;
  try {
    if (!originalExpanded) {
      await SidebarController.handleToolbarButtonClick();
      await SidebarController.waitUntilStable();
    }
    ok(
      !document.getElementById("custom-drift"),
      "The sidebar has no drifted tabs section"
    );

    for (let i = 0; i < 5; i++) {
      tabs.push(
        await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank")
      );
    }
    let newTabButton = document.getElementById("tabs-newtab-button");
    await TestUtils.waitForCondition(
      () => newTabButton.getAttribute("label") === "새 탭",
      "The new tab item uses the sidebar label"
    );
    ok(
      BrowserTestUtils.isVisible(newTabButton),
      "The new tab item is part of the tab list"
    );
    Assert.greaterOrEqual(
      newTabButton.getBoundingClientRect().top,
      tabs.at(-1).getBoundingClientRect().bottom - 1,
      "The new tab item follows the last tab"
    );

    for (let tab of tabs.slice(0, 3)) {
      gBrowser.pinTab(tab);
    }
    let [first, second, third] = tabs
      .slice(0, 3)
      .map(tab => tab.getBoundingClientRect());
    Assert.lessOrEqual(
      Math.abs(first.top - second.top),
      1,
      "Two pinned tiles share a row"
    );
    Assert.less(first.left, second.left, "Pinned tiles sit side by side");
    Assert.greater(first.width, 80, "Pinned tiles fill their column");
    Assert.greaterOrEqual(
      third.top,
      first.bottom - 1,
      "A third pinned tile starts a new row"
    );

    group = gBrowser.addTabGroup(tabs.slice(3), { label: "test" });
    let count;
    await TestUtils.waitForCondition(() => {
      count = group.querySelector(".custom-tab-group-count");
      return count?.textContent === "2";
    }, "The group header shows its tab count");
    ok(BrowserTestUtils.isVisible(count), "The tab count is visible");
    let icons = group.querySelector(".custom-tab-group-icons");
    ok(BrowserTestUtils.isHidden(icons), "An open group hides its favicons");

    await BrowserTestUtils.switchTab(gBrowser, tabs[0]);
    group.collapsed = true;
    ok(BrowserTestUtils.isVisible(icons), "A collapsed group shows favicons");
    is(
      icons.querySelectorAll(".custom-tab-group-icon:not([hidden])").length,
      2,
      "Each grouped tab adds one favicon"
    );
  } finally {
    if (group?.isConnected) {
      await gBrowser.removeTabGroup(group);
    }
    for (let tab of tabs) {
      if (tab.isConnected) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    if (SidebarController.sidebarMain.expanded !== originalExpanded) {
      await SidebarController.handleToolbarButtonClick();
      await SidebarController.waitUntilStable();
    }
  }
});
