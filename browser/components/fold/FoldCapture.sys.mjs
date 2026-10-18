/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  compileRule,
  isSafeIcon,
  validateRule,
} from "resource:///modules/fold/FoldRules.sys.mjs";
import {
  parentOf,
  queryAllDeep,
  queryDeep,
  serializeIcon,
  shadowOf,
  transcribe,
} from "resource:///modules/fold/FoldTranscriber.sys.mjs";

/**
 * Fold capture: a description of a page's navigation for writing or fixing
 * its site rule, made by Tools > Capture Fold and handed to an AI as text
 * (see mono/skills/fold-site). The same capture rebuilt into a document is
 * the test fixture of the rule.
 *
 * {
 *   format, version, url, title, viewport: { width, height },
 *   rule: { id, read: { items, sections, missed } | null, folded } | null,
 *   candidates: [{ path, links, score, reasons, rect, position }],
 *   containers: [{ path, ancestors, layout, siblings, tree }],
 *   overlays: [{ path, tree }],
 *   main: { path, rect } | null,
 *   truncated,
 * }
 *
 * - candidates: separate elements that look like navigation, best first.
 *   `path` reads like a selector from <body>, with ">>>" entering a shadow
 *   tree.
 * - containers: the outermost column around the best candidates, the likely
 *   element to hide. `ancestors` lists the elements above it as { tag, attrs }
 *   and "#shadow-root", `layout` the display of each ancestor from the
 *   nearest, and `siblings` the elements next to it.
 * - tree: { tag, attrs?, kids?, shadow?, shown?, svg?, icon? }, where kids
 *   and shadow hold child elements and text strings in order, icon is an SVG
 *   icon's markup with shapes only, and shown is false
 *   for an element that isn't drawn, such as a collapsed section, and so
 *   neither is what's inside it. Elements without text, links or controls
 *   below them are left out.
 * - overlays: [{ path, tree }], menus and dialogs the site has open outside
 *   the sidebar when capturing, such as a row's menu opened beforehand.
 * - rule: the page's current rule, what it reads and the controls it misses
 *   (`read`), and the page measured with the sidebar folded (`folded`:
 *   where main lands, and how many elements each hide and remove selector
 *   finds and leaves drawn), for fixing a rule.
 */

export const CAPTURE_FORMAT = "mono-fold-capture";
export const CAPTURE_VERSION = 1;

const MAX_VISITED = 30000;
const MAX_NODES = 4000;
const MAX_DEPTH = 64;
const MAX_TEXT = 120;
const MAX_VALUE = 300;
const MAX_ATTRIBUTES = 16;
const MAX_CANDIDATES = 6;
const MAX_CONTAINERS = 2;
const MAX_LAYOUT = 15;
const MAX_SIBLINGS = 12;
const MIN_LINKS = 4;
const MAX_OVERLAYS = 3;
const OVERLAYS =
  "[role='menu'], [role='listbox'], [role='dialog'], [role='alertdialog'], dialog[open]";
const SKIPPED = new Set([
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
]);
const KEPT = new Set([
  "a",
  "button",
  "details",
  "img",
  "input",
  "select",
  "slot",
  "summary",
  "textarea",
]);
const ATTRIBUTE =
  /^(id|class|role|aria-[a-z-]+|href|target|open|hidden|slot|name|title|alt|type|src|data-testid|[a-z-]*icon[a-z-]*)$/;
const NAME_HINT = /side|nav|menu|drawer|guide|rail/i;
const ROLES = new Set([
  "navigation",
  "complementary",
  "menu",
  "menubar",
  "tree",
  "tablist",
]);
const SVG_NS = "http://www.w3.org/2000/svg";

function clip(text, limit) {
  return text.length > limit ? text.slice(0, limit) : text;
}

