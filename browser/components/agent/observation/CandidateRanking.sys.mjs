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

function baseReasons(row, role) {
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
  return reasons;
}

/** Orders eligible nodes before the action budget, preserving their identities. */
export function rankCandidates(rows, roleOf) {
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
    const reasons = baseReasons(row, role);
    const baseScore = reasons.reduce((sum, reason) => sum + reason.delta, 0);
    const frame = row.frame?.id ?? "document";
    const group = features.repetition_group
      ? JSON.stringify([frame, features.repetition_group, role])
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
    const repetition = -Math.min(20, Math.max(0, position - 2) * 4);
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
