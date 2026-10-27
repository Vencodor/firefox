/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HiddenFrame } from "resource://gre/modules/HiddenFrame.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { AgentObservationSession } from "resource:///modules/agent/AgentObservation.sys.mjs";
import { fitPagesToBudget } from "resource:///modules/agent/observation/TextRelevance.sys.mjs";
import { AgentDecide } from "resource:///modules/agent/AgentDecide.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
});

const PREF_SEARCH_TEMPLATE = "browser.agent.searchUrlTemplate";
const PREF_PAGE_TIMEOUT_MS = "browser.agent.headlessPageTimeoutMs";
const PREF_RESULT_BUDGET_MS = "browser.agent.headlessResultBudgetMs";
const PREF_CONTEXT_CHAR_BUDGET = "browser.agent.contextCharBudget";
const PREF_SERP_OVERVIEW_CHAR_BUDGET = "browser.agent.serpOverviewCharBudget";
const DEFAULT_CONTEXT_CHAR_BUDGET = 6000;
const DEFAULT_SERP_OVERVIEW_CHAR_BUDGET = 1600;
const SERP_SNIPPET_CHARS = 200;
const PREF_MIN_CONCURRENCY = "browser.agent.headlessMinConcurrency";
const PREF_MAX_CONCURRENCY = "browser.agent.headlessMaxConcurrency";
const DEFAULT_SEARCH_TEMPLATE =
  "https://www.google.com/search?q={searchTerms}&hl=ko";

const HEADLESS_WIDTH = 1280;
const HEADLESS_HEIGHT = 2000;
const DEFAULT_LOAD_TIMEOUT_MS = 12000;
const DEFAULT_RESULT_PAGE_TIMEOUT_MS = 3000;
const DEFAULT_RESULT_BUDGET_MS = 2500;
const SERP_GRACE_MS = 1500;
const DEFAULT_MIN_CONCURRENCY = 3;
const DEFAULT_MAX_CONCURRENCY = 8;
const ESTIMATED_MB_PER_HEADLESS = 120;
const HIDDEN_FRAME_LINGER_MS = 60000;
const COMMIT_POLL_MS = 15;
const HEADLESS_MESSAGE_MANAGER_GROUP = "agent-headless";

const BLOCKED_TYPES_SEARCH = new Set([
  Ci.nsIContentPolicy.TYPE_IMAGE,
  Ci.nsIContentPolicy.TYPE_IMAGESET,
  Ci.nsIContentPolicy.TYPE_MEDIA,
  Ci.nsIContentPolicy.TYPE_FONT,
  Ci.nsIContentPolicy.TYPE_OBJECT,
  Ci.nsIContentPolicy.TYPE_BEACON,
  Ci.nsIContentPolicy.TYPE_PING,
  Ci.nsIContentPolicy.TYPE_WEBSOCKET,
  Ci.nsIContentPolicy.TYPE_CSP_REPORT,
]);
const BLOCKED_TYPES_PAGE = new Set([
  ...BLOCKED_TYPES_SEARCH,
  Ci.nsIContentPolicy.TYPE_STYLESHEET,
]);

const activeBrowsers = new Map();

// Document types the page reader can extract text from. Anything else, and
// any attachment, would become a download (and a PDF could open in a tab).
const READABLE_DOCUMENT_TYPES = new Set([
  "",
  "application/x-unknown-content-type",
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/xml",
  "application/xml",
  "application/json",
  "application/rss+xml",
  "application/atom+xml",
]);
const RESPONSE_TOPICS = [
  "http-on-examine-response",
  "http-on-examine-cached-response",
  "http-on-examine-merged-response",
];

/**
 * Says why a document response is not read, or returns null when it is.
 *
 * @param {nsIChannel} channel
 * @returns {string|null}
 */
function describeUnreadableDocument(channel) {
  try {
    if (channel.contentDisposition === Ci.nsIChannel.DISPOSITION_ATTACHMENT) {
      return "다운로드 파일";
    }
  } catch {}
  const type = String(channel.contentType || "").toLowerCase();
  if (!READABLE_DOCUMENT_TYPES.has(type)) {
    return type === "application/pdf" ? "PDF 파일" : `${type} 파일`;
  }
  return null;
}

const blockedTypesByBrowserId = new Map();
// Why the top document of a headless browser was cancelled, by browserId.
const unreadableDocuments = new Map();
let requestObserverRegistered = false;
const requestObserver = {
  observe(subject, topic) {
    if (!blockedTypesByBrowserId.size || !(subject instanceof Ci.nsIChannel)) {
      return;
    }
    const loadInfo = subject.loadInfo;
    const browserId = loadInfo?.browsingContext?.browserId;
    const types = blockedTypesByBrowserId.get(browserId);
    if (!types) {
      return;
    }
    const type = loadInfo.externalContentPolicyType;
    if (topic === "http-on-modify-request") {
      if (types.has(type)) {
        subject.cancel(Cr.NS_BINDING_ABORTED);
      }
      return;
    }
    if (
      type !== Ci.nsIContentPolicy.TYPE_DOCUMENT &&
      type !== Ci.nsIContentPolicy.TYPE_SUBDOCUMENT
    ) {
      return;
    }
    const reason = describeUnreadableDocument(subject);
    if (reason) {
      if (type === Ci.nsIContentPolicy.TYPE_DOCUMENT) {
        unreadableDocuments.set(browserId, reason);
      }
      subject.cancel(Cr.NS_BINDING_ABORTED);
    }
  },
};

// A download a headless page started anyway (e.g. from script) is removed
// with its file, so nothing lands in the downloads list or opens in a tab.
let downloadGuardPromise = null;
function ensureDownloadGuard() {
  downloadGuardPromise ??= (async () => {
    const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    const discard = async download => {
      const browserId = BrowsingContext.get(
        download.source?.browsingContextId
      )?.browserId;
      if (!browserId || !blockedTypesByBrowserId.has(browserId)) {
        return;
      }
      try {
        await download.manuallyRemoveData();
      } catch {}
      await list.remove(download);
    };
    await list.addView({ onDownloadAdded: discard });
  })().catch(error => {
    downloadGuardPromise = null;
    console.error(error);
  });
}

