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
  });
});

add_task(async function test_basic_browser_layout() {
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

add_task(async function test_panel_controls_and_keyboard() {
  let panel = document.getElementById("custom-ai-panel");
  let button = document.getElementById("custom-ai-button");
  let closeButton = document.getElementById("custom-ai-close");
  let page = document.getElementById("tabbrowser-tabbox");

  ok(BrowserTestUtils.isHidden(panel), "The assistant starts closed");
  is(
    button.getAttribute("aria-expanded"),
    "false",
    "The button starts collapsed"
  );
  ok(BrowserTestUtils.isVisible(button), "The assistant button is available");
  ok(
    document.getElementById("custom-ai-pause").disabled,
    "Pause is unavailable"
  );
  ok(document.getElementById("custom-ai-stop").disabled, "Stop is unavailable");

  let pageWidth = page.getBoundingClientRect().width;
  EventUtils.synthesizeMouseAtCenter(button, {});
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(panel),
    "The assistant opens from its button"
  );
  Assert.lessOrEqual(
    Math.abs(page.getBoundingClientRect().width - pageWidth),
    1,
    "Opening the floating card preserves the page width"
  );
  is(
    button.getAttribute("aria-expanded"),
    "true",
    "The button reflects the open panel"
  );
  is(document.activeElement, closeButton, "Focus enters the panel");

  EventUtils.synthesizeMouseAtCenter(closeButton, {});
  ok(BrowserTestUtils.isHidden(panel), "The close button closes the assistant");
  is(
    document.activeElement,
    button,
    "Closing returns focus to the assistant button"
  );

  EventUtils.synthesizeMouseAtCenter(button, {});
  await TestUtils.waitForCondition(
    () => document.activeElement === closeButton,
    "Focus enters the reopened panel"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  ok(BrowserTestUtils.isHidden(panel), "Escape closes the assistant");
  is(
    button.getAttribute("aria-expanded"),
    "false",
    "Escape updates the button state"
  );
  is(
    document.activeElement,
    button,
    "Escape returns focus to the assistant button"
  );
});

add_task(async function test_window_state_and_pref_toggle() {
  let panel = document.getElementById("custom-ai-panel");
  let button = document.getElementById("custom-ai-button");
  EventUtils.synthesizeMouseAtCenter(button, {});
  let newWindow = await BrowserTestUtils.openNewBrowserWindow();
  let prefEnvPushed = false;
  try {
    await TestUtils.waitForCondition(
      () => newWindow.CustomBrowserUI?.enabled,
      "The new window initializes its custom UI"
    );
    await newWindow.SidebarController.waitUntilStable();
    let newPanel = newWindow.document.getElementById("custom-ai-panel");
    let newButton = newWindow.document.getElementById("custom-ai-button");
    ok(
      BrowserTestUtils.isVisible(panel),
      "The original window keeps its open panel"
    );
    ok(
      BrowserTestUtils.isHidden(newPanel),
      "A new window starts with its own closed panel"
    );

    EventUtils.synthesizeMouseAtCenter(newButton, {}, newWindow);
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
          win.document.getElementById("custom-sidebar-footer")
        ),
        "Disabling custom UI hides its sidebar controls"
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
          win.document.getElementById("custom-sidebar-footer")
        ),
        "Enabling custom UI restores the sidebar controls"
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
      document.getElementById("custom-sidebar-newtab"),
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

    EventUtils.synthesizeMouseAtCenter(
      document.getElementById("custom-ai-button"),
      {}
    );
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
