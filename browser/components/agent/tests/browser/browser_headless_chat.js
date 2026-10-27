/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  AgentHeadless,
  normalizeUrlForDedup,
  toReadableUrl,
  createParagraphDeduplicator,
  computeAdaptiveHeadlessBudget,
} = ChromeUtils.importESModule(
  "resource:///modules/agent/AgentHeadless.sys.mjs"
);
const {
  SYSTEM_PROMPT,
  stripSourceSections,
  stripDsmlMarkup,
  extractTabTitleTag,
  deriveConciseTabTitle,
  normalizeSearchItems,
  AgentRuntime,
} = ChromeUtils.importESModule(
  "resource:///modules/agent/AgentRuntime.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

const FIXTURE_ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const FIXTURE = FIXTURE_ROOT + "observation.html";
const CHAT_URI = "chrome://browser/content/custom-ui/agent-chat.html";

add_task(async function test_headless_observe_url_without_opening_tab() {
  const initialTabCount = gBrowser.tabs.length;
  const page = await AgentHeadless.observeUrl(FIXTURE);

  Assert.equal(
    gBrowser.tabs.length,
    initialTabCount,
    "Headless observation does not open a visible browser tab"
  );
  Assert.equal(page.url, FIXTURE, "Observed URL matches the target fixture");
  Assert.ok(
    page.text.includes("Alpha") || !!page.links.length,
    "Headless observation extracts page content and links"
  );
});

add_task(async function test_end_to_end_chat_with_headless_search_and_llm() {
  const server = new HttpServer();
  let llmRequests = [];

  let stalledResponses = [];

  server.registerPathHandler("/search", (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    const slowUrl = `http://localhost:${server.identity.primaryPort}/article-slow`;
    const article1Url = `http://localhost:${server.identity.primaryPort}/article-1`;
    const article2Url = `http://localhost:${server.identity.primaryPort}/article-2`;
    response.write(`<!doctype html>
      <html>
        <head><title>Search Results</title></head>
        <body>
          <main>
            <h1>Search Results for: ${request.queryString}</h1>
            <article>
              <h2><a href="${slowUrl}">Stalled Legacy Portal (Rank 1)</a></h2>
              <p>This site hangs and should be skipped after timeout.</p>
            </article>
            <article>
              <h2><a href="${article1Url}">Mono Browser AI Architecture</a></h2>
              <p>Summary of the Mono Browser headless search pipeline.</p>
            </article>
            <article>
              <h2><a href="${article2Url}">Mono Concurrent Headless Engine</a></h2>
              <p>Summary of concurrent headless browsing in Mono.</p>
            </article>
          </main>
        </body>
      </html>`);
  });

  server.registerPathHandler("/article-slow", (request, response) => {
    response.processAsync();
    stalledResponses.push(response);
  });

  server.registerPathHandler("/article-1", (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.write(`<!doctype html>
      <html>
        <head><title>Mono Browser AI Architecture</title></head>
        <body>
          <main>
            <h1>Mono Browser AI Architecture</h1>
            <p>CODEWORD_MONO_HEADLESS_42: The headless browser collects DOM observations in the background.</p>
          </main>
        </body>
      </html>`);
  });

  server.registerPathHandler("/article-2", (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.write(`<!doctype html>
      <html>
        <head><title>Mono Concurrent Headless Engine</title></head>
        <body>
          <main>
            <h1>Mono Concurrent Headless Engine</h1>
            <p>CODEWORD_CONCURRENT_99: Multiple headless browsers run asynchronously in parallel.</p>
          </main>
        </body>
      </html>`);
  });

  server.registerPathHandler("/chat/completions", (request, response) => {
    const StreamTools = Cc[
      "@mozilla.org/scriptableinputstream;1"
    ].createInstance(Ci.nsIScriptableInputStream);
    StreamTools.init(request.bodyInputStream);
    const rawBody = StreamTools.read(request.bodyInputStream.available());
    const utf8Body = decodeURIComponent(escape(rawBody));
    const body = JSON.parse(utf8Body);
    llmRequests.push(body);

    response.setHeader(
      "Content-Type",
      "application/json; charset=utf-8",
      false
    );
    const hasToolMessage = body.messages.some(m => m.role === "tool");
    if (!hasToolMessage) {
      const payload = JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              reasoning_content:
                "Thinking: I should search for Mono Browser AI architecture first.",
              tool_calls: [
                {
                  id: "call_search_1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({
                      tabTitle: "Mono AI 아키텍처",
                      query: "Mono Browser AI",
                      maxPagesToVisit: 2,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 140,
          completion_tokens: 60,
          total_tokens: 200,
          completion_tokens_details: {
            reasoning_tokens: 25,
          },
        },
      });
      response.write(unescape(encodeURIComponent(payload)));
    } else {
      const toolMsg = body.messages.find(m => m.role === "tool");
      const foundBoth =
        toolMsg.content.includes("CODEWORD_MONO_HEADLESS_42") &&
        toolMsg.content.includes("CODEWORD_CONCURRENT_99");
      const payload = JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              reasoning_content:
                "Thinking: Found both CODEWORD_MONO_HEADLESS_42 and CODEWORD_CONCURRENT_99.",
              content: foundBoth
                ? "### 검색 요약\n\n- **핵심 코드**: `CODEWORD_MONO_HEADLESS_42`\n- **병렬 수집**: `CODEWORD_CONCURRENT_99`\n\n### 출처\n- https://example.com/should-be-stripped"
                : "검색 결과에서 코드워드를 찾지 못했습니다.",
            },
          },
        ],
        usage: {
          prompt_tokens: 320,
          completion_tokens: 90,
          total_tokens: 410,
          completion_tokens_details: {
            reasoning_tokens: 35,
          },
        },
      });
      response.write(unescape(encodeURIComponent(payload)));
    }
  });

  Assert.equal(
    Services.prefs.getIntPref("browser.agent.headlessPageTimeoutMs", 0),
    3000,
    "Default headless page extraction timeout is 3000ms (3 seconds)"
  );

  server.start(-1);
  const baseUrl = `http://localhost:${server.identity.primaryPort}`;

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.agent.apiKey", "test-deepseek-key"],
      ["browser.agent.apiBaseUrl", baseUrl],
      ["browser.agent.searchUrlTemplate", `${baseUrl}/search?q={searchTerms}`],
      ["browser.agent.headlessPageTimeoutMs", 600],
    ],
  });

  let chatTab = null;
  try {
    chatTab = window.CustomAgentChatUI.openChat(
      "Mono Browser AI 아키텍처에 대해 검색해서 알려줘"
    );
    const browser = chatTab.linkedBrowser;
    if (
      browser.contentDocument?.documentURI !== CHAT_URI ||
      browser.contentDocument.readyState !== "complete"
    ) {
      await BrowserTestUtils.browserLoaded(browser, { wantLoad: CHAT_URI });
    }
    await TestUtils.waitForCondition(
      () => browser.contentWindow?.AgentChatPage,
      "AgentChatPage initialized"
    );
    const page = browser.contentWindow.AgentChatPage;
    await TestUtils.waitForCondition(
      () => !page.pending && page.messages.length === 2,
      "Chat request completed with user question and assistant answer"
    );

    Assert.equal(
      llmRequests.length,
      2,
      "LLM was called twice (tool call turn + final synthesis turn)"
    );
    Assert.equal(
      llmRequests[0].model,
      "deepseek-flash",
      "Default model is deepseek-flash (DeepSeek V4.1 Flash)"
    );
    Assert.deepEqual(
      llmRequests[0].thinking,
      { type: "enabled" },
      "Thinking mode is enabled in DeepSeek request body"
    );
    Assert.deepEqual(
      llmRequests[1].thinking,
      { type: "disabled" },
      "Final synthesis after tool results skips thinking"
    );
    const firstUserMsg = llmRequests[0].messages.findLast(
      m => m.role === "user"
    );
    Assert.ok(
      /^<current_datetime>.+\(.+, UTC[+-]\d\d:\d\d\)<\/current_datetime>\n/.test(
        firstUserMsg.content
      ),
      "Latest user message is prefixed with the current local date and time"
    );
    Assert.equal(
      llmRequests[0].messages[0].content,
      SYSTEM_PROMPT,
      "System prompt stays constant so the prompt prefix can be cached"
    );
    const assistantToolMsg = llmRequests[1].messages.find(
      m => m.role === "assistant" && Array.isArray(m.tool_calls)
    );
    Assert.equal(
      assistantToolMsg?.reasoning_content,
      "Thinking: I should search for Mono Browser AI architecture first.",
      "reasoning_content is preserved and passed back on assistant tool_calls turn"
    );
    const toolContextMsg = llmRequests[1].messages.find(m => m.role === "tool");
    Assert.ok(
      !toolContextMsg.content.includes("http://localhost"),
      "Tool search report omits raw URLs so the LLM does not cite URLs"
    );
    Assert.ok(
      page.messages[1].content.includes("CODEWORD_MONO_HEADLESS_42") &&
        page.messages[1].content.includes("CODEWORD_CONCURRENT_99"),
      "Final answer incorporates content after skipping stalled Rank #1 and falling back to Rank #3"
    );
    Assert.ok(
      !page.messages[1].content.includes("출처") &&
        !page.messages[1].content.includes("should-be-stripped"),
      "Trailing Sources / 출처 section is stripped from the final assistant response"
    );
    Assert.equal(
      browser.contentDocument.title,
      "Mono AI 아키텍처",
      "Document title is updated from the first LLM call's summarized tabTitle"
    );
    Assert.equal(
      chatTab.label,
      "Mono AI 아키텍처",
      "Firefox browser tab label is updated from the first LLM call's summarized tabTitle"
    );

    const doc = browser.contentDocument;
    Assert.equal(
      doc.getElementById("chat-input-hint"),
      null,
      "'Enter로 보내기' hint element is removed"
    );
    const effortOptions = doc.querySelectorAll(
      '#chat-effort-control[role="radiogroup"] [role="radio"]'
    );
    Assert.equal(
      effortOptions.length,
      2,
      "Normal and deep modes are offered in the composer actions"
    );
    Assert.equal(
      browser.contentWindow.AgentChatPage.researchMode,
      "normal",
      "Chats start in normal mode"
    );
    const thinkingBlocks = doc.querySelectorAll(".chat-step-thinking");
    Assert.equal(
      thinkingBlocks.length,
      2,
      "Both rounds of CoT thinking are rendered in the chat message activity"
    );
    Assert.ok(
      thinkingBlocks[0]
        .querySelector(".chat-thinking-body")
        .textContent.includes("search for Mono Browser AI"),
      "First thinking block displays the streamed CoT text"
    );

    const toolCards = doc.querySelectorAll(".chat-step-tool");
    Assert.equal(toolCards.length, 1, "The web_search tool call is rendered");
    Assert.equal(
      toolCards[0].dataset.toolName,
      "web_search",
      "Tool card shows the called tool name"
    );

    await TestUtils.waitForCondition(
      () => !doc.querySelector('.chat-headless-card[data-phase="removing"]'),
      "Skipped pages finish leaving the activity"
    );
    const headlessCards = doc.querySelectorAll(".chat-headless-card");
    Assert.equal(
      headlessCards.length,
      2,
      "Only the pages actually read (Rank #2 and fallback Rank #3) stay listed; the search page and the timed-out Rank #1 are not"
    );
    Assert.ok(
      Array.from(headlessCards).every(c => c.dataset.phase === "done"),
      "Listed pages are shown as read"
    );
    Assert.ok(
      doc.getElementById("chat-activity-status").hidden,
      "Floating activity status is hidden once the answer is finished"
    );

    const assistantBody = doc.querySelector(
      '.chat-message[data-role="assistant"] .chat-message-body'
    );
    Assert.equal(
      assistantBody.dataset.markdown,
      "true",
      "Assistant message body is rendered with Markdown enabled"
    );
    Assert.equal(
      assistantBody.querySelector("h3")?.textContent,
      "검색 요약",
      "Markdown heading is rendered as an <h3> element"
    );
    Assert.equal(
      assistantBody.querySelectorAll("ul li").length,
      2,
      "Markdown unordered list items are rendered as <ul><li> elements"
    );
    Assert.ok(
      assistantBody.querySelector("strong")?.textContent.includes("핵심 코드"),
      "Markdown bold text is rendered as <strong>"
    );
    Assert.ok(
      assistantBody
        .querySelector("code")
        ?.textContent.includes("CODEWORD_MONO_HEADLESS_42"),
      "Markdown inline code is rendered as <code>"
    );

    const debugCard = doc.querySelector(".chat-debug-card");
    Assert.ok(debugCard, "Developer debug metrics card is rendered");
    const debugRows = debugCard.querySelectorAll(".chat-debug-table tbody tr");
    Assert.greaterOrEqual(
      debugRows.length,
      6,
      "Debug table includes LLM steps, Tool step, and all 4 Headless substeps"
    );
    const totalFootText = debugCard.querySelector(
      ".chat-debug-table tfoot"
    ).textContent;
    Assert.ok(
      totalFootText.includes("610"),
      "Debug table footer sums total tokens (200 + 410 = 610)"
    );

    // Regression test: character-by-character streaming of headings, code fences, lists, tables
    const sampleStream =
      "### \n### 제목\n\n- \n- 항목 1\n1. \n1. 순서 1\n\n```c++ (example)\nint x = 0;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const tempDiv = doc.createElement("div");
    for (let len = 1; len <= sampleStream.length; len++) {
      browser.contentWindow.renderMarkdown(tempDiv, sampleStream.slice(0, len));
    }
    Assert.ok(
      tempDiv.querySelector("table") && tempDiv.querySelector("pre code"),
      "Incremental character-by-character Markdown streaming completes without hanging"
    );
  } finally {
    for (const res of stalledResponses) {
      try {
        res.finish();
      } catch {}
    }
    if (chatTab?.isConnected) {
      await BrowserTestUtils.removeTab(chatTab);
    }
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_multi_query_parallel_search_and_deduplication() {
  Assert.equal(
    normalizeUrlForDedup(
      "https://example.com/news/item/?utm_source=ddg&fbclid=123#section-2"
    ),
    "https://example.com/news/item",
    "normalizeUrlForDedup strips tracking params, hash, and trailing slash"
  );

  const deduplicator = createParagraphDeduplicator();
  const firstText = deduplicator.deduplicateText(
    "공통 신디케이션 리드 문단: 차세대 브라우저 내장형 AI 에이전트는 비동기 병렬 탐색과 문단 중복 제거를 통해 토큰 효율을 극대화합니다.\n첫 번째 문서만의 고유 핵심 사실: ALPHA_FACT_777"
  );
  const secondText = deduplicator.deduplicateText(
    "공통 신디케이션 리드 문단: 차세대 브라우저 내장형 AI 에이전트는 비동기 병렬 탐색과 문단 중복 제거를 통해 토큰 효율을 극대화합니다!\n두 번째 문서만의 고유 핵심 사실: BETA_FACT_888"
  );
  Assert.ok(
    firstText.includes("ALPHA_FACT_777") &&
      secondText.includes("BETA_FACT_888") &&
      !secondText.includes("공통 신디케이션 리드 문단"),
    "3-gram Jaccard paragraph deduplicator removes near-duplicate syndicated paragraph while preserving unique facts"
  );
  Assert.equal(
    deduplicator.getStats().removedParagraphs,
    1,
    "Deduplicator records 1 removed duplicate paragraph"
  );

  const server = new HttpServer();
  let sharedArticleHits = 0;

  server.registerPathHandler("/search", (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    const port = server.identity.primaryPort;
    const isSecondQuery = request.queryString.includes("beta");
    const sharedUrl = isSecondQuery
      ? `http://localhost:${port}/shared-article?utm_source=query_beta#top`
      : `http://localhost:${port}/shared-article?utm_source=query_alpha`;
    const uniqueUrl = `http://localhost:${port}/unique-article`;

    response.write(`<!doctype html>
      <html>
        <head><title>SERP ${request.queryString}</title></head>
        <body>
          <main>
            <h1>Results for ${request.queryString}</h1>
            <article>
              <h2><a href="${sharedUrl}">Shared Deep Research Article</a></h2>
              <p>Appears in both sub-queries with different tracking parameters.</p>
            </article>
            <article>
              <h2><a href="${uniqueUrl}">Unique Companion Article</a></h2>
              <p>Complementary details for multi-query fusion.</p>
            </article>
          </main>
        </body>
      </html>`);
  });

  const syndicatedBoilerplate =
    "SYNDICATED_BOILERPLATE_PARAGRAPH: All modern browser agents must eliminate redundant cross-page paragraphs before LLM synthesis to save context window tokens.";

  server.registerPathHandler("/shared-article", (request, response) => {
    sharedArticleHits++;
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.write(`<!doctype html>
      <html>
        <head><title>Shared Deep Research Article</title></head>
        <body>
          <main>
            <h1>Shared Deep Research Article</h1>
            <p>${syndicatedBoilerplate}</p>
            <p>SHARED_CODEWORD_101: Extracted from the shared primary source.</p>
          </main>
        </body>
      </html>`);
  });

  server.registerPathHandler("/unique-article", (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.write(`<!doctype html>
      <html>
        <head><title>Unique Companion Article</title></head>
        <body>
          <main>
            <h1>Unique Companion Article</h1>
            <p>${syndicatedBoilerplate}</p>
            <p>UNIQUE_CODEWORD_202: Extracted from the secondary source.</p>
          </main>
        </body>
      </html>`);
  });

  server.start(-1);
  const baseUrl = `http://localhost:${server.identity.primaryPort}`;

  try {
    const result = await AgentHeadless.search(["mono alpha", "mono beta"], {
      searchUrlTemplate: `${baseUrl}/search?q={searchTerms}`,
      maxPagesToVisit: 2,
    });

    Assert.equal(
      result.queries.length,
      2,
      "Multi-query search executes both sub-queries in parallel"
    );
    Assert.equal(
      sharedArticleHits,
      1,
      "Shared URL across sub-queries is normalized and visited only once"
    );
    Assert.greaterOrEqual(
      result.dedupStats.skippedDuplicateUrls,
      1,
      "Cross-query URL deduplication count is recorded"
    );
    Assert.greaterOrEqual(
      result.dedupStats.removedParagraphs,
      1,
      "Cross-page syndicated paragraph is deduplicated"
    );
    Assert.ok(
      result.formattedContext.includes("SHARED_CODEWORD_101") &&
        result.formattedContext.includes("UNIQUE_CODEWORD_202"),
      "Both unique codewords are preserved in the merged context"
    );
    Assert.ok(
      !result.formattedContext.includes("http://localhost"),
      "Formatted context contains no raw URLs"
    );
  } finally {
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(
  async function test_adaptive_ram_concurrency_early_stop_and_structured_prompt() {
    // 1. Structured English prompt without persona + Google default search
    Assert.ok(
      Services.prefs
        .getStringPref("browser.agent.searchUrlTemplate", "")
        .startsWith("https://www.google.com/search"),
      "Default search URL template uses Google Search"
    );
    Assert.ok(
      AgentHeadless.buildSearchUrl("mono ai").startsWith(
        "https://www.google.com/search?q=mono%20ai"
      ),
      "AgentHeadless.buildSearchUrl resolves to Google Search by default"
    );
    Assert.ok(
      SYSTEM_PROMPT.includes("<instructions>") &&
        SYSTEM_PROMPT.includes("<tab_title_protocol>") &&
        SYSTEM_PROMPT.includes("<retrieval_protocol>") &&
        SYSTEM_PROMPT.includes("<output_protocol>") &&
        SYSTEM_PROMPT.includes(
          "Answer directly on Step 1 WITHOUT calling any tool"
        ) &&
        SYSTEM_PROMPT.includes("Conciseness (Answer-First)"),
      "SYSTEM_PROMPT uses structured XML-tag sections with early-answer and conciseness rules"
    );
    Assert.ok(
      !SYSTEM_PROMPT.toLowerCase().includes("you are "),
      "SYSTEM_PROMPT omits persona declarations"
    );

    // 2. Source section stripping & tab title tag extraction
    const parsedTag = extractTabTitleTag(
      "<tab_title>양자 컴퓨팅 동향</tab_title>\n### 핵심 내용\n양자 오류 정정 기술이 발전했습니다."
    );
    Assert.equal(
      parsedTag.tabTitle,
      "양자 컴퓨팅 동향",
      "extractTabTitleTag extracts <tab_title> tag cleanly"
    );
    Assert.ok(
      !parsedTag.cleanedText.includes("<tab_title>"),
      "extractTabTitleTag removes <tab_title> from visible text"
    );
    const stripped = stripSourceSections(
      "### 본문 요약\n핵심 사실입니다.\n\n### Sources\n- https://example.com/1"
    );
    Assert.ok(
      stripped.includes("핵심 사실입니다.") &&
        !stripped.includes("Sources") &&
        !stripped.includes("https://example.com"),
      "stripSourceSections removes trailing Sources section and URLs"
    );
    Assert.lessOrEqual(
      deriveConciseTabTitle(
        "2026년 최신 반도체 공정 기술 트렌드에 대해 자세히 알려줘"
      ).length,
      28,
      "deriveConciseTabTitle produces a concise fallback tab title"
    );

    // 3. RAM-adaptive headless concurrency between 3 and 8
    const lowRamBudget = computeAdaptiveHeadlessBudget({
      minConcurrency: 3,
      maxConcurrency: 8,
      simulatedTotalRamMB: 4096,
      simulatedResidentMB: 2800,
    });
    const midRamBudget = computeAdaptiveHeadlessBudget({
      minConcurrency: 3,
      maxConcurrency: 8,
      simulatedTotalRamMB: 8192,
      simulatedResidentMB: 2200,
    });
    const highRamBudget = computeAdaptiveHeadlessBudget({
      minConcurrency: 3,
      maxConcurrency: 8,
      simulatedTotalRamMB: 32768,
      simulatedResidentMB: 1500,
    });

    Assert.equal(
      lowRamBudget.concurrency,
      3,
      "Low available RAM scales headless concurrency down to minimum (3)"
    );
    Assert.ok(
      midRamBudget.concurrency > lowRamBudget.concurrency &&
        midRamBudget.concurrency < highRamBudget.concurrency,
      "Medium available RAM selects an intermediate headless concurrency"
    );
    Assert.equal(
      highRamBudget.concurrency,
      8,
      "Abundant available RAM scales headless concurrency up to maximum (8)"
    );

    // 4. Speculative parallel execution + early-stopping of slow sites
    const server = new HttpServer();
    let stalledResponses = [];

    server.registerPathHandler("/search", (request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8", false);
      const port = server.identity.primaryPort;
      response.write(`<!doctype html>
        <html>
          <head><title>Speculative Search</title></head>
          <body>
            <main>
              <article><h2><a href="http://localhost:${port}/slow-1">Slow Site 1</a></h2></article>
              <article><h2><a href="http://localhost:${port}/slow-2">Slow Site 2</a></h2></article>
              <article><h2><a href="http://localhost:${port}/fast-1">Fast Site 1</a></h2></article>
              <article><h2><a href="http://localhost:${port}/fast-2">Fast Site 2</a></h2></article>
            </main>
          </body>
        </html>`);
    });

    for (const slowPath of ["/slow-1", "/slow-2"]) {
      server.registerPathHandler(slowPath, (request, response) => {
        response.processAsync();
        stalledResponses.push(response);
      });
    }

    for (const [idx, fastPath] of ["/fast-1", "/fast-2"].entries()) {
      server.registerPathHandler(fastPath, (request, response) => {
        response.setHeader("Content-Type", "text/html; charset=utf-8", false);
        const uniqueBody =
          idx === 0
            ? "FAST_FACT_1: Quantum error correction architectures reduce logical qubit overhead using surface code lattices."
            : "FAST_FACT_2: Photonic interconnects enable low-latency modular scaling across distributed cryogenic processors.";
        response.write(`<!doctype html>
          <html>
            <head><title>Fast Site ${idx + 1}</title></head>
            <body>
              <main>
                <h1>Fast Site ${idx + 1}</h1>
                <p>${uniqueBody}</p>
              </main>
            </body>
          </html>`);
      });
    }

    server.start(-1);
    const baseUrl = `http://localhost:${server.identity.primaryPort}`;
    const events = [];

    try {
      const startMs = Date.now();
      const result = await AgentHeadless.search("speculative early stop", {
        searchUrlTemplate: `${baseUrl}/search?q={searchTerms}`,
        maxPagesToVisit: 2,
        minConcurrency: 4,
        maxConcurrency: 8,
        simulatedTotalRamMB: 32768,
        simulatedResidentMB: 1500,
        pageTimeoutMs: 3500,
        onEvent(ev) {
          events.push(ev);
        },
      });
      const elapsedMs = Date.now() - startMs;

      const validPages = result.visitedPages.filter(p => !p.error && p.text);
      Assert.equal(
        validPages.length,
        2,
        "Collected the 2 fast pages needed to satisfy maxPagesToVisit"
      );
      Assert.ok(
        result.formattedContext.includes("FAST_FACT_1") &&
          result.formattedContext.includes("FAST_FACT_2"),
        "Both fast sites contributed to the final context"
      );
      Assert.less(
        elapsedMs,
        2800,
        "Early-stopping aborted the slow sites well before the 3500ms timeout"
      );
      const earlyStoppedEvents = events.filter(
        e => e.type === "headless_error" && e.earlyStopped
      );
      Assert.greaterOrEqual(
        earlyStoppedEvents.length,
        1,
        "In-flight slow headless browsers were aborted with earlyStopped=true"
      );

      // 5. DSML markup stripping
      const dsmlSample =
        '핵심 요약 본문입니다.\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="web_search">';
      Assert.equal(
        stripDsmlMarkup(dsmlSample),
        "핵심 요약 본문입니다.",
        "stripDsmlMarkup removes leaked DeepSeek DSML function call markup"
      );
    } finally {
      for (const res of stalledResponses) {
        try {
          res.finish();
        } catch {}
      }
      await new Promise(resolve => server.stop(resolve));
    }

    // 6. Dedicated Google SERP parser + Firefox Readability article extraction with quality gate
    const googleServer = new HttpServer();
    googleServer.registerPathHandler("/search", (request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8", false);
      const port = googleServer.identity.primaryPort;
      // 20 top navigation/filter links that previously exhausted maxLinks=15
      const navLinks = Array.from(
        { length: 20 },
        (_, i) =>
          `<a href="http://localhost:${port}/nav-${i + 1}">Nav Filter ${i + 1}</a>`
      ).join("");
      response.write(`<!doctype html>
        <html>
          <head><title>Google 검색</title></head>
          <body>
            <header><nav>${navLinks}</nav></header>
            <div id="rcnt">
              <div class="hgKElc">FEATURED_SNIPPET_999: Direct featured answer extracted from Google SERP header box.</div>
              <div id="search">
                <div id="rso">
                  <div class="MjjYud">
                    <a href="/url?q=http%3A%2F%2Flocalhost%3A${port}%2Freader-article&sa=U">
                      <h3>Firefox Readability Deep Dive</h3>
                    </a>
                    <div class="VwiC3b">Organic snippet describing how Firefox Readability extracts clean article prose.</div>
                  </div>
                </div>
              </div>
            </div>
          </body>
        </html>`);
    });

    googleServer.registerPathHandler("/reader-article", (request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8", false);
      response.write(`<!doctype html>
        <html>
          <head><title>Firefox Readability Deep Dive</title></head>
          <body>
            <header><nav><a href="/home">Site Nav Noise</a></nav></header>
            <article>
              <h1>Firefox Readability Deep Dive</h1>
              <p>READABILITY_BODY_777: Mozilla Readability parses the DOM tree and strips surrounding navigation clutter to isolate high-signal prose paragraphs for the agent without including menus, sidebars, or footer boilerplate.</p>
              <p>Every extracted article undergoes a rigorous quality check comparing character count and substantive line density against semantic DOM blocks so compact technical documentation pages never lose important content during extraction.</p>
              <p>By running Readability in a dedicated background worker and validating the extracted prose before synthesis, the headless browsing pipeline achieves high precision and low token overhead across diverse web pages.</p>
            </article>
            <footer>Copyright Noise Footer</footer>
          </body>
        </html>`);
    });

    googleServer.start(-1);
    const gBase = `http://localhost:${googleServer.identity.primaryPort}`;
    try {
      const gResult = await AgentHeadless.search("firefox readability", {
        searchUrlTemplate: `${gBase}/search?q={searchTerms}`,
        maxPagesToVisit: 1,
      });

      Assert.equal(
        gResult.searchPage.extractionMethod,
        "google-serp-parser",
        "Search page uses the dedicated Google SERP parser"
      );
      Assert.ok(
        gResult.formattedContext.includes("FEATURED_SNIPPET_999"),
        "Google SERP featured snippet is captured in the search overview"
      );
      Assert.equal(
        gResult.visitedPages.length,
        1,
        "Google SERP parser ignored the 20 header nav links and extracted the #rso a>h3 organic result"
      );
      Assert.equal(
        gResult.visitedPages[0].extractionMethod,
        "firefox-readability",
        "Result article was extracted using Firefox's built-in Readability algorithm after passing the quality check"
      );
      Assert.ok(
        gResult.formattedContext.includes("READABILITY_BODY_777") &&
          !gResult.formattedContext.includes("Site Nav Noise"),
        "Readability extracted article prose while stripping header/nav noise"
      );
    } finally {
      await new Promise(resolve => googleServer.stop(resolve));
    }
  }
);

add_task(async function test_mercury_provider_request_shape() {
  const server = new HttpServer();
  const requests = [];
  server.registerPathHandler("/v1/chat/completions", (request, response) => {
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    requests.push({
      auth: request.getHeader("Authorization"),
      body: JSON.parse(
        decodeURIComponent(
          escape(stream.read(request.bodyInputStream.available()))
        )
      ),
    });
    response.setHeader("Content-Type", "application/json", false);
    response.write(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", reasoning: "R", content: "OK" } },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      })
    );
  });
  server.start(-1);
  const baseUrl = `http://localhost:${server.identity.primaryPort}/v1`;

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.agent.provider", "mercury"],
      ["browser.agent.mercury.apiKey", "test-mercury-key"],
      ["browser.agent.mercury.apiBaseUrl", baseUrl],
    ],
  });
  try {
    const config = AgentRuntime.getConfig();
    Assert.equal(config.model, "mercury-3", "Mercury default model is used");
    Assert.equal(
      config.endpoint,
      `${baseUrl}/chat/completions`,
      "Mercury endpoint is built from its own base URL pref"
    );

    let metrics = null;
    const answer = await AgentRuntime.chat({
      messages: [{ role: "user", content: "1+1?" }],
      onEvent(ev) {
        if (ev.type === "chat_metrics") {
          metrics = ev.metrics;
        }
      },
    });

    Assert.equal(answer, "OK", "Mercury answer is returned");
    Assert.equal(requests.length, 1, "One request for a direct answer");
    const { auth, body } = requests[0];
    Assert.equal(auth, "Bearer test-mercury-key", "Mercury API key is sent");
    Assert.equal(body.model, "mercury-3", "Mercury model id is sent");
    Assert.equal(
      body.reasoning_effort,
      "low",
      "A round that may call tools uses the lighter toolReasoningEffort"
    );
    Assert.ok(
      !("thinking" in body),
      "DeepSeek-only thinking parameter is not sent to Mercury"
    );
    Assert.ok(
      !("diffusing" in body),
      "Diffusing is off by default; blocks are revealed by the chat UI"
    );
    Assert.equal(
      metrics?.totals.cacheHitTokens,
      4,
      "OpenAI-style cached_tokens usage is counted"
    );
    Assert.greater(
      metrics?.firstContentMs,
      0,
      "Time to first visible answer is reported"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_mercury_diffusing_stream_replaces_text() {
  const server = new HttpServer();
  const bodies = [];
  server.registerPathHandler("/v1/chat/completions", (request, response) => {
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    bodies.push(JSON.parse(stream.read(request.bodyInputStream.available())));
    response.setHeader("Content-Type", "text/event-stream", false);
    const steps = ["Hxllo wqrld", "Hello wqrld", "Hello world!"];
    for (const content of steps) {
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
      );
    }
    response.write("data: [DONE]\n\n");
  });
  server.start(-1);

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.agent.provider", "mercury"],
      ["browser.agent.mercury.apiKey", "test-mercury-key"],
      [
        "browser.agent.mercury.apiBaseUrl",
        `http://localhost:${server.identity.primaryPort}/v1`,
      ],
      ["browser.agent.mercury.diffusing", true],
    ],
  });
  try {
    const refined = [];
    const deltas = [];
    const answer = await AgentRuntime.chat({
      messages: [{ role: "user", content: "hi" }],
      onDelta: delta => deltas.push(delta),
      onEvent(ev) {
        if (ev.type === "answer_refine") {
          refined.push(ev.text);
        }
      },
    });
    Assert.strictEqual(bodies[0].diffusing, true, "diffusing is requested");
    Assert.equal(answer, "Hello world!", "Final answer is the last state");
    Assert.deepEqual(
      refined,
      ["Hxllo wqrld", "Hello wqrld", "Hello world!"],
      "Each refinement replaces the whole answer"
    );
    Assert.equal(deltas.length, 0, "Diffusing text is not appended as deltas");
  } finally {
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(function test_fit_pages_to_budget_keeps_relevant_lines() {
  const { fitPagesToBudget } = ChromeUtils.importESModule(
    "resource:///modules/agent/observation/TextRelevance.sys.mjs"
  );
  const filler = n =>
    Array.from({ length: n }, (_, i) => `filler line ${i} about nothing`);
  const pages = [
    { text: ["Lead A", ...filler(40), "battery life is 12 hours"].join("\n") },
    { text: ["Lead B", ...filler(40), "battery charges in 30 min"].join("\n") },
  ];
  const { before, after } = fitPagesToBudget(pages, "laptop battery", 600);
  Assert.greater(before, 600, "Pages start over budget");
  Assert.lessOrEqual(after, 600, "Combined text fits the budget");
  Assert.ok(
    pages[0].text.startsWith("Lead A") && pages[1].text.startsWith("Lead B"),
    "Each page keeps its lead"
  );
  Assert.ok(
    pages[0].text.includes("battery life") &&
      pages[1].text.includes("battery charges"),
    "Query-relevant lines survive from every page"
  );
});

add_task(async function test_llm_retry_and_stream_error_reporting() {
  const server = new HttpServer();
  let hits = 0;
  let mode = "rate-limit";
  server.registerPathHandler("/v1/chat/completions", (request, response) => {
    hits++;
    if (mode === "rate-limit" && hits === 1) {
      response.setStatusLine(request.httpVersion, 429, "Too Many Requests");
      response.setHeader("Retry-After", "0", false);
      response.write("{}");
      return;
    }
    if (mode === "stream-error") {
      response.setHeader("Content-Type", "text/event-stream", false);
      response.write(
        `data: ${JSON.stringify({ error: { message: "upstream overloaded" } })}\n\n`
      );
      return;
    }
    response.setHeader("Content-Type", "application/json", false);
    response.write(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "after retry" } }],
      })
    );
  });
  server.start(-1);

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.agent.provider", "mercury"],
      ["browser.agent.mercury.apiKey", "test-mercury-key"],
      [
        "browser.agent.mercury.apiBaseUrl",
        `http://localhost:${server.identity.primaryPort}/v1`,
      ],
    ],
  });
  try {
    const answer = await AgentRuntime.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    Assert.equal(answer, "after retry", "A 429 is retried once");
    Assert.equal(hits, 2, "Exactly one retry was sent");

    mode = "stream-error";
    await Assert.rejects(
      AgentRuntime.chat({ messages: [{ role: "user", content: "hi" }] }),
      /LLM stream error: upstream overloaded/,
      "An error event inside the stream is reported instead of an empty answer"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => server.stop(resolve));
  }
});

