/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from browser-custom-dropdown.js */
/* import-globals-from browser-custom-archive.js */

/**
 * The archive's calendar view: things to do, with an optional due day and
 * time. A composer at the top adds tasks, and the list below groups them as
 * overdue, by due day, without a date and completed. Tasks live in
 * CalendarStore, which the agent will share; this view only reads and writes
 * through it and redraws when the store announces a change, so every window
 * shows the same tasks.
 */
var CustomCalendarUI = {
  composerMaxHeight: 160,
  timeStep: 30,
  defaultTime: "09:00",
  completeDelay: 450,
  refreshDelay: 60000,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  icons: {
    calendar:
      "chrome://browser/content/custom-ui/resources/archive/calendar.svg",
    clock: "chrome://browser/content/custom-ui/resources/archive/clock.svg",
    edit: "chrome://global/skin/icons/edit.svg",
    delete: "chrome://global/skin/icons/delete.svg",
  },

  lazy: {},

  /**
   * @param {object} options
   * @param {Function} options.onChange Asks the archive to render the view.
   */
  init({ onChange }) {
    ChromeUtils.defineESModuleGetters(this.lazy, {
      CalendarStore: "resource:///modules/calendar/CalendarStore.sys.mjs",
    });
    this.onChange = onChange;
    this.panel = document.getElementById("custom-archive-calendar");
    this.composer = document.getElementById("custom-calendar-composer");
    this.input = document.getElementById("custom-calendar-input");
    this.dateChip = document.getElementById("custom-calendar-date");
    this.timeChip = document.getElementById("custom-calendar-time");
    this.submit = document.getElementById("custom-calendar-submit");
    this.sections = this.panel.querySelector(".custom-archive-sections");
    this.menu = new CustomDropdown({ id: "custom-calendar-menu" });
    this.picker = new CustomDatePicker({ id: "custom-calendar-picker" });
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.draft = { dueDate: null, dueTime: null };
    this.tasks = null;
    this.rows = new Map();
    this.rowTasks = new WeakMap();
    this.completing = new Map();
    this.showCompleted = false;
    this.editing = null;

    this.composer.addEventListener("submit", this);
    this.input.addEventListener("input", this);
    this.input.addEventListener("keydown", this);
    this.dateChip.addEventListener("click", this);
    this.timeChip.addEventListener("click", this);
    this.sections.addEventListener("click", this);
    window.addEventListener("unload", this, { once: true });
    this.updateDraft();
  },

  handleEvent(event) {
    switch (event.type) {
      case "submit":
        event.preventDefault();
        this.addTask();
        break;
      case "input":
        this.updateComposer();
        break;
      case "keydown":
        this.onComposerKey(event);
        break;
      case "click":
        this.onClick(event);
        break;
      case "unload":
        this.uninit();
        break;
    }
  },

  onClick(event) {
    let keyboard = event.detail == 0;
    if (event.currentTarget === this.dateChip) {
      this.openDateMenu(this.dateChip, this.draft.dueDate, keyboard, date => {
        this.draft.dueDate = date;
        if (!date) {
          this.draft.dueTime = null;
        }
        this.updateDraft();
        this.input.focus();
      });
    } else if (event.currentTarget === this.timeChip) {
      this.openTimeMenu(this.timeChip, this.draft.dueTime, keyboard, time => {
        this.draft.dueTime = time;
        this.updateDraft();
        this.input.focus();
      });
    } else if (event.target.closest(".custom-calendar-completed-toggle")) {
      this.showCompleted = !this.showCompleted;
      this.onChange();
    }
  },

  observe() {
    this.load();
  },

  async load() {
    if (!this.observing) {
      this.observing = true;
      Services.obs.addObserver(this, this.lazy.CalendarStore.TOPIC);
    }
    let request = (this.loadRequest = {});
    let tasks = await this.lazy.CalendarStore.getAll();
    if (this.loadRequest !== request || this.unloaded) {
      return;
    }
    this.tasks = tasks;
    this.onChange();
  },

  focusComposer() {
    if (this.panel.hidden || this.composer.offsetParent == null) {
      this.panel.focus();
      return;
    }
    this.input.focus();
  },

  onComposerKey(event) {
    if (event.key == "Escape") {
      return;
    }
    // The archive's keys move between views and rows; here they edit text.
    event.stopPropagation();
    if (event.key == "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.addTask();
    }
  },

  updateComposer() {
    this.submit.disabled = !this.input.value.trim();
    this.fitTextarea(this.input, this.composerMaxHeight);
  },

  fitTextarea(textarea, maxHeight = Infinity) {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  },

  /**
   * Shows the composer's due day and time on its chips. The time chip only
   * shows once there is a day.
   */
  updateDraft() {
    let { dueDate, dueTime } = this.draft;
    this.setChipLabel(
      this.dateChip,
      dueDate ? this.dayName(dueDate) : null,
      "custom-ui-calendar-date-chip"
    );
    this.setChipLabel(
      this.timeChip,
      dueTime ? this.formatTime(dueTime) : null,
      "custom-ui-calendar-time-chip"
    );
    this.timeChip.hidden = !dueDate;
  },

  setChipLabel(chip, text, emptyL10nId) {
    let label = chip.querySelector(".custom-calendar-chip-label");
    chip.setAttribute("aria-pressed", String(!!text));
    if (text) {
      label.removeAttribute("data-l10n-id");
      label.textContent = text;
    } else {
      document.l10n.setAttributes(label, emptyL10nId);
    }
  },

  async addTask() {
    let title = this.input.value.trim();
    if (!title) {
      return;
    }
    let { dueDate, dueTime } = this.draft;
    this.input.value = "";
    this.draft = { dueDate: null, dueTime: null };
    this.updateComposer();
    this.updateDraft();
    try {
      let task = await this.lazy.CalendarStore.add({ title, dueDate, dueTime });
      this.appeared = task.id;
    } catch (e) {
      console.error(e);
      this.input.value = title;
      this.draft = { dueDate, dueTime };
      this.updateComposer();
      this.updateDraft();
    }
  },

  get locales() {
    return Services.locale.appLocalesAsBCP47;
  },

  get todayKey() {
    return CustomDatePicker.key(new Date());
  },

  addDays(key, days) {
    let date = CustomDatePicker.parse(key);
    date.setDate(date.getDate() + days);
    return CustomDatePicker.key(date);
  },

  /**
   * Names a day the way the list does: today, tomorrow and yesterday by
   * name, other days by date and weekday, with the year only when it differs.
   */
  dayName(key) {
    let date = CustomDatePicker.parse(key);
    let today = CustomDatePicker.parse(this.todayKey);
    let days = Math.round((date - today) / 86400000);
    if (Math.abs(days) <= 1) {
      let text = new Intl.RelativeTimeFormat(this.locales, {
        numeric: "auto",
      }).format(days, "day");
      return text.charAt(0).toLocaleUpperCase() + text.slice(1);
    }
    return new Intl.DateTimeFormat(this.locales, {
      year: date.getFullYear() == today.getFullYear() ? undefined : "numeric",
      month: "short",
      day: "numeric",
      weekday: "short",
    }).format(date);
  },

  formatTime(time) {
    let [hours, minutes] = time.split(":").map(Number);
    return new Intl.DateTimeFormat(this.locales, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(2000, 0, 1, hours, minutes));
  },

  get nowTime() {
    let now = new Date();
    let pad = number => String(number).padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  },

  /**
   * The quick day choices, plus the month calendar and clearing the day.
   *
   * @param {Element} anchor
   * @param {string|null} current The day already chosen.
   * @param {boolean} keyboard
   * @param {Function} apply Called with the new day, or null to clear it.
   */
  openDateMenu(anchor, current, keyboard, apply) {
    let today = this.todayKey;
    let tomorrow = this.addDays(today, 1);
    let weekday = new Date().getDay();
    let nextWeek = this.addDays(today, (8 - weekday) % 7 || 7);
    let weekdayFormat = new Intl.DateTimeFormat(this.locales, {
      weekday: "short",
    });
    let dateFormat = new Intl.DateTimeFormat(this.locales, {
      month: "short",
      day: "numeric",
    });
    let quick = [today, tomorrow, nextWeek];
    let items = [
      {
        id: today,
        label: this.dayName(today),
        detail: weekdayFormat.format(CustomDatePicker.parse(today)),
        checked: current == today,
      },
      {
        id: tomorrow,
        label: this.dayName(tomorrow),
        detail: weekdayFormat.format(CustomDatePicker.parse(tomorrow)),
        checked: current == tomorrow,
      },
      {
        id: nextWeek,
        l10nId: "custom-ui-calendar-next-week",
        detail: dateFormat.format(CustomDatePicker.parse(nextWeek)),
        checked: current == nextWeek,
      },
      {
        id: "pick",
        l10nId: "custom-ui-calendar-pick-date",
        icon: this.icons.calendar,
        detail:
          current && !quick.includes(current) ? this.dayName(current) : "",
      },
    ];
    if (current) {
      items.push({ id: "none", l10nId: "custom-ui-calendar-clear-date" });
    }
    this.menu.toggle(anchor, items, {
      keyboard,
      onSelect: id => {
        if (id == "pick") {
          this.picker.open(anchor, current, { keyboard, onSelect: apply });
        } else {
          apply(id == "none" ? null : id);
        }
      },
    });
  },

  /**
   * Times of day every half hour. Without a time chosen, the list opens at
   * the morning.
   */
  openTimeMenu(anchor, current, keyboard, apply) {
    let items = [{ id: "none", l10nId: "custom-ui-calendar-clear-time" }];
    let pad = number => String(number).padStart(2, "0");
    for (let minutes = 0; minutes < 24 * 60; minutes += this.timeStep) {
      let time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
      items.push({
        id: time,
        label: this.formatTime(time),
        checked: time == current,
      });
    }
    this.menu.toggle(anchor, items, {
      keyboard,
      scrollTo: this.defaultTime,
      onSelect: id => apply(id == "none" ? null : id),
    });
  },

  render() {
    if (!this.tasks) {
      this.load();
      return;
    }
    if (this.editing) {
      this.renderAfterEdit = true;
      return;
    }
    this.scheduleRefresh();
    let archive = CustomArchiveUI;
    let today = this.todayKey;
    let overdue = [];
    let days = new Map();
    let undated = [];
    let done = [];
    for (let task of this.tasks) {
      if (!archive.matches(task.title)) {
        continue;
      }
      if (task.completedAt) {
        done.push(task);
      } else if (!task.dueDate) {
        undated.push(task);
      } else if (task.dueDate < today) {
        overdue.push(task);
      } else {
        if (!days.has(task.dueDate)) {
          days.set(task.dueDate, []);
        }
        days.get(task.dueDate).push(task);
      }
    }
    let byDue = (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      (a.dueTime ?? "").localeCompare(b.dueTime ?? "") ||
      a.createdAt - b.createdAt;

    let rows = new Map();
    let fragment = document.createDocumentFragment();
    let addSection = (heading, tasks, { showDate = false } = {}) => {
      let { section, list } = this.createSection(heading, tasks.length);
      for (let task of tasks) {
        let row = this.rows.get(task.id) ?? this.createRow();
        this.updateRow(row, task, { showDate });
        rows.set(task.id, row);
        list.append(row);
      }
      fragment.append(section);
      return { section, list };
    };
    if (overdue.length) {
      let { section } = addSection(
        { l10nId: "custom-ui-calendar-overdue" },
        overdue.sort(byDue),
        { showDate: true }
      );
      section.toggleAttribute("overdue", true);
    }
    for (let day of [...days.keys()].sort()) {
      addSection({ text: this.dayName(day) }, days.get(day).sort(byDue));
    }
    if (undated.length) {
      addSection(
        { l10nId: "custom-ui-calendar-no-date" },
        undated.sort((a, b) => b.createdAt - a.createdAt)
      );
    }
    if (done.length) {
      let { list } = addSection(
        { l10nId: "custom-ui-calendar-completed", toggle: true },
        done.sort((a, b) => b.completedAt - a.completedAt),
        { showDate: true }
      );
      list.hidden = !this.showCompleted;
    }
    this.rows = rows;
    this.sections.replaceChildren(fragment);
    archive.updateEmpty(this.panel, !!rows.size);
    this.animateAppeared();
  },

  /**
   * A section with its title and how many tasks it holds. The completed
   * section's title folds its list.
   */
  createSection({ l10nId, text, toggle }, count) {
    let { section, list } = CustomArchiveUI.createSection({ text: "" });
    let heading = section.querySelector(".custom-archive-heading");
    let name = document.createElement("span");
    if (l10nId) {
      document.l10n.setAttributes(name, l10nId);
    } else {
      name.textContent = text;
    }
    let number = document.createElement("span");
    number.className = "custom-calendar-count";
    number.textContent = count;
    if (toggle) {
      let button = document.createElement("button");
      button.type = "button";
      button.className = "custom-calendar-completed-toggle";
      button.setAttribute("aria-expanded", String(this.showCompleted));
      button.append(name, number);
      heading.append(button);
    } else {
      heading.append(name, number);
    }
    return { section, list };
  },

  /**
   * Redraws once a minute while the view is shown, so "today" and overdue
   * times stay right.
   */
  scheduleRefresh() {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      if (!CustomArchiveUI.open || this.panel.hidden) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        return;
      }
      this.onChange();
    }, this.refreshDelay);
  },

  animateAppeared() {
    let row = this.appeared && this.rows.get(this.appeared);
    this.appeared = null;
    if (!row || this.reducedMotion.matches) {
      return;
    }
    row.animate(
      [
        { opacity: 0, translate: "0 -6px" },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: 280, easing: this.easing }
    );
  },

  createRow() {
    let row = document.createElement("li");
    row.className =
      "custom-archive-row custom-archive-link custom-calendar-row";
    row.tabIndex = -1;
    let check = document.createElement("button");
    check.className = "custom-calendar-check";
    check.type = "button";
    check.tabIndex = -1;
    check.setAttribute("role", "checkbox");
    let text = document.createElement("span");
    text.className = "custom-archive-text";
    let title = document.createElement("span");
    title.className = "custom-calendar-title";
    let due = document.createElement("span");
    due.className = "custom-archive-status custom-calendar-due";
    text.append(title, due);
    let more = document.createElement("button");
    more.className = "custom-archive-more";
    more.type = "button";
    more.tabIndex = -1;
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    document.l10n.setAttributes(more, "custom-ui-calendar-more");
    row.append(check, text, more);
    return row;
  },

  /**
   * @param {Element} row
   * @param {object} task
   * @param {object} options
   * @param {boolean} options.showDate Whether the due line names the day,
   *   which a day's own section already does.
   */
  updateRow(row, task, { showDate }) {
    this.rowTasks.set(row, task);
    row.dataset.author = task.author;
    let done = !!task.completedAt || this.completing.has(task.id);
    row.toggleAttribute("done", done);
    let check = row.querySelector(".custom-calendar-check");
    check.setAttribute("aria-checked", String(done));
    document.l10n.setAttributes(check, "custom-ui-calendar-complete", {
      title: task.title,
    });
    row.querySelector(".custom-calendar-title").textContent = task.title;

    let parts = [];
    if (task.dueDate && showDate) {
      parts.push(this.dayName(task.dueDate));
    }
    if (task.dueTime) {
      parts.push(this.formatTime(task.dueTime));
    }
    let due = row.querySelector(".custom-calendar-due");
    due.textContent = parts.join(" ");
    due.hidden = !parts.length;
    let today = this.todayKey;
    row.toggleAttribute(
      "overdue",
      !done &&
        !!task.dueDate &&
        (task.dueDate < today ||
          (task.dueDate == today &&
            !!task.dueTime &&
            task.dueTime < this.nowTime))
    );
  },

  /**
   * The circle completes or reopens the task, the more button opens its
   * menu, and anywhere else edits the title in place.
   */
  onRowClick(event, row) {
    if (
      !this.rowTasks.has(row) ||
      event.button != 0 ||
      event.target.closest(".custom-calendar-edit")
    ) {
      return;
    }
    if (event.target.closest(".custom-calendar-check")) {
      this.toggleComplete(row);
      return;
    }
    let more = event.target.closest(".custom-archive-more");
    if (more) {
      this.openRowMenu(more, row, event.detail == 0);
    } else {
      this.startEdit(row);
    }
  },

  /**
   * Space completes the focused task, Enter and F2 edit it and the context
   * menu key opens its menu.
   *
   * @returns {boolean} Whether the key was used.
   */
  onRowKey(event, row) {
    if (!this.rowTasks.has(row)) {
      return false;
    }
    switch (event.key) {
      case " ":
        this.toggleComplete(row);
        return true;
      case "Enter":
      case "F2":
        this.startEdit(row);
        return true;
      case "ContextMenu":
        this.openRowMenu(row.querySelector(".custom-archive-more"), row, true);
        return true;
    }
    return false;
  },

  /**
   * Checks the circle right away and completes the task a moment later, so
   * the check can be seen and undone before the task moves to the completed
   * section.
   */
  toggleComplete(row) {
    let task = this.rowTasks.get(row);
    let store = this.lazy.CalendarStore;
    if (task.completedAt) {
      store.update(task.id, { completed: false }).catch(console.error);
      return;
    }
    let check = row.querySelector(".custom-calendar-check");
    if (this.completing.has(task.id)) {
      clearTimeout(this.completing.get(task.id));
      this.completing.delete(task.id);
      row.removeAttribute("done");
      check.setAttribute("aria-checked", "false");
      return;
    }
    row.toggleAttribute("done", true);
    check.setAttribute("aria-checked", "true");
    let timer = setTimeout(() => {
      this.completing.delete(task.id);
      if (row.contains(document.activeElement)) {
        this.focusNeighbor(row);
      }
      store.update(task.id, { completed: true }).catch(console.error);
    }, this.completeDelay);
    this.completing.set(task.id, timer);
  },

  focusNeighbor(row) {
    let rows = [...this.panel.querySelectorAll(".custom-calendar-row")].filter(
      item => item.checkVisibility()
    );
    let index = rows.indexOf(row);
    (rows[index + 1] ?? rows[index - 1] ?? this.panel).focus();
  },

  openRowMenu(anchor, row, keyboard) {
    let task = this.rowTasks.get(row);
    let store = this.lazy.CalendarStore;
    let items = [
      { id: "edit", l10nId: "custom-ui-calendar-edit", icon: this.icons.edit },
      {
        id: "date",
        l10nId: "custom-ui-calendar-change-date",
        icon: this.icons.calendar,
        detail: task.dueDate ? this.dayName(task.dueDate) : "",
      },
    ];
    if (task.dueDate) {
      items.push({
        id: "time",
        l10nId: "custom-ui-calendar-change-time",
        icon: this.icons.clock,
        detail: task.dueTime ? this.formatTime(task.dueTime) : "",
      });
    }
    items.push({
      id: "delete",
      l10nId: "custom-ui-calendar-delete",
      icon: this.icons.delete,
    });
    let update = changes => store.update(task.id, changes).catch(console.error);
    this.menu.toggle(anchor, items, {
      position: "bottom-end",
      keyboard,
      onSelect: action => {
        switch (action) {
          case "edit":
            this.startEdit(row);
            break;
          case "date":
            this.openDateMenu(anchor, task.dueDate, keyboard, dueDate =>
              update({ dueDate })
            );
            break;
          case "time":
            this.openTimeMenu(anchor, task.dueTime, keyboard, dueTime =>
              update({ dueTime })
            );
            break;
          case "delete":
            this.deleteTask(row, task);
            break;
        }
      },
    });
  },

  deleteTask(row, task) {
    if (row.contains(document.activeElement)) {
      this.focusNeighbor(row);
    }
    this.lazy.CalendarStore.remove(task.id).catch(console.error);
  },

  /**
   * Turns the title into a field in place. Enter or leaving the field saves,
   * Shift+Enter adds a line and Escape keeps the old title.
   */
  startEdit(row) {
    let task = this.rowTasks.get(row);
    if (
      !task ||
      this.editing ||
      !CustomArchiveUI.container.hasAttribute("sidebar-launcher-expanded")
    ) {
      return;
    }
    let title = row.querySelector(".custom-calendar-title");
    let field = document.createElement("textarea");
    field.className = "custom-calendar-edit";
    field.rows = 1;
    field.spellcheck = false;
    field.value = task.title;
    document.l10n.setAttributes(field, "custom-ui-calendar-edit-field");
    let edit = { row, task, field, title };
    this.editing = edit;
    field.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key == "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.endEdit(edit, { save: true });
      } else if (event.key == "Escape") {
        event.preventDefault();
        this.endEdit(edit, { save: false });
      }
    });
    field.addEventListener("input", () => this.fitTextarea(field));
    field.addEventListener("blur", () => this.endEdit(edit, { save: true }));
    row.toggleAttribute("editing", true);
    title.hidden = true;
    title.after(field);
    this.fitTextarea(field);
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  },

  endEdit(edit, { save }) {
    if (this.editing !== edit) {
      return;
    }
    this.editing = null;
    let { row, task, field, title } = edit;
    let text = field.value.trim();
    let hadFocus = field.matches(":focus");
    row.removeAttribute("editing");
    field.remove();
    title.hidden = false;
    if (save && text && text != task.title) {
      title.textContent = text;
      this.lazy.CalendarStore.update(task.id, { title: text }).catch(
        console.error
      );
    }
    if (hadFocus && row.isConnected) {
      row.focus();
    }
    if (this.renderAfterEdit) {
      this.renderAfterEdit = false;
      this.onChange();
    }
  },

  uninit() {
    this.unloaded = true;
    clearInterval(this.refreshTimer);
    // Completions still waiting for their moment are saved right away.
    for (let [id, timer] of this.completing) {
      clearTimeout(timer);
      this.lazy.CalendarStore.update(id, { completed: true }).catch(
        console.error
      );
    }
    if (this.observing) {
      Services.obs.removeObserver(this, this.lazy.CalendarStore.TOPIC);
    }
  },
};

