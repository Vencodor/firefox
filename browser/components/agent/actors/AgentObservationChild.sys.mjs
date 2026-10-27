/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectDOMObservation } from "resource:///modules/agent/observation/DOMObservation.sys.mjs";
import { ObservationOverlay } from "resource:///modules/agent/observation/ObservationOverlay.sys.mjs";
import { selectRelevantText } from "resource:///modules/agent/observation/TextRelevance.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ReaderWorker: "moz-src:///toolkit/components/reader/ReaderWorker.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "Readability", () => {
  const scope = {};
  Services.scriptloader.loadSubScript(
    "moz-src:///toolkit/components/reader/readability/Readability.js",
    scope
  );
  return scope.Readability;
});

const NOISE_CONTAINER_SELECTOR =
  'script,style,noscript,template,svg,canvas,nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[aria-hidden="true"]';
const READER_STRIP_SELECTOR =
  "script,style,noscript,template,svg,canvas,iframe,object,embed,video,audio,source,link";
const OBSERVED_EVENTS = [
  "scroll",
  "resize",
  "input",
  "change",
  "pagehide",
  "hashchange",
  "popstate",
];
const THIN_ARTICLE_CHARS = 200;
const THIN_CONTENT_WAIT_MS = 1200;
const DEADLINE_MARGIN_MS = 150;

