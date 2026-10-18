/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  ICON_NAMES,
  isSafeIcon,
} from "resource:///modules/fold/FoldRules.sys.mjs";

/**
 * Reads a site's own sidebar into the site menu model, following the site's
 * rule (see FoldRules). The model only carries what the Mono sidebar draws:
 *
 *   { site: { name },
 *     sections: [{ id, heading?, collapsible?, collapsed?, toggleId?,
 *                  items: [item] }] }
 *
 * An item is { id, kind, label, href?, icon?, badge?, current?, actions? },
 * with value, placeholder and inputType for a field and checked for a
 * toggle. `kind` is one of FoldRules' ITEM_KINDS; the sidebar draws each kind
 * with its own row, so a new kind is added here and in the sidebar together.
 * `icon` is { name } for a Mono icon, { svg } for an icon drawn in the Mono
 * color, { image } for the site's picture or { letter } for an entity
 * without one. `actions` are the other controls of the item's row:
 * [{ id, label, icon?, pressed?, popup? }], where pressed is set for a toggle
 * like a favorite star and popup for a button that opens the site's menu.
 * An item that opens the site's menu itself, like an overflow button, has
 * popup too.
 *
 * Nothing on the page is changed here. The elements behind the model are
 * returned so that the actor can click them for the user.
 */

const SKIPPED_TEXT = new Set([
  "img",
  "mat-icon",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
]);
// Icon fonts spell their icon's name as text.
const ICON_FONT = /\b(material-(icons|symbols)[\w-]*|google-symbols)\b/;
const BADGE = /^[A-Z][A-Z0-9]{1,7}$/;
const LABEL_LIMIT = 120;
const VALUE_LIMIT = 500;
const MAX_ACTIONS = 8;
// How far up from a button aria-haspopup is looked for.
const MENU_WRAPPERS = 3;
const CONTROLS = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='searchbox']",
].join(", ");
const SECTION_TOGGLE = "button, summary, [role='button'], [aria-expanded]";
const FIELD_TYPES = new Set(["", "text", "search", "email", "url", "tel"]);
const TOGGLE_ROLES = new Set([
  "switch",
  "checkbox",
  "radio",
  "menuitemcheckbox",
  "menuitemradio",
]);
const SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "rect",
  "defs",
  "symbol",
  "use",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
]);
const SVG_ATTRIBUTES = new Set([
  "viewBox",
  "d",
  "fill",
  "fill-rule",
  "fill-opacity",
  "clip-rule",
  "clip-path",
  "mask",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
  "transform",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "points",
  "id",
  "href",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "preserveAspectRatio",
]);

export function shadowOf(element) {
  return element.openOrClosedShadowRoot ?? element.shadowRoot ?? null;
}

/**
 * The parent of a node, crossing from a shadow root to its host.
 *
 * @param {Node} node
 * @returns {?Node}
 */
export function parentOf(node) {
  let parent = node.parentNode;
  if (parent && parent.nodeType == parent.DOCUMENT_FRAGMENT_NODE) {
    return parent.host ?? null;
  }
  return parent;
}

/**
 * Walks elements below a node, shadow trees included, and remembers every
 * shadow root it entered so they can be watched for changes.
 */
class Walker {
  constructor() {
    this.shadowRoots = new Set();
  }

  queryAll(root, selector, results = []) {
    for (let element of root.children) {
      if (element.matches(selector)) {
        results.push(element);
      }
      let shadow = shadowOf(element);
      if (shadow) {
        this.shadowRoots.add(shadow);
        this.queryAll(shadow, selector, results);
      }
      this.queryAll(element, selector, results);
    }
    return results;
  }

  query(root, selector) {
    for (let element of root.children) {
      if (element.matches(selector)) {
        return element;
      }
      let shadow = shadowOf(element);
      if (shadow) {
        this.shadowRoots.add(shadow);
      }
      let found =
        (shadow && this.query(shadow, selector)) ||
        this.query(element, selector);
      if (found) {
        return found;
      }
    }
    return null;
  }
}