function startDecideFixtureServer({
  sufficient = 0.1,
  decideStatus = 200,
  coverageFor = () => 0.9,
} = {}) {
  const server = new HttpServer();
  const hits = new Map();
  const decideBodies = [];
  const titles = {
    "/relevant-1": "Relevant Battery Review",
    "/unrelated-1": "Unrelated Cooking Blog",
    "/relevant-2": "Relevant Battery Benchmarks",
    "/unrelated-2": "Unrelated Store Login",
  };
  server.registerPathHandler("/search", (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    const port = server.identity.primaryPort;
    const results = Object.entries(titles)
      .map(
        ([path, title]) =>
          `<article><h2><a href="http://localhost:${port}${path}">${title}</a></h2><p>SNIPPET_${path.slice(1)} short summary.</p></article>`
      )
      .join("");
    response.write(
      `<!doctype html><html><head><title>SERP</title></head><body><main>${results}</main></body></html>`
    );
  });
  for (const [path, title] of Object.entries(titles)) {
    server.registerPathHandler(path, (request, response) => {
      hits.set(path, (hits.get(path) || 0) + 1);
      response.setHeader("Content-Type", "text/html; charset=utf-8", false);
      response.write(
        `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>BODY_${path.slice(1)}: battery details for the decide filter test.</p></main></body></html>`
      );
    });
  }
  server.registerPathHandler("/v1/decisions", (request, response) => {
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    // The stream yields raw bytes; decode them as UTF-8.
    const body = JSON.parse(
      decodeURIComponent(
        escape(stream.read(request.bodyInputStream.available()))
      )
    );
    decideBodies.push(body);
    if (decideStatus !== 200) {
      response.setStatusLine(request.httpVersion, decideStatus, "Error");
      response.write("{}");
      return;
    }
    const answers = {};
    for (const item of body.state.needs || []) {
      answers[item.id] = { type: "noul", noul: coverageFor(item.need) };
    }
    if (body.state.results) {
      answers.snippets_sufficient = { type: "noul", noul: sufficient };
    }
    for (const result of body.state.results || []) {
      answers[result.id] = {
        type: "noul",
        noul: result.title.startsWith("Relevant") ? 0.9 : 0.05,
      };
    }
    response.setHeader("Content-Type", "application/json", false);
    response.write(
      JSON.stringify({
        answers,
        usage: { input_tokens: 120, output_tokens: 5 },
      })
    );
  });
  server.start(-1);
  const base = `http://localhost:${server.identity.primaryPort}`;
  return { server, hits, decideBodies, base };
}

