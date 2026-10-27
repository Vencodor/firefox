/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const TOOL_TITLES = {
  web_search: "웹 검색",
  read_web_page: "웹 페이지 읽기",
};

const TOOL_ACTIVITIES = {
  web_search: "웹 검색 중",
  read_web_page: "페이지 읽는 중",
};

/**
 * Returns the search words of a tool call. Pages a tool opens are listed
 * under the step instead.
 *
 * @param {object} args
 * @returns {string[]}
 */
function formatToolQueries(args) {
  if (!args || typeof args !== "object") {
    return [];
  }
  if (Array.isArray(args.queries) && args.queries.length) {
    return args.queries
      .map(item => (item && typeof item === "object" ? item.query : item))
      .filter(query => typeof query === "string" && query);
  }
  return typeof args.query === "string" && args.query ? [args.query] : [];
}

function formatHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function formatShortUrl(url) {
  try {
    let parsed = new URL(url);
    let path = parsed.pathname === "/" ? "" : parsed.pathname;
    return parsed.hostname.replace(/^www\./, "") + path;
  } catch {
    return String(url || "");
  }
}

function formatDurationMs(ms) {
  const num = Number(ms) || 0;
  if (num >= 1000) {
    return `${(num / 1000).toFixed(2)}s (${Math.round(num).toLocaleString()}ms)`;
  }
  return `${Math.round(num).toLocaleString()}ms`;
}

function formatTokenCount(count, estimated = false) {
  if (count === null || count === undefined) {
    return "-";
  }
  const num = Number(count) || 0;
  return `${estimated ? "~" : ""}${num.toLocaleString()}`;
}

const INLINE_MD_RE =
  /(`[^`\n]+`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+)\*\*)|(__([^_\n]+)__)|(\*([^*\n]+)\*)|(\[(\d{1,3})\])/g;

// Sources of the answer being rendered, by number; see renderMarkdown.
let citationSources = null;

function appendCitation(parent, number, raw) {
  const source = citationSources?.get(number);
  if (!source) {
    parent.append(document.createTextNode(raw));
    return;
  }
  const a = document.createElement("a");
  a.className = "chat-cite";
  a.href = source.url;
  a.title = source.title ? `${source.title}\n${source.url}` : source.url;
  a.textContent = String(number);
  parent.append(a);
}

function appendInlineMarkdown(parent, text) {
  const str = String(text ?? "");
  let lastIndex = 0;
  INLINE_MD_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_MD_RE.exec(str)) !== null) {
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(str.slice(lastIndex, match.index)));
    }
    if (match[1]) {
      let code = document.createElement("code");
      code.textContent = match[1].slice(1, -1);
      parent.append(code);
    } else if (match[2]) {
      let a = document.createElement("a");
      a.href = match[4];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[3];
      parent.append(a);
    } else if (match[5] || match[7]) {
      let strong = document.createElement("strong");
      strong.textContent = match[6] || match[8];
      parent.append(strong);
    } else if (match[9]) {
      let em = document.createElement("em");
      em.textContent = match[10];
      parent.append(em);
    } else if (match[11]) {
      appendCitation(parent, Number(match[12]), match[11]);
    }
    lastIndex = INLINE_MD_RE.lastIndex;
  }
  if (lastIndex < str.length) {
    parent.append(document.createTextNode(str.slice(lastIndex)));
  }
}

function parseTableCells(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split("|").map(cell => cell.trim());
}

function isTableSeparatorLine(line) {
  if (!line || !line.includes("|")) {
    return false;
  }
  const cells = parseTableCells(line);
  return !!cells.length && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function isFenceLine(line) {
  return /^\s*```/.test(line);
}

