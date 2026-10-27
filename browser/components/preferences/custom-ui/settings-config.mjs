/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const { getRules: getFoldRules } = ChromeUtils.importESModule(
  "resource:///modules/fold/FoldRules.sys.mjs"
);

// Mono's categories gather groups that Firefox defines in these modules.
for (let module of [
  "account-sync",
  "downloads",
  "tabs-browsing",
  "search",
  "accessibility",
]) {
  ChromeUtils.importESModule(
    `chrome://browser/content/preferences/config/${module}.mjs`,
    { global: "current" }
  );
}

const getGroup = SettingGroupManager.get.bind(SettingGroupManager);

let defaultBrowser = window.createDefaultBrowserConfig();
defaultBrowser.items = defaultBrowser.items.map(item => ({
  ...item,
  l10nId:
    item.id === "isDefaultPane"
      ? "custom-ui-settings-default-active"
      : "custom-ui-settings-default-inactive",
  control: "moz-box-item",
  controlAttrs: {},
}));
let startup = window.createStartupConfig();
startup.items = startup.items
  .filter(item => item.id === "browserRestoreSession")
  .map(item => ({ ...item, items: [] }));
let downloads = getGroup("downloads");
let tabs = getGroup("tabs");
let pageNavigation = getGroup("pageNavigation");

Preferences.addAll([
  { id: "browser.customUI.theme", type: "string" },
  { id: "browser.customUI.fold.enabled", type: "bool" },
  { id: "browser.customUI.fold.disabledSites", type: "string" },
]);
Preferences.addSetting({
  id: "mono-theme-chooser",
  pref: "browser.customUI.theme",
});

const MONO_THEMES = [
  "mono",
  "sky",
  "ocean",
  "lavender",
  "mint",
  "rose",
  "peach",
  "sand",
  "sage",
  "slate",
];

/**
 * A row that opens one of a category's sub-pages.
 *
 * @param {string} id
 * @param {string} pane The sub-page's friendly id.
 */
function addSubPageLink(id, pane) {
  Preferences.addSetting({ id, onUserClick: () => window.gotoPref(pane) });
  return { id, control: "moz-box-button", l10nId: `custom-ui-settings-${id}` };
}

Preferences.addSetting({
  id: "monoFoldEnabled",
  pref: "browser.customUI.fold.enabled",
});

