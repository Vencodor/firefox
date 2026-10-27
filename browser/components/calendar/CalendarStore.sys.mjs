/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
});

const SCHEMA_VERSION = 1;
const MAX_TITLE_LENGTH = 2000;

/**
 * @typedef {object} CalendarTask
 * @property {string} id A UUID without braces.
 * @property {"task"} kind Always "task" for now; events can join later.
 * @property {string} title Plain text, possibly several lines.
 * @property {string|null} dueDate A local calendar day, "YYYY-MM-DD", like an
 *   all-day event, so it doesn't move with time zones.
 * @property {string|null} dueTime "HH:MM" in 24 hours, only with a due date.
 * @property {number|null} completedAt Milliseconds since the epoch.
 * @property {number} createdAt Milliseconds since the epoch.
 * @property {number} updatedAt Milliseconds since the epoch.
 * @property {"user"|"agent"} author Who added the task, so tasks the agent
 *   adds can be told apart and reviewed.
 */

/**
 * The tasks kept in the profile's calendar.json. It is the only way to read
 * or change them, for the sidebar as well as for the agent, and it tells
 * every window about a change through the `CalendarStore.TOPIC` observer
 * topic, with `{ type: "added"|"updated"|"removed", id }` as JSON data.
 *
 * Every method returns copies, so callers can't change stored tasks in place.
 */
export const CalendarStore = {
  TOPIC: "mono-calendar-changed",

  _file: null,

  async _data() {
    if (!this._file) {
      this._file = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, "calendar.json"),
        dataPostProcessor: data => ({
          version: SCHEMA_VERSION,
          items: Array.isArray(data.items) ? data.items : [],
        }),
      });
    }
    await this._file.load();
    return this._file.data;
  },

  _notify(type, id) {
    Services.obs.notifyObservers(
      null,
      this.TOPIC,
      JSON.stringify({ type, id })
    );
  },

  _title(title) {
    title = String(title ?? "").trim();
    if (!title) {
      throw new Error("A task needs a title.");
    }
    return title.slice(0, MAX_TITLE_LENGTH);
  },

  /**
   * @param {string|null} [date]
   * @returns {string|null} The day if it's a real "YYYY-MM-DD" date.
   */
  _date(date) {
    let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
    if (!match) {
      return null;
    }
    let [year, month, day] = match.slice(1).map(Number);
    let parsed = new Date(year, month - 1, day);
    return parsed.getMonth() == month - 1 && parsed.getDate() == day
      ? date
      : null;
  },

  /**
   * @param {string|null} [time]
   * @returns {string|null} The time if it's a real "HH:MM" time.
   */
  _time(time) {
    let match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
    return match ? time : null;
  },

  /**
   * @param {object} [options]
   * @param {boolean} [options.includeCompleted]
   * @returns {Promise<CalendarTask[]>} The tasks in the order they were added.
   */
  async getAll({ includeCompleted = true } = {}) {
    let { items } = await this._data();
    return items
      .filter(item => includeCompleted || !item.completedAt)
      .map(item => structuredClone(item));
  },

  /**
   * @param {string} id
   * @returns {Promise<CalendarTask|null>}
   */
  async get(id) {
    let { items } = await this._data();
    let item = items.find(task => task.id == id);
    return item ? structuredClone(item) : null;
  },

  /**
   * Lists the open tasks due between two days, both included, by due date
   * and time.
   *
   * @param {string} from "YYYY-MM-DD"
   * @param {string} to "YYYY-MM-DD"
   * @returns {Promise<CalendarTask[]>}
   */
  async getDue(from, to) {
    let tasks = await this.getAll({ includeCompleted: false });
    return tasks
      .filter(
        task => task.dueDate && task.dueDate >= from && task.dueDate <= to
      )
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) ||
          (a.dueTime ?? "").localeCompare(b.dueTime ?? "")
      );
  },

  /**
   * Finds tasks whose title contains every word of the query.
   *
   * @param {string} query
   * @returns {Promise<CalendarTask[]>}
   */
  async search(query) {
    let words = String(query ?? "")
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    let tasks = await this.getAll();
    return tasks.filter(task => {
      let title = task.title.toLocaleLowerCase();
      return words.every(word => title.includes(word));
    });
  },

  /**
   * @param {object} task
   * @param {string} task.title
   * @param {string|null} [task.dueDate] "YYYY-MM-DD"
   * @param {string|null} [task.dueTime] "HH:MM", kept only with a due date.
   * @param {"user"|"agent"} [task.author]
   * @returns {Promise<CalendarTask>}
   */
  async add({ title, dueDate = null, dueTime = null, author = "user" }) {
    let data = await this._data();
    let now = Date.now();
    let date = this._date(dueDate);
    let task = {
      id: Services.uuid.generateUUID().toString().slice(1, -1),
      kind: "task",
      title: this._title(title),
      dueDate: date,
      dueTime: date ? this._time(dueTime) : null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      author: author == "agent" ? "agent" : "user",
    };
    data.items.push(task);
    this._file.saveSoon();
    this._notify("added", task.id);
    return structuredClone(task);
  },

  /**
   * @param {string} id
   * @param {object} changes
   * @param {string} [changes.title]
   * @param {string|null} [changes.dueDate] Clearing it clears the time too.
   * @param {string|null} [changes.dueTime]
   * @param {boolean} [changes.completed]
   * @returns {Promise<CalendarTask|null>} The task, or null if it doesn't
   *   exist.
   */
  async update(id, changes) {
    let { items } = await this._data();
    let task = items.find(item => item.id == id);
    if (!task) {
      return null;
    }
    if ("title" in changes) {
      task.title = this._title(changes.title);
    }
    if ("dueDate" in changes) {
      task.dueDate = this._date(changes.dueDate);
    }
    if ("dueTime" in changes) {
      task.dueTime = this._time(changes.dueTime);
    }
    if (!task.dueDate) {
      task.dueTime = null;
    }
    if ("completed" in changes) {
      task.completedAt = changes.completed ? Date.now() : null;
    }
    task.updatedAt = Date.now();
    this._file.saveSoon();
    this._notify("updated", id);
    return structuredClone(task);
  },

  /**
   * @param {string} id
   * @returns {Promise<boolean>} Whether a task was removed.
   */
  async remove(id) {
    let { items } = await this._data();
    let index = items.findIndex(item => item.id == id);
    if (index == -1) {
      return false;
    }
    items.splice(index, 1);
    this._file.saveSoon();
    this._notify("removed", id);
    return true;
  },
};