/**
 * The first element matching a selector below a node, shadow trees included.
 *
 * @param {Node} root
 * @param {string} selector
 * @returns {?Element}
 */
export function queryDeep(root, selector) {
  return new Walker().query(root, selector);
}

/**
 * @param {Node} root
 * @param {string} selector
 * @returns {Element[]} The elements matching a selector below a node, shadow
 *   trees included.
 */
export function queryAllDeep(root, selector) {
  return new Walker().queryAll(root, selector);
}

/**
 * The visible text of a node as separate pieces, read in rendered order:
 * a shadow tree replaces its host's children and a slot shows what it holds.
 *
 * @param {Node} node
 * @param {object} [options]
 * @param {boolean} [options.all] Whether to read text hidden from assistive
 *   technology too.
 * @param {string[]} [pieces] The pieces found so far.
 * @returns {string[]}
 */
function textPieces(node, { all = false } = {}, pieces = []) {
  if (node.nodeType == node.TEXT_NODE) {
    let text = node.data.replace(/\s+/g, " ").trim();
    if (text) {
      pieces.push(text);
    }
    return pieces;
  }
  if (node.nodeType == node.ELEMENT_NODE) {
    if (
      SKIPPED_TEXT.has(node.localName) ||
      node.hasAttribute("hidden") ||
      (!all && node.getAttribute("aria-hidden") == "true") ||
      ICON_FONT.test(node.getAttribute("class") ?? "")
    ) {
      return pieces;
    }
    if (node.localName == "slot") {
      for (let assigned of node.assignedNodes({ flatten: true })) {
        textPieces(assigned, { all }, pieces);
      }
      return pieces;
    }
    let shadow = shadowOf(node);
    if (shadow) {
      return textPieces(shadow, { all }, pieces);
    }
  } else if (node.nodeType != node.DOCUMENT_FRAGMENT_NODE) {
    return pieces;
  }
  for (let child of node.childNodes) {
    textPieces(child, { all }, pieces);
  }
  return pieces;
}

function sentenceCase(text) {
  if (/\p{L}/u.test(text) && text == text.toUpperCase()) {
    return text.charAt(0) + text.slice(1).toLowerCase();
  }
  return text;
}