function matchHeadingLine(line) {
  return line.match(/^\s*(#{1,6})(?:\s+(.*)|\s*)$/);
}

function isHrLine(line) {
  return /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line);
}

function isBlockquoteLine(line) {
  return /^\s*>\s?/.test(line);
}

function isUlLine(line) {
  return /^\s*[-*+]\s+/.test(line);
}

function isOlLine(line) {
  return /^\s*\d+\.\s+/.test(line);
}

function isTableStartAt(lines, idx) {
  return (
    idx + 1 < lines.length &&
    lines[idx].includes("|") &&
    isTableSeparatorLine(lines[idx + 1])
  );
}

function isBlockStartAt(lines, idx) {
  const line = lines[idx];
  return (
    !line.trim() ||
    isFenceLine(line) ||
    Boolean(matchHeadingLine(line)) ||
    isHrLine(line) ||
    isBlockquoteLine(line) ||
    isUlLine(line) ||
    isOlLine(line) ||
    isTableStartAt(lines, idx)
  );
}

const FADE_MS = 260;
const REVEAL_MIN_CHARS_PER_SEC = 1200;
const REVEAL_DRAIN_MS = 160;
const REVEAL_FINISH_TIMEOUT_MS = 600;

/**
 * Wraps the text that arrived within the last FADE_MS in spans whose fade-in
 * animation starts part-way through. The tree is rebuilt on every chunk, so
 * each span's negative delay makes the new element continue the fade where
 * the one it replaces stopped. Text that was already shown stays plain and
 * never fades again.
 *
 * @param {DocumentFragment} frag
 * @param {{ text: string, runs: object[] }} fade
 *   Text of the previous render and when each stretch of it arrived.
 */
function applyFade(frag, fade) {
  const now = performance.now();
  const text = frag.textContent;
  const limit = Math.min(text.length, fade.text.length);
  let prefix = 0;
  while (
    prefix < limit &&
    text.charCodeAt(prefix) === fade.text.charCodeAt(prefix)
  ) {
    prefix++;
  }
  if (fade.refine) {
    applyRefine(frag, fade, text, prefix, now);
    return;
  }
  fade.text = text;
  const runs = fade.runs;
  while (runs.length && runs.at(-1).start >= prefix) {
    runs.pop();
  }
  if (runs.length) {
    runs.at(-1).end = Math.min(runs.at(-1).end, prefix);
  }
  if (text.length > prefix) {
    runs.push({ start: prefix, end: text.length, time: now });
  }
  while (runs.length && now - runs[0].time > FADE_MS) {
    runs.shift();
  }
  if (!runs.length) {
    return;
  }
  wrapTextRuns(frag, runs, "chat-fade", now);
}

/**
 * Diffusion refinement: the whole answer is restated on every chunk, so only
 * the stretch between the unchanged start and the unchanged end is marked.
 * Text that stayed the same is left plain and does not flicker.
 *
 * @param {DocumentFragment} frag
 * @param {{ text: string, runs: object[] }} fade
 * @param {string} text The rendered text of `frag`.
 * @param {number} prefix Length of the start shared with the previous text.
 * @param {number} now
 */
function applyRefine(frag, fade, text, prefix, now) {
  const previous = fade.text;
  let suffix = 0;
  while (
    suffix < text.length - prefix &&
    suffix < previous.length - prefix &&
    text.charCodeAt(text.length - 1 - suffix) ===
      previous.charCodeAt(previous.length - 1 - suffix)
  ) {
    suffix++;
  }
  fade.text = text;
  fade.runs = [];
  const end = text.length - suffix;
  if (end > prefix) {
    wrapTextRuns(frag, [{ start: prefix, end, time: now }], "chat-refine", now);
  }
}

function wrapTextRuns(frag, runs, className, now) {
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  let offset = 0;
  for (const node of nodes) {
    const data = node.data;
    const start = offset;
    offset += data.length;
    if (offset <= runs[0].start) {
      continue;
    }
    const snap = index =>
      index > 0 &&
      index < data.length &&
      (data.charCodeAt(index - 1) & 0xfc00) === 0xd800 &&
      (data.charCodeAt(index) & 0xfc00) === 0xdc00
        ? index + 1
        : index;
    const pieces = [];
    let cursor = 0;
    for (const run of runs) {
      const to = snap(Math.min(run.end, offset) - start);
      const from = Math.max(snap(Math.max(run.start, start) - start), cursor);
      if (to <= from) {
        continue;
      }
      if (from > cursor) {
        pieces.push(data.slice(cursor, from));
      }
      const span = document.createElement("span");
      span.className = className;
      span.style.animationDelay = `${-(now - run.time) - 8}ms`;
      span.textContent = data.slice(from, to);
      pieces.push(span);
      cursor = to;
    }
    if (cursor) {
      if (cursor < data.length) {
        pieces.push(data.slice(cursor));
      }
      node.replaceWith(...pieces);
    }
  }
}

/**
 * Renders markdown into a container.
 *
 * @param {HTMLElement} container
 * @param {string} markdown
 * @param {object} [fade] Streaming fade state; see applyFade.
 * @param {Map<number, {url: string, title: string}>} [sources] Turns `[n]`
 *   citations into links to these sources.
 */
function renderMarkdown(container, markdown, fade = null, sources = null) {
  citationSources = sources;
  const raw = String(markdown ?? "").replace(/\r\n/g, "\n");
  container.dataset.markdown = "true";
  if (!raw) {
    container.replaceChildren();
    return;
  }

  const lines = raw.split("\n");
  const frag = document.createDocumentFragment();
  let i = 0;

  while (i < lines.length) {
    const startIdx = i;
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    if (isFenceLine(line)) {
      const lang = line.replace(/^\s*```/, "").trim();
      i++;
      const codeLines = [];
      while (i < lines.length && !isFenceLine(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        i++;
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (lang) {
        code.dataset.lang = lang;
      }
      code.textContent = codeLines.join("\n");
      pre.append(code);
      frag.append(pre);
      continue;
    }

    // Heading (handles streaming prefix like "### " as well as "### Title")
    const headingMatch = matchHeadingLine(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const h = document.createElement(`h${level}`);
      appendInlineMarkdown(h, (headingMatch[2] || "").trim());
      frag.append(h);
      i++;
      continue;
    }

    // Horizontal rule
    if (isHrLine(line)) {
      frag.append(document.createElement("hr"));
      i++;
      continue;
    }

    // Markdown table
    if (isTableStartAt(lines, i)) {
      const headers = parseTableCells(line);
      i += 2;
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const headerText of headers) {
        const th = document.createElement("th");
        appendInlineMarkdown(th, headerText);
        headRow.append(th);
      }
      thead.append(headRow);
      table.append(thead);

      const tbody = document.createElement("tbody");
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const cells = parseTableCells(lines[i]);
        const tr = document.createElement("tr");
        for (let c = 0; c < headers.length; c++) {
          const td = document.createElement("td");
          appendInlineMarkdown(td, cells[c] ?? "");
          tr.append(td);
        }
        tbody.append(tr);
        i++;
      }
      table.append(tbody);
      frag.append(table);
      continue;
    }

    // Blockquote
    if (isBlockquoteLine(line)) {
      const quoteLines = [];
      while (i < lines.length && isBlockquoteLine(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const blockquote = document.createElement("blockquote");
      appendInlineMarkdown(blockquote, quoteLines.join("\n"));
      frag.append(blockquote);
      continue;
    }

    // Unordered list
    if (isUlLine(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && isUlLine(lines[i])) {
        const li = document.createElement("li");
        appendInlineMarkdown(li, lines[i].replace(/^\s*[-*+]\s+/, ""));
        ul.append(li);
        i++;
      }
      frag.append(ul);
      continue;
    }

    // Ordered list
    if (isOlLine(line)) {
      const ol = document.createElement("ol");
      while (i < lines.length && isOlLine(lines[i])) {
        const li = document.createElement("li");
        appendInlineMarkdown(li, lines[i].replace(/^\s*\d+\.\s+/, ""));
        ol.append(li);
        i++;
      }
      frag.append(ol);
      continue;
    }

    // Paragraph: always consume at least lines[i] so `i` strictly increases
    const paraLines = [lines[i++]];
    while (i < lines.length && !isBlockStartAt(lines, i)) {
      paraLines.push(lines[i]);
      i++;
    }
    const p = document.createElement("p");
    for (let pIdx = 0; pIdx < paraLines.length; pIdx++) {
      if (pIdx > 0) {
        p.append(document.createElement("br"));
      }
      appendInlineMarkdown(p, paraLines[pIdx]);
    }
    frag.append(p);

    if (i <= startIdx) {
      i = startIdx + 1;
    }
  }

  if (fade) {
    applyFade(frag, fade);
  }
  container.replaceChildren(frag);
}

var AgentChatPage = {
  messages: [],
  request: null,
  retry: null,
  statusId: "agent-chat-disconnected",

  themePref: "browser.customUI.theme",

  applyTheme() {
    document.documentElement.setAttribute(
      "custom-theme",
      Services.prefs.getStringPref(this.themePref, "mono")
    );
  },

  get browserWindow() {
    return window.browsingContext.topChromeWindow;
  },

  get agent() {
    return this.browserWindow?.CustomAgentChatUI?.agent ?? null;
  },

  get pending() {
    return !!this.request;
  },

  get canSend() {
    let text = this.input.value.trim();
    return !!this.agent && !this.pending && !!text && text.length <= 32000;
  },

  init() {
    this.conversationId = Services.uuid.generateUUID().toString();
    this.input = document.getElementById("chat-input");
    this.form = document.getElementById("chat-form");
    this.sendButton = document.getElementById("chat-send");
    this.stopButton = document.getElementById("chat-stop");
    this.newButton = document.getElementById("chat-new");
    this.list = document.getElementById("chat-messages");
    this.status = document.getElementById("chat-status");
    this.icon = document.getElementById("chat-icon");
    this.composer = document.querySelector(".chat-composer");
    this.scrollEndButton = document.getElementById("chat-scroll-end");
    this.activityStatus = document.getElementById("chat-activity-status");
    this.activityStatusLabel = document.getElementById(
      "chat-activity-status-label"
    );
    this.activityStatusDetail = document.getElementById(
      "chat-activity-status-detail"
    );
    this.effortControl = document.getElementById("chat-effort-control");
    this.effortOptions = [
      ...this.effortControl.querySelectorAll(".chat-effort-option"),
    ];
    this.initEffort();

    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    new ResizeObserver(() => {
      document.documentElement.style.setProperty(
        "--chat-composer-height",
        `${this.composer.offsetHeight}px`
      );
      this.followIfNeeded();
    }).observe(this.composer);
    this.initScrollFollow();
    this.scrollEndButton.addEventListener("click", () => {
      this.scrollToEnd(true);
      this.input.focus();
    });
    this.list.addEventListener("click", event => this.openLink(event));
    this.list.addEventListener("auxclick", event => this.openLink(event));

    this.form.addEventListener("submit", event => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener("input", () => {
      this.fitInput();
      this.updateAvailability();
    });
    this.input.addEventListener("keydown", event => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        this.submit();
      }
    });
    this.stopButton.addEventListener("click", () => {
      this.cancel();
      this.input.focus();
    });
    this.newButton.addEventListener("click", () => {
      this.browserWindow.CustomAgentChatUI.openChat();
    });
    this.newButton.disabled = !this.browserWindow?.CustomAgentChatUI?.enabled;
    this.connectionListener = () => {
      if (this.request && this.request.agent !== this.agent) {
        this.cancel();
      }
      this.updateAvailability();
    };
    this.prefObserver = () => {
      this.ensureRuntimeConnected();
      this.updateAvailability();
    };
    Services.prefs.addObserver("browser.agent.apiKey", this.prefObserver);
    this.applyTheme();
    this.themeObserver = () => this.applyTheme();
    Services.prefs.addObserver(this.themePref, this.themeObserver);
    window.addEventListener("pageshow", () => {
      this.rebindWindow();
    });
    window.addEventListener("pagehide", () => {
      this.cancel();
      Services.prefs.removeObserver("browser.agent.apiKey", this.prefObserver);
      Services.prefs.removeObserver(this.themePref, this.themeObserver);
      this.connectionWindow?.removeEventListener(
        "CustomAgentConnectionChanged",
        this.connectionListener
      );
    });
    this.rebindWindow();
    let query = this.browserWindow?.CustomAgentChatUI?.takeInitialQuery(
      window.browsingContext.embedderElement
    );
    if (query) {
      this.input.value = query;
      this.updateAvailability();
      if (this.canSend) {
        this.submit();
      }
    }
    document.l10n.ready.then(() => this.input.focus());
  },

  ensureRuntimeConnected() {
    let owner = this.browserWindow;
    if (!owner?.CustomAgentUI || owner.CustomAgentUI.agent) {
      return;
    }
    let hasApiKey = Boolean(
      Services.prefs.getStringPref("browser.agent.apiKey", "").trim()
    );
    if (!Cu.isInAutomation || hasApiKey) {
      try {
        let { AgentChatAdapter } = ChromeUtils.importESModule(
          "resource:///modules/agent/AgentRuntime.sys.mjs"
        );
        owner.CustomAgentUI.connect(AgentChatAdapter);
      } catch (e) {
        console.error(e);
      }
    }
  },

  rebindWindow() {
    let owner = this.browserWindow;
    if (this.connectionWindow !== owner) {
      this.cancel();
      this.connectionWindow?.removeEventListener(
        "CustomAgentConnectionChanged",
        this.connectionListener
      );
      this.connectionWindow = owner;
    }
    this.connectionWindow?.addEventListener(
      "CustomAgentConnectionChanged",
      this.connectionListener
    );
    this.ensureRuntimeConnected();
    this.updateAvailability();
  },

  /**
   * @param {string} [statusId] Fluent ID for the status line.
   * @param {object} [statusArgs] Fluent arguments for `statusId`.
   */
  updateAvailability(statusId, statusArgs = null) {
    if (this.pending) {
      this.statusId = "agent-chat-responding";
      this.statusArgs = null;
    } else if (!this.agent) {
      this.statusId = "agent-chat-disconnected";
      this.statusArgs = null;
    } else if (statusId) {
      this.statusId = statusId;
      this.statusArgs = statusArgs;
    } else if (
      ["agent-chat-disconnected", "agent-chat-responding"].includes(
        this.statusId
      )
    ) {
      this.statusId = "agent-chat-ready";
      this.statusArgs = null;
    }
    document.l10n.setAttributes(this.status, this.statusId, this.statusArgs);
    this.sendButton.disabled = !this.canSend;
    this.newButton.disabled = !this.browserWindow?.CustomAgentChatUI?.enabled;
    this.sendButton.hidden = this.pending;
    this.stopButton.hidden = !this.pending;
    this.list.setAttribute("aria-busy", String(this.pending));
    if (!this.pending) {
      this.hideActivityStatus();
    }
    let icon = this.pending
      ? "chrome://browser/content/custom-ui/resources/mono/animation/mono-glyph-spin-small.svg"
      : "chrome://browser/content/custom-ui/resources/mono/logo/mono-glyph-small.svg";
    if (this.icon.getAttribute("href") !== icon) {
      this.icon.setAttribute("href", icon);
    }
  },

  /**
   * Sets up the effort switch: a track whose selection surface follows the
   * chosen level. Dragging across the track turns the surface into glass
   * that follows the pointer, and releasing chooses the level under it.
   */
  initEffort() {
    let control = this.effortControl;
    let count = this.effortOptions.length;
    let levelAt = clientX => {
      let rect = control.getBoundingClientRect();
      let ratio = (clientX - rect.left) / rect.width;
      if (document.dir === "rtl") {
        ratio = 1 - ratio;
      }
      return Math.min(count, Math.max(1, Math.floor(ratio * count) + 1));
    };
    for (let option of this.effortOptions) {
      option.addEventListener("click", () => {
        this.setEffort(Number(option.dataset.level));
      });
    }
    control.addEventListener("keydown", event => {
      let step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[
        event.key
      ];
      if (document.dir === "rtl" && event.key.startsWith("Arrow")) {
        step = -step;
      }
      let level = this.effortLevel + (step || 0);
      if (event.key === "Home") {
        level = 1;
      } else if (event.key === "End") {
        level = count;
      } else if (!step) {
        return;
      }
      event.preventDefault();
      this.setEffort(Math.min(count, Math.max(1, level)));
      this.effortOptions[this.effortLevel - 1].focus();
    });
    control.addEventListener("pointerdown", event => {
      if (event.button !== 0) {
        return;
      }
      this.effortDrag = { x: event.clientX, moved: false };
    });
    control.addEventListener("pointermove", event => {
      if (!this.effortDrag) {
        return;
      }
      if (!this.effortDrag.moved) {
        if (Math.abs(event.clientX - this.effortDrag.x) < 4) {
          return;
        }
        // Captured only once dragging, so a plain press still clicks an option.
        control.setPointerCapture(event.pointerId);
      }
      this.effortDrag.moved = true;
      control.toggleAttribute("swiping", true);
      this.showEffort(levelAt(event.clientX));
    });
    let endDrag = event => {
      if (!this.effortDrag) {
        return;
      }
      let { moved } = this.effortDrag;
      this.effortDrag = null;
      control.removeAttribute("swiping");
      if (moved && event.type === "pointerup") {
        this.setEffort(levelAt(event.clientX));
      } else {
        this.showEffort(this.effortLevel);
      }
    };
    control.addEventListener("pointerup", endDrag);
    control.addEventListener("pointercancel", endDrag);
    this.setEffort(Number(control.dataset.effortLevel) || 1);
  },

  // "normal" or "deep"; see AgentRuntime.chat.
  get researchMode() {
    return this.effortOptions[this.effortLevel - 1]?.dataset.mode || "normal";
  },

  setEffort(level) {
    this.effortLevel = level;
    this.effortControl.dataset.effortLevel = String(level);
    for (let option of this.effortOptions) {
      let selected = Number(option.dataset.level) === level;
      option.setAttribute("aria-checked", String(selected));
      option.tabIndex = selected ? 0 : -1;
    }
    this.showEffort(level);
  },

  showEffort(level) {
    this.effortControl.style.setProperty("--chat-effort-index", level - 1);
    for (let option of this.effortOptions) {
      option.toggleAttribute(
        "candidate",
        Number(option.dataset.level) === level
      );
    }
  },

  get reducedMotion() {
    return this.motionQuery.matches;
  },

  /**
   * Resizes the composer's input to its text. The measuring pass needs the
   * natural height, so the old height is read first and eased from.
   */
  fitInput() {
    let input = this.input;
    let from = input.getBoundingClientRect().height;
    for (let animation of input.getAnimations()) {
      animation.cancel();
    }
    input.style.height = "";
    let to = Math.min(input.scrollHeight, 200);
    input.style.height = `${to}px`;
    if (from && Math.abs(from - to) >= 1 && !this.reducedMotion) {
      input.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: 160,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
    }
  },

  distanceFromEnd() {
    return (
      this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight
    );
  },

  updateScrollEnd() {
    this.scrollEndButton.hidden =
      this.list.hidden || this.distanceFromEnd() < 160;
  },

  /**
   * Keeps the list pinned to its end while an answer grows, until the user
   * scrolls away. Scrolling is told apart from the page's own pinning by
   * direction: pinning only ever moves toward the end, so an upward scroll
   * beyond the threshold, or one that follows wheel, key, touch or scrollbar
   * input, ends following. Reaching the end again resumes it.
   */
  initScrollFollow() {
    this.following = true;
    this.smoothing = false;
    this.lastScrollTop = 0;
    this.userScrollUntil = 0;
    this.userHolding = false;
    const FOLLOW_THRESHOLD = 40;
    let list = this.list;

    this.contentObserver = new ResizeObserver(() => this.followIfNeeded());
    this.contentObserver.observe(list);

    let markUser = () => {
      this.userScrollUntil = performance.now() + 700;
    };
    let stopFollowing = () => {
      this.following = false;
      this.endSmoothing(false);
    };
    let canScrollUp = () =>
      list.scrollTop > 0 && list.scrollHeight > list.clientHeight;
    let release = () => {
      if (this.userHolding) {
        this.userHolding = false;
        markUser();
      }
    };

    list.addEventListener(
      "wheel",
      event => {
        if (event.ctrlKey) {
          return;
        }
        markUser();
        if (event.deltaY < 0 && canScrollUp()) {
          stopFollowing();
        }
      },
      { passive: true }
    );
    list.addEventListener("keydown", event => {
      let up = ["ArrowUp", "PageUp", "Home"].includes(event.key);
      if (up || ["ArrowDown", "PageDown", "End", " "].includes(event.key)) {
        markUser();
      }
      if ((up || (event.key === " " && event.shiftKey)) && canScrollUp()) {
        stopFollowing();
      }
    });
    list.addEventListener(
      "touchstart",
      () => {
        this.userHolding = true;
        markUser();
      },
      { passive: true }
    );
    list.addEventListener("touchmove", markUser, { passive: true });
    list.addEventListener("pointerdown", event => {
      if (
        event.target === list &&
        (event.offsetX > list.clientWidth || event.offsetX < 0)
      ) {
        this.userHolding = true;
        markUser();
      }
    });
    for (let type of [
      "touchend",
      "touchcancel",
      "pointerup",
      "pointercancel",
    ]) {
      window.addEventListener(type, release, { passive: true });
    }

    list.addEventListener(
      "scroll",
      () => {
        let top = list.scrollTop;
        let up = top < this.lastScrollTop - 1;
        this.lastScrollTop = top;
        let distance = this.distanceFromEnd();
        if (up) {
          // A shrinking list clamps itself toward the end without the user.
          if (
            distance > FOLLOW_THRESHOLD ||
            this.userHolding ||
            performance.now() < this.userScrollUntil
          ) {
            stopFollowing();
          }
        } else if (distance <= FOLLOW_THRESHOLD) {
          this.following = true;
        }
        if (this.smoothing && distance <= 1) {
          this.endSmoothing(true);
        }
        this.updateScrollEnd();
      },
      { passive: true }
    );
    list.addEventListener("scrollend", () => {
      if (this.smoothing) {
        this.endSmoothing(true);
      }
    });
  },

  /**
   * Runs after layout whenever the list or an answer changes size, so the
   * stream needs no layout reads of its own.
   */
  followIfNeeded() {
    if (this.following && !this.smoothing) {
      this.list.scrollTop = this.list.scrollHeight;
    }
    this.updateScrollEnd();
  },

  endSmoothing(follow) {
    clearTimeout(this.smoothTimer);
    this.smoothing = false;
    if (follow) {
      this.followIfNeeded();
    }
  },

  /**
   * Shows what the agent is doing in the capsule over the composer. A new
   * label fades in while the capsule eases to its new width, so the capsule
   * changes its words without jumping.
   */
  setActivityStatus(label, detail = "") {
    if (!this.pending) {
      return;
    }
    let status = this.activityStatus;
    let shown = !status.hidden && !status.hasAttribute("data-leaving");
    if (
      shown &&
      this.activityStatusLabel.textContent === label &&
      this.activityStatusDetail.textContent === detail
    ) {
      return;
    }
    let from = shown ? status.getBoundingClientRect().width : 0;
    for (let animation of status.getAnimations()) {
      animation.cancel();
    }
    status.removeAttribute("data-leaving");
    status.hidden = false;
    this.activityStatusLabel.textContent = label;
    this.activityStatusDetail.textContent = detail;
    this.activityStatusDetail.hidden = !detail;
    if (!from || this.reducedMotion) {
      return;
    }
    let to = status.getBoundingClientRect().width;
    let easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
    if (Math.abs(to - from) >= 1) {
      status.animate(
        { width: [`${from}px`, `${to}px`] },
        { duration: 260, easing }
      );
    }
    for (let text of [this.activityStatusLabel, this.activityStatusDetail]) {
      text.animate(
        { opacity: [0, 1], filter: ["blur(2px)", "blur(0)"] },
        { duration: 220, easing: "ease-out" }
      );
    }
  },

  hideActivityStatus() {
    let status = this.activityStatus;
    if (status.hidden || status.hasAttribute("data-leaving")) {
      return;
    }
    if (this.reducedMotion) {
      status.hidden = true;
      return;
    }
    status.setAttribute("data-leaving", "");
    status
      .animate(
        { opacity: [1, 0], translate: ["0 0", "0 4px"], scale: [1, 0.96] },
        { duration: 180, easing: "ease-in", fill: "forwards" }
      )
      .finished.then(() => {
        if (status.hasAttribute("data-leaving")) {
          status.removeAttribute("data-leaving");
          status.hidden = true;
        }
        for (let animation of status.getAnimations()) {
          animation.cancel();
        }
      })
      .catch(() => {});
  },

  /**
   * Plays the finish flash on a completed answer's author icon. Each answer
   * gets its own image URL so the one-shot animation starts from the
   * beginning instead of sharing an earlier, finished timeline.
   *
   * @param {HTMLElement} article
   */
  playFinished(article) {
    this.finishCount = (this.finishCount ?? 0) + 1;
    article.style.setProperty(
      "--chat-author-icon",
      `url("chrome://browser/content/custom-ui/resources/mono/animation/mono-glyph-done.svg?${this.finishCount}")`
    );
  },

  appendMessage(role, content, { scroll = true } = {}) {
    let article = document.createElement("article");
    article.className = "chat-message";
    article.dataset.role = role;
    let author = document.createElement("div");
    author.className = "chat-message-author";
    document.l10n.setAttributes(author, `agent-chat-author-${role}`);
    let activity = null;
    let activityTitle = null;
    let activityList = null;
    if (role === "assistant") {
      activity = document.createElement("div");
      activity.className = "chat-message-activity";
      activity.hidden = true;
      let header = document.createElement("button");
      header.type = "button";
      header.className = "chat-activity-header";
      activityTitle = document.createElement("span");
      activityTitle.className = "chat-activity-title";
      document.l10n.setAttributes(activityTitle, "agent-chat-activity-title");
      header.append(activityTitle, this.createChevron());
      activityList = document.createElement("ol");
      activityList.className = "chat-timeline";
      activity.append(header, this.createCollapse(activityList));
      this.makeCollapsible(activity, header, true);
    }
    let body = document.createElement("div");
    body.className = "chat-message-body";
    body.textContent = content;
    if (activity) {
      article.append(author, activity, body);
    } else {
      article.append(author, body);
    }
    this.list.append(article);
    this.contentObserver.observe(article);
    if (scroll) {
      this.scrollToEnd();
    }
    return { article, activity, activityTitle, activityList, body };
  },

  /**
   * Adds one step to an answer's activity timeline.
   *
   * @param {object} request
   * @param {string} kind "thinking" or "tool"; also the step's class suffix.
   */
  appendStep(request, kind) {
    request.activity.hidden = false;
    let step = document.createElement("li");
    step.className = `chat-step chat-step-${kind}`;
    step.dataset.status = "running";
    let rail = document.createElement("span");
    rail.className = "chat-step-rail";
    rail.setAttribute("aria-hidden", "true");
    let marker = document.createElement("span");
    marker.className = "chat-step-marker";
    rail.append(marker);
    let header = document.createElement("button");
    header.type = "button";
    header.className = "chat-step-header";
    step.append(rail, header);
    request.activityList.append(step);
    this.makeCollapsible(step, header, true);
    return { step, header };
  },

  /**
   * Folds a finished step. Its pages first leave one after another (see
   * data-settling in the stylesheet), then the step closes, so the list goes
   * away the way it came instead of being cut off by the fold.
   *
   * @param {HTMLElement} step
   */
  settleStep(step) {
    if (!this.reducedMotion) {
      step.style.setProperty(
        "--chat-settle-pages",
        step.querySelectorAll(".chat-headless-card").length
      );
      step.setAttribute("data-settling", "");
      clearTimeout(step.settleTimer);
      step.settleTimer = setTimeout(
        () => step.removeAttribute("data-settling"),
        900
      );
    }
    this.setOpen(step, false);
  },

  createChevron() {
    let chevron = document.createElement("span");
    chevron.className = "chat-chevron";
    chevron.setAttribute("aria-hidden", "true");
    return chevron;
  },

  /**
   * Wraps content in a box whose height animates when its owner opens or
   * closes.
   *
   * @param {HTMLElement} content
   */
  createCollapse(content) {
    let collapse = document.createElement("div");
    collapse.className = "chat-collapse";
    let inner = document.createElement("div");
    inner.className = "chat-collapse-inner";
    inner.append(content);
    collapse.append(inner);
    return collapse;
  },

  makeCollapsible(owner, header, open) {
    header.addEventListener("click", () => {
      this.setOpen(owner, owner.dataset.open !== "true");
    });
    owner.collapseHeader = header;
    this.setOpen(owner, open);
  },

  setOpen(owner, open) {
    let thought =
      owner.dataset.open !== undefined &&
      owner.classList.contains("chat-step-thinking") &&
      !this.reducedMotion
        ? owner.querySelector(".chat-thinking-body")
        : null;
    let from = thought?.getBoundingClientRect().height;
    owner.dataset.open = String(open);
    owner.collapseHeader.setAttribute("aria-expanded", String(open));
    if (thought) {
      this.easeThought(thought, from);
    }
  },

  /**
   * A thought has no collapse box: opening or closing swaps its clamp and
   * line wrapping at once, so the height is eased by hand. Wrapping is held
   * while it runs so the text being clipped does not reflow.
   */
  easeThought(body, from) {
    let to = body.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) {
      return;
    }
    let frame = height => ({
      height: `${height}px`,
      maxHeight: `${height}px`,
      whiteSpace: "pre-wrap",
      textOverflow: "clip",
    });
    body.animate([frame(from), frame(to)], {
      duration: 280,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  },

  ensureThinkingCard(request, round = 0) {
    let existing = request.thinkingCards.get(round);
    if (existing) {
      return existing;
    }
    let { step, header } = this.appendStep(request, "thinking");
    step.dataset.round = String(round);
    let body = document.createElement("span");
    body.className = "chat-thinking-body";
    header.append(body);

    let card = { step, body, text: "" };
    request.thinkingCards.set(round, card);
    return card;
  },

  ensureToolCard(request, { id, round = 0, index = 0, name = "tool" }) {
    let key = id || `round_${round}_idx_${index}`;
    let existing =
      request.toolCards.get(key) ||
      request.toolCards.get(`round_${round}_idx_${index}`);
    if (existing) {
      if (id && !request.toolCards.has(id)) {
        request.toolCards.set(id, existing);
      }
      return existing;
    }

    let { step: container, header } = this.appendStep(request, "tool");

    let title = document.createElement("span");
    title.className = "chat-step-title";
    header.append(title, this.createChevron());

    let content = document.createElement("div");
    content.className = "chat-step-content";

    let queries = document.createElement("div");
    queries.className = "chat-step-queries";
    queries.hidden = true;

    let headlessList = document.createElement("div");
    headlessList.className = "chat-headless-list";
    headlessList.hidden = true;

    let outputDetails = document.createElement("details");
    outputDetails.className = "chat-tool-output";
    outputDetails.hidden = true;

    let outputSummary = document.createElement("summary");
    outputSummary.textContent = "수집한 내용 보기";

    let outputPre = document.createElement("pre");
    outputPre.className = "chat-tool-output-pre";

    outputDetails.append(outputSummary, outputPre);
    content.append(queries, headlessList, outputDetails);
    container.append(this.createCollapse(content));

    let card = {
      container,
      title,
      queries,
      headlessList,
      outputDetails,
      outputPre,
    };
    this.setToolName(card, name);
    request.toolCards.set(key, card);
    if (id) {
      request.toolCards.set(id, card);
    }
    request.lastToolCard = card;
    return card;
  },

  ensureHeadlessCard(request, event) {
    let existing = request.headlessCards.get(event.browserId);
    if (existing) {
      return existing;
    }

    // Search result pages repeat the queries already listed in the step.
    if (
      typeof event.purpose === "string" &&
      event.purpose.startsWith("search")
    ) {
      let card = { skipped: true };
      request.headlessCards.set(event.browserId, card);
      return card;
    }

    let toolCard =
      (event.toolCallId && request.toolCards.get(event.toolCallId)) ||
      request.lastToolCard ||
      this.ensureToolCard(request, { id: "headless", name: "read_web_page" });
    toolCard.headlessList.hidden = false;

    let cardEl = document.createElement("span");
    cardEl.className = "chat-headless-card";
    cardEl.dataset.phase = "loading";
    // Pages leave in the order they came when the step folds.
    cardEl.style.setProperty(
      "--chat-pill-index",
      toolCard.headlessList.childElementCount
    );

    let address = document.createElement("span");
    address.className = "chat-headless-address";

    cardEl.append(address);
    toolCard.headlessList.append(cardEl);

    let card = { cardEl, address };
    this.setHeadlessUrl(card, event.url);
    request.headlessCards.set(event.browserId, card);
    return card;
  },

  setHeadlessUrl(card, url) {
    if (!url) {
      return;
    }
    card.address.textContent = formatHost(url) || formatShortUrl(url);
    card.cardEl.title = url;
  },

  /**
   * Takes a page the agent skipped out of its step: its width, padding and
   * opacity shrink to nothing (the negative margin takes the flex gap with
   * it, so the pills after it slide left without a final jump), then it
   * leaves the document.
   */
  removeHeadlessCard(request, card) {
    card.skipped = true;
    let { cardEl } = card;
    let list = cardEl.parentElement;
    let remove = () => {
      if (!cardEl.isConnected) {
        return;
      }
      this.flipBelow(request, () => {
        cardEl.remove();
        if (list && !list.childElementCount) {
          list.hidden = true;
        }
      });
    };
    if (this.reducedMotion) {
      remove();
      return;
    }
    let gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    let width = cardEl.getBoundingClientRect().width;
    cardEl.dataset.phase = "removing";
    cardEl.animate(
      [
        { width: `${width}px` },
        {
          width: "0px",
          paddingLeft: "0px",
          paddingRight: "0px",
          marginInlineEnd: `${-gap}px`,
          opacity: 0,
          filter: "blur(2px)",
        },
      ],
      {
        duration: 300,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        fill: "forwards",
      }
    );
    setTimeout(remove, 320);
  },

  renderToolOutput(card, event) {
    if (typeof event.output !== "string" || !event.output) {
      return;
    }
    card.outputDetails.hidden = false;
    card.outputPre.textContent = event.output;
  },

  setToolQueries(card, args) {
    let queries = formatToolQueries(args);
    if (!queries.length) {
      return;
    }
    // Lines already shown stay in place so they do not animate in again.
    let shown = [...card.queries.children];
    if (
      shown.length > queries.length ||
      shown.some((line, i) => line.textContent !== queries[i])
    ) {
      card.queries.replaceChildren();
      shown = [];
    }
    card.queries.append(
      ...queries.slice(shown.length).map(query => {
        let line = document.createElement("div");
        line.className = "chat-step-query";
        line.textContent = query;
        return line;
      })
    );
    card.queries.hidden = false;
  },

  setToolName(card, name) {
    if (!name) {
      return;
    }
    card.container.dataset.toolName = name;
    card.title.textContent = TOOL_TITLES[name] || name;
  },

  renderDebugMetrics(request, metrics) {
    if (!metrics || !Array.isArray(metrics.steps) || !metrics.steps.length) {
      return;
    }
    if (request.debugCard) {
      request.debugCard.remove();
    }

    let details = document.createElement("details");
    details.className = "chat-debug-card";

    let summary = document.createElement("summary");

    let title = document.createElement("span");
    title.textContent = "세부 정보";

    let totals = metrics.totals || {};
    let status = document.createElement("span");
    status.className = "chat-debug-totals";
    status.textContent = [
      `${((Number(metrics.totalDurationMs) || 0) / 1000).toFixed(1)}s`,
      metrics.firstContentMs > 0
        ? `첫 응답 ${(metrics.firstContentMs / 1000).toFixed(1)}s`
        : "",
      `LLM ${formatTokenCount(totals.totalTokens ?? 0)} tokens`,
      metrics.decideTotals?.inputTokens > 0
        ? `Decide ${formatTokenCount(metrics.decideTotals.inputTokens)} tokens`
        : "",
      metrics.model,
    ]
      .filter(Boolean)
      .join(" · ");

    summary.append(title, status);

    let wrap = document.createElement("div");
    wrap.className = "chat-debug-table-wrap";

    let table = document.createElement("table");
    table.className = "chat-debug-table";

    let thead = document.createElement("thead");
    let headRow = document.createElement("tr");
    const columns = [
      { label: "단계 (Step)", num: false },
      { label: "세부 내용", num: false },
      { label: "소요 시간", num: true },
      { label: "입력 토큰", num: true },
      { label: "추론(CoT) 토큰", num: true },
      { label: "출력 토큰", num: true },
      { label: "총 토큰", num: true },
    ];
    for (const col of columns) {
      let th = document.createElement("th");
      if (col.num) {
        th.className = "is-num";
      }
      th.textContent = col.label;
      headRow.append(th);
    }
    thead.append(headRow);

    let tbody = document.createElement("tbody");
    for (const step of metrics.steps) {
      let tr = document.createElement("tr");
      if (step.kind) {
        tr.dataset.kind = step.kind;
      }

      let tdStep = document.createElement("td");
      tdStep.textContent =
        step.kind === "headless" ? `↳ ${step.step}` : step.step || "-";

      let tdDetail = document.createElement("td");
      tdDetail.className = "chat-debug-detail";
      tdDetail.textContent = step.detail || "-";
      tdDetail.title = step.detail || "";

      let tdDuration = document.createElement("td");
      tdDuration.className = "is-num";
      tdDuration.textContent = formatDurationMs(step.durationMs);

      let tdPrompt = document.createElement("td");
      tdPrompt.className = "is-num";
      tdPrompt.textContent = formatTokenCount(
        step.promptTokens,
        step.estimated
      );

      let tdReasoning = document.createElement("td");
      tdReasoning.className = "is-num";
      tdReasoning.textContent = formatTokenCount(
        step.reasoningTokens,
        step.estimated
      );

      let tdCompletion = document.createElement("td");
      tdCompletion.className = "is-num";
      tdCompletion.textContent = formatTokenCount(
        step.completionTokens,
        step.estimated
      );

      let tdTotal = document.createElement("td");
      tdTotal.className = "is-num";
      tdTotal.textContent = formatTokenCount(step.totalTokens, step.estimated);

      tr.append(
        tdStep,
        tdDetail,
        tdDuration,
        tdPrompt,
        tdReasoning,
        tdCompletion,
        tdTotal
      );
      tbody.append(tr);
    }

    let tfoot = document.createElement("tfoot");
    let footRow = document.createElement("tr");

    let tdFootLabel = document.createElement("td");
    tdFootLabel.textContent = "LLM 합계";

    let tdFootDetail = document.createElement("td");
    tdFootDetail.className = "chat-debug-detail";
    tdFootDetail.textContent = `${metrics.steps.length}개 단계`;

    let tdFootDuration = document.createElement("td");
    tdFootDuration.className = "is-num";
    tdFootDuration.textContent = formatDurationMs(metrics.totalDurationMs);

    let tdFootPrompt = document.createElement("td");
    tdFootPrompt.className = "is-num";
    tdFootPrompt.textContent = formatTokenCount(totals.promptTokens ?? 0);

    let tdFootReasoning = document.createElement("td");
    tdFootReasoning.className = "is-num";
    tdFootReasoning.textContent = formatTokenCount(totals.reasoningTokens ?? 0);

    let tdFootCompletion = document.createElement("td");
    tdFootCompletion.className = "is-num";
    tdFootCompletion.textContent = formatTokenCount(
      totals.completionTokens ?? 0
    );

    let tdFootTotal = document.createElement("td");
    tdFootTotal.className = "is-num";
    tdFootTotal.textContent = formatTokenCount(totals.totalTokens ?? 0);

    footRow.append(
      tdFootLabel,
      tdFootDetail,
      tdFootDuration,
      tdFootPrompt,
      tdFootReasoning,
      tdFootCompletion,
      tdFootTotal
    );
    tfoot.append(footRow);

    // The decision model is billed apart from the LLM (input only), so it
    // gets its own total instead of being added to the LLM total.
    const decideTotals = metrics.decideTotals;
    if (decideTotals?.calls > 0) {
      let decideRow = document.createElement("tr");
      const cells = [
        "Decide 합계",
        `${decideTotals.calls}회 판단`,
        "",
        formatTokenCount(decideTotals.inputTokens),
        "-",
        "-",
        formatTokenCount(decideTotals.inputTokens),
      ];
      cells.forEach((text, index) => {
        let td = document.createElement("td");
        if (index === 1) {
          td.className = "chat-debug-detail";
        } else if (index > 1) {
          td.className = "is-num";
        }
        td.textContent = text;
        decideRow.append(td);
      });
      tfoot.append(decideRow);
    }

    table.append(thead, tbody, tfoot);
    wrap.append(table);
    details.append(summary, wrap);
    request.article.append(details);
    request.debugCard = details;
  },

  /**
   * Content under the activity timeline: it moves when the timeline grows or
   * shrinks.
   */
  belowActivity(request) {
    return [request.body, request.debugCard].filter(Boolean);
  },

  /**
   * Runs a change that resizes the activity timeline and slides the content
   * below it from where it was to where it ends up (FLIP), so that content
   * does not jump. The slide is added to any animation already running.
   */
  flipBelow(request, mutate) {
    if (this.reducedMotion) {
      mutate();
      return;
    }
    let before = this.belowActivity(request).map(element => [
      element,
      element.getBoundingClientRect().top,
    ]);
    mutate();
    for (let [element, top] of before) {
      let delta = top - element.getBoundingClientRect().top;
      if (Math.abs(delta) >= 1) {
        element.animate(
          { translate: [`0 ${delta}px`, "0 0"] },
          {
            duration: 280,
            easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
            composite: "add",
          }
        );
      }
    }
  },

  /**
   * Keeps a running thought scrolled to its newest line, once per frame
   * instead of forcing layout for every streamed piece.
   */
  queueThinkingScroll(card) {
    if (card.scrollQueued) {
      return;
    }
    card.scrollQueued = true;
    requestAnimationFrame(() => {
      card.scrollQueued = false;
      if (card.step.dataset.status !== "done") {
        card.body.scrollTop = card.body.scrollHeight;
      }
    });
  },

  handleAgentEvent(request, event) {
    if (this.request !== request || !event || typeof event !== "object") {
      return;
    }
    if (event.type === "thinking_delta") {
      this.applyAgentEvent(request, event);
    } else {
      this.flipBelow(request, () => this.applyAgentEvent(request, event));
    }
  },

  applyAgentEvent(request, event) {
    switch (event.type) {
      case "thinking_start": {
        this.ensureThinkingCard(request, event.round ?? 0);
        this.setActivityStatus("생각하는 중");
        break;
      }
      case "thinking_delta": {
        if (typeof event.delta !== "string" || !event.delta) {
          break;
        }
        let card = this.ensureThinkingCard(request, event.round ?? 0);
        card.text = event.replace ? event.delta : card.text + event.delta;
        card.body.textContent = card.text;
        this.queueThinkingScroll(card);
        break;
      }
      case "thinking_done": {
        let card = request.thinkingCards.get(event.round ?? 0);
        if (card) {
          card.body.scrollTop = 0;
          this.setOpen(card.step, false);
          card.step.dataset.status = "done";
        }
        break;
      }
      case "tool_call_delta": {
        let card = this.ensureToolCard(request, event);
        this.setToolName(card, event.name);
        break;
      }
      case "answer_refine": {
        if (typeof event.text !== "string") {
          break;
        }
        if (!request.fade.refine) {
          request.fade.refine = true;
          request.body.dataset.refining = "true";
          this.setActivityStatus("답변 다듬는 중");
        }
        request.received = event.text;
        request.text = event.text;
        this.renderAnswer(request, request.text);
        break;
      }
      case "tab_title": {
        if (event.title) {
          this.setTabTitle(event.title, request);
        }
        break;
      }
      case "tool_call_start": {
        if ((event.round ?? 0) === 0 && event.args?.tabTitle) {
          this.setTabTitle(event.args.tabTitle, request);
        }
        let card = this.ensureToolCard(request, event);
        this.setToolName(card, event.name);
        this.setToolQueries(card, event.args);
        card.container.dataset.status = "running";
        this.setOpen(card.container, true);
        this.setActivityStatus(
          TOOL_ACTIVITIES[event.name] || card.title.textContent,
          formatToolQueries(event.args)[0]
        );
        break;
      }
      case "tool_call_done": {
        let card = this.ensureToolCard(request, event);
        this.setToolQueries(card, event.args);
        card.container.dataset.status = event.isError ? "error" : "done";
        this.settleStep(card.container);
        this.setActivityStatus("생각하는 중");
        this.renderToolOutput(card, event);
        break;
      }
      case "headless_start":
      case "headless_observing":
      case "headless_done": {
        let hCard = this.ensureHeadlessCard(request, event);
        if (hCard.skipped) {
          break;
        }
        hCard.cardEl.dataset.phase =
          event.type === "headless_done" ? "done" : "loading";
        this.setHeadlessUrl(hCard, event.url);
        if (event.type !== "headless_done") {
          this.setActivityStatus("페이지 읽는 중", formatHost(event.url));
        } else if (event.title) {
          hCard.cardEl.title = `${event.title}\n${hCard.cardEl.title}`;
        }
        break;
      }
      case "headless_error": {
        let hCard = this.ensureHeadlessCard(request, event);
        if (!hCard.skipped) {
          this.removeHeadlessCard(request, hCard);
        }
        break;
      }
      case "chat_metrics": {
        this.renderDebugMetrics(request, event.metrics);
        break;
      }
      case "deep_think": {
        // Text the light round wrote is replaced by the deeper answer.
        if (request.received) {
          request.received = "";
          this.flushReveal(request);
        }
        this.setActivityStatus("깊이 생각하는 중");
        break;
      }
      case "sources": {
        if (Array.isArray(event.sources)) {
          request.sources = new Map(
            event.sources
              .filter(source => /^https?:/.test(source?.url || ""))
              .map(source => [source.id, source])
          );
        }
        break;
      }
    }
  },

  setTabTitle(rawTitle, request) {
    let clean = String(rawTitle || "")
      .replace(/<\/?tab_title>/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) {
      return;
    }
    if (clean.length > 40) {
      clean = clean.slice(0, 40).trim();
    }
    if (request?.activityTitle) {
      request.activityTitle.removeAttribute("data-l10n-id");
      request.activityTitle.textContent = clean;
    }
    this.tabTitle = clean;
    let titleEl = document.querySelector("title");
    if (titleEl) {
      titleEl.removeAttribute("data-l10n-id");
      titleEl.textContent = clean;
    }
    document.title = clean;
    let headingEl = document.getElementById("chat-title");
    if (headingEl) {
      headingEl.removeAttribute("data-l10n-id");
      headingEl.textContent = clean;
    }
    let embedder = window.browsingContext?.embedderElement;
    let gBrowser = this.browserWindow?.gBrowser;
    if (gBrowser && embedder) {
      let tab = gBrowser.getTabForBrowser(embedder);
      if (tab) {
        let changed = tab.getAttribute("label") !== clean;
        tab.setAttribute("label", clean);
        tab.setAttribute("visibleLabel", clean);
        gBrowser.setTabTitle(tab);
        // setTabTitle finds the label already set and stays quiet, so the
        // tab strip and sidebar address are told here.
        if (changed) {
          gBrowser._tabAttrModified(tab, ["label"]);
        }
      }
    }
  },

  /**
   * Jumps to the end of the list and resumes following. The scroll-to-end
   * button scrolls smoothly; following itself never does, since restarting a
   * smooth scroll on every chunk would stall it.
   *
   * @param {boolean} [smooth]
   */
  scrollToEnd(smooth = false) {
    this.following = true;
    clearTimeout(this.smoothTimer);
    if (smooth && !this.reducedMotion) {
      this.smoothing = true;
      this.list.scrollTo({ top: this.list.scrollHeight, behavior: "smooth" });
      this.smoothTimer = setTimeout(() => this.endSmoothing(true), 900);
    } else {
      this.smoothing = false;
      this.list.scrollTop = this.list.scrollHeight;
    }
    this.updateScrollEnd();
  },

  /**
   * Renders the answer text. The markdown is rebuilt synchronously for each
   * chunk; only the text that just arrived fades in, and the waiting dots
   * fade out over the first text instead of vanishing.
   */
  renderAnswer(request, text) {
    let body = request.body;
    if (body.hasAttribute("data-l10n-id")) {
      body.removeAttribute("data-l10n-id");
      if (!this.reducedMotion) {
        body.dataset.dotsOut = "true";
        setTimeout(() => body.removeAttribute("data-dots-out"), 200);
      }
    }
    renderMarkdown(
      body,
      text,
      this.reducedMotion ? null : request.fade,
      request.sources
    );
  },

  /**
   * Lists the sources the answer cited, in citation order, under the answer.
   *
   * @param {object} request
   */
  renderSources(request) {
    if (!request.sources?.size) {
      return;
    }
    let cited = new Set();
    for (let cite of request.body.querySelectorAll(".chat-cite")) {
      cited.add(cite.textContent);
    }
    if (!cited.size) {
      return;
    }
    let list = document.createElement("div");
    list.className = "chat-sources";
    list.setAttribute("role", "list");
    document.l10n.setAttributes(list, "agent-chat-sources");
    for (let id of cited) {
      let source = request.sources.get(Number(id));
      let item = document.createElement("a");
      item.className = "chat-source";
      item.setAttribute("role", "listitem");
      item.style.setProperty("--chat-pill-index", list.childElementCount);
      item.href = source.url;
      item.title = source.title ? `${source.title}\n${source.url}` : source.url;
      let number = document.createElement("span");
      number.className = "chat-source-number";
      number.textContent = id;
      let label = document.createElement("span");
      label.className = "chat-source-label";
      label.textContent = formatHost(source.url) || source.title;
      item.append(number, label);
      list.append(item);
    }
    request.body.after(list);
  },

  openLink(event) {
    let link = event.target.closest?.("a[href]");
    if (!link || !/^https?:/.test(link.href) || event.button > 1) {
      return;
    }
    event.preventDefault();
    this.browserWindow?.openWebLinkIn(link.href, "tab", {
      relatedToCurrent: true,
      inBackground: event.button === 1 || event.ctrlKey || event.metaKey,
    });
  },

  removeArticle(article) {
    this.contentObserver.unobserve(article);
    article.remove();
  },

  async submit() {
    if (!this.canSend) {
      return;
    }
    let query = this.input.value.trim();
    let agent = this.agent;
    let userMessage = this.retry?.message;
    if (
      userMessage === this.messages.at(-1) &&
      userMessage?.content === query
    ) {
      this.removeArticle(this.retry.response.article);
    } else {
      userMessage = { role: "user", content: query };
      this.messages.push(userMessage);
      this.appendMessage("user", query, { scroll: false });
    }
    this.retry = null;
    this.input.value = "";
    this.fitInput();
    let response = this.appendMessage("assistant", "", { scroll: false });
    response.article.dataset.pending = "true";
    document.l10n.setAttributes(response.body, "agent-chat-pending-message");
    // The new exchange glides into view instead of the list jumping to it.
    this.scrollToEnd(true);
    let request = {
      ...response,
      agent,
      // Shown text and everything received so far; see queueReveal.
      text: "",
      received: "",
      revealFrame: 0,
      revealIdle: null,
      thinkingCards: new Map(),
      toolCards: new Map(),
      headlessCards: new Map(),
      lastToolCard: null,
      debugCard: null,
      fade: { text: "", runs: [] },
      controller: new AbortController(),
    };
    this.request = request;
    this.updateAvailability();
    this.setActivityStatus("생각하는 중");
    this.input.focus();
    try {
      let answer = await agent.chat({
        conversationId: this.conversationId,
        messages: this.messages.map(message => ({ ...message })),
        mode: this.researchMode,
        signal: request.controller.signal,
        onEvent: event => this.handleAgentEvent(request, event),
        onDelta: delta => {
          if (this.request !== request || typeof delta !== "string") {
            return;
          }
          if (!request.received) {
            this.setActivityStatus("답변 작성 중");
          }
          request.received += delta;
          this.queueReveal(request);
        },
      });
      if (this.request !== request) {
        return;
      }
      if (answer !== undefined && typeof answer !== "string") {
        throw new TypeError("Agent chat must return text or stream a response");
      }
      let content = typeof answer === "string" ? answer : request.received;
      if (!content.trim()) {
        this.removeArticle(request.article);
        this.request = null;
        this.input.value ||= query;
        this.retry = { message: userMessage, response: request };
        this.updateAvailability("agent-chat-empty-response");
        return;
      }
      const continuesShownText = content.startsWith(request.text);
      request.received = content;
      if (continuesShownText) {
        this.queueReveal(request);
        await this.waitForReveal(request);
        if (this.request !== request) {
          return;
        }
      } else {
        this.flushReveal(request);
      }
      this.endRefining(request);
      request.text = content;
      this.renderAnswer(request, content);
      this.renderSources(request);
      delete request.article.dataset.pending;
      this.setOpen(request.activity, false);
      this.playFinished(request.article);
      // Source numbers restart with every answer, so old ones are dropped.
      this.messages.push({
        role: "assistant",
        content: request.sources?.size
          ? content.replace(/ ?\[\d{1,3}\]/g, "")
          : content,
      });
      this.request = null;
      this.updateAvailability("agent-chat-ready");
    } catch (error) {
      if (this.request !== request) {
        return;
      }
      this.finishInterrupted(request);
      this.request = null;
      this.input.value ||= query;
      this.retry = { message: userMessage, response: request };
      const reason = String(error?.message || error || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      if (reason) {
        this.updateAvailability("agent-chat-error-detail", { reason });
      } else {
        this.updateAvailability("agent-chat-error");
      }
      console.error("Agent chat request failed", error);
    }
  },

  /**
   * Reveals streamed text at a pace that turns block-sized jumps into a quick
   * sweep without falling behind the stream: at least
   * REVEAL_MIN_CHARS_PER_SEC, and faster while a large block is waiting, so
   * each block is fully shown within about REVEAL_DRAIN_MS.
   *
   * @param {object} request
   */
  queueReveal(request) {
    if (this.reducedMotion || document.hidden) {
      this.flushReveal(request);
      return;
    }
    if (request.revealFrame) {
      return;
    }
    let last = performance.now();
    const step = now => {
      request.revealFrame = 0;
      const elapsed = Math.max(16, now - last);
      last = now;
      const { received } = request;
      const backlog = received.length - request.text.length;
      if (backlog > 0) {
        const count = Math.max(
          Math.ceil((REVEAL_MIN_CHARS_PER_SEC * elapsed) / 1000),
          Math.ceil((backlog * elapsed) / REVEAL_DRAIN_MS)
        );
        let end = Math.min(received.length, request.text.length + count);
        if ((received.charCodeAt(end - 1) & 0xfc00) === 0xd800) {
          end++;
        }
        request.text = received.slice(0, end);
        this.renderAnswer(request, request.text);
      }
      if (request.text.length < received.length) {
        request.revealFrame = requestAnimationFrame(step);
      } else {
        request.revealIdle?.();
      }
    };
    request.revealFrame = requestAnimationFrame(step);
  },

  flushReveal(request) {
    if (request.revealFrame) {
      cancelAnimationFrame(request.revealFrame);
      request.revealFrame = 0;
    }
    if (request.text !== request.received) {
      request.text = request.received;
      this.renderAnswer(request, request.text);
    }
    request.revealIdle?.();
  },

  /**
   * Resolves once all received text is shown. Hidden pages get no animation
   * frames, so the rest is shown at once after a short timeout.
   *
   * @param {object} request
   * @returns {Promise<void>}
   */
  waitForReveal(request) {
    if (!request.revealFrame) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const timer = setTimeout(
        () => this.flushReveal(request),
        REVEAL_FINISH_TIMEOUT_MS
      );
      request.revealIdle = () => {
        clearTimeout(timer);
        request.revealIdle = null;
        resolve();
      };
    });
  },

  endRefining(request) {
    request.fade.refine = false;
    delete request.body.dataset.refining;
  },

  finishInterrupted(request) {
    this.flushReveal(request);
    this.endRefining(request);
    if (!request.text) {
      this.removeArticle(request.article);
      return;
    }
    delete request.article.dataset.pending;
    request.article.dataset.interrupted = "true";
  },

  cancel() {
    let request = this.request;
    if (!request) {
      return;
    }
    this.request = null;
    request.controller.abort();
    this.finishInterrupted(request);
    this.updateAvailability("agent-chat-stopped");
  },
};

AgentChatPage.init();