/**
 * Cancels subresource requests of the given types for one headless browser.
 *
 * @param {number} browserId
 * @param {Set<number>|null} types nsIContentPolicy types, or null to stop.
 */
function setRequestBlocking(browserId, types) {
  if (!browserId) {
    return;
  }
  if (types) {
    blockedTypesByBrowserId.set(browserId, types);
    ensureDownloadGuard();
  } else {
    blockedTypesByBrowserId.delete(browserId);
    unreadableDocuments.delete(browserId);
  }
  const topics = ["http-on-modify-request", ...RESPONSE_TOPICS];
  if (blockedTypesByBrowserId.size && !requestObserverRegistered) {
    for (const topic of topics) {
      Services.obs.addObserver(requestObserver, topic);
    }
    requestObserverRegistered = true;
  } else if (!blockedTypesByBrowserId.size && requestObserverRegistered) {
    for (const topic of topics) {
      Services.obs.removeObserver(requestObserver, topic);
    }
    requestObserverRegistered = false;
  }
}

let hiddenFrame = null;
let hiddenFrameUsers = 0;
let hiddenFrameLingerTimer = null;

function getHiddenFrameWindow() {
  clearTimeout(hiddenFrameLingerTimer);
  hiddenFrameLingerTimer = null;
  hiddenFrame ??= new HiddenFrame();
  return hiddenFrame.get();
}

/**
 * Keeps the windowless frame alive for a while after the last browser is
 * released, so the next tool call does not pay for creating it again.
 */
function scheduleHiddenFrameRelease() {
  if (hiddenFrameUsers > 0 || !hiddenFrame) {
    return;
  }
  clearTimeout(hiddenFrameLingerTimer);
  hiddenFrameLingerTimer = setTimeout(() => {
    hiddenFrameLingerTimer = null;
    if (!hiddenFrameUsers && hiddenFrame) {
      hiddenFrame.destroy();
      hiddenFrame = null;
    }
  }, HIDDEN_FRAME_LINGER_MS);
}

async function withHeadlessBrowser(callback) {
  hiddenFrameUsers++;
  let browser = null;
  try {
    const win = await getHiddenFrameWindow();
    const doc = win.document;
    browser = doc.createXULElement("browser");
    browser.setAttribute("remote", "true");
    browser.setAttribute("type", "content");
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute("nodefaultsrc", "true");
    browser.setAttribute("messagemanagergroup", HEADLESS_MESSAGE_MANAGER_GROUP);
    browser.style.width = `${HEADLESS_WIDTH}px`;
    browser.style.minWidth = `${HEADLESS_WIDTH}px`;
    browser.style.height = `${HEADLESS_HEIGHT}px`;
    browser.style.minHeight = `${HEADLESS_HEIGHT}px`;
    doc.documentElement.appendChild(browser);
    return await callback(browser);
  } finally {
    browser?.remove();
    hiddenFrameUsers--;
    scheduleHiddenFrameRelease();
  }
}

function speculativeConnect(url) {
  try {
    const uri = Services.io.newURI(url);
    if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
      return;
    }
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      uri,
      {}
    );
    Services.io
      .QueryInterface(Ci.nsISpeculativeConnect)
      .speculativeConnect(uri, principal, null, false);
  } catch {}
}

function getPrefMs(pref, fallback) {
  const value = Services.prefs.getIntPref(pref, fallback);
  return value > 0 ? value : fallback;
}

function createTimeoutError(timeoutMs) {
  const sec = (timeoutMs / 1000).toFixed(1);
  const err = new Error(
    `사이트 응답 지연 (${sec}s 초과) → 다음 순위 결과 탐색`
  );
  err.name = "TimeoutError";
  err.timedOut = true;
  return err;
}

