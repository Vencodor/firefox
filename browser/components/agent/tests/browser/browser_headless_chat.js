/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  AgentHeadless,
  normalizeUrlForDedup,
  createParagraphDeduplicator,
  computeAdaptiveHeadlessBudget,
} = ChromeUtils.importESModule(
  "resource:///modules/agent/AgentHeadless.sys.mjs"
);
const {
  SYSTEM_PROMPT,
  stripSourceSections,
  extractTabTitleTag,
  deriveConciseTabTitle,
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
    page.text.includes("Alpha") || page.links.length > 0,
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

    response.setHeader("Content-Type", "application/json; charset=utf-8", false);
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
    4000,
    "Default headless page extraction timeout is 4000ms (4 seconds)"
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
    const effortSlider = doc.getElementById("chat-effort-slider");
    Assert.ok(
      effortSlider &&
        effortSlider.min === "1" &&
        effortSlider.max === "3" &&
        effortSlider.step === "1",
      "3-step horizontal effort level slider is rendered in the composer actions"
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

    const headlessCards = doc.querySelectorAll(".chat-headless-card");
    Assert.equal(
      headlessCards.length,
      4,
      "All 4 headless browser instances (search + timed-out Rank #1 + Rank #2 + fallback Rank #3) are shown in UI"
    );
    const timedOutCard = Array.from(headlessCards).find(
      c => c.dataset.phase === "error"
    );
    Assert.ok(
      timedOutCard &&
        timedOutCard
          .querySelector(".chat-headless-phase")
          .textContent.includes("지연 건너뜀"),
      "Timed-out Rank #1 card shows timeout skip indicator"
    );
    Assert.ok(
      !doc.getElementById("chat-headless-monitor").hidden,
      "Header headless browser monitor is visible"
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
    const result = await AgentHeadless.search(
      ["mono alpha", "mono beta"],
      {
        searchUrlTemplate: `${baseUrl}/search?q={searchTerms}`,
        maxPagesToVisit: 2,
      }
    );

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
        SYSTEM_PROMPT.includes("Answer directly on Step 1 WITHOUT calling any tool") &&
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
    Assert.ok(
      deriveConciseTabTitle("2026년 최신 반도체 공정 기술 트렌드에 대해 자세히 알려줘").length <=
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
    } finally {
      for (const res of stalledResponses) {
        try {
          res.finish();
        } catch {}
      }
      await new Promise(resolve => server.stop(resolve));
    }
  }
);