function clip(text, limit = LABEL_LIMIT) {
  return text.length > limit ? text.slice(0, limit) : text;
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The first ancestor of an element, the element itself included and shadow
 * hosts crossed, that matches a selector.
 *
 * @param {Element} element
 * @param {string} selector
 * @param {?Node} stop The ancestor where the search stops, not tested itself.
 * @returns {?Element}
 */
function closest(element, selector, stop) {
  for (let node = element; node && node !== stop; node = parentOf(node)) {
    if (node.nodeType == node.ELEMENT_NODE && node.matches(selector)) {
      return node;
    }
  }
  return null;
}

/**
 * @param {?Node} ancestor
 * @param {Node} node
 * @returns {boolean} Whether a node is the ancestor or below it, shadow
 *   trees crossed.
 */
function contains(ancestor, node) {
  if (!ancestor) {
    return false;
  }
  for (let current = node; current; current = parentOf(current)) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

function isInside(element, ancestors, stop) {
  for (
    let node = parentOf(element);
    node && node !== stop;
    node = parentOf(node)
  ) {
    if (ancestors.has(node)) {
      return true;
    }
  }
  return false;
}

function webURL(value, base) {
  try {
    let url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function trimSlash(path) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function samePath(url, path) {
  let [pathname, search = ""] = path.split("?");
  return (
    trimSlash(url.pathname) == trimSlash(pathname) &&
    (!search || url.search == `?${search}`)
  );
}

function matchesRule(rule, { element, url, label, location }) {
  return (
    (!rule.tag || element.localName == rule.tag) &&
    (!rule.href || (url && rule.href.test(url.pathname))) &&
    (!rule.text || rule.text.test(label)) &&
    (rule.external == undefined ||
      (!!url && url.origin != location.origin) == rule.external)
  );
}

/**
 * @param {Element} element
 * @returns {?string} "field" for a text field, "toggle" for a checkbox or
 *   switch, null for other elements.
 */
function controlKind(element) {
  let tag = element.localName;
  let role = element.getAttribute("role");
  let type = (element.getAttribute("type") ?? "").toLowerCase();
  if (tag == "textarea" || (tag == "input" && FIELD_TYPES.has(type))) {
    return "field";
  }
  if (
    (tag == "input" && (type == "checkbox" || type == "radio")) ||
    TOGGLE_ROLES.has(role)
  ) {
    return "toggle";
  }
  return null;
}

function isChecked(element) {
  if (element.localName == "input") {
    return !!element.checked;
  }
  let state =
    element.getAttribute("aria-checked") ??
    element.getAttribute("aria-pressed");
  return state == "true" || state == "mixed";
}

function escapeAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Writes an SVG element as markup with shapes only, so it can be drawn as
 * the Mono icon of an item.
 *
 * @param {Element} element
 * @param {Set<string>} refs Collects the ids referred to with href.
 * @param {number} [depth]
 * @returns {string}
 */
function serializeSvg(element, refs, depth = 0) {
  if (depth > 12 || !SVG_TAGS.has(element.localName)) {
    return "";
  }
  let attrs =
    element.localName == "svg" ? ' xmlns="http://www.w3.org/2000/svg"' : "";
  for (let { name, value } of element.attributes) {
    let key = name == "xlink:href" ? "href" : name;
    if (!SVG_ATTRIBUTES.has(key) || /url\((?!\s*["']?\s*#)/i.test(value)) {
      continue;
    }
    if (key == "href") {
      if (!value.startsWith("#")) {
        continue;
      }
      refs.add(value.slice(1));
    }
    attrs += ` ${key}="${escapeAttribute(value)}"`;
  }
  let kids = "";
  for (let child of element.children) {
    kids += serializeSvg(child, refs, depth + 1);
  }
  return `<${element.localName}${attrs}>${kids}</${element.localName}>`;
}

/**
 * @param {Element} svg
 * @returns {?string} The icon as markup with shapes only, or null when it
 *   draws nothing or can't be made safe.
 */
export function serializeIcon(svg) {
  let refs = new Set();
  let markup = serializeSvg(svg, refs);
  if (refs.size) {
    // Icons drawn from a sprite elsewhere in the page take their shapes along.
    let root = svg.getRootNode();
    let defs = "";
    for (let id of refs) {
      let target = root.getElementById?.(id);
      if (target && !contains(svg, target)) {
        defs += serializeSvg(target, new Set());
      }
    }
    if (defs) {
      markup = markup.replace(/<\/svg>$/, `<defs>${defs}</defs></svg>`);
    }
  }
  let drawn = /<(path|circle|ellipse|line|polyline|polygon|rect|use)[\s>]/;
  return drawn.test(markup) && isSafeIcon(markup) ? markup : null;
}

/**
 * One reading of a page by a site rule.
 */
class Transcription {
  constructor(document, rule, url) {
    this.document = document;
    this.rule = rule;
    this.location = new URL(url ?? document.URL);
    this.walker = new Walker();
    this.elements = new Map();
    this.used = new Set();
    this.toggles = new Set();
    this.ids = new Set();
    this.count = 0;
  }

  run({ coverage = false } = {}) {
    let root = this.findRoot();
    if (!root) {
      return null;
    }
    this.root = root;
    let sections = [...this.extraSections("start")];
    let main = this.mainSection();
    if (main) {
      sections.push(main);
    }
    if (this.rule.groups) {
      sections.push(...this.groupSections());
    }
    sections.push(...this.extraSections("end"));
    for (let section of this.extraSections("bottom")) {
      sections.push({ ...section, pinned: true });
    }
    let result = {
      model: { site: { name: this.rule.name }, sections },
      elements: this.elements,
      watched: [root, ...this.walker.shadowRoots],
      count: this.count,
    };
    if (coverage) {
      result.missed = this.missed();
    }
    return result;
  }

  /**
   * The sidebar element. It's looked up with a walker of its own, so the
   * shadow trees passed on the way to it, the page header's say, aren't
   * watched.
   *
   * @returns {?Element}
   */
  findRoot() {
    let finder = new Walker();
    for (let selector of this.rule.root) {
      let root =
        this.document.querySelector(selector) ??
        finder.query(this.document, selector);
      if (root) {
        return root;
      }
    }
    return null;
  }

  isExcluded(element) {
    return (
      !!this.rule.exclude &&
      !!closest(element, this.rule.exclude, parentOf(this.root))
    );
  }

  /**
   * The elements matching a selector that can become items: not read yet,
   * not excluded or hidden, not inside another candidate, and not a section
   * title or what holds one.
   *
   * @param {Node} scope
   * @param {string} selector
   * @param {?Element[]} [titles] A section's title and its toggle.
   * @returns {Element[]}
   */
  candidates(scope, selector, titles = []) {
    let heading = this.rule.groups?.heading;
    let found = this.walker
      .queryAll(scope, selector)
      .filter(
        element =>
          !this.used.has(element) &&
          !this.toggles.has(element) &&
          !this.isExcluded(element) &&
          !closest(element, "[hidden]", scope) &&
          !(heading && titles.length && closest(element, heading, scope)) &&
          !titles.some(
            title =>
              title && (contains(title, element) || contains(element, title))
          )
      );
    let set = new Set(found);
    return found.filter(element => !isInside(element, set, scope));
  }

  mainSection() {
    if (!this.rule.main?.length) {
      return null;
    }
    let links = this.walker
      .queryAll(this.root, "a[href]")
      .filter(element => !this.isExcluded(element))
      .map(element => ({ element, url: this.linkURL(element) }))
      .filter(({ url }) => url?.origin == this.location.origin);
    let items = [];
    for (let entry of this.rule.main) {
      let link = links.find(
        ({ element, url }) =>
          !this.used.has(element) &&
          entry.paths.some(path => samePath(url, path))
      );
      if (!link) {
        continue;
      }
      let item = this.item(link.element, {
        section: "main",
        kind: "nav",
        icon: entry.icon,
      });
      if (item) {
        items.push(item);
      }
    }
    return items.length ? { id: "main", items } : null;
  }

  groupSections() {
    let groups = this.rule.groups;
    let sections = [];
    for (let group of this.walker.queryAll(this.root, groups.each)) {
      if (this.isExcluded(group)) {
        continue;
      }
      let headingElement = groups.heading
        ? this.walker.query(group, groups.heading)
        : null;
      let heading = headingElement
        ? sentenceCase(
            textPieces(headingElement)[0] ?? this.accessibleName(headingElement)
          )
        : "";
      // The button or summary around the title opens and closes the section.
      let toggle = headingElement
        ? closest(headingElement, SECTION_TOGGLE, group)
        : null;
      let expandable =
        group.localName == "details" || !!toggle?.hasAttribute("aria-expanded");
      if (toggle) {
        this.toggles.add(toggle);
      }
      let override =
        groups.sections?.find(section => section.heading.test(heading)) ?? {};
      let id = this.uniqueId(slug(heading) || "section", "");
      // Read first, so they're not read as items too.
      let headingActions = groups.headingActions
        ? this.candidates(group, groups.headingActions, [
            headingElement,
            toggle,
          ])
            .slice(0, MAX_ACTIONS)
            .map(element => this.action(element, { id }, group))
            .filter(Boolean)
        : [];
      let items = this.rows(
        this.candidates(group, groups.items, [headingElement, toggle]),
        { section: id, scope: group, kind: override.kind }
      );
      // A collapsed section may only fill in once it's opened, so it stays as
      // a heading that opens it.
      let foldable = !!heading && !!toggle && expandable;
      if (!items.length && !foldable) {
        continue;
      }
      let section = { id, items };
      if (heading) {
        section.heading = clip(heading);
      }
      if (headingActions.length) {
        section.actions = headingActions;
      }
      if (override.collapsed != undefined) {
        section.collapsible = true;
        section.collapsed = override.collapsed;
      } else if (foldable) {
        section.collapsible = true;
        section.collapsed =
          group.localName == "details"
            ? !group.open
            : toggle.getAttribute("aria-expanded") == "false";
        section.toggleId = `${id}#toggle`;
        this.elements.set(section.toggleId, { element: toggle });
      }
      sections.push(section);
    }
    return sections;
  }

  extraSections(at) {
    let sections = [];
    for (let extra of this.rule.extras ?? []) {
      if ((extra.at ?? "end") != at) {
        continue;
      }
      let id = this.uniqueId(slug(extra.heading ?? "") || `extra-${at}`, "");
      let items = this.rows(this.candidates(this.root, extra.items), {
        section: id,
        scope: this.root,
        kind: extra.kind,
      });
      if (items.length) {
        let section = { id, items };
        if (extra.heading) {
          section.heading = clip(extra.heading);
        }
        sections.push(section);
      }
    }
    return sections;
  }

  /**
   * Turns candidates into items, one per row: the row's first link, or its
   * first element, is the item and the other elements are its actions.
   *
   * @param {Element[]} candidates
   * @param {object} options
   * @param {string} options.section The section id.
   * @param {Node} options.scope Where rows are looked for.
   * @param {string} [options.kind] The kind every item takes.
   * @returns {object[]}
   */
  rows(candidates, { section, scope, kind }) {
    let rowSelector = this.rule.groups?.container;
    let order = [];
    let rows = new Map();
    for (let element of candidates) {
      let row =
        (rowSelector && closest(element, rowSelector, scope)) || element;
      if (!rows.has(row)) {
        rows.set(row, []);
        order.push(row);
      }
      rows.get(row).push(element);
    }
    let items = [];
    let seen = new Set();
    for (let row of order) {
      let elements = rows.get(row);
      let primary =
        elements.find(
          element => element.localName == "a" && element.hasAttribute("href")
        ) ?? elements[0];
      let item = this.item(primary, { section, container: row, kind });
      if (!item) {
        continue;
      }
      let key = item.href ?? `${item.kind}:${item.label}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      let actions = elements
        .filter(element => element !== primary)
        .slice(0, MAX_ACTIONS)
        .map(element => this.action(element, item, row))
        .filter(Boolean);
      if (actions.length) {
        item.actions = actions;
      }
      items.push(item);
    }
    return items;
  }

  linkURL(element) {
    return element.localName == "a" && typeof element.href == "string"
      ? webURL(element.href, this.location)
      : null;
  }

  /**
   * An element's name for assistive technology, for controls without text.
   *
   * @param {Element} element
   * @returns {string}
   */
  accessibleName(element) {
    let label = element.getAttribute("aria-label")?.trim();
    if (label) {
      return label;
    }
    let ids = element.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
    let root = element.getRootNode();
    let labelled = ids
      .map(id => root.getElementById?.(id))
      .filter(Boolean)
      .map(target => textPieces(target, { all: true }).join(" "))
      .join(" ")
      .trim();
    if (labelled) {
      return labelled;
    }
    let labels = [...(element.labels ?? [])]
      .map(target => textPieces(target).join(" "))
      .join(" ")
      .trim();
    if (labels) {
      return labels;
    }
    let title = element.getAttribute("title")?.trim();
    if (title) {
      return title;
    }
    let alt = this.walker.query(element, "img[alt]")?.getAttribute("alt");
    if (alt?.trim()) {
      return alt.trim();
    }
    let svgTitle = this.walker.query(element, "svg title");
    return svgTitle?.textContent.trim() ?? "";
  }

  /**
   * The first text piece is the label and a later short all-caps piece is a
   * badge. Controls without text are named by their accessible name; fields
   * by their accessible name, label or placeholder.
   *
   * @param {Element} element
   * @param {?string} kind controlKind of the element.
   * @returns {{label: string, badge: ?string}}
   */
  label(element, kind = controlKind(element)) {
    if (kind == "field") {
      let label =
        this.accessibleName(element) ||
        element.getAttribute("placeholder") ||
        "";
      return { label: clip(label.trim()), badge: null };
    }
    let pieces = textPieces(element);
    let label =
      pieces[0] ||
      this.accessibleName(element) ||
      textPieces(element, { all: true })[0] ||
      "";
    let badge = pieces.slice(1).find(piece => BADGE.test(piece));
    return { label: clip(label.trim()), badge: badge?.toLowerCase() };
  }

  item(element, { section, container = element, kind, icon }) {
    let control = controlKind(element);
    let { label, badge } = this.label(element, control);
    if (!label) {
      return null;
    }
    let groups = this.rule.groups ?? {};
    let url = this.linkURL(element);
    let context = { element, url, label, location: this.location };
    kind =
      control ??
      kind ??
      groups.kinds?.find(rule => matchesRule(rule, context))?.kind ??
      "nav";
    let key = slug(label);
    if (url) {
      key =
        url.origin == this.location.origin
          ? url.pathname + url.search
          : url.host + url.pathname + url.search;
    }
    let item = { id: this.uniqueId(section, key), kind, label };
    if (url) {
      item.href = url.href;
    }
    let itemIcon =
      this.namedIcon(icon, element) ?? this.icon(context, container, kind);
    if (itemIcon) {
      item.icon = itemIcon;
    }
    if (badge) {
      item.badge = badge;
    }
    if (this.isCurrent(element, container, url)) {
      item.current = true;
    }
    if (
      kind != "field" &&
      kind != "toggle" &&
      this.opensMenu(element, container)
    ) {
      item.popup = true;
    }
    if (kind == "field") {
      item.value = clip(String(element.value ?? ""), VALUE_LIMIT);
      item.inputType = element.localName == "textarea" ? "text" : "search";
      let placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        item.placeholder = clip(placeholder);
      }
    } else if (kind == "toggle") {
      item.checked = isChecked(element);
    }
    this.used.add(element);
    this.elements.set(item.id, { element });
    this.count++;
    return item;
  }

  action(element, item, row) {
    let { label } = this.label(element, null);
    if (!label) {
      return null;
    }
    let action = {
      id: this.uniqueId(`${item.id}/action`, slug(label) || "action"),
      label,
    };
    let pressed = this.isPressed(element);
    if (pressed != null) {
      action.pressed = pressed;
    }
    if (this.opensMenu(element, row)) {
      action.popup = true;
    }
    let context = { element, url: null, label, location: this.location };
    let named = this.rule.groups?.icons?.find(rule =>
      matchesRule(rule, context)
    );
    let icon = this.namedIcon(named?.icon, element) ?? this.siteIcon(element);
    if (icon) {
      action.icon = icon;
    }
    this.used.add(element);
    this.elements.set(action.id, { element });
    return action;
  }

  /**
   * Whether clicking an element opens a site menu: it, or a wrapper close
   * around it within its row, has aria-haspopup, or matches the rule's
   * popups selector. Sites often put aria-haspopup on a wrapper of the
   * button that is clicked.
   *
   * @param {Element} element
   * @param {?Element} row The element's row, where the search stops.
   * @returns {boolean}
   */
  opensMenu(element, row) {
    if (element.localName == "a" && element.hasAttribute("href")) {
      return false;
    }
    let node = element;
    for (let depth = 0; node && depth < MENU_WRAPPERS; depth++) {
      if (
        node.nodeType != node.ELEMENT_NODE ||
        (node === row && node !== element)
      ) {
        break;
      }
      let popup = node.getAttribute("aria-haspopup");
      if (
        (popup && popup != "false") ||
        (this.rule.popups && node.matches(this.rule.popups))
      ) {
        return true;
      }
      node = parentOf(node);
    }
    return false;
  }

  /**
   * @param {Element} element
   * @returns {?boolean} Whether a row action is on, or null when it isn't a
   *   toggle.
   */
  isPressed(element) {
    let state =
      element.getAttribute("aria-pressed") ??
      element.getAttribute("aria-checked");
    if (state != null) {
      return state == "true" || state == "mixed";
    }
    let groups = this.rule.groups ?? {};
    let selector = groups.pressed ?? groups.secondary?.pressed;
    if (
      selector &&
      (element.matches(selector) || this.walker.query(element, selector))
    ) {
      return true;
    }
    if (groups.secondary && element.matches(groups.secondary.selector)) {
      return false;
    }
    return null;
  }

  /**
   * An icon a rule names: a Mono icon, one of the rule's own, or "site".
   *
   * @param {?string} name
   * @param {Element} element The item, for the site's icon.
   * @returns {?object}
   */
  namedIcon(name, element) {
    if (!name) {
      return null;
    }
    if (ICON_NAMES.includes(name)) {
      return { name };
    }
    let svg = this.rule.customIcons?.[name];
    if (svg) {
      return { svg };
    }
    return name == "site" ? this.siteIcon(element, { force: true }) : null;
  }

  siteIcon(scope, { force = false, skip = [] } = {}) {
    if (!force && this.rule.siteIcons === false) {
      return null;
    }
    let svg = this.walker
      .queryAll(scope, "svg")
      .find(candidate => !skip.some(other => contains(other, candidate)));
    let markup = svg && serializeIcon(svg);
    return markup ? { svg: markup } : null;
  }

  icon(context, container, kind) {
    let named = this.rule.groups?.icons?.find(rule =>
      matchesRule(rule, context)
    );
    if (named) {
      let icon = this.namedIcon(named.icon, context.element);
      if (icon) {
        return icon;
      }
    }
    if (kind == "field" || kind == "toggle") {
      return null;
    }
    if (kind == "nav" || kind == "entity") {
      let image = [
        ...this.walker.queryAll(context.element, "img"),
        ...this.walker.queryAll(container, "img"),
      ]
        .map(img => webURL(img.currentSrc || img.src, this.location))
        .find(Boolean);
      if (image) {
        return { image: image.href };
      }
    }
    let site = this.siteIcon(context.element);
    if (!site && container !== context.element) {
      // The row's picture, but not the icon of one of its actions.
      site = this.siteIcon(container, {
        skip: this.rowControls(container, context.element),
      });
    }
    if (site) {
      return site;
    }
    if (kind == "entity") {
      let letter = context.label.replace(/^[a-z]\//i, "").charAt(0);
      return { letter: letter.toUpperCase() };
    }
    return { name: kind == "action" ? "more" : "link" };
  }

  rowControls(container, primary) {
    return this.walker
      .queryAll(container, CONTROLS)
      .filter(element => element !== primary && !contains(primary, element));
  }

  isCurrent(element, container, url) {
    let mode = this.rule.current ?? "auto";
    if (mode != "url") {
      let scope = parentOf(container);
      let selector = this.rule.currentSelector;
      if (selector && closest(element, selector, scope)) {
        return true;
      }
      let marked = closest(element, "[aria-current], [aria-selected]", scope);
      if (marked) {
        let state =
          marked.getAttribute("aria-current") ??
          marked.getAttribute("aria-selected");
        return state != "false";
      }
      if (mode == "marker") {
        return false;
      }
    }
    if (!url || url.origin != this.location.origin) {
      return false;
    }
    return (
      trimSlash(url.pathname) == trimSlash(this.location.pathname) &&
      (this.rule.currentIgnoresSearch || url.search == this.location.search)
    );
  }

  /**
   * The controls in the sidebar that no item or action reads, so a rule can
   * be checked to carry every function over.
   *
   * @returns {string[]}
   */
  missed() {
    let read = new Set([...this.used, ...this.toggles]);
    return this.walker
      .queryAll(this.root, CONTROLS)
      .filter(
        element =>
          !read.has(element) &&
          !isInside(element, read, parentOf(this.root)) &&
          ![...read].some(other => contains(element, other)) &&
          !this.isExcluded(element) &&
          !closest(element, "[hidden]", parentOf(this.root))
      )
      .map(element => {
        let { label } = this.label(element);
        return label ? `${element.localName} "${label}"` : element.localName;
      });
  }

  uniqueId(prefix, key) {
    let base = key ? `${prefix}/${key}` : prefix;
    let id = base;
    for (let i = 2; this.ids.has(id); i++) {
      id = `${base}#${i}`;
    }
    this.ids.add(id);
    return id;
  }
}

/**
 * Reads the site menu from a document.
 *
 * @param {Document} document The page.
 * @param {object} rule The site's compiled rule.
 * @param {object} [options]
 * @param {string} [options.url] The page address, when the document was
 *   rebuilt from a capture.
 * @param {boolean} [options.coverage] Whether to list the controls the rule
 *   doesn't read, as `missed`.
 * @returns {?{model: object, elements: Map, watched: Node[], count: number,
 *   missed?: string[]}} null when the rule's root isn't on the page.
 *   `elements` maps item, action and section toggle ids to { element }, and
 *   `watched` lists the root and the shadow roots below it, whose changes can
 *   change the model.
 */
export function transcribe(document, rule, { url, coverage } = {}) {
  return new Transcription(document, rule, url).run({ coverage });
}

const MENU_ITEMS = [
  "[role^='menuitem']",
  "[role='option']",
  "a[href]",
  "button",
  "input[type='checkbox']",
  "input[type='radio']",
].join(", ");
const MAX_MENU_ITEMS = 40;

/**
 * Reads a menu the site opened, such as the one behind a row's menu button,
 * for the Mono sidebar to show instead.
 *
 * @param {Document} document The page.
 * @param {Element} menu The site's menu element.
 * @returns {{items: object[], elements: Map}} The items as
 *   { id, label, checked?, disabled? }, and the elements behind them by id.
 */
export function readMenu(document, menu) {
  let reading = new Transcription(document, { root: [] });
  let found = reading.walker
    .queryAll(menu, MENU_ITEMS)
    .filter(element => !closest(element, "[hidden]", menu));
  let set = new Set(found);
  let items = [];
  let elements = new Map();
  for (let element of found) {
    if (isInside(element, set, menu) || items.length >= MAX_MENU_ITEMS) {
      continue;
    }
    let { label } = reading.label(element, null);
    if (!label) {
      continue;
    }
    let item = { id: reading.uniqueId("popup", slug(label) || "item"), label };
    let state =
      element.getAttribute("aria-checked") ??
      (element.localName == "input" ? String(element.checked) : null);
    if (state != null) {
      item.checked = state == "true";
    }
    if (element.getAttribute("aria-disabled") == "true" || element.disabled) {
      item.disabled = true;
    }
    items.push(item);
    elements.set(item.id, { element });
  }
  return { items, elements };
}

/**
 * The stylesheet that conceals the site's sidebar while Fold is on. It's
 * loaded as a user sheet, so it reaches into shadow trees and wins over the
 * page's own styles.
 *
 * @param {object} rule The site's compiled rule.
 * @returns {string}
 */
export function hidingStyle(rule) {
  let style = "";
  if (rule.hide.length) {
    // Laid out and rendered, so the site keeps loading what's inside, but
    // not drawn, not in the page flow and not clickable. Nothing clips it,
    // so intersection observers still see it in view.
    style += `:is(${rule.hide.join(", ")}) {
  position: fixed !important;
  inset-block-start: 0 !important;
  inset-inline-start: 0 !important;
  z-index: -2147483647 !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
`;
  }
  if (rule.remove?.length) {
    style += `:is(${rule.remove.join(", ")}) { display: none !important; }\n`;
  }
  // A site menu opened from the concealed sidebar, and what it's drawn on,
  // is shown in the Mono sidebar instead.
  style += `[data-mono-fold-relay] {
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
[data-mono-fold-relay]::backdrop {
  background: transparent !important;
}
`;
  return style + (rule.css ?? "");
}
