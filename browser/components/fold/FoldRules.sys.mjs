/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The site rules: one JSON file per site under rules/, listed by id in
 * rules/index.json. A rule tells the transcriber where the site's sidebar is
 * and how its parts map to the site menu model. Fold aims to carry every
 * function of the site's sidebar over, so whatever a rule doesn't read is
 * reported by checkCapture.
 *
 * - id: the rule's key, also its file name. name: the site name.
 * - description: notes for whoever edits the rule; not read.
 * - matches: match patterns of the pages the rule applies to.
 * - root: selectors tried in order for the sidebar element; shadow trees are
 *   searched too, and each selector is matched within its own tree.
 * - hide: selectors of the sidebar to conceal while Fold is on. They stay
 *   laid out and rendered, so the site keeps loading what they hold, but
 *   aren't drawn, take no space or clicks. Selectors match inside shadow
 *   trees too, each within its own tree.
 * - remove: selectors to take out of the layout entirely (display: none),
 *   such as the button that opens the site's sidebar.
 * - css: extra rules, as a string or a list of lines, for the page layout
 *   without the sidebar.
 * - ready: { minItems, timeoutMs }. The site menu needs at least minItems
 *   items, waiting up to timeoutMs for the page to render them; otherwise the
 *   page is left alone.
 * - current: how the current item is found. "auto" (the default) takes
 *   aria-current, aria-selected or currentSelector on the item or its row,
 *   and the address otherwise. "url" uses the address only, for sites whose
 *   markers lag behind; "marker" the markers only, for sites whose view
 *   changes without the address.
 * - currentSelector: a selector marking the current item or its row.
 * - currentIgnoresSearch: whether a link to the current path is the current
 *   item whatever the query string.
 * - exclude: selectors of elements that are not read at all, with what's in
 *   them, such as the site's own sidebar collapse button.
 * - customIcons: { name: "<svg ...>" }, icons for this site's items, named
 *   like the Mono icons. The SVG holds shapes only.
 * - siteIcons: false to not use the site's own SVG icons for items with no
 *   named icon. They're drawn in the Mono color.
 * - main: [{ paths, icon }], top links found by address, in this order.
 * - groups: sections read from repeated containers:
 *   - each: the container of a section, heading: its title inside it. The
 *     button around the title, or a details summary, toggles the section and
 *     is never read as an item.
 *   - items: links, buttons and controls in a section. Text fields become
 *     field items and checkboxes or switches toggle items. Elements without
 *     text are named by their accessible name.
 *   - container: the element of one row. The row's first link, or its first
 *     element, is the item; the other elements in the row become its
 *     actions, like a favorite star or a menu button.
 *   - pressed: a selector marking a row action, or what's inside it, as on.
 *   - secondary: { selector, pressed }, the older form of `pressed`.
 *   - kinds, icons: ordered lists of { tag, href, text, external } tests
 *     (all optional) giving an item's kind or icon.
 *   - sections: [{ heading, kind, collapsed }] for a section whose heading
 *     matches: every item takes `kind`, and `collapsed` makes the section
 *     collapsible, collapsed or not at first. Otherwise a section is
 *     collapsible when it's a details element or its title button has
 *     aria-expanded, starts as the page shows it, and toggling it in the
 *     sidebar toggles it on the page.
 * - extras: [{ items, heading, at, kind }], sections of elements found
 *   anywhere in the sidebar, before ("start") or after ("end", the default)
 *   the others, such as a search field above the links.
 *
 * Icons named by a rule are Mono icons (ICON_NAMES), the rule's customIcons,
 * or "site" for the site's own icon. href, text and heading tests are regular
 * expressions, written as strings and matched without regard to case. href
 * is tested against the path.
 *
 * The parent process reads the files and hands them to content processes
 * through shared data, so they don't read files themselves.
 */

export const ITEM_KINDS = [
  "nav",
  "entity",
  "action",
  "link",
  "field",
  "toggle",
];

