/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Splits a query into lowercase terms of two or more letters or digits.
 *
 * @param {string} query
 * @returns {Array<string>}
 */
export function queryTerms(query) {
  return Array.from(
    new Set(
      String(query || "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(t => t.length >= 2)
    )
  );
}

function countTermHits(line, terms) {
  const lower = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score++;
    }
  }
  return score;
}

/**
 * Trims text to `limit` characters, keeping the lead of the document and then
 * the lines that mention the most query terms, in their original order.
 *
 * @param {string} text
 * @param {string} query
 * @param {number} limit
 * @returns {string}
 */
export function selectRelevantText(text, query, limit) {
  if (text.length <= limit) {
    return text;
  }
  const terms = queryTerms(query);
  if (!terms.length) {
    return text.slice(0, limit);
  }
  const lines = text.split("\n");
  const leadBudget = Math.floor(limit * 0.35);
  const picked = new Set();
  let used = 0;
  let i = 0;
  for (; i < lines.length && used + lines[i].length + 1 <= leadBudget; i++) {
    picked.add(i);
    used += lines[i].length + 1;
  }
  const scored = [];
  for (let j = i; j < lines.length; j++) {
    const score = countTermHits(lines[j], terms);
    if (score) {
      scored.push({ j, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.j - b.j);
  for (const { j } of scored) {
    if (used + lines[j].length + 1 > limit) {
      continue;
    }
    picked.add(j);
    used += lines[j].length + 1;
  }
  for (let j = i; j < lines.length && used < limit; j++) {
    if (!picked.has(j) && used + lines[j].length + 1 <= limit) {
      picked.add(j);
      used += lines[j].length + 1;
    }
  }
  return Array.from(picked)
    .sort((a, b) => a - b)
    .map(j => lines[j])
    .join("\n");
}

/**
 * Shrinks the combined text of several pages to `budget` characters. Every
 * page keeps a short lead, then the remaining budget goes to the lines that
 * mention the most query terms across all pages, earlier pages winning ties.
 * Each page keeps its lines in their original order. Mutates `page.text`.
 *
 * @param {Array<{text: string}>} pages
 * @param {string} query
 * @param {number} budget
 * @returns {{before: number, after: number}}
 */
export function fitPagesToBudget(pages, query, budget) {
  const usable = pages.filter(page => page?.text);
  const before = usable.reduce((sum, page) => sum + page.text.length, 0);
  if (before <= budget || !usable.length) {
    return { before, after: before };
  }
  const terms = queryTerms(query);
  const leadBudget = Math.floor((budget * 0.4) / usable.length);
  const perPage = usable.map(page => ({
    page,
    lines: page.text.split("\n"),
    picked: new Set(),
  }));
  let used = 0;
  const candidates = [];
  perPage.forEach((entry, pageIndex) => {
    let lead = 0;
    entry.lines.forEach((line, lineIndex) => {
      const cost = line.length + 1;
      // Lead lines are the contiguous start of the page.
      if (lineIndex === entry.picked.size && lead + cost <= leadBudget) {
        entry.picked.add(lineIndex);
        lead += cost;
        return;
      }
      candidates.push({
        entry,
        lineIndex,
        pageIndex,
        cost,
        score: countTermHits(line, terms),
      });
    });
    used += lead;
  });
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.pageIndex - b.pageIndex ||
      a.lineIndex - b.lineIndex
  );
  for (const candidate of candidates) {
    if (used + candidate.cost > budget) {
      continue;
    }
    candidate.entry.picked.add(candidate.lineIndex);
    used += candidate.cost;
  }
  let after = 0;
  for (const { page, lines, picked } of perPage) {
    page.text = Array.from(picked)
      .sort((a, b) => a - b)
      .map(index => lines[index])
      .join("\n");
    after += page.text.length;
  }
  return { before, after };
}
