/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AgentObservationSession } = ChromeUtils.importESModule(
  "resource:///modules/agent/AgentObservation.sys.mjs"
);

const FIXTURE_ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const FIXTURE = FIXTURE_ROOT + "observation.html";
const CROSS_ORIGIN_FRAME =
  FIXTURE_ROOT.replace("example.com", "example.org") + "frame.html";

function getElement(result, name) {
  return result.elements.find(element => element.name === name);
}

async function waitForVisibleFrame(browser) {
  await SpecialPowers.spawn(browser, [CROSS_ORIGIN_FRAME], url => {
    const frame = content.document.querySelector("#visible-frame");
    if (frame.getAttribute("src") !== url) {
      frame.dataset.loaded = "false";
      frame.src = url;
    }
  });
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(browser, [], () => {
        return (
          content.document.querySelector("#visible-frame")?.dataset.loaded ===
          "true"
        );
      }),
    "The visible cross-origin frame finishes loading before observation"
  );
}

add_task(async function test_observation_exposes_safe_controls_and_context() {
  await BrowserTestUtils.withNewTab(FIXTURE, async browser => {
    await waitForVisibleFrame(browser);
    const session = new AgentObservationSession(browser);
    try {
      const result = await session.observe();
      const openButtons = result.elements.filter(
        element => element.name === "Open"
      );
      Assert.equal(
        openButtons.length,
        2,
        "Both same-named card buttons are observed"
      );
      Assert.ok(
        openButtons.some(element => element.context?.heading === "Alpha"),
        "The first Open button has its card context"
      );
      Assert.ok(
        openButtons.some(element => element.context?.heading === "Beta"),
        "The second Open button has its card context"
      );
      Assert.ok(
        !getElement(result, "Disabled"),
        "Disabled controls are excluded"
      );
      Assert.ok(!getElement(result, "secret"), "Password values are excluded");
      const terms = result.elements.find(
        element => element.name === "Accept terms"
      );
      Assert.equal(
        terms?.interaction_via,
        "label",
        "The visible label is the checkbox target"
      );
      Assert.ok(
        getElement(result, "Shadow action"),
        "Open shadow-root controls are observed"
      );
      Assert.ok(
        !getElement(result, "Hidden frame action"),
        "Controls from a hidden frame are not observed"
      );
      Assert.ok(
        getElement(result, "Cross-origin frame action"),
        "Controls in the visible cross-origin frame are observed"
      );
      Assert.greaterOrEqual(
        result.coverage.framesCollected,
        2,
        "The visible cross-origin frame is observed in its own browsing context"
      );
    } finally {
      session.destroy();
    }
  });
});

add_task(async function test_highlight_preserves_page_dom_and_clicks() {
  await BrowserTestUtils.withNewTab(FIXTURE, async browser => {
    await waitForVisibleFrame(browser);
    const session = new AgentObservationSession(browser);
    try {
      const result = await session.observe();
      const target = getElement(result, "Click through highlight");
      Assert.ok(target, "The page click target was observed");

      const before = await SpecialPowers.spawn(browser, [], () => {
        const targetNode = content.document.querySelector("#page-click-target");
        const rect = targetNode.getBoundingClientRect();
        return {
          html: content.document.documentElement.innerHTML,
          hit: content.document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          )?.id,
        };
      });
      Assert.ok(
        await session.highlight(target.handle),
        "The observed target can be highlighted"
      );

      const after = await SpecialPowers.spawn(browser, [], () => {
        const targetNode = content.document.querySelector("#page-click-target");
        const rect = targetNode.getBoundingClientRect();
        return {
          html: content.document.documentElement.innerHTML,
          hit: content.document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          )?.id,
        };
      });
      Assert.equal(
        after.html,
        before.html,
        "Highlight does not mutate page DOM"
      );
      Assert.equal(
        after.hit,
        before.hit,
        "Hit testing still resolves to the page target"
      );

      const clicked = BrowserTestUtils.waitForContentEvent(
        browser,
        "click",
        false,
        event => event.target?.id === "page-click-target"
      );
      await BrowserTestUtils.synthesizeMouseAtCenter(
        "#page-click-target",
        {},
        browser
      );
      await clicked;
      const count = await SpecialPowers.spawn(
        browser,
        [],
        () =>
          content.document.querySelector("#page-click-target").dataset
            .clickCount
      );
      Assert.equal(count, 1, "The page receives a click after highlighting");
    } finally {
      session.destroy();
    }
  });
});

