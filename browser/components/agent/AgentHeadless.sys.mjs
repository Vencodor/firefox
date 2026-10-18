/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HiddenBrowserManager } from "resource://gre/modules/HiddenFrame.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { AgentObservationSession } from "resource:///modules/agent/AgentObservation.sys.mjs";

const PREF_SEARCH_TEMPLATE = "browser.agent.searchUrlTemplate";
const PREF_PAGE_TIMEOUT_MS = "browser.agent.headlessPageTimeoutMs";
const PREF_MIN_CONCURRENCY = "browser.agent.headlessMinConcurrency";
const PREF_MAX_CONCURRENCY = "browser.agent.headlessMaxConcurrency";
const DEFAULT_SEARCH_TEMPLATE =
  "https://www.google.com/search?q={searchTerms}&gbv=1";

const HEADLESS_WIDTH = 1280;
const HEADLESS_HEIGHT = 2000;
const DEFAULT_LOAD_TIMEOUT_MS = 12000;
const DEFAULT_RESULT_PAGE_TIMEOUT_MS = 4000;
const DEFAULT_MIN_CONCURRENCY = 3;
const DEFAULT_MAX_CONCURRENCY = 8;
const ESTIMATED_MB_PER_HEADLESS = 120;

const activeBrowsers = new Map();

function createTimeoutError(timeoutMs) {
  const sec = (timeoutMs / 1000).toFixed(1);
  const err = new Error(
    `사이트 응답 지연 (${sec}s 초과) → 다음 순위 결과 탐색`
  );
  err.name = "TimeoutError";
  err.timedOut = true;
  return err;
}

function createEarlyStopError() {
  const err = new Error(
    "빠른 응답 웹사이트에서 충분한 정보 확보 → 지연 사이트 조기 종료"
  );
  err.name = "EarlyStopError";
  err.timedOut = true;
  err.earlyStopped = true;
  return err;
}

/**
 * Dynamically determines how many headless browsers (3 to 8) to run concurrently
 * based on total system RAM, Firefox's current resident memory usage, and
 * remaining available RAM.
 *
 * @param {object} [options]
 * @returns {{
 *   concurrency: number,
 *   minConcurrency: number,
 *   maxConcurrency: number,
 *   totalRamMB: number,
 *   residentMB: number,
 *   remainingRamMB: number,
 *   usedRatio: number
 * }}
 */
export function computeAdaptiveHeadlessBudget(options = {}) {
  const minConcurrency = Math.max(
    1,
    options.minConcurrency ??
      Services.prefs.getIntPref(PREF_MIN_CONCURRENCY, DEFAULT_MIN_CONCURRENCY)
  );
  const maxConcurrency = Math.max(
    minConcurrency,
    options.maxConcurrency ??
      Services.prefs.getIntPref(PREF_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY)
  );

  let totalRamMB = 8192;
  let residentMB = 1024;
  try {
    const memBytes = Number(Services.sysinfo.getProperty("memsize"));
    if (Number.isFinite(memBytes) && memBytes > 0) {
      totalRamMB = Math.round(memBytes / (1024 * 1024));
    }
  } catch {}

  try {
    const mgr = Cc["@mozilla.org/memory-reporter-manager;1"]?.getService(
      Ci.nsIMemoryReporterManager
    );
    const resBytes = Number(mgr?.residentFast || mgr?.resident || 0);
    if (Number.isFinite(resBytes) && resBytes > 0) {
      residentMB = Math.round(resBytes / (1024 * 1024));
    }
  } catch {}

  if (Number.isFinite(options.simulatedTotalRamMB)) {
    totalRamMB = options.simulatedTotalRamMB;
  }
  if (Number.isFinite(options.simulatedResidentMB)) {
    residentMB = options.simulatedResidentMB;
  }

  const activePenaltyMB = activeBrowsers.size * ESTIMATED_MB_PER_HEADLESS;
  const remainingRamMB = Math.max(
    0,
    totalRamMB - residentMB - activePenaltyMB
  );
  const usedRatio =
    (residentMB + activePenaltyMB) / Math.max(1, totalRamMB);

  let desired;
  if (remainingRamMB >= 6144 && usedRatio < 0.45) {
    desired = 8;
  } else if (remainingRamMB >= 4608 && usedRatio < 0.55) {
    desired = 7;
  } else if (remainingRamMB >= 3584 && usedRatio < 0.65) {
    desired = 6;
  } else if (remainingRamMB >= 2560 && usedRatio < 0.75) {
    desired = 5;
  } else if (remainingRamMB >= 1536 && usedRatio < 0.85) {
    desired = 4;
  } else {
    desired = 3;
  }

  const concurrency = Number.isFinite(options.concurrency)
    ? Math.min(maxConcurrency, Math.max(minConcurrency, options.concurrency))
    : Math.min(maxConcurrency, Math.max(minConcurrency, desired));

  return {
    concurrency,
    minConcurrency,
    maxConcurrency,
    totalRamMB,
    residentMB,
    remainingRamMB,
    usedRatio: Number(usedRatio.toFixed(2)),
  };
}

