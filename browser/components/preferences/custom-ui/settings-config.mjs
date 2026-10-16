/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

ChromeUtils.importESModule(
  "chrome://browser/content/preferences/config/account-sync.mjs",
  { global: "current" }
);
ChromeUtils.importESModule(
  "chrome://browser/content/preferences/config/downloads.mjs",
  { global: "current" }
);

ChromeUtils.importESModule(
  "chrome://browser/content/preferences/config/tabs-browsing.mjs",
  { global: "current" }
);

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
let downloads = SettingGroupManager.get("downloads");
let tabs = SettingGroupManager.get("tabs");
let pageNavigation = SettingGroupManager.get("pageNavigation");

Preferences.addSetting({ id: "monoBrowserDescription" });
Preferences.addSetting({ id: "monoBrowserStage" });

SettingGroupManager.registerGroups({
  monoDefaultBrowser: defaultBrowser,
  monoStartup: startup,
  monoDownloadFolder: {
    ...downloads,
    items: downloads.items.filter(item => item.id === "downloadFolder"),
  },
  monoTabGroups: {
    l10nId: "custom-ui-settings-tab-groups-heading",
    headingLevel: 2,
    iconSrc: tabs.iconSrc,
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
  monoAbout: {
    items: [
      {
        id: "monoBrowserDescription",
        control: "p",
        l10nId: "custom-ui-settings-about-description",
      },
      {
        id: "monoBrowserStage",
        control: "p",
        l10nId: "custom-ui-settings-about-stage",
      },
    ],
  },
});