function createUnreadableDocumentError(reason) {
  const err = new Error(`${reason}이라 열지 않음`);
  err.name = "UnreadableDocumentError";
  err.unreadable = true;
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
  const remainingRamMB = Math.max(0, totalRamMB - residentMB - activePenaltyMB);
  const usedRatio = (residentMB + activePenaltyMB) / Math.max(1, totalRamMB);

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
    if (parsed.pathname === "/url" || parsed.pathname === "/interstitial") {
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

const FILE_EXTENSION_RE =
  /\.(?:pdf|zip|rar|7z|gz|tgz|tar|exe|msi|dmg|pkg|apk|iso|docx?|xlsx?|pptx?|hwpx?|csv|mp3|mp4|mov|avi)$/i;

function isFileUrl(url) {
  try {
    return FILE_EXTENSION_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isVideoPageUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^(?:www|m)\./, "");
    return (
      host === "youtu.be" ||
      (host === "youtube.com" && /^\/(?:watch|shorts|live)\b/.test(pathname)) ||
      (host === "tiktok.com" && pathname.includes("/video/")) ||
      host === "tv.naver.com" ||
      host === "vimeo.com"
    );
  } catch {
    return false;
  }
}

/**
 * Rewrites a URL to a version whose text loads without frames. Naver blog
 * posts keep the article in an iframe on desktop; the mobile page does not.
 *
 * @param {string} url
 * @returns {string}
 */
export function toReadableUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "blog.naver.com") {
      return url;
    }
    const blogId = parsed.searchParams.get("blogId");
    const logNo = parsed.searchParams.get("logNo");
    if (blogId && logNo) {
      return `https://m.blog.naver.com/${blogId}/${logNo}`;
    }
    const match = parsed.pathname.match(/^\/([^/]+)\/(\d+)\/?$/);
    return match ? `https://m.blog.naver.com/${match[1]}/${match[2]}` : url;
  } catch {
    return url;
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
      if (lowerKey.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(lowerKey)) {
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

function createLoadError() {
  const err = new Error("페이지를 열 수 없음 → 다음 순위 결과 탐색");
  err.name = "LoadError";
  return err;
}

/**
 * Starts loading `uri` and resolves once the new top-level document has been
 * committed (not when every subresource has finished). Network error pages
 * reject right away so the caller can move on to the next candidate.
 *
 * @param {MozBrowser} browser
 * @param {nsIURI} uri
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.strictTimeout] Reject instead of resolving on timeout.
 * @param {AbortSignal} [options.signal]
 * @param {AbortSignal} [options.earlyStopSignal]
 */
function loadUntilCommitted(browser, uri, options = {}) {
  const {
    timeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
    strictTimeout = false,
    signal,
    earlyStopSignal,
  } = options;
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
    let done = false;

    const finish = (callback, value, stop = false) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      earlyStopSignal?.removeEventListener("abort", onEarlyStop);
      try {
        browser.webProgress?.removeProgressListener(listener);
      } catch {}
      if (stop) {
        try {
          browser.stop();
        } catch {}
      }
      callback(value);
    };

    const onAbort = () =>
      finish(reject, new DOMException("Aborted", "AbortError"), true);
    const onEarlyStop = () => finish(reject, createEarlyStopError(), true);

    signal?.addEventListener("abort", onAbort, { once: true });
    earlyStopSignal?.addEventListener("abort", onEarlyStop, { once: true });

    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onLocationChange(webProgress, request, location, flags) {
        if (
          !webProgress?.isTopLevel ||
          !location ||
          location.spec === "about:blank" ||
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
        ) {
          return;
        }
        if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE) {
          finish(reject, createLoadError(), true);
          return;
        }
        finish(resolve);
      },
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
        const unreadable = unreadableDocuments.get(browser.browserId);
        if (unreadable) {
          finish(reject, createUnreadableDocumentError(unreadable), true);
          return;
        }
        if (
          request instanceof Ci.nsIChannel &&
          request.URI?.spec === "about:blank" &&
          uri.spec !== "about:blank"
        ) {
          return;
        }
        finish(resolve);
      },
    };

    timer = setTimeout(() => {
      if (strictTimeout) {
        finish(reject, createTimeoutError(timeoutMs), true);
        return;
      }
      finish(resolve);
    }, timeoutMs);

    browser.webProgress.addProgressListener(
      listener,
      Ci.nsIWebProgress.NOTIFY_STATE_ALL | Ci.nsIWebProgress.NOTIFY_LOCATION
    );

    const triggeringPrincipal = uri.schemeIs("file")
      ? Services.scriptSecurityManager.getSystemPrincipal()
      : Services.scriptSecurityManager.createNullPrincipal({});

    browser.loadURI(uri, { triggeringPrincipal });
  });
}

/**
 * The location change can reach the parent before the new document's window
 * global becomes current, so poll briefly until it does.
 *
 * @param {MozBrowser} browser
 * @param {number} deadline Epoch milliseconds after which polling stops.
 */
async function waitForDocumentGlobal(browser, deadline) {
  while (true) {
    const global = browser.browsingContext?.currentWindowGlobal;
    const spec = global?.documentURI?.spec;
    if (global && !global.isInitialDocument && spec && spec !== "about:blank") {
      return global;
    }
    if (Date.now() >= deadline) {
      return global ?? null;
    }
    await new Promise(resolve => setTimeout(resolve, COMMIT_POLL_MS));
  }
}

/**
 * Builds a short search overview: featured answers first, then the snippets
 * of results that were not read in full (those are already in the prompt).
 *
 * @param {object} searchPage
 * @param {Set<string>} readUrls Normalized URLs of pages read in full.
 * @param {number} budget
 * @param {(url: string, title: string) => number} cite Returns the source
 *   number of a result.
 * @returns {string}
 */
function buildSerpOverview(searchPage, readUrls, budget, cite) {
  if (!searchPage) {
    return "";
  }
  const featured = String(searchPage.text || "")
    .split("\n")
    .filter(line => line.startsWith("[핵심 스니펫]"))
    .map(text => ({ text }));
  const results = (searchPage.links || [])
    .filter(link => !readUrls.has(normalizeUrlForDedup(link.url)))
    .map(link => {
      const snippet = stripFootnoteMarks(
        String(link.context || "").slice(0, SERP_SNIPPET_CHARS)
      );
      return {
        link,
        text: snippet ? `${link.title} — ${snippet}` : link.title,
      };
    });
  const lines = [];
  let used = 0;
  for (const { link, text } of [...featured, ...results]) {
    // Leaves room for the "- [12] " prefix of a numbered result.
    const cost = text.length + (link ? 8 : 1);
    if (used + cost > budget) {
      continue;
    }
    lines.push(link ? `- [${cite(link.url, link.title)}] ${text}` : text);
    used += cost;
  }
  return lines.join("\n");
}