async function withDecidePrefs(base, extra, fn) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.agent.decide.enabled", true],
      ["browser.agent.decide.apiKey", "test-decide-key"],
      ["browser.agent.decide.apiBaseUrl", `${base}/v1`],
      ...extra,
    ],
  });
  try {
    await fn();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_decide_filters_unrelated_results() {
  const fixture = startDecideFixtureServer();
  const { hits, decideBodies, base } = fixture;
  const events = [];
  try {
    await withDecidePrefs(
      base,
      [["browser.agent.decide.speculativeVisits", 0]],
      async () => {
        const result = await AgentHeadless.search("battery life", {
          searchUrlTemplate: `${base}/search?q={searchTerms}`,
          userQuestion: "이 노트북 배터리 얼마나 가?",
          maxPagesToVisit: 4,
          minConcurrency: 4,
          maxConcurrency: 4,
          onEvent: ev => events.push(ev),
        });
        Assert.equal(decideBodies.length, 1, "One decision call per query");
        Assert.equal(
          decideBodies[0].state.user_question,
          "이 노트북 배터리 얼마나 가?",
          "The user's own question is judged against"
        );
        Assert.ok(hits.get("/relevant-1") && hits.get("/relevant-2"));
        Assert.ok(
          !hits.has("/unrelated-1") && !hits.has("/unrelated-2"),
          "Results judged unrelated are never opened"
        );
        Assert.ok(
          !result.formattedContext.includes("SNIPPET_unrelated"),
          "Unrelated snippets are left out of the overview"
        );
        Assert.equal(result.dedupStats.decide.dropped, 2);
        Assert.ok(
          events.some(ev => ev.type === "decide_done" && ev.kept === 2),
          "The decision is reported for the debug card"
        );
      }
    );
  } finally {
    await new Promise(resolve => fixture.server.stop(resolve));
  }
});

