/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function formatToolArgsPreview(name, args, rawText = "") {
  if (args && typeof args === "object") {
    if (Array.isArray(args.queries) && args.queries.length) {
      return `queries (${args.queries.length}개 병렬): ${args.queries.map(q => `"${q}"`).join(", ")}`;
    }
    if (typeof args.query === "string" && args.query) {
      return `query: "${args.query}"`;
    }
    if (Array.isArray(args.urls) && args.urls.length) {
      return `urls (${args.urls.length}개 병렬): ${args.urls.join(", ")}`;
    }
    if (typeof args.url === "string" && args.url) {
      return `url: "${args.url}"`;
    }
    const keys = Object.keys(args);
    if (keys.length) {
      return JSON.stringify(args);
    }
  }
  const trimmed = String(rawText || "").trim();
  return trimmed || `${name}()`;
}

function formatHeadlessPurpose(purpose) {
  if (purpose === "search") {
    return "Headless Browser · 검색 결과 수집";
  }
  if (typeof purpose === "string" && purpose.startsWith("search-")) {
    const num = purpose.slice("search-".length);
    return `Headless Browser · 병렬 검색 #${num}`;
  }
  if (typeof purpose === "string" && purpose.startsWith("result-")) {
    const num = purpose.slice("result-".length);
    return `Headless Browser · 상위 문서 #${num}`;
  }
  if (typeof purpose === "string" && purpose.startsWith("read-")) {
    const num = purpose.slice("read-".length);
    return `Headless Browser · 웹페이지 #${num}`;
  }
  return "Headless Browser · 웹페이지 열람";
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
  /(`[^`\n]+`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+)\*\*)|(__([^_\n]+)__)|(\*([^*\n]+)\*)/g;

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
  return (
    cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
  );
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

function renderMarkdown(container, markdown) {
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
      while (
        i < lines.length &&
        lines[i].trim() &&
        lines[i].includes("|")
      ) {
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

  container.replaceChildren(frag);
}

var AgentChatPage = {
  messages: [],
  request: null,
  retry: null,
  statusId: "agent-chat-disconnected",

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
    this.empty = document.getElementById("chat-empty");
    this.status = document.getElementById("chat-status");
    this.icon = document.getElementById("chat-icon");
    this.headlessMonitor = document.getElementById("chat-headless-monitor");
    this.headlessLabel = document.getElementById("chat-headless-label");
    this.headlessUrl = document.getElementById("chat-headless-url");
    this.effortControl = document.getElementById("chat-effort-control");
    this.effortSlider = document.getElementById("chat-effort-slider");
    this.effortValue = document.getElementById("chat-effort-value");

    if (this.effortSlider) {
      const updateEffortUI = () => {
        const level = Number(this.effortSlider.value) || 2;
        const labels = {
          1: "낮음 (1/3)",
          2: "보통 (2/3)",
          3: "높음 (3/3)",
        };
        if (this.effortControl) {
          this.effortControl.dataset.effortLevel = String(level);
        }
        if (this.effortValue) {
          this.effortValue.textContent = labels[level] || `${level}단계`;
        }
        for (const tick of document.querySelectorAll(
          ".chat-effort-ticks span[data-level]"
        )) {
          tick.classList.toggle(
            "is-active",
            Number(tick.dataset.level) === level
          );
        }
      };
      this.effortSlider.addEventListener("input", updateEffortUI);
      updateEffortUI();
    }

    this.form.addEventListener("submit", event => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener("input", () => this.updateAvailability());
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
    for (let suggestion of document.querySelectorAll(".chat-suggestion")) {
      suggestion.addEventListener("click", () => {
        this.input.value = suggestion.dataset.prompt;
        this.updateAvailability();
        this.input.focus();
      });
    }
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
    window.addEventListener("pageshow", () => {
      this.rebindWindow();
    });
    window.addEventListener("pagehide", () => {
      this.cancel();
      Services.prefs.removeObserver("browser.agent.apiKey", this.prefObserver);
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

  updateAvailability(statusId) {
    if (this.pending) {
      this.statusId = "agent-chat-responding";
    } else if (!this.agent) {
      this.statusId = "agent-chat-disconnected";
    } else if (statusId) {
      this.statusId = statusId;
    } else if (
      ["agent-chat-disconnected", "agent-chat-responding"].includes(
        this.statusId
      )
    ) {
      this.statusId = "agent-chat-ready";
    }
    document.l10n.setAttributes(this.status, this.statusId);
    this.sendButton.disabled = !this.canSend;
    this.newButton.disabled = !this.browserWindow?.CustomAgentChatUI?.enabled;
    this.sendButton.hidden = this.pending;
    this.stopButton.hidden = !this.pending;
    this.list.setAttribute("aria-busy", String(this.pending));
    let icon = this.pending
      ? "chrome://browser/content/custom-ui/resources/mono/animation/mono-glyph-spin-small.svg"
      : "chrome://browser/content/custom-ui/resources/mono/logo/mono-glyph-small.svg";
    if (this.icon.getAttribute("href") !== icon) {
      this.icon.setAttribute("href", icon);
    }
  },

  updateHeadlessMonitor(event) {
    if (!this.headlessMonitor) {
      return;
    }
    this.headlessMonitor.hidden = false;
    const activeCount = event.activeCount ?? 0;

    if (
      event.type === "headless_start" ||
      event.type === "headless_observing"
    ) {
      this.headlessMonitor.dataset.active = "true";
      const phaseLabel =
        event.type === "headless_start" ? "페이지 로딩 중" : "DOM 관찰 중";
      this.headlessLabel.textContent = `Headless Browser (${Math.max(1, activeCount)}) · ${phaseLabel}`;
      this.headlessUrl.textContent = event.url || "";
      return;
    }

    if (activeCount > 0) {
      this.headlessMonitor.dataset.active = "true";
      this.headlessLabel.textContent = `Headless Browser (${activeCount}) · 실행 중`;
    } else {
      this.headlessMonitor.dataset.active = "false";
      this.headlessLabel.textContent = "Headless Browser · 수집 완료";
      this.headlessUrl.textContent = event.title || event.url || "";
    }
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

  appendMessage(role, content) {
    let article = document.createElement("article");
    article.className = "chat-message";
    article.dataset.role = role;
    let author = document.createElement("div");
    author.className = "chat-message-author";
    document.l10n.setAttributes(author, `agent-chat-author-${role}`);
    let activity = null;
    if (role === "assistant") {
      activity = document.createElement("div");
      activity.className = "chat-message-activity";
      activity.hidden = true;
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
    this.empty.hidden = true;
    this.list.hidden = false;
    this.scrollToEnd();
    return { article, activity, body };
  },

  ensureThinkingCard(request, round = 0) {
    let existing = request.thinkingCards.get(round);
    if (existing) {
      return existing;
    }
    request.activity.hidden = false;
    let details = document.createElement("details");
    details.className = "chat-step-card chat-step-thinking";
    details.open = true;
    details.dataset.status = "running";
    details.dataset.round = String(round);

    let summary = document.createElement("summary");
    summary.className = "chat-step-header";

    let titleGroup = document.createElement("div");
    titleGroup.className = "chat-step-title-group";

    let badge = document.createElement("span");
    badge.className = "chat-step-badge";
    badge.textContent = "CoT";

    let title = document.createElement("span");
    title.className = "chat-step-title";
    title.textContent =
      round > 0 ? `Thinking (Step ${round + 1})` : "Thinking";

    titleGroup.append(badge, title);

    let status = document.createElement("span");
    status.className = "chat-step-status";
    status.textContent = "스트리밍 추론 중…";

    summary.append(titleGroup, status);

    let body = document.createElement("div");
    body.className = "chat-thinking-body";

    details.append(summary, body);
    request.activity.append(details);

    let card = { details, status, body, text: "" };
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

    request.activity.hidden = false;
    let container = document.createElement("div");
    container.className = "chat-step-card chat-step-tool";
    container.dataset.status = "running";
    container.dataset.toolName = name;

    let header = document.createElement("div");
    header.className = "chat-step-header";

    let titleGroup = document.createElement("div");
    titleGroup.className = "chat-step-title-group";

    let badge = document.createElement("span");
    badge.className = "chat-step-badge";
    badge.textContent = "Tool Call";

    let title = document.createElement("span");
    title.className = "chat-step-title";
    title.textContent = name || "tool";

    let subtitle = document.createElement("span");
    subtitle.className = "chat-step-subtitle";

    titleGroup.append(badge, title, subtitle);

    let status = document.createElement("span");
    status.className = "chat-step-status";
    status.textContent = "실행 중…";

    header.append(titleGroup, status);

    let headlessList = document.createElement("div");
    headlessList.className = "chat-headless-list";
    headlessList.hidden = true;

    let outputDetails = document.createElement("details");
    outputDetails.className = "chat-tool-output";
    outputDetails.hidden = true;

    let outputSummary = document.createElement("summary");
    outputSummary.textContent = "수집된 데이터 보기";

    let outputPre = document.createElement("pre");
    outputPre.className = "chat-tool-output-pre";

    outputDetails.append(outputSummary, outputPre);
    container.append(header, headlessList, outputDetails);
    request.activity.append(container);

    let card = {
      container,
      title,
      subtitle,
      status,
      headlessList,
      outputDetails,
      outputSummary,
      outputPre,
    };
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

    let toolCard =
      (event.toolCallId && request.toolCards.get(event.toolCallId)) ||
      request.lastToolCard;

    let parentList;
    if (toolCard) {
      toolCard.headlessList.hidden = false;
      parentList = toolCard.headlessList;
    } else {
      request.activity.hidden = false;
      parentList = request.activity;
    }

    let cardEl = document.createElement("div");
    cardEl.className = "chat-headless-card";
    cardEl.dataset.phase = "loading";

    let chrome = document.createElement("div");
    chrome.className = "chat-headless-chrome";

    let chromeLeft = document.createElement("div");
    chromeLeft.className = "chat-headless-chrome-left";

    let dots = document.createElement("span");
    dots.className = "chat-headless-window-dots";
    dots.append(
      document.createElement("span"),
      document.createElement("span"),
      document.createElement("span")
    );

    let purpose = document.createElement("span");
    purpose.className = "chat-headless-purpose";
    purpose.textContent = formatHeadlessPurpose(event.purpose);

    chromeLeft.append(dots, purpose);

    let phase = document.createElement("span");
    phase.className = "chat-headless-phase";
    phase.textContent = "페이지 로딩 중… (1280×2000)";

    chrome.append(chromeLeft, phase);

    let viewportBody = document.createElement("div");
    viewportBody.className = "chat-headless-viewport-body";

    let address = document.createElement("div");
    address.className = "chat-headless-address";
    address.textContent = event.url || "";

    let pageTitle = document.createElement("div");
    pageTitle.className = "chat-headless-page-title";
    pageTitle.hidden = true;

    let metrics = document.createElement("div");
    metrics.className = "chat-headless-metrics";
    metrics.hidden = true;

    viewportBody.append(address, pageTitle, metrics);
    cardEl.append(chrome, viewportBody);
    parentList.append(cardEl);

    let card = { cardEl, purpose, phase, address, pageTitle, metrics };
    request.headlessCards.set(event.browserId, card);
    return card;
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
    details.open = true;

    let summary = document.createElement("summary");
    summary.className = "chat-step-header";

    let titleGroup = document.createElement("div");
    titleGroup.className = "chat-step-title-group";

    let badge = document.createElement("span");
    badge.className = "chat-step-badge";
    badge.textContent = "Debug";

    let title = document.createElement("span");
    title.className = "chat-step-title";
    title.textContent = "단계별 소요 시간 및 토큰 사용량";

    let subtitle = document.createElement("span");
    subtitle.className = "chat-step-subtitle";
    subtitle.textContent = metrics.model ? `model: ${metrics.model}` : "";

    titleGroup.append(badge, title, subtitle);

    let totals = metrics.totals || {};
    let status = document.createElement("span");
    status.className = "chat-step-status";
    status.textContent = `총 ${formatDurationMs(metrics.totalDurationMs)} · ${formatTokenCount(totals.totalTokens ?? 0)} tokens`;

    summary.append(titleGroup, status);

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
    tdFootLabel.textContent = "합계 (Total)";

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

    table.append(thead, tbody, tfoot);
    wrap.append(table);
    details.append(summary, wrap);
    request.article.append(details);
    request.debugCard = details;
  },

  handleAgentEvent(request, event) {
    if (this.request !== request || !event || typeof event !== "object") {
      return;
    }
    let atEnd =
      this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight <
      80;

    switch (event.type) {
      case "thinking_start": {
        this.ensureThinkingCard(request, event.round ?? 0);
        break;
      }
      case "thinking_delta": {
        if (typeof event.delta !== "string" || !event.delta) {
          break;
        }
        let card = this.ensureThinkingCard(request, event.round ?? 0);
        card.text += event.delta;
        card.body.textContent = card.text;
        card.body.scrollTop = card.body.scrollHeight;
        break;
      }
      case "thinking_done": {
        let card = request.thinkingCards.get(event.round ?? 0);
        if (card) {
          card.details.dataset.status = "done";
          card.status.textContent = `추론 완료 (${card.text.length.toLocaleString()}자)`;
        }
        break;
      }
      case "tool_call_delta": {
        let card = this.ensureToolCard(request, event);
        if (event.name) {
          card.title.textContent = event.name;
          card.container.dataset.toolName = event.name;
        }
        if (event.argumentsText) {
          card.subtitle.textContent = event.argumentsText;
        }
        card.status.textContent = "도구 호출 생성 중…";
        break;
      }
      case "tab_title": {
        if (event.title) {
          this.setTabTitle(event.title);
        }
        break;
      }
      case "tool_call_start": {
        if ((event.round ?? 0) === 0 && event.args?.tabTitle) {
          this.setTabTitle(event.args.tabTitle);
        }
        let card = this.ensureToolCard(request, event);
        if (event.name) {
          card.title.textContent = event.name;
          card.container.dataset.toolName = event.name;
        }
        card.subtitle.textContent = formatToolArgsPreview(
          event.name,
          event.args,
          event.argumentsText
        );
        card.container.dataset.status = "running";
        card.status.textContent = "실행 중…";
        break;
      }
      case "tool_call_done": {
        let card = this.ensureToolCard(request, event);
        card.subtitle.textContent = formatToolArgsPreview(
          event.name,
          event.args
        );
        card.container.dataset.status = event.isError ? "error" : "done";
        const sec = ((event.durationMs ?? 0) / 1000).toFixed(1);
        card.status.textContent = event.isError
          ? `오류 (${sec}s)`
          : `완료 (${sec}s)`;
        if (typeof event.output === "string" && event.output) {
          card.outputDetails.hidden = false;
          const ds = event.dedupStats;
          const badgeParts = [];
          if (ds?.headlessConcurrency) {
            badgeParts.push(`동적 Headless ${ds.headlessConcurrency}개`);
          }
          if (ds?.earlyStoppedCount > 0) {
            badgeParts.push(`조기 종료 ${ds.earlyStoppedCount}개`);
          }
          if (ds && (ds.removedParagraphs > 0 || ds.skippedDuplicateUrls > 0)) {
            badgeParts.push(
              `중복 문단 ${ds.removedParagraphs || 0}개 / 중복 URL ${ds.skippedDuplicateUrls || 0}건 제거`
            );
          }
          const dedupBadge = badgeParts.length
            ? ` · ${badgeParts.join(" · ")}`
            : "";
          card.outputSummary.textContent = `수집된 컨텍스트 보기 (${event.output.length.toLocaleString()}자${dedupBadge})`;
          card.outputPre.textContent = event.output;
        }
        break;
      }
      case "headless_start": {
        this.updateHeadlessMonitor(event);
        let hCard = this.ensureHeadlessCard(request, event);
        hCard.cardEl.dataset.phase = "loading";
        hCard.address.textContent = event.url || "";
        hCard.phase.textContent = "페이지 로딩 중… (1280×2000)";
        break;
      }
      case "headless_observing": {
        this.updateHeadlessMonitor(event);
        let hCard = this.ensureHeadlessCard(request, event);
        hCard.cardEl.dataset.phase = "observing";
        if (event.url) {
          hCard.address.textContent = event.url;
        }
        hCard.phase.textContent = "DOM 관찰 및 본문 추출 중…";
        break;
      }
      case "headless_done": {
        this.updateHeadlessMonitor(event);
        let hCard = this.ensureHeadlessCard(request, event);
        hCard.cardEl.dataset.phase = "done";
        if (event.url) {
          hCard.address.textContent = event.url;
        }
        const sec = ((event.durationMs ?? 0) / 1000).toFixed(1);
        hCard.phase.textContent = `수집 완료 (${sec}s)`;
        if (event.title) {
          hCard.pageTitle.hidden = false;
          hCard.pageTitle.textContent = event.title;
        }
        hCard.metrics.hidden = false;
        hCard.metrics.textContent = `본문 ${(event.textLength ?? 0).toLocaleString()}자 추출 · 링크 ${event.linkCount ?? 0}개 발견`;
        break;
      }
      case "headless_error": {
        this.updateHeadlessMonitor(event);
        let hCard = this.ensureHeadlessCard(request, event);
        hCard.cardEl.dataset.phase = "error";
        const sec = ((event.durationMs ?? 0) / 1000).toFixed(1);
        hCard.phase.textContent = event.earlyStopped
          ? `지연 건너뜀 · 조기 종료 (${sec}s)`
          : event.timedOut
            ? `지연 건너뜀 (${sec}s)`
            : "로드 실패";
        hCard.metrics.hidden = false;
        hCard.metrics.textContent = event.error || "오류가 발생했습니다.";
        break;
      }
      case "chat_metrics": {
        this.renderDebugMetrics(request, event.metrics);
        break;
      }
    }

    if (atEnd) {
      this.scrollToEnd();
    }
  },

  setTabTitle(rawTitle) {
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
        tab.setAttribute("label", clean);
        tab.setAttribute("visibleLabel", clean);
        gBrowser.setTabTitle(tab);
      }
    }
  },

  scrollToEnd() {
    this.list.scrollTop = this.list.scrollHeight;
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
      this.retry.response.article.remove();
    } else {
      userMessage = { role: "user", content: query };
      this.messages.push(userMessage);
      this.appendMessage("user", query);
    }
    this.retry = null;
    this.input.value = "";
    let response = this.appendMessage("assistant", "");
    response.article.dataset.pending = "true";
    document.l10n.setAttributes(response.body, "agent-chat-pending-message");
    let request = {
      ...response,
      agent,
      text: "",
      thinkingCards: new Map(),
      toolCards: new Map(),
      headlessCards: new Map(),
      lastToolCard: null,
      debugCard: null,
      controller: new AbortController(),
    };
    this.request = request;
    this.updateAvailability();
    this.input.focus();
    try {
      let answer = await agent.chat({
        conversationId: this.conversationId,
        messages: this.messages.map(message => ({ ...message })),
        signal: request.controller.signal,
        onEvent: event => this.handleAgentEvent(request, event),
        onDelta: delta => {
          if (this.request !== request || typeof delta !== "string") {
            return;
          }
          let atEnd =
            this.list.scrollHeight -
              this.list.scrollTop -
              this.list.clientHeight <
            80;
          request.text += delta;
          request.body.removeAttribute("data-l10n-id");
          renderMarkdown(request.body, request.text);
          if (atEnd) {
            this.scrollToEnd();
          }
        },
      });
      if (this.request !== request) {
        return;
      }
      if (answer !== undefined && typeof answer !== "string") {
        throw new TypeError("Agent chat must return text or stream a response");
      }
      let content = typeof answer === "string" ? answer : request.text;
      if (!content.trim()) {
        request.article.remove();
        this.request = null;
        this.input.value ||= query;
        this.retry = { message: userMessage, response: request };
        this.updateAvailability("agent-chat-empty-response");
        return;
      }
      request.body.removeAttribute("data-l10n-id");
      renderMarkdown(request.body, content);
      delete request.article.dataset.pending;
      this.playFinished(request.article);
      this.messages.push({ role: "assistant", content });
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
      this.updateAvailability("agent-chat-error");
      console.error("Agent chat request failed", error);
    }
  },

  finishInterrupted(request) {
    if (!request.text) {
      request.article.remove();
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
