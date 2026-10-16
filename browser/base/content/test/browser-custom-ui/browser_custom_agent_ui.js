/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineLazyGetter(this, "UrlbarTestUtils", () => {
  const { UrlbarTestUtils: module } = ChromeUtils.importESModule(
    "resource://testing-common/UrlbarTestUtils.sys.mjs"
  );
  module.init(this);
  return module;
});

const QUERY = "도쿄 왕복 항공권 최저가";
const CHAT_ROW_TYPE = "mono-run";

function createAgent() {
  let calls = [];
  let record = type => (tab, state) => calls.push({ type, tab, state });
  return {
    calls,
    run: details => calls.push({ type: "run", ...details }),
    stop: record("stop"),
    resume: record("resume"),
    approve: record("approve"),
    takeOver: record("takeOver"),
  };
}

function findChatRowIndex() {
  let rows = UrlbarTestUtils.getResultsContainer(window).children;
  return Array.from(rows).findIndex(
    row => row.getAttribute("dynamicType") == CHAT_ROW_TYPE
  );
}

async function openSuggestions() {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: QUERY,
    waitForFocus,
  });
}

add_setup(async function () {
  await TestUtils.waitForCondition(
    () => window.CustomBrowserUI?.enabled && window.CustomAgentUI?.hud,
    "The custom UI and its agent surface have initialized"
  );
  await SidebarController.waitUntilStable();
  registerCleanupFunction(() => {
    window.CustomAgentUI.disconnect();
    gURLBar.view.close();
    gBrowser.selectedBrowser.focus();
  });
});

add_task(async function test_urlbar_chat_row() {
  await BrowserTestUtils.withNewTab("about:newtab", async () => {
    await openSuggestions();
    let index = findChatRowIndex();
    is(index, 1, "The chat row sits right below the typed query");
    let row = UrlbarTestUtils.getRowAt(window, index);
    ok(
      row.hasAttribute("row-selectable"),
      "A chat draft can be opened without a connected agent"
    );
    is(
      row.querySelector(".urlbarView-dynamic-mono-run-title").textContent,
      QUERY,
      "The row repeats the query"
    );
    is(
      row.querySelector(".urlbarView-dynamic-mono-run-pill").textContent,
      await document.l10n.formatValue("agent-chat-urlbar-action"),
      "The pill offers a chat rather than a web task"
    );
    await UrlbarTestUtils.promisePopupClose(window);
  });
});

add_task(async function test_agent_tab_states() {
  let ui = window.CustomAgentUI;
  let agent = createAgent();
  ui.connect(agent);
  await BrowserTestUtils.withNewTab("about:mozilla", async () => {
    let tab = gBrowser.selectedTab;
    let { hud, buttons } = ui;
    ok(
      BrowserTestUtils.isHidden(hud),
      "The orb is hidden without an agent task"
    );

    ui.setState(tab, {
      status: "working",
      title: "항공권 비교",
      summary: "검색 결과 읽는 중",
      step: 2,
      totalSteps: 5,
    });
    is(tab.getAttribute("custom-agent-state"), "working", "The row is working");
    is(
      tab.style.getPropertyValue("--custom-agent-progress"),
      "40",
      "The ring shows 2 of 5 steps"
    );
    await TestUtils.waitForCondition(
      () => tab.getAttribute("aria-label")?.includes("항공권 비교"),
      "The tab row has an accessible name that includes the task"
    );
    ok(BrowserTestUtils.isVisible(hud), "The orb shows for the selected tab");
    is(hud.dataset.status, "working", "The orb is working");
    ok(!buttons.stop.hidden, "Stop is offered while working");
    ok(buttons.approve.hidden, "Approve is hidden while working");

    ui.parts.get(tab).stop.click();
    is(tab.getAttribute("custom-agent-state"), "paused", "Stop pauses the row");
    is(agent.calls.at(-1).type, "stop", "The agent is told to stop");
    ok(!buttons.resume.hidden, "Resume is offered after a stop");
    buttons.resume.click();
    is(tab.getAttribute("custom-agent-state"), "working", "Resume continues");
    is(agent.calls.at(-1).type, "resume", "The agent is told to resume");

    ui.setState(tab, {
      status: "confirm",
      step: 4,
      confirm: {
        title: "결제 직전이에요",
        detail: "총 378,000원 · 이대로 진행할까요?",
      },
    });
    is(tab.getAttribute("custom-agent-state"), "confirm", "The row asks");
    is(ui.bubbleTitle.textContent, "결제 직전이에요", "The bubble asks too");
    ok(!buttons.approve.hidden, "Approve is offered at a confirmation");
    ok(!buttons.takeOver.hidden, "Taking over is offered at a confirmation");
    ok(buttons.stop.hidden, "Stop is hidden at a confirmation");
    buttons.approve.click();
    is(tab.getAttribute("custom-agent-state"), "working", "Approve continues");
    is(agent.calls.at(-1).type, "approve", "The agent is told to continue");

    ui.setState(tab, {
      status: "done",
      step: 5,
      result: { headline: "목록까지 왔어요", pathSaved: true },
    });
    ok(
      !tab.hasAttribute("custom-agent-state"),
      "A result seen on the selected tab clears the row state"
    );
    is(hud.dataset.status, "done", "The orb keeps showing the result");
    ok(BrowserTestUtils.isVisible(hud), "The orb stays until it is dismissed");

    ui.clearState(tab);
    ok(BrowserTestUtils.isHidden(hud), "Clearing the state hides the orb");
  });
  ui.disconnect();
});

