/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A glass dropdown menu drawn in the window's own document. Unlike XUL
 * popups, which are separate widgets, it can blur what's behind it, so it
 * shares the sidebar's glass. One instance serves any number of anchors; each
 * open() passes its items and what to do with the choice.
 *
 * A hover surface slides between items like the switch indicator. The menu
 * grows from the anchor's side and closes on Escape, Tab, a click outside,
 * window blur or resize.
 */
class CustomDropdown {
  gap = 6;
  edge = 8;
  maxHeight = 360;
  easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";

  /**
   * @param {object} [options]
   * @param {string} [options.id] Id of the menu element.
   */
  constructor({ id } = {}) {
    this.menu = document.createElement("div");
    this.menu.className = "custom-dropdown";
    if (id) {
      this.menu.id = id;
    }
    this.menu.setAttribute("role", "menu");
    this.menu.tabIndex = -1;
    this.menu.hidden = true;
    this.highlight = document.createElement("span");
    this.highlight.className = "custom-dropdown-highlight";
    this.highlight.setAttribute("aria-hidden", "true");
    this.list = document.createElement("div");
    this.list.className = "custom-dropdown-list";
    this.menu.append(this.highlight, this.list);
    document.body.append(this.menu);

    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.anchor = null;
    this.options = null;
    this.closing = null;
    this.menu.addEventListener("click", this);
    this.menu.addEventListener("keydown", this);
    this.menu.addEventListener("pointermove", this);
    this.menu.addEventListener("pointerleave", this);
    this.menu.addEventListener("focusin", this);
    this.menu.addEventListener("focusout", this);
  }

  get isOpen() {
    return !!this.anchor;
  }

  /**
   * Opens the menu at an anchor, or closes it when it's already open there,
   * so the anchor's click can simply call this.
   *
   * @param {Element} anchor
   * @param {object[]} items Each item has an `id` and an `l10nId` (or a
   *   `label`), plus an optional `icon` URL, `detail` text shown at the end,
   *   `checked` and `disabled`.
   * @param {object} options
   * @param {Function} options.onSelect Called with the chosen item's id.
   * @param {string} [options.position] "top-start", "top-end",
   *   "bottom-start" (the default) or "bottom-end", flipped when there isn't
   *   room. Start and end follow the text direction.
   * @param {boolean} [options.keyboard] Whether the keyboard opened it, which
   *   moves focus to the checked or first item.
   * @param {string} [options.scrollTo] Id of an item to scroll into view in a
   *   long menu when none is checked.
   */
  toggle(anchor, items, options) {
    if (this.suppressedAnchor === anchor) {
      this.suppressedAnchor = null;
      return;
    }
    if (this.anchor === anchor) {
      this.close();
      return;
    }
    this.open(anchor, items, options);
  }

  async open(
    anchor,
    content,
    { onSelect, position = "bottom-start", keyboard, scrollTo } = {}
  ) {
    if (this.anchor) {
      this.close({ animate: false, restoreFocus: false });
    }
    this.finishClosing();
    this.anchor = anchor;
    this.options = { onSelect, position };
    this.render(content);
    anchor.setAttribute("aria-expanded", "true");
    if (anchor.id) {
      this.menu.setAttribute("aria-labelledby", anchor.id);
    } else {
      this.menu.removeAttribute("aria-labelledby");
    }
    // The menu is measured for placement, so its labels are translated first.
    await document.l10n.translateElements([
      ...this.list.querySelectorAll("[data-l10n-id]"),
    ]);
    if (this.anchor !== anchor) {
      return;
    }
    this.menu.hidden = false;
    this.place();
    this.highlightItem(null, { instant: true });
    let checked = this.items.find(
      item => item.getAttribute("aria-checked") == "true"
    );
    let scrollTarget =
      checked ??
      (scrollTo && this.items.find(item => item.dataset.id == scrollTo));
    scrollTarget?.scrollIntoView({ block: "center" });

    let focusTarget = this.initialFocus(keyboard);
    (focusTarget ?? this.menu).focus({ focusVisible: !!keyboard });

    window.addEventListener("pointerdown", this, true);
    window.addEventListener("blur", this);
    window.addEventListener("resize", this);
    this.animateOpen();
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.animate]
   * @param {boolean} [options.restoreFocus] Moves focus back to the anchor
   *   when the menu had it.
   */
  close({ animate = true, restoreFocus = true } = {}) {
    let anchor = this.anchor;
    if (!anchor) {
      return;
    }
    this.anchor = null;
    window.removeEventListener("pointerdown", this, true);
    window.removeEventListener("blur", this);
    window.removeEventListener("resize", this);
    anchor.setAttribute("aria-expanded", "false");
    if (restoreFocus && this.menu.contains(document.activeElement)) {
      anchor.focus();
    }
    if (!animate || this.reducedMotion.matches || this.menu.hidden) {
      this.menu.hidden = true;
      return;
    }
    this.menu.getAnimations().forEach(animation => animation.cancel());
    let origin = this.position.startsWith("top") ? 1 : -1;
    this.closing = this.menu.animate(
      [
        { opacity: 1, scale: 1, translate: "0 0" },
        { opacity: 0, scale: 0.97, translate: `0 ${origin * 2}px` },
      ],
      { duration: 120, easing: "ease-in", fill: "forwards" }
    );
    this.closing.finished.then(
      () => this.finishClosing(),
      () => {}
    );
  }

