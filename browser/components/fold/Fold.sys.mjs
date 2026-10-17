/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ITEM_KINDS: "resource:///modules/fold/FoldRules.sys.mjs",
  allMatches: "resource:///modules/fold/FoldRules.sys.mjs",
  findRule: "resource:///modules/fold/FoldRules.sys.mjs",
  formatCapture: "resource:///modules/fold/FoldCapture.sys.mjs",
  isFoldAvailable: "resource:///modules/fold/FoldRules.sys.mjs",
  isFoldEnabled: "resource:///modules/fold/FoldRules.sys.mjs",
  isSafeIcon: "resource:///modules/fold/FoldRules.sys.mjs",
  setFoldEnabled: "resource:///modules/fold/FoldRules.sys.mjs",
  setRulesForTests: "resource:///modules/fold/FoldRules.sys.mjs",
  shareRules: "resource:///modules/fold/FoldRules.sys.mjs",
});

const ACTOR = "Fold";
const CAPTURE_ACTOR = "FoldCapture";
const MAX_SECTIONS = 50;
const MAX_ITEMS = 500;
const MAX_TEXT = 200;
const MAX_VALUE = 500;
const MAX_URL = 4096;
const MAX_ACTIONS = 8;
const MAX_MENU_ITEMS = 40;
const MAX_DIALOG_ITEMS = 20;
const MAX_DIALOG_TEXT = 600;
const DIALOG_KINDS = ["field", "toggle", "button"];

let registered = false;
let captureRegistered = false;

function getActor(browser, { name = ACTOR, report = false } = {}) {
  try {
    return browser?.browsingContext?.currentWindowGlobal?.getActor(name);
  } catch (e) {
    // The page doesn't match the actor, or it's being torn down.
    if (report) {
      console.warn(`Fold: no ${name} actor for the page`, e);
    }
    return null;
  }
}

function text(value, limit = MAX_TEXT) {
  return typeof value == "string" && value ? value.slice(0, limit) : undefined;
}

function flag(value) {
  return typeof value == "boolean" ? value : undefined;
}

function cleanIcon(icon) {
  if (!icon || typeof icon != "object") {
    return undefined;
  }
  return {
    name: text(icon.name),
    image: text(icon.image, MAX_URL),
    svg: lazy.isSafeIcon(icon.svg) ? icon.svg : undefined,
    letter: text(icon.letter, 1),
  };
}

function cleanAction(action) {
  let label = text(action?.label);
  if (!label) {
    return null;
  }
  return {
    id: text(action.id) ?? "",
    label,
    icon: cleanIcon(action.icon),
    pressed: flag(action.pressed),
    popup: action.popup === true || undefined,
  };
}

function cleanItem(item) {
  let label = text(item?.label);
  if (!label) {
    return null;
  }
  let clean = {
    id: text(item.id) ?? "",
    kind: lazy.ITEM_KINDS.includes(item.kind) ? item.kind : "nav",
    label,
    href: text(item.href, MAX_URL),
    icon: cleanIcon(item.icon),
    badge: text(item.badge),
    current: item.current === true,
    popup: item.popup === true || undefined,
  };
  if (Array.isArray(item.actions)) {
    let actions = item.actions
      .slice(0, MAX_ACTIONS)
      .map(cleanAction)
      .filter(Boolean);
    if (actions.length) {
      clean.actions = actions;
    }
  }
  if (clean.kind == "field") {
    clean.value =
      typeof item.value == "string" ? item.value.slice(0, MAX_VALUE) : "";
    clean.placeholder = text(item.placeholder);
    clean.inputType = item.inputType == "text" ? "text" : "search";
  } else if (clean.kind == "toggle") {
    clean.checked = item.checked === true;
  }
  return clean;
}

/**
 * @param {*} menu A menu the page read with readMenu.
 * @returns {?object[]} Its items as { id, label, checked?, disabled? }.
 */
function cleanMenu(menu) {
  if (!Array.isArray(menu?.items)) {
    return null;
  }
  return menu.items
    .slice(0, MAX_MENU_ITEMS)
    .map(item => {
      let label = text(item?.label);
      return label
        ? {
            id: text(item.id) ?? "",
            label,
            checked: flag(item.checked),
            disabled: item.disabled === true || undefined,
          }
        : null;
    })
    .filter(Boolean);
}

/**
 * Keeps only what the sidebar draws from a site menu model, as strings and
 * flags of bounded size. The model comes from a web content process, so the
 * window must not trust its shape.
 *
 * @param {*} model
 * @returns {?object}
 */
