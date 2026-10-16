/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global CustomizableUI, delayedStartupPromise, gBrowser, PanelUI */

var CustomObservationUI = {
  session: null,
  browser: null,
  result: null,
  requestId: 0,
  selectedHandle: null,
  pending: false,

  init() {
    this.panel = document.getElementById("custom-observation-panel");
    this.closeButton = document.getElementById("custom-observation-close");
    this.toggleButton = document.getElementById("custom-observation-toggle");
    this.refreshButton = document.getElementById("custom-observation-refresh");
    this.status = document.getElementById("custom-observation-status");
    this.summary = document.getElementById("custom-observation-summary");
    this.list = document.getElementById("custom-observation-list");

    let menuBody = PanelUI.mainView.querySelector(".panel-subview-body");
    if (!document.getElementById("custom-observation-menuitem")) {
      let menuItem = document.createXULElement("toolbarbutton");
      menuItem.id = "custom-observation-menuitem";
      menuItem.className = "subviewbutton";
      menuItem.setAttribute("data-l10n-id", "agent-observation-toolbar");
      menuItem.addEventListener("command", () => {
        PanelUI.hide();
        this.togglePanel();
      });
      menuBody.append(menuItem);
    }

    this.closeButton.addEventListener("click", this);
    this.toggleButton.addEventListener("click", this);
    this.refreshButton.addEventListener("click", this);
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
      let result = await session.observe();
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

  render() {
    let result = this.result;
    this.list.replaceChildren();
    this.summary.replaceChildren();
    if (!result) {
      return;
    }

    let coverage = result.coverage ?? {};
    let stats = [
      ["agent-observation-count", { count: result.elements?.length ?? 0 }],
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

    let elements = result.elements ?? [];
    if (elements.some(element => Number.isFinite(element.ranking?.score))) {
      let rankingSummary = document.createElement("span");
      document.l10n.setAttributes(
        rankingSummary,
        "agent-observation-ranking-summary"
      );
      this.summary.append(rankingSummary);
    }

    let warnings = [];
    if (coverage.actionsOmitted) {
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

    let header = document.createElement("div");
    header.className = "custom-observation-row-header";
    let select = document.createElement("button");
    select.type = "button";
    select.className = "custom-observation-select";
    select.textContent = `${element.index}. ${element.name || element.label || ""}`;
    select.setAttribute("aria-pressed", "false");
    select.addEventListener("click", () => this.selectElement(element, select));

    let ranking = element.ranking;
    let scoreBadge = null;
    if (Number.isFinite(ranking?.score)) {
      scoreBadge = document.createElement("span");
      scoreBadge.className = "custom-observation-score";
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
    if (scoreBadge && Array.isArray(ranking.reasons)) {
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
        let reasonId = {
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
      button.setAttribute("label", "페이지 관찰");
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
