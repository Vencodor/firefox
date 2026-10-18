/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AgentHeadless } from "resource:///modules/agent/AgentHeadless.sys.mjs";

/**
 * ============================================================================
 * DeepSeek V4.1 Flash (deepseek-flash) 기본 설정
 * - 여기에 직접 DEFAULT_API_KEY를 입력하거나,
 * - about:config 에서 `browser.agent.apiKey` 값을 설정하거나,
 * - OS 환경변수 `DEEPSEEK_API_KEY`를 설정할 수 있습니다.
 * ============================================================================
 */
export const DEFAULT_API_KEY = "";
export const DEFAULT_API_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-flash";
export const DEFAULT_THINKING_ENABLED = true;

const PREF_API_KEY = "browser.agent.apiKey";
const PREF_API_BASE_URL = "browser.agent.apiBaseUrl";
const PREF_MODEL = "browser.agent.model";
const PREF_THINKING = "browser.agent.thinking";
const MAX_TOOL_ROUNDS = 2;

export const SYSTEM_PROMPT = [
  "<instructions>",
  "<tab_title_protocol>",
  "- On the FIRST turn only, summarize the user's core query intent into a concise 2-5 word title (in the user's language) for the browser tab.",
  "- If calling a tool on the first turn, pass this summary in the tool's `tabTitle` parameter.",
  "- If answering directly on the first turn without calling a tool, prepend `<tab_title>Concise Title</tab_title>` at the very start of your response.",
  "</tab_title_protocol>",
  "",
  "<retrieval_protocol>",
  "- Answer directly on Step 1 WITHOUT calling any tool if the query is general knowledge, conceptual, math, coding, translation, or stable facts.",
  "- Call `web_search` ONLY when up-to-date events, live data, or specific external verification is required.",
  "- Once `web_search` returns sufficient context to answer the core question, answer immediately; do NOT call additional tools.",
  "- For multi-aspect searches, pass 2-4 sub-queries in `web_search.queries` in a single turn rather than chaining sequential searches.",
  "</retrieval_protocol>",
  "",
  "<output_protocol>",
  "- Language: Match the user's language (default: Korean).",
  "- Conciseness (Answer-First): Start immediately with the core conclusion in 1-2 sentences. Skip introductory greetings, filler, and closing remarks.",
  "- Length Budget: Keep responses compact (3-6 bullet points or a short table; under ~250 words) unless the user explicitly asks for a detailed/long explanation.",
  "- Format: Scannable Markdown (short headings, bullet points, bold key terms).",
  "- NO SOURCES: Never output source URLs, website links, domain names, inline citations, or any 'Sources / References / 출처' section.",
  "</output_protocol>",
  "</instructions>",
].join("\n");

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Use ONLY when live/recent web data or external verification is needed. Executes parallel headless Google searches and extracts top result pages.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Single search query string.",
          },
          queries: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of 2-4 sub-queries to execute in parallel for multi-faceted questions.",
          },
          maxPagesToVisit: {
            type: "integer",
            description:
              "Target number of top result pages to extract (default: dynamic 2-4, max: 8).",
          },
          tabTitle: {
            type: "string",
            description:
              "Concise 2-5 word summary of the user's query intent for the browser tab title (include on the first turn).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_web_page",
      description:
        "Use ONLY when the user provides specific URL(s) to read. Opens URLs concurrently in headless browsers.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Single http/https URL to extract.",
          },
          urls: {
            type: "array",
            items: { type: "string" },
            description: "Array of http/https URLs to extract in parallel.",
          },
          tabTitle: {
            type: "string",
            description:
              "Concise 2-5 word summary of the user's query intent for the browser tab title (include on the first turn).",
          },
        },
      },
    },
  },
];

export function extractTabTitleTag(rawText) {
  const str = String(rawText || "");
  const match = str.match(/<tab_title>([\s\S]*?)<\/tab_title>/i);
  if (!match) {
    return { tabTitle: "", cleanedText: str };
  }
  const tabTitle = match[1].replace(/\s+/g, " ").trim();
  const cleanedText = str
    .replace(/^\s*<tab_title>[\s\S]*?<\/tab_title>\s*/i, "")
    .replace(/<tab_title>[\s\S]*?<\/tab_title>/gi, "");
  return { tabTitle, cleanedText };
}