  finishClosing() {
    if (!this.closing) {
      return;
    }
    let closing = this.closing;
    this.closing = null;
    closing.cancel();
    if (!this.anchor) {
      this.menu.hidden = true;
    }
  }

  /**
   * @param {boolean} keyboard Whether the keyboard opened the menu.
   * @returns {Element|null} What gets focus; the menu itself when null.
   */
  initialFocus(keyboard) {
    if (!keyboard) {
      return null;
    }
    return (
      this.items.find(item => item.getAttribute("aria-checked") == "true") ??
      this.enabledItems[0]
    );
  }

  render(items) {
    this.list.replaceChildren(
      ...items.map(item => {
        let element = document.createElement("div");
        element.className = "custom-dropdown-item";
        element.dataset.id = item.id;
        element.tabIndex = -1;
        if (item.checked != undefined) {
          element.setAttribute("role", "menuitemradio");
          element.setAttribute("aria-checked", String(!!item.checked));
        } else {
          element.setAttribute("role", "menuitem");
        }
        if (item.disabled) {
          element.setAttribute("aria-disabled", "true");
        }
        let icon = document.createElement("span");
        icon.className = "custom-dropdown-icon";
        if (item.icon) {
          icon.style.setProperty(
            "--custom-dropdown-icon",
            `url("${item.icon}")`
          );
        } else {
          icon.hidden = true;
        }
        let label = document.createElement("span");
        label.className = "custom-dropdown-label";
        if (item.l10nId) {
          document.l10n.setAttributes(label, item.l10nId, item.l10nArgs);
        } else {
          label.textContent = item.label;
        }
        element.append(icon, label);
        if (item.detail) {
          let detail = document.createElement("span");
          detail.className = "custom-dropdown-detail";
          detail.textContent = item.detail;
          element.append(detail);
        }
        let check = document.createElement("span");
        check.className = "custom-dropdown-check";
        check.setAttribute("aria-hidden", "true");
        element.append(check);
        return element;
      })
    );
  }

  get items() {
    return [...this.list.children];
  }

  get enabledItems() {
    return this.items.filter(item => !item.hasAttribute("aria-disabled"));
  }

  /**
   * Places the menu beside the anchor, flipping to the other side when it
   * doesn't fit, and keeps it inside the window.
   */
  place() {
    let rect = this.anchor.getBoundingClientRect();
    let rtl = window.getComputedStyle(this.anchor).direction == "rtl";
    this.menu.style.setProperty(
      "--custom-dropdown-anchor-width",
      `${Math.round(rect.width)}px`
    );
    let [block, inline] = this.options.position.split("-");
    let above = rect.top - this.gap - this.edge;
    let below = window.innerHeight - rect.bottom - this.gap - this.edge;
    this.menu.style.maxHeight = `${Math.min(this.maxHeight, Math.max(above, below))}px`;
    let { width, height } = this.menu.getBoundingClientRect();
    if (block == "top" && height > above && below > above) {
      block = "bottom";
    } else if (block == "bottom" && height > below && above > below) {
      block = "top";
    }
    this.position = `${block}-${inline}`;
    let alignLeft = (inline == "start") != rtl;
    let left = alignLeft ? rect.left : rect.right - width;
    left = Math.max(
      this.edge,
      Math.min(left, window.innerWidth - width - this.edge)
    );
    let top =
      block == "top" ? rect.top - this.gap - height : rect.bottom + this.gap;
    top = Math.max(this.edge, top);
    this.menu.style.left = `${Math.round(left)}px`;
    this.menu.style.top = `${Math.round(top)}px`;
    this.menu.style.transformOrigin = `${alignLeft ? "left" : "right"} ${
      block == "top" ? "bottom" : "top"
    }`;
  }

