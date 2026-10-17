/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import reddit from "resource:///modules/sitesidebar/rules/reddit.sys.mjs";

/**
 * The site rules, one module per site under rules/. A rule tells the
 * transcriber where the site's sidebar is and how its parts map to the site
 * menu model:
 *
 * - id, name: the rule's key and the site name shown as the menu title.
 * - matches: match patterns of the pages the rule applies to.
 * - root: selectors tried in order for the sidebar element; shadow trees are
 *   searched too.
 * - hide: selectors hidden on the page while the site menu is shown, and
 *   css: extra rules for the page layout without them.
 * - ready: { minItems, timeoutMs }. The site menu needs at least minItems
 *   items, waiting up to timeoutMs for the page to render them; otherwise the
 *   page is left alone.
 * - currentIgnoresSearch: whether a link to the current path is the current
 *   item whatever the query string.
 * - main: [{ paths, icon }], top links found by address, in this order.
 * - groups: sections read from repeated containers:
 *   - each: the container of a section, heading: its title inside it.
 *   - items: candidate links and buttons in a section; buttons need text.
 *   - container: the element of one row, searched for its picture and its
 *     secondary toggle.
 *   - secondary: { selector, pressed } for the toggle at the row end.
 *   - kinds, icons: ordered lists of { tag, href, text, external } tests
 *     (all optional, RegExps for href and text) giving an item's kind or
 *     Mono icon.
 *   - sections: [{ heading, kind, collapsed }] for a section whose heading
 *     matches: every item takes `kind`, and `collapsed` makes the section
 *     collapsible, collapsed or not at first.
 */
export const RULES = [reddit];

let matchSets = new Map();

/**
 * The rule for a page address, if any.
 *
 * @param {string} url
 * @returns {?object}
 */
export function findRule(url) {
  if (!url) {
    return null;
  }
  for (let rule of RULES) {
    let set = matchSets.get(rule);
    if (!set) {
      set = new MatchPatternSet(rule.matches);
      matchSets.set(rule, set);
    }
    if (set.matches(url)) {
      return rule;
    }
  }
  return null;
}

export function allMatches() {
  return RULES.flatMap(rule => rule.matches);
}
