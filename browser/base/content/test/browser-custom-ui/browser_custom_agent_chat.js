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

const CHAT_URI = "chrome://browser/content/custom-ui/agent-chat.html";
const chatTabs = new Set();

function createChatAgent() {
  return {
    calls: [],
    chat(request) {
      return new Promise((resolve, reject) => {
        this.calls.push({ ...request, resolve, reject });
      });
    },
  };
}

async function chatPage(tab) {
  chatTabs.add(tab);
  let browser = tab.linkedBrowser;
  if (
    browser.contentDocument?.documentURI !== CHAT_URI ||
    browser.contentDocument.readyState !== "complete"
  ) {
    await BrowserTestUtils.browserLoaded(browser, { wantLoad: CHAT_URI });
  }
  await TestUtils.waitForCondition(
    () => browser.contentWindow?.AgentChatPage,
    "The chat controller has initialized in the native tab"
  );
  let win = browser.contentWindow;
  await win.document.l10n.ready;
  return {
    tab,
    win,
    doc: win.document,
    page: win.AgentChatPage,
    input: win.document.getElementById("chat-input"),
    send: win.document.getElementById("chat-send"),
  };
}

async function openChat() {
  return chatPage(window.CustomAgentChatUI.openChat());
}

async function closeChat(chat) {
  if (chat.tab.isConnected) {
    await BrowserTestUtils.removeTab(chat.tab);
  }
  chatTabs.delete(chat.tab);
}

function typeQuestion(chat, value) {
  chat.input.value = value;
  chat.input.dispatchEvent(new chat.win.Event("input", { bubbles: true }));
}

function messageBodies(chat, role) {
  return Array.from(
    chat.doc.querySelectorAll(
      `.chat-message[data-role="${role}"] .chat-message-body`
    ),
    element => element.textContent
  );
}

