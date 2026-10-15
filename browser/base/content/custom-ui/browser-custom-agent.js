/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const CUSTOM_AGENT_SVG_NS = "http://www.w3.org/2000/svg";
const CUSTOM_AGENT_LABEL_CLEARANCE = 34;

/**
 * Shows what an agent is doing in a tab: sidebar tab rows, the bottom-right
 * orb and its bubble, and the Run entry points. The agent is not part of this
 * file. It connects with `connect({ run, stop, resume, approve, takeOver })`
 * and reports progress with `setState(tab, state)`.
 *
 * State fields: status ("working", "confirm", "paused", "done"), title,
 * summary, step, totalSteps, elapsedMs, confirm { title, detail, handoff }
 * and result { headline, steps, durationMs, pathSaved }. A confirm with
 * handoff set asks the user to take over instead of approving.
 *
 * `showNextClick(tab, { x, y, width, height, radius })` marks the element the
 * agent clicks next, in page CSS pixels. The mark goes away when the state
 * leaves "working" or `hideNextClick(tab)` is called.
 */
var CustomAgentUI = {
  mockPref: "browser.customUI.agentMock",
  bubbleTimeoutMs: 5000,
  tickIntervalMs: 100,
  doneGraceMs: 1500,
  statuses: ["working", "confirm", "paused", "done"],

  agent: null,
  states: new WeakMap(),
  parts: new WeakMap(),
  nextClicks: new WeakMap(),
  bubbleTimer: 0,
  tickTimer: 0,
  pointerInside: false,
  focusInside: false,

  get enabled() {
    return document.documentElement.hasAttribute("custom-ui");
  },

  get canRun() {
    return !!this.agent;
  },

  init() {
    this.hud = document.getElementById("custom-agent-hud");
    this.bubble = document.getElementById("custom-agent-bubble");
    this.orb = document.getElementById("custom-agent-orb");
    this.bubbleTitle = document.getElementById("custom-agent-bubble-title");
    this.bubbleDetail = document.getElementById("custom-agent-bubble-detail");
    this.announcer = document.getElementById("custom-agent-announce");
    this.runButton = document.getElementById("custom-newtab-run");
    this.marker = document.getElementById("custom-agent-marker");
    this.markerTarget = this.marker.querySelector(
      ".custom-agent-marker-target"
    );
    this.buttons = {
      stop: document.getElementById("custom-agent-stop"),
      approve: document.getElementById("custom-agent-approve"),
      takeOver: document.getElementById("custom-agent-takeover"),
      resume: document.getElementById("custom-agent-resume"),
    };

    this.orb.addEventListener("click", this);
    for (let button of Object.values(this.buttons)) {
      button.addEventListener("click", this);
    }
    for (let type of ["mouseenter", "mouseleave", "focusin", "focusout"]) {
      this.hud.addEventListener(type, this);
    }
    this.hud.addEventListener("keydown", this);
    this.runButton.addEventListener("click", this);
    gURLBar.inputField.addEventListener("input", this);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    gBrowser.tabContainer.addEventListener("TabClose", this);
    this.progressListener = {
      onLocationChange: (browser, webProgress, request, location, flags) => {
        this.onLocationChange(browser, webProgress, flags);
      },
    };
    gBrowser.addTabsProgressListener(this.progressListener);
    Services.prefs.addObserver(this.mockPref, this);
    window.addEventListener("unload", this, { once: true });

    try {
      ChromeUtils.importESModule(
        "chrome://browser/content/custom-ui/custom-urlbar-run.sys.mjs"
      ).ensureRegistered();
    } catch (e) {
      console.error(e);
    }
    this.urlbarObserver = new MutationObserver(() => this.syncUrlbarOpen());
    this.urlbarObserver.observe(gURLBar, {
      attributes: true,
      attributeFilter: ["open"],
    });

    this.updateMock();
    this.updateRunButton();
    this.render();
  },

  observe() {
    this.updateMock();
  },

  updateMock() {
    let mock = Services.prefs.getBoolPref(this.mockPref, false);
    if (mock && !this.agent) {
      this.connect(this.mockAgent);
    } else if (!mock && this.agent === this.mockAgent) {
      this.disconnect();
    }
  },

  connect(agent) {
    this.agent = agent;
    this.updateRunButton();
  },

  disconnect() {
    this.agent = null;
    this.updateRunButton();
  },

  hasState(tab) {
    return this.states.has(tab);
  },

  getState(tab) {
    return this.states.get(tab) ?? null;
  },

  elapsedMs(state) {
    let running = state.runningSince ? Date.now() - state.runningSince : 0;
    return state.baseMs + running;
  },

  progress(state) {
    if (state.status === "done" || state.status === "confirm") {
      return 100;
    }
    if (!state.totalSteps) {
      return 0;
    }
    return Math.round(Math.min(1, state.step / state.totalSteps) * 100);
  },

  setState(tab, update) {
    let previous = this.states.get(tab);
    let status = update.status ?? previous?.status ?? "working";
    if (!this.statuses.includes(status)) {
      console.error(`Unknown agent status: ${status}`);
      return;
    }
    let now = Date.now();
    let baseMs = previous?.baseMs ?? 0;
    if (previous?.runningSince) {
      baseMs += now - previous.runningSince;
    }
    if (typeof update.elapsedMs === "number") {
      baseMs = update.elapsedMs;
    }
    let state = {
      step: 0,
      totalSteps: 0,
      summary: "",
      ...previous,
      ...update,
      status,
      baseMs,
      runningSince: status === "working" ? now : null,
      pausedReason:
        status === "paused" ? (update.pausedReason ?? "manual") : null,
    };
    delete state.elapsedMs;
    state.title ||= tab.label;
    if (status === "done") {
      state.finishedAt =
        previous?.status === "done" ? previous.finishedAt : now;
      state.seen =
        previous?.status === "done"
          ? previous.seen
          : tab === gBrowser.selectedTab;
      state.result = {
        headline: "",
        steps: state.step,
        durationMs: baseMs,
        pathSaved: false,
        ...state.result,
      };
    } else {
      state.seen = false;
    }
    if (status !== "working") {
      this.nextClicks.delete(tab);
    }
    this.states.set(tab, state);
    this.decorate(tab);
    if (tab === gBrowser.selectedTab) {
      this.render({ announce: previous?.status !== status });
      CustomBrowserUI.updateNewTab();
    }
  },

  clearState(tab) {
    this.nextClicks.delete(tab);
    if (!this.states.delete(tab)) {
      return;
    }
    this.decorate(tab);
    if (tab === gBrowser.selectedTab) {
      this.render();
      CustomBrowserUI.updateNewTab();
    }
  },

  run(query) {
    query = query?.trim();
    if (!query || !this.agent) {
      return null;
    }
    let tab = gBrowser.selectedTab;
    if (!document.documentElement.hasAttribute("custom-newtab")) {
      tab = gBrowser.addTrustedTab("about:blank");
      gBrowser.selectedTab = tab;
    }
    gURLBar.handleRevert();
    gURLBar.view.close();
    this.setState(tab, { status: "working", title: query, step: 0 });
    this.agent.run({ query, tab });
    return tab;
  },

  signal(type, tab = gBrowser.selectedTab) {
    let state = this.states.get(tab);
    if (!state) {
      return;
    }
    let update = {
      stop: { status: "paused", pausedReason: "stop" },
      takeOver: { status: "paused", pausedReason: "manual" },
      resume: { status: "working" },
      approve: { status: "working", confirm: null },
    }[type];
    this.setState(tab, update);
    this.agent?.[type]?.(tab, state);
  },

  showNextClick(tab, target) {
    this.nextClicks.set(tab, target);
    if (tab === gBrowser.selectedTab) {
      this.renderMarker();
    }
  },

  hideNextClick(tab) {
    if (this.nextClicks.delete(tab) && tab === gBrowser.selectedTab) {
      this.renderMarker();
    }
  },

  renderMarker() {
    let tab = gBrowser.selectedTab;
    let target = this.nextClicks.get(tab);
    let visible = !!target && this.states.get(tab)?.status === "working";
    this.marker.toggleAttribute("data-visible", visible);
    if (!visible) {
      return;
    }
    let { linkedBrowser: browser } = tab;
    let area = browser.getBoundingClientRect();
    let zoom = browser.fullZoom || 1;
    let { x, y, width, height, radius = 17 } = target;
    let { style } = this.marker;
    style.left = `${area.x}px`;
    style.top = `${area.y}px`;
    style.width = `${area.width}px`;
    style.height = `${area.height}px`;
    let box = this.markerTarget.style;
    box.left = `${x * zoom}px`;
    box.top = `${y * zoom}px`;
    box.width = `${width * zoom}px`;
    box.height = `${height * zoom}px`;
    box.borderRadius = `${Math.min(radius, width / 2, height / 2) * zoom}px`;
    this.markerTarget.toggleAttribute(
      "data-label-below",
      y * zoom < CUSTOM_AGENT_LABEL_CLEARANCE
    );
  },

  onLocationChange(browser, webProgress, flags) {
    if (
      !webProgress.isTopLevel ||
      flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
    ) {
      return;
    }
    let tab = gBrowser.getTabForBrowser(browser);
    let state = tab && this.states.get(tab);
    if (
      state?.status === "done" &&
      state.seen &&
      Date.now() - state.finishedAt > this.doneGraceMs
    ) {
      this.clearState(tab);
    }
  },

  syncUrlbarOpen() {
    this.runButton.toggleAttribute("urlbar-open", gURLBar.hasAttribute("open"));
  },

  updateRunButton() {
    if (!this.runButton) {
      return;
    }
    this.runButton.disabled = !this.agent || !gURLBar.value.trim();
    document.l10n.setAttributes(
      this.runButton,
      this.agent ? "custom-ui-run" : "custom-ui-run-unavailable"
    );
  },

  element(tag, className) {
    let element = document.createElement(tag);
    element.className = className;
    return element;
  },

  svg(tag, attributes) {
    let element = document.createElementNS(CUSTOM_AGENT_SVG_NS, tag);
    for (let [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    return element;
  },

  setText(element, text) {
    element.removeAttribute("data-l10n-id");
    element.removeAttribute("data-l10n-args");
    if (element.textContent !== text) {
      element.textContent = text;
    }
  },

  applySpec(element, spec) {
    if (spec.id) {
      document.l10n.setAttributes(element, spec.id, spec.args);
    } else {
      this.setText(element, spec.text ?? "");
    }
  },

  resolveSpec(spec) {
    return spec.id
      ? document.l10n.formatValue(spec.id, spec.args)
      : Promise.resolve(spec.text ?? "");
  },

  seconds(state) {
    return (this.elapsedMs(state) / 1000).toFixed(1);
  },

  pausedTitleId(state) {
    return state.pausedReason === "stop"
      ? "custom-ui-agent-stopped-title"
      : "custom-ui-agent-paused-title";
  },

  countText(state) {
    return state.totalSteps ? `${state.step}/${state.totalSteps}` : "";
  },

  bubbleSpec(state) {
    let seconds = this.seconds(state);
    let { step, totalSteps: total } = state;
    switch (state.status) {
      case "confirm":
        return {
          title: { text: state.confirm?.title },
          detail: { text: state.confirm?.detail },
        };
      case "paused":
        return {
          title: { id: this.pausedTitleId(state) },
          detail: {
            id: total
              ? "custom-ui-agent-paused-detail"
              : "custom-ui-agent-paused-detail-open",
            args: { step, total },
          },
        };
      case "done": {
        let { headline, steps, pathSaved } = state.result;
        return {
          title: headline
            ? { id: "custom-ui-agent-done-title", args: { headline } }
            : { id: "custom-ui-agent-done-title-plain" },
          detail: {
            id: pathSaved
              ? "custom-ui-agent-done-detail-saved"
              : "custom-ui-agent-done-detail",
            args: { steps, seconds },
          },
        };
      }
      default:
        return {
          title: { text: state.summary || state.title },
          detail: {
            id: total
              ? "custom-ui-agent-progress"
              : "custom-ui-agent-progress-open",
            args: { step, total, seconds },
          },
        };
    }
  },

  rowSummarySpec(state) {
    switch (state.status) {
      case "confirm":
        return { text: state.confirm?.title };
      case "paused":
        return { id: this.pausedTitleId(state) };
      case "done":
        return state.result.headline
          ? {
              id: "custom-ui-agent-done-summary",
              args: {
                headline: state.result.headline,
                seconds: this.seconds(state),
              },
            }
          : {
              id: "custom-ui-agent-done-summary-plain",
              args: { seconds: this.seconds(state) },
            };
      default:
        return { text: state.summary };
    }
  },

  tabLabelSpec(state) {
    let args = {
      title: state.title,
      step: state.step,
      total: state.totalSteps,
    };
    switch (state.status) {
      case "confirm":
        return { id: "custom-ui-agent-tab-confirm", args };
      case "paused":
        return { id: "custom-ui-agent-tab-paused", args };
      case "done":
        return { id: "custom-ui-agent-tab-done", args };
      default:
        return {
          id: state.totalSteps
            ? "custom-ui-agent-tab-working"
            : "custom-ui-agent-tab-working-open",
          args,
        };
    }
  },

  createRing() {
    let ring = this.element("span", "custom-agent-ring");
    ring.setAttribute("aria-hidden", "true");
    let svg = this.svg("svg", { viewBox: "0 0 24 24" });
    svg.append(
      this.svg("circle", {
        class: "custom-agent-ring-track",
        cx: 12,
        cy: 12,
        r: 11,
      }),
      this.svg("circle", {
        class: "custom-agent-ring-value",
        cx: 12,
        cy: 12,
        r: 11,
        pathLength: 100,
      }),
      this.svg("circle", {
        class: "custom-agent-ring-fill",
        cx: 12,
        cy: 12,
        r: 10,
      }),
      this.svg("path", {
        class: "custom-agent-ring-check",
        d: "M7.3 12.3 L10.7 15.3 L16.7 9.1",
      }),
      this.svg("path", {
        class: "custom-agent-ring-alert",
        d: "M12 7.5 V13 M12 16.6 V16.6",
      }),
      this.svg("circle", {
        class: "custom-agent-ring-dot",
        cx: 20.5,
        cy: 3.5,
        r: 3.8,
      })
    );
    ring.append(svg);
    return ring;
  },

  ensureParts(tab) {
    let parts = this.parts.get(tab);
    if (parts) {
      return parts;
    }
    let iconStack = tab.querySelector(".tab-icon-stack");
    let labelContainer = tab.querySelector(".tab-label-container");
    if (!iconStack || !labelContainer) {
      return null;
    }
    parts = {
      title: this.element("span", "custom-agent-title"),
      summary: this.element("span", "custom-agent-summary"),
      trail: this.element("span", "custom-agent-trail"),
      count: this.element("span", "custom-agent-count"),
      stop: this.element("button", "custom-agent-stop"),
      confirm: this.element("span", "custom-agent-confirm"),
      done: this.element("span", "custom-agent-done"),
    };
    parts.stop.type = "button";
    parts.stop.tabIndex = -1;
    parts.stop.append(this.element("span", "custom-agent-stop-glyph"));
    document.l10n.setAttributes(parts.stop, "custom-ui-agent-stop");
    document.l10n.setAttributes(parts.confirm, "custom-ui-agent-confirm-label");
    document.l10n.setAttributes(parts.done, "custom-ui-agent-done-label");
    parts.confirm.setAttribute("aria-hidden", "true");
    parts.done.setAttribute("aria-hidden", "true");
    parts.count.setAttribute("aria-hidden", "true");
    parts.trail.append(parts.count, parts.stop, parts.confirm, parts.done);
    parts.stop.addEventListener("click", event => {
      event.stopPropagation();
      this.signal("stop", tab);
    });
    parts.stop.addEventListener("mousedown", event => event.stopPropagation());
    iconStack.append(this.createRing());
    labelContainer.append(parts.title, parts.summary);
    labelContainer.after(parts.trail);
    this.parts.set(tab, parts);
    return parts;
  },

  decorate(tab) {
    let state = this.states.get(tab);
    let visible = state && !(state.status === "done" && state.seen);
    if (!visible) {
      tab.removeAttribute("custom-agent-state");
      tab.removeAttribute("custom-agent-indeterminate");
      tab.style.removeProperty("--custom-agent-progress");
      if (this.parts.has(tab)) {
        tab.removeAttribute("aria-label");
      }
      return;
    }
    let parts = this.ensureParts(tab);
    if (!parts) {
      return;
    }
    tab.setAttribute("custom-agent-state", state.status);
    tab.toggleAttribute(
      "custom-agent-indeterminate",
      state.status === "working" && !state.totalSteps
    );
    tab.style.setProperty("--custom-agent-progress", this.progress(state));
    this.setText(parts.title, state.title);
    this.applySpec(parts.summary, this.rowSummarySpec(state));
    this.setText(parts.count, this.countText(state));
    this.resolveSpec(this.tabLabelSpec(state)).then(label => {
      if (this.states.get(tab) === state) {
        tab.setAttribute("aria-label", label);
      }
    });
  },

  render({ announce = false } = {}) {
    this.renderMarker();
    let state = this.states.get(gBrowser.selectedTab);
    this.hud.hidden = !state;
    if (!state) {
      this.closeBubble();
      return;
    }
    let { status } = state;
    this.hud.dataset.status = status;
    let indeterminate = status === "working" && !state.totalSteps;
    let progress = this.progress(state);
    this.hud.toggleAttribute("data-indeterminate", indeterminate);
    this.hud.toggleAttribute("data-empty", progress === 0 && !indeterminate);
    this.hud.style.setProperty("--custom-agent-progress", progress);
    this.buttons.stop.hidden = status !== "working";
    let handoff = status === "confirm" && !!state.confirm?.handoff;
    this.buttons.approve.hidden = status !== "confirm" || handoff;
    this.buttons.takeOver.hidden = status !== "confirm";
    this.buttons.takeOver.classList.toggle(
      "custom-agent-action-primary",
      handoff
    );
    document.l10n.setAttributes(
      this.buttons.takeOver,
      handoff ? "custom-ui-agent-handoff" : "custom-ui-agent-takeover"
    );
    this.buttons.resume.hidden = status !== "paused";

    let spec = this.bubbleSpec(state);
    this.applySpec(this.bubbleTitle, spec.title);
    this.applySpec(this.bubbleDetail, spec.detail);
    if (announce) {
      Promise.all([
        this.resolveSpec(spec.title),
        this.resolveSpec(spec.detail),
      ]).then(([title, detail]) => {
        this.announcer.textContent = [title, detail].filter(Boolean).join(". ");
      });
    }
    this.openBubble();
  },

  openBubble() {
    this.hud.toggleAttribute("bubble-open", true);
    this.scheduleBubbleClose();
    this.syncTick();
  },

  closeBubble() {
    clearTimeout(this.bubbleTimer);
    this.hud.toggleAttribute("bubble-open", false);
    this.syncTick();
  },

  scheduleBubbleClose() {
    clearTimeout(this.bubbleTimer);
    let state = this.states.get(gBrowser.selectedTab);
    if (
      this.pointerInside ||
      this.focusInside ||
      !state ||
      state.status === "confirm"
    ) {
      return;
    }
    this.bubbleTimer = setTimeout(
      () => this.closeBubble(),
      this.bubbleTimeoutMs
    );
  },

  syncTick() {
    let state = this.states.get(gBrowser.selectedTab);
    let ticking =
      state?.status === "working" && this.hud.hasAttribute("bubble-open");
    if (ticking && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
    } else if (!ticking && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = 0;
    }
  },

  tick() {
    let state = this.states.get(gBrowser.selectedTab);
    if (state?.status === "working") {
      this.applySpec(this.bubbleDetail, this.bubbleSpec(state).detail);
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "click":
        this.onClick(event);
        break;
      case "mouseenter":
      case "mouseleave":
        this.pointerInside = event.type === "mouseenter";
        this.scheduleBubbleClose();
        break;
      case "focusin":
      case "focusout":
        this.focusInside =
          event.type === "focusin" || this.hud.contains(event.relatedTarget);
        this.scheduleBubbleClose();
        break;
      case "keydown":
        if (
          event.key === "Escape" &&
          this.hud.hasAttribute("bubble-open") &&
          this.bubble.contains(event.target)
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.orb.focus();
          this.closeBubble();
        }
        break;
      case "input":
        this.updateRunButton();
        break;
      case "TabSelect": {
        let state = this.states.get(event.target);
        if (state?.status === "done" && !state.seen) {
          state.seen = true;
          this.decorate(event.target);
        }
        this.updateRunButton();
        this.render();
        break;
      }
      case "TabClose":
        this.onTabClose(event.target);
        break;
      case "unload":
        Services.prefs.removeObserver(this.mockPref, this);
        gBrowser.tabContainer.removeEventListener("TabSelect", this);
        gBrowser.tabContainer.removeEventListener("TabClose", this);
        gBrowser.removeTabsProgressListener(this.progressListener);
        this.urlbarObserver.disconnect();
        clearTimeout(this.bubbleTimer);
        clearInterval(this.tickTimer);
        break;
    }
  },

  onClick(event) {
    let { currentTarget: target } = event;
    if (target === this.orb) {
      CustomBrowserUI.setPanelOpen(true);
    } else if (target === this.runButton) {
      this.run(gURLBar.value);
    } else {
      for (let [type, button] of Object.entries(this.buttons)) {
        if (target === button) {
          this.signal(type);
        }
      }
    }
  },

  onTabClose(tab) {
    let state = this.states.get(tab);
    if (!state) {
      return;
    }
    this.states.delete(tab);
    this.nextClicks.delete(tab);
    if (state.status === "working" || state.status === "confirm") {
      this.agent?.stop?.(tab, state);
    }
  },

  mockAgent: {
    steps: [
      "검색 결과 읽는 중",
      "필터 적용 중",
      "날짜별 최저가로 정렬하는 중",
      "결제 직전 화면 확인 중",
      "결과 정리 중",
    ],
    confirmStep: 4,
    delayMs: 1200,
    runs: new WeakMap(),
    spots: [
      [0.2, 0.18],
      [0.45, 0.3],
      [0.3, 0.45],
      [0.55, 0.55],
      [0.38, 0.7],
    ],

    run({ tab }) {
      this.runs.set(tab, { step: 0, approved: false, timer: 0 });
      this.advance(tab, 1);
    },

    target(tab, step) {
      let { linkedBrowser: browser } = tab;
      let { width, height } = browser.getBoundingClientRect();
      let zoom = browser.fullZoom || 1;
      let [x, y] = this.spots[(step - 1) % this.spots.length];
      return {
        x: Math.round((width / zoom) * x),
        y: Math.round((height / zoom) * y),
        width: 150,
        height: 34,
      };
    },

    advance(tab, step) {
      let run = this.runs.get(tab);
      if (!run) {
        return;
      }
      clearTimeout(run.timer);
      run.step = step;
      let totalSteps = this.steps.length;
      if (step > totalSteps) {
        this.runs.delete(tab);
        CustomAgentUI.setState(tab, {
          status: "done",
          step: totalSteps,
          totalSteps,
          summary: "",
          result: {
            headline: "조건에 맞는 목록까지 왔어요",
            steps: totalSteps,
            pathSaved: true,
          },
        });
        return;
      }
      let summary = this.steps[step - 1];
      if (step === this.confirmStep && !run.approved) {
        CustomAgentUI.setState(tab, {
          status: "confirm",
          step,
          totalSteps,
          summary,
          confirm: {
            title: "결제 직전이에요",
            detail: "총 378,000원 · 이대로 진행할까요?",
          },
        });
        return;
      }
      CustomAgentUI.setState(tab, {
        status: "working",
        step,
        totalSteps,
        summary,
      });
      CustomAgentUI.showNextClick(tab, this.target(tab, step));
      run.timer = setTimeout(() => this.advance(tab, step + 1), this.delayMs);
    },

    stop(tab) {
      let run = this.runs.get(tab);
      if (run) {
        clearTimeout(run.timer);
      }
    },

    takeOver(tab) {
      this.stop(tab);
    },

    resume(tab) {
      let run = this.runs.get(tab);
      if (run) {
        this.advance(tab, run.step);
      }
    },

    approve(tab) {
      let run = this.runs.get(tab);
      if (run) {
        run.approved = true;
        this.advance(tab, run.step);
      }
    },
  },
};

delayedStartupPromise.then(() => CustomAgentUI.init());
