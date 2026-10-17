/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reddit's left navigation. Its top links are found by address, the
 * collapsible groups (Recent, Communities, Resources, ...) by their
 * details/summary structure, so the rule doesn't depend on class names.
 */
export default {
  id: "reddit",
  name: "Reddit",
  matches: ["*://www.reddit.com/*"],
  root: [
    "#left-sidebar",
    "reddit-sidebar-nav",
    "#left-sidebar-container",
    "flex-left-nav-container",
  ],
  hide: [
    "#left-sidebar-container",
    "flex-left-nav-container",
    "#navbar-menu-button",
  ],
  // The page grid keeps a column for the navigation; let the content take it.
  css: `
    .grid-container:has(> #left-sidebar-container) {
      grid-template-columns: minmax(0, 1fr) !important;
    }
    .grid-container:has(> #left-sidebar-container) > :not(#left-sidebar-container) {
      grid-column: 1 / -1 !important;
    }
  `,
  ready: { minItems: 3, timeoutMs: 4000 },
  current: "url",
  currentIgnoresSearch: true,
  main: [
    { paths: ["/", "/?feed=home"], icon: "home" },
    { paths: ["/r/popular/"], icon: "trending" },
    { paths: ["/answers/"], icon: "answers" },
    { paths: ["/news/"], icon: "news" },
    { paths: ["/explore/"], icon: "explore" },
    { paths: ["/r/all/"], icon: "all" },
  ],
  groups: {
    each: "details",
    heading: "summary",
    items: "a[href], button",
    container: "left-nav-community-item, left-nav-link, li",
    secondary: {
      selector:
        "button[aria-label*='favorite' i], button[aria-label*='favourite' i]",
      pressed: "[aria-pressed='true'], [icon-name$='-fill']",
    },
    kinds: [
      { text: /^(create|manage)\b/i, kind: "action" },
      { href: /^\/(r|user)\/[^/]+\/?$/, kind: "entity" },
      { tag: "button", kind: "action" },
      { external: true, kind: "link" },
    ],
    icons: [
      { text: /^create\b/i, icon: "add" },
      { text: /^manage\b/i, icon: "settings" },
      { text: /^see (more|less)\b/i, icon: "more" },
    ],
    sections: [{ heading: /^resources$/i, kind: "link" }],
  },
};
