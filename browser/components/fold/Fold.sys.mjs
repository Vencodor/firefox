/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ITEM_KINDS: "resource:///modules/fold/FoldTranscriber.sys.mjs",
  allMatches: "resource:///modules/fold/FoldRules.sys.mjs",
  findRule: "resource:///modules/fold/FoldRules.sys.mjs",
  isFoldAvailable: "resource:///modules/fold/FoldRules.sys.mjs",
  isFoldEnabled: "resource:///modules/fold/FoldRules.sys.mjs",
  setFoldEnabled: "resource:///modules/fold/FoldRules.sys.mjs",
});

const ACTOR = "Fold";
const MAX_SECTIONS = 50;
const MAX_ITEMS = 500;
const MAX_TEXT = 200;
const MAX_URL = 4096;

let registered = false;

function getActor(browser, { report = false } = {}) {
  try {
    return browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR);
  } catch (e) {
    // The page doesn't match any site rule, or it's being torn down.
    if (report) {
      console.warn("Fold: no actor for the page", e);
    }
    return null;
  }
}

function text(value, limit = MAX_TEXT) {
  return typeof value == "string" && value ? value.slice(0, limit) : undefined;
}

function cleanItem(item) {
  let label = text(item?.label);
  if (!label) {
    return null;
  }
  let icon = item.icon ?? {};
  let clean = {
    id: text(item.id) ?? "",
    kind: lazy.ITEM_KINDS.includes(item.kind) ? item.kind : "nav",
    label,
    href: text(item.href, MAX_URL),
    icon: {
      name: text(icon.name),
      image: text(icon.image, MAX_URL),
      letter: text(icon.letter, 1),
    },
    badge: text(item.badge),
    current: item.current === true,
  };
  if (item.secondary) {
    clean.secondary = {
      label: text(item.secondary.label) ?? "",
      pressed: item.secondary.pressed === true,
    };
  }
  return clean;
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
 * The browser side of the site menu: which pages have a site rule, and the
 * messages that ask a page to show, update or act on its site menu.
 */
export const Fold = {
  ensureRegistered() {
    if (registered) {
      return;
    }
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
      matches: lazy.allMatches(),
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
   * Clicks the page element behind an item.
   *
   * @param {Element} browser
   * @param {string} id The item id.
   * @param {string} [part] "secondary" for the item's toggle.
   */
  run(browser, id, part) {
    this.send(browser, "Fold:Run", { id, part });
  },

  send(browser, name, data) {
    try {
      getActor(browser)?.sendAsyncMessage(name, data);
    } catch {
      // The page went away.
    }
  },
};
