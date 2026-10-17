/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The sidebar archive: the bottom sidebar button slides the tab list out for
 * history (with recently closed tabs), bookmarks and downloads. Entries are
 * read from the existing Places, SessionStore and Downloads data.
 */
var CustomArchiveUI = {
  views: ["history", "bookmarks", "downloads"],
  historyDays: 30,
  historyLimit: 300,
  closedTabsLimit: 5,
  downloadsLimit: 100,
  bookmarkEvents: [
    "bookmark-added",
    "bookmark-removed",
    "bookmark-moved",
    "bookmark-title-changed",
    "bookmark-url-changed",
  ],
  slideDistance: 24,
  swipeStep: 36,
  swipeNudge: 6,
  searchDelay: 150,
  loadingDelay: 400,
  wideStep: 3,
  swipeEndDelay: 120,
  swipeReleaseRatio: 0.35,
  swipeReleasePeak: 8,
  inertiaGap: 120,
  switchDistance: 12,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",

  lazy: {},

  init() {
    ChromeUtils.defineESModuleGetters(this.lazy, {
      Downloads: "resource://gre/modules/Downloads.sys.mjs",
      PlacesTransactions: "resource://gre/modules/PlacesTransactions.sys.mjs",
      DownloadsViewUI:
        "moz-src:///browser/components/downloads/DownloadsViewUI.sys.mjs",
      PlacesQuery: "resource://gre/modules/PlacesQuery.sys.mjs",
    });
    this.root = document.documentElement;
    this.container = document.getElementById("sidebar-container");
    this.archive = document.getElementById("custom-archive");
    this.button = document.getElementById("custom-archive-button");
    this.tablist = document.getElementById("custom-archive-tabs");
    this.indicator = document.getElementById("custom-archive-indicator");
    this.title = document.getElementById("custom-archive-title");
    this.tabs = [...this.tablist.querySelectorAll(".custom-archive-tab")];
    this.address = document.getElementById("custom-sidebar-address");
    this.search = document.getElementById("custom-archive-search");
    this.searchInput = document.getElementById("custom-archive-search-input");
    this.clearButton = document.getElementById("custom-archive-search-clear");
    this.tabLayer = [
      ...this.container.querySelectorAll(
        ":scope > :is(#custom-sidebar-address, sidebar-main, #custom-notice-sidebar)"
      ),
    ];
    this.archiveLayer = [this.search, this.archive];
    this.view = "history";
    this.query = "";
    this.open = false;
    this.dirty = new Set(this.views);
    this.slideAnimations = [];
    this.downloads = [];
    this.downloadRows = new Map();
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.button.addEventListener("click", this);
    this.button.addEventListener("pointerenter", this);
    this.button.addEventListener("focus", this);
    this.tablist.addEventListener("click", this);
    this.tablist.addEventListener("keydown", this);
    this.archive.addEventListener("keydown", this);
    this.archive.addEventListener("wheel", this, { passive: false });
    this.archive.addEventListener("click", this);
    this.archive.addEventListener("auxclick", this);
    this.rowEntries = new WeakMap();
    this.searchInput.addEventListener("input", this);
    this.search.addEventListener("keydown", this);
    this.clearButton.addEventListener("click", this);
    window.addEventListener("unload", this, { once: true });
    Services.prefs.addObserver("sidebar.verticalTabs", this);
    this.rootObserver = new MutationObserver(() => {
      // A width the user drags to while the archive is open is kept.
      if (this.root.hasAttribute("sidebar-launcher-drag-active")) {
        this.restoreWidth = null;
      }
      this.updateAvailable();
    });
    this.rootObserver.observe(this.root, {
      attributes: true,
      attributeFilter: [
        "custom-ui",
        "customizing",
        "inDOMFullscreen",
        "fullscreenNavToolboxHidden",
        "sidebar-launcher-drag-active",
      ],
    });
    this.resizeObserver = new ResizeObserver(() => this.updateIndicator());
    this.resizeObserver.observe(this.tablist);

    this.bookmarksListener = () => this.loadBookmarks();
    this.downloadView = {
      onDownloadAdded: download => {
        this.downloads.push(download);
        this.invalidate("downloads");
      },
      onDownloadChanged: download => this.onDownloadChanged(download),
      onDownloadRemoved: download => {
        let index = this.downloads.indexOf(download);
        if (index != -1) {
          this.downloads.splice(index, 1);
        }
        this.invalidate("downloads");
      },
    };
  },

  get available() {
    return (
      this.root.hasAttribute("custom-ui") &&
      !this.root.hasAttribute("customizing") &&
      !this.root.hasAttribute("inDOMFullscreen") &&
      !this.root.hasAttribute("fullscreenNavToolboxHidden") &&
      Services.prefs.getBoolPref("sidebar.verticalTabs", false)
    );
  },

  updateAvailable() {
    if (this.open && !this.available) {
      this.setOpen(false, { animate: false });
    }
  },

  observe(subject, topic) {
    if (topic == "nsPref:changed") {
      this.updateAvailable();
    } else if (topic == "sessionstore-closed-objects-changed") {
      this.invalidate("history");
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "click":
        if (event.currentTarget === this.button) {
          this.setOpen(!this.open);
        } else if (event.currentTarget === this.clearButton) {
          this.clearSearch();
          this.searchInput.focus();
        } else if (event.currentTarget === this.tablist) {
          let tab = event.target.closest(".custom-archive-tab");
          if (tab) {
            this.setView(tab.dataset.view);
          }
        } else {
          this.onRowClick(event);
        }
        break;
      case "auxclick":
        if (event.button == 1) {
          this.onRowClick(event);
        }
        break;
      case "pointerenter":
      case "focus":
        this.ensureData();
        break;
      case "keydown":
        this.onKeyDown(event);
        break;
      case "wheel":
        this.onWheel(event);
        break;
      case "input":
        this.setQuery(this.searchInput.value);
        break;
      case "unload":
        this.uninit();
        break;
    }
  },

  onKeyDown(event) {
    if (event.currentTarget === this.tablist) {
      let index = this.views.indexOf(this.view);
      let rtl = this.isRTL();
      let next;
      switch (event.key) {
        case "ArrowDown":
        case rtl ? "ArrowLeft" : "ArrowRight":
          next = (index + 1) % this.views.length;
          break;
        case "ArrowUp":
        case rtl ? "ArrowRight" : "ArrowLeft":
          next = (index - 1 + this.views.length) % this.views.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = this.views.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.setView(this.views[next]);
      this.tabs[next].focus();
    } else if (
      event.currentTarget === this.archive &&
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Enter",
        "Delete",
      ].includes(event.key)
    ) {
      this.onArchiveKey(event);
    } else if (event.key == "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget === this.search && this.searchInput.value) {
        this.clearSearch();
      } else {
        this.setOpen(false);
      }
    }
  },

  /**
   * A horizontal scroll picks a view with the switch, the selection surface
   * of the icon tabs. While scrolling it grows into glass and steps one tab
   * for every swipeStep pixels in the direction the fingers move, so one
   * gesture can move across several tabs.
   * The view under it is shown once the gesture ends.
   */
  onWheel(event) {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
      return;
    }
    event.preventDefault();
    let rtl = this.isRTL();
    let raw =
      event.deltaMode == WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaX
        : event.deltaX * this.swipeStep;
    let speed = Math.abs(raw);
    let now = event.timeStamp;
    // The touchpad keeps sending decaying scroll events after the fingers
    // lift. They are ignored until they stop or speed up again, which means
    // a new gesture.
    let inertia = this.inertia;
    if (inertia) {
      if (now - inertia.time < this.inertiaGap && speed <= inertia.speed + 1) {
        inertia.time = now;
        inertia.speed = speed;
        return;
      }
      this.inertia = null;
    }
    if (!this.swipe) {
      this.swipe = { index: this.views.indexOf(this.view), delta: 0, peak: 0 };
      this.tablist.toggleAttribute("swiping", true);
    }
    let swipe = this.swipe;
    // A sharp drop from the gesture's peak speed is taken as the fingers
    // lifting, so the view switches at once instead of after the inertia.
    swipe.peak = Math.max(swipe.peak, speed);
    if (
      swipe.peak >= this.swipeReleasePeak &&
      speed < swipe.peak * this.swipeReleaseRatio
    ) {
      this.inertia = { time: now, speed };
      this.endSwipe();
      return;
    }
    let delta = raw * (rtl ? 1 : -1);
    let last = this.views.length - 1;
    swipe.delta += delta;
    while (swipe.delta >= this.swipeStep && swipe.index < last) {
      swipe.index++;
      swipe.delta -= this.swipeStep;
    }
    while (swipe.delta <= -this.swipeStep && swipe.index > 0) {
      swipe.index--;
      swipe.delta += this.swipeStep;
    }
    swipe.delta = Math.max(
      -this.swipeStep,
      Math.min(this.swipeStep, swipe.delta)
    );
    this.tabs.forEach((tab, i) =>
      tab.toggleAttribute("candidate", i == swipe.index)
    );
    this.updateIndicator(
      true,
      swipe.index,
      (swipe.delta / this.swipeStep) * this.swipeNudge * (rtl ? -1 : 1)
    );
    clearTimeout(this.swipeTimer);
    this.swipeTimer = setTimeout(() => this.endSwipe(), this.swipeEndDelay);
  },

  endSwipe() {
    clearTimeout(this.swipeTimer);
    let view = this.views[this.swipe.index];
    this.swipe = null;
    this.tablist.removeAttribute("swiping");
    for (let tab of this.tabs) {
      tab.removeAttribute("candidate");
    }
    if (view == this.view) {
      this.updateIndicator(true);
    } else {
      this.setView(view);
    }
  },

  moveView(step) {
    let index = this.views.indexOf(this.view) + step;
    if (index >= 0 && index < this.views.length) {
      this.setView(this.views[index]);
    }
  },

  /**
   * Left and right move between views, up and down between rows, Enter opens
   * the focused row and Delete removes it.
   */
  onArchiveKey(event) {
    let row = event.target.closest?.(".custom-archive-row");
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        this.moveView((event.key == "ArrowRight") != this.isRTL() ? 1 : -1);
        break;
      case "ArrowUp":
      case "ArrowDown": {
        let panel = document.getElementById(`custom-archive-${this.view}`);
        let rows = [...panel.querySelectorAll(".custom-archive-link")];
        let index = rows.indexOf(row);
        let next =
          event.key == "ArrowDown"
            ? (rows[index + 1] ?? rows[index])
            : (rows[index - 1] ?? rows[0]);
        next?.focus();
        break;
      }
      case "Enter":
        if (!this.rowEntries.has(row)) {
          return;
        }
        this.openEntry(this.rowEntries.get(row), event);
        break;
      case "Delete":
        if (!this.rowEntries.has(row)) {
          return;
        }
        this.removeEntry(row);
        break;
    }
    event.preventDefault();
    event.stopPropagation();
  },

  onRowClick(event) {
    let row = event.target.closest(".custom-archive-row");
    let entry = row && this.rowEntries.get(row);
    if (!entry) {
      return;
    }
    if (event.target.closest(".custom-archive-remove")) {
      if (event.button == 0) {
        this.removeEntry(row);
      }
      return;
    }
    this.openEntry(entry, event);
  },

  /**
   * Opens a row like a link. A plain click switches to the page, reusing a tab
   * that already shows it, and closes the archive; a modified or middle click
   * opens it where Firefox would and keeps the archive open.
   */
  openEntry(entry, event) {
    if (entry.closedId != null) {
      SessionStore.undoCloseById(entry.closedId);
      this.setOpen(false);
      return;
    }
    let where = BrowserUtils.whereToOpenLink(event, false, true);
    let triggeringPrincipal =
      Services.scriptSecurityManager.getSystemPrincipal();
    if (where == "current") {
      switchToTabHavingURI(entry.url, true, { triggeringPrincipal });
      this.setOpen(false);
    } else {
      openTrustedLinkIn(entry.url, where, { triggeringPrincipal });
    }
  },

  /**
   * Removes the row's entry: the page from history, the record of a closed
   * tab, or the bookmark, which stays undoable like other Places edits.
   */
  removeEntry(row) {
    let entry = this.rowEntries.get(row);
    if (!entry?.removable) {
      return;
    }
    if (row.contains(document.activeElement)) {
      let next = row.nextElementSibling ?? row.previousElementSibling;
      (next ?? document.getElementById(`custom-archive-${this.view}`)).focus();
    }
    row.remove();
    if (entry.closedId != null) {
      SessionStore.forgetClosedTabById(entry.closedId, window);
    } else if (entry.guid) {
      this.lazy.PlacesTransactions.Remove({ guid: entry.guid })
        .transact()
        .catch(console.error);
    } else {
      let search = this.historySearch;
      if (search?.visits) {
        search.visits = search.visits.filter(visit => visit.url != entry.url);
      }
      PlacesUtils.history.remove(entry.url).catch(console.error);
    }
  },

  setQuery(value) {
    this.clearButton.hidden = !value;
    let query = value.trim().toLocaleLowerCase();
    if (query == this.query) {
      return;
    }
    this.query = query;
    for (let view of this.views) {
      this.dirty.add(view);
    }
    this.scheduleHistorySearch(query);
    if (this.open) {
      this.renderIfDirty(this.view);
      document.getElementById(`custom-archive-${this.view}`).scrollTop = 0;
    }
  },

  /**
   * Searches all of history, not only the recent visits listed without a
   * query. Until the results arrive the recent visits are filtered instead.
   * The search waits for a pause in typing and the loading indicator only
   * shows when results are slow, so typing doesn't make the list flicker.
   */
  scheduleHistorySearch(query) {
    clearTimeout(this.searchTimer);
    clearTimeout(this.loadingTimer);
    let search = (this.historySearch = { query, visits: null });
    this.setSearching(false);
    if (!query) {
      return;
    }
    this.loadingTimer = setTimeout(() => {
      if (this.historySearch === search && !search.visits) {
        this.setSearching(true);
      }
    }, this.loadingDelay);
    this.searchTimer = setTimeout(
      () => this.searchHistory(search),
      this.searchDelay
    );
  },

  async searchHistory(search) {
    let { query } = search;
    this.ensureData();
    try {
      await this.historyReady;
      search.visits = await this.placesQuery.searchHistory(
        query,
        this.historyLimit
      );
    } catch (e) {
      // A newer search interrupts this one.
      return;
    }
    if (this.historySearch === search) {
      clearTimeout(this.loadingTimer);
      this.setSearching(false);
      this.invalidate("history");
    }
  },

  setSearching(searching) {
    let panel = document.getElementById("custom-archive-history");
    panel.querySelector(".custom-archive-loading").hidden = !searching;
    panel.setAttribute("aria-busy", String(searching));
  },

  get historySearchPending() {
    return !!this.query && !this.historySearch?.visits;
  },

  clearSearch() {
    this.searchInput.value = "";
    this.setQuery("");
  },

  matches(...texts) {
    return (
      !this.query ||
      texts.some(text => text?.toLocaleLowerCase().includes(this.query))
    );
  },

  /**
   * Shows the empty message for a view, or the no-results message while a
   * search is active.
   */
  updateEmpty(panel, hasEntries, pending = false) {
    panel.querySelector(".custom-archive-empty").hidden =
      hasEntries || !!this.query;
    panel.querySelector(".custom-archive-no-results").hidden =
      hasEntries || !this.query || pending;
  },

  isRTL() {
    return window.getComputedStyle(this.container).direction == "rtl";
  },

  setOpen(open, { animate = true } = {}) {
    open = open && this.available;
    if (open == this.open) {
      return;
    }
    if (open) {
      window.CustomSiteSidebarUI?.setOpen(false, { animate: false });
    }
    this.open = open;
    let hadFocus = this.archiveLayer.some(element =>
      element.contains(document.activeElement)
    );
    this.container.toggleAttribute("custom-archive", open);
    this.setLayersInert(open);
    this.button.setAttribute("aria-pressed", String(open));
    this.widen(open);
    if (open) {
      this.ensureData();
      this.renderIfDirty(this.view);
      this.updateIndicator();
    } else {
      if (hadFocus) {
        this.button.focus();
      }
      this.clearSearch();
    }
    if (animate) {
      this.slide(open);
    } else {
      this.cancelSlide();
    }
  },

  /**
   * The archive needs room for titles, so a narrower sidebar width step grows
   * to the third step while it's open and returns afterwards. Only the inline
   * width changes; the stored launcher width is left alone.
   */
  widen(open) {
    if (!open) {
      if (this.restoreWidth != null) {
        this.setWidth(this.restoreWidth);
        this.restoreWidth = null;
      }
      return;
    }
    let { minWidth = 168, step = 42 } = window.CustomSidebarResize ?? {};
    let target = minWidth + step * this.wideStep;
    if (
      !this.container.hasAttribute("sidebar-launcher-expanded") ||
      this.container.getBoundingClientRect().width >= target - 1
    ) {
      return;
    }
    this.restoreWidth = this.container.style.width;
    this.setWidth(`${target}px`);
  },

  setWidth(width) {
    CustomBrowserUI.resizeSidebar(width);
  },

  setLayersInert(open) {
    for (let element of this.tabLayer) {
      element.inert = open;
    }
    for (let element of this.archiveLayer) {
      element.inert = !open;
    }
  },

  cancelSlide() {
    for (let animation of this.slideAnimations) {
      animation.cancel();
    }
    this.slideAnimations = [];
  },

  /**
   * Pushes the tab list and the archive past each other. The hidden layer
   * fades out for the length of its exit animation. The address and search
   * boxes share one place and surface, so they swap in place and only the
   * new box's content fades in.
   */
  slide(open) {
    this.cancelSlide();
    if (this.reducedMotion.matches) {
      return;
    }
    let shift = (open ? -1 : 1) * this.slideDistance * (this.isRTL() ? -1 : 1);
    let box = open ? this.search : this.address;
    for (let element of box.children) {
      this.slideAnimations.push(
        element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 240,
          delay: 40,
          easing: "ease-out",
          fill: "backwards",
        })
      );
    }
    let sliding = element =>
      element !== this.address && element !== this.search;
    let outgoing = (open ? this.tabLayer : this.archiveLayer).filter(sliding);
    let incoming = (open ? this.archiveLayer : this.tabLayer).filter(sliding);
    for (let element of outgoing) {
      this.slideAnimations.push(
        element.animate(
          [
            { opacity: 1, translate: "0 0" },
            { opacity: 0, translate: `${shift}px 0` },
          ],
          { duration: 160, easing: "ease-in" }
        )
      );
    }
    for (let element of incoming) {
      this.slideAnimations.push(
        element.animate(
          [
            { opacity: 0, translate: `${-shift}px 0` },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 280, delay: 40, easing: this.easing, fill: "backwards" }
        )
      );
    }
  },

  setView(view) {
    if (view == this.view || !this.views.includes(view)) {
      return;
    }
    let direction =
      this.views.indexOf(view) > this.views.indexOf(this.view) ? 1 : -1;
    this.view = view;
    for (let tab of this.tabs) {
      let selected = tab.dataset.view == view;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    let panel;
    for (let name of this.views) {
      let element = document.getElementById(`custom-archive-${name}`);
      element.hidden = name != view;
      if (name == view) {
        panel = element;
      }
    }
    document.l10n.setAttributes(this.title, `custom-ui-archive-title-${view}`);
    document.l10n.setAttributes(
      this.searchInput,
      `custom-ui-archive-search-${view}`
    );
    this.renderIfDirty(view);
    this.updateIndicator(true);
    if (!this.reducedMotion.matches) {
      let shift = direction * this.switchDistance * (this.isRTL() ? -1 : 1);
      panel.animate(
        [
          { opacity: 0, translate: `${shift}px 0` },
          { opacity: 1, translate: "0 0" },
        ],
        { duration: 220, easing: this.easing }
      );
      this.title.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 180,
        easing: "ease-out",
      });
    }
  },

  /**
   * Moves the selection surface under the selected icon tab. It follows the
   * tab's box, so it also works when the collapsed sidebar stacks the tabs.
   */
  updateIndicator(
    animate = false,
    index = this.views.indexOf(this.view),
    nudge = 0
  ) {
    let tab = this.tabs[index];
    let style = this.indicator.style;
    this.indicator.toggleAttribute("instant", !animate);
    style.width = `${tab.offsetWidth}px`;
    style.height = `${tab.offsetHeight}px`;
    style.translate = `${tab.offsetLeft + nudge}px ${tab.offsetTop}px`;
    if (!animate) {
      // Flush the position before transitions are allowed again.
      this.indicator.getBoundingClientRect();
      this.indicator.removeAttribute("instant");
    }
  },

  ensureData() {
    if (this.dataRequested) {
      return;
    }
    this.dataRequested = true;
    Services.obs.addObserver(this, "sessionstore-closed-objects-changed");

    this.placesQuery = new this.lazy.PlacesQuery();
    this.placesQuery.observeHistory(history => {
      this.history = history;
      this.invalidate("history");
    });
    this.historyReady = this.placesQuery
      .getHistory({
        daysOld: this.historyDays,
        limit: this.historyLimit,
        sortBy: "date",
      })
      .then(history => {
        if (this.placesQuery) {
          this.history = history;
          this.invalidate("history");
        }
      }, console.error);

    PlacesUtils.observers.addListener(
      this.bookmarkEvents,
      this.bookmarksListener
    );
    this.loadBookmarks();

    let listType = PrivateBrowsingUtils.isWindowPrivate(window)
      ? this.lazy.Downloads.PRIVATE
      : this.lazy.Downloads.PUBLIC;
    this.lazy.Downloads.getList(listType).then(list => {
      if (this.unloaded) {
        return;
      }
      this.downloadList = list;
      list.addView(this.downloadView);
    }, console.error);
  },

  async loadBookmarks() {
    let tree = await PlacesUtils.promiseBookmarksTree(
      PlacesUtils.bookmarks.rootGuid
    );
    if (this.unloaded) {
      return;
    }
    this.bookmarks = tree;
    this.invalidate("bookmarks");
  },

  invalidate(view) {
    this.dirty.add(view);
    if (!this.open || this.view != view || this.renderPending) {
      return;
    }
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      if (this.open) {
        this.renderIfDirty(this.view);
      }
    });
  },

  renderIfDirty(view) {
    if (!this.dirty.has(view)) {
      return;
    }
    this.dirty.delete(view);
    switch (view) {
      case "history":
        this.renderHistory();
        break;
      case "bookmarks":
        this.renderBookmarks();
        break;
      case "downloads":
        this.renderDownloads();
        break;
    }
  },

  get locales() {
    return Services.locale.appLocalesAsBCP47;
  },

  /**
   * @param {object} entry
   * @param {string} entry.icon
   * @param {string} entry.label
   * @param {string} [entry.meta] Detail always shown at the row end.
   * @param {string} [entry.time] Time shown in a pill while the row is hovered.
   * @param {string} [entry.tooltip]
   * @param {object} [entry.action] What the row opens and removes: `url`,
   *   plus `closedId` for a closed tab or `guid` for a bookmark, and
   *   `removeL10nId` for its remove button.
   */
  createRow({ icon, label, meta, time, tooltip, action }) {
    let row = document.createElement("li");
    row.className = "custom-archive-row";
    let image = document.createElement("img");
    image.className = "custom-archive-icon";
    image.alt = "";
    image.src = icon;
    let text = document.createElement("span");
    text.className = "custom-archive-label";
    text.textContent = label;
    row.append(image, text);
    if (meta) {
      let detail = document.createElement("span");
      detail.className = "custom-archive-meta";
      detail.textContent = meta;
      row.append(detail);
    }
    if (time) {
      let pill = document.createElement("span");
      pill.className = "custom-archive-time";
      pill.textContent = time;
      row.append(pill);
    }
    if (tooltip) {
      row.title = tooltip;
    }
    if (action) {
      row.tabIndex = -1;
      row.classList.add("custom-archive-link");
      if (action.removeL10nId) {
        action.removable = true;
        row.classList.add("custom-archive-removable");
        let remove = document.createElement("button");
        remove.className = "custom-archive-remove";
        remove.type = "button";
        remove.tabIndex = -1;
        document.l10n.setAttributes(remove, action.removeL10nId);
        row.append(remove);
      }
      this.rowEntries.set(row, action);
    }
    return row;
  },

  createSection(heading) {
    let section = document.createElement("section");
    section.className = "custom-archive-section";
    let title = document.createElement("h3");
    title.className = "custom-archive-heading";
    if (heading.l10nId) {
      document.l10n.setAttributes(title, heading.l10nId);
    } else {
      title.textContent = heading.text;
    }
    let list = document.createElement("ul");
    list.className = "custom-archive-list";
    section.append(title, list);
    return { section, list };
  },

  renderHistory() {
    let panel = document.getElementById("custom-archive-history");
    let closed = this.renderClosedTabs();

    let fragment = document.createDocumentFragment();
    let now = new Date();
    let today = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();
    let relative = new Intl.RelativeTimeFormat(this.locales, {
      numeric: "auto",
    });
    let dayFormat = new Intl.DateTimeFormat(this.locales, {
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    let timeFormat = new Intl.DateTimeFormat(this.locales, {
      hour: "numeric",
      minute: "2-digit",
    });
    let days = new Map();
    for (let visit of this.historyVisits().slice(0, this.historyLimit)) {
      let date = visit.date;
      let day = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
      ).getTime();
      if (!days.has(day)) {
        days.set(day, []);
      }
      days.get(day).push(visit);
    }
    for (let [day, visits] of days) {
      let age = Math.round((today - day) / 86400000);
      let text = age < 2 ? relative.format(-age, "day") : dayFormat.format(day);
      let { section, list } = this.createSection({
        text: text.charAt(0).toLocaleUpperCase() + text.slice(1),
      });
      for (let visit of visits) {
        list.append(
          this.createRow({
            icon: `page-icon:${visit.url}`,
            label: visit.title || visit.url,
            time: timeFormat.format(visit.date),
            tooltip: visit.url,
            action: {
              url: visit.url,
              removeL10nId: "custom-ui-archive-remove-history",
            },
          })
        );
      }
      fragment.append(section);
    }
    panel.querySelector(".custom-archive-sections").replaceChildren(fragment);
    this.updateEmpty(panel, closed || !!days.size, this.historySearchPending);
  },

  /**
   * Returns the visits to list, newest first: the full history search
   * results once they match the query, otherwise the recent visits.
   */
  historyVisits() {
    let search = this.historySearch;
    if (this.query && search?.query == this.query && search.visits) {
      return search.visits;
    }
    let visits = [];
    for (let dayVisits of this.history?.values() ?? []) {
      visits.push(
        ...dayVisits.filter(visit => this.matches(visit.title, visit.url))
      );
    }
    return visits.sort((a, b) => b.date - a.date);
  },

  renderClosedTabs() {
    let section = document.getElementById("custom-archive-closed");
    let relative = new Intl.RelativeTimeFormat(this.locales, {
      numeric: "auto",
      style: "short",
    });
    let rows = SessionStore.getClosedTabDataForWindow(window)
      .map(tab => {
        let entries = tab.state?.entries ?? [];
        let entry = entries[(tab.state?.index ?? entries.length) - 1];
        return {
          tab,
          url: entry?.url ?? "",
          label: tab.title || entry?.title || entry?.url || "",
        };
      })
      .filter(({ url, label }) => this.matches(label, url))
      .sort((a, b) => (b.tab.closedAt ?? 0) - (a.tab.closedAt ?? 0))
      .slice(0, this.closedTabsLimit)
      .map(({ tab, url, label }) =>
        this.createRow({
          icon: tab.image || "chrome://global/skin/icons/defaultFavicon.svg",
          label,
          time: tab.closedAt
            ? this.formatElapsed(relative, Date.now() - tab.closedAt)
            : "",
          tooltip: url,
          action: {
            url,
            closedId: tab.closedId,
            removeL10nId: "custom-ui-archive-remove-closed",
          },
        })
      );
    section.querySelector(".custom-archive-list").replaceChildren(...rows);
    section.hidden = !rows.length;
    return !!rows.length;
  },

  formatElapsed(relative, elapsed) {
    let minutes = Math.max(0, Math.round(elapsed / 60000));
    if (minutes < 60) {
      return relative.format(-minutes, "minute");
    }
    let hours = Math.round(minutes / 60);
    if (hours < 24) {
      return relative.format(-hours, "hour");
    }
    return relative.format(-Math.round(hours / 24), "day");
  },

  renderBookmarks() {
    let panel = document.getElementById("custom-archive-bookmarks");
    let { bookmarks } = PlacesUtils;
    let roots = [
      [bookmarks.toolbarGuid, "custom-ui-archive-folder-toolbar"],
      [bookmarks.menuGuid, "custom-ui-archive-folder-menu"],
      [bookmarks.unfiledGuid, "custom-ui-archive-folder-other"],
      [bookmarks.mobileGuid, "custom-ui-archive-folder-mobile"],
    ];
    let fragment = document.createDocumentFragment();
    let hasItems = false;
    for (let [guid, l10nId] of roots) {
      let folder = this.bookmarks?.children?.find(node => node.guid == guid);
      let items = this.query
        ? this.matchingBookmarks(folder)
        : this.visibleBookmarks(folder);
      if (!items.length) {
        continue;
      }
      hasItems = true;
      let { section, list } = this.createSection({ l10nId });
      for (let item of items) {
        list.append(
          item.children
            ? this.createRow({
                icon: "chrome://global/skin/icons/folder.svg",
                label: item.title,
                meta: String(this.visibleBookmarks(item).length),
              })
            : this.createRow({
                icon: `page-icon:${item.uri}`,
                label: item.title || item.uri,
                tooltip: item.uri,
                action: {
                  url: item.uri,
                  guid: item.guid,
                  removeL10nId: "custom-ui-archive-remove-bookmark",
                },
              })
        );
      }
      fragment.append(section);
    }
    panel.querySelector(".custom-archive-sections").replaceChildren(fragment);
    this.updateEmpty(panel, hasItems);
  },

  /**
   * Returns the folders and bookmarks anywhere under a root folder that
   * match the search, in tree order.
   */
  matchingBookmarks(folder, results = []) {
    for (let node of this.visibleBookmarks(folder)) {
      if (this.matches(node.title, node.uri)) {
        results.push(node);
      }
      if (node.children) {
        this.matchingBookmarks(node, results);
      }
    }
    return results;
  },

  visibleBookmarks(folder) {
    return (folder?.children ?? []).filter(node => {
      if (node.type == PlacesUtils.TYPE_X_MOZ_PLACE_CONTAINER) {
        node.children ??= [];
        return true;
      }
      return (
        node.type == PlacesUtils.TYPE_X_MOZ_PLACE &&
        !node.uri?.startsWith("place:")
      );
    });
  },

  renderDownloads() {
    let panel = document.getElementById("custom-archive-downloads");
    let downloads = this.downloads
      .filter(download =>
        this.matches(
          download.target.path && PathUtils.filename(download.target.path),
          download.source.url
        )
      )
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, this.downloadsLimit);
    let rows = new Map();
    for (let download of downloads) {
      let row = this.downloadRows.get(download) ?? this.createDownloadRow();
      this.updateDownloadRow(row, download);
      rows.set(download, row);
    }
    this.downloadRows = rows;
    panel
      .querySelector(".custom-archive-list")
      .replaceChildren(...rows.values());
    this.updateEmpty(panel, !!rows.size);
  },

  createDownloadRow() {
    let element = (tag, className, ...children) => {
      let node = document.createElement(tag);
      node.className = className;
      node.append(...children);
      return node;
    };
    let image = element("img", "custom-archive-icon");
    image.alt = "";
    let progress = element(
      "span",
      "custom-archive-progress",
      element("span", "custom-archive-progress-bar")
    );
    progress.setAttribute("aria-hidden", "true");
    return element(
      "li",
      "custom-archive-row custom-archive-download",
      image,
      element(
        "span",
        "custom-archive-text",
        element("span", "custom-archive-label"),
        element("span", "custom-archive-status")
      ),
      progress
    );
  },

  updateDownloadRow(row, download) {
    let { DownloadsViewUI } = this.lazy;
    let path = download.target.path;
    let icon = path
      ? `moz-icon://${path}?size=16${download.succeeded ? "&state=normal" : ""}`
      : "moz-icon://.unknown?size=16";
    let image = row.querySelector(".custom-archive-icon");
    if (image.getAttribute("src") != icon) {
      image.src = icon;
    }

    let label = row.querySelector(".custom-archive-label");
    let name = DownloadsViewUI.getDisplayName(download);
    if (typeof name == "object") {
      document.l10n.setAttributes(label, name.l10n.id, name.l10n.args);
    } else {
      label.removeAttribute("data-l10n-id");
      label.textContent = name;
    }
    row.title = path || download.source.url;

    let state;
    let status = { text: "" };
    if (!download.stopped) {
      state = "progress";
      status.text = download.hasProgress
        ? DownloadUtils.getTransferTotal(
            download.currentBytes,
            download.totalBytes
          )
        : "";
      if (!status.text) {
        status.l10nId = "custom-ui-archive-download-starting";
      }
    } else if (download.succeeded) {
      state = download.target.exists === false ? "missing" : "done";
      if (state == "missing") {
        status.l10nId = "custom-ui-archive-download-missing";
      } else {
        let [host] = DownloadUtils.getURIHost(download.source.url);
        status.text = [DownloadsViewUI.getSizeWithUnits(download), host]
          .filter(Boolean)
          .join(" · ");
      }
    } else if (download.error) {
      state = "error";
      status.l10nId = download.error.becauseBlocked
        ? "custom-ui-archive-download-blocked"
        : "custom-ui-archive-download-failed";
    } else {
      state = download.hasPartialData ? "paused" : "canceled";
      status.l10nId = `custom-ui-archive-download-${state}`;
    }
    row.dataset.state = state;

    let statusElement = row.querySelector(".custom-archive-status");
    if (status.l10nId) {
      document.l10n.setAttributes(statusElement, status.l10nId);
    } else {
      statusElement.removeAttribute("data-l10n-id");
      statusElement.textContent = status.text;
    }

    let progress = row.querySelector(".custom-archive-progress");
    progress.toggleAttribute(
      "indeterminate",
      state == "progress" && !download.hasProgress
    );
    progress.style.setProperty(
      "--custom-archive-progress",
      `${download.hasProgress ? download.progress : 0}%`
    );
  },

  onDownloadChanged(download) {
    let row = this.downloadRows.get(download);
    if (row && this.open && this.view == "downloads") {
      this.updateDownloadRow(row, download);
    } else {
      this.invalidate("downloads");
    }
  },

  uninit() {
    this.unloaded = true;
    Services.prefs.removeObserver("sidebar.verticalTabs", this);
    this.rootObserver.disconnect();
    this.resizeObserver.disconnect();
    if (this.dataRequested) {
      Services.obs.removeObserver(this, "sessionstore-closed-objects-changed");
      PlacesUtils.observers.removeListener(
        this.bookmarkEvents,
        this.bookmarksListener
      );
      this.placesQuery.close();
      this.placesQuery = null;
      this.downloadList?.removeView(this.downloadView);
    }
  },
};

delayedStartupPromise.then(() => CustomArchiveUI.init());