export function stripSourceSections(rawText) {
  const { cleanedText } = extractTabTitleTag(rawText);
  return cleanedText.replace(
    /(?:\r?\n|^)#{1,4}\s*(?:출처|참고\s*자료|참고\s*문헌|Sources?|References?)\s*(?:\r?\n[\s\S]*$|$)/i,
    ""
  );
}

export function deriveConciseTabTitle(
  messagesOrQuery,
  toolCalls = [],
  reasoning = ""
) {
  const fromReasoning = extractTabTitleTag(reasoning).tabTitle;
  if (fromReasoning) {
    return fromReasoning.slice(0, 36);
  }
  for (const tc of toolCalls || []) {
    try {
      const args = JSON.parse(tc?.function?.arguments || "{}");
      if (typeof args.tabTitle === "string" && args.tabTitle.trim()) {
        return args.tabTitle.replace(/\s+/g, " ").trim().slice(0, 36);
      }
      if (Array.isArray(args.queries) && args.queries[0]) {
        return String(args.queries[0]).replace(/\s+/g, " ").trim().slice(0, 36);
      }
      if (typeof args.query === "string" && args.query.trim()) {
        return args.query.replace(/\s+/g, " ").trim().slice(0, 36);
      }
    } catch {}
  }
  let firstUserText = "";
  if (typeof messagesOrQuery === "string") {
    firstUserText = messagesOrQuery.trim();
  } else if (Array.isArray(messagesOrQuery)) {
    const userMsgs = messagesOrQuery.filter(m => m?.role === "user");
    firstUserText = String(userMsgs[0]?.content || "").trim();
  }
  if (!firstUserText) {
    return "";
  }
  const condensed = firstUserText
    .replace(
      /\s*(?:에\s*대해서?|에\s*관해서?)?\s*(?:검색해서\s*)?(?:자세히\s*|간단히\s*)?(?:알려주세요|알려줘|설명해줘|설명해주세요|정리해줘|정리해주세요|검색해줘|검색해주세요|무엇인가요|뭔가요|궁금합니다)[?.!\s]*$/i,
      ""
    )
    .replace(/[?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (condensed || firstUserText).slice(0, 28).trim();
}

function resolveCompletionsEndpoint(baseUrl) {
  const trimmed = String(baseUrl || DEFAULT_API_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(String(text).length / 3));
}

function normalizeUsage(rawUsage, { promptText, reasoningContent, content, toolCalls }) {
  if (rawUsage && typeof rawUsage === "object") {
    const promptTokens = Number(rawUsage.prompt_tokens) || 0;
    const completionTokens = Number(rawUsage.completion_tokens) || 0;
    const reasoningTokens =
      Number(rawUsage.completion_tokens_details?.reasoning_tokens) ||
      Number(rawUsage.reasoning_tokens) ||
      (reasoningContent ? estimateTokens(reasoningContent) : 0);
    const totalTokens =
      Number(rawUsage.total_tokens) || promptTokens + completionTokens;
    const cacheHitTokens = Number(rawUsage.prompt_cache_hit_tokens) || 0;
    return {
      promptTokens,
      reasoningTokens,
      completionTokens,
      totalTokens,
      cacheHitTokens,
      estimated: false,
    };
  }

  const promptTokens = estimateTokens(promptText);
  const reasoningTokens = estimateTokens(reasoningContent);
  const toolText = toolCalls?.length ? JSON.stringify(toolCalls) : "";
  const answerTokens = estimateTokens(content) + estimateTokens(toolText);
  const completionTokens = reasoningTokens + answerTokens;
  return {
    promptTokens,
    reasoningTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitTokens: 0,
    estimated: true,
  };
}

async function parseStreamOrJsonResponse(
  response,
  { round, promptText, onContentDelta, onEvent, signal }
) {
  const startedAt = Date.now();
  let thinkingStartAt = 0;
  let thinkingEndAt = 0;
  let emittedTabTitle = "";
  const contentType = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  if (!contentType.includes("text/event-stream") || !response.body) {
    const data = await response.json();
    const durationMs = Date.now() - startedAt;
    const choice = data?.choices?.[0]?.message || {};
    const rawContent = typeof choice.content === "string" ? choice.content : "";
    const { tabTitle, cleanedText } = extractTabTitleTag(rawContent);
    const content = stripSourceSections(cleanedText);
    if (tabTitle && round === 0) {
      emittedTabTitle = tabTitle;
      onEvent?.({ type: "tab_title", title: tabTitle });
    }
    const reasoningContent =
      typeof choice.reasoning_content === "string"
        ? choice.reasoning_content
        : "";
    const toolCalls = Array.isArray(choice.tool_calls)
      ? choice.tool_calls
      : [];

    if (reasoningContent) {
      onEvent?.({ type: "thinking_start", round });
      onEvent?.({ type: "thinking_delta", round, delta: reasoningContent });
      onEvent?.({
        type: "thinking_done",
        round,
        reasoningContent,
        durationMs,
      });
    }
    if (content && !toolCalls.length) {
      onContentDelta?.(content);
    }
    const usage = normalizeUsage(data?.usage, {
      promptText,
      reasoningContent,
      content: rawContent,
      toolCalls,
    });
    return {
      content,
      reasoningContent,
      toolCalls,
      usage,
      durationMs,
      thinkingMs: reasoningContent ? Math.round(durationMs * 0.5) : 0,
      emittedTabTitle,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawStreamContent = "";
  let streamedVisibleLen = 0;
  let tabTagResolved = round !== 0;
  let reasoningContent = "";
  let rawUsage = null;
  let thinkingStarted = false;
  let thinkingFinished = false;
  const toolCallsByIndex = new Map();

  const finishThinkingIfNeeded = () => {
    if (thinkingStarted && !thinkingFinished) {
      thinkingFinished = true;
      thinkingEndAt = Date.now();
      onEvent?.({
        type: "thinking_done",
        round,
        reasoningContent,
        durationMs: Math.max(0, thinkingEndAt - thinkingStartAt),
      });
    }
  };

  const flushVisibleContentDelta = (force = false) => {
    if (toolCallsByIndex.size > 0) {
      return;
    }
    if (!tabTagResolved) {
      const trimmedStart = rawStreamContent.trimStart();
      if (!trimmedStart) {
        return;
      }
      if ("<tab_title>".startsWith(trimmedStart.slice(0, 11).toLowerCase())) {
        const endMatch = rawStreamContent.match(
          /<tab_title>([\s\S]*?)<\/tab_title>\s*/i
        );
        if (endMatch) {
          emittedTabTitle = endMatch[1].replace(/\s+/g, " ").trim();
          if (emittedTabTitle) {
            onEvent?.({ type: "tab_title", title: emittedTabTitle });
          }
          tabTagResolved = true;
        } else if (!force && rawStreamContent.length < 100) {
          return;
        } else {
          tabTagResolved = true;
        }
      } else {
        tabTagResolved = true;
      }
    }

    const { cleanedText } = extractTabTitleTag(rawStreamContent);
    if (cleanedText.length > streamedVisibleLen) {
      const nextSlice = cleanedText.slice(streamedVisibleLen);
      streamedVisibleLen = cleanedText.length;
      onContentDelta?.(nextSlice);
    }
  };

  const processLine = line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed?.usage) {
      rawUsage = parsed.usage;
    }
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) {
      return;
    }
    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content
    ) {
      if (!thinkingStarted) {
        thinkingStarted = true;
        thinkingStartAt = Date.now();
        onEvent?.({ type: "thinking_start", round });
      }
      reasoningContent += delta.reasoning_content;
      onEvent?.({
        type: "thinking_delta",
        round,
        delta: delta.reasoning_content,
      });
    }
    if (Array.isArray(delta.tool_calls)) {
      finishThinkingIfNeeded();
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolCallsByIndex.get(idx);
        if (!entry) {
          entry = {
            id: tc.id || `call_${round}_${idx}`,
            type: "function",
            function: { name: "", arguments: "" },
          };
          toolCallsByIndex.set(idx, entry);
        }
        if (tc.id) {
          entry.id = tc.id;
        }
        if (tc.function?.name) {
          entry.function.name += tc.function.name;
        }
        if (tc.function?.arguments) {
          entry.function.arguments += tc.function.arguments;
        }
        onEvent?.({
          type: "tool_call_delta",
          round,
          index: idx,
          id: entry.id,
          name: entry.function.name,
          argumentsText: entry.function.arguments,
        });
      }
    }
    if (typeof delta.content === "string" && delta.content) {
      finishThinkingIfNeeded();
      rawStreamContent += delta.content;
      flushVisibleContentDelta(false);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        processLine(line);
      }
    }
    finishThinkingIfNeeded();
    flushVisibleContentDelta(true);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const durationMs = Date.now() - startedAt;
  const thinkingMs =
    thinkingStarted && thinkingEndAt >= thinkingStartAt
      ? thinkingEndAt - thinkingStartAt
      : 0;
  const toolCalls = Array.from(toolCallsByIndex.values());
  const { tabTitle, cleanedText } = extractTabTitleTag(rawStreamContent);
  if (tabTitle && round === 0 && !emittedTabTitle) {
    emittedTabTitle = tabTitle;
    onEvent?.({ type: "tab_title", title: tabTitle });
  }
  const content = stripSourceSections(cleanedText);
  const usage = normalizeUsage(rawUsage, {
    promptText,
    reasoningContent,
    content: rawStreamContent,
    toolCalls,
  });

  return {
    content,
    reasoningContent,
    toolCalls,
    usage,
    durationMs,
    thinkingMs,
    emittedTabTitle,
  };
}

