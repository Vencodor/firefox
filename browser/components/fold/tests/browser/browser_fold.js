/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Fold } = ChromeUtils.importESModule(
  "resource:///modules/fold/Fold.sys.mjs"
);

const TEST_ROOT = getRootDirectory(gTestPath);
const TEST_URL =
  TEST_ROOT.replace("chrome://mochitests/content", "https://example.com") +
  "file_fold_site.html";

add_setup(async function () {
  let rule = await (await fetch(TEST_ROOT + "fold_test_rule.json")).json();
  Fold.setRulesForTests([rule]);
  // The menu docks whatever the test window's width.
  let ui = window.CustomFoldUI;
  let { minPageWidth } = ui;
  ui.minPageWidth = 0;
  registerCleanupFunction(() => {
    ui.minPageWidth = minPageWidth;
    Fold.setEnabledFor(rule.id, true);
    Fold.setRulesForTests(null);
  });
});

function pageState(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    let document = content.document;
    return {
      shownAtLoad: document.body.dataset.sidebarShownAtLoad,
      shown: document.getElementById("sidebar").checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
      }),
      mainX: document.getElementById("main").getBoundingClientRect().x,
    };
  });
}

function waitForPage(browser, condition) {
  return SpecialPowers.spawn(browser, [condition.toString()], source => {
    // eslint-disable-next-line no-new-func
    let test = new Function("document", `return (${source})(document);`);
    return ContentTaskUtils.waitForCondition(() => test(content.document));
  });
}

function menuRows() {
  return [...window.CustomFoldUI.menu.querySelectorAll(".custom-fold-row")];
}

function row(label) {
  return menuRows().find(element => element.textContent.includes(label));
}

add_task(async function test_folded_as_the_page_loads() {
  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    let state = await pageState(browser);
    is(state.shownAtLoad, "false", "The sidebar is concealed before it draws");
    ok(!state.shown, "The sidebar stays concealed");
    is(state.mainX, 0, "The content takes the sidebar's column");

    let loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserCommands.reload();
    await loaded;
    state = await pageState(browser);
    is(state.shownAtLoad, "false", "Reloading doesn't show the sidebar");
    ok(!state.shown, "The sidebar stays concealed after reloading");

    Fold.setEnabledFor("fold-test", false);
    await TestUtils.waitForCondition(
      async () => (await pageState(browser)).shown,
      "Turning Fold off for the site shows its sidebar"
    );
    Fold.setEnabledFor("fold-test", true);
    await TestUtils.waitForCondition(
      async () => !(await pageState(browser)).shown,
      "Turning Fold on again conceals it"
    );
  });
});

