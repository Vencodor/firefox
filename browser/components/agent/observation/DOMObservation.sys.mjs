/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { rankCandidates } from "./CandidateRanking.sys.mjs";

const ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemradio",
  "option",
  "gridcell",
  "combobox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "menuitemcheckbox",
]);
const SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  "[onclick]",
  ...[...ROLES].map(role => `[role="${role}"]`),
].join(",");
const GROUP_SELECTOR =
  'tr,[role="row"],li,[role="listitem"],article,[role="article"],fieldset,section,dialog,nav,aside,form,[role="search"],[role="group"],[role="dialog"],[role="complementary"],[role="region"],[role="banner"],[role="navigation"],ytd-video-renderer,ytm-shorts-lockup-view-model,.fds-web-doc-root,.fds-aib-expandable-container';

function normalize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function roleOf(row) {
  if (ROLES.has(row.declared_role)) {
    return row.declared_role;
  }
  if (["button", "summary"].includes(row.tag)) {
    return "button";
  }
  if (row.tag === "a") {
    return "link";
  }
  if (row.tag === "select") {
    return "combobox";
  }
  if (row.tag === "textarea" || row.contenteditable) {
    return "textbox";
  }
  if (row.tag === "input") {
    if (["checkbox", "radio"].includes(row.type)) {
      return row.type;
    }
    if (["button", "submit", "reset", "image"].includes(row.type)) {
      return "button";
    }
    if (row.type === "search") {
      return "searchbox";
    }
    if (row.type === "number") {
      return "spinbutton";
    }
    if (
      [
        "text",
        "email",
        "url",
        "tel",
        "date",
        "time",
        "datetime-local",
        "month",
        "week",
      ].includes(row.type)
    ) {
      return "textbox";
    }
    if (row.type === "range") {
      return "slider";
    }
    if (row.type === "color") {
      return "button";
    }
  }
  return row.generic_click ? "button" : null;
}