  /**
   * Grows the menu out of the anchor's side and lets the items follow one
   * after another.
   */
  animateOpen() {
    if (this.reducedMotion.matches) {
      return;
    }
    let origin = this.position.startsWith("top") ? 1 : -1;
    this.menu.animate(
      [
        { opacity: 0, scale: 0.94, translate: `0 ${origin * 6}px` },
        { opacity: 1, scale: 1, translate: "0 0" },
      ],
      { duration: 220, easing: this.easing }
    );
    let items = this.items;
    if (origin > 0) {
      items.reverse();
    }
    items.forEach((item, index) =>
      item.animate(
        [
          { opacity: 0, translate: `0 ${origin * 4}px` },
          { opacity: 1, translate: "0 0" },
        ],
        {
          duration: 200,
          delay: 30 + index * 18,
          easing: this.easing,
          fill: "backwards",
        }
      )
    );
  }

  /**
   * Slides the hover surface to an item, or fades it out.
   *
   * @param {Element|null} item
   * @param {object} [options]
   * @param {boolean} [options.instant] Skips the slide.
   */
  highlightItem(item, { instant = false } = {}) {
    if (item?.hasAttribute("aria-disabled")) {
      item = null;
    }
    let { highlight } = this;
    let visible = highlight.hasAttribute("visible");
    highlight.toggleAttribute("instant", instant || !visible);
    if (!item) {
      highlight.removeAttribute("visible");
      this.highlighted = null;
      return;
    }
    this.highlighted = item;
    highlight.style.translate = `${item.offsetLeft}px ${item.offsetTop}px`;
    highlight.style.width = `${item.offsetWidth}px`;
    highlight.style.height = `${item.offsetHeight}px`;
    // Lets the jump to a first item land before the surface fades in.
    highlight.getBoundingClientRect();
    highlight.setAttribute("visible", "");
    if (highlight.hasAttribute("instant")) {
      requestAnimationFrame(() => highlight.removeAttribute("instant"));
    }
  }

  select(item) {
    if (!item || item.hasAttribute("aria-disabled")) {
      return;
    }
    let { onSelect } = this.options;
    this.close();
    onSelect?.(item.dataset.id);
  }

  moveFocus(step) {
    let items = this.enabledItems;
    if (!items.length) {
      return;
    }
    let index = items.indexOf(document.activeElement);
    let next;
    if (step == Infinity) {
      next = items.at(-1);
    } else if (step == -Infinity) {
      next = items[0];
    } else if (index == -1) {
      next = step > 0 ? items[0] : items.at(-1);
    } else {
      next = items[(index + step + items.length) % items.length];
    }
    next.focus({ focusVisible: true });
  }

  handleEvent(event) {
    switch (event.type) {
      case "click":
        this.onClick(event);
        break;
      case "pointermove": {
        let item = event.target.closest(".custom-dropdown-item");
        if (item && item !== this.highlighted) {
          this.highlightItem(item);
        }
        break;
      }
      case "pointerleave":
        if (
          !this.menu.contains(document.activeElement) ||
          document.activeElement === this.menu
        ) {
          this.highlightItem(null);
        } else {
          this.highlightItem(document.activeElement);
        }
        break;
      case "focusin":
        if (event.target.classList.contains("custom-dropdown-item")) {
          this.highlightItem(event.target);
        }
        break;
      // Clicks in a web page never reach this window, but they take focus.
      case "focusout":
        if (this.anchor && !this.menu.contains(event.relatedTarget)) {
          this.close({ restoreFocus: false });
        }
        break;
      case "keydown":
        this.onKeyDown(event);
        break;
      case "pointerdown":
        if (this.menu.contains(event.target)) {
          return;
        }
        // The anchor's own click would open the menu again right away.
        if (this.anchor?.contains(event.target)) {
          this.suppressedAnchor = this.anchor;
          setTimeout(() => (this.suppressedAnchor = null), 500);
        }
        this.close({ restoreFocus: false });
        break;
      case "blur":
      case "resize":
        this.close({ restoreFocus: false });
        break;
    }
  }