add_task(async function test_handoff_asks_the_user_to_take_over() {
  let ui = window.CustomAgentUI;
  let agent = createAgent();
  ui.connect(agent);
  await BrowserTestUtils.withNewTab("about:mozilla", async () => {
    let tab = gBrowser.selectedTab;
    let { buttons } = ui;
    ui.setState(tab, {
      status: "confirm",
      step: 3,
      totalSteps: 5,
      confirm: {
        title: "여기서부터는 직접 해주세요",
        detail: "원하는 항목을 찾지 못했어요",
        handoff: true,
      },
    });
    is(tab.getAttribute("custom-agent-state"), "confirm", "The row asks");
    ok(buttons.approve.hidden, "Approving is not offered on a handoff");
    ok(!buttons.takeOver.hidden, "Taking over is offered on a handoff");
    is(
      buttons.takeOver.getAttribute("data-l10n-id"),
      "custom-ui-agent-handoff",
      "The take over button is labeled for a handoff"
    );
    ok(
      buttons.takeOver.classList.contains("custom-agent-action-primary"),
      "Taking over is the primary action on a handoff"
    );

    buttons.takeOver.click();
    is(tab.getAttribute("custom-agent-state"), "paused", "Taking over pauses");
    is(agent.calls.at(-1).type, "takeOver", "The agent is told to step back");

    ui.setState(tab, {
      status: "confirm",
      confirm: { title: "결제 직전이에요", detail: "이대로 진행할까요?" },
    });
    ok(!buttons.approve.hidden, "A normal confirmation offers approving");
    is(
      buttons.takeOver.getAttribute("data-l10n-id"),
      "custom-ui-agent-takeover",
      "A normal confirmation uses the regular take over label"
    );
    ok(
      !buttons.takeOver.classList.contains("custom-agent-action-primary"),
      "Approving is the primary action on a normal confirmation"
    );
    ui.clearState(tab);
  });
  ui.disconnect();
});

