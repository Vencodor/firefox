/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemradio",
  "option",
  "gridcell",
  "combobox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "menuitemcheckbox",
]);

export const SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  "[onclick]",
  ...[...ROLES].map(role => `[role="${role}"]`),
].join(",");

export const GROUP_SELECTOR =
  'tr,[role="row"],li,[role="listitem"],article,[role="article"],fieldset,section,dialog,nav,aside,form,[role="search"],[role="group"],[role="dialog"],[role="complementary"],[role="region"],[role="banner"],[role="navigation"],ytd-video-renderer,ytm-shorts-lockup-view-model,shreddit-post,shreddit-ad-post,shreddit-comment,.fds-web-doc-root,.fds-aib-expandable-container';

const SEMANTIC_CARD_SELECTOR =
  'li,tr,article,[role="article"],[role="listitem"],[role="row"],ytd-video-renderer,ytd-rich-item-renderer,ytd-grid-video-renderer,shreddit-post,shreddit-ad-post,shreddit-comment';

const CUSTOM_CARD_TAG_RE = /-(?:post|card|item|article|comment|renderer|lockup)(?:$|-)/i;

const TITLE_MARKER_SELECTOR =
  'h1,h2,h3,h4,h5,h6,[role="heading"],[slot*="title"],[slot="full-post-link"],[id^="post-title-"]';

const META_MARKER_SELECTOR =
  'time,[datetime],[rel="author"],[rel="tag"],[slot*="author"],[slot*="credit"],[slot*="flair"],[slot*="subreddit"],[slot*="meta"],[slot*="timestamp"],[data-ad-click-location="username"],[data-ad-click-location="promoted_label"],[data-testid*="author"],[data-testid*="timestamp"]';

const ACTION_MARKER_SELECTOR =
  '[slot*="comment"],[slot*="share"],[slot*="action"],[slot*="overflow"],[slot*="vote"],shreddit-post-overflow-menu';

const BODY_MARKER_SELECTOR =
  '[slot="text-body"],[slot*="post-media-container"],[slot*="content"],[slot*="body"],[slot*="description"]';

const BLOCK_CONTAINER_SELECTOR =
  'p,li,h1,h2,h3,h4,h5,h6,[role="heading"],blockquote,dd,dt,td,th,figcaption,pre,[role="alert"],[role="status"],[slot="text-body"],[slot="title"],article,[role="article"],section,main,[role="main"],div';

const TRANSLATION_EXCLUDED_TAGS = new Set([
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "VAR",
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "MATH",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "SUMMARY",
  "TIME",
]);

const TRANSLATION_EXCLUDED_ROLES = new Set([
  "button",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "switch",
  "checkbox",
  "radio",
  "combobox",
  "searchbox",
  "textbox",
  "spinbutton",
  "slider",
  "navigation",
  "menubar",
  "menu",
  "listbox",
  "tablist",
  "search",
  "contentinfo",
]);

const NO_SPACE_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;

const ABBREV_DOT_RE = /\b(?:hr|hrs|min|mins|sec|secs|mr|mrs|ms|dr|prof|vs|etc|inc|ltd|jr|sr)\./gi;
const DECIMAL_DOT_RE = /\d+\.\d+/g;
const TERMINAL_PUNCT_RE = /[.?!。？！](?=\s|$)/;

const SHORT_META_PATTERNS = [
  /^(?:Author:\s*)?[ur]\/[^\s/]+$/i,
  /^(?:Flair:\s*.+|Ad|Promoted|Sponsored)$/i,
  /^(?:\d+\s*(?:sec|min|hr|h|d|mo|yr)s?\s*ago|\d+\s*(?:초|분|시간|일|주|개월|년)\s*전)$/i,
];

const SHORT_ACTION_RE =
  /^(?:\d+[\d,.kKmM]*\s+)?(?:go\s+to\s+)?(?:comments?|share|save|report|award|hide|reply|upvote|downvote|공유|저장|신고|댓글|답글)$/i;

const META_HREF_RE = /(?:\/user\/|\/u\/|\?f=flair_name)/i;

