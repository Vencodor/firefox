/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { readRuleFiles, readRuleIndex, validateRule } =
  ChromeUtils.importESModule("resource:///modules/fold/FoldRules.sys.mjs");
const { checkCapture } = ChromeUtils.importESModule(
  "resource:///modules/fold/FoldCapture.sys.mjs"
);

const RULES_URL = "resource:///modules/fold/rules/";

// Links put in the rebuilt documents ask the history service whether they
// were visited, and it needs a profile.
do_get_profile();

function packagedRuleIds() {
  let uri = Services.io.newURI(RULES_URL);
  let resolved = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .resolveURI(uri);
  if (!resolved.startsWith("file:")) {
    return null;
  }
  let dir = Services.io.newURI(resolved).QueryInterface(Ci.nsIFileURL).file;
  return [...dir.directoryEntries]
    .map(file => file.leafName)
    .filter(name => name.endsWith(".json") && name != "index.json")
    .map(name => name.slice(0, -".json".length));
}

function emptyDocument() {
  return new DOMParser().parseFromString(
    "<!DOCTYPE html><html><head></head><body></body></html>",
    "text/html"
  );
}

add_task(function test_listed_rules_are_valid() {
  let index = readRuleIndex();
  let rules = readRuleFiles();
  Assert.deepEqual(
    rules.map(rule => rule.id),
    index,
    "Every rule listed in rules/index.json reads and passes validation"
  );
  for (let rule of rules) {
    Assert.deepEqual(validateRule(rule), [], `${rule.id} has no problems`);
  }
});

add_task(function test_every_rule_is_listed() {
  let ids = packagedRuleIds();
  if (!ids) {
    info("The rules are packaged in a jar; skipping the listing check.");
    return;
  }
  let index = readRuleIndex();
  for (let id of ids) {
    Assert.ok(index.includes(id), `rules/${id}.json is listed in index.json`);
  }
});

add_task(function test_validation_catches_mistakes() {
  let problems = validateRule({
    id: "Bad Id",
    name: "Example",
    matches: ["not a pattern"],
    root: [],
    hide: ["nav"],
    ready: { minItems: 0 },
    remove: ["app >>> #nav"],
    current: "aria",
    customIcons: { star: '<svg onload="alert(1)"><path d="M0 0"/></svg>' },
    extras: [{ items: "input", at: "top" }],
    groups: {
      each: "details",
      items: "a",
      kinds: [{ text: "(", kind: "unknown" }],
    },
    extra: true,
  });
  for (let expected of [
    'unknown key "extra"',
    "id must be",
    "not a valid match pattern",
    "root must list",
    "remove must list selectors, each within one tree",
    'current must be "auto"',
    "customIcons.star must be an <svg>",
    'extras[0].at must be "start" or "end"',
    "ready.minItems",
    "groups.kinds[0].kind",
    "groups.kinds[0].text is not a valid regular expression",
  ]) {
    Assert.ok(
      problems.some(problem => problem.includes(expected)),
      `Reports: ${expected}`
    );
  }
});

add_task(async function test_rules_read_their_captures() {
  let rules = new Map(readRuleFiles().map(rule => [rule.id, rule]));
  let captures = [...do_get_file("captures").directoryEntries].filter(file =>
    file.leafName.endsWith(".json")
  );
  Assert.ok(captures.length, "There are captures to check");
  for (let file of captures) {
    // captures/<rule id>.json, or <rule id>-<state>.json for more than one.
    let rule =
      rules.get(file.leafName.slice(0, -5)) ??
      rules.get(file.leafName.replace(/-[^-]*\.json$/, ""));
    Assert.ok(rule, `${file.leafName} belongs to a listed rule`);
    if (!rule) {
      continue;
    }
    let { problems, warnings } = checkCapture(
      rule,
      await IOUtils.readJSON(file.path),
      emptyDocument()
    );
    for (let warning of warnings) {
      info(`${file.leafName}: ${warning}`);
    }
    Assert.deepEqual(problems, [], `${rule.id} reads ${file.leafName}`);
  }
});