add_task(async function test_next_click_marker() {
  let ui = window.CustomAgentUI;
  ui.connect(createAgent());
  await BrowserTestUtils.withNewTab("about:mozilla", async () => {
    let tab = gBrowser.selectedTab;
    let { marker, markerTarget } = ui;
    ui.setState(tab, { status: "working", title: "항공권 비교", step: 1 });
    ok(!marker.hasAttribute("data-visible"), "Nothing is marked at first");

    ui.showNextClick(tab, { x: 120, y: 80, width: 150, height: 34 });
    ok(marker.hasAttribute("data-visible"), "The next click is marked");
    let area = tab.linkedBrowser.getBoundingClientRect();
    let box = markerTarget.getBoundingClientRect();
    Assert.lessOrEqual(
      Math.abs(box.left - area.left - 120),
      1,
      "The mark is placed from the left edge of the page"
    );
    Assert.lessOrEqual(
      Math.abs(box.top - area.top - 80),
      1,
      "The mark is placed from the top edge of the page"
    );
    Assert.lessOrEqual(Math.abs(box.width - 150), 1, "The mark has the width");
    Assert.lessOrEqual(Math.abs(box.height - 34), 1, "The mark has the height");
    ok(
      !markerTarget.hasAttribute("data-label-below"),
      "The label sits above the mark"
    );

    ui.showNextClick(tab, { x: 120, y: 10, width: 150, height: 34 });
    ok(
      markerTarget.hasAttribute("data-label-below"),
      "The label moves below a mark near the top of the page"
    );

    ui.setState(tab, {
      status: "confirm",
      confirm: { title: "결제 직전이에요", detail: "이대로 진행할까요?" },
    });
    ok(!marker.hasAttribute("data-visible"), "The mark goes away at a pause");
    ui.setState(tab, { status: "working" });
    ok(
      !marker.hasAttribute("data-visible"),
      "Working again starts without the old mark"
    );

    ui.showNextClick(tab, { x: 120, y: 80, width: 150, height: 34 });
    ui.hideNextClick(tab);
    ok(!marker.hasAttribute("data-visible"), "The agent can hide the mark");
    ui.clearState(tab);
  });
  ui.disconnect();
});

add_task(async function test_unseen_result_on_background_tab() {
  let ui = window.CustomAgentUI;
  ui.connect(createAgent());
  await BrowserTestUtils.withNewTab("about:mozilla", async () => {
    let background = await BrowserTestUtils.addTab(gBrowser, "about:mozilla");
    ui.setState(background, { status: "done", step: 3, totalSteps: 3 });
    is(
      background.getAttribute("custom-agent-state"),
      "done",
      "A result finished in the background is marked unseen"
    );
    ok(BrowserTestUtils.isHidden(ui.hud), "The orb follows the selected tab");

    await BrowserTestUtils.switchTab(gBrowser, background);
    ok(
      !background.hasAttribute("custom-agent-state"),
      "Opening the tab marks the result as seen"
    );
    is(ui.hud.dataset.status, "done", "The orb shows the result");

    ui.clearState(background);
    BrowserTestUtils.removeTab(background);
  });
  ui.disconnect();
});

add_task(async function test_run_from_a_page_opens_an_agent_tab() {
  let ui = window.CustomAgentUI;
  ok(!ui.canRun, "No agent is connected by default");
  is(ui.run(QUERY), null, "Run does nothing without an agent");

  let agent = createAgent();
  ui.connect(agent);
  await BrowserTestUtils.withNewTab("about:mozilla", async () => {
    let origin = gBrowser.selectedTab;
    ok(
      !document.documentElement.hasAttribute("custom-newtab"),
      "A normal page is showing"
    );
    is(ui.run("   "), null, "An empty query is ignored");

    let tab = ui.run(`  ${QUERY}  `);
    ok(tab, "Run returns the tab it started in");
    isnot(tab, origin, "Run opens a new tab away from a normal page");
    is(gBrowser.selectedTab, tab, "The new tab is selected");
    is(agent.calls.length, 1, "The agent is started once");
    is(agent.calls[0].query, QUERY, "The query is trimmed");
    is(agent.calls[0].tab, tab, "The agent gets the new tab");
    is(tab.getAttribute("custom-agent-state"), "working", "The row is working");
    ok(
      !document.documentElement.hasAttribute("custom-newtab"),
      "The agent tab does not show the search screen"
    );

    await BrowserTestUtils.removeTab(tab);
    is(
      agent.calls.at(-1).type,
      "stop",
      "Closing a working tab stops the agent"
    );
    is(agent.calls.at(-1).tab, tab, "The agent is told which tab closed");
  });
  ui.disconnect();
});

add_task(async function test_mock_agent_pref() {
  let ui = window.CustomAgentUI;
  is(ui.agent, null, "No agent is connected before the mock pref is set");
  await SpecialPowers.pushPrefEnv({ set: [[ui.mockPref, true]] });
  is(ui.agent, ui.mockAgent, "The mock pref connects the demo agent");
  ok(ui.canRun, "Run is available with the demo agent");
  await SpecialPowers.popPrefEnv();
  is(ui.agent, null, "Clearing the mock pref disconnects the demo agent");
});
