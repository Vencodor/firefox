/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from browser-custom-dropdown.js */
/* import-globals-from browser-custom-calendar.js */

/**
 * The sidebar archive: the bottom sidebar button opens a menu of views, and
 * choosing one slides the tab list out for history (with recently closed
 * tabs), bookmarks, downloads or the calendar. Entries are read from the
 * existing Places, SessionStore and Downloads data, and tasks from
 * CalendarStore.
 * The view title switches views while the archive is open.
 */
var CustomArchiveUI = {
  views: ["history", "bookmarks", "downloads", "calendar"],
  viewIcons: {
    history: "chrome://browser/skin/history.svg",
    bookmarks: "chrome://browser/skin/bookmark-hollow.svg",
    downloads: "chrome://browser/skin/downloads/downloads.svg",
    calendar:
      "chrome://browser/content/custom-ui/resources/archive/calendar.svg",
  },
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
  searchDelay: 150,
  loadingDelay: 400,
  wideStep: 3,
  switchDistance: 12,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",

  lazy: {},

  init() {
    ChromeUtils.defineESModuleGetters(this.lazy, {
      DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
      DownloadsCommon:
        "moz-src:///browser/components/downloads/DownloadsCommon.sys.mjs",
      FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
      PlacesTransactions: "resource://gre/modules/PlacesTransactions.sys.mjs",
      DownloadsViewUI:
        "moz-src:///browser/components/downloads/DownloadsViewUI.sys.mjs",
      PlacesQuery: "resource://gre/modules/PlacesQuery.sys.mjs",
    });
    this.root = document.documentElement;
    this.container = document.getElementById("sidebar-container");
    this.archive = document.getElementById("custom-archive");
    this.button = document.getElementById("custom-archive-button");
    this.titleButton = document.getElementById("custom-archive-title");
    this.title = document.getElementById("custom-archive-title-text");
    this.menu = new CustomDropdown({ id: "custom-archive-menu" });
    this.search = document.getElementById("custom-archive-search");
    this.searchInput = document.getElementById("custom-archive-search-input");
    this.clearButton = document.getElementById("custom-archive-search-clear");
    this.tabLayer = [
      ...this.container.querySelectorAll(
        ":scope > :is(#custom-fold-switch, sidebar-main, #custom-notice-sidebar)"
      ),
    ];
    this.archiveLayer = [this.archive];
    this.view = "history";
    this.query = "";
    this.open = false;
    this.dirty = new Set(this.views);
    this.slideAnimations = [];
    this.downloads = new Set();
    this.downloadRows = new Map();
    this.rowDownloads = new WeakMap();
    this.refreshedDownloads = new WeakSet();
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.button.addEventListener("click", this);
    this.button.addEventListener("pointerenter", this);
    this.button.addEventListener("focus", this);
    this.titleButton.addEventListener("click", this);
    this.archive.addEventListener("keydown", this);
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
    CustomCalendarUI.init({ onChange: () => this.invalidate("calendar") });

    this.bookmarksListener = () => this.loadBookmarks();
    this.downloadView = {
      onDownloadAdded: download => {
        this.downloads.add(download);
        this.invalidate("downloads");
      },
      onDownloadChanged: download => this.onDownloadChanged(download),
      onDownloadRemoved: download => {
        this.downloads.delete(download);
        this.invalidate("downloads");
      },
    };

    this.activeDownloads = new Set();
    this.progressView = {
      onDownloadAdded: download => this.trackDownload(download),
      onDownloadChanged: download => this.trackDownload(download),
      onDownloadRemoved: download => this.trackDownload(download, true),
    };
    this.progressData = this.lazy.DownloadsCommon.getData(window);
    this.progressData.addView(this.progressView);
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
          this.onButtonClick(event);
        } else if (event.currentTarget === this.titleButton) {
          this.openViewMenu(this.titleButton, event, "bottom-start");
        } else if (event.currentTarget === this.clearButton) {
          this.clearSearch();
          this.searchInput.focus();
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
      case "input":
        this.setQuery(this.searchInput.value);
        break;
      case "command":
        this.onDownloadCommand(event.target.dataset.action);
        break;
      case "popuphidden":
        this.onDownloadMenuHidden();
        break;
      case "unload":
        this.uninit();
        break;
    }
  },

  onKeyDown(event) {
    if (
      event.currentTarget === this.archive &&
      this.search.contains(event.target)
    ) {
      if (event.key == "ArrowDown") {
        document
          .getElementById(`custom-archive-${this.view}`)
          .querySelector(".custom-archive-link")
          ?.focus();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (
      event.currentTarget === this.archive &&
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Enter",
        "Delete",
        "F2",
        "ContextMenu",
        " ",
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
   * While the archive is closed the button opens the view menu above it;
   * while it's open the button brings the tabs back.
   */
  onButtonClick(event) {
    if (this.button.hasAttribute("custom-downloading")) {
      this.showDownloads();
    } else if (this.open) {
      this.setOpen(false);
    } else {
      this.openViewMenu(this.button, event, "top-start");
    }
  },

  /**
   * While a download runs the button skips the view menu and goes straight
   * to the downloads view; a second click brings the tabs back.
   */
  showDownloads() {
    if (this.open && this.view == "downloads") {
      this.setOpen(false);
      return;
    }
    this.ensureData();
    this.setView("downloads");
    this.setOpen(true);
    if (this.open) {
      document.getElementById("custom-archive-downloads").focus();
    }
  },

  trackDownload(download, removed = false) {
    if (removed || download.stopped) {
      if (this.activeDownloads.delete(download) && download.succeeded) {
        this.downloadSucceeded = true;
      }
    } else {
      this.activeDownloads.add(download);
    }
    if (this.downloadButtonPending) {
      return;
    }
    this.downloadButtonPending = true;
    requestAnimationFrame(() => {
      this.downloadButtonPending = false;
      this.updateDownloadButton();
    });
  },

  /**
   * Shows the overall progress of running downloads as a ring around a
   * download icon. When the last one finishes the ring completes before the
   * archive icon comes back.
   */
  updateDownloadButton() {
    let button = this.button;
    let state = button.getAttribute("custom-downloading");
    clearTimeout(this.downloadDoneTimer);

    if (!this.activeDownloads.size) {
      if (!state) {
        return;
      }
      let succeeded = this.downloadSucceeded;
      this.downloadSucceeded = false;
      if (succeeded && state != "done") {
        button.style.setProperty("--custom-download-progress", "1");
        button.setAttribute("custom-downloading", "done");
        document.l10n.setAttributes(
          button,
          "custom-ui-archive-button-downloaded"
        );
        this.downloadDoneTimer = setTimeout(
          () => this.clearDownloadButton(),
          this.reducedMotion.matches ? 600 : 1200
        );
      } else {
        this.clearDownloadButton();
      }
      return;
    }

    let current = 0;
    let total = 0;
    for (let download of this.activeDownloads) {
      if (download.hasProgress) {
        current += download.currentBytes;
        total += download.totalBytes;
      }
    }
    let progress = total ? Math.min(current / total, 1) : 0;
    if (!state || state == "done") {
      // Sets the starting point before the ring shows so it doesn't sweep
      // back from the last download's full ring.
      button.style.setProperty("--custom-download-progress", progress);
      getComputedStyle(button).getPropertyValue("--custom-download-progress");
    }
    button.style.setProperty("--custom-download-progress", progress);
    button.setAttribute(
      "custom-downloading",
      total ? "progress" : "indeterminate"
    );
    let percent = Math.floor(progress * 100);
    if (!total) {
      document.l10n.setAttributes(
        button,
        "custom-ui-archive-button-downloading-unknown"
      );
    } else if (state != "progress" || this.downloadPercent != percent) {
      document.l10n.setAttributes(
        button,
        "custom-ui-archive-button-downloading",
        { percent }
      );
    }
    this.downloadPercent = total ? percent : -1;
  },

  clearDownloadButton() {
    this.button.removeAttribute("custom-downloading");
    this.downloadPercent = -1;
    document.l10n.setAttributes(this.button, "custom-ui-archive-button");
  },

  openViewMenu(anchor, event, position) {
    this.ensureData();
    this.menu.toggle(
      anchor,
      this.views.map(view => ({
        id: view,
        l10nId: `custom-ui-archive-title-${view}`,
        icon: this.viewIcons[view],
        checked: this.open && view == this.view,
      })),
      {
        position,
        keyboard: event.detail == 0,
        onSelect: view => {
          this.setView(view);
          this.setOpen(true);
          if (!this.open) {
            return;
          }
          if (view == "calendar") {
            CustomCalendarUI.focusComposer();
          } else if (anchor === this.button) {
            document.getElementById(`custom-archive-${view}`).focus();
          }
        },
      }
    );
  },

  moveView(step) {
    let index = this.views.indexOf(this.view) + step;
    if (index >= 0 && index < this.views.length) {
      this.setView(this.views[index]);
    }
  },

  /**
   * Left and right move between views, up and down between rows, Enter opens
   * the focused row and Delete removes it. F2 renames a download's file and
   * the context menu key opens its menu. Calendar rows handle their own keys
   * first.
   */
  onArchiveKey(event) {
    let row = event.target.closest?.(".custom-archive-row");
    if (row && CustomCalendarUI.onRowKey(event, row)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
        if (this.rowDownloads.has(row)) {
          this.openDownload(this.rowDownloads.get(row));
          break;
        }
        if (!this.rowEntries.has(row)) {
          return;
        }
        this.openEntry(this.rowEntries.get(row), event);
        break;
      case "F2":
        if (!this.rowDownloads.has(row)) {
          return;
        }
        this.startRename(row, this.rowDownloads.get(row));
        break;
      case "ContextMenu":
        if (!this.rowDownloads.has(row)) {
          return;
        }
        this.openDownloadMenu(
          row.querySelector(".custom-archive-more"),
          row,
          this.rowDownloads.get(row)
        );
        break;
      case "Delete":
        if (!this.rowEntries.has(row)) {
          return;
        }
        this.removeEntry(row);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  },

  onRowClick(event) {
    let row = event.target.closest(".custom-archive-row");
    if (row?.classList.contains("custom-calendar-row")) {
      CustomCalendarUI.onRowClick(event, row);
      return;
    }
    let download = row && this.rowDownloads.get(row);
    if (download) {
      this.onDownloadClick(event, row, download);
      return;
    }
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
      window.CustomFoldUI?.setOpen(false, { animate: false });
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
    } else {
      if (this.menu.anchor === this.titleButton) {
        this.menu.close({ animate: false, restoreFocus: false });
      }
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
   * fades out for the length of its exit animation.
   */
  slide(open) {
    this.cancelSlide();
    if (this.reducedMotion.matches) {
      return;
    }
    let shift = (open ? -1 : 1) * this.slideDistance * (this.isRTL() ? -1 : 1);
    let outgoing = open ? this.tabLayer : this.archiveLayer;
    let incoming = open ? this.archiveLayer : this.tabLayer;
    for (let element of outgoing) {
      // The stylesheet hides the outgoing layer at once; it stays visible
      // until its fade ends.
      this.slideAnimations.push(
        element.animate(
          [
            { opacity: 1, translate: "0 0", visibility: "visible" },
            { opacity: 0, translate: `${shift}px 0`, visibility: "visible" },
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
    if (this.open && !this.reducedMotion.matches) {
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

    // Like the Library, this includes downloads from earlier sessions, which
    // are only kept in history.
    this.downloadData = this.lazy.DownloadsCommon.getData(window, true);
    this.downloadData.addView(this.downloadView);
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
      case "calendar":
        CustomCalendarUI.render();
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

  get timeFormat() {
    return new Intl.DateTimeFormat(this.locales, {
      hour: "numeric",
      minute: "2-digit",
    });
  },

  /**
   * Groups items that are already sorted by date under the start of their
   * day, keeping their order.
   *
   * @param {object[]} items
   * @param {Function} dateOf Returns an item's Date.
   * @returns {Map<number, object[]>}
   */
  groupByDay(items, dateOf) {
    let days = new Map();
    for (let item of items) {
      let date = dateOf(item);
      let day = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
      ).getTime();
      if (!days.has(day)) {
        days.set(day, []);
      }
      days.get(day).push(item);
    }
    return days;
  },

  /**
   * Returns the title of a day section: today, yesterday or the date.
   */
  dayHeading(day) {
    let now = new Date();
    let today = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();
    let age = Math.round((today - day) / 86400000);
    let text =
      age < 2
        ? new Intl.RelativeTimeFormat(this.locales, { numeric: "auto" }).format(
            -age,
            "day"
          )
        : new Intl.DateTimeFormat(this.locales, {
            month: "long",
            day: "numeric",
            weekday: "short",
          }).format(day);
    return text.charAt(0).toLocaleUpperCase() + text.slice(1);
  },

  renderHistory() {
    let panel = document.getElementById("custom-archive-history");
    let closed = this.renderClosedTabs();

    let fragment = document.createDocumentFragment();
    let timeFormat = this.timeFormat;
    let days = this.groupByDay(
      this.historyVisits().slice(0, this.historyLimit),
      visit => visit.date
    );
    for (let [day, visits] of days) {
      let { section, list } = this.createSection({
        text: this.dayHeading(day),
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
    let downloads = [...this.downloads]
      .filter(download =>
        this.matches(
          download.target.path && PathUtils.filename(download.target.path),
          download.source.url
        )
      )
      .sort((a, b) => this.downloadTime(b) - this.downloadTime(a))
      .slice(0, this.downloadsLimit);
    let rows = new Map();
    for (let download of downloads) {
      let row = this.downloadRows.get(download) ?? this.createDownloadRow();
      this.rowDownloads.set(row, download);
      this.updateDownloadRow(row, download);
      rows.set(download, row);
      // Checks once whether the file was moved or deleted outside Firefox.
      if (!this.refreshedDownloads.has(download)) {
        this.refreshedDownloads.add(download);
        download.refresh?.().catch(console.error);
      }
    }
    this.downloadRows = rows;
    panel
      .querySelector(".custom-archive-list")
      .replaceChildren(...rows.values());
    this.updateEmpty(panel, !!rows.size);
  },

  /**
   * Returns when a download started. Downloads from earlier sessions only
   * know the time of their history visit.
   */
  downloadTime(download) {
    if (download.startTime) {
      return download.startTime.getTime();
    }
    return download.placesNode?.time / 1000 || download.endTime || 0;
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
    let more = element("button", "custom-archive-more");
    more.type = "button";
    more.tabIndex = -1;
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    document.l10n.setAttributes(more, "custom-ui-archive-download-more");
    let row = element(
      "li",
      "custom-archive-row custom-archive-link custom-archive-download",
      image,
      element(
        "span",
        "custom-archive-text",
        element("span", "custom-archive-label"),
        element("span", "custom-archive-status")
      ),
      progress,
      more
    );
    row.tabIndex = -1;
    return row;
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

  canOpenDownload(download) {
    return (
      download.succeeded &&
      download.target.exists &&
      !download.deleted &&
      !!download.target.path
    );
  },

  canShowDownload(download) {
    let { target } = download;
    return (
      !download.deleted &&
      !!target.path &&
      !!(target.exists || target.partFileExists)
    );
  },

  openDownload(download) {
    if (this.canOpenDownload(download)) {
      this.lazy.DownloadsCommon.openDownload(download, { openWhere: "tab" });
    }
  },

  /**
   * A click runs the file, except on the more button, which opens the row's
   * menu, and in the field of a rename in progress.
   */
  onDownloadClick(event, row, download) {
    if (event.button != 0 || event.target.closest(".custom-archive-rename")) {
      return;
    }
    let more = event.target.closest(".custom-archive-more");
    if (more) {
      this.openDownloadMenu(more, row, download);
      return;
    }
    if (!row.hasAttribute("renaming")) {
      this.openDownload(download);
    }
  },

  get downloadMenu() {
    if (!this._downloadMenu) {
      let popup = document.createXULElement("menupopup");
      popup.id = "custom-archive-download-menu";
      for (let action of ["rename", "show", "delete"]) {
        let item = document.createXULElement("menuitem");
        item.dataset.action = action;
        document.l10n.setAttributes(
          item,
          `custom-ui-archive-download-${action}`
        );
        popup.append(item);
      }
      popup.addEventListener("command", this);
      popup.addEventListener("popuphidden", this);
      document.getElementById("mainPopupSet").append(popup);
      this._downloadMenu = popup;
    }
    return this._downloadMenu;
  },

  openDownloadMenu(anchor, row, download) {
    let popup = this.downloadMenu;
    if (popup.state != "closed") {
      popup.hidePopup();
      return;
    }
    let enabled = {
      rename: this.canOpenDownload(download),
      show: this.canShowDownload(download),
      delete: true,
    };
    for (let item of popup.children) {
      item.disabled = !enabled[item.dataset.action];
    }
    this.menuTarget = { anchor, row, download };
    anchor.setAttribute("aria-expanded", "true");
    popup.openPopup(anchor, "after_end");
  },

  /**
   * Renaming waits for the menu to close, so the menu doesn't take the focus
   * back from the name field.
   */
  onDownloadCommand(action) {
    let { row, download } = this.menuTarget ?? {};
    if (!download) {
      return;
    }
    switch (action) {
      case "rename":
        this.menuTarget.rename = true;
        break;
      case "show":
        this.lazy.DownloadsCommon.showDownloadedFile(
          new this.lazy.FileUtils.File(download.target.path)
        );
        break;
      case "delete":
        this.deleteDownload(row, download);
        break;
    }
  },

  onDownloadMenuHidden() {
    let target = this.menuTarget;
    this.menuTarget = null;
    target?.anchor.setAttribute("aria-expanded", "false");
    if (target?.rename && target.row.isConnected) {
      this.startRename(target.row, target.download);
    }
  },

  /**
   * Deletes the file and removes the download from the list and history.
   */
  deleteDownload(row, download) {
    if (row.isConnected && row.contains(document.activeElement)) {
      let next = row.nextElementSibling ?? row.previousElementSibling;
      (next ?? document.getElementById("custom-archive-downloads")).focus();
    }
    this.lazy.DownloadsCommon.deleteDownloadFiles(download, 2).catch(
      console.error
    );
  },

  /**
   * Turns the file name into a field in place, like renaming a tab. The base
   * name is selected so typing keeps the extension. Enter or leaving the field
   * renames the file and Escape keeps the old name.
   */
  startRename(row, download) {
    if (
      row.hasAttribute("renaming") ||
      !this.canOpenDownload(download) ||
      !this.container.hasAttribute("sidebar-launcher-expanded")
    ) {
      return;
    }
    let label = row.querySelector(".custom-archive-label");
    let name = PathUtils.filename(download.target.path);
    let input = document.createElement("input");
    input.className = "custom-archive-rename";
    input.type = "text";
    input.value = name;
    input.spellcheck = false;
    input.autocomplete = "off";
    document.l10n.setAttributes(
      input,
      "custom-ui-archive-download-rename-field"
    );
    let rename = { row, download, input, label };
    this.renaming = rename;
    input.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key == "Enter") {
        event.preventDefault();
        this.commitRename(rename, { keepOnError: true });
      } else if (event.key == "Escape") {
        event.preventDefault();
        this.endRename(rename);
      }
    });
    input.addEventListener("input", () =>
      input.removeAttribute("aria-invalid")
    );
    input.addEventListener("blur", () => this.commitRename(rename));
    row.toggleAttribute("renaming", true);
    label.hidden = true;
    label.after(input);
    input.focus();
    let [base] = this.lazy.DownloadPaths.splitBaseNameAndExtension(name);
    input.setSelectionRange(0, (base || name).length);
  },

  async commitRename(rename, { keepOnError = false } = {}) {
    if (this.renaming !== rename || rename.busy) {
      return;
    }
    let { download, input } = rename;
    let path = download.target.path;
    let name = this.lazy.DownloadPaths.sanitize(input.value.trim());
    if (!name || name == PathUtils.filename(path)) {
      this.endRename(rename);
      return;
    }
    let newPath = PathUtils.join(PathUtils.parent(path), name);
    // A change of case only is the same file on case-insensitive systems.
    let sameFile = newPath.toLowerCase() == path.toLowerCase();
    rename.busy = true;
    try {
      await IOUtils.move(path, newPath, { noOverwrite: !sameFile });
    } catch (e) {
      rename.busy = false;
      if (keepOnError && this.renaming === rename) {
        input.setAttribute("aria-invalid", "true");
        input.select();
      } else {
        this.endRename(rename);
      }
      return;
    }
    download.target.path = newPath;
    this.endRename(rename);
    if (!download.source.isPrivate) {
      PlacesUtils.history
        .update({
          url: download.source.originalUrl || download.source.url,
          annotations: new Map([
            ["downloads/destinationFileURI", PathUtils.toFileURI(newPath)],
          ]),
        })
        .catch(console.error);
    }
    // Session downloads only tell their views about changes of state, so the
    // new name is announced here.
    await download.refresh();
    download._notifyChange?.();
  },

  endRename(rename) {
    if (this.renaming !== rename) {
      return;
    }
    this.renaming = null;
    let { row, download, input, label } = rename;
    let hadFocus = input.matches(":focus");
    row.removeAttribute("renaming");
    input.remove();
    label.hidden = false;
    if (row.isConnected) {
      this.updateDownloadRow(row, download);
      if (hadFocus) {
        row.focus();
      }
    }
  },

  uninit() {
    this.unloaded = true;
    Services.prefs.removeObserver("sidebar.verticalTabs", this);
    this.rootObserver.disconnect();
    clearTimeout(this.downloadDoneTimer);
    this.progressData.removeView(this.progressView);
    if (this.dataRequested) {
      Services.obs.removeObserver(this, "sessionstore-closed-objects-changed");
      PlacesUtils.observers.removeListener(
        this.bookmarkEvents,
        this.bookmarksListener
      );
      this.placesQuery.close();
      this.placesQuery = null;
      this.downloadData.removeView(this.downloadView);
    }
  },
};

delayedStartupPromise.then(() => CustomArchiveUI.init());
