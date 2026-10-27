/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AgentHeadless,
  normalizeUrlForDedup,
} from "resource:///modules/agent/AgentHeadless.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

/**
 * ============================================================================
 * LLM 공급자 설정 (about:config)
 * - `browser.agent.provider`: "deepseek"(기본) 또는 "mercury"
 * - DeepSeek V4.1 Flash: `browser.agent.apiKey` / `apiBaseUrl` / `model`,
 *   또는 OS 환경변수 `DEEPSEEK_API_KEY`
 * - Inception Mercury 3: `browser.agent.mercury.apiKey` / `apiBaseUrl` /
 *   `model` / `reasoningEffort`, 또는 OS 환경변수 `INCEPTION_API_KEY`
 * ============================================================================
 */
export const DEFAULT_API_KEY = "";
export const DEFAULT_API_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-flash";
export const DEFAULT_THINKING_ENABLED = true;

const PREF_PROVIDER = "browser.agent.provider";
const PREF_THINKING = "browser.agent.thinking";
const PREF_FINAL_THINKING = "browser.agent.finalThinking";
const MAX_TOOL_ROUNDS = 2;
const PREF_DEEP_MAX_SEARCH_ROUNDS = "browser.agent.deep.maxSearchRounds";
const PREF_DEEP_COVERAGE_THRESHOLD = "browser.agent.deep.coverageThreshold";

/**
 * Differences between OpenAI-compatible providers: where their settings live,
 * how thinking is requested, and whether reasoning text must be sent back on
 * tool-call turns.
 */
export const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    prefPrefix: "browser.agent",
    envKey: "DEEPSEEK_API_KEY",
    defaultBaseUrl: DEFAULT_API_BASE_URL,
    defaultModel: DEFAULT_MODEL,
    echoReasoning: true,
    retryWithThinkingOn400: true,
    reasoningParams: useThinking => ({
      thinking: { type: useThinking ? "enabled" : "disabled" },
    }),
  },
  mercury: {
    label: "Inception Mercury",
    prefPrefix: "browser.agent.mercury",
    envKey: "INCEPTION_API_KEY",
    defaultBaseUrl: "https://api.inceptionlabs.ai/v1",
    defaultModel: "mercury-3",
    echoReasoning: false,
    retryWithThinkingOn400: false,
    supportsDiffusing: true,
    // Tool rounds think lightly; think_deeply hands hard questions to
    // reasoningEffort.
    supportsDeepThink: true,
    reasoningParams: (useThinking, config, effort) => ({
      reasoning_effort: useThinking ? effort || config.reasoningEffort : "low",
    }),
  },
};

function getProviderStringPref(provider, name, fallback) {
  const pref = `${provider.prefPrefix}.${name}`;
  return (
    (Services.prefs.prefHasUserValue(pref)
      ? Services.prefs.getStringPref(pref, fallback)
      : fallback) || fallback
  ).trim();
}

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
  "- When the `think_deeply` tool is offered and answering well needs careful multi-step reasoning, call it instead of answering yourself.",
  "- Call `web_search` ONLY when up-to-date events, live data, or specific external verification is required.",
  "- Once `web_search` returns sufficient context to answer the core question, answer immediately; do NOT call additional tools.",
  "- Use as few searches as possible: one broad query usually covers several related facts, since Google matches loosely. Add a second query only for an unrelated aspect. Each `web_search.queries` item lists the pieces of information it should find (`needs`, short phrases in the user's language).",
  "- Prefer sub-queries and follow-up searches that differ meaningfully from ones already run; near-duplicate rewordings rarely add results.",
  "- Treat `<current_datetime>` in the latest user message as now; resolve relative dates (today, this week, latest) against it and include the year or date in search queries when recency matters.",
  "</retrieval_protocol>",
  "",
  "<output_protocol>",
  "- Language: Match the user's language (default: Korean).",
  "- Conciseness (Answer-First): Start immediately with the core conclusion in 1-2 sentences. Skip introductory greetings, filler, and closing remarks.",
  "- Length Budget: Keep responses compact (3-6 bullet points or a short table; under ~250 words) unless the user explicitly asks for a detailed/long explanation.",
  "- Format: Scannable Markdown (short headings, bullet points, bold key terms).",
  "- Citations: When a statement relies on web results, put their source numbers right after it, e.g. `[1]` or `[2][3]`, using only the numbers shown in the tool results. Never output URLs, website links, domain names, or any 'Sources / References / 출처' section.",
  "</output_protocol>",
  "</instructions>",
].join("\n");

export const DEEP_THINK_TOOL_NAME = "think_deeply";

// Offered to light-reasoning tool rounds only. Calling it re-asks the same
// conversation with the full reasoning effort instead of running a tool.
const DEEP_THINK_TOOL = {
  type: "function",
  function: {
    name: DEEP_THINK_TOOL_NAME,
    description:
      "Hands the question to a stronger reasoning pass that writes the answer. Call it instead of answering when the question needs careful multi-step reasoning: math, logic, nontrivial code, or a careful analysis or comparison. It may be called together with web_search so the final answer is written with deeper reasoning. Never call it for simple questions.",
    parameters: { type: "object", properties: {} },
  },
};

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
          queries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The search query.",
                },
                needs: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The pieces of information this query should find, as short phrases.",
                },
              },
              required: ["query", "needs"],
            },
            description:
              "Usually 1 search that covers every need; at most 2, run in parallel.",
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
        required: ["queries"],
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

