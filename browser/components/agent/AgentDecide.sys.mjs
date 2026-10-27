/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Client for Inception's Mercury Decide decision model (`POST /v1/decisions`).
 * It answers typed questions about a shared state with probabilities and
 * writes no prose. Every caller treats a failure or timeout as "no opinion"
 * and keeps its default behavior.
 */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const PREF_PREFIX = "browser.agent.decide";
const DEFAULT_BASE_URL = "https://api.inceptionlabs.ai/v1";
const DEFAULT_MODEL = "mercury-decide";
const DEFAULT_TIMEOUT_MS = 2500;
const MAX_SNIPPET_CHARS = 300;
const MAX_EVIDENCE_CHARS = 1500;

function getPercentPref(name, fallback) {
  const value = Services.prefs.getIntPref(`${PREF_PREFIX}.${name}`, fallback);
  return Math.min(100, Math.max(0, value)) / 100;
}

/**
 * Reads the probability of a "yes" from a noul answer. The documented field
 * is `noul`; `probability` and `probabilities.true` are accepted as well.
 *
 * @param {object} answer
 * @returns {number|null}
 */
export function readNoulProbability(answer) {
  const candidates = [
    answer?.noul,
    answer?.probability,
    answer?.probabilities?.true,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (value !== undefined && value !== null && Number.isFinite(number)) {
      return Math.min(1, Math.max(0, number));
    }
  }
  return null;
}