export function cleanModel(model) {
  if (!Array.isArray(model?.sections)) {
    return null;
  }
  let left = MAX_ITEMS;
  let sections = model.sections.slice(0, MAX_SECTIONS).map(section => {
    let items = Array.isArray(section?.items) ? section.items : [];
    items = items.slice(0, Math.max(left, 0)).map(cleanItem).filter(Boolean);
    left -= items.length;
    return {
      id: text(section?.id) ?? "",
      heading: text(section?.heading),
      collapsible: section?.collapsible === true,
      collapsed: section?.collapsed === true,
      toggleId: text(section?.toggleId),
      items,
    };
  });
  return { site: { name: text(model.site?.name) ?? "" }, sections };
}

/**
 * @param {*} dialog A dialog the page read with readDialog.
 * @returns {?object} { title, text, items }, its items as
 *   { id, kind, label, value?, placeholder?, checked?, disabled? }.
 */
function cleanDialog(dialog) {
  if (!dialog || typeof dialog != "object" || !Array.isArray(dialog.items)) {
    return null;
  }
  let items = dialog.items
    .slice(0, MAX_DIALOG_ITEMS)
    .map(item => {
      let label = text(item?.label);
      if (!label || !DIALOG_KINDS.includes(item.kind)) {
        return null;
      }
      return {
        id: text(item.id) ?? "",
        kind: item.kind,
        label,
        value:
          item.kind == "field" && typeof item.value == "string"
            ? item.value.slice(0, MAX_VALUE)
            : undefined,
        placeholder: text(item.placeholder),
        checked: item.kind == "toggle" ? item.checked === true : undefined,
        disabled: item.disabled === true || undefined,
      };
    })
    .filter(Boolean);
  return {
    title: text(dialog.title) ?? "",
    text: text(dialog.text, MAX_DIALOG_TEXT) ?? "",
    items,
  };
}

/**
 * The browser side of the site menu: which pages have a site rule, and the
 * messages that ask a page to show, update or act on its site menu.
 */