/**
 * Formats the current local date and time for the model, e.g.
 * `<current_datetime>2026년 10월 19일 월요일 오후 2:32 (Asia/Seoul, UTC+09:00)</current_datetime>`.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function formatCurrentDateTime(now = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const local = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(now);
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `<current_datetime>${local} (${timeZone}, UTC${offset})</current_datetime>`;
}

// The time goes on the latest user turn rather than the system prompt so the
// cached prompt prefix stays the same between requests.
const DEEP_RESEARCH_NOTE =
  "<research_mode>deep: The user wants a thorough, well-supported answer. When the question benefits from web information, first plan every piece of information a complete answer needs (background, current figures, comparisons, caveats) as `needs`, and expect several search rounds; each later round digs into what earlier results left thin.</research_mode>";

// The deep research note rides on the latest user turn too, so both modes
// share one cached system prompt.
function buildConversation(messages, mode) {
  const conversation = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(messages || []).map(({ role, content }) => ({ role, content })),
  ];
  const lastUser = conversation.findLast(m => m.role === "user");
  if (lastUser) {
    const prefix =
      mode === "deep"
        ? `${formatCurrentDateTime()}\n${DEEP_RESEARCH_NOTE}`
        : formatCurrentDateTime();
    lastUser.content = `${prefix}\n${lastUser.content ?? ""}`;
  }
  return conversation;
}

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

export function stripDsmlMarkup(rawText) {
  const str = String(rawText || "");
  return str.replace(/<[\s｜|]*DSML[\s｜|]*[\s\S]*$/i, "").trimEnd();
}

export function stripSourceSections(rawText) {
  const { cleanedText } = extractTabTitleTag(rawText);
  const withoutDsml = stripDsmlMarkup(cleanedText);
  return withoutDsml.replace(
    /(?:\r?\n|^)#{1,4}\s*(?:출처|참고\s*자료|참고\s*문헌|Sources?|References?)\s*(?:\r?\n[\s\S]*$|$)/i,
    ""
  );
}

// Google rate-limits quickly, so one call runs few searches.
const PREF_MAX_SEARCH_QUERIES = "browser.agent.maxSearchQueries";

function readNeeds(item) {
  const list = Array.isArray(item?.needs) ? item.needs : [item?.need];
  return list.map(need => String(need || "").trim()).filter(Boolean);
}

/**
 * Reads the searches of web_search arguments. Items may be `{query, needs}`
 * objects (`need` is accepted too) or plain strings; a single `query` is
 * only used when `queries` is empty, so a model that sends both does not
 * search twice. Searches past browser.agent.maxSearchQueries are dropped and
 * their needs move to the last kept search.
 *
 * @param {object} args
 * @returns {Array<{query: string, needs: Array<string>}>}
 */
