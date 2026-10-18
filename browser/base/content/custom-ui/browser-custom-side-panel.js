/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A column beside the tab list, where Firefox's sidebar panel goes, for a
 * view that should show next to the tabs rather than in their place. Nothing
 * uses it yet; it's kept for views to come. A view shows itself with show(),
 * fills the returned content element and hides with hide().
 *
 * The column only shows while the window has room for it: Firefox's own
 * sidebar panel isn't open in its place, the tab sidebar is on the left and
 * the page keeps its minimum width. Losing that room hides it and tells the
 * view. Its width is resized with a splitter and kept in a pref.
 */
var CustomSidePanel = {
  widthPref: "browser.customUI.sidePanel.width",
  minWidth: 200,
  maxWidth: 420,
  // The page keeps at least this width beside the column.
  minPageWidth: 560,
  // The view showing in the column: { onHide }.
  owner: null,
  initialized: false,

  /**
   * Shows the column for a view, replacing the one shown before.
   *
   * @param {object} options
   * @param {string} options.title The column's heading.
   * @param {?string} [options.icon] The heading's icon URL.
   * @param {Function} [options.onHide] Called when the column hides for
   *   another view or for lack of room.
   * @returns {?Element} The element to fill, or null without room.
   */
  show({ title, icon = null, onHide = null }) {
    this.init();
    if (!this.hasRoom()) {
      return null;
    }
    let previous = this.owner;
    this.owner = { onHide };
    if (previous) {
      previous.onHide?.();
    }
    this.title.textContent = title;
    this.icon.hidden = !icon;
    if (icon) {
      this.icon.src = icon;
    }
    this.content.replaceChildren();
    this.applyWidth();
    this.panel.hidden = false;
    this.splitter.hidden = false;
    return this.content;
  },

  /**
   * Hides the column. A view passes its onHide to only hide its own.
   *
   * @param {Function} [onHide]
   */
  hide(onHide) {
    if (!this.owner || (onHide && this.owner.onHide != onHide)) {
      return;
    }
    let owner = this.owner;
    this.owner = null;
    let hadFocus = this.panel.contains(document.activeElement);
    this.panel.hidden = true;
    this.splitter.hidden = true;
    this.content.replaceChildren();
    if (hadFocus) {
      gBrowser.selectedBrowser.focus();
    }
    if (!onHide) {
      owner.onHide?.();
    }
  },

  get shown() {
    return !!this.owner;
  },

  /**
   * Starts following the window's room and the splitter, the first time a
   * view asks for the column.
   */
  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.root = document.documentElement;
    this.container = document.getElementById("sidebar-container");
    this.panel = document.getElementById("custom-side-panel");
    this.title = document.getElementById("custom-side-panel-title");
    this.icon = document.getElementById("custom-side-panel-icon");
    this.content = document.getElementById("custom-side-panel-content");
    this.splitter = document.getElementById("custom-side-panel-splitter");
    this.sidebarBox = document.getElementById("sidebar-box");
    this.frame = 0;
    this.resized = false;
    this.widthObserver = new MutationObserver(() => this.onResize());
    this.widthObserver.observe(this.panel, {
      attributes: true,
      attributeFilter: ["width"],
    });
    this.layoutObserver = new ResizeObserver(() => this.scheduleUpdate());
    this.layoutObserver.observe(this.container);
    this.attributeObserver = new MutationObserver(() => this.scheduleUpdate());
    this.attributeObserver.observe(this.sidebarBox, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    this.attributeObserver.observe(this.root, {
      attributes: true,
      attributeFilter: ["sidebar-positionend"],
    });
    window.addEventListener("resize", this);
    window.addEventListener("mouseup", this, true);
    window.addEventListener("unload", this, { once: true });
    this.panel.addEventListener("keydown", this);
  },

  handleEvent(event) {
    switch (event.type) {
      case "resize":
        this.scheduleUpdate();
        break;
      case "mouseup":
        this.onResizeEnd();
        break;
      case "keydown":
        if (event.key == "Escape") {
          event.preventDefault();
          gBrowser.selectedBrowser.focus();
        }
        break;
      case "unload":
        this.uninit();
        break;
    }
  },

  /**
   * Whether the window has room for the column beside the tab list.
   */
  hasRoom() {
    return (
      !this.root.hasAttribute("sidebar-positionend") &&
      this.sidebarBox.hidden &&
      this.maxWidthHere() >= this.minWidth
    );
  },

  /**
   * The widest the column may be in the window as it is.
   */
  maxWidthHere() {
    let room =
      window.innerWidth -
      this.container.getBoundingClientRect().width -
      this.minPageWidth;
    return Math.min(this.maxWidth, room);
  },

  scheduleUpdate() {
    if (this.frame || !this.owner) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.owner) {
        return;
      }
      if (this.hasRoom()) {
        this.applyWidth();
      } else {
        this.hide();
      }
    });
  },

  clampWidth(width) {
    return Math.max(this.minWidth, Math.min(width, this.maxWidthHere()));
  },

  applyWidth() {
    let width = Services.prefs.getIntPref(this.widthPref, 240);
    this.panel.style.width = `${this.clampWidth(width)}px`;
  },

  /**
   * Follows the splitter while it's dragged, within the widths the window
   * allows, and covers the page as the tab sidebar's resizing does.
   */
  onResize() {
    if (this.splitter.getAttribute("state") != "dragging") {
      return;
    }
    let width = parseFloat(this.panel.getAttribute("width"));
    if (!Number.isFinite(width)) {
      return;
    }
    this.resized = true;
    this.root.toggleAttribute("custom-sidebar-resizing", true);
    this.panel.style.width = `${this.clampWidth(width)}px`;
  },

  onResizeEnd() {
    if (!this.resized) {
      return;
    }
    this.resized = false;
    this.root.toggleAttribute("custom-sidebar-resizing", false);
    Services.prefs.setIntPref(
      this.widthPref,
      Math.round(this.panel.getBoundingClientRect().width)
    );
  },

  uninit() {
    window.removeEventListener("resize", this);
    window.removeEventListener("mouseup", this, true);
    cancelAnimationFrame(this.frame);
    this.widthObserver.disconnect();
    this.layoutObserver.disconnect();
    this.attributeObserver.disconnect();
  },
};