function foldSiteItem(rule) {
  let id = `monoFoldSite-${rule.id}`;
  let parseDisabled = value => {
    try {
      let ids = JSON.parse(value);
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  };
  Preferences.addSetting({
    id,
    pref: "browser.customUI.fold.disabledSites",
    deps: ["monoFoldEnabled"],
    disabled: deps => !deps.monoFoldEnabled.value,
    get: value => !parseDisabled(value).includes(rule.id),
    set: (enabled, deps, setting) => {
      let ids = parseDisabled(setting.pref.value).filter(
        other => other != rule.id
      );
      if (!enabled) {
        ids.push(rule.id);
      }
      return JSON.stringify(ids);
    },
  });
  let host = (rule.matches?.[0] ?? "")
    .replace(/^\*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  Preferences.addSetting({ id: `${id}-row` });
  return {
    id: `${id}-row`,
    control: "moz-box-item",
    l10nId: "custom-ui-settings-fold-site",
    l10nArgs: { name: rule.name ?? rule.id, host },
    items: [
      {
        id,
        control: "moz-toggle",
        slot: "actions",
        l10nId: "custom-ui-settings-fold-site-toggle",
        l10nArgs: { name: rule.name ?? rule.id },
      },
    ],
  };
}

Preferences.addSetting({ id: "monoFoldSites" });
Preferences.addSetting({ id: "monoConnectServices" });
Preferences.addSetting({ id: "monoConnectGoogleCalendar" });
// Connecting is not built yet; the button is where it will start.
Preferences.addSetting({
  id: "monoConnectGoogleCalendarButton",
  onUserClick: () => {},
});
Preferences.addSetting({ id: "monoGeneralLinkList" });
Preferences.addSetting({ id: "monoPrivacyLinkList" });

SettingGroupManager.registerGroups({
  monoTheme: {
    l10nId: "custom-ui-settings-theme-group",
    headingLevel: 2,
    items: [
      {
        id: "mono-theme-chooser",
        control: "moz-visual-picker",
        options: MONO_THEMES.map(theme => ({
          value: theme,
          l10nId: `custom-ui-settings-theme-${theme}`,
          controlAttrs: {
            id: `mono-theme-${theme}`,
            class: "mono-theme-item",
            imagesrc: `chrome://browser/content/preferences/custom-ui/theme-${theme}.svg`,
          },
        })),
      },
    ],
  },
  monoDefaultBrowser: defaultBrowser,
  monoStartup: startup,
  monoDownloadFolder: {
    ...downloads,
    items: downloads.items.filter(item => item.id === "downloadFolder"),
  },
  monoGeneralLinks: {
    items: [
      {
        id: "monoGeneralLinkList",
        control: "moz-box-group",
        controlAttrs: { type: "list" },
        items: [addSubPageLink("languages-link", "languages")],
      },
    ],
  },
  monoTabGroups: {
    l10nId: "custom-ui-settings-tab-groups-heading",
    headingLevel: 2,
    items: tabs.items
      .find(item => item.id === "tabsInteraction")
      .items.filter(item =>
        ["tabGroupSuggestions", "tabGroupDragToCreate"].includes(item.id)
      ),
  },
  monoContainers: {
    l10nId: "tabs-containers-heading",
    headingLevel: 2,
    items: tabs.items.find(item => item.id === "browserContainersbox").items,
  },
  monoPageNavigation: {
    ...pageNavigation,
    items: pageNavigation.items.filter(item =>
      ["useCursorNavigation", "searchStartTyping"].includes(item.id)
    ),
  },
  monoFold: {
    l10nId: "custom-ui-settings-fold-group",
    headingLevel: 2,
    items: [
      {
        id: "monoFoldEnabled",
        control: "moz-toggle",
        l10nId: "custom-ui-settings-fold-enabled",
      },
      {
        id: "monoFoldSites",
        control: "moz-box-group",
        controlAttrs: { type: "list" },
        items: getFoldRules().map(foldSiteItem),
      },
    ],
  },
  monoConnect: {
    l10nId: "custom-ui-settings-connect-group",
    headingLevel: 2,
    items: [
      {
        id: "monoConnectServices",
        control: "moz-box-group",
        controlAttrs: { type: "list" },
        items: [
          {
            id: "monoConnectGoogleCalendar",
            control: "moz-box-item",
            l10nId: "custom-ui-settings-connect-google-calendar",
            iconSrc:
              "chrome://browser/content/custom-ui/resources/archive/calendar.svg",
            items: [
              {
                id: "monoConnectGoogleCalendarButton",
                control: "moz-button",
                slot: "actions",
                l10nId: "custom-ui-settings-connect-button",
              },
            ],
          },
        ],
      },
    ],
  },
  monoPrivacyLinks: {
    l10nId: "custom-ui-settings-privacy-more",
    headingLevel: 2,
    items: [
      {
        id: "monoPrivacyLinkList",
        control: "moz-box-group",
        controlAttrs: { type: "list" },
        items: [
          addSubPageLink("passwords-link", "passwordsAutofill"),
          addSubPageLink("permissions-link", "permissionsData"),
          addSubPageLink("ai-link", "ai"),
        ],
      },
    ],
  },
});

/**
 * Mono draws Firefox's setting groups its own way: no card around a group,
 * switches instead of checkboxes, and no heading icons or links to Firefox
 * support pages.
 */
const monoGroups = new WeakMap();

function isSupportLink(item) {
  return item.control == "a" && item.controlAttrs?.is == "moz-support-link";
}

function monoItem(item) {
  let copy = { ...item };
  delete copy.supportPage;
  if (!copy.control || copy.control == "moz-checkbox") {
    copy.control = "moz-toggle";
  }
  // The label starts the row and the switch ends it.
  if (copy.control == "moz-toggle" && !copy.controlAttrs?.inputlayout) {
    copy.controlAttrs = { ...copy.controlAttrs, inputlayout: "inline-end" };
  }
  if (copy.items) {
    copy.items = copy.items
      .filter(child => !isSupportLink(child))
      .map(monoItem);
  }
  if (copy.options) {
    copy.options = copy.options
      .filter(option => !isSupportLink(option))
      .map(option =>
        option.items ? { ...option, items: option.items.map(monoItem) } : option
      );
  }
  return copy;
}

SettingGroupManager.get = id => {
  let config = getGroup(id);
  if (!monoGroups.has(config)) {
    let group = {
      ...config,
      card: "never",
      items: config.items?.map(monoItem),
    };
    delete group.iconSrc;
    delete group.supportPage;
    monoGroups.set(config, group);
  }
  return monoGroups.get(config);
};