export function normalize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function roleOf(row) {
  if (ROLES.has(row.declared_role)) {
    return row.declared_role;
  }
  if (["button", "summary"].includes(row.tag)) {
    return "button";
  }
  if (row.tag === "a") {
    return "link";
  }
  if (row.tag === "select") {
    return "combobox";
  }
  if (row.tag === "textarea" || row.contenteditable) {
    return "textbox";
  }
  if (row.tag === "input") {
    if (["checkbox", "radio"].includes(row.type)) {
      return row.type;
    }
    if (["button", "submit", "reset", "image"].includes(row.type)) {
      return "button";
    }
    if (row.type === "search") {
      return "searchbox";
    }
    if (row.type === "number") {
      return "spinbutton";
    }
    if (
      [
        "text",
        "email",
        "url",
        "tel",
        "date",
        "time",
        "datetime-local",
        "month",
        "week",
      ].includes(row.type)
    ) {
      return "textbox";
    }
    if (row.type === "range") {
      return "slider";
    }
    if (row.type === "color") {
      return "button";
    }
  }
  return row.generic_click ? "button" : null;
}

export function analyzeTextMetrics(rawText) {
  const text = normalize(rawText);
  if (!text) {
    return {
      text: "",
      charCount: 0,
      wordCount: 0,
      noSpaceScriptCount: 0,
      hasTerminalPunct: false,
      isSentenceLike: false,
      isShortLabel: true,
    };
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const noSpaceMatches = text.match(NO_SPACE_SCRIPT_RE);
  const noSpaceScriptCount = noSpaceMatches ? noSpaceMatches.length : 0;
  const cleanedForPunct = text
    .replace(DECIMAL_DOT_RE, "0")
    .replace(ABBREV_DOT_RE, "abbr");
  const hasTerminalPunct = TERMINAL_PUNCT_RE.test(cleanedForPunct);
  const isSentenceLike =
    wordCount >= 4 ||
    noSpaceScriptCount >= 10 ||
    (hasTerminalPunct && (wordCount >= 2 || noSpaceScriptCount >= 4));
  const isShortLabel =
    !hasTerminalPunct &&
    wordCount <= 2 &&
    text.length < 10 &&
    noSpaceScriptCount < 4;

  return {
    text,
    charCount: text.length,
    wordCount,
    noSpaceScriptCount,
    hasTerminalPunct,
    isSentenceLike,
    isShortLabel,
  };
}

/**
 * Shared DOM heuristic and caching helper for a single observation pass
 * or a single selective-translation subdivision pass.
 */
export class DOMHeuristics {
  constructor(window, { clip = null, legacyMode = false } = {}) {
    this.window = window;
    this.document = window.document;
    this.NodeConstructor = window.Node;
    this.getComputedStyle = window.getComputedStyle.bind(window);
    this.legacyMode = Boolean(legacyMode);
    this.clip = clip || {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };

    this.parentCache = new WeakMap();
    this.closestCache = new WeakMap();
    this.visibilityCache = new WeakMap();
    this.prunableCache = new WeakMap();
    this.rectCache = new WeakMap();
    this.repetitionSiblings = new Map();
    this.repetitionItemIds = new WeakMap();
    this.repetitionGroupIds = new WeakMap();
    this.repetitionSignatures = new WeakMap();
    this.repetitionCardCache = new WeakMap();
    this.compactCache = new WeakMap();
    this.subroleCache = new WeakMap();
    this.excludedNodeCache = new WeakMap();
    this.excludedDescendantCache = new WeakMap();
    this.controlDensityCache = new WeakMap();
    this.nextRepetitionItemId = 1;
    this.nextRepetitionGroupId = 1;
  }

  parentOf(element) {
    if (!element) {
      return null;
    }
    if (!this.parentCache.has(element)) {
      this.parentCache.set(
        element,
        element.assignedSlot ||
          element.parentElement ||
          element.getRootNode().host ||
          null
      );
    }
    return this.parentCache.get(element);
  }

  closest(element, selector) {
    if (!element) {
      return null;
    }
    if (!this.closestCache.has(element)) {
      this.closestCache.set(element, new Map());
    }
    const cache = this.closestCache.get(element);
    if (!cache.has(selector)) {
      cache.set(
        selector,
        element.matches?.(selector)
          ? element
          : this.closest(this.parentOf(element), selector)
      );
    }
    return cache.get(selector);
  }

  cssVisible(element) {
    if (!this.visibilityCache.has(element)) {
      let visible = element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
      if (!visible && this.getComputedStyle(element).display === "contents") {
        const style = this.getComputedStyle(element);
        visible =
          style.visibility === "visible" &&
          style.opacity !== "0" &&
          (!this.parentOf(element) || this.cssVisible(this.parentOf(element)));
      }
      this.visibilityCache.set(element, visible);
    }
    return this.visibilityCache.get(element);
  }

  /**
   * Prunes subtrees that are guaranteed not to render any visible descendants
   * (`display: none`, `content-visibility: hidden`, or `opacity: 0`), while
   * preserving `visibility: hidden` ancestors that may contain `visibility: visible`
   * children and `display: contents` elements (such as `<slot>` or `.contents`).
   */
  prunable(element) {
    if (this.legacyMode) {
      return false;
    }
    if (!this.prunableCache.has(element)) {
      let canPrune = false;
      if (!element.checkVisibility({ checkOpacity: true })) {
        const style = this.getComputedStyle(element);
        if (style.display !== "contents") {
          canPrune = true;
        } else {
          canPrune =
            style.opacity === "0" ||
            Boolean(this.parentOf(element) && this.prunable(this.parentOf(element)));
        }
      }
      this.prunableCache.set(element, canPrune);
    }
    return this.prunableCache.get(element);
  }

  composedChildren(node) {
    if (
      node.nodeType === this.NodeConstructor.ELEMENT_NODE &&
      node.tagName === "SLOT"
    ) {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) {
        return assigned;
      }
    }
    return node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
  }

  rectOf(element) {
    if (!this.rectCache.has(element)) {
      const rect = element.getBoundingClientRect();
      this.rectCache.set(element, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    }
    return this.rectCache.get(element);
  }

  visibleRect(rect) {
    const left = Math.max(rect.x, this.clip.left);
    const top = Math.max(rect.y, this.clip.top);
    const right = Math.min(rect.x + rect.width, this.clip.right);
    const bottom = Math.min(rect.y + rect.height, this.clip.bottom);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  landmark(element, selector, requireVisible = false) {
    let node = this.closest(element, selector);
    while (node && requireVisible && !this.cssVisible(node)) {
      node = this.closest(this.parentOf(node), selector);
    }
    return node;
  }

  isSemanticOrCustomCard(node) {
    if (this.legacyMode) {
      return node.matches(
        'li,tr,article,[role="article"],[role="listitem"],[role="row"],ytd-video-renderer,ytd-rich-item-renderer,ytd-grid-video-renderer'
      );
    }
    if (node.matches(SEMANTIC_CARD_SELECTOR)) {
      return true;
    }
    const tag = node.tagName.toLowerCase();
    return tag.includes("-") && CUSTOM_CARD_TAG_RE.test(tag);
  }

  repetitionSignature(node, isSemantic = false) {
    if (this.repetitionSignatures.has(node)) {
      return this.repetitionSignatures.get(node);
    }
    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute("role") || "";
    let signature;
    if (!this.legacyMode && tag.includes("-") && isSemantic) {
      const slot = node.getAttribute("slot") || "";
      signature = `${tag}|${role}|${slot}`;
    } else if (!this.legacyMode && isSemantic) {
      const classes = Array.from(node.classList || []).sort().join(".");
      signature = `${tag}|${role}|${classes}`;
    } else {
      const classes = Array.from(node.classList || []).sort().join(".");
      const children = Array.from(node.children || [], child =>
        child.tagName.toLowerCase()
      ).join(",");
      signature = `${tag}|${role}|${classes}|${children}`;
    }
    this.repetitionSignatures.set(node, signature);
    return signature;
  }

  repeatedSiblingGroups(parent) {
    if (!this.repetitionSiblings.has(parent)) {
      const groups = new Map();
      for (const child of parent.children || []) {
        const isSemantic = this.isSemanticOrCustomCard(child);
        const signature = this.repetitionSignature(child, isSemantic);
        if (!groups.has(signature)) {
          groups.set(signature, []);
        }
        groups.get(signature).push(child);
      }
      this.repetitionSiblings.set(parent, groups);
    }
    return this.repetitionSiblings.get(parent);
  }

  repetitionCard(element) {
    if (this.repetitionCardCache.has(element)) {
      return this.repetitionCardCache.get(element);
    }
    let result = null;
    for (
      let node = element, depth = 0;
      node && depth <= 8;
      node = this.parentOf(node), depth++
    ) {
      if (this.repetitionCardCache.has(node)) {
        result = this.repetitionCardCache.get(node);
        break;
      }
      if (node.matches('body,html,main,[role="main"]')) {
        break;
      }
      const boundary = this.closest(
        node,
        'nav,[role="navigation"],dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],search,[role="search"]'
      );
      if (boundary) {
        break;
      }
      const parent = this.parentOf(node);
      if (!parent || !parent.children || parent.children.length < 2) {
        continue;
      }
      const semanticCard = this.isSemanticOrCustomCard(node);
      const classCard = node.classList?.length > 0;
      if (!semanticCard && !classCard) {
        continue;
      }
      const signature = this.repetitionSignature(node, semanticCard);
      const siblings = this.repeatedSiblingGroups(parent).get(signature);
      if (!siblings || siblings.length < 2) {
        continue;
      }
      if (
        !semanticCard &&
        (node.children.length < 2 ||
          !node.querySelector("h1,h2,h3,h4,[role='heading'],img[alt]") ||
          !node.querySelector(SELECTOR))
      ) {
        continue;
      }
      if (!this.repetitionItemIds.has(node)) {
        this.repetitionItemIds.set(node, `i${this.nextRepetitionItemId++}`);
      }
      if (!this.repetitionGroupIds.has(parent)) {
        this.repetitionGroupIds.set(parent, new Map());
      }
      const groupIds = this.repetitionGroupIds.get(parent);
      if (!groupIds.has(signature)) {
        groupIds.set(signature, `g${this.nextRepetitionGroupId++}`);
      }
      result = {
        group: groupIds.get(signature),
        item: this.repetitionItemIds.get(node),
        cardNode: node,
      };
      this.repetitionCardCache.set(node, result);
      break;
    }
    this.repetitionCardCache.set(element, result);
    return result;
  }

  withinBoundary(node, boundarySelector, stopNode = null) {
    for (
      let cur = node;
      cur && cur !== stopNode && !cur.matches?.("body,html");
      cur = this.parentOf(cur)
    ) {
      if (cur.matches?.(boundarySelector)) {
        return cur;
      }
    }
    return null;
  }

  postTitleOf(stopNode) {
    if (!stopNode || stopNode.matches?.("main,[role='main']")) {
      return "";
    }
    if (!this.subroleCache.has(stopNode)) {
      const val =
        stopNode.getAttribute?.("post-title") ||
        stopNode.querySelector?.("[post-title]")?.getAttribute?.("post-title") ||
        "";
      this.subroleCache.set(stopNode, normalize(val));
    }
    return this.subroleCache.get(stopNode);
  }

  /**
   * 2-stage subrole classification:
   * Stage 1: Explicit structure/slot/attribute markers (works even on standalone cards).
   * Stage 2: Short-text patterns (<= 3~4 words) and card-relative position fallback.
   */
  classifySubrole(element, { role = null, label = "", href = "", cardNode = null } = {}) {
    if (!element) {
      return null;
    }
    const stopNode =
      cardNode ||
      this.closest(element, SEMANTIC_CARD_SELECTOR) ||
      this.closest(element, "main,[role='main']");

    // Stage 1: Structural & explicit markers (title -> meta -> action -> body)
    if (this.withinBoundary(element, TITLE_MARKER_SELECTOR, stopNode)) {
      return "title";
    }
    if (this.withinBoundary(element, META_MARKER_SELECTOR, stopNode)) {
      return "meta";
    }
    const normLabel = normalize(label || element.textContent);
    if (
      role === "link" &&
      href &&
      META_HREF_RE.test(href) &&
      normLabel !== this.postTitleOf(stopNode)
    ) {
      return "meta";
    }
    if (
      (role !== null && role !== "link") ||
      this.withinBoundary(element, ACTION_MARKER_SELECTOR, stopNode)
    ) {
      return "action";
    }
    if (this.withinBoundary(element, BODY_MARKER_SELECTOR, stopNode)) {
      return "body";
    }

    // Stage 2: Short-text pattern & card fallback
    const wordCount = normLabel ? normLabel.split(/\s+/).filter(Boolean).length : 0;
    if (wordCount > 0 && wordCount <= 3) {
      if (SHORT_META_PATTERNS.some(re => re.test(normLabel))) {
        return "meta";
      }
    }
    if (wordCount > 0 && wordCount <= 4) {
      if (SHORT_ACTION_RE.test(normLabel)) {
        return "action";
      }
    }

    if (cardNode) {
      if (role === "link") {
        const postTitle = this.postTitleOf(stopNode);
        if (postTitle && normLabel === postTitle) {
          return "title";
        }
        const headingNode = cardNode.querySelector(
          'h1,h2,h3,h4,[role="heading"],[slot*="title"]'
        );
        if (headingNode && normLabel && normLabel === normalize(headingNode.textContent)) {
          return "title";
        }
        if (normLabel.length >= 16 && wordCount >= 3) {
          return "title";
        }
      }
      if (
        role === null &&
        element.matches?.("p,blockquote,div,span") &&
        analyzeTextMetrics(normLabel).isSentenceLike
      ) {
        return "body";
      }
    }

    return null;
  }

  headingLevelOf(element) {
    const heading = this.closest(
      element,
      'h1,h2,h3,h4,h5,h6,[role="heading"]'
    );
    if (!heading) {
      return 0;
    }
    if (/^H[1-6]$/.test(heading.tagName)) {
      return Number(heading.tagName[1]);
    }
    const ariaLevel = Number(heading.getAttribute("aria-level"));
    return Number.isFinite(ariaLevel) && ariaLevel >= 1 && ariaLevel <= 6
      ? ariaLevel
      : 2;
  }

  isBlockingDialog(element, viewportArea) {
    const dialogNode = this.landmark(
      element,
      'dialog[open],[role="dialog"],[role="alertdialog"]',
      true
    );
    if (!dialogNode) {
      return false;
    }
    try {
      if (dialogNode.matches(":modal")) {
        return true;
      }
    } catch {}
    if (dialogNode.getAttribute("aria-modal") === "true") {
      return true;
    }
    const rect = this.rectOf(dialogNode);
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    return viewportArea > 0 && area / viewportArea >= 0.25;
  }

  isGlobalHeaderBanner(element) {
    const header = this.landmark(element, 'header,[role="banner"]');
    if (!header) {
      return false;
    }
    if (header.getAttribute("role") === "banner") {
      return true;
    }
    if (
      this.landmark(
        this.parentOf(header),
        'article,section,main,aside,nav,[role="article"],[role="main"]'
      )
    ) {
      return false;
    }
    if (this.closest(element, "h1")) {
      return false;
    }
    return true;
  }

  isExternalComplementary(element) {
    const aside = this.landmark(element, 'aside,[role="complementary"]');
    if (!aside) {
      return false;
    }
    return !this.landmark(
      this.parentOf(aside),
      'main,article,[role="main"],[role="article"]'
    );
  }

  inCentralBand(element) {
    const rect = this.rectOf(element);
    const vw = this.window.innerWidth || 1280;
    if (rect.width <= 0 || rect.height <= 0 || vw <= 0) {
      return false;
    }
    const centerX = rect.x + rect.width / 2;
    return centerX >= vw * 0.15 && centerX <= vw * 0.85 && rect.width >= vw * 0.2;
  }

  controlDensityOf(block) {
    if (!block) {
      return 0;
    }
    if (this.controlDensityCache.has(block)) {
      return this.controlDensityCache.get(block);
    }
    const totalText = normalize(block.textContent);
    if (!totalText) {
      this.controlDensityCache.set(block, 0);
      return 0;
    }
    const controls = block.querySelectorAll?.(
      'button,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"]'
    );
    let controlChars = 0;
    for (const ctrl of controls || []) {
      controlChars += normalize(ctrl.textContent || ctrl.value || "").length;
    }
    const density = Math.min(1, controlChars / totalText.length);
    this.controlDensityCache.set(block, density);
    return density;
  }

  closestBlockContainer(node) {
    const start =
      node?.nodeType === this.NodeConstructor.TEXT_NODE
        ? this.parentOf(node)
        : node;
    if (!start) {
      return null;
    }
    return (
      this.closest(start, BLOCK_CONTAINER_SELECTOR) ||
      this.document.body ||
      this.document.documentElement
    );
  }

  /**
   * 3-Step Deterministic Boolean Filter for Selective Translation:
   * Step 1: Hard Reject (controls, nav/footer/global-header/external-aside, meta/action subroles).
   * Step 2: Explicit Content Include (card title/body, main/article headings & prose blocks).
   * Step 3: General Container Fallback (sentence-like block text with low control density).
   */
  isExcludedFromTranslation(node) {
    if (!node) {
      return true;
    }
    if (node.nodeType === this.NodeConstructor.TEXT_NODE) {
      return false;
    }
    if (node.nodeType !== this.NodeConstructor.ELEMENT_NODE) {
      return true;
    }
    if (this.excludedNodeCache.has(node)) {
      return this.excludedNodeCache.get(node);
    }

    const tag = node.tagName.toUpperCase();
    const role = (node.getAttribute("role") || "").toLowerCase();
    const parent = this.parentOf(node);
    let excluded = false;

    if (
      parent &&
      parent.nodeType === this.NodeConstructor.ELEMENT_NODE &&
      this.isExcludedFromTranslation(parent)
    ) {
      excluded = true;
    } else if (
      TRANSLATION_EXCLUDED_TAGS.has(tag) ||
      TRANSLATION_EXCLUDED_ROLES.has(role) ||
      node.getAttribute("translate") === "no" ||
      node.classList?.contains("notranslate") ||
      node.isContentEditable ||
      node.getAttribute("slot") === "full-post-link"
    ) {
      excluded = true;
    } else if (
      node.matches?.(
        'nav,footer,search,header,aside,[role="navigation"],[role="contentinfo"],[role="search"],[role="banner"],[role="complementary"],[role="menu"],[role="menubar"],[role="listbox"],[role="tablist"]'
      ) ||
      parent?.matches?.('header,[role="banner"]')
    ) {
      if (
        node.matches?.(
          'nav,footer,search,[role="navigation"],[role="contentinfo"],[role="search"],[role="menu"],[role="menubar"],[role="listbox"],[role="tablist"]'
        )
      ) {
        excluded = true;
      } else if (
        this.isGlobalHeaderBanner(node) &&
        !node.querySelector?.('h1,search,[role="search"]')
      ) {
        excluded = true;
      } else if (this.isExternalComplementary(node)) {
        excluded = true;
      }
    }

    if (!excluded) {
      if (
        node.matches?.(TITLE_MARKER_SELECTOR) ||
        node.matches?.(BODY_MARKER_SELECTOR)
      ) {
        excluded = false;
      } else if (
        node.matches?.(META_MARKER_SELECTOR) ||
        node.matches?.(ACTION_MARKER_SELECTOR)
      ) {
        excluded = true;
      } else {
        const effectiveRole = roleOf({
          tag: tag.toLowerCase(),
          type: node.type || "",
          declared_role: role,
          contenteditable: node.isContentEditable,
          generic_click: node.hasAttribute("onclick"),
        });
        if (effectiveRole !== null && effectiveRole !== "link") {
          excluded = true;
        } else if (effectiveRole === "link" || node.childElementCount === 0) {
          const subrole = this.classifySubrole(node, {
            role: effectiveRole,
            label: node.getAttribute("aria-label") || node.textContent || "",
            href: node.href || "",
          });
          if (subrole === "meta" || subrole === "action") {
            excluded = true;
          }
        }
      }
    }

    this.excludedNodeCache.set(node, excluded);
    return excluded;
  }

  /**
   * O(N) memoized check for whether `node` contains any descendant that should be
   * excluded from selective translation (used to trigger SUBDIVIDE_FURTHER).
   */
  containsSelectiveExcludedChild(node) {
    if (!node || node.nodeType !== this.NodeConstructor.ELEMENT_NODE) {
      return false;
    }
    if (this.excludedDescendantCache.has(node)) {
      return this.excludedDescendantCache.get(node);
    }
    let found = false;
    for (const child of node.children || []) {
      if (
        this.isExcludedFromTranslation(child) ||
        this.containsSelectiveExcludedChild(child)
      ) {
        found = true;
        break;
      }
    }
    this.excludedDescendantCache.set(node, found);
    return found;
  }

  /**
   * Evaluates whether a leaf block or text node should be translated in selective mode,
   * returning both the boolean `included` decision and a diagnostic `reason` code.
   */
  explainTranslationDecision(node) {
    if (!node) {
      return { included: false, reason: "excluded_node", subrole: null };
    }
    const element =
      node.nodeType === this.NodeConstructor.TEXT_NODE
        ? this.parentOf(node)
        : node;
    if (!element || this.isExcludedFromTranslation(element)) {
      return { included: false, reason: "excluded_node", subrole: null };
    }

    const block = this.closestBlockContainer(element) || element;
    const blockText = normalize(block.textContent);
    if (!blockText) {
      return { included: false, reason: "empty_text", subrole: null };
    }

    const effectiveRole = roleOf({
      tag: element.tagName.toLowerCase(),
      type: element.type || "",
      declared_role: (element.getAttribute("role") || "").toLowerCase(),
      contenteditable: element.isContentEditable,
      generic_click: element.hasAttribute("onclick"),
    });
    let subrole =
      this.classifySubrole(element, {
        role: effectiveRole,
        label: blockText,
        href: element.href || "",
      }) ||
      this.classifySubrole(block, {
        role: null,
        label: blockText,
      });
    if (!subrole) {
      const rep = this.repetitionCard(block);
      if (rep?.cardNode) {
        subrole =
          this.classifySubrole(element, {
            role: effectiveRole,
            label: blockText,
            href: element.href || "",
            cardNode: rep.cardNode,
          }) ||
          this.classifySubrole(block, {
            role: null,
            label: blockText,
            cardNode: rep.cardNode,
          });
      }
    }

    if (subrole === "meta") {
      return { included: false, reason: "card_meta", subrole };
    }
    if (subrole === "action") {
      return { included: false, reason: "card_action", subrole };
    }
    if (subrole === "title") {
      return { included: true, reason: "card_title", subrole };
    }
    if (subrole === "body") {
      return { included: true, reason: "card_body", subrole };
    }

    const metrics = analyzeTextMetrics(blockText);
    const density = this.controlDensityOf(block);
    if (density > 0.7) {
      return { included: false, reason: "high_control_density", subrole };
    }

    if (this.headingLevelOf(block) > 0) {
      const included = !metrics.isShortLabel || blockText.length >= 4;
      return {
        included,
        reason: included ? "heading" : "short_label",
        subrole,
      };
    }

    const inMainOrArticle = Boolean(
      this.landmark(block, 'main,article,[role="main"],[role="article"]')
    );
    const hasMainOnPage = Boolean(
      this.document.querySelector('main,article,[role="main"],[role="article"]')
    );
    const inContentRegion =
      inMainOrArticle || (!hasMainOnPage && this.inCentralBand(block));

    if (
      inContentRegion &&
      block.matches?.("p,blockquote,dd,figcaption") &&
      !metrics.isShortLabel
    ) {
      return { included: true, reason: "main_prose", subrole };
    }

    if (metrics.isSentenceLike && density <= 0.6) {
      return { included: true, reason: "sentence_like", subrole };
    }

    return {
      included: false,
      reason: metrics.isShortLabel ? "short_label" : "non_sentence",
      subrole,
    };
  }

  /**
   * Evaluates whether a leaf block or text node should be translated in selective mode.
   * Always evaluates sentence metrics on the closest block container so inline `<a>`/`<span>`
   * words inside a sentence are never dropped mid-sentence.
   */
  shouldTranslateNode(node) {
    return this.explainTranslationDecision(node).included;
  }

  /**
   * Selective gate for attribute translations (`alt`, `title`, `aria-label`, `placeholder`).
   * Blocks attribute translation on interactive controls/links (`button`, `a`, `input`, etc.)
   * and excluded nodes, while allowing `alt`/`title` on content images/abbreviations.
   */
  shouldTranslateAttribute(element, attrName = "") {
    if (!element || this.isExcludedFromTranslation(element)) {
      return false;
    }
    if (
      element.matches?.(
        'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[slot="full-post-link"]'
      )
    ) {
      return false;
    }
    if (attrName && !["alt", "title"].includes(attrName.toLowerCase())) {
      return false;
    }
    for (let anc = this.parentOf(element); anc; anc = this.parentOf(anc)) {
      if (
        anc.nodeType === this.NodeConstructor.ELEMENT_NODE &&
        this.isExcludedFromTranslation(anc)
      ) {
        return false;
      }
    }
    const attrText = normalize(
      attrName
        ? element.getAttribute(attrName)
        : element.getAttribute("alt") || element.getAttribute("title") || ""
    );
    if (attrText) {
      return !analyzeTextMetrics(attrText).isShortLabel;
    }
    return this.shouldTranslateNode(element);
  }
}