add_task(async function test_menu() {
  let ui = window.CustomFoldUI;
  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    await TestUtils.waitForCondition(
      () => ui.docked,
      "The site's menu docks beside the tab list"
    );
    await TestUtils.waitForCondition(
      () => row("Dark theme"),
      "The site's menu is read"
    );
    for (let label of [
      "New chat",
      "Home",
      "Explore",
      "First chat",
      "Second chat",
    ]) {
      ok(row(label), `The menu has ${label}`);
    }
    ok(!row("Recent"), "The section title isn't read as an item");
    ok(
      row("Account")?.closest(".custom-fold-pinned"),
      "The account link is pinned under the menu"
    );
    is(
      ui.menu.lastElementChild.className,
      "custom-fold-pinned",
      "The pinned sections come last"
    );
    ok(
      row("Home").classList.contains("custom-fold-current"),
      "Home is current"
    );

    row("Second chat").click();
    await TestUtils.waitForCondition(
      () => row("Second chat")?.classList.contains("custom-fold-current"),
      "The current item follows the page's in-page navigation"
    );

    row("Dark theme").click();
    await TestUtils.waitForCondition(
      () => row("Dark theme")?.getAttribute("aria-checked") == "true",
      "The toggle follows the page's checkbox"
    );

    let field = ui.menu.querySelector(".custom-fold-field");
    ok(field, "The search field is in the menu");
    field.focus();
    EventUtils.sendString("hello");
    EventUtils.synthesizeKey("KEY_Enter");
    await waitForPage(browser, doc => doc.body.dataset.searched == "hello");

    is(
      ui.menu.querySelectorAll(".custom-fold-more").length,
      2,
      "Both rows have a menu button, aria-haspopup on a wrapper included"
    );

    // A row's actions show while it's focused, as when it's hovered.
    row("First chat").focus();
    let more = ui.menu.querySelector(".custom-fold-more");
    let shown = BrowserTestUtils.waitForPopupEvent(ui.popup, "shown");
    more.click();
    await shown;
    Assert.deepEqual(
      [...ui.popup.children].map(item => item.getAttribute("label")),
      ["Rename", "Delete"],
      "The row's menu button shows the site's menu"
    );
    is(
      await SpecialPowers.spawn(
        browser,
        [],
        () => content.document.body.dataset.menuShownAtOpen
      ),
      "hidden",
      "The site's menu is concealed from the moment it opens"
    );
    let hidden = BrowserTestUtils.waitForPopupEvent(ui.popup, "hidden");
    ui.popup.activateItem(ui.popup.children[0]);
    await hidden;

    // Rename opens the site's dialog, which shows on the page as the site
    // draws it, from the moment it opens.
    await waitForPage(browser, doc =>
      doc.getElementById("rename").checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
      })
    );
    is(
      await SpecialPowers.spawn(
        browser,
        [],
        () => content.document.body.dataset.renameShownAtOpen
      ),
      "visible visible",
      "The site's dialog and its backdrop show on the page as they open"
    );
    ok(
      !document.getElementById("custom-fold-dialog"),
      "The site's dialog isn't moved into the sidebar"
    );
    await SpecialPowers.spawn(browser, [], () => {
      let doc = content.document;
      doc.getElementById("rename-input").value = "Better name";
      doc.getElementById("rename-save").click();
    });
    await waitForPage(
      browser,
      doc => doc.body.dataset.lastAction == "rename First chat to Better name"
    );

    // A section's own button shows at the end of its title without hovering.
    let filter = ui.menu.querySelector(
      ".custom-fold-heading-row > .custom-fold-heading-action"
    );
    is(
      filter?.parentNode.querySelector(".custom-fold-toggle")?.textContent,
      "Recent",
      "The filter button sits in the Recent section's title"
    );
    is(filter.getAttribute("aria-label"), "Filter chats", "It has a name");
    ok(filter.checkVisibility(), "It shows without hovering");
    ok(!row("Filter chats"), "It isn't read as an item");
    filter.click();
    await waitForPage(browser, doc => doc.body.dataset.filtered == "true");

    // A dialog a button opens shows on the page too.
    row("Find chats").click();
    await waitForPage(browser, doc =>
      doc.getElementById("find").checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
      })
    );
    await SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("find-close").click()
    );

    ui.menu.querySelector(".custom-fold-toggle").click();
    await waitForPage(
      browser,
      doc =>
        doc.querySelector(".section-header").getAttribute("aria-expanded") ==
        "false"
    );

    // After a reload the menu reads the new page, and keeps reading it when
    // the site draws its sidebar anew, which the observer doesn't see.
    let loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserCommands.reload();
    await loaded;
    await TestUtils.waitForCondition(
      () => row("Dark theme"),
      "The reloaded page's menu is read"
    );
    await SpecialPowers.spawn(browser, [], () => {
      let doc = content.document;
      let nav = doc.querySelector("#sidebar nav");
      let copy = nav.cloneNode(true);
      let late = doc.createElement("li");
      late.className = "row";
      late.innerHTML = '<a href="?view=late">Late chat</a>';
      copy.querySelector(".items").append(late);
      nav.replaceWith(copy);
    });
    await TestUtils.waitForCondition(
      () => row("Late chat"),
      "A sidebar drawn anew is read again"
    );

    ok(!(await pageState(browser)).shown, "The page's sidebar stays folded");
  });
});

add_task(async function test_sidebar_filled_once_drawn() {
  let ui = window.CustomFoldUI;
  await BrowserTestUtils.withNewTab(TEST_URL + "?lazy", async () => {
    await TestUtils.waitForCondition(() => ui.docked, "The menu docks");
    await TestUtils.waitForCondition(
      () => row("Home"),
      "A sidebar the site doesn't draw, and fills only once drawn, is read"
    );
  });
});

add_task(async function test_toggle() {
  let ui = window.CustomFoldUI;
  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    await TestUtils.waitForCondition(() => ui.docked, "The menu docks");
    ok(!ui.dock.hidden, "The docked menu shows beside the tab list");
    is(ui.dockTitle.textContent, "Fold test", "The column has the site name");
    ok(ui.buttonVisible, "The Fold button shows after the reload button");
    ok(!ui.button.classList.contains("custom-fold-off"), "It shows Fold on");
    await TestUtils.waitForCondition(
      () => row("Home"),
      "The docked menu is read"
    );

    // Turning Fold off gives the page its own sidebar back.
    ui.button.click();
    ok(!Fold.isEnabledFor("fold-test"), "The button turns Fold off");
    ok(!ui.docked && ui.dock.hidden, "The column goes away");
    ok(ui.buttonVisible, "The button stays to turn Fold on again");
    ok(ui.button.classList.contains("custom-fold-off"), "It shows Fold off");
    await TestUtils.waitForCondition(
      async () => (await pageState(browser)).shown,
      "The page shows its own sidebar"
    );

    ui.button.click();
    ok(Fold.isEnabledFor("fold-test"), "The button turns Fold on again");
    ok(ui.docked, "The column comes back");
    await TestUtils.waitForCondition(
      async () => !(await pageState(browser)).shown,
      "The page's sidebar is folded again"
    );

    // Without room for the column, the page keeps its own sidebar.
    let { minPageWidth } = ui;
    ui.minPageWidth = 100000;
    ui.update({ animate: false });
    ok(!ui.docked, "A narrow window doesn't dock the menu");
    ok(!ui.buttonVisible, "Nor shows the Fold button");
    await TestUtils.waitForCondition(
      async () => (await pageState(browser)).shown,
      "The page shows its own sidebar without room for the column"
    );
    ui.minPageWidth = minPageWidth;
    ui.update({ animate: false });
    ok(ui.docked, "With room again the menu docks");
    await TestUtils.waitForCondition(
      async () => !(await pageState(browser)).shown,
      "And the page's sidebar is folded"
    );
  });
});