add_task(async function test_observation_sessions_are_tab_scoped() {
  await BrowserTestUtils.withNewTab(FIXTURE, async firstBrowser => {
    await waitForVisibleFrame(firstBrowser);
    const firstSession = new AgentObservationSession(firstBrowser);
    try {
      const firstResult = await firstSession.observe();
      const firstTarget = getElement(firstResult, "Click through highlight");
      await BrowserTestUtils.withNewTab(FIXTURE, async secondBrowser => {
        await waitForVisibleFrame(secondBrowser);
        const secondSession = new AgentObservationSession(secondBrowser);
        try {
          const secondResult = await secondSession.observe();
          const secondTarget = getElement(
            secondResult,
            "Click through highlight"
          );
          Assert.ok(
            await secondSession.highlight(secondTarget.handle),
            "A session can highlight its own tab's target"
          );
          Assert.ok(
            !(await secondSession.highlight(firstTarget.handle)),
            "A session rejects another tab's handle"
          );
          Assert.ok(
            await firstSession.highlight(firstTarget.handle),
            "The first session remains usable after observing the second tab"
          );
        } finally {
          secondSession.destroy();
        }
      });
    } finally {
      firstSession.destroy();
    }
  });
});

add_task(async function test_observation_invalidation_rejects_stale_handles() {
  await BrowserTestUtils.withNewTab(FIXTURE, async browser => {
    await waitForVisibleFrame(browser);
    const invalidations = [];
    const session = new AgentObservationSession(browser, {
      onInvalidated: reason => invalidations.push(reason),
    });
    try {
      const result = await session.observe();
      const staleHandle = getElement(result, "Remove me").handle;
      await SpecialPowers.spawn(browser, [], () => {
        content.document.querySelector("#remove-target").remove();
      });
      await TestUtils.waitForCondition(
        () => Boolean(invalidations.length),
        "The session reports invalidation after target removal"
      );
      Assert.ok(
        !(await session.highlight(staleHandle)),
        "A removed target handle is rejected"
      );
    } finally {
      session.destroy();
    }
  });
});

add_task(async function test_observation_reports_action_cap() {
  await BrowserTestUtils.withNewTab(
    FIXTURE.replace("observation.html", "cap.html"),
    async browser => {
      const session = new AgentObservationSession(browser);
      try {
        const result = await session.observe();
        Assert.lessOrEqual(
          result.elements.length,
          250,
          "The observation respects the action cap"
        );
        Assert.greater(
          result.coverage.actionsOmitted,
          0,
          "The omitted action count is reported"
        );
      } finally {
        session.destroy();
      }
    }
  );
});

add_task(async function test_scroll_input_and_navigation_invalidate_handles() {
  await BrowserTestUtils.withNewTab(FIXTURE, async browser => {
    async function checkInvalidation(action, description) {
      if (browser.currentURI.spec === FIXTURE) {
        await waitForVisibleFrame(browser);
      }
      const invalidations = [];
      const session = new AgentObservationSession(browser, {
        onInvalidated: reason => invalidations.push(reason),
      });
      try {
        const result = await session.observe();
        const staleHandle = getElement(result, "Input target").handle;
        await action();
        await TestUtils.waitForCondition(
          () => Boolean(invalidations.length),
          `The session reports invalidation after ${description}`
        );
        Assert.ok(
          !(await session.highlight(staleHandle)),
          `A handle is rejected after ${description}`
        );
      } finally {
        session.destroy();
      }
      if (description === "scrolling") {
        await SpecialPowers.spawn(browser, [], () => content.scrollTo(0, 0));
      }
    }

    await checkInvalidation(
      () =>
        SpecialPowers.spawn(browser, [], () => {
          content.scrollTo(0, content.document.body.scrollHeight);
        }),
      "scrolling"
    );
    await checkInvalidation(
      () =>
        SpecialPowers.spawn(browser, [], () => {
          const input = content.document.querySelector("#input-target");
          input.value = "changed";
          input.dispatchEvent(new content.Event("input", { bubbles: true }));
        }),
      "input"
    );
    await checkInvalidation(async () => {
      const loaded = BrowserTestUtils.browserLoaded(
        browser,
        false,
        "about:blank"
      );
      BrowserTestUtils.startLoadingURIString(browser, "about:blank");
      await loaded;
    }, "navigation");
  });
});