add_task(async function test_decide_answers_from_snippets() {
  const fixture = startDecideFixtureServer({ sufficient: 0.95 });
  const { hits, base } = fixture;
  try {
    await withDecidePrefs(
      base,
      [["browser.agent.decide.speculativeVisits", 0]],
      async () => {
        const result = await AgentHeadless.search("battery life", {
          searchUrlTemplate: `${base}/search?q={searchTerms}`,
          maxPagesToVisit: 4,
        });
        Assert.equal(hits.size, 0, "No page is opened when snippets suffice");
        Assert.ok(result.dedupStats.decide.answeredBySnippets);
        Assert.ok(
          result.formattedContext.includes("SNIPPET_relevant-1"),
          "Relevant snippets stay in the overview"
        );
      }
    );
  } finally {
    await new Promise(resolve => fixture.server.stop(resolve));
  }
});

add_task(async function test_decide_failure_keeps_every_result() {
  const fixture = startDecideFixtureServer({ decideStatus: 500 });
  const { hits, base } = fixture;
  try {
    await withDecidePrefs(
      base,
      [["browser.agent.decide.speculativeVisits", 0]],
      async () => {
        const result = await AgentHeadless.search("battery life", {
          searchUrlTemplate: `${base}/search?q={searchTerms}`,
          maxPagesToVisit: 4,
          minConcurrency: 4,
          maxConcurrency: 4,
        });
        Assert.equal(result.dedupStats.decide.failed, 1);
        Assert.equal(
          hits.size,
          4,
          "A failed judgment falls back to opening all"
        );
      }
    );
  } finally {
    await new Promise(resolve => fixture.server.stop(resolve));
  }
});