export function normalizeSearchItems(args) {
  const max = Math.max(
    1,
    Services.prefs.getIntPref(PREF_MAX_SEARCH_QUERIES, 2)
  );
  const items = [];
  const seen = new Set();
  const add = (query, needs) => {
    const trimmed = String(query || "").trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      return;
    }
    seen.add(key);
    if (items.length < max) {
      items.push({ query: trimmed, needs });
      return;
    }
    const last = items.at(-1);
    last.needs = [...new Set([...last.needs, ...needs])];
  };
  for (const item of Array.isArray(args?.queries) ? args.queries : []) {
    if (item && typeof item === "object") {
      add(item.query, readNeeds(item));
    } else {
      add(item, []);
    }
  }
  if (!items.length) {
    add(args?.query, readNeeds(args));
  }
  return items;
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
      const firstQuery = normalizeSearchItems(args)[0]?.query;
      if (firstQuery) {
        return firstQuery.replace(/\s+/g, " ").trim().slice(0, 36);
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

function normalizeUsage(
  rawUsage,
  { promptText, reasoningContent, content, toolCalls }
) {
  if (rawUsage && typeof rawUsage === "object") {
    const promptTokens = Number(rawUsage.prompt_tokens) || 0;
    const completionTokens = Number(rawUsage.completion_tokens) || 0;
    const reasoningTokens =
      Number(rawUsage.completion_tokens_details?.reasoning_tokens) ||
      Number(rawUsage.reasoning_tokens) ||
      (reasoningContent ? estimateTokens(reasoningContent) : 0);
    const totalTokens =
      Number(rawUsage.total_tokens) || promptTokens + completionTokens;
    const cacheHitTokens =
      Number(rawUsage.prompt_cache_hit_tokens) ||
      Number(rawUsage.prompt_tokens_details?.cached_tokens) ||
      0;
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

// An unfinished `<tab_title>` at the start of a half-refined answer.
const PARTIAL_TAB_TITLE_RE = /^\s*<tab_title>[^<\n]*(?:<\/tab_title>)?\s*/i;

// Diffusing chunks restate the whole text, so they are about as long as what
// has arrived so far; plain stream chunks are short additions.
function isFullStateChunk(chunk, soFar) {
  return !soFar || chunk.length >= soFar.length * 0.8;
}

function isJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return Boolean(value) && typeof value === "object";
  } catch {
    return false;
  }
}

// Tool arguments normally arrive as pieces to append. A chunk that restates
// the complete arguments (diffusing mode, or a provider repeating the call in
// its final chunk) replaces them instead of being glued on twice.
function mergeToolArguments(current, incoming, diffusing) {
  if (diffusing && incoming.trimStart().startsWith("{")) {
    return incoming;
  }
  if (current && isJsonObject(current) && isJsonObject(incoming)) {
    return incoming;
  }
  return current + incoming;
}

// DeepSeek streams `reasoning_content`; OpenRouter-style providers use
// `reasoning`.
function getReasoningText(message) {
  if (typeof message?.reasoning_content === "string") {
    return message.reasoning_content;
  }
  return typeof message?.reasoning === "string" ? message.reasoning : "";
}

async function parseStreamOrJsonResponse(
  response,
  {
    round,
    promptText,
    diffusing = false,
    onContentDelta,
    onEvent,
    onToolCallReady,
    signal,
  }
) {
  const startedAt = Date.now();
  let firstTokenAt = 0;
  let firstContentAt = 0;
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
    const reasoningContent = getReasoningText(choice);
    const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    firstTokenAt = Date.now();

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
      firstContentAt = Date.now();
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
      firstTokenAt,
      firstContentAt,
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
  const readyToolCallIndexes = new Set();
  const serverIdIndexes = new Set();

  // Lets the caller start a tool while the rest of the stream (usage, stop
  // chunks or further tool calls) is still arriving.
  const maybeNotifyToolCallReady = (idx, entry) => {
    if (
      !onToolCallReady ||
      readyToolCallIndexes.has(idx) ||
      !serverIdIndexes.has(idx) ||
      !entry.function.name ||
      !entry.function.arguments.trimEnd().endsWith("}")
    ) {
      return;
    }
    try {
      JSON.parse(entry.function.arguments);
    } catch {
      return;
    }
    readyToolCallIndexes.add(idx);
    onToolCallReady({
      id: entry.id,
      type: entry.type,
      function: { ...entry.function },
    });
  };

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

  // In diffusing mode each chunk is the whole answer at its current
  // refinement step, so the UI replaces the text instead of appending.
  let lastRefinedText = "";
  const flushRefinedContent = () => {
    if (toolCallsByIndex.size > 0 || !onContentDelta) {
      return;
    }
    const visible = stripDsmlMarkup(
      extractTabTitleTag(rawStreamContent).cleanedText.replace(
        PARTIAL_TAB_TITLE_RE,
        ""
      )
    );
    if (visible === lastRefinedText) {
      return;
    }
    lastRefinedText = visible;
    firstContentAt ||= Date.now();
    onEvent?.({ type: "answer_refine", round, text: visible });
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
    const safeVisibleText = stripDsmlMarkup(cleanedText);
    if (safeVisibleText.length > streamedVisibleLen) {
      const nextSlice = safeVisibleText.slice(streamedVisibleLen);
      streamedVisibleLen = safeVisibleText.length;
      firstContentAt ||= Date.now();
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
    // Some providers report failures mid-stream instead of with a status.
    if (parsed?.error) {
      throw new Error(
        `LLM stream error: ${parsed.error.message || JSON.stringify(parsed.error)}`.slice(
          0,
          300
        )
      );
    }
    if (parsed?.usage) {
      rawUsage = parsed.usage;
    }
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) {
      return;
    }
    const reasoningDelta = getReasoningText(delta);
    if (
      !firstTokenAt &&
      (reasoningDelta || delta.content || delta.tool_calls?.length)
    ) {
      firstTokenAt = Date.now();
    }
    if (reasoningDelta) {
      if (!thinkingStarted) {
        thinkingStarted = true;
        thinkingStartAt = Date.now();
        onEvent?.({ type: "thinking_start", round });
      }
      const replace =
        diffusing && isFullStateChunk(reasoningDelta, reasoningContent);
      reasoningContent = replace
        ? reasoningDelta
        : reasoningContent + reasoningDelta;
      onEvent?.({
        type: "thinking_delta",
        round,
        delta: reasoningDelta,
        replace,
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
          serverIdIndexes.add(idx);
        }
        if (tc.function?.name) {
          entry.function.name = diffusing
            ? tc.function.name
            : entry.function.name + tc.function.name;
        }
        if (tc.function?.arguments) {
          entry.function.arguments = mergeToolArguments(
            entry.function.arguments,
            tc.function.arguments,
            diffusing
          );
        }
        // think_deeply is not a tool step the activity shows.
        if (!DEEP_THINK_TOOL_NAME.startsWith(entry.function.name || "-")) {
          onEvent?.({
            type: "tool_call_delta",
            round,
            index: idx,
            id: entry.id,
            name: entry.function.name,
            argumentsText: entry.function.arguments,
          });
        }
        maybeNotifyToolCallReady(idx, entry);
      }
    }
    if (typeof delta.content === "string" && delta.content) {
      finishThinkingIfNeeded();
      if (diffusing) {
        rawStreamContent = delta.content;
        flushRefinedContent();
      } else {
        rawStreamContent += delta.content;
        flushVisibleContentDelta(false);
      }
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
    if (diffusing) {
      flushRefinedContent();
    } else {
      flushVisibleContentDelta(true);
    }
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
    firstTokenAt,
    firstContentAt,
  };
}

// Extracted documents in a tool result. A search the snippet filter judged
// answerable from its snippets counts as one, so no second search follows.
function countRetrievedSources(res) {
  const docs = res.toolOutput.match(/^\[Document \d+ — /gm)?.length || 0;
  return docs || (res.dedupStats?.decide?.answeredBySnippets ? 1 : 0);
}

function latestUserText(messages) {
  return String(messages?.findLast(m => m.role === "user")?.content || "");
}

function describeDecideDetail(ev) {
  const percent = value =>
    value === null || value === undefined ? "?" : `${Math.round(value * 100)}%`;
  if (ev.purpose === "coverage") {
    return ev.error
      ? `정보 충분성 판단 안 함 (${ev.error})`
      : `정보 충분: ${(ev.coverage || [])
          .map(item => `${item.need} ${percent(item.probability)}`)
          .join(" · ")}`;
  }
  if (ev.error) {
    return `판단 안 함 → 모든 결과 방문 (${ev.error})`;
  }
  const parts = [`${ev.query}: 결과 ${ev.considered}개 중 ${ev.kept}개 관련`];
  if (ev.snippetsSufficient !== null && ev.snippetsSufficient !== undefined) {
    parts.push(`스니펫으로 충분 ${percent(ev.snippetsSufficient)}`);
  }
  return parts.join(" · ");
}

function describeDecideStep(ev) {
  const detail = describeDecideDetail(ev);
  // Decide bills input only; output tokens are free.
  const inputTokens = Number(ev.inputTokens) || 0;
  return {
    category: "decide",
    step: `  ↳ Decide (${ev.purpose || "search"})`,
    detail,
    durationMs: ev.durationMs ?? 0,
    promptTokens: inputTokens,
    totalTokens: inputTokens,
  };
}

// Needs the decision model judged as not found. An unanswered need counts as
// found, so a partial judgment never forces another search.
function findCoverageGaps(coverage, threshold = coverage?.threshold) {
  return (coverage?.needs || []).filter(
    item => item.probability !== null && item.probability < threshold
  );
}

/**
 * The tool message for a turn that only plans one more search: the search
 * snippets and titles of the pages read, plus what is still missing. The full
 * report replaces it again before the answer is written.
 *
 * @param {object} res A runToolCall result.
 * @param {Array<object>} gaps From findCoverageGaps.
 * @returns {string}
 */
function buildGapToolContent(res, gaps) {
  const missing = gaps
    .map(item => `- ${item.need} (searched: ${item.queries.join(" | ")})`)
    .join("\n");
  return [
    res.report?.compactContext || res.toolOutput,
    `[System Note]: These information needs are still missing or thin:\n${missing}\nCall web_search once more with a single new query that targets these gaps, phrased differently from the earlier queries. Do not answer yet.`,
  ].join("\n\n");
}

/**
 * Numbers the sources of one answer from 1. A page cited again, by another
 * search or tool, keeps its first number.
 *
 * @returns {{sources: Array<{id: number, url: string, title: string}>, cite: (url: string, title: string) => number}}
 */
function createSourceRegistry() {
  const sources = [];
  const ids = new Map();
  return {
    sources,
    cite(url, title) {
      const key = normalizeUrlForDedup(url) || url;
      if (!ids.has(key)) {
        const id = sources.length + 1;
        ids.set(key, id);
        sources.push({ id, url, title: title || "" });
      }
      return ids.get(key);
    },
  };
}

function isDeepThinkCall(toolCall) {
  return toolCall?.function?.name === DEEP_THINK_TOOL_NAME;
}

function describeToolArgs(name, args) {
  if (name === "web_search") {
    return normalizeSearchItems(args)
      .map(item => item.query)
      .join(" | ");
  }
  return (
    args?.url || (Array.isArray(args?.urls) ? args.urls.join(", ") : "") || ""
  );
}

const SUFFICIENT_NOTE =
  "[System Note]: Sufficient web context has been collected. Synthesize the final answer directly now without calling any further tools.";

/**
 * Adds the tool results of one round to the conversation and the debug
 * steps, and decides what the next round does.
 *
 * @param {Array<object>} conversation
 * @param {Array<object>} debugSteps
 * @param {Array<object>} toolResults From runToolCall.
 * @param {object} options
 * @param {number} options.round
 * @param {number} options.maxToolRounds
 * @param {boolean} options.checkGaps Whether a gap search may follow.
 * @param {number} [options.gapThreshold] Overrides the coverage threshold.
 * @returns {{sufficient: boolean, gapSearch: boolean, records: Array<{message: object, full: string, compact: string, compactBase: string}>}}
 *   With `gapSearch`, the next turn plans a search from the `compact`
 *   contents; every other turn sees `full`.
 */
function appendToolResults(conversation, debugSteps, toolResults, options) {
  const { round, maxToolRounds, checkGaps, gapThreshold } = options;
  let collectedChars = 0;
  let extractedDocs = 0;
  for (const res of toolResults) {
    if (!res.isError && res.toolOutput) {
      collectedChars += res.toolOutput.length;
      extractedDocs += countRetrievedSources(res);
    }
    const argSummary = describeToolArgs(res.toolName, res.parsedArgs);
    const collected = `수집 ${res.toolOutput.length.toLocaleString()}자${describeSearchStats(res.dedupStats)}`;
    debugSteps.push({
      category: "tool",
      step: `Tool · ${res.toolName}`,
      detail: argSummary ? `${argSummary} (${collected})` : collected,
      durationMs: res.toolDurationMs,
      outputTokensEst: estimateTokens(res.toolOutput),
    });
    debugSteps.push(...res.headlessSubSteps);
  }
  const sufficient = extractedDocs >= 1 || collectedChars >= 400;
  const gapsByResult = toolResults.map(res =>
    checkGaps ? findCoverageGaps(res.report?.coverage, gapThreshold) : []
  );
  const gapSearch =
    sufficient &&
    round + 1 < maxToolRounds &&
    gapsByResult.some(gaps => gaps.length);
  const records = toolResults.map((res, i) => {
    const compactBase = res.report?.compactContext || res.toolOutput;
    const record = {
      message: { role: "tool", tool_call_id: res.toolCall.id },
      full:
        !gapSearch && (sufficient || round + 1 >= maxToolRounds)
          ? `${res.toolOutput}\n\n${SUFFICIENT_NOTE}`
          : res.toolOutput,
      compactBase,
      compact: gapsByResult[i].length
        ? buildGapToolContent(res, gapsByResult[i])
        : compactBase,
    };
    record.message.content = gapSearch ? record.compact : record.full;
    conversation.push(record.message);
    return record;
  });
  return { sufficient, gapSearch, records };
}

function describeSearchStats(ds) {
  if (!ds) {
    return "";
  }
  const notes = [];
  if (ds.headlessConcurrency) {
    notes.push(`Headless ${ds.headlessConcurrency}개`);
  }
  if (ds.earlyStoppedCount > 0) {
    notes.push(`조기 종료 ${ds.earlyStoppedCount}개`);
  }
  if (ds.removedParagraphs > 0 || ds.skippedDuplicateUrls > 0) {
    notes.push(
      `중복 제거(URL ${ds.skippedDuplicateUrls || 0}건, 문단 ${ds.removedParagraphs || 0}개)`
    );
  }
  if (ds.decide?.answeredBySnippets) {
    notes.push("스니펫만으로 답변");
  } else if (ds.decide?.dropped > 0) {
    notes.push(
      `Decide 제외 ${ds.decide.dropped}개${ds.decide.cancelled ? `(방문 취소 ${ds.decide.cancelled})` : ""}`
    );
  }
  const gaps = findCoverageGaps(ds.decide?.coverage);
  if (gaps.length) {
    notes.push(`부족한 정보 ${gaps.length}개`);
  }
  if (ds.contextCharsAfter < ds.contextCharsBefore) {
    notes.push(
      `본문 압축 ${ds.contextCharsBefore.toLocaleString()}→${ds.contextCharsAfter.toLocaleString()}자`
    );
  }
  return notes.length ? ` · ${notes.join(" · ")}` : "";
}

function buildMissingKeyGuide({ prefPrefix, envKey, label }) {
  return [
    `${label} API 키가 아직 등록되지 않았습니다.`,
    "다음 중 한 가지 방법으로 API 키를 등록해 주세요:",
    `1. \`about:config\`에서 \`${prefPrefix}.apiKey\` 문자열 값에 API 키 입력`,
    `2. \`${envKey}\` 환경 변수 설정`,
    "공급자는 `browser.agent.provider`(deepseek 또는 mercury)로 바꿀 수 있습니다.",
  ].join("\n");
}

function buildChatMetrics(config, requestStartedAt, steps, totals) {
  const firstContentAt = steps.find(
    step => step.firstContentAt
  )?.firstContentAt;
  return {
    model: config.model,
    provider: config.provider.label,
    totalDurationMs: Date.now() - requestStartedAt,
    firstContentMs: firstContentAt ? firstContentAt - requestStartedAt : 0,
    steps,
    // LLM usage only; the decision model is billed separately.
    totals,
    decideTotals: {
      calls: steps.filter(step => step.category === "decide").length,
      inputTokens: steps
        .filter(step => step.category === "decide")
        .reduce((sum, step) => sum + (step.promptTokens || 0), 0),
    },
  };
}

function buildLlmDebugStep(round, parsed, requestSentAt) {
  const { toolCalls, thinkingMs, usage, firstTokenAt } = parsed;
  const parts = [
    toolCalls.length
      ? `CoT 추론 (${thinkingMs}ms) + 도구 호출 (${toolCalls.length}개)`
      : `CoT 추론 (${thinkingMs}ms) + 최종 응답 생성`,
  ];
  if (firstTokenAt) {
    parts.push(`첫 토큰 ${firstTokenAt - requestSentAt}ms`);
  }
  return {
    category: "llm",
    step: `LLM Step ${round + 1}`,
    detail: parts.join(" · "),
    firstContentAt: parsed.firstContentAt,
    durationMs: Date.now() - requestSentAt,
    promptTokens: usage.promptTokens,
    reasoningTokens: usage.reasoningTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    estimated: usage.estimated,
  };
}

/**
 * Runs one tool call and reports its progress through `onEvent`.
 *
 * @param {object} runtime The AgentRuntime that executes the tool.
 * @param {object} toolCall
 * @param {number} round
 * @param {object} options
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onEvent]
 * @param {string} [options.userQuestion] The latest user message, for the
 *   search result filter.
 * @param {(url: string, title: string) => number} [options.citeSource]
 *   Numbers the sources of the answer.
 * @param {boolean} [options.skipDecide] Searches without the decision model.
 * @returns {Promise<object>} The tool output plus timing and debug details;
 *   `report` holds the sources, the compact report and the need coverage.
 */
async function runToolCall(runtime, toolCall, round, options) {
  const { signal, onEvent, userQuestion, citeSource, skipDecide } = options;
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
  let report = null;
  const interceptEvent = ev => {
    if (ev.type === "search_dedup_stats") {
      dedupStats = ev.dedupStats;
    }
    if (ev.type === "tool_report") {
      report = ev;
      return;
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
    if (ev.type === "decide_done") {
      headlessSubSteps.push(describeDecideStep(ev));
    }
    onEvent?.(ev);
  };

  let toolOutput;
  let isError = false;
  try {
    toolOutput = await runtime.executeToolCall(toolCall, {
      signal,
      onEvent: interceptEvent,
      userQuestion,
      citeSource,
      skipDecide,
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
    report,
    headlessSubSteps,
    isError,
  };
}

// Set once the API rejects a final request with thinking disabled, so later
// requests keep thinking on instead of failing again.
let finalThinkingRejected = false;

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 700;
const MAX_RETRY_DELAY_MS = 3000;

/**
 * fetch() that retries once on a network failure, a rate limit or a
 * temporary server error. A Retry-After header is honored up to
 * MAX_RETRY_DELAY_MS.
 *
 * @param {string} url
 * @param {object} init fetch options; `init.signal` cancels the wait too.
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, init) {
  let response;
  try {
    response = await fetch(url, init);
    if (!RETRYABLE_STATUSES.has(response.status)) {
      return response;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
  }
  const retryAfterSec = Number(response?.headers.get("retry-after"));
  const delayMs = Number.isFinite(retryAfterSec)
    ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAfterSec * 1000))
    : RETRY_DELAY_MS;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    init.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
  return fetch(url, init);
}

// Set when the API rejects a diffusing request, so later requests fall back
// to plain streaming.
let diffusingRejected = false;

/**
 * Sends one chat completion request.
 *
 * @param {object} config From AgentRuntime.getConfig().
 * @param {Array<object>} conversation
 * @param {object} options
 * @param {boolean} options.allowTools
 * @param {boolean} options.thinkingEnabled
 * @param {string} [options.effort] reasoning_effort for providers that take
 *   one.
 * @param {boolean} [options.offerDeepThink] Adds the think_deeply tool.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{response: Response, diffusing: boolean}>} `diffusing` is
 *   true when every streamed chunk carries the full text so far.
 */
async function requestCompletion(config, conversation, options) {
  const { allowTools, thinkingEnabled, effort, offerDeepThink, signal } =
    options;
  const post = (useThinking, useDiffusing) =>
    fetchWithRetry(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: conversation,
        stream: true,
        stream_options: { include_usage: true },
        ...config.provider.reasoningParams(useThinking, config, effort),
        ...(useDiffusing ? { diffusing: true } : {}),
        tools: offerDeepThink ? [...AGENT_TOOLS, DEEP_THINK_TOOL] : AGENT_TOOLS,
        tool_choice: allowTools ? "auto" : "none",
      }),
      signal,
    });

  let useThinking = thinkingEnabled;
  let useDiffusing =
    config.diffusing && config.provider.supportsDiffusing && !diffusingRejected;
  let response = await post(useThinking, useDiffusing);
  if (!response.ok && response.status === 400 && useDiffusing) {
    diffusingRejected = true;
    useDiffusing = false;
    response = await post(useThinking, useDiffusing);
  }
  if (
    !response.ok &&
    response.status === 400 &&
    config.provider.retryWithThinkingOn400 &&
    config.thinking &&
    !useThinking
  ) {
    finalThinkingRejected = true;
    useThinking = true;
    response = await post(useThinking, useDiffusing);
  }
  if (!response.ok) {
    let errorText = "";
    try {
      errorText = await response.text();
    } catch {}
    throw new Error(
      `LLM API error (${response.status}): ${errorText.slice(0, 300)}`
    );
  }
  return { response, diffusing: useDiffusing };
}

export const AgentRuntime = {
  getConfig() {
    const providerId = Services.prefs
      .getStringPref(PREF_PROVIDER, "deepseek")
      .trim()
      .toLowerCase();
    const provider = PROVIDERS[providerId] || PROVIDERS.deepseek;
    const apiKey = (
      Services.prefs.getStringPref(`${provider.prefPrefix}.apiKey`, "") ||
      Services.env.get(provider.envKey) ||
      (provider === PROVIDERS.deepseek ? DEFAULT_API_KEY : "")
    ).trim();
    const apiBaseUrl =
      Services.prefs
        .getStringPref(
          `${provider.prefPrefix}.apiBaseUrl`,
          provider.defaultBaseUrl
        )
        .trim() || provider.defaultBaseUrl;
    const model = getProviderStringPref(
      provider,
      "model",
      provider.defaultModel
    );
    const reasoningEffort = getProviderStringPref(
      provider,
      "reasoningEffort",
      "medium"
    );
    const toolReasoningEffort = getProviderStringPref(
      provider,
      "toolReasoningEffort",
      "low"
    );
    const thinking = Services.prefs.getBoolPref(
      PREF_THINKING,
      DEFAULT_THINKING_ENABLED
    );
    const finalThinking = Services.prefs.getBoolPref(
      PREF_FINAL_THINKING,
      false
    );
    const diffusing = Services.prefs.getBoolPref(
      `${provider.prefPrefix}.diffusing`,
      false
    );

    return {
      provider,
      apiKey,
      apiBaseUrl,
      endpoint: resolveCompletionsEndpoint(apiBaseUrl),
      model,
      reasoningEffort,
      toolReasoningEffort,
      thinking,
      finalThinking,
      diffusing,
    };
  },

  isConfigured() {
    return Boolean(this.getConfig().apiKey);
  },

  async executeToolCall(
    toolCall,
    { signal, onEvent, userQuestion, citeSource, skipDecide } = {}
  ) {
    citeSource ||= createSourceRegistry().cite;
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
      // A gap search runs one query.
      const queryList = normalizeSearchItems(args).slice(
        0,
        skipDecide ? 1 : undefined
      );
      if (!queryList.length) {
        return "Error: Missing required parameter 'queries'.";
      }
      const maxPagesToVisit = Number.isFinite(args.maxPagesToVisit)
        ? Math.min(8, Math.max(0, args.maxPagesToVisit))
        : undefined;
      const searchResult = await AgentHeadless.search(queryList, {
        userQuestion,
        citeSource,
        ...(skipDecide ? { useDecide: false } : {}),
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
      onEvent?.({
        type: "tool_report",
        sources: searchResult.sources || [],
        compactContext: searchResult.compactContext,
        coverage: searchResult.coverage,
      });
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
      const sources = [];
      const output = pages
        .map((page, idx) => {
          if (page.error) {
            return `[Page ${idx + 1}]: Skipped (${page.error})`;
          }
          const title = page.title || "Document";
          const url = page.url || urlList[idx];
          const id = citeSource(url, title);
          sources.push({ id, url, title });
          return [
            `[Document ${id} — ${title}]:`,
            page.text || "(No text extracted)",
          ].join("\n");
        })
        .join("\n\n---\n\n");
      onEvent?.({ type: "tool_report", sources });
      return output;
    }

    return `Error: Unknown tool '${name}'.`;
  },

  /**
   * Main entry point for `CustomAgentUI` / `AgentChatPage`.
   *
   * @param {object} params
   * @param {string} params.conversationId
   * @param {Array<{role: string, content: string}>} params.messages
   * @param {string} [params.mode] "deep" plans more information needs and
   *   keeps searching, up to browser.agent.deep.maxSearchRounds, until the
   *   decision model judges every need covered. Anything else is normal.
   * @param {AbortSignal} [params.signal]
   * @param {(delta: string) => void} [params.onDelta]
   * @param {(event: object) => void} [params.onEvent]
   * @returns {Promise<string>}
   */
  async chat({ messages, mode, signal, onDelta, onEvent }) {
    const config = this.getConfig();
    if (!config.apiKey) {
      const guide = buildMissingKeyGuide(config.provider);
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

    const deepResearch = mode === "deep";
    const maxToolRounds = deepResearch
      ? Math.max(
          MAX_TOOL_ROUNDS,
          Services.prefs.getIntPref(PREF_DEEP_MAX_SEARCH_ROUNDS, 4)
        )
      : MAX_TOOL_ROUNDS;
    const gapThreshold = deepResearch
      ? Services.prefs.getIntPref(PREF_DEEP_COVERAGE_THRESHOLD, 70) / 100
      : undefined;
    const conversation = buildConversation(messages, mode);
    const sourceRegistry = createSourceRegistry();
    let reportedSources = 0;
    const toolOptions = {
      onEvent,
      userQuestion: latestUserText(messages),
      citeSource: sourceRegistry.cite,
      skipDecide: false,
    };

    let retrievalSufficient = false;
    // Tool messages with their full and compact reports. A turn that plans a
    // gap search sees the compact ones; every other turn sees the full ones.
    const toolRecords = [];
    let planNext = false;
    // Set once a light tool round asks for think_deeply; later rounds use
    // the full reasoning effort.
    let deepThink = false;
    const canDeepThink =
      Boolean(config.provider.supportsDeepThink) &&
      config.thinking &&
      config.toolReasoningEffort !== config.reasoningEffort;
    AgentHeadless.prewarm();

    for (let round = 0; round <= maxToolRounds; round++) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const planningGaps = planNext;
      planNext = false;
      for (const record of toolRecords) {
        record.message.content = planningGaps ? record.compact : record.full;
      }
      const allowTools = round < maxToolRounds && !retrievalSufficient;
      // The synthesis round after tool results skips thinking so the answer
      // starts streaming sooner.
      const thinkingEnabled =
        config.thinking &&
        (allowTools ||
          deepThink ||
          config.finalThinking ||
          finalThinkingRejected);
      const offerDeepThink = canDeepThink && allowTools && !deepThink;
      const promptText = JSON.stringify(conversation);
      const requestSentAt = Date.now();
      const { response, diffusing } = await requestCompletion(
        config,
        conversation,
        {
          allowTools,
          thinkingEnabled,
          effort:
            allowTools && !deepThink
              ? config.toolReasoningEffort
              : config.reasoningEffort,
          offerDeepThink,
          signal,
        }
      );

      // Diffusing chunks hold half-refined arguments that can already parse
      // as JSON, so tools wait for the final call in that mode.
      const earlyToolRuns = new Map();
      const onToolCallReady =
        allowTools && !diffusing
          ? toolCall => {
              if (toolCall.function?.name === DEEP_THINK_TOOL_NAME) {
                return;
              }
              const controller = new AbortController();
              const abortEarlyRun = () => controller.abort();
              signal?.addEventListener("abort", abortEarlyRun, { once: true });
              const run = runToolCall(this, toolCall, round, {
                ...toolOptions,
                signal: controller.signal,
              }).finally(() =>
                signal?.removeEventListener("abort", abortEarlyRun)
              );
              run.catch(() => {});
              earlyToolRuns.set(toolCall.id, { toolCall, controller, run });
            }
          : null;
      const abortEarlyRuns = () => {
        for (const early of earlyToolRuns.values()) {
          early.controller.abort();
        }
      };

      let parsed;
      try {
        parsed = await parseStreamOrJsonResponse(response, {
          round,
          promptText,
          diffusing,
          // A planning turn only sees snippets, so any text it writes is
          // not shown; the answer comes from the full report.
          onContentDelta: planningGaps ? null : onDelta,
          onEvent,
          onToolCallReady,
          signal,
        });
      } catch (error) {
        abortEarlyRuns();
        throw error;
      }
      const { content, reasoningContent, usage, emittedTabTitle } = parsed;
      let { toolCalls } = parsed;

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

      debugSteps.push(buildLlmDebugStep(round, parsed, requestSentAt));

      // A planning turn that searches no more hands over to the answer turn.
      if (planningGaps && !toolCalls.length) {
        retrievalSufficient = true;
        continue;
      }

      if (offerDeepThink && toolCalls.some(isDeepThinkCall)) {
        toolCalls = toolCalls.filter(call => !isDeepThinkCall(call));
        deepThink = true;
        onEvent?.({ type: "deep_think", round });
        debugSteps.push({
          category: "route",
          step: "  ↳ 심층 생각",
          detail: `reasoning_effort ${config.toolReasoningEffort} → ${config.reasoningEffort}${toolCalls.length ? " (도구 실행 후 답변)" : "로 다시 요청"}`,
          durationMs: 0,
        });
        if (!toolCalls.length) {
          continue;
        }
      }

      if (!toolCalls.length || !allowTools) {
        onEvent?.({
          type: "chat_metrics",
          metrics: buildChatMetrics(
            config,
            requestStartedAt,
            debugSteps,
            totals
          ),
        });
        return content;
      }

      conversation.push({
        role: "assistant",
        content: content || null,
        ...(config.provider.echoReasoning
          ? { reasoning_content: reasoningContent || "" }
          : {}),
        tool_calls: toolCalls,
      });

      // Reuse tool runs that already started during streaming when the final
      // call matches; otherwise discard them and run the final call.
      let toolResults;
      try {
        toolResults = await Promise.all(
          toolCalls.map(toolCall => {
            const early = earlyToolRuns.get(toolCall.id);
            if (
              early &&
              early.toolCall.function.name === toolCall.function?.name &&
              early.toolCall.function.arguments === toolCall.function?.arguments
            ) {
              earlyToolRuns.delete(toolCall.id);
              return early.run;
            }
            return runToolCall(this, toolCall, round, {
              ...toolOptions,
              signal,
            });
          })
        );
      } finally {
        abortEarlyRuns();
      }

      if (sourceRegistry.sources.length > reportedSources) {
        reportedSources = sourceRegistry.sources.length;
        onEvent?.({ type: "sources", sources: sourceRegistry.sources.slice() });
      }

      const outcome = appendToolResults(conversation, debugSteps, toolResults, {
        round,
        maxToolRounds,
        checkGaps: !toolOptions.skipDecide,
        gapThreshold,
      });
      // Only the newest results carry the note about what is missing.
      for (const record of toolRecords) {
        record.compact = record.compactBase;
      }
      toolRecords.push(...outcome.records);
      if (outcome.gapSearch) {
        planNext = true;
        // In normal mode the gap search is not judged again, so it runs once.
        if (!deepResearch) {
          toolOptions.skipDecide = true;
        }
      } else if (outcome.sufficient || planningGaps) {
        retrievalSufficient = true;
      }
    }

    onEvent?.({
      type: "chat_metrics",
      metrics: buildChatMetrics(config, requestStartedAt, debugSteps, totals),
    });
    return "";
  },
};

export const AgentChatAdapter = {
  chat(request) {
    return AgentRuntime.chat(request);
  },
};