function normalizeWhitespace(str) {
  return String(str || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function passesReadabilityQualityCheck(readerText, semanticText = "") {
  if (!readerText || readerText.length < 80) {
    return false;
  }
  if (
    semanticText.length >= 200 &&
    readerText.length < semanticText.length * 0.35
  ) {
    return false;
  }
  const substantiveLines = readerText
    .split(/\r?\n/)
    .filter(l => l.trim().length >= 25);
  return Boolean(substantiveLines.length) || readerText.length >= 160;
}

function unwrapGoogleHref(rawHref, baseURI) {
  if (!rawHref) {
    return null;
  }
  try {
    const resolved = new URL(rawHref, baseURI || "https://www.google.com");
    if (!["http:", "https:"].includes(resolved.protocol)) {
      return null;
    }
    if (resolved.pathname === "/url" || resolved.pathname === "/interstitial") {
      const target =
        resolved.searchParams.get("q") || resolved.searchParams.get("url");
      if (target) {
        const parsedTarget = new URL(target);
        if (["http:", "https:"].includes(parsedTarget.protocol)) {
          return parsedTarget.href;
        }
      }
    }
    const uddg = resolved.searchParams.get("uddg");
    if (uddg) {
      const parsedUddg = new URL(uddg);
      if (["http:", "https:"].includes(parsedUddg.protocol)) {
        return parsedUddg.href;
      }
    }
    return resolved.href;
  } catch {
    return null;
  }
}

function isInternalSearchHref(href, pageHost) {
  try {
    const parsed = new URL(href);
    const linkHost = parsed.hostname.toLowerCase();
    const isGoogle = host =>
      /(?:^|\.)(?:google\.[a-z.]+|gstatic\.com|googleusercontent\.com|ggpht\.com|googleapis\.com|g\.co)$/i.test(
        host
      );
    if (isGoogle(pageHost)) {
      if (
        isGoogle(linkHost) ||
        linkHost === "accounts.youtube.com" ||
        parsed.pathname.startsWith("/search") ||
        parsed.pathname.startsWith("/preferences") ||
        parsed.pathname.startsWith("/setprefs")
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** Keeps DOM references and diagnostic overlays inside their owning document. */
export class AgentObservationChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    switch (name) {
      case "AgentObservation:Capture":
        return this.capture(data);
      case "AgentObservation:ExtractPage":
        return this.extractPageData(data);
      case "AgentObservation:Show":
        return this.show(data);
      case "AgentObservation:Clear":
        if (this.id === data.id) {
          this.clear();
        }
        return true;
    }
    return null;
  }

  /**
   * Extracts text and links as soon as the document has been parsed, instead
   * of waiting for every subresource. Thin results (client-rendered pages) get
   * one more attempt after the load event or a short wait.
   *
   * @param {object} options purpose, textLimit, maxLinks, query, timeoutMs.
   */
  async extractPageData(options = {}) {
    const deadline =
      Date.now() +
      Math.max(100, (options.timeoutMs ?? 4000) - DEADLINE_MARGIN_MS);
    await this.#waitForReadyState("interactive", deadline);
    let result = await this.#extractOnce(options);
    const thin =
      result.extractionMethod === "google-serp-parser"
        ? !result.links.length
        : result.text.length < THIN_ARTICLE_CHARS;
    if (
      thin &&
      result.extractionMethod !== "blocked" &&
      this.document?.readyState !== "complete"
    ) {
      await this.#waitForReadyState(
        "complete",
        Math.min(deadline, Date.now() + THIN_CONTENT_WAIT_MS)
      );
      if (this.document) {
        result = await this.#extractOnce(options);
      }
    }
    return result;
  }

  #waitForReadyState(state, deadline) {
    const win = this.contentWindow;
    const doc = this.document;
    const reached = () =>
      !doc ||
      (state === "complete"
        ? doc.readyState === "complete"
        : doc.readyState !== "loading");
    if (reached() || Date.now() >= deadline) {
      return Promise.resolve();
    }
    const type = state === "complete" ? "load" : "DOMContentLoaded";
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        win?.removeEventListener(type, done, true);
        win?.removeEventListener("pagehide", done, true);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
      win.addEventListener(type, done, true);
      win.addEventListener("pagehide", done, true);
    });
  }

  async #extractOnce(options) {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc || !win) {
      return {
        url: "",
        title: "",
        text: "",
        links: [],
        extractionMethod: "empty",
      };
    }

    const url = doc.location?.href || doc.documentURI || "";
    const title = normalizeWhitespace(doc.title || "");
    const maxLinks = Math.max(1, options.maxLinks ?? 15);
    const textLimit = Math.max(200, options.textLimit ?? 6000);
    const purpose = String(options.purpose || "page");
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {}

    const isGoogle = /(?:^|\.)google\.[a-z.]+$/i.test(host);
    if (isGoogle && doc.location?.pathname.startsWith("/sorry")) {
      return {
        url,
        title,
        text: "",
        links: [],
        extractionMethod: "blocked",
      };
    }

    const isSearchPurpose =
      purpose === "search" ||
      purpose.startsWith("search-") ||
      (isGoogle && doc.location?.pathname === "/search");

    if (isSearchPurpose) {
      return this.#extractSearchEnginePage(doc, {
        url,
        title,
        host,
        maxLinks,
        textLimit,
      });
    }

    return this.#extractArticlePage(doc, {
      url,
      title,
      host,
      maxLinks,
      textLimit,
      query: options.query || "",
    });
  }

  #extractSearchEnginePage(doc, { url, title, host, maxLinks, textLimit }) {
    const seenUrls = new Set();
    const links = [];
    const overviewParts = [];

    // 1. Direct answer / Featured snippet / Knowledge panel on Google SERP
    const featuredSelectors = [
      "[data-attrid='wa:/description']",
      "[data-attrid='hw:/collection/events:description']",
      ".IZ6rdc",
      ".hgKElc",
      ".Z0LcW",
      ".LGOjhe",
      ".wDYxhc",
    ];
    const seenSnippets = new Set();
    for (const sel of featuredSelectors) {
      for (const node of doc.querySelectorAll(sel)) {
        const text = normalizeWhitespace(node.textContent);
        if (text.length >= 20 && !seenSnippets.has(text)) {
          seenSnippets.add(text);
          overviewParts.push(`[핵심 스니펫] ${text}`);
        }
      }
    }

    const searchRoot =
      doc.querySelector("#rso") ||
      doc.querySelector("#search") ||
      doc.querySelector("main") ||
      doc.body;

    const addCandidateLink = (anchor, headingText, containerNode) => {
      if (!anchor || links.length >= maxLinks) {
        return;
      }
      const rawHref = anchor.getAttribute("href") || anchor.href;
      const cleanHref = unwrapGoogleHref(rawHref, doc.baseURI);
      if (
        !cleanHref ||
        seenUrls.has(cleanHref) ||
        isInternalSearchHref(cleanHref, host)
      ) {
        return;
      }
      const linkTitle = normalizeWhitespace(
        headingText || anchor.textContent || anchor.getAttribute("aria-label")
      );
      if (!linkTitle || linkTitle.length < 2) {
        return;
      }

      let snippet = "";
      const card =
        containerNode ||
        anchor.closest(
          "[data-snc], .MjjYud, .g, .tF2Cxc, article, li, .result"
        );
      if (card) {
        const snippetNode = card.querySelector(
          ".VwiC3b, [data-sncf='1'], .IsZvec, .aCOpRe, .result__snippet, p"
        );
        if (snippetNode && !anchor.contains(snippetNode)) {
          snippet = normalizeWhitespace(snippetNode.textContent);
        }
        if (!snippet) {
          const cardText = normalizeWhitespace(card.textContent);
          if (cardText.length > linkTitle.length + 15) {
            snippet = normalizeWhitespace(
              cardText.replace(linkTitle, "")
            ).slice(0, 320);
          }
        }
      }

      seenUrls.add(cleanHref);
      links.push({
        title: linkTitle,
        url: cleanHref,
        context: snippet,
      });
      overviewParts.push(
        snippet
          ? `${links.length}. ${linkTitle} — ${snippet}`
          : `${links.length}. ${linkTitle}`
      );
    };

    if (searchRoot) {
      // Primary pass: anchors that wrap or are wrapped by headings (Google `a h3`, standard SERP `h2 a`, `h3 a`)
      for (const heading of searchRoot.querySelectorAll(
        "a h3, a h2, h3 a, h2 a, a [role='heading']"
      )) {
        const anchor = heading.tagName === "A" ? heading : heading.closest("a");
        const headingText =
          heading.tagName === "A" ? heading.textContent : heading.textContent;
        addCandidateLink(anchor, headingText);
      }

      // Fallback pass: if fewer than maxLinks, scan remaining anchors inside searchRoot
      if (links.length < maxLinks) {
        for (const anchor of searchRoot.querySelectorAll("a[href]")) {
          if (anchor.closest("nav, header, footer, [role='navigation']")) {
            continue;
          }
          addCandidateLink(anchor, anchor.textContent);
        }
      }
    }

    const combinedText = overviewParts.join("\n").slice(0, textLimit);
    return {
      url,
      title,
      text: combinedText,
      textTruncated: overviewParts.join("\n").length > textLimit,
      links,
      extractionMethod: "google-serp-parser",
    };
  }

  async #extractArticlePage(
    doc,
    { url, title, host, maxLinks, textLimit, query }
  ) {
    const semantic = this.#extractSemanticBlocksText(doc);
    const semanticText = semantic.text;
    const links = this.#extractContentLinks(doc, { host, maxLinks });

    let reader = null;
    if (!(semantic.fromArticle && semanticText.length >= textLimit)) {
      reader = await this.#parseWithReadability(doc);
    }
    const readerText = normalizeWhitespace(reader?.textContent || "");

    let finalText = semanticText;
    let extractionMethod = "semantic-dom";
    if (
      passesReadabilityQualityCheck(readerText, semanticText) ||
      readerText.length > semanticText.length
    ) {
      finalText = readerText;
      extractionMethod = "firefox-readability";
    }

    return {
      url,
      title:
        (extractionMethod === "firefox-readability" &&
          normalizeWhitespace(reader?.title || "")) ||
        title,
      text: selectRelevantText(finalText, query, textLimit),
      textTruncated: finalText.length > textLimit,
      links,
      extractionMethod,
    };
  }

  /**
   * Runs Readability in this content process on a stripped clone, so the page
   * is never serialized across processes or queued on a shared worker.
   *
   * @param {Document} doc
   */
  async #parseWithReadability(doc) {
    let clone;
    try {
      clone = doc.cloneNode(true);
      for (const el of clone.querySelectorAll(READER_STRIP_SELECTOR)) {
        el.remove();
      }
    } catch {
      return null;
    }
    try {
      return new lazy.Readability(clone, {
        charThreshold: 120,
        serializer: () => "",
      }).parse();
    } catch {}
    try {
      const base = doc.baseURIObject;
      let host = doc.documentURI;
      let pathBase = doc.documentURI;
      try {
        host = base.host;
        pathBase = Services.io.newURI(".", null, base).spec;
      } catch {}
      const serializedDoc =
        new this.contentWindow.XMLSerializer().serializeToString(clone);
      return await lazy.ReaderWorker.post("parseDocument", [
        {
          spec: base.spec,
          prePath: base.prePath,
          scheme: base.scheme,
          host,
          pathBase,
        },
        serializedDoc,
        { charThreshold: 120 },
      ]);
    } catch {
      return null;
    }
  }

  #extractSemanticBlocksText(doc) {
    const articleRoot = doc.querySelector("article, [role='article']");
    const root =
      articleRoot || doc.querySelector("main, [role='main']") || doc.body;
    if (!root) {
      return { text: "", fromArticle: false };
    }
    const fromArticle = Boolean(articleRoot);
    const blocks = [];
    const seen = new Set();
    const candidates = root.querySelectorAll(
      "h1, h2, h3, h4, p, li, blockquote, pre, td, th, dd, dt, figcaption"
    );
    for (const el of candidates) {
      if (el.closest(NOISE_CONTAINER_SELECTOR)) {
        continue;
      }
      const text = normalizeWhitespace(el.textContent);
      if (!text || text.length < 3 || seen.has(text)) {
        continue;
      }
      seen.add(text);
      blocks.push(text);
    }
    if (!blocks.length) {
      return {
        text: normalizeWhitespace(root.innerText || root.textContent || ""),
        fromArticle,
      };
    }
    return { text: blocks.join("\n"), fromArticle };
  }

  #extractContentLinks(doc, { host, maxLinks }) {
    const root = doc.querySelector("article, main, [role='main']") || doc.body;
    if (!root) {
      return [];
    }
    const links = [];
    const seen = new Set();
    for (const anchor of root.querySelectorAll("a[href]")) {
      if (links.length >= maxLinks) {
        break;
      }
      if (anchor.closest(NOISE_CONTAINER_SELECTOR)) {
        continue;
      }
      const href = unwrapGoogleHref(
        anchor.getAttribute("href") || anchor.href,
        doc.baseURI
      );
      if (!href || seen.has(href) || isInternalSearchHref(href, host)) {
        continue;
      }
      const linkTitle = normalizeWhitespace(
        anchor.textContent || anchor.getAttribute("aria-label")
      );
      if (!linkTitle) {
        continue;
      }
      seen.add(href);
      links.push({
        title: linkTitle,
        url: href,
        context: "",
      });
    }
    return links;
  }

  capture({ id, options }) {
    this.clear();
    const { snapshot, targets } = collectDOMObservation(
      this.contentWindow,
      options
    );
    this.id = id;
    this.targets = targets;
    if (options.watch === false) {
      return { ...snapshot, documentId: this.manager.innerWindowId };
    }
    this.capturedWidth = this.contentWindow.innerWidth;
    this.capturedHeight = this.contentWindow.innerHeight;
    this.overlay = new ObservationOverlay(this.document);
    this.mutationObserver = new this.contentWindow.MutationObserver(() =>
      this.invalidate("mutation")
    );
    const roots = [this.document];
    for (let i = 0; i < roots.length; i++) {
      this.mutationObserver.observe(roots[i], {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      for (const element of roots[i].querySelectorAll("*")) {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
        }
      }
    }
    for (const type of OBSERVED_EVENTS) {
      this.contentWindow.addEventListener(type, this, true);
    }
    return { ...snapshot, documentId: this.manager.innerWindowId };
  }

  show({ id, documentId, items, selected = null }) {
    if (
      id !== this.id ||
      documentId !== this.manager.innerWindowId ||
      this.mutationObserver?.takeRecords().length
    ) {
      this.invalidate("stale");
      return false;
    }
    const boxes = [];
    for (const item of items) {
      const reference = this.targets.get(item.nodeId);
      if (!reference?.element.isConnected || !reference.target.isConnected) {
        this.invalidate("detached");
        return false;
      }
      const rect = reference.target.getBoundingClientRect();
      if (
        ["x", "y", "width", "height"].some(
          key => Math.abs(rect[key] - item.rect[key]) > 2
        )
      ) {
        this.invalidate("geometry");
        return false;
      }
      boxes.push(item);
    }
    this.overlay.show(boxes, selected);
    return true;
  }

  handleEvent(event) {
    if (
      event.type === "resize" &&
      this.contentWindow.innerWidth === this.capturedWidth &&
      this.contentWindow.innerHeight === this.capturedHeight
    ) {
      return;
    }
    this.invalidate(event.type);
  }

  invalidate(reason) {
    if (!this.id) {
      return;
    }
    const id = this.id;
    this.clear();
    this.sendAsyncMessage("AgentObservation:Invalidated", { id, reason });
  }

  clear() {
    this.id = null;
    this.targets = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.overlay?.clear();
    this.overlay = null;
    for (const type of OBSERVED_EVENTS) {
      this.contentWindow?.removeEventListener(type, this, true);
    }
  }

  didDestroy() {
    this.mutationObserver?.disconnect();
    this.overlay?.clear();
    this.targets = null;
  }
}