function emitHeadlessEvent(onEvent, payload) {
  const event = {
    timestamp: Date.now(),
    activeCount: activeBrowsers.size,
    ...payload,
  };
  try {
    onEvent?.(event);
  } catch (e) {
    console.error(e);
  }
  try {
    Services.obs.notifyObservers(
      null,
      "agent-headless-event",
      JSON.stringify(event)
    );
  } catch {}
}

function unwrapSearchRedirectUrl(rawHref) {
  if (!rawHref) {
    return null;
  }
  try {
    const parsed = new URL(
      rawHref.startsWith("//")
        ? `https:${rawHref}`
        : rawHref.startsWith("/url?")
          ? `https://www.google.com${rawHref}`
          : rawHref
    );
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      const target = new URL(uddg);
      if (["http:", "https:"].includes(target.protocol)) {
        return target.href;
      }
    }
    if (
      parsed.hostname.includes("google.") &&
      (parsed.pathname === "/url" || parsed.pathname === "/interstitial")
    ) {
      const qTarget =
        parsed.searchParams.get("q") || parsed.searchParams.get("url");
      if (qTarget) {
        const target = new URL(qTarget);
        if (["http:", "https:"].includes(target.protocol)) {
          return target.href;
        }
      }
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function isSearchEngineInternalLink(linkUrl, searchUrl) {
  try {
    const parsedLink = new URL(linkUrl);
    const linkHost = parsedLink.hostname.toLowerCase();
    const searchHost = new URL(searchUrl).hostname.toLowerCase();
    const isGoogleHost = host =>
      /(?:^|\.)(?:google\.[a-z.]+|gstatic\.com|googleusercontent\.com|ggpht\.com|googleapis\.com|g\.co)$/i.test(
        host
      );
    if (isGoogleHost(searchHost)) {
      if (
        isGoogleHost(linkHost) ||
        linkHost === "accounts.youtube.com" ||
        parsedLink.pathname.startsWith("/search") ||
        parsedLink.pathname.startsWith("/preferences") ||
        parsedLink.pathname.startsWith("/setprefs") ||
        parsedLink.pathname.startsWith("/advanced_search")
      ) {
        return true;
      }
    }
    if (
      (searchHost.endsWith("duckduckgo.com") &&
        linkHost.endsWith("duckduckgo.com")) ||
      (searchHost.endsWith("bing.com") && linkHost.endsWith("bing.com"))
    ) {
      return true;
    }
    return linkUrl === searchUrl;
  } catch {
    return false;
  }
}

const TRACKING_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
]);

export function normalizeUrlForDedup(rawUrl) {
  if (!rawUrl) {
    return "";
  }
  try {
    const parsed = new URL(String(rawUrl).trim());
    parsed.hash = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.startsWith("utm_") ||
        TRACKING_QUERY_PARAMS.has(lowerKey)
      ) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.href;
  } catch {
    return String(rawUrl).trim();
  }
}

export function buildShingles(text, k = 3) {
  const compact = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const shingles = new Set();
  if (compact.length < k) {
    if (compact) {
      shingles.add(compact);
    }
    return shingles;
  }
  for (let i = 0; i <= compact.length - k; i++) {
    shingles.add(compact.slice(i, i + k));
  }
  return shingles;
}