/**
 * The Mono icons a rule may name, in browser/base/content/custom-ui/
 * resources/fold/.
 */
export const ICON_NAMES = [
  "add",
  "all",
  "answers",
  "explore",
  "home",
  "link",
  "more",
  "news",
  "settings",
  "trending",
];

const MAX_SVG = 8192;

/**
 * Whether an SVG icon only draws shapes: no scripts, event handlers, foreign
 * content or references outside itself. Icons come from rules and, read from
 * the page, from web content processes.
 *
 * @param {*} svg
 * @returns {boolean}
 */
export function isSafeIcon(svg) {
  return (
    typeof svg == "string" &&
    svg.length <= MAX_SVG &&
    /^<svg[\s>]/.test(svg) &&
    !/<(script|foreignObject|style|iframe|image|a)[\s>/]/i.test(svg) &&
    !/\son\w+\s*=/i.test(svg) &&
    !/(href|src)\s*=(?!\s*["']?\s*#)/i.test(svg) &&
    !/url\((?!\s*["']?\s*#)/i.test(svg)
  );
}

const RULES_URL = "resource:///modules/fold/rules/";
const SHARED_KEY = "Fold:rules";

let ruleData = null;
let compiledRules = null;
let testRules = null;
let matchSets = new WeakMap();
let listening = false;

function readJSON(name) {
  let { NetUtil } = ChromeUtils.importESModule(
    "resource://gre/modules/NetUtil.sys.mjs"
  );
  let stream = NetUtil.newChannel({
    uri: RULES_URL + name,
    loadUsingSystemPrincipal: true,
  }).open();
  try {
    return JSON.parse(
      NetUtil.readInputStreamToString(stream, stream.available(), {
        charset: "UTF-8",
      })
    );
  } finally {
    stream.close();
  }
}

/**
 * @returns {string[]} The ids listed in rules/index.json.
 */
export function readRuleIndex() {
  return readJSON("index.json");
}

/**
 * The rules listed in rules/index.json. Rules that fail validation are left
 * out and reported.
 *
 * @returns {object[]} The rules as written.
 */
export function readRuleFiles() {
  let rules = [];
  for (let id of readRuleIndex()) {
    try {
      let rule = readJSON(`${id}.json`);
      let problems = validateRule(rule);
      if (rule.id != id) {
        problems.push(`id "${rule.id}" doesn't match its file name`);
      }
      if (problems.length) {
        console.error(`Fold: rule ${id} is invalid:\n${problems.join("\n")}`);
        continue;
      }
      rules.push(rule);
    } catch (e) {
      console.error(`Fold: rule ${id} couldn't be read`, e);
    }
  }
  return rules;
}

function getRuleData() {
  if (ruleData) {
    return ruleData;
  }
  if (Services.appinfo.processType == Services.appinfo.PROCESS_TYPE_DEFAULT) {
    ruleData = testRules ?? readRuleFiles();
    return ruleData;
  }
  if (!listening) {
    listening = true;
    Services.cpmm.sharedData.addEventListener("change", event => {
      if (event.changedKeys.includes(SHARED_KEY)) {
        ruleData = compiledRules = null;
      }
    });
  }
  ruleData = Services.cpmm.sharedData.get(SHARED_KEY) ?? null;
  return ruleData;
}

/**
 * Replaces the rules read from rules/ in tests, or goes back to them with
 * null. Fold.setRulesForTests also shares them and registers the actor again.
 *
 * @param {?object[]} rules Rules as written.
 */
export function setRulesForTests(rules) {
  testRules = rules;
  ruleData = compiledRules = null;
  matchSets = new WeakMap();
}

/**
 * Hands the rules to content processes. Called before the actor that uses
 * them is registered.
 */
export function shareRules() {
  Services.ppmm.sharedData.set(SHARED_KEY, getRuleData());
  Services.ppmm.sharedData.flush();
}

function pattern(source) {
  return source == undefined ? undefined : new RegExp(source, "i");
}

function compileTests(tests) {
  return tests?.map(test => ({
    ...test,
    href: pattern(test.href),
    text: pattern(test.text),
  }));
}

/**
 * The rule in the form the transcriber reads: tests as RegExps and css as
 * one string.
 *
 * @param {object} rule A valid rule as written.
 * @returns {object}
 */
export function compileRule(rule) {
  let compiled = {
    ...rule,
    remove: rule.remove ?? [],
    exclude: rule.exclude?.length ? rule.exclude.join(", ") : null,
    customIcons: rule.customIcons ?? {},
    css: Array.isArray(rule.css) ? rule.css.join("\n") : (rule.css ?? ""),
  };
  if (rule.groups) {
    compiled.groups = {
      ...rule.groups,
      kinds: compileTests(rule.groups.kinds),
      icons: compileTests(rule.groups.icons),
      sections: rule.groups.sections?.map(section => ({
        ...section,
        heading: pattern(section.heading),
      })),
    };
  }
  return compiled;
}

/**
 * @returns {object[]} The compiled rules.
 */
export function getRules() {
  if (!compiledRules) {
    let data = getRuleData();
    if (!data) {
      return [];
    }
    compiledRules = data.map(compileRule);
  }
  return compiledRules;
}

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
  for (let rule of getRules()) {
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
  return getRules().flatMap(rule => rule.matches);
}

const RULE_KEYS = new Set([
  "id",
  "name",
  "description",
  "matches",
  "root",
  "hide",
  "remove",
  "css",
  "ready",
  "current",
  "currentSelector",
  "currentIgnoresSearch",
  "exclude",
  "customIcons",
  "siteIcons",
  "main",
  "groups",
  "extras",
]);
const GROUP_KEYS = new Set([
  "each",
  "heading",
  "items",
  "container",
  "pressed",
  "secondary",
  "kinds",
  "icons",
  "sections",
]);
const EXTRA_KEYS = new Set(["items", "heading", "at", "kind"]);
const TEST_KEYS = new Set(["tag", "href", "text", "external"]);

/**
 * Checks a rule as written, without a page. Selectors are only checked
 * against a page, see FoldCapture's checkCapture.
 *
 * @param {*} rule
 * @returns {string[]} The problems found, empty for a valid rule.
 */
export function validateRule(rule) {
  let problems = [];
  let check = (ok, message) => {
    if (!ok) {
      problems.push(message);
    }
    return ok;
  };
  let isString = value => typeof value == "string" && !!value.trim();
  let isStringList = (value, { empty = false } = {}) =>
    Array.isArray(value) && (empty || !!value.length) && value.every(isString);
  let isPattern = (value, where) => {
    if (!check(isString(value), `${where} must be a regular expression`)) {
      return;
    }
    try {
      new RegExp(value, "i");
    } catch (e) {
      problems.push(`${where} is not a valid regular expression: ${e.message}`);
    }
  };
  let checkKeys = (object, keys, where) => {
    for (let key of Object.keys(object)) {
      check(keys.has(key), `${where} has an unknown key "${key}"`);
    }
  };

  if (!check(rule && typeof rule == "object", "a rule must be an object")) {
    return problems;
  }
  checkKeys(rule, RULE_KEYS, "the rule");
  check(
    typeof rule.id == "string" && /^[a-z0-9][a-z0-9-]*$/.test(rule.id),
    "id must be lowercase letters, digits and dashes"
  );
  check(isString(rule.name), "name must be a string");
  check(
    rule.description == undefined || typeof rule.description == "string",
    "description must be a string"
  );
  if (check(isStringList(rule.matches), "matches must list match patterns")) {
    for (let match of rule.matches) {
      try {
        if (typeof MatchPattern == "function") {
          new MatchPattern(match);
        }
      } catch {
        problems.push(`"${match}" is not a valid match pattern`);
      }
    }
  }
  check(isStringList(rule.root), "root must list selectors");
  for (let key of ["hide", "remove", "exclude"]) {
    if (key == "hide" || rule[key] != undefined) {
      check(
        isStringList(rule[key], { empty: true }) &&
          !rule[key].some(selector => selector.includes(">>>")),
        `${key} must list selectors, each within one tree (no ">>>")`
      );
    }
  }
  let iconNames = new Set(ICON_NAMES).add("site");
  if (
    rule.customIcons != undefined &&
    check(
      rule.customIcons && typeof rule.customIcons == "object",
      "customIcons must be an object"
    )
  ) {
    for (let [name, svg] of Object.entries(rule.customIcons)) {
      check(
        /^[a-z0-9][a-z0-9-]*$/.test(name),
        `customIcons "${name}" must be lowercase letters, digits and dashes`
      );
      check(
        isSafeIcon(svg),
        `customIcons.${name} must be an <svg> of at most ${MAX_SVG} characters with shapes only`
      );
      iconNames.add(name);
    }
  }
  let iconList = [...iconNames].join(", ");
  check(
    rule.siteIcons == undefined || typeof rule.siteIcons == "boolean",
    "siteIcons must be true or false"
  );
  check(
    rule.css == undefined ||
      typeof rule.css == "string" ||
      isStringList(rule.css, { empty: true }),
    "css must be a string or a list of lines"
  );
  if (rule.ready != undefined) {
    let { minItems = 1, timeoutMs = 0 } = rule.ready;
    check(
      Number.isInteger(minItems) && minItems >= 1,
      "ready.minItems must be a positive integer"
    );
    check(
      Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 15000,
      "ready.timeoutMs must be an integer from 0 to 15000"
    );
  }
  check(
    rule.current == undefined ||
      ["auto", "url", "marker"].includes(rule.current),
    'current must be "auto", "url" or "marker"'
  );
  check(
    rule.currentSelector == undefined || isString(rule.currentSelector),
    "currentSelector must be a selector"
  );
  check(
    rule.currentIgnoresSearch == undefined ||
      typeof rule.currentIgnoresSearch == "boolean",
    "currentIgnoresSearch must be true or false"
  );
  if (
    rule.main != undefined &&
    check(Array.isArray(rule.main), "main must be a list")
  ) {
    rule.main.forEach((entry, i) => {
      check(
        isStringList(entry?.paths) &&
          entry.paths.every(path => path.startsWith("/")),
        `main[${i}].paths must list paths starting with "/"`
      );
      check(
        iconNames.has(entry?.icon),
        `main[${i}].icon must be one of ${iconList}`
      );
    });
  }
  if (
    rule.extras != undefined &&
    check(Array.isArray(rule.extras), "extras must be a list")
  ) {
    rule.extras.forEach((extra, i) => {
      let where = `extras[${i}]`;
      if (
        !check(extra && typeof extra == "object", `${where} must be an object`)
      ) {
        return;
      }
      checkKeys(extra, EXTRA_KEYS, where);
      check(isString(extra.items), `${where}.items must be a selector`);
      check(
        extra.heading == undefined || isString(extra.heading),
        `${where}.heading must be a string`
      );
      check(
        extra.at == undefined || ["start", "end"].includes(extra.at),
        `${where}.at must be "start" or "end"`
      );
      check(
        extra.kind == undefined || ITEM_KINDS.includes(extra.kind),
        `${where}.kind must be one of ${ITEM_KINDS.join(", ")}`
      );
    });
  }

  let groups = rule.groups;
  if (
    groups == undefined ||
    !check(typeof groups == "object", "groups must be an object")
  ) {
    return problems;
  }
  checkKeys(groups, GROUP_KEYS, "groups");
  check(isString(groups.each), "groups.each must be a selector");
  check(isString(groups.items), "groups.items must be a selector");
  for (let key of ["heading", "container", "pressed"]) {
    check(
      groups[key] == undefined || isString(groups[key]),
      `groups.${key} must be a selector`
    );
  }
  if (groups.secondary != undefined) {
    check(
      isString(groups.secondary?.selector) &&
        (groups.secondary.pressed == undefined ||
          isString(groups.secondary.pressed)),
      "groups.secondary must be { selector, pressed }"
    );
  }
  for (let [key, field, values] of [
    ["kinds", "kind", ITEM_KINDS],
    ["icons", "icon", [...iconNames]],
  ]) {
    if (
      groups[key] == undefined ||
      !check(Array.isArray(groups[key]), `groups.${key} must be a list`)
    ) {
      continue;
    }
    groups[key].forEach((test, i) => {
      let where = `groups.${key}[${i}]`;
      if (
        !check(test && typeof test == "object", `${where} must be an object`)
      ) {
        return;
      }
      checkKeys(test, new Set([...TEST_KEYS, field]), where);
      check(
        values.includes(test[field]),
        `${where}.${field} must be one of ${values.join(", ")}`
      );
      for (let name of ["href", "text"]) {
        if (test[name] != undefined) {
          isPattern(test[name], `${where}.${name}`);
        }
      }
      check(
        test.tag == undefined || isString(test.tag),
        `${where}.tag must be a tag name`
      );
      check(
        test.external == undefined || typeof test.external == "boolean",
        `${where}.external must be true or false`
      );
    });
  }
  if (
    groups.sections != undefined &&
    check(Array.isArray(groups.sections), "groups.sections must be a list")
  ) {
    groups.sections.forEach((section, i) => {
      let where = `groups.sections[${i}]`;
      isPattern(section?.heading, `${where}.heading`);
      check(
        section?.kind == undefined || ITEM_KINDS.includes(section.kind),
        `${where}.kind must be one of ${ITEM_KINDS.join(", ")}`
      );
      check(
        section?.collapsed == undefined ||
          typeof section.collapsed == "boolean",
        `${where}.collapsed must be true or false`
      );
    });
  }
  return problems;
}

// The menu shows in the Mono UI's vertical tab sidebar, so a sidebar is only
// folded away while that sidebar is there to take it.
const REQUIRED_PREFS = [
  "browser.customUI.enabled",
  "sidebar.verticalTabs",
  "browser.customUI.fold.enabled",
];
const DISABLED_SITES_PREF = "browser.customUI.fold.disabledSites";

/**
 * The prefs that decide whether Fold is on for a site.
 */
export const FOLD_PREFS = [...REQUIRED_PREFS, DISABLED_SITES_PREF];

/**
 * @returns {boolean} Whether Fold is on and the sidebar it needs is in use.
 */
export function isFoldAvailable() {
  return REQUIRED_PREFS.every(pref => Services.prefs.getBoolPref(pref, false));
}

/**
 * @returns {string[]} The ids of the rules the user turned Fold off for.
 */
export function disabledSites() {
  try {
    let ids = JSON.parse(
      Services.prefs.getStringPref(DISABLED_SITES_PREF, "[]")
    );
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

/**
 * @param {?object} rule A site rule, or { id } for one.
 * @returns {boolean} Whether Fold folds the sidebar of the rule's site.
 */
export function isFoldEnabled(rule) {
  return !!rule && isFoldAvailable() && !disabledSites().includes(rule.id);
}

/**
 * Turns Fold on or off for one site.
 *
 * @param {string} id The rule's id.
 * @param {boolean} enabled
 */
export function setFoldEnabled(id, enabled) {
  let ids = disabledSites().filter(other => other != id);
  if (!enabled) {
    ids.push(id);
  }
  Services.prefs.setStringPref(DISABLED_SITES_PREF, JSON.stringify(ids));
}
