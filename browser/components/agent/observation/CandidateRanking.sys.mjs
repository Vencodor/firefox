/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const WEIGHTS = {
  base: 20,
  search: 12,
  editable: 8,
  adjustable: 6,
  button: 4,
  submit: 6,
  dialog: 12,
  menu: 8,
  navigation: 4,
  main: 2,
  complementary: -2,
  invalid: 8,
  focused: 4,
  pagination: 6,
  disclosure: 3,
  current: -4,
  readonly: -6,
  reset: -12,
  unlabeled: -4,
  clipped: -4,
  footer_link: -10,
  duplicate_target: -4,
  card_title: 4,
  card_meta: -4,
};

const CONTEXT_WEIGHTS = {
  base: 20,
  alert_assertive: 20,
  status_polite: 8,
  blocking_dialog: 16,
  footer: -18,
  search: 4,
  navigation_or_header: -14,
  main_or_central: 6,
  external_complementary: -8,
  heading_1: 16,
  heading_2_or_card_title: 10,
  heading_3_plus: 6,
  isolated_main_state: 12,
  body_or_sentence: 6,
  card_meta: -10,
  card_action_or_dense_controls: -10,
  small_iframe: -8,
};

const ADJUSTABLE = new Set([
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "spinbutton",
  "slider",
  "menuitemcheckbox",
  "menuitemradio",
]);
const TEXT_INPUT = new Set(["textbox", "searchbox", "spinbutton"]);

function baseReasons(row, role, legacyMode = false) {
  const features = row.ranking_features || {};
  const reasons = [];
  const add = code => reasons.push({ code, delta: WEIGHTS[code] });
  const editable =
    !row.readonly &&
    (TEXT_INPUT.has(role) ||
      (role === "combobox" && ["input", "textarea"].includes(row.tag)));
  add("base");
  if (
    (role === "searchbox" && editable) ||
    (features.search && (editable || role === "button"))
  ) {
    add("search");
  } else if (editable) {
    add("editable");
  } else if (ADJUSTABLE.has(role) && !row.readonly) {
    add("adjustable");
  } else if (role === "button") {
    add("button");
  }
  if (features.dialog) {
    add("dialog");
  }
  if (features.menu) {
    add("menu");
  }
  if (features.navigation && !features.footer) {
    add("navigation");
  } else if (!features.dialog && !features.menu) {
    if (features.main) {
      add("main");
    } else if (features.complementary) {
      add("complementary");
    }
  }
  if (features.submit) {
    add("submit");
  }
  if (features.invalid && !row.readonly && (editable || ADJUSTABLE.has(role))) {
    add("invalid");
  }
  if (features.focused) {
    add("focused");
  }
  if (features.pagination && role === "link") {
    add("pagination");
  }
  if (features.disclosure) {
    add("disclosure");
  }
  if (
    (role === "link" && row.current && row.current !== "false") ||
    (role === "tab" && row.selected === "true")
  ) {
    add("current");
  }
  if (row.readonly && (TEXT_INPUT.has(role) || role === "combobox")) {
    add("readonly");
  }
  if (features.reset) {
    add("reset");
  }
  if (!String(row.label || "").trim()) {
    add("unlabeled");
  }
  if (
    Number.isFinite(features.visible_fraction) &&
    features.visible_fraction < 0.5
  ) {
    add("clipped");
  }
  if (features.footer && role === "link") {
    add("footer_link");
  }
  if (!legacyMode && role === "link" && features.repetition_group) {
    if (features.card_subrole === "title") {
      add("card_title");
    } else if (features.card_subrole === "meta") {
      add("card_meta");
    }
  }
  return reasons;
}