export function computeShingleJaccard(shinglesA, shinglesB) {
  if (!shinglesA?.size || !shinglesB?.size) {
    return 0;
  }
  const [smaller, larger] =
    shinglesA.size <= shinglesB.size
      ? [shinglesA, shinglesB]
      : [shinglesB, shinglesA];
  let intersection = 0;
  for (const gram of smaller) {
    if (larger.has(gram)) {
      intersection++;
    }
  }
  const union = shinglesA.size + shinglesB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function createParagraphDeduplicator({
  jaccardThreshold = 0.72,
  minCharsForFuzzy = 35,
} = {}) {
  const seenNormalized = new Set();
  const seenShingleEntries = [];
  let originalChars = 0;
  let deduplicatedChars = 0;
  let removedParagraphs = 0;

  return {
    deduplicateText(rawText) {
      const str = String(rawText || "");
      originalChars += str.length;
      if (!str.trim()) {
        return "";
      }
      const lines = str.split(/\r?\n/);
      const keptLines = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const normalized = trimmed.replace(/\s+/g, " ").toLowerCase();
        if (seenNormalized.has(normalized)) {
          removedParagraphs++;
          continue;
        }

        if (normalized.length >= minCharsForFuzzy) {
          const shingles = buildShingles(normalized, 3);
          let isNearDuplicate = false;
          for (const prev of seenShingleEntries) {
            const lenRatio =
              Math.min(shingles.size, prev.size) /
              Math.max(1, Math.max(shingles.size, prev.size));
            if (lenRatio < jaccardThreshold) {
              continue;
            }
            if (computeShingleJaccard(shingles, prev) >= jaccardThreshold) {
              isNearDuplicate = true;
              break;
            }
          }
          if (isNearDuplicate) {
            removedParagraphs++;
            continue;
          }
          seenShingleEntries.push(shingles);
        }

        seenNormalized.add(normalized);
        keptLines.push(trimmed);
      }

      const out = keptLines.join("\n");
      deduplicatedChars += out.length;
      return out;
    },

    getStats() {
      return {
        originalChars,
        deduplicatedChars,
        savedChars: Math.max(0, originalChars - deduplicatedChars),
        removedParagraphs,
      };
    },
  };
}

export function deduplicatePagesText(pages, options = {}) {
  const deduplicator = createParagraphDeduplicator(options);
  for (const page of pages || []) {
    if (!page || page.error || typeof page.text !== "string") {
      continue;
    }
    const rawLength = page.text.length;
    page.text = deduplicator.deduplicateText(page.text);
    page.rawTextLength = rawLength;
    page.deduplicatedTextLength = page.text.length;
  }
  return deduplicator.getStats();
}

function waitForBrowserLoad(
  browser,
  uri,
  {
    timeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
    strictTimeout = false,
    settleMs,
    signal,
    earlyStopSignal,
  } = {}
) {
  const effectiveSettleMs =
    typeof settleMs === "number" ? settleMs : Cu.isInAutomation ? 50 : 250;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    if (earlyStopSignal?.aborted) {
      reject(createEarlyStopError());
      return;
    }

    let timer = null;
    let settleTimer = null;
    let done = false;

    const cleanup = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      signal?.removeEventListener("abort", onAbort);
      earlyStopSignal?.removeEventListener("abort", onEarlyStop);
      try {
        browser.webProgress?.removeProgressListener(listener);
      } catch {}
    };

    const onAbort = () => {
      cleanup();
      try {
        browser.stop();
      } catch {}
      reject(new DOMException("Aborted", "AbortError"));
    };

    const onEarlyStop = () => {
      cleanup();
      try {
        browser.stop();
      } catch {}
      reject(createEarlyStopError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    earlyStopSignal?.addEventListener("abort", onEarlyStop, { once: true });

    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange(webProgress, request, stateFlags) {
        if (!webProgress?.isTopLevel || !request) {
          return;
        }
        const isStop = Boolean(
          stateFlags & Ci.nsIWebProgressListener.STATE_STOP
        );
        const isNetworkOrWindow = Boolean(
          stateFlags &
            (Ci.nsIWebProgressListener.STATE_IS_NETWORK |
              Ci.nsIWebProgressListener.STATE_IS_WINDOW)
        );
        if (!isStop || !isNetworkOrWindow) {
          return;
        }
        if (
          request instanceof Ci.nsIChannel &&
          request.URI?.spec === "about:blank" &&
          uri.spec !== "about:blank"
        ) {
          return;
        }
        if (effectiveSettleMs <= 0) {
          cleanup();
          resolve();
          return;
        }
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          cleanup();
          resolve();
        }, effectiveSettleMs);
      },
    };

    timer = setTimeout(() => {
      cleanup();
      if (strictTimeout) {
        try {
          browser.stop();
        } catch {}
        reject(createTimeoutError(timeoutMs));
        return;
      }
      resolve();
    }, timeoutMs);

    browser.webProgress.addProgressListener(
      listener,
      Ci.nsIWebProgress.NOTIFY_STATE_ALL
    );

    const triggeringPrincipal = uri.schemeIs("file")
      ? Services.scriptSecurityManager.getSystemPrincipal()
      : Services.scriptSecurityManager.createNullPrincipal({});

    browser.loadURI(uri, { triggeringPrincipal });
  });
}

