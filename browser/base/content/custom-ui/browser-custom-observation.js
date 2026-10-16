/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global CustomizableUI, delayedStartupPromise, gBrowser, PanelMultiView, PanelUI */

var CustomObservationUI = {
  session: null,
  browser: null,
  result: null,
  requestId: 0,
  selectedHandle: null,
  pending: false,
  mode: "action",

  init() {
    this.panel = document.getElementById("custom-observation-panel");
    this.closeButton = document.getElementById("custom-observation-close");
    this.toggleButton = document.getElementById("custom-observation-toggle");
    this.refreshButton = document.getElementById("custom-observation-refresh");
    this.modesContainer = document.getElementById("custom-observation-modes");
    this.modeButtons = Array.from(
      this.modesContainer?.querySelectorAll("button[data-mode]") || []
    );
    this.status = document.getElementById("custom-observation-status");
    this.summary = document.getElementById("custom-observation-summary");
    this.list = document.getElementById("custom-observation-list");

    let menuBody = PanelMultiView.getViewNode(
      document,
      "appmenu-moreTools"
    ).querySelector(".panel-subview-body");
    if (!document.getElementById("custom-observation-menuitem")) {
      let menuItem = document.createXULElement("toolbarbutton");
      menuItem.id = "custom-observation-menuitem";
      menuItem.className = "subviewbutton";
      menuItem.setAttribute("data-l10n-id", "agent-observation-toolbar");
      menuItem.addEventListener("command", () => {
        PanelUI.hide();
        this.togglePanel();
      });
      menuBody.querySelector("toolbarseparator").before(menuItem);
    }

    this.closeButton.addEventListener("click", this);
    this.toggleButton.addEventListener("click", this);
    this.refreshButton.addEventListener("click", this);
    for (let button of this.modeButtons) {
      button.addEventListener("click", this);
    }
    this.panel.addEventListener("keydown", this);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    gBrowser.tabContainer.addEventListener("TabClose", this);
    this.progressListener = {
      onLocationChange: (browser, webProgress) => {
        if (!webProgress.isTopLevel || browser !== gBrowser.selectedBrowser) {
          return;
        }
        if (!this.canObserve(browser) && this.browser === browser) {
          this.clearSession().then(() => this.updateAvailability());
          return;
        }
        this.updateAvailability();
      },
    };
    gBrowser.addTabsProgressListener(this.progressListener);
    window.addEventListener("unload", this, { once: true });
    this.updateAvailability();
  },

  canObserve(browser = gBrowser.selectedBrowser) {
    return /^(https?|file):/i.test(browser.currentURI?.spec ?? "");
  },

  togglePanel() {
    this.setPanelOpen(this.panel.hidden);
  },

  setPanelOpen(open, restoreFocus = true) {
    open = !!open;
    let wasOpen = !this.panel.hidden;
    this.panel.hidden = !open;
    document.documentElement.toggleAttribute("custom-observation-open", open);
    if (open) {
      this.closeButton.focus();
    } else if (wasOpen && restoreFocus) {
      gBrowser.selectedBrowser.focus();
    }
    if (!open && wasOpen) {
      this.clearSession().then(() => this.updateAvailability());
    }
  },

  async setMode(mode) {
    if (!["action", "context", "translation"].includes(mode) || this.mode === mode) {
      return;
    }
    this.mode = mode;
    for (let button of this.modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    this.selectedHandle = null;
    if (this.result) {
      this.render();
    }
    if (this.session && this.result && !this.pending) {
      let requestId = ++this.requestId;
      let session = this.session;
      let browser = this.browser;
      try {
        let shown = await session.setMode(mode);
        if (
          requestId !== this.requestId ||
          session !== this.session ||
          browser !== gBrowser.selectedBrowser
        ) {
          return;
        }
        if (!shown) {
          this.result = null;
          this.render();
          this.setStatus("agent-observation-stale");
        }
      } catch (error) {
        if (requestId === this.requestId) {
          console.error("Could not switch page observation mode", error);
          this.setStatus("agent-observation-error");
        }
      }
    }
  },

  async start() {
    if (!this.canObserve()) {
      this.setStatus("agent-observation-unavailable");
      return;
    }
    let browser = gBrowser.selectedBrowser;
    let requestId = ++this.requestId;
    this.pending = true;
    this.updateAvailability();
    this.setStatus("agent-observation-running");
    await this.clearSession(false, true);
    if (
      requestId !== this.requestId ||
      this.panel.hidden ||
      browser !== gBrowser.selectedBrowser ||
      !this.canObserve(browser)
    ) {
      if (requestId === this.requestId) {
        this.pending = false;
        this.updateAvailability();
      }
      return;
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (
      requestId !== this.requestId ||
      this.panel.hidden ||
      browser !== gBrowser.selectedBrowser
    ) {
      if (requestId === this.requestId) {
        this.pending = false;
        this.updateAvailability();
      }
      return;
    }
    this.browser = browser;
    let session = new AgentObservationSession(browser, {
      onInvalidated: () => {
        if (this.browser !== browser || this.session !== session) {
          return;
        }
        this.requestId++;
        this.result = null;
        this.selectedHandle = null;
        this.render();
        this.setStatus("agent-observation-stale");
        this.pending = false;
        this.updateAvailability();
      },
    });
    this.session = session;
    this.updateAvailability();
    this.setStatus("agent-observation-running");
    await this.observe(requestId, this.session, browser);
  },

  async refresh() {
    if (!this.session || this.browser !== gBrowser.selectedBrowser) {
      await this.start();
      return;
    }
    let requestId = ++this.requestId;
    this.pending = true;
    this.updateAvailability();
    this.setStatus("agent-observation-running");
    await this.observe(requestId, this.session, this.browser);
  },

  async observe(requestId, session, browser) {
    try {
      let result = await session.observe({ mode: this.mode });
      if (
        requestId !== this.requestId ||
        session !== this.session ||
        browser !== gBrowser.selectedBrowser
      ) {
        return;
      }
      this.result = result;
      this.selectedHandle = null;
      this.render();
      this.setStatus("agent-observation-ready");
    } catch (error) {
      if (requestId !== this.requestId || session !== this.session) {
        return;
      }
      console.error("Page observation failed", error);
      this.result = null;
      this.render();
      this.setStatus("agent-observation-error");
    } finally {
      if (requestId === this.requestId && session === this.session) {
        this.pending = false;
        this.updateAvailability();
      }
    }
  },

  async clearSession(invalidate = true, preservePending = false) {
    if (invalidate) {
      this.requestId++;
    }
    let session = this.session;
    this.session = null;
    this.browser = null;
    this.result = null;
    this.selectedHandle = null;
    if (!preservePending) {
      this.pending = false;
    }
    this.list.replaceChildren();
    this.summary.replaceChildren();
    this.updateAvailability();
    if (session) {
      try {
        await session.destroy();
      } catch (error) {
        console.error("Could not clear page observation", error);
      }
    }
  },

  updateAvailability() {
    let available = this.canObserve();
    this.toggleButton.disabled = !available || this.pending;
    this.refreshButton.disabled =
      this.pending || (!this.result && !this.session);
    for (let button of this.modeButtons || []) {
      button.disabled = this.pending;
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.mode === this.mode)
      );
    }
    this.toggleButton.toggleAttribute("data-active", !!this.session);
    document.l10n.setAttributes(
      this.toggleButton,
      this.session ? "agent-observation-disable" : "agent-observation-enable"
    );
    if (!available) {
      this.setStatus("agent-observation-unavailable");
    } else if (!this.session && !this.pending) {
      this.setStatus("agent-observation-idle");
    }
  },

  setStatus(id) {
    if (this.status) {
      document.l10n.setAttributes(this.status, id);
    }
  },

  getActiveElements() {
    if (!this.result) {
      return [];
    }
    if (this.mode === "context") {
      return this.result.context_elements ?? [];
    }
    if (this.mode === "translation") {
      return this.result.translation_elements ?? [];
    }
    return this.result.elements ?? [];
  },

  render() {
    let result = this.result;
    this.list.replaceChildren();
    this.summary.replaceChildren();
    if (!result) {
      return;
    }

    let elements = this.getActiveElements();
    let coverage = result.coverage ?? {};
    let stats = [
      ["agent-observation-count", { count: elements.length }],
      [
        "agent-observation-duration",
        { duration: result.timing?.total_ms ?? 0 },
      ],
      [
        "agent-observation-coverage",
        {
          frames: coverage.framesCollected ?? 0,
          skipped: coverage.framesSkipped ?? 0,
        },
      ],
    ];
    for (let [id, args] of stats) {
      let item = document.createElement("span");
      document.l10n.setAttributes(item, id, args);
      this.summary.append(item);
    }

    if (this.mode === "action") {
      if (elements.some(element => Number.isFinite(element.ranking?.score))) {
        let rankingSummary = document.createElement("span");
        document.l10n.setAttributes(
          rankingSummary,
          "agent-observation-ranking-summary"
        );
        this.summary.append(rankingSummary);
      }
    } else if (this.mode === "context") {
      let selectedCount = elements.filter(
        element => element.selected_for_context
      ).length;
      let contextSummary = document.createElement("span");
      document.l10n.setAttributes(
        contextSummary,
        "agent-observation-context-summary",
        { selected: selectedCount }
      );
      this.summary.append(contextSummary);

      let signals = result.page?.state_signals ?? {};
      for (let [flag, l10nId] of [
        [signals.hasAlert, "agent-observation-state-alert"],
        [signals.hasDialog, "agent-observation-state-dialog"],
        [signals.isIsolatedMainState, "agent-observation-state-isolated"],
      ]) {
        if (flag) {
          let badge = document.createElement("span");
          badge.className = "custom-observation-warning";
          document.l10n.setAttributes(badge, l10nId);
          this.summary.append(badge);
        }
      }
    } else if (this.mode === "translation") {
      let includedCount = elements.filter(
        element => element.translation?.included
      ).length;
      let excludedCount = elements.length - includedCount;
      let transSummary = document.createElement("span");
      document.l10n.setAttributes(
        transSummary,
        "agent-observation-translation-summary",
        { included: includedCount, excluded: excludedCount }
      );
      this.summary.append(transSummary);
    }

    let warnings = [];
    if (this.mode === "action" && coverage.actionsOmitted) {
      warnings.push([
        "agent-observation-actions-omitted",
        {
          count: coverage.actionsOmitted,
        },
      ]);
    }
    if (
      coverage.textTruncated ||
      coverage.text_truncated ||
      result.page?.text_truncated
    ) {
      warnings.push(["agent-observation-text-truncated", {}]);
    }
    if (
      coverage.viewportOnly ||
      result.page?.viewportOnly ||
      result.page?.viewport_only
    ) {
      warnings.push(["agent-observation-viewport-only", {}]);
    }
    for (let [id, args] of warnings) {
      let warning = document.createElement("span");
      warning.className = "custom-observation-warning";
      document.l10n.setAttributes(warning, id, args);
      this.summary.append(warning);
    }

    let legend = document.createElement("div");
    legend.className = "custom-observation-legend";
    for (let [id, className] of [
      ["agent-observation-legend-candidates", "candidate"],
      ["agent-observation-legend-selected", "selected"],
    ]) {
      let item = document.createElement("span");
      let swatch = document.createElement("span");
      swatch.className = `custom-observation-swatch custom-observation-swatch-${className}`;
      swatch.setAttribute("aria-hidden", "true");
      let label = document.createElement("span");
      document.l10n.setAttributes(label, id);
      item.append(swatch, label);
      legend.append(item);
    }
    this.summary.append(legend);

    for (let element of elements) {
      this.list.append(this.createElementRow(element));
    }
    this.refreshButton.disabled = false;
  },

  createElementRow(element) {
    let row = document.createElement("article");
    row.className = "custom-observation-row";
    row.setAttribute("role", "listitem");
    if (
      (this.mode === "translation" && !element.translation?.included) ||
      (this.mode === "context" && !element.selected_for_context)
    ) {
      row.setAttribute("data-excluded", "true");
    }

    let header = document.createElement("div");
    header.className = "custom-observation-row-header";
    let select = document.createElement("button");
    select.type = "button";
    select.className = "custom-observation-select";
    let displayText = element.name || element.label || "";
    if (displayText.length > 120) {
      displayText = displayText.slice(0, 117) + "…";
    }
    select.textContent = `${element.index}. ${displayText}`;
    select.setAttribute("aria-pressed", "false");
    select.addEventListener("click", () => this.selectElement(element, select));

    let ranking = element.ranking;
    let scoreBadge = null;
    if (this.mode === "translation" && element.translation) {
      scoreBadge = document.createElement("span");
      scoreBadge.className = "custom-observation-score";
      if (element.translation.included) {
        scoreBadge.setAttribute("data-included", "true");
      }
      document.l10n.setAttributes(
        scoreBadge,
        element.translation.included
          ? "agent-observation-translation-included"
          : "agent-observation-translation-excluded"
      );
    } else if (Number.isFinite(ranking?.score)) {
      scoreBadge = document.createElement("span");
      scoreBadge.className = "custom-observation-score";
      if (this.mode === "context" && element.selected_for_context) {
        scoreBadge.setAttribute("data-included", "true");
      }
      document.l10n.setAttributes(scoreBadge, "agent-observation-score", {
        score: ranking.score,
      });
    }

    let detailsButton = document.createElement("button");
    detailsButton.type = "button";
    detailsButton.className = "custom-observation-details-toggle";
    detailsButton.setAttribute("aria-expanded", "false");
    detailsButton.textContent = "⌄";
    document.l10n.setAttributes(
      detailsButton,
      "agent-observation-details-toggle"
    );
    let details = document.createElement("div");
    details.className = "custom-observation-details";
    details.hidden = true;
    detailsButton.addEventListener("click", () => {
      details.hidden = !details.hidden;
      detailsButton.setAttribute("aria-expanded", String(!details.hidden));
      detailsButton.textContent = details.hidden ? "⌄" : "⌃";
    });
    header.append(select);
    if (scoreBadge) {
      header.append(scoreBadge);
    }
    header.append(detailsButton);
    row.append(header, details);

    let context = element.context;
    if (this.mode === "translation" && element.translation) {
      let transDetails = document.createElement("section");
      transDetails.className = "custom-observation-ranking-details";
      let transHeading = document.createElement("h3");
      document.l10n.setAttributes(
        transHeading,
        "agent-observation-translation-details"
      );
      transDetails.append(transHeading);
      let line = document.createElement("p");
      let label = document.createElement("span");
      let transReasonId =
        {
          card_title: "agent-observation-trans-reason-card-title",
          card_body: "agent-observation-trans-reason-card-body",
          heading: "agent-observation-trans-reason-heading",
          main_prose: "agent-observation-trans-reason-main-prose",
          sentence_like: "agent-observation-trans-reason-sentence-like",
          excluded_node: "agent-observation-trans-reason-excluded-node",
          card_meta: "agent-observation-trans-reason-card-meta",
          card_action: "agent-observation-trans-reason-card-action",
          high_control_density:
            "agent-observation-trans-reason-high-control-density",
          short_label: "agent-observation-trans-reason-short-label",
          non_sentence: "agent-observation-trans-reason-non-sentence",
        }[element.translation.reason] ?? "agent-observation-reason-other";
      document.l10n.setAttributes(label, transReasonId);
      let statusSpan = document.createElement("span");
      statusSpan.className = "custom-observation-score-delta";
      document.l10n.setAttributes(
        statusSpan,
        element.translation.included
          ? "agent-observation-translation-included"
          : "agent-observation-translation-excluded"
      );
      line.append(label, statusSpan);
      transDetails.append(line);
      details.append(transDetails);
    } else if (scoreBadge && Array.isArray(ranking?.reasons)) {
      let rankingDetails = document.createElement("section");
      rankingDetails.className = "custom-observation-ranking-details";
      let rankingHeading = document.createElement("h3");
      document.l10n.setAttributes(
        rankingHeading,
        "agent-observation-ranking-details"
      );
      rankingDetails.append(rankingHeading);
      for (let reason of ranking.reasons) {
        let line = document.createElement("p");
        let label = document.createElement("span");
        let reasonId =
          {
            base: "agent-observation-reason-base",
            search: "agent-observation-reason-search",
            editable: "agent-observation-reason-editable",
            adjustable: "agent-observation-reason-adjustable",
            button: "agent-observation-reason-button",
            submit: "agent-observation-reason-submit",
            dialog: "agent-observation-reason-dialog",
            navigation: "agent-observation-reason-navigation",
            menu: "agent-observation-reason-menu",
            main: "agent-observation-reason-main",
            complementary: "agent-observation-reason-complementary",
            invalid: "agent-observation-reason-invalid",
            focused: "agent-observation-reason-focused",
            pagination: "agent-observation-reason-pagination",
            disclosure: "agent-observation-reason-disclosure",
            current: "agent-observation-reason-current",
            readonly: "agent-observation-reason-readonly",
            reset: "agent-observation-reason-reset",
            unlabeled: "agent-observation-reason-unlabeled",
            clipped: "agent-observation-reason-clipped",
            duplicate_target: "agent-observation-reason-duplicate-target",
            footer_link: "agent-observation-reason-footer-link",
            repeated: "agent-observation-reason-repeated",
            card_title: "agent-observation-reason-card-title",
            card_meta: "agent-observation-reason-card-meta",
            alert_assertive: "agent-observation-reason-alert-assertive",
            status_polite: "agent-observation-reason-status-polite",
            blocking_dialog: "agent-observation-reason-blocking-dialog",
            footer: "agent-observation-reason-footer",
            navigation_or_header:
              "agent-observation-reason-navigation-or-header",
            main_or_central: "agent-observation-reason-main-or-central",
            external_complementary:
              "agent-observation-reason-external-complementary",
            heading_1: "agent-observation-reason-heading-1",
            heading_2_or_card_title:
              "agent-observation-reason-heading-2-or-card-title",
            heading_3_plus: "agent-observation-reason-heading-3-plus",
            isolated_main_state:
              "agent-observation-reason-isolated-main-state",
            body_or_sentence: "agent-observation-reason-body-or-sentence",
            card_action_or_dense_controls:
              "agent-observation-reason-card-action-or-dense-controls",
            small_iframe: "agent-observation-reason-small-iframe",
          }[reason?.code] ?? "agent-observation-reason-other";
        document.l10n.setAttributes(label, reasonId);
        let delta = document.createElement("span");
        delta.className = "custom-observation-score-delta";
        if (Number.isFinite(reason?.delta)) {
          document.l10n.setAttributes(delta, "agent-observation-score", {
            score: `${reason.delta >= 0 ? "+" : ""}${reason.delta}`,
          });
        }
        line.append(label, delta);
        rankingDetails.append(line);
      }
      details.append(rankingDetails);
    }

    let detailEntries = [
      ["agent-observation-role", element.role],
      ["agent-observation-tag", element.tag],
      [
        "agent-observation-subrole",
        element.card_subrole || element.ranking_features?.card_subrole,
      ],
      ["agent-observation-operations", element.operations?.join(", ")],
      ["agent-observation-context-heading", context?.heading],
      ["agent-observation-context-scope", context?.scope],
      ["agent-observation-context-text", context?.text],
      ["agent-observation-href", element.href],
    ];
    for (let [labelId, value] of detailEntries) {
      if (!value) {
        continue;
      }
      let line = document.createElement("p");
      let label = document.createElement("strong");
      document.l10n.setAttributes(label, labelId);
      let text = document.createElement("span");
      text.textContent = value;
      line.append(label, text);
      details.append(line);
    }
    if (this.mode === "context") {
      let line = document.createElement("p");
      let label = document.createElement("strong");
      document.l10n.setAttributes(label, "agent-observation-context-selected");
      let text = document.createElement("span");
      document.l10n.setAttributes(
        text,
        element.selected_for_context
          ? "agent-observation-context-selected-yes"
          : "agent-observation-context-selected-no"
      );
      line.append(label, text);
      details.append(line);
    }
    return row;
  },

  async selectElement(element, button) {
    if (!this.session || !element.handle) {
      return;
    }
    let requestId = ++this.requestId;
    let session = this.session;
    let browser = this.browser;
    let previousSelection = this.list.querySelector('[aria-pressed="true"]');
    previousSelection?.setAttribute("aria-pressed", "false");
    previousSelection
      ?.closest(".custom-observation-row")
      ?.removeAttribute("data-selected");
    button.setAttribute("aria-pressed", "true");
    button
      .closest(".custom-observation-row")
      ?.setAttribute("data-selected", "true");
    this.selectedHandle = element.handle;
    try {
      let highlighted = await session.highlight(element.handle);
      if (
        requestId !== this.requestId ||
        session !== this.session ||
        browser !== gBrowser.selectedBrowser
      ) {
        return;
      }
      if (!highlighted) {
        this.result = null;
        this.render();
        this.setStatus("agent-observation-stale");
      }
    } catch (error) {
      if (requestId === this.requestId) {
        console.error("Could not highlight observed element", error);
        this.setStatus("agent-observation-error");
      }
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "click":
        if (event.currentTarget === this.closeButton) {
          this.setPanelOpen(false);
        } else if (event.currentTarget === this.toggleButton) {
          if (this.session) {
            this.clearSession().then(() => this.updateAvailability());
          } else {
            this.start();
          }
        } else if (event.currentTarget === this.refreshButton) {
          this.refresh();
        } else if (event.currentTarget?.dataset?.mode) {
          this.setMode(event.currentTarget.dataset.mode);
        }
        break;
      case "keydown":
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.setPanelOpen(false);
        }
        break;
      case "TabSelect":
      case "TabClose":
        if (
          event.type === "TabClose" &&
          this.browser &&
          event.target.linkedBrowser !== this.browser
        ) {
          return;
        }
        this.clearSession().then(() => this.updateAvailability());
        break;
      case "unload":
        gBrowser.tabContainer.removeEventListener("TabSelect", this);
        gBrowser.tabContainer.removeEventListener("TabClose", this);
        gBrowser.removeTabsProgressListener(this.progressListener);
        this.clearSession();
        break;
    }
  },
};

if (
  CustomizableUI.getWidget("custom-observation-button")?.provider !==
  CustomizableUI.PROVIDER_API
) {
  CustomizableUI.createWidget({
    id: "custom-observation-button",
    type: "custom",
    defaultArea: CustomizableUI.AREA_NAVBAR,
    removable: true,
    onBuild(doc) {
      let button = doc.createXULElement("toolbarbutton");
      button.id = this.id;
      button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
      button.setAttribute("label", "Observe Page");
      button.setAttribute("data-l10n-id", "agent-observation-toolbar");
      button.addEventListener("command", event => {
        event.target.documentGlobal.CustomObservationUI.togglePanel();
      });
      return button;
    },
  });
}

var { AgentObservationSession } = ChromeUtils.importESModule(
  "resource:///modules/agent/AgentObservation.sys.mjs"
);
delayedStartupPromise.then(() => CustomObservationUI.init());