  onClick(event) {
    this.select(event.target.closest(".custom-dropdown-item"));
  }

  onKeyDown(event) {
    switch (event.key) {
      case "ArrowDown":
        this.moveFocus(1);
        break;
      case "ArrowUp":
        this.moveFocus(-1);
        break;
      case "Home":
        this.moveFocus(-Infinity);
        break;
      case "End":
        this.moveFocus(Infinity);
        break;
      case "Enter":
      case " ":
        this.select(
          this.highlighted ?? event.target.closest(".custom-dropdown-item")
        );
        break;
      case "Escape":
        this.close();
        break;
      case "Tab":
        this.close({ restoreFocus: false });
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}

/**
 * A month calendar in the same glass as CustomDropdown, for picking a day.
 * Arrow keys move by day and week, Page Up and Page Down by month, and Enter
 * or a click chooses the day. Days are "YYYY-MM-DD" strings in local time.
 */
class CustomDatePicker extends CustomDropdown {
  constructor(options) {
    super(options);
    this.menu.classList.add("custom-datepicker");
    this.menu.setAttribute("role", "dialog");
  }

  /**
   * @param {Date} date
   * @returns {string} The local day, "YYYY-MM-DD".
   */
  static key(date) {
    let pad = number => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /**
   * @param {string} key "YYYY-MM-DD"
   * @returns {Date} Midnight of that local day.
   */
  static parse(key) {
    let [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  get locales() {
    return Services.locale.appLocalesAsBCP47;
  }

  /**
   * The first day of the week in the app's locale, as Date.getDay() numbers
   * it.
   */
  get firstDay() {
    let locale = new Intl.Locale(this.locales[0]);
    let info = locale.getWeekInfo?.() ?? locale.weekInfo;
    return (info?.firstDay ?? 7) % 7;
  }

  /**
   * Opens the calendar at an anchor. `onSelect` gets the chosen day.
   *
   * @param {Element} anchor
   * @param {string|null} value The selected day, if any.
   * @param {object} options See CustomDropdown.toggle().
   */
  toggle(anchor, value, options) {
    super.toggle(anchor, value, options);
  }

  render(value) {
    this.value = value;
    let today = new Date();
    this.focusDate = value ? CustomDatePicker.parse(value) : today;
    this.todayKey = CustomDatePicker.key(today);

    let header = document.createElement("div");
    header.className = "custom-datepicker-header";
    let previous = this.createNavButton(
      -1,
      "custom-ui-calendar-previous-month"
    );
    let next = this.createNavButton(1, "custom-ui-calendar-next-month");
    this.monthLabel = document.createElement("span");
    this.monthLabel.className = "custom-datepicker-month";
    this.monthLabel.setAttribute("aria-live", "polite");
    header.append(previous, this.monthLabel, next);

    let weekdays = document.createElement("div");
    weekdays.className = "custom-datepicker-weekdays";
    weekdays.setAttribute("aria-hidden", "true");
    let weekdayFormat = new Intl.DateTimeFormat(this.locales, {
      weekday: "narrow",
    });
    // 2023-01-01 was a Sunday.
    for (let index = 0; index < 7; index++) {
      let span = document.createElement("span");
      span.textContent = weekdayFormat.format(
        new Date(2023, 0, 1 + ((this.firstDay + index) % 7))
      );
      weekdays.append(span);
    }

    this.grid = document.createElement("div");
    this.grid.className = "custom-datepicker-grid";
    this.list.replaceChildren(header, weekdays, this.grid);
    this.renderMonth();
  }

  createNavButton(step, l10nId) {
    let button = document.createElement("button");
    button.type = "button";
    button.className = "custom-datepicker-nav";
    button.tabIndex = -1;
    button.dataset.step = step;
    document.l10n.setAttributes(button, l10nId);
    return button;
  }

  /**
   * Fills the grid with six weeks around the month of the focused day, so
   * the calendar keeps its size from month to month.
   */
  renderMonth() {
    let focus = this.focusDate;
    this.month = new Date(focus.getFullYear(), focus.getMonth(), 1);
    this.monthLabel.textContent = new Intl.DateTimeFormat(this.locales, {
      year: "numeric",
      month: "long",
    }).format(this.month);
    let labelFormat = new Intl.DateTimeFormat(this.locales, {
      dateStyle: "full",
    });
    let offset = (this.month.getDay() - this.firstDay + 7) % 7;
    let start = new Date(
      this.month.getFullYear(),
      this.month.getMonth(),
      1 - offset
    );
    let days = [];
    for (let index = 0; index < 42; index++) {
      let date = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + index
      );
      let key = CustomDatePicker.key(date);
      let day = document.createElement("button");
      day.type = "button";
      day.className = "custom-datepicker-day";
      day.tabIndex = -1;
      day.dataset.date = key;
      day.textContent = date.getDate();
      day.setAttribute("aria-label", labelFormat.format(date));
      day.setAttribute("aria-pressed", String(key == this.value));
      if (key == this.todayKey) {
        day.setAttribute("aria-current", "date");
      }
      if (date.getMonth() != this.month.getMonth()) {
        day.toggleAttribute("outside", true);
      }
      days.push(day);
    }
    // The focused day is about to be replaced, and losing focus would close
    // the calendar, so the calendar holds it meanwhile.
    if (this.grid.contains(document.activeElement)) {
      this.menu.focus();
    }
    this.grid.replaceChildren(...days);
  }

  get focusedDay() {
    return this.grid.querySelector(
      `[data-date="${CustomDatePicker.key(this.focusDate)}"]`
    );
  }

  initialFocus() {
    return this.focusedDay;
  }

  moveFocusDate(date) {
    this.focusDate = date;
    if (
      date.getMonth() != this.month.getMonth() ||
      date.getFullYear() != this.month.getFullYear()
    ) {
      this.renderMonth();
    }
    this.focusedDay?.focus({ focusVisible: true });
  }

  /**
   * Moves by whole months, keeping the day of the month where it exists.
   */
  moveMonth(step) {
    let date = this.focusDate;
    let target = new Date(date.getFullYear(), date.getMonth() + step, 1);
    let lastDay = new Date(
      target.getFullYear(),
      target.getMonth() + 1,
      0
    ).getDate();
    target.setDate(Math.min(date.getDate(), lastDay));
    let hadFocus = this.grid.contains(document.activeElement);
    this.focusDate = target;
    this.renderMonth();
    if (hadFocus) {
      this.focusedDay?.focus({ focusVisible: true });
    }
  }

  chooseDay(day) {
    let { onSelect } = this.options;
    this.close();
    onSelect?.(day.dataset.date);
  }

  onClick(event) {
    let nav = event.target.closest(".custom-datepicker-nav");
    if (nav) {
      this.moveMonth(Number(nav.dataset.step));
      return;
    }
    let day = event.target.closest(".custom-datepicker-day");
    if (day) {
      this.chooseDay(day);
    }
  }

  onKeyDown(event) {
    let rtl = window.getComputedStyle(this.menu).direction == "rtl";
    let date = this.focusDate;
    let byDays = days =>
      this.moveFocusDate(
        new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
      );
    switch (event.key) {
      case "ArrowLeft":
        byDays(rtl ? 1 : -1);
        break;
      case "ArrowRight":
        byDays(rtl ? -1 : 1);
        break;
      case "ArrowUp":
        byDays(-7);
        break;
      case "ArrowDown":
        byDays(7);
        break;
      case "PageUp":
        this.moveMonth(-1);
        this.focusedDay?.focus({ focusVisible: true });
        break;
      case "PageDown":
        this.moveMonth(1);
        this.focusedDay?.focus({ focusVisible: true });
        break;
      case "Enter":
      case " ": {
        let day =
          event.target.closest(".custom-datepicker-day") ?? this.focusedDay;
        if (day) {
          this.chooseDay(day);
        }
        break;
      }
      case "Escape":
        this.close();
        break;
      case "Tab":
        this.close({ restoreFocus: false });
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}
