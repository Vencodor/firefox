/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reads a site's own sidebar into the site menu model, following the site's
 * rule (see rules/). The model only carries what the Mono sidebar draws:
 *
 *   { site: { name },
 *     sections: [{ id, heading?, collapsible?, collapsed?, items: [item] }] }
 *
 * An item is { id, kind, label, href?, icon, badge?, current?, secondary? }.
 * `kind` is one of ITEM_KINDS; the sidebar draws each kind with its own row,
 * so a new kind (a text field, say) is added here and in the sidebar together.
 * `icon` is { name } for a Mono icon, { image } for the site's picture or
 * { letter } for an entity without one. `secondary` is { label, pressed } for
 * a toggle at the row end, such as a favorite star.
 *
 * Nothing on the page is changed here. The elements behind the model are
 * returned so that the actor can click them for the user.
 */

export const ITEM_KINDS = ["nav", "entity", "action", "link"];

const SKIPPED_TEXT = new Set([
  "img",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
]);
const BADGE = /^[A-Z][A-Z0-9]{1,7}$/;
const LABEL_LIMIT = 120;

function shadowOf(element) {
  return element.openOrClosedShadowRoot ?? element.shadowRoot ?? null;
}

function parentOf(node) {
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
 * The visible text of a node as separate pieces, read in rendered order:
 * a shadow tree replaces its host's children and a slot shows what it holds.
 *
 * @param {Node} node
 * @param {string[]} [pieces] The pieces found so far.
 * @returns {string[]}
 */
function textPieces(node, pieces = []) {
  if (node.nodeType == node.TEXT_NODE) {
    let text = node.data.replace(/\s+/g, " ").trim();
    if (text) {
      pieces.push(text);
    }
    return pieces;
  }
  if (node.nodeType == node.ELEMENT_NODE) {
    if (SKIPPED_TEXT.has(node.localName) || node.hasAttribute("hidden")) {
      return pieces;
    }
    if (node.localName == "slot") {
      for (let assigned of node.assignedNodes({ flatten: true })) {
        textPieces(assigned, pieces);
      }
      return pieces;
    }
    let shadow = shadowOf(node);
    if (shadow) {
      return textPieces(shadow, pieces);
    }
  } else if (node.nodeType != node.DOCUMENT_FRAGMENT_NODE) {
    return pieces;
  }
  for (let child of node.childNodes) {
    textPieces(child, pieces);
  }
  return pieces;
}

function sentenceCase(text) {
  if (/\p{L}/u.test(text) && text == text.toUpperCase()) {
    return text.charAt(0) + text.slice(1).toLowerCase();
  }
  return text;
}

function clip(text) {
  return text.length > LABEL_LIMIT ? text.slice(0, LABEL_LIMIT) : text;
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
 * One reading of a page by a site rule.
 */
class Transcription {
  constructor(document, rule) {
    this.document = document;
    this.rule = rule;
    this.location = new URL(document.URL);
    this.walker = new Walker();
    this.elements = new Map();
    this.used = new Set();
    this.ids = new Set();
    this.count = 0;
  }

  run() {
    let root = null;
    for (let selector of this.rule.root) {
      root = this.walker.query(this.document, selector);
      if (root) {
        break;
      }
    }
    if (!root) {
      return null;
    }
    this.root = root;
    let sections = [];
    let main = this.mainSection();
    if (main) {
      sections.push(main);
    }
    if (this.rule.groups) {
      sections.push(...this.groupSections());
    }
    return {
      model: { site: { name: this.rule.name }, sections },
      elements: this.elements,
      watched: [root, ...this.walker.shadowRoots],
      count: this.count,
    };
  }

  mainSection() {
    if (!this.rule.main?.length) {
      return null;
    }
    let links = this.walker
      .queryAll(this.root, "a[href]")
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
        icon: { name: entry.icon },
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
      let headingElement = groups.heading
        ? this.walker.query(group, groups.heading)
        : null;
      let heading = headingElement
        ? sentenceCase(textPieces(headingElement)[0] ?? "")
        : "";
      let override =
        groups.sections?.find(section => section.heading.test(heading)) ?? {};
      let id = this.uniqueId(slug(heading) || "section", "");
      let candidates = this.walker
        .queryAll(group, groups.items)
        .filter(
          element =>
            !this.used.has(element) &&
            !(headingElement && closest(element, groups.heading, group)) &&
            !(groups.secondary && element.matches(groups.secondary.selector)) &&
            !closest(element, "[hidden]", group)
        );
      let candidateSet = new Set(candidates);
      let items = [];
      let seen = new Set();
      for (let element of candidates) {
        if (isInside(element, candidateSet, group)) {
          continue;
        }
        let item = this.item(element, {
          section: id,
          group,
          kind: override.kind,
        });
        if (!item) {
          continue;
        }
        let key = item.href ?? `${item.kind}:${item.label}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        items.push(item);
      }
      // A collapsed details element may only fill in once it's opened, so it
      // stays as a heading that opens it.
      let foldable = group.localName == "details" && !!headingElement;
      if (!items.length && !(foldable && heading)) {
        continue;
      }
      let section = { id, items };
      if (heading) {
        section.heading = clip(heading);
      }
      if (override.collapsed != undefined) {
        section.collapsible = true;
        section.collapsed = override.collapsed;
      } else if (foldable) {
        section.collapsible = true;
        section.collapsed = !group.open;
        section.toggleId = `${id}#toggle`;
        this.elements.set(section.toggleId, { element: headingElement });
      }
      sections.push(section);
    }
    return sections;
  }

  linkURL(element) {
    return element.localName == "a" && typeof element.href == "string"
      ? webURL(element.href, this.location)
      : null;
  }

  /**
   * The first text piece is the label and a later short all-caps piece is a
   * badge. Only links may fall back to their accessible name, so icon-only
   * buttons, which are usually per-row extras, aren't read as items.
   *
   * @param {Element} element
   * @returns {{label: string, badge: ?string}}
   */
  label(element) {
    let pieces = textPieces(element);
    let label = pieces[0];
    if (!label && element.localName == "a") {
      label =
        element.getAttribute("aria-label") ?? element.getAttribute("title");
    }
    let badge = pieces.slice(1).find(piece => BADGE.test(piece));
    return { label: clip(label?.trim() ?? ""), badge: badge?.toLowerCase() };
  }

  item(element, { section, group, kind, icon }) {
    let { label, badge } = this.label(element);
    if (!label) {
      return null;
    }
    let groups = this.rule.groups ?? {};
    let url = this.linkURL(element);
    let context = { element, url, label, location: this.location };
    kind ??=
      groups.kinds?.find(rule => matchesRule(rule, context))?.kind ?? "nav";
    let container =
      (group &&
        groups.container &&
        closest(element, groups.container, group)) ||
      element;
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
    item.icon = icon ?? this.icon(context, container, kind);
    if (badge) {
      item.badge = badge;
    }
    if (this.isCurrent(element, container, url)) {
      item.current = true;
    }
    let entry = { element };
    if (groups.secondary && container !== element) {
      let toggle = this.walker.query(container, groups.secondary.selector);
      let toggleLabel =
        toggle &&
        (toggle.getAttribute("aria-label") ??
          toggle.getAttribute("title") ??
          textPieces(toggle)[0]);
      if (toggleLabel) {
        let pressed =
          toggle.getAttribute("aria-pressed") == "true" ||
          (!!groups.secondary.pressed &&
            (toggle.matches(groups.secondary.pressed) ||
              !!this.walker.query(toggle, groups.secondary.pressed)));
        item.secondary = { label: clip(toggleLabel), pressed };
        entry.secondary = toggle;
      }
    }
    this.used.add(element);
    this.elements.set(item.id, entry);
    this.count++;
    return item;
  }

  icon(context, container, kind) {
    let named = this.rule.groups?.icons?.find(rule =>
      matchesRule(rule, context)
    );
    if (named) {
      return { name: named.icon };
    }
    if (kind == "nav" || kind == "entity") {
      let image = this.walker
        .queryAll(container, "img")
        .map(img => webURL(img.currentSrc || img.src, this.location))
        .find(Boolean);
      if (image) {
        return { image: image.href };
      }
    }
    if (kind == "entity") {
      let letter = context.label.replace(/^[a-z]\//i, "").charAt(0);
      return { letter: letter.toUpperCase() };
    }
    return { name: kind == "action" ? "more" : "link" };
  }

  isCurrent(element, container, url) {
    let marked =
      this.rule.current != "url" &&
      closest(element, "[aria-current]", parentOf(container));
    if (marked) {
      return marked.getAttribute("aria-current") != "false";
    }
    if (!url || url.origin != this.location.origin) {
      return false;
    }
    return (
      trimSlash(url.pathname) == trimSlash(this.location.pathname) &&
      (this.rule.currentIgnoresSearch || url.search == this.location.search)
    );
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
 * @param {object} rule The site's rule.
 * @returns {?{model: object, elements: Map, watched: Node[], count: number}}
 *   null when the rule's root isn't on the page. `elements` maps item ids to
 *   { element, secondary? }, and `watched` lists the root and the shadow roots
 *   below it, whose changes can change the model.
 */
export function transcribe(document, rule) {
  return new Transcription(document, rule).run();
}

/**
 * The stylesheet that hides the site's sidebar while the site menu shows in
 * the Mono sidebar.
 *
 * @param {object} rule The site's rule.
 * @returns {string}
 */
export function hidingStyle(rule) {
  let hide = rule.hide.length
    ? `${rule.hide.join(",\n")} { display: none !important; }\n`
    : "";
  return hide + (rule.css ?? "");
}