/**
 * A card at the bottom end of the new tab screen listing the open tasks due
 * today. Closing it hides those tasks for the rest of the day in every
 * window, through `browser.customUI.dueCardDismissed`; a task that becomes
 * due today afterwards brings the card back.
 */
var CustomDueCard = {
  dismissedPref: "browser.customUI.dueCardDismissed",
  maxRows: 3,
  refreshDelay: 60000,

  lazy: {},

  init() {
    ChromeUtils.defineESModuleGetters(this.lazy, {
      CalendarStore: "resource:///modules/calendar/CalendarStore.sys.mjs",
    });
    this.root = document.documentElement;
    this.card = document.getElementById("custom-due-card");
    this.list = document.getElementById("custom-due-list");
    this.count = document.getElementById("custom-due-count");
    this.closeButton = document.getElementById("custom-due-close");
    this.openButton = document.getElementById("custom-due-open");
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.tasks = [];
    this.completing = new Map();
    this.card.addEventListener("click", this);
    Services.prefs.addObserver(this.dismissedPref, this);
    this.rootObserver = new MutationObserver(() => this.update());
    this.rootObserver.observe(this.root, {
      attributes: true,
      attributeFilter: ["custom-newtab"],
    });
    window.addEventListener("unload", this, { once: true });
    this.update();
  },

  get onNewTab() {
    return this.root.hasAttribute("custom-newtab");
  },

  /**
   * Reads the tasks due today, but only while the new tab screen shows, so
   * other pages don't load the calendar.
   */
  async update() {
    if (!this.onNewTab) {
      this.render();
      return;
    }
    if (!this.observing) {
      this.observing = true;
      Services.obs.addObserver(this, this.lazy.CalendarStore.TOPIC);
    }
    let today = CustomCalendarUI.todayKey;
    let request = (this.request = {});
    let tasks = await this.lazy.CalendarStore.getDue(today, today);
    if (this.request !== request || this.unloaded) {
      return;
    }
    this.tasks = tasks;
    this.render();
  },

  readDismissed() {
    try {
      let { day, ids } = JSON.parse(
        Services.prefs.getStringPref(this.dismissedPref, "{}")
      );
      return { day, ids: Array.isArray(ids) ? ids : [] };
    } catch (e) {
      return { day: null, ids: [] };
    }
  },

  render() {
    let today = CustomCalendarUI.todayKey;
    let dismissed = this.readDismissed();
    let show =
      this.onNewTab &&
      this.tasks.some(
        task => dismissed.day != today || !dismissed.ids.includes(task.id)
      );
    this.card.hidden = !show;
    if (!show) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      return;
    }
    this.refreshTimer ??= setInterval(() => this.update(), this.refreshDelay);

    let calendar = CustomCalendarUI;
    let now = calendar.nowTime;
    this.count.textContent = this.tasks.length;
    this.list.replaceChildren(
      ...this.tasks.slice(0, this.maxRows).map(task => {
        let row = document.createElement("li");
        row.className = "custom-due-row";
        row.dataset.id = task.id;
        let done = this.completing.has(task.id);
        row.toggleAttribute("done", done);
        let check = document.createElement("button");
        check.className = "custom-calendar-check";
        check.type = "button";
        check.setAttribute("role", "checkbox");
        check.setAttribute("aria-checked", String(done));
        document.l10n.setAttributes(check, "custom-ui-calendar-complete", {
          title: task.title,
        });
        let text = document.createElement("span");
        text.className = "custom-due-text";
        let title = document.createElement("span");
        title.className = "custom-due-task";
        title.textContent = task.title;
        text.append(title);
        if (task.dueTime) {
          let time = document.createElement("span");
          time.className = "custom-due-time";
          time.textContent = calendar.formatTime(task.dueTime);
          time.toggleAttribute("overdue", task.dueTime < now);
          text.append(time);
        }
        row.append(check, text);
        return row;
      })
    );
    let rest = this.tasks.length - this.maxRows;
    if (rest > 0) {
      document.l10n.setAttributes(this.openButton, "custom-ui-due-more", {
        count: rest,
      });
    } else {
      document.l10n.setAttributes(this.openButton, "custom-ui-due-open");
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "click": {
        if (event.target.closest("#custom-due-close")) {
          this.dismiss();
          return;
        }
        let row = event.target.closest(".custom-due-row");
        if (row && event.target.closest(".custom-calendar-check")) {
          this.complete(row);
        } else if (row || event.target.closest("#custom-due-open")) {
          this.openCalendar();
        }
        break;
      }
      case "unload":
        this.uninit();
        break;
    }
  },

  observe(subject, topic) {
    if (topic == "nsPref:changed") {
      this.render();
    } else {
      this.update();
    }
  },

  /**
   * Checks the circle right away and completes the task a moment later, like
   * the calendar, so the check can be seen and undone.
   */
  complete(row) {
    let { id } = row.dataset;
    let check = row.querySelector(".custom-calendar-check");
    if (this.completing.has(id)) {
      clearTimeout(this.completing.get(id));
      this.completing.delete(id);
      row.removeAttribute("done");
      check.setAttribute("aria-checked", "false");
      return;
    }
    row.toggleAttribute("done", true);
    check.setAttribute("aria-checked", "true");
    let timer = setTimeout(() => {
      this.completing.delete(id);
      this.lazy.CalendarStore.update(id, { completed: true }).catch(
        console.error
      );
    }, CustomCalendarUI.completeDelay);
    this.completing.set(id, timer);
  },

  openCalendar() {
    CustomArchiveUI.setView("calendar");
    CustomArchiveUI.setOpen(true);
  },

  /**
   * Hides today's tasks for the rest of the day, after the card fades out.
   */
  async dismiss() {
    if (this.card.contains(document.activeElement)) {
      gURLBar.focus();
    }
    if (!this.reducedMotion.matches) {
      await this.card
        .animate(
          [
            { opacity: 1, translate: "0 0", scale: 1 },
            { opacity: 0, translate: "0 8px", scale: 0.98 },
          ],
          { duration: 160, easing: "ease-in", fill: "forwards" }
        )
        .finished.catch(() => {});
    }
    Services.prefs.setStringPref(
      this.dismissedPref,
      JSON.stringify({
        day: CustomCalendarUI.todayKey,
        ids: this.tasks.map(task => task.id),
      })
    );
    this.card.getAnimations().forEach(animation => animation.cancel());
  },

  uninit() {
    this.unloaded = true;
    clearInterval(this.refreshTimer);
    for (let [id, timer] of this.completing) {
      clearTimeout(timer);
      this.lazy.CalendarStore.update(id, { completed: true }).catch(
        console.error
      );
    }
    Services.prefs.removeObserver(this.dismissedPref, this);
    this.rootObserver.disconnect();
    if (this.observing) {
      Services.obs.removeObserver(this, this.lazy.CalendarStore.TOPIC);
    }
  },
};

delayedStartupPromise.then(() => CustomDueCard.init());