/** Orders eligible nodes before the action budget, preserving their identities. */
export function rankCandidates(rows, roleOf, { legacyMode = false } = {}) {
  const heap = [];
  const groups = new Map();
  const seenTargets = new Set();
  const ahead = (a, b) =>
    a.score > b.score || (a.score === b.score && a.order < b.order);
  function push(entry) {
    let index = heap.length;
    heap.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!ahead(entry, heap[parent])) {
        break;
      }
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = entry;
  }
  function pop() {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && ahead(heap[child + 1], heap[child])) {
          child++;
        }
        if (!ahead(heap[child], last)) {
          break;
        }
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  }
  rows.forEach((row, order) => {
    const role = roleOf(row);
    const features = row.ranking_features || {};
    const reasons = baseReasons(row, role, legacyMode);
    const baseScore = reasons.reduce((sum, reason) => sum + reason.delta, 0);
    const frame = row.frame?.id ?? "document";
    const subrole = !legacyMode ? features.card_subrole || null : null;
    const group = features.repetition_group
      ? JSON.stringify(
          legacyMode
            ? [frame, features.repetition_group, role]
            : [frame, features.repetition_group, role, subrole || "default"]
        )
      : null;
    const item = features.repetition_item ?? row.node_id;
    const card = features.repetition_item
      ? `repeat:${features.repetition_item}`
      : ["article", "li", "listitem", "tr", "row"].includes(row.context?.kind)
        ? `context:${row.context.id}`
        : null;
    const duplicate =
      card && role === "link" && /^https?:/i.test(row.href || "")
        ? JSON.stringify([frame, card, row.href])
        : null;
    push({
      row,
      order,
      reasons,
      baseScore,
      score: baseScore,
      group,
      item,
      subrole,
      duplicate,
    });
  });

  const ranked = [];
  while (heap.length) {
    const entry = pop();
    const items = groups.get(entry.group);
    const position = entry.group
      ? (items?.get(entry.item) ?? (items?.size ?? 0) + 1)
      : 0;
    const repetition =
      !legacyMode && entry.subrole === "title"
        ? -Math.min(6, Math.max(0, position - 2) * 2)
        : -Math.min(20, Math.max(0, position - 2) * 4);
    const duplicate =
      entry.duplicate && seenTargets.has(entry.duplicate)
        ? WEIGHTS.duplicate_target
        : 0;
    const score = entry.baseScore + repetition + duplicate;
    // Penalties only grow, so stale heap priorities remain safe upper bounds.
    if (score < entry.score) {
      entry.score = score;
      push(entry);
      continue;
    }
    const reasons = [...entry.reasons];
    if (repetition) {
      reasons.push({ code: "repeated", delta: repetition });
    }
    if (duplicate) {
      reasons.push({ code: "duplicate_target", delta: duplicate });
    }
    if (entry.group) {
      if (!groups.has(entry.group)) {
        groups.set(entry.group, new Map());
      }
      groups.get(entry.group).set(entry.item, position);
    }
    if (entry.duplicate) {
      seenTargets.add(entry.duplicate);
    }
    ranked.push({
      ...entry.row,
      ranking: { score, baseScore: entry.baseScore, reasons },
    });
  }
  return ranked;
}

/**
 * Profile 2 ("context"): Scores semantic text blocks to detect page state
 * (e.g., 404 errors, alerts, modals, primary headings, and top feed summaries)
 * while suppressing navigation, footer, sidebar, and metadata noise.
 * Selects top blocks within `textLimit` and reassembles them in DOM reading order.
 */
