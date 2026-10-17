/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Checks a Fold rule against a capture without a Firefox build, in headless
// Chromium through Playwright. The in-tree check is the xpcshell test in
// browser/components/fold/tests/unit; this is for environments that can't
// build Firefox. Gecko-only checks (match patterns) are skipped.
//
//   node mono/skills/fold-site/scripts/check.mjs <rule.json> <capture.json>
//   node mono/skills/fold-site/scripts/check.mjs --capture <page.html> <url> [rule.json]
//
// The second form runs Capture Fold on a local HTML file, as if it were
// loaded from <url>, and prints the capture. With a rule, the capture also
// has what the rule reads and the page measured with it folded.

/* global process */
/* eslint-disable no-console */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fold = path.resolve(here, "../../../../browser/components/fold");
const ORIGIN = "http://fold.test";

async function loadPlaywright() {
  for (let specifier of [
    "playwright",
    process.env.PLAYWRIGHT_MODULE,
    "/opt/node22/lib/node_modules/playwright/index.mjs",
  ]) {
    if (!specifier) {
      continue;
    }
    try {
      // eslint-disable-next-line no-unsanitized/method
      return await import(specifier);
    } catch {}
  }
  throw new Error(
    "Playwright isn't available. Set PLAYWRIGHT_MODULE to its index.mjs, or run the xpcshell test instead."
  );
}

function moduleSource(file) {
  return fs
    .readFileSync(path.join(fold, file), "utf8")
    .replaceAll("resource:///modules/fold/", `${ORIGIN}/`);
}

async function withPage(html, url, callback) {
  let { chromium } = await loadPlaywright();
  let options = process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {};
  let browser;
  try {
    browser = await chromium.launch(options);
  } catch {
    browser = await chromium.launch({
      executablePath: "/opt/pw-browsers/chromium",
    });
  }
  try {
    let page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    page.on("pageerror", error => console.error("page error:", error.message));
    await page.route(`${ORIGIN}/**`, route => {
      let file = new URL(route.request().url()).pathname.slice(1);
      if (file.endsWith(".sys.mjs")) {
        return route.fulfill({
          contentType: "text/javascript",
          body: moduleSource(file),
        });
      }
      return route.fulfill({ contentType: "text/html", body: html });
    });
    await page.goto(url ? `${ORIGIN}/page` : `${ORIGIN}/blank`);
    return await callback(page);
  } finally {
    await browser.close();
  }
}

async function check(rulePath, capturePath) {
  let result = await withPage(
    "<!DOCTYPE html><html><head></head><body></body></html>",
    null,
    page =>
      page.evaluate(
        async args => {
          // eslint-disable-next-line no-unsanitized/method
          let module = await import(`${args.base}/FoldCapture.sys.mjs`);
          let doc = document.implementation.createHTMLDocument("");
          return module.checkCapture(args.rule, args.capture, doc);
        },
        {
          base: ORIGIN,
          rule: JSON.parse(fs.readFileSync(rulePath, "utf8")),
          capture: JSON.parse(fs.readFileSync(capturePath, "utf8")),
        }
      )
  );
  for (let problem of result.problems) {
    console.log(`problem: ${problem}`);
  }
  for (let warning of result.warnings) {
    console.log(`warning: ${warning}`);
  }
  for (let section of result.model?.sections ?? []) {
    let state = section.collapsible
      ? ` (collapsible, ${section.collapsed ? "collapsed" : "open"})`
      : "";
    console.log(`\n[${section.heading ?? section.id}]${state}`);
    for (let item of section.items) {
      let marks = [
        item.kind,
        item.current && "current",
        item.badge,
        item.checked != undefined && (item.checked ? "on" : "off"),
        item.popup && "opens a menu",
        item.icon && Object.keys(item.icon)[0] + " icon",
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`  ${item.label}  (${marks})`);
      for (let action of item.actions ?? []) {
        let actionState = [
          action.pressed != undefined && (action.pressed ? "on" : "off"),
          action.popup && "opens a menu",
          action.icon && Object.keys(action.icon)[0] + " icon",
        ]
          .filter(Boolean)
          .join(", ");
        console.log(
          `    - action: ${action.label}${actionState ? `  (${actionState})` : ""}`
        );
      }
    }
  }
  console.log(result.problems.length ? "\nFAILED" : "\nOK");
  process.exitCode = result.problems.length ? 1 : 0;
}

async function capture(htmlPath, pageURL, rulePath) {
  let html = fs.readFileSync(htmlPath, "utf8");
  let rule = rulePath ? JSON.parse(fs.readFileSync(rulePath, "utf8")) : null;
  let result = await withPage(html, pageURL, page =>
    page.evaluate(
      async args => {
        // eslint-disable-next-line no-unsanitized/method
        let module = await import(`${args.base}/FoldCapture.sys.mjs`);
        // eslint-disable-next-line no-unsanitized/method
        let rules = await import(`${args.base}/FoldRules.sys.mjs`);
        // eslint-disable-next-line no-unsanitized/method
        let engine = await import(`${args.base}/FoldTranscriber.sys.mjs`);
        let compiled = args.rule && rules.compileRule(args.rule);
        let captured = module.capturePage(window, compiled);
        if (compiled) {
          let style = document.createElement("style");
          style.textContent = engine.hidingStyle(compiled);
          document.head.append(style);
          captured.rule.folded = module.measureFold(window, compiled);
          style.remove();
        }
        return { ...captured, url: args.pageURL };
      },
      { base: ORIGIN, pageURL, rule }
    )
  );
  console.log(JSON.stringify(result, null, 2));
}

let args = process.argv.slice(2);
if (args[0] == "--capture" && (args.length == 3 || args.length == 4)) {
  await capture(args[1], args[2], args[3]);
} else if (args.length == 2) {
  await check(args[0], args[1]);
} else {
  console.log(
    "usage: check.mjs <rule.json> <capture.json>\n       check.mjs --capture <page.html> <url> [rule.json]"
  );
  process.exitCode = 2;
}