export function collectDOMObservation(window, options = {}) {
  const { document, performance } = window;
  const NodeConstructor = window.Node;
  const getComputedStyle = window.getComputedStyle.bind(window);
  const started = performance.now();
  const textLimit = Math.max(1, options.textLimit ?? 6000);
  const contextLimit = Math.max(1, options.contextLimit ?? 320);
  const clip = options.clip || {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  const roots = [document];
  let domCount = 0;
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index].querySelectorAll("*")) {
      domCount++;
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
      }
    }
  }
  const parentCache = new WeakMap();
  function parentOf(element) {
    if (!element) {
      return null;
    }
    if (!parentCache.has(element)) {
      parentCache.set(
        element,
        element.assignedSlot ||
          element.parentElement ||
          element.getRootNode().host ||
          null
      );
    }
    return parentCache.get(element);
  }
  const closestCache = new WeakMap();
  function closest(element, selector) {
    if (!element) {
      return null;
    }
    if (!closestCache.has(element)) {
      closestCache.set(element, new Map());
    }
    const cache = closestCache.get(element);
    if (!cache.has(selector)) {
      cache.set(
        selector,
        element.matches(selector)
          ? element
          : closest(parentOf(element), selector)
      );
    }
    return cache.get(selector);
  }
  const visibilityCache = new WeakMap();
  function cssVisible(element) {
    if (!visibilityCache.has(element)) {
      let visible = element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
      if (!visible && getComputedStyle(element).display === "contents") {
        const style = getComputedStyle(element);
        visible =
          style.visibility === "visible" &&
          style.opacity !== "0" &&
          (!parentOf(element) || cssVisible(parentOf(element)));
      }
      visibilityCache.set(element, visible);
    }
    return visibilityCache.get(element);
  }
  function composedChildren(node) {
    if (
      node.nodeType === NodeConstructor.ELEMENT_NODE &&
      node.tagName === "SLOT"
    ) {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) {
        return assigned;
      }
    }
    return node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
  }
  const matches = roots.flatMap(root =>
    Array.from(root.querySelectorAll(SELECTOR))
  );
  const rectCache = new WeakMap();
  function rectOf(element) {
    if (!rectCache.has(element)) {
      const rect = element.getBoundingClientRect();
      rectCache.set(element, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    }
    return rectCache.get(element);
  }
  function visibleRect(rect) {
    const left = Math.max(rect.x, clip.left),
      top = Math.max(rect.y, clip.top);
    const right = Math.min(rect.x + rect.width, clip.right);
    const bottom = Math.min(rect.y + rect.height, clip.bottom);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }
  function containsComposed(ancestor, element) {
    for (let node = element; node; node = parentOf(node)) {
      if (node === ancestor) {
        return true;
      }
    }
    return false;
  }
  const activeElements = new WeakSet();
  for (let active = document.activeElement; active; ) {
    if (active !== document.body && active !== document.documentElement) {
      activeElements.add(active);
    }
    const next = active.shadowRoot?.activeElement;
    if (!next || next === active) {
      break;
    }
    active = next;
  }
  const repetitionSiblings = new Map();
  const repetitionItemIds = new WeakMap();
  const repetitionGroupIds = new WeakMap();
  const repetitionSignatures = new WeakMap();
  let nextRepetitionItemId = 1;
  let nextRepetitionGroupId = 1;
  function repetitionSignature(node) {
    if (repetitionSignatures.has(node)) {
      return repetitionSignatures.get(node);
    }
    const classes = Array.from(node.classList || []).sort().join(".");
    const role = node.getAttribute("role") || "";
    const children = Array.from(node.children || [], child =>
      child.tagName.toLowerCase()
    ).join(",");
    const signature = `${node.tagName.toLowerCase()}|${role}|${classes}|${children}`;
    repetitionSignatures.set(node, signature);
    return signature;
  }
  function repeatedSiblingGroups(parent) {
    if (!repetitionSiblings.has(parent)) {
      const groups = new Map();
      for (const child of parent.children || []) {
        const signature = repetitionSignature(child);
        if (!groups.has(signature)) {
          groups.set(signature, []);
        }
        groups.get(signature).push(child);
      }
      repetitionSiblings.set(parent, groups);
    }
    return repetitionSiblings.get(parent);
  }
  function repetitionCard(element) {
    for (
      let node = element, depth = 0;
      node && depth <= 8;
      node = parentOf(node), depth++
    ) {
      if (node.matches('body,html,main,[role="main"]')) {
        break;
      }
      const boundary = closest(
        node,
        'nav,[role="navigation"],dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],search,[role="search"]'
      );
      if (boundary) {
        break;
      }
      const parent = parentOf(node);
      if (!parent || !parent.children) {
        continue;
      }
      const semanticCard = node.matches(
        'li,tr,article,[role="article"],[role="listitem"],[role="row"],ytd-video-renderer,ytd-rich-item-renderer,ytd-grid-video-renderer'
      );
      const classCard = node.classList?.length > 0;
      if (!semanticCard && !classCard) {
        continue;
      }
      const signature = repetitionSignature(node);
      const siblings = repeatedSiblingGroups(parent).get(signature);
      if (!siblings || siblings.length < 2) {
        continue;
      }
      if (
        !semanticCard &&
        (node.children.length < 2 ||
          !node.querySelector("h1,h2,h3,h4,[role='heading'],img[alt]") ||
          !node.querySelector(SELECTOR))
      ) {
        continue;
      }
      if (!repetitionItemIds.has(node)) {
        repetitionItemIds.set(node, `i${nextRepetitionItemId++}`);
      }
      if (!repetitionGroupIds.has(parent)) {
        repetitionGroupIds.set(parent, new Map());
      }
      const groupIds = repetitionGroupIds.get(parent);
      if (!groupIds.has(signature)) {
        groupIds.set(signature, `g${nextRepetitionGroupId++}`);
      }
      return {
        group: groupIds.get(signature),
        item: repetitionItemIds.get(node),
      };
    }
    return null;
  }
  function landmark(element, selector, requireVisible = false) {
    let node = closest(element, selector);
    while (node && requireVisible && !cssVisible(node)) {
      node = closest(parentOf(node), selector);
    }
    return node;
  }
  function hittable(element, rect, associated = null) {
    const root = element.getRootNode();
    const boxes = Array.from(element.getClientRects(), box => ({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    }));
    for (const box of (boxes.length ? boxes : [rect]).slice(0, 16)) {
      const r = visibleRect(box);
      if (r.width <= 0 || r.height <= 0) {
        continue;
      }
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.15, 0.5],
        [0.85, 0.5],
        [0.5, 0.15],
        [0.5, 0.85],
      ]) {
        const x = r.left + r.width * fx,
          y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (
          !hit ||
          !(
            hit === associated ||
            containsComposed(element, hit) ||
            containsComposed(hit, element)
          )
        ) {
          continue;
        }
        const local = root.elementFromPoint?.(x, y);
        if (
          local &&
          (local === associated || containsComposed(element, local))
        ) {
          return true;
        }
      }
    }
    return false;
  }
  function nameOf(element, visited = new Set(), labelText = false) {
    if (!element || visited.has(element)) {
      return "";
    }
    if (
      labelText &&
      element.matches(
        'input,textarea,select,button,[role="button"],[role="switch"],[role="checkbox"],[role="radio"]'
      )
    ) {
      return "";
    }
    visited.add(element);
    labelText ||= element.tagName === "LABEL";
    const reference = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map(id =>
        nameOf(
          element.getRootNode().getElementById?.(id) ||
            document.getElementById(id),
          visited
        )
      )
      .filter(Boolean)
      .join(" ");
    if (normalize(reference)) {
      return normalize(reference);
    }
    const aria = normalize(element.getAttribute("aria-label"));
    if (aria) {
      return aria;
    }
    const labels = Array.from(element.labels || [])
      .map(label => nameOf(label, visited))
      .filter(Boolean)
      .join(" ");
    if (labels) {
      return normalize(labels);
    }
    if (["button", "submit", "reset"].includes(element.type) && element.value) {
      return normalize(element.value);
    }
    if (element.getAttribute("alt")) {
      return normalize(element.getAttribute("alt"));
    }
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
      const text = Array.from(composedChildren(element), child => {
        if (child.nodeType === NodeConstructor.TEXT_NODE) {
          return child.textContent;
        }
        if (
          child.nodeType === NodeConstructor.ELEMENT_NODE &&
          child.getAttribute("aria-hidden") !== "true" &&
          !child.matches("script,style,noscript,template")
        ) {
          return nameOf(child, visited, labelText);
        }
        return "";
      }).join(" ");
      if (normalize(text)) {
        return normalize(text);
      }
    }
    return normalize(
      element.getAttribute("title") || element.getAttribute("placeholder")
    );
  }
  function placeholderOf(element) {
    const declared = normalize(
      element.getAttribute("placeholder") ||
        element.getAttribute("aria-placeholder")
    );
    if (declared) {
      return declared;
    }
    const hint = normalize(element.getAttribute("data-placeholder"));
    if (!hint || !element.isContentEditable || normalize(element.textContent)) {
      return "";
    }
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      if (
        style.content === JSON.stringify(hint) &&
        style.display !== "none" &&
        style.visibility === "visible" &&
        style.opacity !== "0"
      ) {
        return hint;
      }
    }
    return "";
  }
  const geometry = [];
  const targets = new Map();
  const candidates = matches.map((element, index) => {
    const type = element.type || "";
    const excludedType = ["password", "file", "hidden"].includes(type);
    let target = element;
    if (
      ["radio", "checkbox"].includes(type) &&
      (!cssVisible(element) || !hittable(element, rectOf(element)))
    ) {
      target =
        Array.from(element.labels || []).find(
          label => cssVisible(label) && hittable(label, rectOf(label), element)
        ) || element;
    }
    geometry.push(target);
    const rect = rectOf(target),
      intersection = visibleRect(rect);
    const visible = cssVisible(target);
    const hidden = Boolean(closest(element, "[inert]"));
    const disabled =
      element.matches(":disabled") ||
      Boolean(closest(element, '[aria-disabled="true"]'));
    const inViewport = intersection.width > 0 && intersection.height > 0;
    const occluded =
      visible &&
      inViewport &&
      !hittable(target, rect, target !== element ? element : null);
    const usable =
      !excludedType &&
      !hidden &&
      visible &&
      !disabled &&
      inViewport &&
      !occluded;
    let value = "";
    if (usable && "value" in element) {
      value = String(element.value);
    } else if (usable && element.isContentEditable) {
      value = String(element.innerText);
    }
    const row = {
      node_id: index + 1,
      dom_id: element.id || "",
      tag: element.tagName.toLowerCase(),
      type,
      declared_role: element.getAttribute("role") || "",
      generic_click: element.hasAttribute("onclick"),
      css_visible: visible,
      interaction_hidden: hidden,
      aria_hidden: Boolean(closest(element, '[aria-hidden="true"]')),
      disabled,
      in_viewport: inViewport,
      occluded,
      rect,
      readonly:
        Boolean(element.readOnly) ||
        element.getAttribute("aria-readonly") === "true",
      contenteditable: element.isContentEditable,
      nested_button:
        element.getAttribute("role") === "gridcell" &&
        Boolean(element.querySelector('button,[role="button"]')),
      label: usable ? nameOf(element) : "",
      value,
    };
    if (target !== element) {
      row.interaction_via = "label";
    }
    if (usable) {
      const placeholder = placeholderOf(element);
      if (placeholder) {
        row.placeholder = placeholder;
        if (!row.label) {
          row.label = placeholder;
        }
      }
    }
    const declaredType = (element.getAttribute("type") || type).toLowerCase();
    if (
      usable &&
      element.tagName === "INPUT" &&
      [
        "date",
        "time",
        "datetime-local",
        "month",
        "week",
        "range",
        "number",
        "color",
      ].includes(declaredType)
    ) {
      row.input_type = declaredType;
      for (const attribute of ["min", "max", "step"]) {
        if (element.hasAttribute(attribute)) {
          row[attribute] = element.getAttribute(attribute);
        }
      }
    }
    if (usable && element.tagName === "A") {
      row.href = element.href;
    }
    for (const state of [
      "checked",
      "selected",
      "expanded",
      "pressed",
      "current",
    ]) {
      const stateValue = element.getAttribute(`aria-${state}`);
      if (stateValue !== null) {
        row[state] = stateValue;
      }
    }
    if (usable) {
      const nativeFooter = landmark(element, "footer,[role='contentinfo']");
      const footer =
        nativeFooter &&
        (nativeFooter.getAttribute("role") === "contentinfo" ||
          !landmark(
            parentOf(nativeFooter),
            'article,section,aside,nav,[role="article"]'
          ));
      const repetition = repetitionCard(element);
      const visibleArea =
        Math.max(0, intersection.width) * Math.max(0, intersection.height);
      const rectArea = rect.width * rect.height;
      row.ranking_features = {
        navigation: Boolean(landmark(element, "nav,[role='navigation']")),
        dialog: Boolean(
          landmark(
            element,
            'dialog[open],[role="dialog"],[role="alertdialog"]',
            true
          )
        ),
        menu: Boolean(landmark(element, '[role="menu"],[role="listbox"]', true)),
        search: Boolean(landmark(element, 'search,[role="search"]')),
        main: Boolean(landmark(element, "main,[role='main']")),
        complementary: Boolean(
          landmark(element, "aside,[role='complementary']")
        ),
        footer: Boolean(footer),
        invalid:
          element.matches(":user-invalid") ||
          element.getAttribute("aria-invalid") === "true",
        focused: activeElements.has(element),
        disclosure:
          (["true", "menu", "listbox", "tree", "grid", "dialog"].includes(
            element.getAttribute("aria-haspopup")
          ) &&
            element.getAttribute("aria-expanded") !== "true") ||
          element.getAttribute("aria-expanded") === "false" ||
          (element.tagName === "SUMMARY" &&
            element.parentElement?.tagName === "DETAILS" &&
            !element.parentElement.open),
        pagination:
          element.tagName === "A" &&
          /(?:^|\s)(?:next|prev)(?:\s|$)/i.test(element.getAttribute("rel") || ""),
        submit:
          Boolean(element.form) &&
          ((element.tagName === "BUTTON" && element.type === "submit") ||
            (element.tagName === "INPUT" && ["submit", "image"].includes(type))),
        reset:
          Boolean(element.form) &&
          ((element.tagName === "BUTTON" && element.type === "reset") ||
            (element.tagName === "INPUT" && type === "reset")),
        visible_fraction:
          rectArea > 0
            ? Math.min(1, Math.max(0, visibleArea / rectArea))
            : 0,
      };
      if (repetition) {
        row.ranking_features.repetition_group = repetition.group;
        row.ranking_features.repetition_item = repetition.item;
      }
    }
    if (["checkbox", "radio"].includes(type)) {
      row.checked = String(element.checked);
    }
    if (element.tagName === "SELECT" && usable) {
      row.current_value = Array.from(
        element.selectedOptions,
        option => option.label
      ).join(", ");
      row.options = Array.from(element.options, option => ({
        label: option.label,
        value: option.value,
        selected: option.selected,
        disabled:
          option.disabled || Boolean(option.closest("optgroup[disabled]")),
      }));
    }
    targets.set(row.node_id, { element, target });
    return row;
  });
  const controlsEnded = performance.now();
  const range = document.createRange();
  function renderedText(groups, limit, viewportOnly = false) {
    const parts = [];
    let length = 0,
      visited = 0,
      truncated = false;
    function walk(node) {
      if (length > limit || visited++ > 5000) {
        truncated = true;
        return;
      }
      if (node.nodeType === NodeConstructor.TEXT_NODE) {
        const parent = node.parentElement || node.getRootNode().host;
        const value = normalize(node.textContent);
        if (
          !value ||
          !parent ||
          closest(
            parent,
            'script,style,noscript,template,input,textarea,select,[inert],[aria-hidden="true"]'
          ) ||
          !cssVisible(parent)
        ) {
          return;
        }
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return;
        }
        const r = visibleRect({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
        if (viewportOnly && (r.width <= 0 || r.height <= 0)) {
          return;
        }
        if (parts.at(-1) !== value) {
          parts.push(value);
          length += value.length + 1;
        }
        return;
      }
      if (
        node.nodeType === NodeConstructor.ELEMENT_NODE &&
        node.matches(
          'script,style,noscript,template,input,textarea,select,[inert],[aria-hidden="true"]'
        )
      ) {
        return;
      }
      for (const child of composedChildren(node)) {
        if (length > limit || visited > 5000) {
          truncated = true;
          break;
        }
        walk(child);
      }
    }
    for (const group of groups) {
      walk(group);
    }
    const text = parts.join(" ");
    return {
      text: text.slice(0, limit),
      truncated: truncated || text.length > limit,
    };
  }
  const contextCache = new Map();
  const compactCache = new WeakMap();
  function repeatedCard(node) {
    if (!compactCache.has(node)) {
      const count = node.querySelectorAll(SELECTOR).length;
      const signature = element =>
        `${element.tagName}.${Array.from(element.classList).sort().join(".")}`;
      const siblings = node.parentElement?.children || [];
      compactCache.set(
        node,
        count > 1 &&
          count <= 30 &&
          node.children.length > 1 &&
          Boolean(
            node.querySelector('h1,h2,h3,h4,[role="heading"],img[alt]')
          ) &&
          Array.from(siblings).some(
            other => other !== node && signature(other) === signature(node)
          )
      );
    }
    return compactCache.get(node);
  }
  function groupName(group) {
    const aria = normalize(group.getAttribute("aria-label"));
    if (aria) {
      return aria;
    }
    const referenced = (group.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map(id =>
        nameOf(
          group.getRootNode().getElementById?.(id) ||
            document.getElementById(id)
        )
      )
      .filter(Boolean)
      .join(" ");
    if (referenced) {
      return referenced;
    }
    const heading = group.querySelector(
      ':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > legend,:scope > [role="heading"]'
    );
    if (heading && cssVisible(heading)) {
      return nameOf(heading);
    }
    if (group.matches("form,fieldset")) {
      const before = group.previousElementSibling;
      if (
        before &&
        cssVisible(before) &&
        !before.matches(SELECTOR) &&
        !before.querySelector(SELECTOR)
      ) {
        const text = renderedText([before], 81).text;
        if (text && text.length <= 80) {
          return text;
        }
      }
    }
    return "";
  }
  function contextOf(element) {
    let group = closest(element, GROUP_SELECTOR);
    if (element.matches('[role="switch"],[role="checkbox"],[role="radio"]')) {
      group = closest(element, "label") || group;
    }
    for (
      let node = parentOf(element), depth = 0;
      node && node !== group && depth < 8;
      node = parentOf(node), depth++
    ) {
      if (node.matches("body,html,main")) {
        break;
      }
      if (repeatedCard(node)) {
        group = node;
        break;
      }
    }
    if (!group) {
      for (
        let node = parentOf(element), depth = 0;
        node && depth < 6;
        node = parentOf(node), depth++
      ) {
        if (node.matches("body,html,main")) {
          break;
        }
        if (
          node.querySelector("h1,h2,h3,h4,[role=heading]") &&
          node.querySelectorAll(SELECTOR).length <= 30
        ) {
          group = node;
          break;
        }
      }
    }
    if (!group) {
      return null;
    }
    if (
      group.tagName === "TR" &&
      group.previousElementSibling?.matches("tr.athing")
    ) {
      group = group.previousElementSibling;
    }
    if (!contextCache.has(group)) {
      const groups =
        group.matches("tr.athing") && group.nextElementSibling
          ? [group, group.nextElementSibling]
          : [group];
      const scope = closest(
        element,
        'ul[aria-label],ol[aria-label],ul[aria-labelledby],ol[aria-labelledby],nav,aside,form,dialog,[role="dialog"],[role="search"],[role="group"]'
      );
      const context = {
        id: `c${contextCache.size + 1}`,
        kind: group.getAttribute("role") || group.tagName.toLowerCase(),
        ...renderedText(groups, contextLimit),
      };
      const heading = groupName(group);
      if (heading) {
        context.heading = heading.slice(0, 160);
      }
      if (scope) {
        context.scope =
          groupName(scope) || scope.id || scope.tagName.toLowerCase();
      }
      contextCache.set(group, context);
    }
    return contextCache.get(group);
  }
  for (let index = 0; index < candidates.length; index++) {
    const row = candidates[index];
    if (
      !row.in_viewport ||
      !row.css_visible ||
      row.interaction_hidden ||
      row.disabled ||
      row.occluded ||
      ["password", "file", "hidden"].includes(row.type) ||
      row.nested_button
    ) {
      continue;
    }
    const context = contextOf(geometry[index]);
    if (context && (context.text !== row.label || context.scope)) {
      row.context = context;
    }
  }
  const contextEnded = performance.now();
  const rendered = renderedText(
    [document.body || document.documentElement],
    textLimit,
    true
  );
  const textEnded = performance.now();
  const frameElements = roots.flatMap(root =>
    Array.from(root.querySelectorAll("iframe,frame"))
  );
  const frames = frameElements
    .filter(
      frame =>
        cssVisible(frame) &&
        !closest(frame, "[inert]") &&
        hittable(frame, rectOf(frame))
    )
    .map(frame => {
      const rect = rectOf(frame);
      return {
        browsingContextId: frame.browsingContext?.id ?? null,
        rect,
        offset_x: rect.x + frame.clientLeft,
        offset_y: rect.y + frame.clientTop,
        clip: visibleRect(rect),
        title: frame.title || "",
      };
    });
  const snapshot = {
    url: window.location.href,
    title: document.title,
    ready_state: document.readyState,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scroll_y: window.scrollY,
    },
    dom_element_count: domCount,
    shadow_root_count: roots.length - 1,
    iframe_count: frameElements.length,
    frames,
    text: rendered.text,
    text_truncated: rendered.truncated,
    candidates,
    timing: {
      controls_ms: controlsEnded - started,
      context_ms: contextEnded - controlsEnded,
      text_ms: textEnded - contextEnded,
      browser_collect_ms: performance.now() - started,
    },
    coverage: {
      candidates: candidates.length,
      dom_elements: domCount,
      text_truncated: rendered.truncated,
      frames_missing_browsing_context: frames.filter(
        frame => frame.browsingContextId === null
      ).length,
    },
  };
  return { snapshot, targets };
}

