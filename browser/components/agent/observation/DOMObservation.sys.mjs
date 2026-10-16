/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  DOMHeuristics,
  GROUP_SELECTOR,
  SELECTOR,
  analyzeTextMetrics,
  normalize,
  roleOf,
} from "./DOMHeuristics.sys.mjs";
import { rankCandidates, rankContextBlocks } from "./CandidateRanking.sys.mjs";

const PROSE_BLOCK_SELECTOR =
  'p,blockquote,dd,dt,figcaption,pre,h1,h2,h3,h4,h5,h6,[role="heading"],[slot="text-body"],[slot="title"]';

const UNIT_CONTAINER_SELECTOR =
  'h1,h2,h3,h4,h5,h6,[role="heading"],[role="alert"],[role="status"],p,blockquote,pre,dd,dt,figcaption,td,th,[slot="title"],[slot="text-body"],li,[role="listitem"],article,[role="article"],section,main,[role="main"],nav,[role="navigation"],aside,[role="complementary"],footer,[role="contentinfo"],header,[role="banner"],dialog,[role="dialog"],form,fieldset,div';

export function collectDOMObservation(window, options = {}) {
  const { document, performance } = window;
  const NodeConstructor = window.Node;
  const getComputedStyle = window.getComputedStyle.bind(window);
  const started = performance.now();
  const legacyMode = Boolean(options.legacyMode);
  const textMode = legacyMode ? "raw" : options.textMode ?? "ranked";
  const textLimit = Math.max(1, options.textLimit ?? 6000);
  const contextLimit = Math.max(1, options.contextLimit ?? 320);
  const clip = options.clip || {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const smallIframe = Boolean(options.smallIframe);

  const heuristics = new DOMHeuristics(window, { clip, legacyMode });
  const parentOf = heuristics.parentOf.bind(heuristics);
  const closest = heuristics.closest.bind(heuristics);
  const cssVisible = heuristics.cssVisible.bind(heuristics);
  const prunable = heuristics.prunable.bind(heuristics);
  const composedChildren = heuristics.composedChildren.bind(heuristics);
  const rectOf = heuristics.rectOf.bind(heuristics);
  const visibleRect = heuristics.visibleRect.bind(heuristics);
  const landmark = heuristics.landmark.bind(heuristics);
  const repetitionCard = heuristics.repetitionCard.bind(heuristics);

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

  const matches = roots.flatMap(root =>
    Array.from(root.querySelectorAll(SELECTOR))
  );

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
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
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
    const rect = rectOf(target);
    const intersection = visibleRect(rect);
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
      const role = roleOf(row);
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
          /(?:^|\s)(?:next|prev)(?:\s|$)/i.test(
            element.getAttribute("rel") || ""
          ),
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
        if (!legacyMode) {
          const subrole = heuristics.classifySubrole(element, {
            role,
            label: row.label,
            href: row.href || "",
            cardNode: repetition.cardNode,
          });
          if (subrole) {
            row.ranking_features.card_subrole = subrole;
          }
        }
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
    let length = 0;
    let visited = 0;
    let truncated = false;
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
        (node.matches(
          'script,style,noscript,template,input,textarea,select,[inert],[aria-hidden="true"]'
        ) ||
          prunable(node))
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

  function unitContainerForTextParent(parent) {
    const prose = closest(parent, PROSE_BLOCK_SELECTOR);
    if (prose) {
      const linkInCard = closest(parent, 'a[href],[role="link"]');
      if (
        linkInCard &&
        prose.matches('article,[role="article"],div') &&
        !prose.matches('p,blockquote,h1,h2,h3,h4,h5,h6,[role="heading"]')
      ) {
        return linkInCard;
      }
      return prose;
    }
    const controlOrLink = closest(
      parent,
      'button,[role="button"],a[href],[role="link"],[role="tab"],[role="menuitem"],summary,time,[datetime]'
    );
    if (controlOrLink) {
      return controlOrLink;
    }
    return (
      closest(parent, UNIT_CONTAINER_SELECTOR) ||
      parent ||
      document.body ||
      document.documentElement
    );
  }

  function collectContextBlocksAndState(rootNode) {
    const unitMap = new Map();
    const unitOrder = [];
    let visited = 0;
    let walkTruncated = false;
    let docMainBlockCount = 0;
    let docMainCharCount = 0;
    const seenMainUnits = new WeakSet();
    const hasMainLandmark = Boolean(
      document.querySelector('main,[role="main"]')
    );

    function walkContext(node) {
      if (visited++ > 8000) {
        walkTruncated = true;
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
        const unit = unitContainerForTextParent(parent);
        const inMainDoc = hasMainLandmark
          ? Boolean(landmark(unit, 'main,[role="main"]'))
          : !landmark(
              unit,
              'nav,[role="navigation"],footer,[role="contentinfo"],aside,[role="complementary"]'
            ) && !heuristics.isGlobalHeaderBanner(unit);

        if (inMainDoc) {
          docMainCharCount += value.length;
          const proseOrHeading =
            closest(unit, PROSE_BLOCK_SELECTOR) || unit;
          if (!seenMainUnits.has(proseOrHeading)) {
            seenMainUnits.add(proseOrHeading);
            docMainBlockCount++;
          }
        }

        const r = visibleRect({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
        if (r.width <= 0 || r.height <= 0) {
          return;
        }
        let entry = unitMap.get(unit);
        if (!entry) {
          entry = { unit, parts: [], order: unitOrder.length };
          unitMap.set(unit, entry);
          unitOrder.push(entry);
        }
        if (entry.parts.at(-1) !== value) {
          entry.parts.push(value);
        }
        return;
      }
      if (
        node.nodeType === NodeConstructor.ELEMENT_NODE &&
        (node.matches(
          'script,style,noscript,template,input,textarea,select,[inert],[aria-hidden="true"]'
        ) ||
          prunable(node))
      ) {
        return;
      }
      for (const child of composedChildren(node)) {
        if (visited > 8000) {
          walkTruncated = true;
          break;
        }
        walkContext(child);
      }
    }

    if (rootNode) {
      walkContext(rootNode);
    }

    const isIsolatedMainState =
      !smallIframe &&
      docMainBlockCount > 0 &&
      docMainBlockCount <= 5 &&
      docMainCharCount < 400;

    let hasAlert = false;
    let hasDialog = false;
    let primaryHeading = "";

    const blocks = [];
    for (const entry of unitOrder) {
      const { unit, parts, order } = entry;
      const text = normalize(parts.join(" "));
      if (!text) {
        continue;
      }
      const rect = rectOf(unit);
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const blockNodeId = `b${order + 1}`;
      targets.set(blockNodeId, { element: unit, target: unit });

      const nativeFooter = landmark(unit, "footer,[role='contentinfo']");
      const footer = Boolean(
        nativeFooter &&
          (nativeFooter.getAttribute("role") === "contentinfo" ||
            !landmark(
              parentOf(nativeFooter),
              'article,section,aside,nav,[role="article"]'
            ))
      );
      const alertNode = landmark(
        unit,
        '[role="alert"],[aria-live="assertive"]',
        true
      );
      const statusNode = !alertNode
        ? landmark(
            unit,
            '[role="status"],[aria-live="polite"],output',
            true
          )
        : null;
      let alertAssertive = false;
      let statusPolite = false;
      if (alertNode) {
        const aRect = rectOf(alertNode);
        if (aRect.width >= 20 && aRect.height >= 12) {
          alertAssertive = true;
          hasAlert = true;
        }
      } else if (statusNode) {
        const sRect = rectOf(statusNode);
        if (sRect.width >= 20 && sRect.height >= 12) {
          statusPolite = true;
        }
      }

      const blockingDialog =
        !smallIframe && heuristics.isBlockingDialog(unit, viewportArea);
      if (blockingDialog) {
        hasDialog = true;
      }

      const headingLevel = heuristics.headingLevelOf(unit);
      if (headingLevel === 1 && !primaryHeading) {
        primaryHeading = text.slice(0, 160);
      }

      const rep = repetitionCard(unit);
      const effectiveRole = roleOf({
        tag: unit.tagName.toLowerCase(),
        type: unit.type || "",
        declared_role: (unit.getAttribute("role") || "").toLowerCase(),
        contenteditable: unit.isContentEditable,
        generic_click: unit.hasAttribute("onclick"),
      });
      const subrole = heuristics.classifySubrole(unit, {
        role: effectiveRole,
        label: text,
        href: unit.href || "",
        cardNode: rep?.cardNode || null,
      });

      const inMain = Boolean(
        landmark(unit, 'main,[role="main"]') ||
          (landmark(unit, 'aside,[role="complementary"]') &&
            !heuristics.isExternalComplementary(unit))
      );
      const inCentralBand = !hasMainLandmark && heuristics.inCentralBand(unit);
      const metrics = analyzeTextMetrics(text);
      const controlDensity =
        effectiveRole && effectiveRole !== "link"
          ? 1
          : heuristics.controlDensityOf(unit);
      const translationDecision = heuristics.explainTranslationDecision(unit);

      blocks.push({
        node_id: blockNodeId,
        order,
        tag: unit.tagName.toLowerCase(),
        role: effectiveRole || (headingLevel > 0 ? "heading" : unit.tagName.toLowerCase()),
        text,
        rect,
        heading_level: headingLevel,
        alert_assertive: alertAssertive,
        status_polite: statusPolite,
        blocking_dialog: blockingDialog,
        footer,
        search: Boolean(landmark(unit, 'search,[role="search"]')),
        navigation: Boolean(landmark(unit, 'nav,[role="navigation"]')),
        header_banner: heuristics.isGlobalHeaderBanner(unit),
        main: inMain,
        in_central_band: inCentralBand,
        external_complementary: heuristics.isExternalComplementary(unit),
        card_subrole: subrole,
        is_sentence_like: metrics.isSentenceLike,
        control_density: controlDensity,
        small_iframe: smallIframe,
        repetition_group: rep?.group || null,
        repetition_item: rep?.item || null,
        translation: {
          included: translationDecision.included,
          reason: translationDecision.reason,
        },
      });
    }

    return {
      blocks,
      walkTruncated,
      stateSignals: {
        hasAlert,
        hasDialog,
        isIsolatedMainState,
        primaryHeading,
      },
    };
  }

  const contextCache = new Map();
  function repeatedCard(node) {
    if (!heuristics.compactCache.has(node)) {
      const count = node.querySelectorAll(SELECTOR).length;
      const signature = element =>
        `${element.tagName}.${Array.from(element.classList).sort().join(".")}`;
      const siblings = node.parentElement?.children || [];
      heuristics.compactCache.set(
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
    return heuristics.compactCache.get(node);
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

  const bodyRoot = document.body || document.documentElement;
  let rendered;
  let contextData = null;
  if (textMode === "ranked" && !legacyMode) {
    contextData = collectContextBlocksAndState(bodyRoot);
    const rankedCtx = rankContextBlocks(contextData.blocks, {
      textLimit,
      isIsolatedMainState: contextData.stateSignals.isIsolatedMainState,
    });
    rendered = {
      text: rankedCtx.text,
      truncated: contextData.walkTruncated || rankedCtx.truncated,
    };
  } else {
    rendered = renderedText([bodyRoot], textLimit, true);
    if (!legacyMode) {
      contextData = collectContextBlocksAndState(bodyRoot);
    }
  }
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
    ...(legacyMode
      ? {}
      : {
          text_mode: textMode,
          context_blocks: contextData?.blocks || [],
          state_signals: contextData?.stateSignals || {
            hasAlert: false,
            hasDialog: false,
            isIsolatedMainState: false,
            primaryHeading: "",
          },
        }),
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

export function filterCandidates(
  snapshot,
  { maxActions = 250, legacyMode = false } = {}
) {
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
  eligibleRows = rankCandidates(eligibleRows, roleOf, { legacyMode });
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