function extractStructuredPage(observation, { maxLinks = 15 } = {}) {
  const seenUrls = new Set();
  const links = [];

  for (const element of observation.elements || []) {
    const href = unwrapSearchRedirectUrl(element.href);
    if (!href || seenUrls.has(href)) {
      continue;
    }
    const title = (element.name || element.label || "").trim();
    if (!title) {
      continue;
    }
    seenUrls.add(href);
    const contextParts = [];
    if (element.context?.heading && element.context.heading !== title) {
      contextParts.push(element.context.heading);
    }
    const snippet = element.context?.summary || element.context?.text;
    if (snippet && snippet !== title) {
      contextParts.push(snippet);
    }
    links.push({
      title,
      url: href,
      context: contextParts.join(" — "),
    });
    if (links.length >= maxLinks) {
      break;
    }
  }

  return {
    url: observation.page?.url || "",
    title: observation.page?.title || "",
    text: observation.page?.text || "",
    textTruncated: Boolean(observation.page?.text_truncated),
    links,
  };
}

export const AgentHeadless = {
  getActiveBrowsers() {
    return Array.from(activeBrowsers.values());
  },

  getAdaptiveBudget(options = {}) {
    return computeAdaptiveHeadlessBudget(options);
  },

  /**
   * Resolves a search query into a concrete search engine URL.
   *
   * @param {string} query
   * @param {string} [templateOverride]
   * @returns {string}
   */
  buildSearchUrl(query, templateOverride) {
    const template =
      templateOverride ||
      Services.prefs.getStringPref(
        PREF_SEARCH_TEMPLATE,
        DEFAULT_SEARCH_TEMPLATE
      ) ||
      DEFAULT_SEARCH_TEMPLATE;
    if (template.includes("{searchTerms}")) {
      return template.replaceAll("{searchTerms}", encodeURIComponent(query));
    }
    const separator = template.includes("?") ? "&" : "?";
    return `${template}${separator}q=${encodeURIComponent(query)}`;
  },

  /**
   * Opens a URL in a windowless (headless) browser, observes the DOM using
   * AgentObservationSession, and returns the extracted page text and links.
   *
   * @param {string} url
   * @param {object} [options]
   * @returns {Promise<{browserId: string, purpose: string, url: string, title: string, text: string, textTruncated: boolean, links: Array, durationMs: number, loadMs: number, observeMs: number}>}
   */
  async observeUrl(url, options = {}) {
    const uri = Services.io.newURI(url);
    if (!["http", "https", "file"].includes(uri.scheme)) {
      throw new Error(
        `Unsupported URL scheme for headless observation: ${uri.scheme}`
      );
    }

    const browserId = Services.uuid.generateUUID().toString();
    const purpose = options.purpose || "page";
    const effectiveTimeoutMs = options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    const strictTimeout = Boolean(options.strictTimeout);
    const startedAt = Date.now();

    activeBrowsers.set(browserId, {
      browserId,
      url,
      purpose,
      phase: "loading",
      startedAt,
    });
    emitHeadlessEvent(options.onEvent, {
      type: "headless_start",
      browserId,
      url,
      purpose,
      rank: options.rank ?? null,
      query: options.query || null,
      viewport: { width: HEADLESS_WIDTH, height: HEADLESS_HEIGHT },
    });

    try {
      return await HiddenBrowserManager.withHiddenBrowser(async browser => {
        browser.style.width = `${HEADLESS_WIDTH}px`;
        browser.style.minWidth = `${HEADLESS_WIDTH}px`;
        browser.style.height = `${HEADLESS_HEIGHT}px`;
        browser.style.minHeight = `${HEADLESS_HEIGHT}px`;

        if (browser.browsingContext) {
          browser.browsingContext.useGlobalHistory = false;
          browser.browsingContext.mediaController?.mute();
        }

        await waitForBrowserLoad(browser, uri, {
          timeoutMs: effectiveTimeoutMs,
          strictTimeout,
          settleMs: options.settleMs,
          signal: options.signal,
          earlyStopSignal: options.earlyStopSignal,
        });

        if (options.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        if (options.earlyStopSignal?.aborted) {
          throw createEarlyStopError();
        }

        const loadFinishedAt = Date.now();
        const loadMs = loadFinishedAt - startedAt;
        if (strictTimeout && loadMs >= effectiveTimeoutMs) {
          throw createTimeoutError(effectiveTimeoutMs);
        }

        const loadedUrl = browser.currentURI?.spec || url;
        activeBrowsers.set(browserId, {
          browserId,
          url: loadedUrl,
          purpose,
          phase: "observing",
          startedAt,
        });
        emitHeadlessEvent(options.onEvent, {
          type: "headless_observing",
          browserId,
          url: loadedUrl,
          purpose,
          rank: options.rank ?? null,
          loadMs,
        });

        const session = new AgentObservationSession(browser);
        let observeTimer = null;
        let onEarlyStopObserve = null;
        try {
          const observePromise = session.observe({
            showOverlay: false,
            includeOffscreenText: options.includeOffscreenText ?? true,
            textLimit: options.textLimit ?? 6000,
            maxActions: options.maxActions ?? 120,
            query: options.query || "",
          });

          const racePromises = [observePromise];
          if (strictTimeout) {
            racePromises.push(
              new Promise((_, reject) => {
                const remainingMs = Math.max(
                  1,
                  effectiveTimeoutMs - (Date.now() - startedAt)
                );
                observeTimer = setTimeout(
                  () => reject(createTimeoutError(effectiveTimeoutMs)),
                  remainingMs
                );
              })
            );
          }
          if (options.earlyStopSignal) {
            racePromises.push(
              new Promise((_, reject) => {
                if (options.earlyStopSignal.aborted) {
                  reject(createEarlyStopError());
                  return;
                }
                onEarlyStopObserve = () => reject(createEarlyStopError());
                options.earlyStopSignal.addEventListener(
                  "abort",
                  onEarlyStopObserve,
                  { once: true }
                );
              })
            );
          }

          const observation =
            racePromises.length > 1
              ? await Promise.race(racePromises)
              : await observePromise;

          clearTimeout(observeTimer);
          const structured = extractStructuredPage(observation, {
            maxLinks: options.maxLinks ?? 15,
          });
          const durationMs = Date.now() - startedAt;
          const observeMs = Math.max(0, durationMs - loadMs);
          activeBrowsers.delete(browserId);
          emitHeadlessEvent(options.onEvent, {
            type: "headless_done",
            browserId,
            url: structured.url || loadedUrl,
            title: structured.title || "",
            textLength: structured.text.length,
            linkCount: structured.links.length,
            durationMs,
            loadMs,
            observeMs,
            purpose,
            rank: options.rank ?? null,
          });
          return {
            ...structured,
            browserId,
            purpose,
            rank: options.rank ?? null,
            durationMs,
            loadMs,
            observeMs,
          };
        } finally {
          clearTimeout(observeTimer);
          if (onEarlyStopObserve && options.earlyStopSignal) {
            options.earlyStopSignal.removeEventListener(
              "abort",
              onEarlyStopObserve
            );
          }
          await session.destroy();
        }
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      activeBrowsers.delete(browserId);
      emitHeadlessEvent(options.onEvent, {
        type: "headless_error",
        browserId,
        url,
        error: error?.message || String(error),
        timedOut: Boolean(error?.timedOut),
        earlyStopped: Boolean(error?.earlyStopped),
        rank: options.rank ?? null,
        durationMs,
        purpose,
      });
      throw error;
    }
  },

  /**
   * Observes multiple URLs concurrently in separate headless browser instances
   * with RAM-adaptive parallelism (3-8), URL deduplication, and cross-page
   * paragraph deduplication.
   *
   * @param {Array<string>} urls
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async observeUrlsConcurrently(urls, options = {}) {
    const validUrls = [];
    const seenNormUrls = new Set();
    for (const rawUrl of urls || []) {
      const trimmed = String(rawUrl || "").trim();
      if (!trimmed) {
        continue;
      }
      const norm = normalizeUrlForDedup(trimmed);
      if (seenNormUrls.has(norm)) {
        continue;
      }
      seenNormUrls.add(norm);
      validUrls.push(trimmed);
    }

    const ramBudget = computeAdaptiveHeadlessBudget(options);
    const maxConcurrency = Math.max(
      1,
      options.maxConcurrency ?? ramBudget.concurrency
    );
    const configuredPageTimeout = Services.prefs.getIntPref(
      PREF_PAGE_TIMEOUT_MS,
      DEFAULT_RESULT_PAGE_TIMEOUT_MS
    );
    const defaultTimeoutMs =
      configuredPageTimeout > 0
        ? configuredPageTimeout
        : DEFAULT_RESULT_PAGE_TIMEOUT_MS;
    const results = new Array(validUrls.length);
    let nextIdx = 0;

    async function worker(self) {
      while (nextIdx < validUrls.length) {
        const idx = nextIdx++;
        const url = validUrls[idx];
        const startedAt = Date.now();
        try {
          results[idx] = await self.observeUrl(url, {
            timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
            strictTimeout: options.strictTimeout ?? true,
            ...options,
            purpose: options.purposePrefix
              ? `${options.purposePrefix}-${idx + 1}`
              : `page-${idx + 1}`,
          });
        } catch (error) {
          if (error?.name === "AbortError") {
            throw error;
          }
          results[idx] = {
            url,
            title: "",
            text: "",
            error: error?.message || String(error),
            timedOut: Boolean(error?.timedOut),
            earlyStopped: Boolean(error?.earlyStopped),
            links: [],
            durationMs: Date.now() - startedAt,
          };
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrency, validUrls.length) },
        () => worker(this)
      )
    );
    if (options.deduplicate !== false) {
      deduplicatePagesText(results);
    }
    return results;
  },

  /**
   * Alias for multi-query parallel search.
   *
   * @param {Array<string>} queries
   * @param {object} [options]
   */
  async searchMulti(queries, options = {}) {
    return this.search(queries, options);
  },

  /**
   * Performs a headless web search for a single `query` or an array of `queries`
   * in parallel, deduplicates candidate URLs across queries, dynamically launches
   * 3-8 concurrent headless browsers based on available RAM, early-terminates slow
   * browsers as soon as fast websites provide sufficient information, falls back
   * to next-rank candidates on 4s timeout, and deduplicates paragraphs across pages.
   *
   * @param {string|Array<string>} queryOrQueries
   * @param {object} [options]
   * @returns {Promise<{
   *   query: string,
   *   queries: Array<string>,
   *   searchUrl: string,
   *   searchPage: object,
   *   searchPages: Array<object>,
   *   visitedPages: Array<object>,
   *   ramBudget: object,
   *   dedupStats: object,
   *   formattedContext: string
   * }>}
   */
  async search(queryOrQueries, options = {}) {
    const rawQueries = Array.isArray(queryOrQueries)
      ? queryOrQueries
      : Array.isArray(options.queries) && options.queries.length
        ? options.queries
        : [queryOrQueries];

    const queries = [];
    const seenQueryKeys = new Set();
    for (const q of rawQueries) {
      const trimmed = String(q || "").trim();
      const key = trimmed.toLowerCase();
      if (trimmed && !seenQueryKeys.has(key)) {
        seenQueryKeys.add(key);
        queries.push(trimmed);
      }
    }
    if (!queries.length) {
      throw new Error("Search query must not be empty");
    }

    const isMultiQuery = queries.length > 1;
    const combinedQueryText = queries.join(" ");

    // Phase 1: Observe all search engine result pages (SERPs) concurrently
    const searchEntries = await Promise.all(
      queries.map(async (q, idx) => {
        const searchUrl = this.buildSearchUrl(q, options.searchUrlTemplate);
        const purpose = isMultiQuery ? `search-${idx + 1}` : "search";
        const searchPage = await this.observeUrl(searchUrl, {
          timeoutMs: options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
          settleMs: options.settleMs,
          textLimit: options.searchTextLimit ?? 5000,
          maxLinks: options.maxLinks ?? 15,
          signal: options.signal,
          onEvent: options.onEvent,
          purpose,
          query: q,
        });
        const filteredLinks = (searchPage.links || []).filter(
          link => !isSearchEngineInternalLink(link.url, searchUrl)
        );
        return {
          query: q,
          searchUrl,
          searchPage,
          filteredLinks,
        };
      })
    );

    // Phase 2: Round-robin rank interleaving & cross-query URL deduplication
    const candidateLinks = [];
    const seenCandidateMap = new Map();
    let skippedDuplicateUrls = 0;
    const maxListLen = searchEntries.reduce(
      (max, entry) => Math.max(max, entry.filteredLinks.length),
      0
    );

    for (let depth = 0; depth < maxListLen; depth++) {
      for (const entry of searchEntries) {
        if (depth >= entry.filteredLinks.length) {
          continue;
        }
        const link = entry.filteredLinks[depth];
        const normUrl = normalizeUrlForDedup(link.url);
        if (!normUrl) {
          continue;
        }
        const existing = seenCandidateMap.get(normUrl);
        if (existing) {
          skippedDuplicateUrls++;
          if (!existing.matchedQueries.includes(entry.query)) {
            existing.matchedQueries.push(entry.query);
          }
          continue;
        }
        const candidate = {
          ...link,
          normalizedUrl: normUrl,
          matchedQueries: [entry.query],
        };
        seenCandidateMap.set(normUrl, candidate);
        candidateLinks.push(candidate);
      }
    }

    // Phase 3: RAM-adaptive concurrent result extraction (3-8 browsers) +
    // speculative early-stopping when fast websites yield sufficient content +
    // 4s timeout fallback to next rank
    const ramBudget = computeAdaptiveHeadlessBudget(options);
    const defaultTargetPages = isMultiQuery
      ? Math.min(5, Math.max(3, queries.length * 2))
      : Math.min(4, Math.max(2, Math.ceil(ramBudget.concurrency * 0.5)));
    const targetPagesToVisit = Math.max(
      0,
      options.maxPagesToVisit ?? defaultTargetPages
    );
    const sufficientCharsThreshold =
      options.sufficientCharsThreshold ?? targetPagesToVisit * 1800;

    const configuredPageTimeout = Services.prefs.getIntPref(
      PREF_PAGE_TIMEOUT_MS,
      DEFAULT_RESULT_PAGE_TIMEOUT_MS
    );
    const pageTimeoutMs =
      options.pageTimeoutMs ??
      (configuredPageTimeout > 0
        ? configuredPageTimeout
        : DEFAULT_RESULT_PAGE_TIMEOUT_MS);

    const visitedPages = [];
    let nextCandidateIdx = 0;
    let completedValidPages = 0;
    let collectedChars = 0;
    let earlyStoppedCount = 0;
    let inFlightWorkers = 0;
    const earlyStopController = new AbortController();

    const checkEarlyStop = () => {
      if (earlyStopController.signal.aborted) {
        return true;
      }
      if (
        completedValidPages >= targetPagesToVisit ||
        (completedValidPages >= 2 && collectedChars >= sufficientCharsThreshold)
      ) {
        earlyStopController.abort();
        return true;
      }
      return false;
    };

    async function visitSlotWorker(self) {
      while (
        nextCandidateIdx < candidateLinks.length &&
        !earlyStopController.signal.aborted
      ) {
        if (options.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        if (checkEarlyStop()) {
          return;
        }
        const rankIndex = nextCandidateIdx++;
        const rank = rankIndex + 1;
        const link = candidateLinks[rankIndex];
        const startedAt = Date.now();
        inFlightWorkers++;
        try {
          const page = await self.observeUrl(link.url, {
            timeoutMs: pageTimeoutMs,
            strictTimeout: true,
            settleMs: options.settleMs,
            textLimit: options.pageTextLimit ?? 4000,
            maxLinks: 8,
            signal: options.signal,
            earlyStopSignal: earlyStopController.signal,
            onEvent: options.onEvent,
            purpose: `result-${rank}`,
            rank,
            query: combinedQueryText,
          });
          inFlightWorkers--;
          visitedPages.push({
            ...page,
            rank,
            matchedQueries: link.matchedQueries,
          });
          if ((page.text || "").trim().length > 0) {
            completedValidPages++;
            collectedChars += page.text.length;
          }
          if (checkEarlyStop()) {
            return;
          }
          if (completedValidPages + inFlightWorkers >= targetPagesToVisit) {
            return;
          }
        } catch (error) {
          inFlightWorkers--;
          if (options.signal?.aborted || error?.name === "AbortError") {
            throw error;
          }
          if (error?.earlyStopped) {
            earlyStoppedCount++;
          }
          visitedPages.push({
            url: link.url,
            title: link.title,
            text: "",
            error: error?.message || String(error),
            timedOut: Boolean(error?.timedOut),
            earlyStopped: Boolean(error?.earlyStopped),
            rank,
            matchedQueries: link.matchedQueries,
            links: [],
            durationMs: Date.now() - startedAt,
          });
          if (earlyStopController.signal.aborted) {
            return;
          }
          // Automatically fall back to the next rank result in `candidateLinks`
        }
      }
    }

    const workerCount =
      targetPagesToVisit > 0
        ? Math.min(ramBudget.concurrency, candidateLinks.length)
        : 0;
    await Promise.all(
      Array.from({ length: workerCount }, () => visitSlotWorker(this))
    );

    visitedPages.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

    // Phase 4: Cross-page 3-gram Jaccard paragraph deduplication
    const textDedupStats =
      options.deduplicate !== false
        ? deduplicatePagesText(visitedPages)
        : {
            originalChars: 0,
            deduplicatedChars: 0,
            savedChars: 0,
            removedParagraphs: 0,
          };

    const dedupStats = {
      ...textDedupStats,
      skippedDuplicateUrls,
      queryCount: queries.length,
      earlyStoppedCount,
      headlessConcurrency: workerCount,
      ramBudget,
    };

    const primaryEntry = searchEntries[0];
    const formattedContext = this.formatSearchReport({
      query: primaryEntry.query,
      queries,
      searchPage: primaryEntry.searchPage,
      searchEntries,
      visitedPages,
      dedupStats,
    });

    return {
      query: primaryEntry.query,
      queries,
      searchUrl: primaryEntry.searchUrl,
      searchPage: primaryEntry.searchPage,
      searchPages: searchEntries.map(e => e.searchPage),
      visitedPages,
      ramBudget,
      dedupStats,
      formattedContext,
    };
  },

  /**
   * Formats the collected headless search & page observations into a concise,
   * source-URL-free text block for the LLM tool response.
   */
  formatSearchReport({
    query,
    queries,
    searchPage,
    searchEntries,
    visitedPages,
  }) {
    const entries =
      Array.isArray(searchEntries) && searchEntries.length
        ? searchEntries
        : [{ query, searchPage }];

    const sections = [];
    if (entries.length > 1) {
      sections.push(
        `[Queries]: ${(queries || entries.map(e => e.query)).join(" | ")}`
      );
      for (const [idx, entry] of entries.entries()) {
        if (entry.searchPage?.text) {
          sections.push(
            `[Search Overview #${idx + 1} (${entry.query})]:\n${entry.searchPage.text}`
          );
        }
      }
    } else {
      sections.push(`[Query]: ${query}`);
      if (searchPage?.text) {
        sections.push(`[Search Overview]:\n${searchPage.text}`);
      }
    }

    let docIndex = 0;
    for (const page of visitedPages || []) {
      if (page.error || !page.text?.trim()) {
        continue;
      }
      docIndex++;
      sections.push(
        `[Extracted Document #${docIndex} — ${page.title || "Document"}]:\n${page.text}`
      );
    }

    return sections.join("\n\n");
  },
};