add_task(function test_search_items_and_readable_urls() {
  Assert.deepEqual(
    normalizeSearchItems({
      query: "ignored when queries are given",
      queries: [
        { needs: ["가격", "출시일"], query: "galaxy price" },
        { need: "dup", query: "Galaxy Price" },
        "plain query",
        { needs: ["c"], query: "c" },
        { needs: ["d"], query: "d" },
      ],
    }),
    [
      { query: "galaxy price", needs: ["가격", "출시일"] },
      { query: "plain query", needs: ["c", "d"] },
    ],
    "queries win over query, duplicates drop, and searches past 2 hand their needs to the last one"
  );
  Assert.deepEqual(normalizeSearchItems({ query: "single" }), [
    { query: "single", needs: [] },
  ]);
  Assert.equal(
    toReadableUrl("https://blog.naver.com/someone/223344556677"),
    "https://m.blog.naver.com/someone/223344556677",
    "Naver blog posts open as their frameless mobile page"
  );
  Assert.equal(
    toReadableUrl(
      "https://blog.naver.com/PostView.naver?blogId=someone&logNo=42"
    ),
    "https://m.blog.naver.com/someone/42"
  );
  Assert.equal(toReadableUrl("https://example.com/a"), "https://example.com/a");
});

add_task(function test_search_report_numbers_sources() {
  let next = 5;
  const cited = new Map();
  const report = AgentHeadless.formatSearchReport({
    query: "q",
    searchEntries: [
      {
        query: "q",
        needs: ["배터리 수명"],
        searchPage: {
          text: "",
          links: [
            { title: "Read Page", url: "https://a.example/read", context: "" },
            {
              title: "Snippet Only",
              url: "https://b.example/snippet",
              context: "SNIPPET_TEXT [4]",
            },
          ],
        },
      },
    ],
    visitedPages: [
      {
        url: "https://a.example/read",
        title: "Read Page",
        text: "BODY_TEXT with a footnote[12].",
      },
    ],
    citeSource: url => {
      if (!cited.has(url)) {
        cited.set(url, ++next);
      }
      return cited.get(url);
    },
  });
  Assert.ok(report.text.includes("[Query]: q — needs: 배터리 수명"));
  Assert.ok(
    report.text.includes(
      "[Document 6 — Read Page]:\nBODY_TEXT with a footnote."
    ),
    "Read pages are numbered from the shared counter and lose footnote marks"
  );
  Assert.ok(
    report.text.includes("- [7] Snippet Only — SNIPPET_TEXT"),
    "Snippet results get their own source number"
  );
  Assert.ok(
    !report.compact.includes("BODY_TEXT") &&
      report.compact.includes("- [6] Read Page") &&
      report.compact.includes("SNIPPET_TEXT"),
    "The compact report keeps snippets and titles but no page text"
  );
  Assert.deepEqual(
    report.sources.map(source => [source.id, source.url]),
    [
      [6, "https://a.example/read"],
      [7, "https://b.example/snippet"],
    ]
  );
});