function round(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * @param {Element} element
 * @returns {string} tag#id.class.class, with at most three classes.
 */
function describe(element) {
  let name = element.localName;
  if (element.id) {
    name += `#${element.id}`;
  }
  let classes = (element.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  for (let className of classes) {
    name += `.${clip(className, 40)}`;
  }
  return name;
}

function pathOf(element) {
  let path = "";
  for (let node = element; node; ) {
    if (node.localName == "body" || node.localName == "html") {
      break;
    }
    path = describe(node) + path;
    let parent = node.parentNode;
    if (parent?.nodeType == parent?.DOCUMENT_FRAGMENT_NODE) {
      path = " >>> " + path;
      node = parent.host;
    } else {
      path = " > " + path;
      node = parent?.nodeType == parent?.ELEMENT_NODE ? parent : null;
    }
  }
  return path.replace(/^ > /, "");
}

function contains(ancestor, node) {
  for (let current = node; current; current = parentOf(current)) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

function pick(element, names) {
  let attrs = {};
  for (let name of names) {
    let value = element.getAttribute(name);
    if (value) {
      attrs[name] = clip(value, MAX_VALUE);
    }
  }
  return attrs;
}

/**
 * Counts the links under every element in one pass over the page, shadow
 * trees included, and keeps the elements holding a few.
 *
 * @param {Document} document
 * @returns {{rich: {element: Element, links: number}[], truncated: boolean}}
 */
function survey(document) {
  let visited = 0;
  let rich = [];
  let walk = root => {
    let links = 0;
    for (let element of root.children) {
      if (visited++ >= MAX_VISITED) {
        break;
      }
      let count =
        element.localName == "a" && element.hasAttribute("href") ? 1 : 0;
      let shadow = shadowOf(element);
      if (shadow) {
        count += walk(shadow);
      }
      count += walk(element);
      if (count >= MIN_LINKS) {
        rich.push({ element, links: count });
      }
      links += count;
    }
    return links;
  };
  walk(document);
  return { rich, truncated: visited >= MAX_VISITED };
}

/**
 * Scores how much an element looks like the site's sidebar: a narrow, tall
 * column at the start of the page, a navigation role or name, and links.
 *
 * @param {{element: Element, links: number}} entry
 * @param {Window} window
 * @returns {?object} null for an element as wide as the page.
 */
function score({ element, links }, window) {
  let rect = element.getBoundingClientRect();
  let { innerWidth: width, innerHeight: height } = window;
  let shown = rect.width > 0 && rect.height > 0;
  let column =
    shown &&
    rect.width >= 48 &&
    rect.width <= Math.min(480, width * 0.4) &&
    rect.height >= height * 0.5;
  let reasons = [];
  let points = Math.min(links / 20, 2);
  let left = column && rect.left <= width * 0.15;
  if (left) {
    points += 4;
    reasons.push("left column");
  } else if (column && rect.right >= width * 0.85) {
    points += 1;
    reasons.push("right column");
  } else if (rect.width > width * 0.6) {
    return null;
  }
  if (!shown) {
    reasons.push("not shown");
  }
  let role = element.getAttribute("role");
  if (ROLES.has(role)) {
    points += 2;
    reasons.push(`role=${role}`);
  } else if (element.localName == "nav" || element.localName == "aside") {
    points += 2;
    reasons.push(element.localName);
  }
  let name = `${element.localName} ${element.id} ${element.getAttribute("class") ?? ""}`;
  if (NAME_HINT.test(name)) {
    points += 1;
    reasons.push("name");
  }
  reasons.push(`${links} links`);
  return { element, links, rect, left, points, reasons };
}

function isLeftColumn(element, window) {
  let rect = element.getBoundingClientRect();
  return (
    rect.width >= 48 &&
    rect.width <= Math.min(480, window.innerWidth * 0.4) &&
    rect.height >= window.innerHeight * 0.5 &&
    rect.left <= window.innerWidth * 0.15
  );
}

/**
 * The outermost column around a sidebar candidate, which is usually what
 * the rule hides.
 *
 * @param {object} candidate A scored candidate.
 * @param {Window} window
 * @returns {Element}
 */
function containerOf(candidate, window) {
  let container = candidate.element;
  if (!candidate.left) {
    return container;
  }
  for (let node = parentOf(container); node; node = parentOf(node)) {
    if (
      node.nodeType != node.ELEMENT_NODE ||
      node.localName == "body" ||
      !isLeftColumn(node, window)
    ) {
      break;
    }
    container = node;
  }
  return container;
}

function ancestorsOf(element) {
  let chain = [];
  for (let node = element; ; ) {
    let parent = node.parentNode;
    if (parent?.nodeType == parent?.DOCUMENT_FRAGMENT_NODE) {
      chain.unshift("#shadow-root");
      parent = parent.host;
    }
    if (
      parent?.nodeType != parent?.ELEMENT_NODE ||
      parent.localName == "body" ||
      parent.localName == "html"
    ) {
      break;
    }
    chain.unshift({
      tag: parent.localName,
      attrs: pick(parent, ["id", "class", "role"]),
    });
    node = parent;
  }
  return chain;
}

function layoutOf(element, window) {
  let layout = [];
  for (
    let node = parentOf(element);
    node?.nodeType == node?.ELEMENT_NODE && layout.length < MAX_LAYOUT;
    node = parentOf(node)
  ) {
    let style = window.getComputedStyle(node);
    let entry = {
      node: describe(node),
      display: style.display,
      position: style.position,
      width: Math.round(node.getBoundingClientRect().width),
    };
    if (style.display.includes("grid")) {
      entry.columns = clip(style.gridTemplateColumns, MAX_VALUE);
    } else if (style.display.includes("flex")) {
      entry.direction = style.flexDirection;
    }
    layout.push(entry);
    if (node.localName == "body") {
      break;
    }
  }
  return layout;
}

function siblingsOf(element) {
  return [...(element.parentNode?.children ?? [])]
    .slice(0, MAX_SIBLINGS)
    .map(sibling => {
      let entry = {
        node: describe(sibling),
        rect: round(sibling.getBoundingClientRect()),
      };
      if (sibling === element) {
        entry.self = true;
      }
      return entry;
    });
}

/**
 * Writes an element and what's below it as plain data, leaving out what
 * can't matter to a rule.
 */
class Serializer {
  nodes = 0;
  truncated = false;

  constructor(window) {
    this.window = window;
  }

  element(element, depth = 0, parentShown = true) {
    if (SKIPPED.has(element.localName)) {
      return null;
    }
    if (this.nodes >= MAX_NODES || depth > MAX_DEPTH) {
      this.truncated = true;
      return null;
    }
    this.nodes++;
    let data = { tag: element.localName };
    let attrs = this.attributes(element);
    if (attrs) {
      data.attrs = attrs;
    }
    if (element.namespaceURI == SVG_NS) {
      // Icons, kept as markup with shapes only, since items may show them.
      data.svg = true;
      let icon = element.localName == "svg" && serializeIcon(element);
      if (icon) {
        data.icon = icon;
      }
      if (attrs || icon) {
        return data;
      }
      this.nodes--;
      return null;
    }
    let shown = parentShown && this.isShown(element);
    let kids = this.children(element, depth, shown);
    if (kids.length) {
      data.kids = kids;
    }
    let shadow = shadowOf(element);
    let shadowKids = shadow ? this.children(shadow, depth, shown) : [];
    if (shadowKids.length) {
      data.shadow = shadowKids;
    }
    if (
      !kids.length &&
      !shadowKids.length &&
      !KEPT.has(data.tag) &&
      !attrs?.id &&
      !attrs?.role &&
      !attrs?.["aria-label"]
    ) {
      this.nodes--;
      return null;
    }
    if (parentShown && !shown) {
      data.shown = false;
    }
    return data;
  }

  isShown(element) {
    if (!element.checkVisibility || element.checkVisibility()) {
      return true;
    }
    // Slots and other boxless wrappers show what they hold.
    return this.window.getComputedStyle(element).display == "contents";
  }

  children(parent, depth, shown) {
    let kids = [];
    for (let node of parent.childNodes) {
      if (node.nodeType == node.TEXT_NODE) {
        let text = node.data.replace(/\s+/g, " ").trim();
        if (text) {
          kids.push(clip(text, MAX_TEXT));
        }
      } else if (node.nodeType == node.ELEMENT_NODE) {
        let kid = this.element(node, depth + 1, shown);
        if (kid) {
          kids.push(kid);
        }
      }
    }
    return kids;
  }

  attributes(element) {
    let custom = element.localName.includes("-");
    let attrs = null;
    let count = 0;
    for (let { name, value } of element.attributes) {
      if (count >= MAX_ATTRIBUTES) {
        break;
      }
      let kept =
        ATTRIBUTE.test(name) ||
        (custom &&
          value.length <= 80 &&
          name != "style" &&
          !name.startsWith("on"));
      if (!kept || (name == "src" && element.localName != "img")) {
        continue;
      }
      attrs ??= {};
      attrs[name] = clip(value, MAX_VALUE);
      count++;
    }
    return attrs;
  }
}

function readRule(document, rule) {
  if (!rule) {
    return null;
  }
  let entry = { id: rule.id, read: null };
  try {
    let result = transcribe(document, rule, { coverage: true });
    if (result) {
      entry.read = {
        items: result.count,
        sections: result.model.sections.map(
          section => section.heading ?? section.id
        ),
        missed: result.missed,
      };
    }
  } catch (e) {
    entry.error = String(e);
  }
  return entry;
}

/**
 * Measures a page with its rule's stylesheet applied: where the main content
 * ends up, and how many elements each hide and remove selector finds and
 * leaves drawn. Run in the page's process while it's folded.
 *
 * @param {Window} window The page.
 * @param {object} rule The page's compiled rule.
 * @returns {object}
 */
export function measureFold(window, rule) {
  let document = window.document;
  let report = selectors =>
    selectors.map(selector => {
      let found = queryAllDeep(document, selector);
      return {
        selector,
        found: found.length,
        drawn: found.filter(element =>
          element.checkVisibility({
            visibilityProperty: true,
            opacityProperty: true,
          })
        ).length,
      };
    });
  let main = document.querySelector("main, [role='main']");
  return {
    main: main ? round(main.getBoundingClientRect()) : null,
    hide: report(rule.hide),
    remove: report(rule.remove ?? []),
  };
}

/**
 * Describes the navigation of a page. Run in the page's process, with its
 * own sidebar shown.
 *
 * @param {Window} window The page.
 * @param {?object} rule The page's compiled rule, if it has one.
 * @returns {object} The capture.
 */
export function capturePage(window, rule = null) {
  let document = window.document;
  let { rich, truncated } = survey(document);
  let scored = rich
    .map(entry => score(entry, window))
    .filter(Boolean)
    .sort((a, b) => b.points - a.points);
  let candidates = [];
  for (let entry of scored) {
    if (candidates.length >= MAX_CANDIDATES) {
      break;
    }
    // Parts and wrappers of a better candidate add nothing.
    let overlaps = candidates.some(
      other =>
        contains(other.element, entry.element) ||
        contains(entry.element, other.element)
    );
    if (!overlaps) {
      candidates.push(entry);
    }
  }

  let serializer = new Serializer(window);
  let containers = [];
  for (let candidate of candidates) {
    if (containers.length >= MAX_CONTAINERS) {
      break;
    }
    let element = containerOf(candidate, window);
    if (
      containers.some(
        other =>
          contains(other.element, element) || contains(element, other.element)
      )
    ) {
      continue;
    }
    containers.push({
      element,
      path: pathOf(element),
      ancestors: ancestorsOf(element),
      layout: layoutOf(element, window),
      siblings: siblingsOf(element),
      tree: serializer.element(element),
    });
  }

  // A menu or dialog the site has open outside the sidebar, such as a row
  // menu opened before capturing, so a rule's popups can be checked.
  // Also what an expanded button says it controls, for menus without a role.
  let controlled = queryAllDeep(
    document,
    "[aria-expanded='true'][aria-controls]"
  )
    .map(trigger =>
      trigger
        .getRootNode()
        .getElementById?.(trigger.getAttribute("aria-controls").split(/\s+/)[0])
    )
    .filter(Boolean);
  let overlays = [
    ...new Set([...queryAllDeep(document, OVERLAYS), ...controlled]),
  ]
    .filter(
      element =>
        element.checkVisibility() &&
        !containers.some(container => contains(container.element, element))
    )
    .slice(0, MAX_OVERLAYS)
    .map(element => ({
      path: pathOf(element),
      tree: serializer.element(element),
    }));

  let main = document.querySelector("main, [role='main']");
  return {
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    url: document.URL,
    title: clip(document.title, 200),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    rule: readRule(document, rule),
    candidates: candidates.map(candidate => ({
      path: pathOf(candidate.element),
      links: candidate.links,
      score: Math.round(candidate.points * 10) / 10,
      reasons: candidate.reasons,
      rect: round(candidate.rect),
      position: window.getComputedStyle(candidate.element).position,
    })),
    containers: containers.map(
      ({ element: _element, ...container }) => container
    ),
    overlays,
    main: main
      ? { path: pathOf(main), rect: round(main.getBoundingClientRect()) }
      : null,
    truncated: truncated || serializer.truncated,
  };
}

/**
 * @param {object} capture
 * @returns {string} The capture with a note for the AI that reads it.
 */
export function formatCapture(capture) {
  return [
    `Mono Fold capture: ${capture.url}`,
    "이 사이트의 사이드바를 Fold에 등록하거나 규칙을 고쳐 주세요. 절차는 저장소의 mono/skills/fold-site/SKILL.md를 따릅니다.",
    "사이드바에 개인 정보(구독 목록, 사용자 이름 등)가 들어 있을 수 있습니다. 테스트 자료로 저장할 때는 익명화하세요.",
    "",
    "```json",
    JSON.stringify(capture),
    "```",
    "",
  ].join("\n");
}

function setAttributes(element, attrs = {}) {
  for (let [name, value] of Object.entries(attrs)) {
    try {
      element.setAttribute(name, value);
    } catch {
      // Not a valid attribute name here.
    }
  }
}

function attach(host) {
  try {
    return host.attachShadow({ mode: "open" });
  } catch {
    // Elements that can't host a shadow tree keep its content as children.
    return host;
  }
}

function create(document, tag, svg) {
  try {
    return svg
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
  } catch {
    return document.createElement("div");
  }
}

function build(document, data) {
  if (typeof data == "string") {
    return document.createTextNode(data);
  }
  let element = create(document, data.tag, data.svg);
  if (data.svg && isSafeIcon(data.icon)) {
    let [, open = "", inner = ""] =
      /^<svg([^>]*)>([\s\S]*)<\/svg>$/.exec(data.icon) ?? [];
    for (let [, name, value] of open.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (name != "xmlns") {
        element.setAttribute(
          name,
          value.replace(/&quot;/g, '"').replace(/&amp;/g, "&")
        );
      }
    }
    // Shapes only, as isSafeIcon checks; captures are rebuilt for checks.
    // eslint-disable-next-line no-unsanitized/property
    element.innerHTML = inner;
  }
  setAttributes(element, data.attrs);
  for (let kid of data.kids ?? []) {
    element.append(build(document, kid));
  }
  if (data.shadow) {
    let root = attach(element);
    for (let kid of data.shadow) {
      root.append(build(document, kid));
    }
  }
  return element;
}

/**
 * Rebuilds the captured navigation into a document, under copies of the
 * elements above it, so that a rule can be read against it.
 *
 * @param {Document} document An empty HTML document.
 * @param {object} capture
 * @returns {Document}
 */
export function rebuildCapture(document, capture) {
  for (let container of capture.containers ?? []) {
    let parent = document.body;
    for (let part of container.ancestors ?? []) {
      if (part == "#shadow-root") {
        parent = attach(parent);
        continue;
      }
      let element = create(document, part.tag);
      setAttributes(element, part.attrs);
      parent.append(element);
      parent = element;
    }
    if (container.tree) {
      parent.append(build(document, container.tree));
    }
  }
  return document;
}

function selectorsOf(rule) {
  let groups = rule.groups ?? {};
  return [
    ...rule.root,
    ...rule.hide,
    ...(rule.remove ?? []),
    ...(rule.exclude ?? []),
    ...(rule.extras ?? []).map(extra => extra.items),
    rule.currentSelector,
    rule.popups,
    rule.overlays,
    groups.each,
    groups.heading,
    groups.items,
    groups.container,
    groups.pressed,
    groups.secondary?.selector,
    groups.secondary?.pressed,
  ].filter(Boolean);
}

/**
 * Checks a rule against a capture of its site: the rule is valid, covers
 * the captured address and reads every control of the captured sidebar
 * that it doesn't exclude. A capture may carry
 * `expect: { minItems, sections, labels, current }`: the item count,
 * section headings, item or action labels and current item label the rule
 * should read from it.
 *
 * @param {object} rule The rule as written.
 * @param {object} capture
 * @param {Document} document An empty HTML document to rebuild it into.
 * @returns {{problems: string[], warnings: string[], model: ?object}}
 */
export function checkCapture(rule, capture, document) {
  let problems = validateRule(rule);
  let warnings = [];
  if (problems.length) {
    return { problems, warnings, model: null };
  }
  if (
    typeof MatchPatternSet == "function" &&
    !new MatchPatternSet(rule.matches).matches(capture.url)
  ) {
    problems.push(`matches doesn't cover ${capture.url}`);
  }
  for (let selector of selectorsOf(rule)) {
    try {
      document.querySelector(selector);
    } catch {
      problems.push(`"${selector}" is not a valid selector`);
    }
  }
  if (problems.length) {
    return { problems, warnings, model: null };
  }

  rebuildCapture(document, capture);
  let result = transcribe(document, compileRule(rule), {
    url: capture.url,
    coverage: true,
  });
  if (!result) {
    problems.push("none of the root selectors finds the sidebar");
    return { problems, warnings, model: null };
  }
  let { model, count, missed } = result;
  let minItems = rule.ready?.minItems ?? 1;
  if (count < minItems) {
    problems.push(
      `reads ${count} items, fewer than ready.minItems ${minItems}`
    );
  }
  // Fold carries every function of the sidebar over: what isn't read has
  // to be read or excluded on purpose.
  if (missed.length) {
    problems.push(
      `${missed.length} controls aren't read or excluded: ${missed.join(", ")}`
    );
  }
  let items = model.sections.flatMap(section => section.items);
  let current = items.filter(item => item.current).map(item => item.label);
  if (!current.length) {
    warnings.push("no item is current at the captured address");
  }
  if (!rule.hide.some(selector => queryDeep(document, selector))) {
    warnings.push(
      "no hide selector matches the captured elements; check them on the page"
    );
  }

  let expect = capture.expect ?? {};
  if (expect.minItems != undefined && count < expect.minItems) {
    problems.push(`reads ${count} items, expected at least ${expect.minItems}`);
  }
  let headings = model.sections.map(section => section.heading);
  for (let heading of expect.sections ?? []) {
    if (!headings.includes(heading)) {
      problems.push(`no section "${heading}"; read ${headings.join(", ")}`);
    }
  }
  let labels = new Set([
    ...model.sections.flatMap(section =>
      (section.actions ?? []).map(action => action.label)
    ),
    ...items.flatMap(item => [
      item.label,
      ...(item.actions ?? []).map(action => action.label),
    ]),
  ]);
  for (let label of expect.labels ?? []) {
    if (!labels.has(label)) {
      problems.push(`nothing reads "${label}"`);
    }
  }
  if (expect.current != undefined && !current.includes(expect.current)) {
    problems.push(
      `"${expect.current}" isn't current; current: ${current.join(", ") || "none"}`
    );
  }
  return { problems, warnings, model };
}