// Page footnote markers like "[3]" would read as source numbers.
function stripFootnoteMarks(text) {
  return String(text || "").replace(/\[\d{1,3}\]/g, "");
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

const COVERAGE_PAGE_CHARS = 700;
const COVERAGE_SNIPPETS = 4;

/**
 * Asks the decision model, for every `need` of the searched queries, whether
 * the snippets and page excerpts collected for it already state it. Queries
 * without a need are not judged.
 *
 * @param {object} params
 * @param {Array<object>} params.entries Loaded search entries.
 * @param {Array<object>} params.visitedPages
 * @param {string} params.question
 * @param {object} params.config From AgentDecide.getConfig().
 * @param {object} params.stats decideStats of the search, updated in place.
 * @param {AbortSignal} [params.signal]
 * @param {(event: object) => void} [params.onEvent]
 * @returns {Promise<{threshold: number, needs: Array<{need: string, queries: Array<string>, probability: number|null}>}|null>}
 *   null when nothing was judged or the judgment failed.
 */
async function assessNeedCoverage({
  entries,
  visitedPages,
  question,
  config,
  stats,
  signal,
  onEvent,
}) {
  // Evidence per query; a need searched by several queries gets all of it.
  const groups = new Map();
  const evidenceByQuery = new Map();
  for (const entry of entries) {
    if (!entry.needs?.length) {
      continue;
    }
    const evidence = [];
    evidence.push(
      ...String(entry.searchPage?.text || "")
        .split("\n")
        .filter(line => line.startsWith("[핵심 스니펫]")),
      ...entry.candidates
        .filter(candidate => candidate.decision !== "drop")
        .slice(0, COVERAGE_SNIPPETS)
        .map(candidate => `${candidate.title} — ${candidate.context || ""}`)
    );
    for (const page of visitedPages) {
      if (!page.error && page.matchedQueries?.includes(entry.query)) {
        evidence.push(String(page.text || "").slice(0, COVERAGE_PAGE_CHARS));
      }
    }
    evidenceByQuery.set(entry.query, evidence);
    for (const need of entry.needs) {
      const group = groups.get(need) || { queries: [] };
      group.queries.push(entry.query);
      groups.set(need, group);
    }
  }
  if (!groups.size) {
    return null;
  }
  const searchQueries = Array.from(evidenceByQuery.keys());
  const searches = searchQueries.map(query => ({
    query,
    evidence: evidenceByQuery.get(query).filter(Boolean).join("\n"),
  }));
  const needs = Array.from(groups, ([need, group]) => ({
    need,
    queries: group.queries,
    searches: group.queries.map(query => searchQueries.indexOf(query)),
  }));
  const startedAt = Date.now();
  let result = null;
  let error = null;
  try {
    result = await AgentDecide.assessCoverage(
      { question, searches, needs },
      { config, signal }
    );
  } catch (e) {
    if (signal?.aborted) {
      throw e;
    }
    error = e;
  }
  stats.calls++;
  if (error) {
    stats.failed++;
  } else {
    stats.maxMs = Math.max(stats.maxMs, result.durationMs);
    stats.inputTokens += result.inputTokens;
  }
  const judged = needs.map((item, i) => ({
    need: item.need,
    queries: item.queries,
    probability: result ? result.found[i] : null,
  }));
  try {
    onEvent?.({
      type: "decide_done",
      purpose: "coverage",
      query: needs.map(item => item.need).join(" | "),
      durationMs: result?.durationMs ?? Date.now() - startedAt,
      coverage: judged.map(({ need, probability }) => ({ need, probability })),
      inputTokens: result?.inputTokens ?? 0,
      error: error ? error.message || String(error) : null,
    });
  } catch {}
  return result ? { threshold: config.coverageThreshold, needs: judged } : null;
}

export const AgentHeadless = {
  getActiveBrowsers() {
    return Array.from(activeBrowsers.values());
  },

  getAdaptiveBudget(options = {}) {
    return computeAdaptiveHeadlessBudget(options);
  },

  /**
   * Prepares the windowless frame and a connection to the search engine while
   * the model is still deciding whether to call a tool.
   *
   * @param {object} [options]
   * @param {string} [options.searchUrlTemplate]
   */
  prewarm(options = {}) {
    getHiddenFrameWindow().then(scheduleHiddenFrameRelease, () => {});
    speculativeConnect(this.buildSearchUrl("", options.searchUrlTemplate));
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

    const isSearchPurpose =
      purpose === "search" || purpose.startsWith("search-");
    const deadline = startedAt + effectiveTimeoutMs;
    let blockedBrowserId = 0;

    try {
      return await withHeadlessBrowser(async browser => {
        const bc = browser.browsingContext;
        if (bc) {
          bc.useGlobalHistory = false;
          try {
            bc.useTrackingProtection = true;
          } catch {}
          bc.mediaController?.mute();
          blockedBrowserId = bc.browserId;
          setRequestBlocking(
            blockedBrowserId,
            isSearchPurpose ? BLOCKED_TYPES_SEARCH : BLOCKED_TYPES_PAGE
          );
        }

        await loadUntilCommitted(browser, uri, {
          timeoutMs: effectiveTimeoutMs,
          strictTimeout,
          signal: options.signal,
          earlyStopSignal: options.earlyStopSignal,
        });

        if (options.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        if (options.earlyStopSignal?.aborted) {
          throw createEarlyStopError();
        }
        await waitForDocumentGlobal(
          browser,
          Math.min(deadline, Date.now() + 500)
        );

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
          const textLimit = options.textLimit ?? 6000;
          const maxLinks = options.maxLinks ?? 15;
          const extractOnce = () =>
            session.extractPageData({
              purpose,
              textLimit,
              maxLinks,
              query: options.query || "",
              timeoutMs: Math.max(500, deadline - Date.now()),
            });
          const extractPromise = (async () => {
            try {
              let extracted;
              const firstGlobal = browser.browsingContext?.currentWindowGlobal;
              try {
                extracted = await extractOnce();
              } catch (error) {
                // A script or meta redirect replaced the document mid-query.
                if (
                  Date.now() >= deadline ||
                  browser.browsingContext?.currentWindowGlobal === firstGlobal
                ) {
                  throw error;
                }
                await waitForDocumentGlobal(
                  browser,
                  Math.min(deadline, Date.now() + 500)
                );
                extracted = await extractOnce();
              }
              if (extracted?.extractionMethod === "blocked") {
                const blockedError = new Error(
                  "검색 엔진이 자동 요청을 차단함 (CAPTCHA)"
                );
                blockedError.name = "BlockedError";
                throw blockedError;
              }
              if (
                extracted &&
                ((extracted.text && !!extracted.text.trim().length) ||
                  (Array.isArray(extracted.links) && !!extracted.links.length))
              ) {
                return {
                  url: extracted.url || loadedUrl,
                  title: extracted.title || "",
                  text: extracted.text || "",
                  textTruncated: Boolean(extracted.textTruncated),
                  links: extracted.links || [],
                  extractionMethod: extracted.extractionMethod || "direct",
                };
              }
            } catch (error) {
              if (error?.name === "BlockedError") {
                throw error;
              }
            }

            const observation = await session.observe({
              showOverlay: false,
              watch: false,
              includeOffscreenText: options.includeOffscreenText ?? true,
              textLimit,
              maxActions: options.maxActions ?? 120,
              query: options.query || "",
            });
            return {
              ...extractStructuredPage(observation, { maxLinks }),
              extractionMethod: "observation-fallback",
            };
          })();

          const racePromises = [extractPromise];
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

          const structured =
            racePromises.length > 1
              ? await Promise.race(racePromises)
              : await extractPromise;

          clearTimeout(observeTimer);
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
            extractionMethod: structured.extractionMethod,
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
          session.destroy();
          setRequestBlocking(blockedBrowserId, null);
        }
      });
    } catch (error) {
      setRequestBlocking(blockedBrowserId, null);
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
    const defaultTimeoutMs = getPrefMs(
      PREF_PAGE_TIMEOUT_MS,
      DEFAULT_RESULT_PAGE_TIMEOUT_MS
    );
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
      Array.from({ length: Math.min(maxConcurrency, validUrls.length) }, () =>
        worker(this)
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
   * 3-8 concurrent headless browsers based on available RAM, starts reading
   * result pages as soon as the first SERP arrives, early-terminates slow
   * browsers once enough pages are read or the result budget has passed, falls
   * back to next-rank candidates on the per-page timeout, and deduplicates
   * paragraphs across pages.
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

    // Each query may carry the pieces of information it looks for (`needs`).
    const queries = [];
    const needs = [];
    const seenQueryKeys = new Set();
    for (const q of rawQueries) {
      const isItem = q && typeof q === "object";
      const trimmed = String((isItem ? q.query : q) || "").trim();
      const key = trimmed.toLowerCase();
      if (trimmed && !seenQueryKeys.has(key)) {
        seenQueryKeys.add(key);
        queries.push(trimmed);
        const itemNeeds = Array.isArray(q?.needs) ? q.needs : [q?.need];
        needs.push(
          isItem
            ? itemNeeds.map(need => String(need || "").trim()).filter(Boolean)
            : []
        );
      }
    }
    if (!queries.length) {
      throw new Error("Search query must not be empty");
    }

    const isMultiQuery = queries.length > 1;
    const combinedQueryText = queries.join(" ");

    // SERPs load concurrently. Result pages start as soon as any SERP yields
    // links (interleaved by rank across queries) instead of waiting for the
    // slowest SERP. Visits stop once enough pages are collected, or once the
    // result budget has passed with at least one usable page.
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
    const pageTimeoutMs =
      options.pageTimeoutMs ??
      getPrefMs(PREF_PAGE_TIMEOUT_MS, DEFAULT_RESULT_PAGE_TIMEOUT_MS);
    const resultBudgetMs =
      options.resultBudgetMs ??
      getPrefMs(PREF_RESULT_BUDGET_MS, DEFAULT_RESULT_BUDGET_MS);
    const workerCount = targetPagesToVisit > 0 ? ramBudget.concurrency : 0;

    const searchEntries = queries.map((q, i) => ({
      query: q,
      needs: needs[i],
      searchUrl: this.buildSearchUrl(q, options.searchUrlTemplate),
      searchPage: null,
      filteredLinks: [],
      candidates: [],
      error: null,
    }));
    speculativeConnect(searchEntries[0].searchUrl);

    const seenCandidateMap = new Map();
    const takenUrls = new Set();
    const visitedPages = [];
    let skippedDuplicateUrls = 0;
    let pendingSerps = searchEntries.length;
    let nextRank = 0;
    let completedValidPages = 0;
    let collectedChars = 0;
    let earlyStoppedCount = 0;
    let inFlightWorkers = 0;
    let deadlinePassed = false;
    let budgetTimer = null;
    let hardStopTimer = null;
    let waiters = [];
    const earlyStopController = new AbortController();
    // SERPs outlive the visit stop briefly, so a slower query still gets its
    // snippets and result judgment.
    const serpStopController = new AbortController();
    let serpGraceTimer = null;

    // Snippet filter: results judged unrelated are never opened, the top
    // `speculativeVisits` of each query open by rank while the judgment is
    // pending, and an opened page judged unrelated is cancelled.
    const decideConfig =
      options.useDecide === false ? null : AgentDecide.getConfig();
    const useDecide = Boolean(decideConfig?.enabled) && workerCount > 0;
    if (decideConfig?.requested && !decideConfig.enabled) {
      try {
        options.onEvent?.({
          type: "decide_done",
          purpose: "search",
          query: queries.join(" | "),
          durationMs: 0,
          considered: 0,
          kept: 0,
          snippetsSufficient: null,
          error:
            "API 키 없음 (browser.agent.decide.apiKey 또는 browser.agent.mercury.apiKey)",
        });
      } catch {}
    }
    const userQuestion = String(options.userQuestion || combinedQueryText);
    let pendingAssessments = 0;
    let answeredBySnippets = false;
    const decideStats = {
      calls: 0,
      failed: 0,
      maxMs: 0,
      considered: 0,
      kept: 0,
      dropped: 0,
      cancelled: 0,
      inputTokens: 0,
      snippetsSufficient: [],
    };

    const notifyChange = () => {
      const pending = waiters;
      waiters = [];
      for (const wake of pending) {
        wake();
      }
    };
    const waitForChange = () => new Promise(resolve => waiters.push(resolve));

    const stopSerps = () => {
      if (!serpStopController.signal.aborted) {
        serpStopController.abort();
      }
    };

    const stopVisits = () => {
      if (!earlyStopController.signal.aborted) {
        earlyStopController.abort();
        if (pendingSerps > 0) {
          serpGraceTimer = setTimeout(stopSerps, SERP_GRACE_MS);
        }
      }
      notifyChange();
    };

    const checkEarlyStop = () => {
      if (earlyStopController.signal.aborted) {
        return true;
      }
      if (
        completedValidPages >= targetPagesToVisit ||
        (completedValidPages >= 2 &&
          collectedChars >= sufficientCharsThreshold) ||
        (deadlinePassed && completedValidPages >= 1)
      ) {
        stopVisits();
        return true;
      }
      return false;
    };

    const startBudgetTimers = () => {
      if (budgetTimer || !workerCount) {
        return;
      }
      budgetTimer = setTimeout(() => {
        deadlinePassed = true;
        checkEarlyStop();
      }, resultBudgetMs);
      hardStopTimer = setTimeout(() => {
        stopVisits();
        stopSerps();
      }, resultBudgetMs + pageTimeoutMs);
    };

    const addSerpCandidates = entry => {
      for (const link of entry.filteredLinks) {
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
          position: entry.candidates.length,
          decision: useDecide ? "pending" : "keep",
          relevance: null,
          assessed: false,
          // Video pages and files have no readable page; their snippet is
          // used instead.
          noVisit: isVideoPageUrl(link.url) || isFileUrl(link.url),
          controller: new AbortController(),
        };
        seenCandidateMap.set(normUrl, candidate);
        entry.candidates.push(candidate);
      }
      for (const candidate of entry.candidates.slice(0, workerCount * 2)) {
        speculativeConnect(candidate.url);
      }
    };

    const pickNextCandidate = () => {
      const maxDepth = Math.max(
        0,
        ...searchEntries.map(entry => entry.candidates.length)
      );
      for (let depth = 0; depth < maxDepth; depth++) {
        for (const entry of searchEntries) {
          const candidate = entry.candidates[depth];
          const visitable =
            !candidate?.noVisit &&
            (candidate?.decision === "keep" ||
              (candidate?.decision === "pending" &&
                candidate.position < decideConfig.speculativeVisits));
          if (visitable && !takenUrls.has(candidate.normalizedUrl)) {
            takenUrls.add(candidate.normalizedUrl);
            return candidate;
          }
        }
      }
      return null;
    };

    const applyAssessment = (entry, candidates, result) => {
      // Results past the judged ones stay as a fallback behind them.
      for (const candidate of entry.candidates) {
        if (candidate.decision === "pending") {
          candidate.decision = "keep";
        }
      }
      if (!result) {
        return;
      }
      const { relevanceThreshold, minKeep } = decideConfig;
      const scored = candidates.map((candidate, i) => {
        candidate.relevance = result.relevance[i];
        candidate.assessed = true;
        return candidate;
      });
      // Unanswered results count as relevant; at least `minKeep` per query
      // are kept so a strict or miscalibrated judgment never empties it.
      const keep = new Set(
        scored.filter(
          c => c.relevance === null || c.relevance >= relevanceThreshold
        )
      );
      const byRelevance = [...scored].sort(
        (a, b) => (b.relevance ?? 1) - (a.relevance ?? 1)
      );
      for (const candidate of byRelevance) {
        if (keep.size >= minKeep) {
          break;
        }
        keep.add(candidate);
      }
      for (const candidate of scored) {
        candidate.decision = keep.has(candidate) ? "keep" : "drop";
        if (candidate.decision === "drop") {
          candidate.controller.abort();
          // A page that was read speculatively stops counting as collected.
          if (candidate.countedChars !== undefined) {
            completedValidPages--;
            collectedChars -= candidate.countedChars;
            delete candidate.countedChars;
          }
        }
      }
      entry.candidates.sort(
        (a, b) =>
          (a.decision === "drop") - (b.decision === "drop") ||
          b.assessed - a.assessed ||
          (b.relevance ?? 1) - (a.relevance ?? 1) ||
          a.position - b.position
      );
      decideStats.considered += scored.length;
      decideStats.kept += keep.size;
      decideStats.dropped += scored.length - keep.size;
      entry.snippetsSufficient = result.snippetsSufficient;
      if (result.snippetsSufficient !== null) {
        decideStats.snippetsSufficient.push(result.snippetsSufficient);
      }
    };

    const checkSnippetsAnswer = () => {
      const loaded = searchEntries.filter(entry => entry.searchPage);
      if (
        pendingSerps === 0 &&
        loaded.length &&
        loaded.every(
          entry =>
            entry.snippetsSufficient >= decideConfig.snippetsSufficientThreshold
        )
      ) {
        answeredBySnippets = true;
        stopVisits();
      }
    };

    const assessEntry = async (entry, purpose) => {
      const candidates = entry.candidates.slice(0, decideConfig.maxResults);
      const startedAt = Date.now();
      let result = null;
      let error = null;
      try {
        result = await AgentDecide.assessSearchResults(
          {
            question: userQuestion,
            query: entry.query,
            results: candidates,
            featured: String(entry.searchPage.text || "")
              .split("\n")
              .filter(line => line.startsWith("[핵심 스니펫]")),
          },
          { config: decideConfig, signal: options.signal }
        );
      } catch (e) {
        if (options.signal?.aborted) {
          pendingAssessments--;
          throw e;
        }
        error = e;
      }
      pendingAssessments--;
      decideStats.calls++;
      if (error) {
        decideStats.failed++;
      } else {
        decideStats.maxMs = Math.max(decideStats.maxMs, result.durationMs);
        decideStats.inputTokens += result.inputTokens;
      }
      applyAssessment(entry, candidates, result);
      try {
        options.onEvent?.({
          type: "decide_done",
          purpose,
          query: entry.query,
          durationMs: result?.durationMs ?? Date.now() - startedAt,
          considered: candidates.length,
          kept: candidates.filter(c => c.decision === "keep").length,
          snippetsSufficient: result?.snippetsSufficient ?? null,
          inputTokens: result?.inputTokens ?? 0,
          error: error ? error.message || String(error) : null,
        });
      } catch {}
      checkSnippetsAnswer();
      notifyChange();
    };

    const loadSerp = async (entry, idx) => {
      try {
        entry.searchPage = await this.observeUrl(entry.searchUrl, {
          timeoutMs: options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
          textLimit: options.searchTextLimit ?? 5000,
          maxLinks: options.maxLinks ?? 15,
          signal: options.signal,
          earlyStopSignal: serpStopController.signal,
          onEvent: options.onEvent,
          purpose: isMultiQuery ? `search-${idx + 1}` : "search",
          query: entry.query,
        });
        entry.filteredLinks = (entry.searchPage.links || []).filter(
          link => !isSearchEngineInternalLink(link.url, entry.searchUrl)
        );
        addSerpCandidates(entry);
        startBudgetTimers();
      } catch (error) {
        if (options.signal?.aborted || error?.name === "AbortError") {
          throw error;
        }
        entry.error = error;
      } finally {
        // Counted before the SERP stops being pending, so idle workers keep
        // waiting for the judgment instead of exiting.
        if (useDecide && entry.searchPage && entry.candidates.length) {
          pendingAssessments++;
        }
        pendingSerps--;
        notifyChange();
      }
      if (useDecide && entry.searchPage && entry.candidates.length) {
        await assessEntry(entry, isMultiQuery ? `search-${idx + 1}` : "search");
      }
    };

    const visitSlotWorker = async () => {
      let retired = false;
      while (!earlyStopController.signal.aborted) {
        if (options.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const mayLaunch =
          !retired ||
          completedValidPages + inFlightWorkers < targetPagesToVisit;
        const link = mayLaunch ? pickNextCandidate() : null;
        if (!link) {
          if (
            pendingSerps > 0 ||
            pendingAssessments > 0 ||
            (retired && inFlightWorkers > 0)
          ) {
            await waitForChange();
            continue;
          }
          return;
        }
        retired = false;
        const rank = ++nextRank;
        const startedAt = Date.now();
        inFlightWorkers++;
        let page = null;
        let failure = null;
        try {
          page = await this.observeUrl(toReadableUrl(link.url), {
            timeoutMs: pageTimeoutMs,
            strictTimeout: true,
            textLimit: options.pageTextLimit ?? 3000,
            maxLinks: 8,
            signal: options.signal,
            earlyStopSignal: AbortSignal.any([
              earlyStopController.signal,
              link.controller.signal,
            ]),
            onEvent: options.onEvent,
            purpose: `result-${rank}`,
            rank,
            query: combinedQueryText,
          });
        } catch (error) {
          failure = error;
        }
        inFlightWorkers--;
        if (failure) {
          if (options.signal?.aborted || failure?.name === "AbortError") {
            throw failure;
          }
          const filtered = link.decision === "drop";
          if (filtered) {
            decideStats.cancelled++;
          } else if (failure?.earlyStopped) {
            earlyStoppedCount++;
          }
          visitedPages.push({
            url: link.url,
            title: link.title,
            text: "",
            filtered,
            error: filtered
              ? "검색 결과 판단에서 관련성 낮음 → 방문 취소"
              : failure?.message || String(failure),
            timedOut: Boolean(failure?.timedOut),
            earlyStopped: Boolean(failure?.earlyStopped),
            rank,
            matchedQueries: link.matchedQueries,
            links: [],
            durationMs: Date.now() - startedAt,
          });
          notifyChange();
          continue;
        }
        visitedPages.push({
          ...page,
          url: link.url,
          serpTitle: link.title,
          rank,
          matchedQueries: link.matchedQueries,
          candidate: link,
        });
        if ((page.text || "").trim() && link.decision !== "drop") {
          link.countedChars = page.text.length;
          completedValidPages++;
          collectedChars += page.text.length;
        }
        if (checkEarlyStop()) {
          return;
        }
        retired = completedValidPages + inFlightWorkers >= targetPagesToVisit;
        notifyChange();
      }
    };

    try {
      await Promise.all([
        ...searchEntries.map(loadSerp),
        ...Array.from({ length: workerCount }, visitSlotWorker),
      ]);
    } finally {
      clearTimeout(budgetTimer);
      clearTimeout(hardStopTimer);
      stopVisits();
      clearTimeout(serpGraceTimer);
      stopSerps();
    }

    const loadedEntries = searchEntries.filter(entry => entry.searchPage);
    if (!loadedEntries.length) {
      throw searchEntries[0].error || new Error("Search failed");
    }

    const droppedUrls = new Set();
    for (const entry of searchEntries) {
      for (const candidate of entry.candidates) {
        if (candidate.decision === "drop") {
          droppedUrls.add(candidate.normalizedUrl);
        }
      }
    }
    for (const page of visitedPages) {
      if (page.candidate?.decision === "drop" && !page.error) {
        page.filtered = true;
        page.error = "검색 결과 판단에서 관련성 낮음 → 제외";
        page.text = "";
        // Takes the page out of the activity list, which showed it as read.
        emitHeadlessEvent(options.onEvent, {
          type: "headless_error",
          browserId: page.browserId,
          url: page.url,
          error: page.error,
          earlyStopped: true,
          rank: page.rank,
          durationMs: page.durationMs,
          purpose: page.purpose,
        });
      }
      delete page.candidate;
    }

    visitedPages.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

    // A title several pages share is a site-wide default (Reddit's "The
    // heart of the internet"), so the result title is clearer.
    const titleCounts = new Map();
    for (const page of visitedPages) {
      titleCounts.set(page.title, (titleCounts.get(page.title) || 0) + 1);
    }
    for (const page of visitedPages) {
      if (page.serpTitle && (!page.title || titleCounts.get(page.title) > 1)) {
        page.title = page.serpTitle;
      }
      delete page.serpTitle;
    }

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

    // Keep the most query-relevant lines across pages within one budget, so
    // the synthesis prompt does not grow with every page read.
    const contextBudget = fitPagesToBudget(
      visitedPages.filter(page => !page.error),
      combinedQueryText,
      options.contextCharBudget ??
        getPrefMs(PREF_CONTEXT_CHAR_BUDGET, DEFAULT_CONTEXT_CHAR_BUDGET)
    );

    const coverage =
      useDecide &&
      decideConfig.coverage &&
      options.checkCoverage !== false &&
      !answeredBySnippets
        ? await assessNeedCoverage({
            entries: loadedEntries,
            visitedPages,
            question: userQuestion,
            config: decideConfig,
            stats: decideStats,
            signal: options.signal,
            onEvent: options.onEvent,
          })
        : null;

    const dedupStats = {
      ...textDedupStats,
      contextCharsBefore: contextBudget.before,
      contextCharsAfter: contextBudget.after,
      skippedDuplicateUrls,
      queryCount: queries.length,
      earlyStoppedCount,
      headlessConcurrency: workerCount,
      ramBudget,
      ...(useDecide
        ? { decide: { ...decideStats, answeredBySnippets, coverage } }
        : {}),
    };

    const primaryEntry = loadedEntries[0];
    const report = this.formatSearchReport({
      query: primaryEntry.query,
      queries,
      searchPage: primaryEntry.searchPage,
      searchEntries: loadedEntries,
      visitedPages,
      droppedUrls,
      citeSource: options.citeSource,
    });

    return {
      query: primaryEntry.query,
      queries,
      searchUrl: primaryEntry.searchUrl,
      searchPage: primaryEntry.searchPage,
      searchPages: loadedEntries.map(e => e.searchPage),
      visitedPages,
      ramBudget,
      dedupStats,
      coverage,
      sources: report.sources,
      formattedContext: report.text,
      compactContext: report.compact,
    };
  },

  /**
   * Formats the collected headless search & page observations into a concise,
   * source-URL-free text block for the LLM tool response.
   *
   * @param {object} report
   * @param {string} report.query
   * @param {Array<string>} [report.queries]
   * @param {object} [report.searchPage]
   * @param {Array<object>} [report.searchEntries]
   * @param {Array<object>} [report.visitedPages]
   * @param {Set<string>} [report.droppedUrls] Normalized URLs the snippet
   *   filter judged unrelated.
   * @param {(url: string, title: string) => number} [report.citeSource]
   *   Returns the number of a source; the same page keeps its number across
   *   the searches of one answer.
   * @returns {{text: string, compact: string, sources: Array<{id: number, url: string, title: string}>}}
   *   `compact` keeps the snippets and the titles of the pages read, for a
   *   turn that only plans the next search.
   */
  formatSearchReport({
    query,
    queries,
    searchPage,
    searchEntries,
    visitedPages,
    droppedUrls,
    citeSource,
  }) {
    const entries =
      Array.isArray(searchEntries) && searchEntries.length
        ? searchEntries
        : [{ query, searchPage }];
    const sources = [];
    const sourceIds = new Map();
    const cite = (url, title) => {
      const key = normalizeUrlForDedup(url);
      if (!sourceIds.has(key)) {
        const id = citeSource
          ? citeSource(url, title || "")
          : sourceIds.size + 1;
        sourceIds.set(key, id);
        sources.push({ id, url, title: title || "" });
      }
      return sourceIds.get(key);
    };
    const documents = [];
    for (const page of visitedPages || []) {
      if (page.error || !page.text?.trim()) {
        continue;
      }
      const title = page.title || "Document";
      documents.push({ id: cite(page.url, title), title, text: page.text });
    }
    // Results read in full or judged unrelated add nothing as snippets.
    const readUrls = new Set([
      ...(droppedUrls || []),
      ...(visitedPages || [])
        .filter(page => !page.error && page.text?.trim())
        .map(page => normalizeUrlForDedup(page.url)),
    ]);
    // One budget for every query, so more queries do not mean more snippets.
    const overviewBudget = Math.max(
      300,
      Math.floor(
        getPrefMs(
          PREF_SERP_OVERVIEW_CHAR_BUDGET,
          DEFAULT_SERP_OVERVIEW_CHAR_BUDGET
        ) / entries.length
      )
    );
    const describeQuery = entry =>
      entry.needs?.length
        ? `${entry.query} — needs: ${entry.needs.join(", ")}`
        : entry.query;

    const sections = [];
    if (entries.length > 1) {
      sections.push(
        `[Queries]: ${(queries || entries.map(e => e.query)).join(" | ")}`
      );
      for (const [idx, entry] of entries.entries()) {
        const overview = buildSerpOverview(
          entry.searchPage,
          readUrls,
          overviewBudget,
          cite
        );
        if (overview) {
          sections.push(
            `[Search Overview #${idx + 1} (${describeQuery(entry)})]:\n${overview}`
          );
        }
      }
    } else {
      sections.push(`[Query]: ${describeQuery(entries[0])}`);
      const overview = buildSerpOverview(
        entries[0].searchPage,
        readUrls,
        overviewBudget,
        cite
      );
      if (overview) {
        sections.push(`[Search Overview]:\n${overview}`);
      }
    }

    const compactSections = sections.slice();
    if (documents.length) {
      compactSections.push(
        `[Documents read]:\n${documents.map(doc => `- [${doc.id}] ${doc.title}`).join("\n")}`
      );
    }
    for (const doc of documents) {
      sections.push(
        `[Document ${doc.id} — ${doc.title}]:\n${stripFootnoteMarks(doc.text)}`
      );
    }

    return {
      text: sections.join("\n\n"),
      compact: compactSections.join("\n\n"),
      sources,
    };
  },
};