export const AgentDecide = {
  getConfig() {
    const apiKey = (
      Services.prefs.getStringPref(`${PREF_PREFIX}.apiKey`, "") ||
      Services.prefs.getStringPref("browser.agent.mercury.apiKey", "") ||
      Services.env.get("INCEPTION_API_KEY") ||
      ""
    ).trim();
    const baseUrl = (
      Services.prefs.getStringPref(`${PREF_PREFIX}.apiBaseUrl`, "") ||
      DEFAULT_BASE_URL
    )
      .trim()
      .replace(/\/+$/, "");
    const requested = Services.prefs.getBoolPref(
      `${PREF_PREFIX}.enabled`,
      true
    );
    return {
      // `requested` without `enabled` means the pref is on but no key was
      // found; the search reports that instead of skipping silently.
      requested,
      enabled: requested && Boolean(apiKey),
      apiKey,
      endpoint: baseUrl.endsWith("/decisions")
        ? baseUrl
        : `${baseUrl}/decisions`,
      model:
        Services.prefs.getStringPref(`${PREF_PREFIX}.model`, "").trim() ||
        DEFAULT_MODEL,
      timeoutMs: Math.max(
        200,
        Services.prefs.getIntPref(
          `${PREF_PREFIX}.timeoutMs`,
          DEFAULT_TIMEOUT_MS
        )
      ),
      relevanceThreshold: getPercentPref("relevanceThreshold", 50),
      snippetsSufficientThreshold: getPercentPref(
        "snippetsSufficientThreshold",
        85
      ),
      minKeep: Math.max(
        1,
        Services.prefs.getIntPref(`${PREF_PREFIX}.minKeep`, 2)
      ),
      speculativeVisits: Math.max(
        0,
        Services.prefs.getIntPref(`${PREF_PREFIX}.speculativeVisits`, 2)
      ),
      // Results past this rank are not judged; they stay as a fallback.
      maxResults: Math.max(
        1,
        Services.prefs.getIntPref(`${PREF_PREFIX}.maxResults`, 6)
      ),
      coverage: Services.prefs.getBoolPref(`${PREF_PREFIX}.coverage`, true),
      coverageThreshold: getPercentPref("coverageThreshold", 50),
    };
  },

  /**
   * Sends one decision request.
   *
   * @param {object} request
   * @param {object|string} request.state Context shared by every question.
   * @param {object} request.questions Map of question name to definition.
   * @param {object} [options]
   * @param {object} [options.config] From getConfig().
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{answers: object, usage: object, durationMs: number}>}
   */
  async decide({ state, questions }, options = {}) {
    const config = options.config || this.getConfig();
    const startedAt = Date.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, state, questions }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let errorText = "";
        try {
          errorText = await response.text();
        } catch {}
        throw new Error(
          `Decide API error (${response.status}): ${errorText.slice(0, 200)}`
        );
      }
      const data = await response.json();
      return {
        answers: data?.answers || {},
        usage: data?.usage || {},
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      if (error?.name === "AbortError") {
        throw new Error(`Decide timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  },

  /**
   * Judges search results from their titles and snippets only: which ones are
   * worth opening, and whether the snippets already answer the question.
   *
   * @param {object} input
   * @param {string} input.question The user's question.
   * @param {string} input.query The search query that produced the results.
   * @param {Array<{title: string, url: string, context: string}>} input.results
   * @param {Array<string>} [input.featured] Direct answers shown on the
   *   results page.
   * @param {object} [options] Passed to decide().
   * @returns {Promise<{relevance: Array<number|null>, snippetsSufficient: number|null, durationMs: number, inputTokens: number}>}
   */
  async assessSearchResults(
    { question, query, results, featured = [] },
    options = {}
  ) {
    const state = {
      user_question: question,
      search_query: query,
      featured_answers: featured,
      results: results.map((result, index) => {
        let domain = "";
        try {
          domain = new URL(result.url).hostname;
        } catch {}
        return {
          id: `r${index + 1}`,
          title: result.title,
          domain,
          snippet: String(result.context || "").slice(0, MAX_SNIPPET_CHARS),
        };
      }),
    };
    const questions = {
      snippets_sufficient: {
        type: "noul",
        instructions:
          "Do featured_answers and the result titles and snippets together already answer user_question completely and correctly, so that opening any page is unnecessary? Answer no if the question needs details, explanations, current figures or several facts that the snippets do not state.",
      },
    };
    state.results.forEach(result => {
      questions[result.id] = {
        type: "noul",
        instructions: `Is search result ${result.id} likely to contain information that helps answer user_question? Judge only from its title, domain and snippet. Answer no for unrelated topics, login or store pages, and pages about a different subject with similar words.`,
      };
    });
    const { answers, usage, durationMs } = await this.decide(
      { state, questions },
      options
    );
    return {
      relevance: state.results.map(result =>
        readNoulProbability(answers[result.id])
      ),
      snippetsSufficient: readNoulProbability(answers.snippets_sufficient),
      durationMs,
      inputTokens: Number(usage.input_tokens) || 0,
    };
  },

  /**
   * Judges, for each piece of information the answer needs, whether the
   * collected snippets and page excerpts already state it.
   *
   * @param {object} input
   * @param {string} input.question The user's question.
   * @param {Array<{query: string, evidence: string}>} input.searches What
   *   each search found; sent once even when it serves several needs.
   * @param {Array<{need: string, searches: Array<number>}>} input.needs
   *   Indexes into `searches` of the searches made for each need.
   * @param {object} [options] Passed to decide().
   * @returns {Promise<{found: Array<number|null>, durationMs: number, inputTokens: number}>}
   */
  async assessCoverage({ question, searches, needs }, options = {}) {
    const state = {
      user_question: question,
      searches: searches.map((search, index) => ({
        id: `s${index + 1}`,
        query: search.query,
        evidence: String(search.evidence || "").slice(0, MAX_EVIDENCE_CHARS),
      })),
      needs: needs.map((item, index) => ({
        id: `n${index + 1}`,
        need: item.need,
        search_ids: item.searches.map(i => `s${i + 1}`),
      })),
    };
    const questions = {};
    state.needs.forEach(item => {
      questions[item.id] = {
        type: "noul",
        instructions: `Does the evidence of the searches listed in search_ids of ${item.id} state the information described by its need concretely enough to answer that part of user_question? Answer no if it is missing, only hinted at, outdated for the question, or about a different subject.`,
      };
    });
    const { answers, usage, durationMs } = await this.decide(
      { state, questions },
      options
    );
    return {
      found: state.needs.map(item => readNoulProbability(answers[item.id])),
      durationMs,
      inputTokens: Number(usage.input_tokens) || 0,
    };
  },
};
