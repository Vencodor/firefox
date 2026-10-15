/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const NOTICE_PREF = "browser.customUI.notice";
const DISMISSED_PREF = "browser.customUI.noticeDismissed";
const NOTICE = {
  id: "test-notice",
  label: "새 기능 · v0.3",
  title: "경로 다시 걷기",
  description: "지난번에 찾아간 길을 기억해 두었다가 다시 걸어요.",
};

async function setNotice(notice, dismissed = []) {
  await SpecialPowers.pushPrefEnv({
    set: [
      [NOTICE_PREF, notice ? JSON.stringify(notice) : ""],
      [DISMISSED_PREF, JSON.stringify(dismissed)],
    ],
  });
}

function dismissedIds() {
  return JSON.parse(Services.prefs.getStringPref(DISMISSED_PREF, "[]"));
}

add_setup(async function () {
  await TestUtils.waitForCondition(
    () => window.CustomBrowserUI?.enabled && window.CustomNotice?.cards,
    "The custom UI and its notice cards have initialized"
  );
  await SidebarController.waitUntilStable();
});

add_task(async function test_no_notice_without_content() {
  await setNotice(null);
  await BrowserTestUtils.withNewTab("about:newtab", async () => {
    await TestUtils.waitForCondition(
      () => document.documentElement.hasAttribute("custom-newtab"),
      "An empty new tab shows the search screen"
    );
    for (let id of ["custom-notice-newtab", "custom-notice-sidebar"]) {
      ok(
        BrowserTestUtils.isHidden(document.getElementById(id)),
        `${id} is hidden while there is nothing to announce`
      );
    }
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_notice_on_new_tab() {
  await setNotice(NOTICE);
  await BrowserTestUtils.withNewTab("about:newtab", async () => {
    await TestUtils.waitForCondition(
      () => document.documentElement.hasAttribute("custom-newtab"),
      "An empty new tab shows the search screen"
    );
    let card = document.getElementById("custom-notice-newtab");
    ok(BrowserTestUtils.isVisible(card), "The card shows under the search box");
    is(
      card.querySelector(".custom-notice-label").textContent,
      NOTICE.label,
      "The card shows the label"
    );
    is(
      card.querySelector(".custom-notice-title").textContent,
      NOTICE.title,
      "The card shows the title"
    );
    is(
      card.querySelector(".custom-notice-description").textContent,
      NOTICE.description,
      "The card shows the description"
    );
    let rect = card.getBoundingClientRect();
    Assert.lessOrEqual(
      Math.abs(rect.height - 132),
      1,
      "The card is 132px tall"
    );
    Assert.greaterOrEqual(
      rect.top,
      gURLBar.getBoundingClientRect().bottom,
      "The card sits below the search box"
    );
    ok(
      BrowserTestUtils.isHidden(
        document.getElementById("custom-notice-sidebar")
      ),
      "The sidebar card does not show together with the new tab card"
    );

    card.querySelector(".custom-notice-close").click();
    ok(BrowserTestUtils.isHidden(card), "Closing the card hides it");
    Assert.deepEqual(dismissedIds(), [NOTICE.id], "The notice is remembered");
  });
  await BrowserTestUtils.withNewTab("about:newtab", async () => {
    await TestUtils.waitForCondition(
      () => document.documentElement.hasAttribute("custom-newtab"),
      "An empty new tab shows the search screen"
    );
    ok(
      BrowserTestUtils.isHidden(
        document.getElementById("custom-notice-newtab")
      ),
      "A closed notice does not come back"
    );
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_notice_in_sidebar() {
  await setNotice(NOTICE);
  await BrowserTestUtils.withNewTab("about:mozilla", async () => {
    let card = document.getElementById("custom-notice-sidebar");
    await TestUtils.waitForCondition(
      () => BrowserTestUtils.isVisible(card),
      "The card shows at the bottom of the sidebar"
    );
    is(
      card.querySelector(".custom-notice-title").textContent,
      NOTICE.title,
      "The card shows the title"
    );
    let rect = card.getBoundingClientRect();
    let sidebar = document
      .getElementById("sidebar-container")
      .getBoundingClientRect();
    Assert.lessOrEqual(rect.width, 224 + 1, "The card is at most 224px wide");
    Assert.lessOrEqual(rect.right, sidebar.right, "The card fits the sidebar");
    Assert.greaterOrEqual(rect.left, sidebar.left, "The card fits the sidebar");
    ok(
      BrowserTestUtils.isHidden(
        document.getElementById("custom-notice-newtab")
      ),
      "The new tab card is not shown on a page"
    );

    card.querySelector(".custom-notice-close").click();
    ok(BrowserTestUtils.isHidden(card), "Closing the card hides it");
    Assert.deepEqual(dismissedIds(), [NOTICE.id], "The notice is remembered");
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_dismissed_notice_stays_hidden() {
  await setNotice(NOTICE, [NOTICE.id]);
  await BrowserTestUtils.withNewTab("about:mozilla", async () => {
    ok(
      BrowserTestUtils.isHidden(
        document.getElementById("custom-notice-sidebar")
      ),
      "A notice that was closed before does not show"
    );
  });
  await SpecialPowers.popPrefEnv();
});