add_task(async function test_need_coverage_gap_triggers_one_more_search() {
  const fixture = startDecideFixtureServer({
    coverageFor: need => (need === "가격" ? 0.1 : 0.9),
  });
  const { server, decideBodies, base } = fixture;
  const llmBodies = [];
  server.registerPathHandler("/chat/completions", (request, response) => {
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    const body = JSON.parse(
      decodeURIComponent(
        escape(stream.read(request.bodyInputStream.available()))
      )
    );
    llmBodies.push(body);
    const toolMessages = body.messages.filter(m => m.role === "tool");
    const toolCall = queries => ({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: `call_${toolMessages.length}`,
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ queries }),
          },
        },
      ],
    });
    let message;
    if (!toolMessages.length) {
      message = toolCall([
        { need: "배터리 수명", query: "battery life" },
        { need: "가격", query: "battery price" },
      ]);
    } else if (toolMessages.length === 1) {
      message = toolCall([{ need: "가격", query: "battery price 2026" }]);
    } else {
      message = { role: "assistant", content: "배터리는 오래 갑니다 [1]." };
    }
    response.setHeader("Content-Type", "application/json", false);
    response.write(
      unescape(
        encodeURIComponent(
          JSON.stringify({
            choices: [{ message }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          })
        )
      )
    );
  });
  const events = [];
  try {
    await withDecidePrefs(
      base,
      [
        ["browser.agent.decide.speculativeVisits", 0],
        ["browser.agent.provider", "deepseek"],
        ["browser.agent.apiKey", "test-deepseek-key"],
        ["browser.agent.apiBaseUrl", base],
        ["browser.agent.searchUrlTemplate", `${base}/search?q={searchTerms}`],
      ],
      async () => {
        const answer = await AgentRuntime.chat({
          messages: [{ role: "user", content: "배터리 수명과 가격은?" }],
          onEvent: ev => events.push(ev),
        });
        Assert.equal(answer, "배터리는 오래 갑니다 [1].");
        Assert.equal(
          llmBodies.length,
          3,
          "Search, plan the gap search, then answer"
        );
        const planningTool = llmBodies[1].messages.find(m => m.role === "tool");
        Assert.ok(
          planningTool.content.includes("still missing or thin") &&
            planningTool.content.includes("- 가격") &&
            !planningTool.content.includes("BODY_"),
          "The planning turn sees the gap and snippets, not the page text"
        );
        const finalTools = llmBodies[2].messages.filter(m => m.role === "tool");
        Assert.equal(finalTools.length, 2);
        Assert.ok(
          finalTools[0].content.includes("BODY_relevant") &&
            !finalTools[0].content.includes("still missing"),
          "The full first report is restored for the answer"
        );
        Assert.ok(
          decideBodies.some(body => body.state.needs?.length === 2),
          "Both needs of the first search are judged in one call"
        );
        Assert.ok(
          !decideBodies.some(body => body.state.search_query?.includes("2026")),
          "The gap search is not filtered again"
        );
        const sources = events.findLast(ev => ev.type === "sources")?.sources;
        Assert.ok(
          sources?.length &&
            sources.every(source => source.url.startsWith(base)) &&
            new Set(sources.map(source => source.url)).size === sources.length,
          "Sources of both searches reach the UI, each page with one number"
        );
      }
    );
  } finally {
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_think_deeply_reasks_with_full_effort() {
  const server = new HttpServer();
  const bodies = [];
  server.registerPathHandler("/v1/chat/completions", (request, response) => {
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    const body = JSON.parse(
      decodeURIComponent(
        escape(stream.read(request.bodyInputStream.available()))
      )
    );
    bodies.push(body);
    const message =
      bodies.length === 1
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_deep",
                type: "function",
                function: { name: "think_deeply", arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: "DEEP_ANSWER" };
    response.setHeader("Content-Type", "application/json", false);
    response.write(
      JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })
    );
  });
  server.start(-1);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.agent.provider", "mercury"],
      ["browser.agent.mercury.apiKey", "test-mercury-key"],
      [
        "browser.agent.mercury.apiBaseUrl",
        `http://localhost:${server.identity.primaryPort}/v1`,
      ],
    ],
  });
  const events = [];
  try {
    const answer = await AgentRuntime.chat({
      messages: [{ role: "user", content: "어려운 증명 문제" }],
      onEvent: ev => events.push(ev),
    });
    Assert.equal(answer, "DEEP_ANSWER");
    Assert.equal(bodies.length, 2, "The light round hands off once");
    const toolNames = body => body.tools.map(tool => tool.function.name);
    Assert.equal(bodies[0].reasoning_effort, "low");
    Assert.ok(toolNames(bodies[0]).includes("think_deeply"));
    Assert.equal(
      bodies[1].reasoning_effort,
      "medium",
      "The handed-off round uses the full reasoning effort"
    );
    Assert.ok(
      !toolNames(bodies[1]).includes("think_deeply") &&
        !bodies[1].messages.some(m => m.tool_calls || m.role === "tool"),
      "The deeper round gets the same conversation without the hand-off call"
    );
    Assert.ok(
      !events.some(
        ev => ev.type?.startsWith("tool_call") && ev.name === "think_deeply"
      ),
      "The hand-off is not shown as a tool step"
    );
    Assert.ok(events.some(ev => ev.type === "deep_think"));
  } finally {
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_deep_mode_searches_until_needs_are_covered() {
  const fixture = startDecideFixtureServer({
    coverageFor: need => (need === "가격" ? 0.1 : 0.9),
  });
  const { server, decideBodies, base } = fixture;
  const llmBodies = [];
  server.registerPathHandler("/chat/completions", (request, response) => {
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    const body = JSON.parse(
      decodeURIComponent(
        escape(stream.read(request.bodyInputStream.available()))
      )
    );
    llmBodies.push(body);
    const searches = body.messages.filter(m => m.role === "tool").length;
    const message =
      searches < 3
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: `call_${searches}`,
                type: "function",
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({
                    queries: [
                      {
                        query: `battery price round ${searches}`,
                        needs: ["배터리 수명", "가격"],
                      },
                    ],
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "DEEP_RESEARCH_ANSWER" };
    response.setHeader("Content-Type", "application/json", false);
    response.write(
      unescape(
        encodeURIComponent(
          JSON.stringify({
            choices: [{ message }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          })
        )
      )
    );
  });
  try {
    await withDecidePrefs(
      base,
      [
        ["browser.agent.decide.speculativeVisits", 0],
        ["browser.agent.deep.maxSearchRounds", 3],
        ["browser.agent.provider", "deepseek"],
        ["browser.agent.apiKey", "test-deepseek-key"],
        ["browser.agent.apiBaseUrl", base],
        ["browser.agent.searchUrlTemplate", `${base}/search?q={searchTerms}`],
      ],
      async () => {
        const answer = await AgentRuntime.chat({
          messages: [{ role: "user", content: "배터리 수명과 가격 비교" }],
          mode: "deep",
        });
        Assert.equal(answer, "DEEP_RESEARCH_ANSWER");
        Assert.ok(
          llmBodies[0].messages
            .findLast(m => m.role === "user")
            .content.includes("<research_mode>deep"),
          "Deep mode asks for a thorough plan on the latest user turn"
        );
        Assert.equal(
          llmBodies[0].messages[0].content,
          SYSTEM_PROMPT,
          "Both modes share the cached system prompt"
        );
        Assert.equal(
          llmBodies.length,
          4,
          "Three search rounds while a need stays thin, then the answer"
        );
        for (const body of llmBodies.slice(1, 3)) {
          const tools = body.messages.filter(m => m.role === "tool");
          Assert.ok(
            tools.every(m => !m.content.includes("BODY_")) &&
              tools.at(-1).content.includes("still missing or thin") &&
              tools
                .slice(0, -1)
                .every(m => !m.content.includes("still missing or thin")),
            "Planning turns see compact reports; only the newest names the gap"
          );
        }
        const finalTools = llmBodies[3].messages.filter(m => m.role === "tool");
        Assert.equal(finalTools.length, 3);
        Assert.ok(
          finalTools.every(m => m.content.includes("BODY_relevant")),
          "The answer turn gets every full report"
        );
        Assert.equal(
          decideBodies.filter(body => body.state.needs).length,
          3,
          "Every deep search round is judged"
        );
      }
    );
  } finally {
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_headless_skips_files_and_downloads() {
  const server = new HttpServer();
  server.registerPathHandler("/report", (request, response) => {
    response.setHeader("Content-Type", "application/pdf", false);
    response.write("%PDF-1.4\n%fake\n");
  });
  server.registerPathHandler("/attachment", (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="page.html"',
      false
    );
    response.write("<!doctype html><p>download me</p>");
  });
  server.start(-1);
  const base = `http://localhost:${server.identity.primaryPort}`;
  const { Downloads } = ChromeUtils.importESModule(
    "resource://gre/modules/Downloads.sys.mjs"
  );
  const list = await Downloads.getList(Downloads.ALL);
  try {
    for (const [path, reason] of [
      ["/report", "PDF 파일"],
      ["/attachment", "다운로드 파일"],
    ]) {
      const startedAt = Date.now();
      let error = null;
      try {
        await AgentHeadless.observeUrl(`${base}${path}`, { timeoutMs: 5000 });
      } catch (e) {
        error = e;
      }
      Assert.ok(error?.unreadable, `${path} is not read`);
      Assert.ok(error.message.includes(reason), error.message);
      Assert.less(
        Date.now() - startedAt,
        5000,
        "The load fails as soon as the response arrives"
      );
    }
    const downloads = await list.getAll();
    Assert.ok(
      !downloads.some(download => download.source.url.startsWith(base)),
      "Nothing from the headless pages reaches the downloads list"
    );
  } finally {
    await new Promise(resolve => server.stop(resolve));
  }
});