export function filterCandidates(snapshot, { maxActions = 250 } = {}) {
  const limit = Math.max(0, Math.min(250, maxActions));
  const allRows = snapshot.candidates || [];
  let eligibleRows = allRows;
  const rejected = {};
  const stages = [{ stage: "selector_matches", remaining: allRows.length }];
  const predicates = [
    [
      "excluded_input_type",
      row => ["password", "file", "hidden"].includes(row.type),
    ],
    ["hidden_or_inert", row => row.interaction_hidden || !row.css_visible],
    ["disabled", row => row.disabled],
    ["outside_viewport", row => !row.in_viewport],
    ["occluded", row => Boolean(row.occluded)],
    ["unsupported_role", row => roleOf(row) === null],
    ["nested_gridcell_button", row => row.nested_button],
  ];
  for (const [reason, predicate] of predicates) {
    eligibleRows = eligibleRows.filter(row => {
      if (!predicate(row)) {
        return true;
      }
      rejected[reason] = (rejected[reason] || 0) + 1;
      return false;
    });
    stages.push({ stage: reason, remaining: eligibleRows.length });
  }
  eligibleRows = rankCandidates(eligibleRows, roleOf);
  const actions = [];
  for (const row of eligibleRows) {
    const role = roleOf(row);
    const base = {
      node_id: row.node_id,
      role,
      name: row.label || role,
      label: row.label || role,
      value: row.value,
      ranking: row.ranking,
      ...(row.context ? { context: row.context } : {}),
      rect: row.rect,
      ...Object.fromEntries(
        [
          "checked",
          "selected",
          "expanded",
          "pressed",
          "current",
          "href",
          "interaction_via",
          "frame",
          "input_type",
          "min",
          "max",
          "step",
        ]
          .filter(key => key in row)
          .map(key => [key, row[key]])
      ),
      ...(row.placeholder && row.placeholder !== row.label
        ? { placeholder: row.placeholder }
        : {}),
    };
    if (row.tag === "select") {
      actions.push({ ...base, operation: "CLICK" });
      for (const option of row.options || []) {
        if (!option.selected && !option.disabled) {
          actions.push({
            ...base,
            operation: "SELECT",
            option_label: option.label,
            option_value: option.value,
            value: row.current_value,
          });
        }
      }
    } else {
      const editable =
        !row.readonly &&
        (["textbox", "searchbox", "spinbutton"].includes(role) ||
          (role === "combobox" && ["input", "textarea"].includes(row.tag)));
      if (editable) {
        actions.push({ ...base, operation: "TYPE_TEXT" });
      }
      actions.push({ ...base, operation: "CLICK" });
    }
  }
  const byNode = new Map();
  actions.forEach((action, index) => {
    if (!byNode.has(action.node_id)) {
      byNode.set(action.node_id, []);
    }
    byNode.get(action.node_id).push(index);
  });
  const selected = new Set();
  for (let tier = 0; selected.size < Math.min(actions.length, limit); tier++) {
    let advanced = false;
    for (const positions of byNode.values()) {
      if (positions[tier] !== undefined) {
        selected.add(positions[tier]);
        advanced = true;
      }
      if (selected.size >= limit) {
        break;
      }
    }
    if (!advanced) {
      break;
    }
  }
  const chosen = actions.filter((_, index) => selected.has(index));
  const elements = [];
  const indexed = new Map();
  const targets_by_operation = {};
  for (const action of chosen) {
    let item = indexed.get(action.node_id);
    if (!item) {
      const sourceRow = eligibleRows.find(
        row => row.node_id === action.node_id
      );
      item = {
        index: String(elements.length + 1),
        node_id: action.node_id,
        name: action.name,
        role: action.role,
        value: action.value,
        ranking: action.ranking,
        operations: [],
        rect: action.rect,
        ...Object.fromEntries(
          [
            "checked",
            "selected",
            "expanded",
            "pressed",
            "current",
            "href",
            "interaction_via",
            "frame",
            "input_type",
            "min",
            "max",
            "step",
            "placeholder",
            "context",
          ]
            .filter(key => key in action)
            .map(key => [key, action[key]])
        ),
        ...(!sourceRow?.label ? { label_missing: true } : {}),
      };
      elements.push(item);
      indexed.set(action.node_id, item);
    }
    if (!item.operations.includes(action.operation)) {
      item.operations.push(action.operation);
    }
    const targetId =
      action.operation === "SELECT"
        ? `${item.index}:${(item.options ||= []).length + 1}`
        : item.index;
    if (action.operation === "SELECT") {
      item.options.push({
        index: targetId,
        label: action.option_label,
        value: action.option_value,
      });
    }
    (targets_by_operation[action.operation] ||= {})[targetId] = action.label;
  }
  for (const row of eligibleRows) {
    const item = indexed.get(row.node_id);
    if (item && row.tag === "select") {
      item.value = row.current_value ?? row.value;
      const total = (row.options || []).filter(
        option => !option.selected && !option.disabled
      ).length;
      item.options_total = total;
      if (total > (item.options?.length || 0)) {
        item.options_omitted = total - (item.options?.length || 0);
      }
    }
  }
  const coverage = {
    eligible_elements: eligibleRows.length,
    selected_elements: elements.length,
    actions_before_cap: actions.length,
    actions_after_cap: chosen.length,
    omitted_actions: actions.length - chosen.length,
    omitted_elements: eligibleRows.length - elements.length,
    selector_matches: allRows.length,
  };
  return { elements, targets_by_operation, coverage, stages, rejected };
}