export function rankContextBlocks(
  blocks,
  { textLimit = 6000, threshold = 18, isIsolatedMainState = false } = {}
) {
  const cardPositions = new Map();
  const scoredBlocks = blocks.map((block, index) => {
    const reasons = [{ code: "base", delta: CONTEXT_WEIGHTS.base }];
    const add = code => reasons.push({ code, delta: CONTEXT_WEIGHTS[code] });

    // 1. Status / Alert (mutually exclusive)
    if (block.alert_assertive) {
      add("alert_assertive");
    } else if (block.status_polite) {
      add("status_polite");
    }

    // 2. Landmark region (conditional mutual exclusion):
    // footer (-18) > search (+4) > nav/header (-14) > blocking_dialog (+16) > external_complementary (-8) > main/central (+6)
    const isPeripheralNoise = Boolean(
      block.footer ||
        (!block.search &&
          (block.navigation ||
            block.header_banner ||
            block.external_complementary))
    );
    const inContentRegion = Boolean(
      block.main || (block.in_central_band && !isPeripheralNoise)
    );
    if (block.footer) {
      add("footer");
    } else if (block.search) {
      add("search");
    } else if (block.navigation || block.header_banner) {
      add("navigation_or_header");
    } else if (block.blocking_dialog) {
      add("blocking_dialog");
    } else if (block.external_complementary) {
      add("external_complementary");
    } else if (inContentRegion) {
      add("main_or_central");
    }

    // 3. Heading & Title hierarchy (mutually exclusive; peripheral widgets don't get sub-heading boosts)
    const isHeadingOrTitle =
      block.heading_level > 0 || block.card_subrole === "title";
    if (block.heading_level === 1) {
      add("heading_1");
    } else if (
      !isPeripheralNoise &&
      (block.heading_level === 2 || block.card_subrole === "title")
    ) {
      add("heading_2_or_card_title");
    } else if (!isPeripheralNoise && block.heading_level >= 3) {
      add("heading_3_plus");
    }

    // 4. Content density & subrole signals
    if (
      isIsolatedMainState &&
      (inContentRegion || block.blocking_dialog) &&
      !isPeripheralNoise
    ) {
      add("isolated_main_state");
    }
    if (
      !isPeripheralNoise &&
      (block.card_subrole === "body" || block.is_sentence_like) &&
      block.card_subrole !== "meta" &&
      block.card_subrole !== "action"
    ) {
      add("body_or_sentence");
    }
    if (block.card_subrole === "meta") {
      add("card_meta");
    } else if (
      block.card_subrole === "action" ||
      (block.control_density > 0.8 && !isHeadingOrTitle)
    ) {
      add("card_action_or_dense_controls");
    }
    if (block.small_iframe) {
      add("small_iframe");
    }

    // 5. Card repetition penalty (from 3rd card in same group)
    let repetition = 0;
    if (block.repetition_group && block.repetition_item) {
      const groupKey = `${block.frame_id || "top"}:${block.repetition_group}`;
      if (!cardPositions.has(groupKey)) {
        cardPositions.set(groupKey, new Map());
      }
      const groupMap = cardPositions.get(groupKey);
      if (!groupMap.has(block.repetition_item)) {
        groupMap.set(block.repetition_item, groupMap.size + 1);
      }
      const pos = groupMap.get(block.repetition_item);
      repetition = -Math.min(20, Math.max(0, pos - 2) * 4);
      if (repetition) {
        reasons.push({ code: "repeated", delta: repetition });
      }
    }

    const score = reasons.reduce((sum, item) => sum + item.delta, 0);
    return {
      ...block,
      order: block.order ?? index,
      score,
      reasons,
    };
  });

  // Sort by score descending, tie-break by original DOM order
  const byPriority = [...scoredBlocks].sort(
    (a, b) => b.score - a.score || a.order - b.order
  );

  const chosen = [];
  let charBudgetUsed = 0;
  let truncated = false;

  for (const item of byPriority) {
    if (item.score < threshold) {
      continue;
    }
    const nextLen = item.text.length + (chosen.length ? 1 : 0);
    if (charBudgetUsed + nextLen > textLimit) {
      truncated = true;
      continue;
    }
    chosen.push(item);
    charBudgetUsed += nextLen;
  }

  // Fallback if qualifying blocks produced almost no text (< 80 chars)
  if (charBudgetUsed < 80 && byPriority.length > chosen.length) {
    for (const item of byPriority) {
      if (chosen.includes(item)) {
        continue;
      }
      const nextLen = item.text.length + (chosen.length ? 1 : 0);
      if (charBudgetUsed + nextLen > textLimit) {
        truncated = true;
        break;
      }
      chosen.push(item);
      charBudgetUsed += nextLen;
      if (charBudgetUsed >= 160) {
        break;
      }
    }
  }

  // Re-order selected blocks in natural DOM reading order
  chosen.sort((a, b) => a.order - b.order);
  const text = chosen
    .map(item => item.text)
    .join(" ")
    .slice(0, textLimit);

  return {
    text,
    truncated,
    selectedBlocks: chosen,
    allScoredBlocks: scoredBlocks,
  };
}