export const Fold = {
  ensureRegistered() {
    if (registered) {
      return;
    }
    let matches = lazy.allMatches();
    if (!matches.length) {
      // Without matches the actor would run on every page.
      return;
    }
    lazy.shareRules();
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: {
        esModuleURI: "resource:///actors/FoldParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///actors/FoldChild.sys.mjs",
        events: {
          DOMDocElementInserted: {},
          DOMContentLoaded: {},
          pageshow: { createActor: false },
          pagehide: { createActor: false },
        },
      },
      matches,
      messageManagerGroups: ["browsers"],
      // Sites run in web content processes. Whatever the page sends is only
      // drawn as text by the sidebar, and links are checked before opening.
      safeForUntrustedWebProcess: true,
    });
    registered = true;
  },

  /**
   * @param {nsIURI} uri
   * @returns {?{id: string, name: string}} The site rule for a page, if any.
   */
  ruleFor(uri) {
    let rule = lazy.findRule(uri?.spec);
    return rule ? { id: rule.id, name: rule.name } : null;
  },

  /**
   * @param {string} id A rule's id.
   * @returns {boolean} Whether Fold is on for the rule's site.
   */
  isEnabledFor(id) {
    return lazy.isFoldEnabled({ id });
  },

  /**
   * @returns {boolean} Whether Fold is on and the sidebar it needs is in use.
   */
  isAvailable() {
    return lazy.isFoldAvailable();
  },

  /**
   * Turns Fold on or off for a site. Its open pages fold or unfold at once.
   *
   * @param {string} id A rule's id.
   * @param {boolean} enabled
   */
  setEnabledFor(id, enabled) {
    lazy.setFoldEnabled(id, enabled);
  },

  /**
   * Hides the page's sidebar and reads its site menu, waiting for the page to
   * render it. Asking again reads the menu again.
   *
   * @param {Element} browser
   * @returns {Promise<?object>} The site menu model, or null when the page's
   *   sidebar couldn't be read and was left as it is.
   */
  async activate(browser) {
    let actor = getActor(browser, { report: true });
    if (!actor) {
      return null;
    }
    try {
      let result = await actor.sendQuery("Fold:Activate");
      return cleanModel(result?.model);
    } catch (e) {
      // A page left while it was being read is not an error.
      if (e.name != "AbortError") {
        console.error("Fold: activating the page failed", e);
      }
      return null;
    }
  },

  deactivate(browser) {
    this.send(browser, "Fold:Deactivate");
  },

  /**
   * Clicks the page element behind an item, an action, a section title, an
   * item of a site menu opened with openPopup or a dialog button.
   *
   * @param {Element} browser
   * @param {string} id
   * @returns {Promise<?object>} A dialog the click opened, read for the Mono
   *   sidebar and concealed on the page, or null.
   */
  async run(browser, id) {
    let actor = getActor(browser);
    if (!actor) {
      return null;
    }
    try {
      return cleanDialog((await actor.sendQuery("Fold:Run", { id }))?.dialog);
    } catch (e) {
      // A click that leaves the page ends the query.
      if (e.name != "AbortError") {
        console.error("Fold: clicking the page failed", e);
      }
      return null;
    }
  },

  /**
   * @param {Element} browser
   * @returns {Promise<?object>} The dialog a click opened, as it is now, or
   *   null once the site closed it.
   */
  async readDialog(browser) {
    let actor = getActor(browser);
    if (!actor) {
      return null;
    }
    try {
      return cleanDialog((await actor.sendQuery("Fold:ReadDialog"))?.dialog);
    } catch {
      return null;
    }
  },

  /**
   * Closes the relayed dialog like Escape does on the page.
   *
   * @param {Element} browser
   */
  closeDialog(browser) {
    this.send(browser, "Fold:CloseDialog");
  },

  /**
   * Reads the navigation of the selected page for writing or fixing its
   * site rule, see mono/skills/fold-site.
   *
   * @param {Element} browser
   * @returns {Promise<?string>} The capture as text to hand to an AI, or null
   *   when the page can't be captured.
   */
  async capture(browser) {
    if (!captureRegistered) {
      // Registered on first use and without events, so it's only created
      // for the page being captured.
      ChromeUtils.registerWindowActor(CAPTURE_ACTOR, {
        parent: {
          esModuleURI: "resource:///actors/FoldCaptureParent.sys.mjs",
        },
        child: {
          esModuleURI: "resource:///actors/FoldCaptureChild.sys.mjs",
        },
        matches: ["*://*/*"],
        messageManagerGroups: ["browsers"],
        safeForUntrustedWebProcess: true,
      });
      captureRegistered = true;
    }
    let actor = getActor(browser, { name: CAPTURE_ACTOR });
    if (!actor) {
      return null;
    }
    try {
      let capture = await actor.sendQuery("FoldCapture:Capture");
      return capture ? lazy.formatCapture(capture) : null;
    } catch (e) {
      console.error("Fold: capturing the page failed", e);
      return null;
    }
  },

  /**
   * Has the page fold or unfold its sidebar as Fold is set for its site. The
   * page does this itself as it loads; this covers pages that started before
   * the actor was registered or missed it.
   *
   * @param {Element} browser
   * @param {boolean} enabled
   */
  sync(browser, enabled) {
    this.send(browser, "Fold:Sync", { enabled });
  },

  /**
   * Types into the page's text field behind a field item.
   *
   * @param {Element} browser
   * @param {string} id The item id.
   * @param {string} value
   * @param {object} [options]
   * @param {boolean} [options.submit] Whether to submit it like Enter does.
   */
  input(browser, id, value, { submit = false } = {}) {
    this.send(browser, "Fold:Input", { id, value, submit });
  },

  /**
   * Opens the site's menu behind an item or action and reads it.
   *
   * @param {Element} browser
   * @param {string} id The item or action id.
   * @returns {Promise<?object>} { items } for a menu, { dialog } when the
   *   button opened a dialog instead, or null if nothing opened.
   */
  async openPopup(browser, id) {
    let actor = getActor(browser);
    if (!actor) {
      return null;
    }
    try {
      let result = await actor.sendQuery("Fold:OpenPopup", { id });
      if (result?.dialog) {
        let dialog = cleanDialog(result.dialog);
        return dialog ? { dialog } : null;
      }
      let items = cleanMenu(result);
      return items ? { items } : null;
    } catch (e) {
      if (e.name != "AbortError") {
        console.error("Fold: opening the site's menu failed", e);
      }
      return null;
    }
  },

  closePopup(browser) {
    this.send(browser, "Fold:ClosePopup");
  },

  /**
   * Replaces the site rules in tests, or goes back to rules/ with null, and
   * registers the actor again for them.
   *
   * @param {?object[]} rules Rules as written.
   */
  setRulesForTests(rules) {
    if (registered) {
      ChromeUtils.unregisterWindowActor(ACTOR);
      registered = false;
    }
    lazy.setRulesForTests(rules);
    this.ensureRegistered();
  },

  send(browser, name, data) {
    try {
      getActor(browser)?.sendAsyncMessage(name, data);
    } catch {
      // The page went away.
    }
  },
};