add_setup(async function () {
  await TestUtils.waitForCondition(
    () =>
      window.CustomBrowserUI?.enabled &&
      window.CustomAgentUI?.hud &&
      window.CustomAgentChatUI?.menuItem,
    "The Mono chat entry point has initialized"
  );
  await SidebarController.waitUntilStable();
  await SpecialPowers.pushPrefEnv({
    set: [["browser.customUI.agentMock", false]],
  });
  let previousAgent = window.CustomAgentUI.agent;
  window.CustomAgentUI.disconnect();
  registerCleanupFunction(async () => {
    for (let tab of chatTabs) {
      if (tab.isConnected) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    chatTabs.clear();
    window.CustomAgentUI.disconnect();
    if (previousAgent) {
      window.CustomAgentUI.connect(previousAgent);
    }
    PanelUI.hide();
    gURLBar.view.close();
    gBrowser.selectedBrowser.focus();
  });
});

add_task(async function test_menu_opens_a_native_chat_tab_and_preserves_home() {
  await BrowserTestUtils.withNewTab("about:newtab", async browser => {
    let homeTab = gBrowser.selectedTab;
    let homeURI = browser.currentURI.spec;
    await TestUtils.waitForCondition(
      () => document.documentElement.hasAttribute("custom-newtab"),
      "The original home screen is visible"
    );
    let count = gBrowser.tabs.length;
    let shown = BrowserTestUtils.waitForEvent(PanelUI.panel, "popupshown");
    PanelUI.show();
    await shown;
    let menuItem = document.getElementById("custom-agent-chat-menuitem");
    ok(
      BrowserTestUtils.isVisible(menuItem),
      "Chat is available in the app menu"
    );
    let opened = BrowserTestUtils.waitForNewTab(gBrowser, CHAT_URI, true);
    EventUtils.synthesizeMouseAtCenter(menuItem, {});
    let chat = await chatPage(await opened);
    try {
      is(gBrowser.tabs.length, count + 1, "The command adds exactly one tab");
      isnot(chat.tab, homeTab, "The home tab is not reused");
      is(gBrowser.selectedTab, chat.tab, "The new chat tab is selected");
      is(browser.currentURI.spec, homeURI, "The home URI is unchanged");
      ok(
        !chat.tab.linkedBrowser.isRemoteBrowser,
        "The chat is a chrome document"
      );
      ok(
        !document.documentElement.hasAttribute("custom-newtab"),
        "The chat tab does not display the home search surface"
      );
      await TestUtils.waitForCondition(
        () => chat.doc.activeElement === chat.input,
        "The question field receives focus"
      );
      await BrowserTestUtils.switchTab(gBrowser, homeTab);
      await TestUtils.waitForCondition(
        () => document.documentElement.hasAttribute("custom-newtab"),
        "Switching back restores the unchanged home screen"
      );
    } finally {
      await closeChat(chat);
    }
  });
});

add_task(
  async function test_home_suggestion_opens_chat_with_the_typed_question() {
    let question = "내일 할 일을 정리해 주세요";
    for (let method of ["mouse", "keyboard"]) {
      let agent = method === "keyboard" ? createChatAgent() : null;
      if (agent) {
        window.CustomAgentUI.connect(agent);
      } else {
        window.CustomAgentUI.disconnect();
      }
      try {
        await BrowserTestUtils.withNewTab("about:newtab", async browser => {
          let homeTab = gBrowser.selectedTab;
          let homeURI = browser.currentURI.spec;
          let count = gBrowser.tabs.length;
          let chat;
          await UrlbarTestUtils.promiseAutocompleteResultPopup({
            window,
            value: `  ${question}  `,
            waitForFocus,
          });
          let rows = UrlbarTestUtils.getResultsContainer(window).children;
          let index = Array.from(rows).findIndex(
            row => row.getAttribute("dynamicType") === "mono-run"
          );
          is(index, 1, "The chat suggestion follows the regular search result");
          let row = UrlbarTestUtils.getRowAt(window, index);
          ok(
            row.hasAttribute("row-selectable"),
            "The chat suggestion can be selected"
          );
          let opened = BrowserTestUtils.waitForNewTab(gBrowser, CHAT_URI, true);
          let engaged = UrlbarTestUtils.promiseProviderEngagement(window);
          if (method === "mouse") {
            EventUtils.synthesizeMouseAtCenter(
              row.querySelector(".urlbarView-dynamic-mono-run-pill"),
              {}
            );
          } else {
            EventUtils.synthesizeKey("KEY_ArrowDown");
            is(
              UrlbarTestUtils.getSelectedRowIndex(window),
              index,
              "Arrow Down selects the chat suggestion"
            );
            EventUtils.synthesizeKey("KEY_Enter");
          }
          await engaged;
          chat = await chatPage(await opened);
          try {
            is(
              gBrowser.tabs.length,
              count + 1,
              `${method} opens exactly one chat tab`
            );
            isnot(chat.tab, homeTab, "The existing home tab is preserved");
            is(browser.currentURI.spec, homeURI, "The home URI is unchanged");
            is(
              chat.tab.linkedBrowser.currentURI.spec,
              CHAT_URI,
              "The question is not placed in the chat URL"
            );
            ok(
              !gURLBar.view.isOpen,
              "The suggestions close after the transition"
            );
            if (!agent) {
              is(
                chat.input.value,
                question,
                "The clicked question becomes an editable draft"
              );
              is(
                chat.page.messages.length,
                0,
                "No response is fabricated without an agent"
              );
              ok(chat.send.disabled, "The disconnected draft is not submitted");
            } else {
              await TestUtils.waitForCondition(() => agent.calls.length === 1);
              Assert.deepEqual(
                agent.calls[0].messages.map(({ role, content }) => ({
                  role,
                  content,
                })),
                [{ role: "user", content: question }],
                "Keyboard selection sends the original question after URLbar revert"
              );
              agent.calls[0].resolve("첫 질문에 대한 답변");
              await TestUtils.waitForCondition(() => !chat.page.pending);
              is(
                agent.calls.length,
                1,
                "The initial question is submitted once"
              );
              await BrowserTestUtils.reloadTab(chat.tab);
              chat = await chatPage(chat.tab);
              is(
                agent.calls.length,
                1,
                "Reloading does not resend the initial question"
              );
              is(
                chat.input.value,
                "",
                "The initial query is consumed only once"
              );
            }
          } finally {
            await closeChat(chat);
          }
        });
      } finally {
        window.CustomAgentUI.disconnect();
      }
    }
  }
);

add_task(async function test_agent_chat_command_uses_the_current_input() {
  window.CustomAgentUI.disconnect();
  await BrowserTestUtils.withNewTab("about:newtab", async browser => {
    let homeURI = browser.currentURI.spec;
    let question = "명령으로 전달할 질문";
    gURLBar.value = `  ${question}  `;
    let opened = BrowserTestUtils.waitForNewTab(gBrowser, CHAT_URI, true);
    document.getElementById("Browser:AgentChat").doCommand();
    let chat = await chatPage(await opened);
    try {
      is(
        chat.input.value,
        question,
        "The XUL command transfers the current input"
      );
      is(
        browser.currentURI.spec,
        homeURI,
        "The command preserves the home page"
      );
      is(
        chat.page.messages.length,
        0,
        "The disconnected command preserves a draft"
      );
    } finally {
      await closeChat(chat);
    }
  });
});

add_task(async function test_unconnected_chat_keeps_an_editable_draft() {
  let chat = await openChat();
  try {
    ok(
      !chat.input.disabled,
      "A draft can be written without a connected agent"
    );
    ok(chat.send.disabled, "Send starts disabled without an agent");
    typeQuestion(chat, "이 페이지의 내용을 설명해 주세요.");
    ok(
      !chat.page.canSend,
      "Typing a draft does not imply an agent is connected"
    );
    await chat.page.submit();
    is(chat.page.messages.length, 0, "No conversation is fabricated");
    is(
      chat.input.value,
      "이 페이지의 내용을 설명해 주세요.",
      "An unavailable submission preserves the draft"
    );
    window.CustomAgentUI.connect({ run() {} });
    ok(chat.send.disabled, "A task-only adapter does not enable chat");
  } finally {
    window.CustomAgentUI.disconnect();
    await closeChat(chat);
  }
});

add_task(async function test_chat_streams_answers_and_respects_composition() {
  let chat = await openChat();
  let agent = createChatAgent();
  try {
    window.CustomAgentUI.connect(agent);
    ok(!window.CustomAgentUI.canRun, "A chat-only adapter does not enable Run");
    is(
      window.CustomAgentUI.run("실행되지 않을 웹 작업"),
      null,
      "A chat-only adapter cannot start a web task"
    );
    is(
      gBrowser.selectedTab,
      chat.tab,
      "The Run guard does not open another tab"
    );
    typeQuestion(chat, "  \n ");
    ok(chat.send.disabled, "Whitespace cannot be submitted");
    typeQuestion(chat, "  <b>질문</b>을 설명해 주세요.  ");
    ok(
      chat.page.canSend,
      "A connected chat adapter enables a nonempty question"
    );
    chat.input.dispatchEvent(
      new chat.win.KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
    );
    is(agent.calls.length, 0, "Enter during IME composition does not send");
    let submission = chat.page.submit();
    await TestUtils.waitForCondition(
      () => agent.calls.length === 1,
      "The adapter receives the question once"
    );
    let call = agent.calls[0];
    Assert.deepEqual(
      call.messages.map(({ role, content }) => ({ role, content })),
      [{ role: "user", content: "<b>질문</b>을 설명해 주세요." }],
      "The adapter receives the trimmed conversation"
    );
    ok(call.conversationId, "The conversation has an identifier");
    ok(chat.page.pending, "The conversation is waiting for a response");
    ok(chat.send.disabled, "A second submission is disabled while waiting");
    is(
      chat.doc.querySelector('.chat-message[data-role="user"] b'),
      null,
      "Question text is not interpreted as markup"
    );
    call.onDelta("첫 번째 ");
    call.onDelta("답변");
    Assert.deepEqual(
      messageBodies(chat, "assistant"),
      ["첫 번째 답변"],
      "Stream chunks appear as one assistant message"
    );
    call.resolve("첫 번째 답변입니다.");
    await submission;
    Assert.deepEqual(
      messageBodies(chat, "assistant"),
      ["첫 번째 답변입니다."],
      "The final result replaces the streamed partial answer"
    );
    ok(!chat.page.pending, "The response finishes the pending state");
    is(
      chat.page.messages.length,
      2,
      "The history contains one user and one answer"
    );
  } finally {
    window.CustomAgentUI.disconnect();
    await closeChat(chat);
  }
});

add_task(async function test_cancel_and_disconnect_ignore_late_answers() {
  let chat = await openChat();
  let agent = createChatAgent();
  window.CustomAgentUI.connect(agent);
  try {
    typeQuestion(chat, "취소할 질문");
    let submission = chat.page.submit();
    await TestUtils.waitForCondition(() => agent.calls.length === 1);
    let call = agent.calls[0];
    call.onDelta("중간 답변");
    chat.page.cancel();
    ok(call.signal.aborted, "Stopping aborts the adapter request");
    ok(!chat.page.pending, "Stopping releases the composer");
    call.onDelta("늦은 조각");
    call.resolve("늦은 완료 답변");
    await submission;
    ok(
      !messageBodies(chat, "assistant").join("").includes("늦은"),
      "Neither late chunks nor a late final answer are displayed"
    );

    typeQuestion(chat, "연결이 끊길 질문");
    submission = chat.page.submit();
    await TestUtils.waitForCondition(() => agent.calls.length === 2);
    call = agent.calls[1];
    window.CustomAgentUI.disconnect();
    ok(call.signal.aborted, "Disconnecting aborts the active adapter request");
    ok(chat.send.disabled, "Send is disabled after disconnection");
    call.resolve("연결 해제 후 늦은 답변");
    await submission;
    ok(
      !messageBodies(chat, "assistant").join("").includes("늦은"),
      "Disconnecting prevents a stale answer from updating the page"
    );
  } finally {
    window.CustomAgentUI.disconnect();
    await closeChat(chat);
  }
});

add_task(async function test_new_chat_tabs_have_independent_conversations() {
  let first = await openChat();
  let second;
  let agent = createChatAgent();
  window.CustomAgentUI.connect(agent);
  try {
    typeQuestion(first, "첫 대화의 질문");
    let submission = first.page.submit();
    await TestUtils.waitForCondition(() => agent.calls.length === 1);
    agent.calls[0].resolve("첫 대화의 답변");
    await submission;
    typeQuestion(first, "첫 탭에 남길 초안");

    let opened = BrowserTestUtils.waitForNewTab(gBrowser, CHAT_URI, true);
    first.doc.getElementById("chat-new").click();
    second = await chatPage(await opened);
    isnot(second.tab, first.tab, "New chat creates another native tab");
    is(second.page.messages.length, 0, "The second conversation starts empty");
    is(
      second.input.value,
      "",
      "The first draft is not copied into the new chat"
    );
    typeQuestion(second, "두 번째 대화의 질문");
    submission = second.page.submit();
    await TestUtils.waitForCondition(() => agent.calls.length === 2);
    let secondCall = agent.calls[1];
    isnot(
      secondCall.conversationId,
      agent.calls[0].conversationId,
      "Each tab has its own conversation identifier"
    );
    is(
      secondCall.messages.length,
      1,
      "The first conversation is not sent again"
    );
    secondCall.resolve("두 번째 대화의 답변");
    await submission;
    await BrowserTestUtils.switchTab(gBrowser, first.tab);
    Assert.deepEqual(
      messageBodies(first, "assistant"),
      ["첫 대화의 답변"],
      "The original conversation is preserved"
    );
    is(
      first.input.value,
      "첫 탭에 남길 초안",
      "The original draft is preserved"
    );
  } finally {
    window.CustomAgentUI.disconnect();
    if (second) {
      await closeChat(second);
    }
    await closeChat(first);
  }
});

add_task(async function test_closing_a_chat_aborts_the_request() {
  let chat = await openChat();
  let agent = createChatAgent();
  window.CustomAgentUI.connect(agent);
  try {
    typeQuestion(chat, "탭을 닫으면 멈출 질문");
    chat.page.submit();
    await TestUtils.waitForCondition(() => agent.calls.length === 1);
    let call = agent.calls[0];
    await closeChat(chat);
    ok(call.signal.aborted, "Closing the tab aborts its pending request");
    let tabCount = gBrowser.tabs.length;
    call.onDelta("닫힌 탭에 보이면 안 되는 조각");
    call.resolve("닫힌 탭에 보이면 안 되는 답변");
    await new Promise(resolve => executeSoon(resolve));
    ok(call.signal.aborted, "A late answer does not reactivate the request");
    is(gBrowser.tabs.length, tabCount, "A late answer does not reopen a tab");
  } finally {
    window.CustomAgentUI.disconnect();
    await closeChat(chat);
  }
});

add_task(
  async function test_failed_chat_can_retry_without_duplicate_questions() {
    let chat = await openChat();
    let agent = createChatAgent();
    let question = "다시 보낼 질문";
    window.CustomAgentUI.connect(agent);
    try {
      typeQuestion(chat, question);
      let submission = chat.page.submit();
      await TestUtils.waitForCondition(() => agent.calls.length === 1);
      agent.calls[0].onDelta("실패한 부분 답변");
      agent.calls[0].reject(new Error("Expected test adapter failure"));
      await submission;
      is(chat.input.value, question, "A failed request restores the question");
      is(
        chat.page.messages.length,
        1,
        "A failed answer is not committed to history"
      );
      is(
        chat.doc.getElementById("chat-status").getAttribute("data-l10n-id"),
        "agent-chat-error",
        "The failure is shown to the user"
      );

      for (let [answer, expectedStatus] of [
        [{ unexpected: true }, "agent-chat-error"],
        ["  ", "agent-chat-empty-response"],
        ["재시도한 답변", "agent-chat-ready"],
      ]) {
        let previousCalls = agent.calls.length;
        submission = chat.page.submit();
        await TestUtils.waitForCondition(
          () => agent.calls.length === previousCalls + 1
        );
        let call = agent.calls.at(-1);
        Assert.deepEqual(
          call.messages.map(({ role, content }) => ({ role, content })),
          [{ role: "user", content: question }],
          "Retrying sends the original question exactly once"
        );
        Assert.deepEqual(
          messageBodies(chat, "user"),
          [question],
          "Retrying does not duplicate the user's message"
        );
        if (typeof answer !== "string") {
          call.onDelta("형식 오류가 있는 부분 답변");
        }
        call.resolve(answer);
        await submission;
        is(
          chat.doc.getElementById("chat-status").getAttribute("data-l10n-id"),
          expectedStatus,
          "Each adapter result has the appropriate status"
        );
        if (expectedStatus !== "agent-chat-ready") {
          is(
            chat.input.value,
            question,
            "An unsuccessful retry keeps the draft"
          );
          is(
            chat.page.messages.length,
            1,
            "Invalid responses do not enter history"
          );
        }
      }
      Assert.deepEqual(
        messageBodies(chat, "assistant"),
        ["재시도한 답변"],
        "The successful retry replaces failed partial responses"
      );
      is(
        chat.page.messages.length,
        2,
        "The completed history contains one exchange"
      );
    } finally {
      window.CustomAgentUI.disconnect();
      await closeChat(chat);
    }
  }
);

add_task(async function test_moving_a_chat_rebinds_to_its_new_browser_window() {
  let original = await openChat();
  let originalAgent = createChatAgent();
  let moved;
  let extra;
  let otherWindow;
  window.CustomAgentUI.connect(originalAgent);
  try {
    otherWindow = await BrowserTestUtils.openNewBrowserWindow();
    await TestUtils.waitForCondition(
      () =>
        otherWindow.CustomAgentChatUI?.menuItem &&
        otherWindow.CustomAgentUI?.hud,
      "The destination browser window has initialized its chat controller"
    );
    let destinationAgent = createChatAgent();
    otherWindow.CustomAgentUI.connect(destinationAgent);
    typeQuestion(original, "이동 전에 보낸 질문");
    let originalSubmission = original.page.submit();
    await TestUtils.waitForCondition(() => originalAgent.calls.length === 1);
    let originalCall = originalAgent.calls[0];
    let conversationId = original.page.conversationId;
    typeQuestion(original, "이동한 뒤 보낼 초안");

    let adoptedTab = otherWindow.gBrowser.adoptTab(original.tab, {
      selectTab: true,
    });
    ok(adoptedTab, "The native tab can be moved into another browser window");
    chatTabs.delete(original.tab);
    moved = await chatPage(adoptedTab);
    await TestUtils.waitForCondition(
      () => moved.page.connectionWindow === otherWindow,
      "The chat listens to the destination window's connection changes"
    );
    is(
      moved.page.browserWindow,
      otherWindow,
      "The chat resolves its current owner"
    );
    is(
      moved.page.conversationId,
      conversationId,
      "Moving a tab preserves its identity"
    );
    is(
      moved.input.value,
      "이동한 뒤 보낼 초안",
      "Moving preserves the unsent draft"
    );
    ok(originalCall.signal.aborted, "Moving stops the old window's request");
    originalCall.onDelta("원래 창에서 늦게 온 조각");
    originalCall.resolve("원래 창에서 늦게 온 답변");
    await originalSubmission;
    is(
      moved.page.messages.length,
      1,
      "The stale answer does not change history"
    );

    let submission = moved.page.submit();
    await TestUtils.waitForCondition(() => destinationAgent.calls.length === 1);
    is(
      originalAgent.calls.length,
      1,
      "The old adapter receives no further question"
    );
    let call = destinationAgent.calls[0];
    window.CustomAgentUI.disconnect();
    ok(
      !call.signal.aborted,
      "Disconnecting the old window leaves the new request active"
    );
    otherWindow.CustomAgentUI.disconnect();
    ok(
      call.signal.aborted,
      "The current window's disconnection stops the request"
    );
    call.resolve("연결 해제 후 늦은 답변");
    await submission;
    ok(
      moved.send.disabled,
      "The moved composer reflects its owner's disconnection"
    );

    let originalTabCount = gBrowser.tabs.length;
    let opened = BrowserTestUtils.waitForNewTab(
      otherWindow.gBrowser,
      CHAT_URI,
      true
    );
    moved.doc.getElementById("chat-new").click();
    extra = await chatPage(await opened);
    is(
      extra.tab.documentGlobal,
      otherWindow,
      "New chat opens in the destination browser window"
    );
    is(
      gBrowser.tabs.length,
      originalTabCount,
      "The original window gains no tab"
    );
  } finally {
    window.CustomAgentUI.disconnect();
    otherWindow?.CustomAgentUI?.disconnect();
    if (extra) {
      await closeChat(extra);
    }
    if (moved) {
      await closeChat(moved);
    }
    await closeChat(original);
    if (otherWindow) {
      await BrowserTestUtils.closeWindow(otherWindow);
    }
  }
});