export const AgentRuntime = {
  getConfig() {
    const apiKey = (
      Services.prefs.getStringPref(PREF_API_KEY, "") ||
      Services.env.get("DEEPSEEK_API_KEY") ||
      DEFAULT_API_KEY
    ).trim();
    const apiBaseUrl = (
      Services.prefs.getStringPref(PREF_API_BASE_URL, DEFAULT_API_BASE_URL) ||
      DEFAULT_API_BASE_URL
    ).trim();
    const hasCustomModel = Services.prefs.prefHasUserValue(PREF_MODEL);
    const model = (
      (hasCustomModel
        ? Services.prefs.getStringPref(PREF_MODEL, DEFAULT_MODEL)
        : DEFAULT_MODEL) || DEFAULT_MODEL
    ).trim();
    const thinking = Services.prefs.getBoolPref(
      PREF_THINKING,
      DEFAULT_THINKING_ENABLED
    );

    return {
      apiKey,
      apiBaseUrl,
      endpoint: resolveCompletionsEndpoint(apiBaseUrl),
      model,
      thinking,
    };
  },

  isConfigured() {
    return Boolean(this.getConfig().apiKey);
  },

  async executeToolCall(toolCall, { signal, onEvent } = {}) {
    const name = toolCall?.function?.name;
    let args = {};
    try {
      args = JSON.parse(toolCall?.function?.arguments || "{}");
    } catch {
      args = {};
    }

    const forwardHeadlessEvent = headlessEvent => {
      onEvent?.({
        ...headlessEvent,
        toolCallId: toolCall.id,
        toolName: name,
      });
    };

    if (name === "web_search") {
      const queryList = [];
      if (Array.isArray(args.queries)) {
        for (const q of args.queries) {
          const trimmed = String(q || "").trim();
          if (trimmed) {
            queryList.push(trimmed);
          }
        }
      }
      if (args.query) {
        const single = String(args.query || "").trim();
        if (single && !queryList.includes(single)) {
          queryList.push(single);
        }
      }
      if (!queryList.length) {
        return "Error: Missing required parameter 'query' or 'queries'.";
      }
      const maxPagesToVisit = Number.isFinite(args.maxPagesToVisit)
        ? Math.min(8, Math.max(0, args.maxPagesToVisit))
        : undefined;
      const searchResult = await AgentHeadless.search(queryList, {
        ...(maxPagesToVisit !== undefined ? { maxPagesToVisit } : {}),
        signal,
        onEvent: forwardHeadlessEvent,
      });
      if (searchResult.dedupStats) {
        onEvent?.({
          type: "search_dedup_stats",
          toolCallId: toolCall.id,
          dedupStats: searchResult.dedupStats,
        });
      }
      return searchResult.formattedContext;
    }

    if (name === "read_web_page") {
      const urlList = Array.isArray(args.urls)
        ? args.urls.map(u => String(u || "").trim()).filter(Boolean)
        : args.url
          ? [String(args.url).trim()]
          : [];
      if (!urlList.length) {
        return "Error: Missing required parameter 'url' or 'urls'.";
      }
      const pages = await AgentHeadless.observeUrlsConcurrently(urlList, {
        signal,
        onEvent: forwardHeadlessEvent,
        purposePrefix: "direct-page",
      });
      return pages
        .map((page, idx) => {
          if (page.error) {
            return `[Document #${idx + 1}]: Skipped (${page.error})`;
          }
          return [
            `[Document #${idx + 1} — ${page.title || "Document"}]:`,
            page.text || "(No text extracted)",
          ].join("\n");
        })
        .join("\n\n---\n\n");
    }

    return `Error: Unknown tool '${name}'.`;
  },

  /**
   * Main entry point for `CustomAgentUI` / `AgentChatPage`.
   *
   * @param {object} params
   * @param {string} params.conversationId
   * @param {Array<{role: string, content: string}>} params.messages
   * @param {AbortSignal} [params.signal]
   * @param {(delta: string) => void} [params.onDelta]
   * @param {(event: object) => void} [params.onEvent]
   * @returns {Promise<string>}
   */
  async chat({ messages, signal, onDelta, onEvent }) {
    const config = this.getConfig();
    if (!config.apiKey) {
      const guide = [
        "LLM API 키가 아직 등록되지 않았습니다.",
        "다음 중 한 가지 방법으로 API 키를 등록해 주세요:",
        "1. `about:config`에서 `browser.agent.apiKey` 문자열 값에 API 키 입력",
        "2. `browser/components/agent/AgentRuntime.sys.mjs` 상단의 `DEFAULT_API_KEY`에 입력",
        "3. `DEEPSEEK_API_KEY` 환경 변수 설정",
      ].join("\n");
      onDelta?.(guide);
      return guide;
    }

    const requestStartedAt = Date.now();
    const debugSteps = [];
    const totals = {
      promptTokens: 0,
      reasoningTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      estimated: false,
    };

    const conversation = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(messages || []).map(({ role, content }) => ({ role, content })),
    ];

    let retrievalSufficient = false;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const allowTools = round < MAX_TOOL_ROUNDS && !retrievalSufficient;
      const body = {
        model: config.model,
        messages: conversation,
        stream: true,
        stream_options: { include_usage: true },
        thinking: {
          type: config.thinking ? "enabled" : "disabled",
        },
        ...(allowTools ? { tools: AGENT_TOOLS, tool_choice: "auto" } : {}),
      };

      const promptText = JSON.stringify(conversation);
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        let errorText = "";
        try {
          errorText = await response.text();
        } catch {}
        throw new Error(
          `LLM API error (${response.status}): ${errorText.slice(0, 300)}`
        );
      }

      const {
        content,
        reasoningContent,
        toolCalls,
        usage,
        durationMs,
        thinkingMs,
        emittedTabTitle,
      } = await parseStreamOrJsonResponse(response, {
        round,
        promptText,
        onContentDelta: onDelta,
        onEvent,
        signal,
      });

      if (round === 0 && !emittedTabTitle) {
        const resolvedTitle = deriveConciseTabTitle(
          messages,
          toolCalls,
          reasoningContent
        );
        if (resolvedTitle) {
          onEvent?.({ type: "tab_title", title: resolvedTitle });
        }
      }

      totals.promptTokens += usage.promptTokens;
      totals.reasoningTokens += usage.reasoningTokens;
      totals.completionTokens += usage.completionTokens;
      totals.totalTokens += usage.totalTokens;
      totals.cacheHitTokens += usage.cacheHitTokens;
      totals.estimated ||= usage.estimated;

      debugSteps.push({
        category: "llm",
        step: `LLM Step ${round + 1}`,
        detail: toolCalls.length
          ? `CoT 추론 (${thinkingMs}ms) + 도구 호출 (${toolCalls.length}개)`
          : `CoT 추론 (${thinkingMs}ms) + 최종 응답 생성`,
        durationMs,
        promptTokens: usage.promptTokens,
        reasoningTokens: usage.reasoningTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        estimated: usage.estimated,
      });

      if (!toolCalls.length) {
        onEvent?.({
          type: "chat_metrics",
          metrics: {
            model: config.model,
            totalDurationMs: Date.now() - requestStartedAt,
            steps: debugSteps,
            totals,
          },
        });
        return content;
      }

      conversation.push({
        role: "assistant",
        content: content || "",
        reasoning_content: reasoningContent || "",
        tool_calls: toolCalls,
      });

      // Execute all tool calls in this turn concurrently via Promise.all
      const toolResults = await Promise.all(
        toolCalls.map(async toolCall => {
          if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(toolCall?.function?.arguments || "{}");
          } catch {}

          const startedAt = Date.now();
          const toolName = toolCall.function?.name || "tool";
          onEvent?.({
            type: "tool_call_start",
            round,
            id: toolCall.id,
            name: toolName,
            args: parsedArgs,
            argumentsText: toolCall.function?.arguments || "",
          });

          const headlessSubSteps = [];
          let dedupStats = null;
          const interceptEvent = ev => {
            if (ev.type === "search_dedup_stats") {
              dedupStats = ev.dedupStats;
            }
            if (ev.type === "headless_done" || ev.type === "headless_error") {
              headlessSubSteps.push({
                category: "headless",
                step: `  ↳ Headless (${ev.purpose || "page"})`,
                detail:
                  ev.type === "headless_done"
                    ? `${ev.title || ev.url} (로드 ${ev.loadMs ?? 0}ms / 관찰 ${ev.observeMs ?? 0}ms · ${ev.textLength ?? 0}자)`
                    : `${ev.url} (오류: ${ev.error})`,
                durationMs: ev.durationMs ?? 0,
              });
            }
            onEvent?.(ev);
          };

          let toolOutput;
          let isError = false;
          try {
            toolOutput = await this.executeToolCall(toolCall, {
              signal,
              onEvent: interceptEvent,
            });
          } catch (error) {
            if (error?.name === "AbortError") {
              throw error;
            }
            isError = true;
            toolOutput = `Tool execution failed: ${error?.message || String(error)}`;
          }

          const toolDurationMs = Date.now() - startedAt;
          onEvent?.({
            type: "tool_call_done",
            round,
            id: toolCall.id,
            name: toolName,
            args: parsedArgs,
            output: toolOutput,
            durationMs: toolDurationMs,
            dedupStats,
            isError,
          });

          return {
            toolCall,
            toolName,
            parsedArgs,
            toolOutput,
            toolDurationMs,
            dedupStats,
            headlessSubSteps,
          };
        })
      );

      let roundCollectedChars = 0;
      let roundExtractedDocs = 0;

      for (const res of toolResults) {
        if (!res.isError && res.toolOutput) {
          roundCollectedChars += res.toolOutput.length;
          const docMatches = res.toolOutput.match(/\[Extracted Document #/g);
          roundExtractedDocs += docMatches ? docMatches.length : 0;
        }
        const argSummary = Array.isArray(res.parsedArgs?.queries)
          ? res.parsedArgs.queries.join(" | ")
          : res.parsedArgs?.query ||
            res.parsedArgs?.url ||
            (Array.isArray(res.parsedArgs?.urls)
              ? res.parsedArgs.urls.join(", ")
              : "");
        const ds = res.dedupStats;
        const extraNotes = [];
        if (ds?.headlessConcurrency) {
          extraNotes.push(`Headless ${ds.headlessConcurrency}개`);
        }
        if (ds?.earlyStoppedCount > 0) {
          extraNotes.push(`조기 종료 ${ds.earlyStoppedCount}개`);
        }
        if (
          ds &&
          (ds.removedParagraphs > 0 || ds.skippedDuplicateUrls > 0)
        ) {
          extraNotes.push(
            `중복 제거(URL ${ds.skippedDuplicateUrls || 0}건, 문단 ${ds.removedParagraphs || 0}개)`
          );
        }
        const suffixNote = extraNotes.length
          ? ` · ${extraNotes.join(" · ")}`
          : "";
        debugSteps.push({
          category: "tool",
          step: `Tool · ${res.toolName}`,
          detail: argSummary
            ? `${argSummary} (수집 ${res.toolOutput.length.toLocaleString()}자${suffixNote})`
            : `수집 ${res.toolOutput.length.toLocaleString()}자${suffixNote}`,
          durationMs: res.toolDurationMs,
          outputTokensEst: estimateTokens(res.toolOutput),
        });
        for (const sub of res.headlessSubSteps) {
          debugSteps.push(sub);
        }
        conversation.push({
          role: "tool",
          tool_call_id: res.toolCall.id,
          name: res.toolName,
          content: res.toolOutput,
        });
      }

      if (roundExtractedDocs >= 1 || roundCollectedChars >= 400) {
        retrievalSufficient = true;
      }
    }

    onEvent?.({
      type: "chat_metrics",
      metrics: {
        model: config.model,
        totalDurationMs: Date.now() - requestStartedAt,
        steps: debugSteps,
        totals,
      },
    });
    return "";
  },
};

export const AgentChatAdapter = {
  chat(request) {
    return AgentRuntime.chat(request);
  },
};
