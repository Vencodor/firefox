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

add_task(
  async function test_profiles_action_context_and_selective_translation() {
    await BrowserTestUtils.withNewTab(FIXTURE, async browser => {
      await SpecialPowers.spawn(browser, [], () => {
        const doc = content.document;
        let megaMenuItems = "";
        for (let i = 0; i < 2600; i++) {
          megaMenuItems += `<li><a href="https://example.com/m/${i}">Hidden Menu ${i}</a></li>`;
        }
        doc.body.innerHTML = `
          <header role="banner">
            <nav aria-label="Top navigation">
              <div style="display: none;"><ul>${megaMenuItems}</ul></div>
              <a href="https://example.com/signup">Sign Up</a>
              <a href="https://example.com/login">Log In</a>
            </nav>
          </header>
          <main>
            <article data-post-id="t3_1">
              <shreddit-post post-title="IT department of my company banned firefox at work.">
                <a slot="full-post-link" href="https://example.com/post/1" aria-label="IT department of my company banned firefox at work."></a>
                <a slot="authorName" href="https://example.com/user/Genceryx">Author: u/Genceryx</a>
                <time datetime="2026-10-16T01:00:00Z">7 hr. ago</time>
                <a slot="flair" href="https://example.com/?f=flair_name">Flair: Discussion</a>
                <a id="post-title-t3_1" slot="title" href="https://example.com/post/1">IT department of my company banned firefox at work.</a>
                <div slot="text-body">
                  <p>Only chrome and edge is allowed for security reasons as we are told. Now I am tortured by ads without <a id="inline-link-1" href="https://example.com/ublock">uBlock</a>.</p>
                </div>
                <button id="upvote-btn" type="button" aria-label="Upvote">Upvote 542</button>
              </shreddit-post>
            </article>
            <article data-post-id="t3_2">
              <shreddit-post post-title="How do I share tabs between desktop and Android?">
                <a id="post-title-t3_2" slot="title" href="https://example.com/post/2">How do I share tabs between desktop and Android?</a>
                <a slot="authorName" href="https://example.com/user/Alice">Author: u/Alice</a>
              </shreddit-post>
            </article>
            <article data-post-id="t3_3">
              <shreddit-post post-title="Save session on exit is not restoring pinned tabs">
                <a id="post-title-t3_3" slot="title" href="https://example.com/post/3">Save session on exit is not restoring pinned tabs</a>
                <a slot="authorName" href="https://example.com/user/Bob">Author: u/Bob</a>
              </shreddit-post>
            </article>
            <article data-post-id="t3_4">
              <shreddit-post post-title="Firefox 135 WebGPU performance improvements">
                <a id="post-title-t3_4" slot="title" href="https://example.com/post/4">Firefox 135 WebGPU performance improvements</a>
                <a slot="authorName" href="https://example.com/user/Carol">Author: u/Carol</a>
              </shreddit-post>
            </article>
            <article data-post-id="t3_5">
              <shreddit-post post-title="Vertical tabs drag and drop feedback thread">
                <a id="post-title-t3_5" slot="title" href="https://example.com/post/5">Vertical tabs drag and drop feedback thread</a>
                <a slot="authorName" href="https://example.com/user/Dave">Author: u/Dave</a>
              </shreddit-post>
            </article>
          </main>
          <aside aria-label="Community sidebar">
            <h2>Community Bookmarks</h2>
            <div>커뮤니티 가이드라인</div>
          </aside>
        `;
      });

      const session = new AgentObservationSession(browser);
      try {
        const result = await session.observe({ textMode: "ranked" });
        const title5 = getElement(
          result,
          "Vertical tabs drag and drop feedback thread"
        );
        const meta1 = getElement(result, "Author: u/Genceryx");
        Assert.ok(title5 && meta1, "Both 5th card title and 1st card meta exist");
        Assert.greater(
          title5.ranking.score,
          meta1.ranking.score,
          "5th card post title ranks above 1st card author metadata link"
        );
        Assert.ok(
          result.page.text.includes(
            "IT department of my company banned firefox at work."
          ) &&
            result.page.text.includes(
              "Only chrome and edge is allowed for security reasons"
            ),
          "Ranked page.text includes core post titles and body previews"
        );
        Assert.ok(
          !result.page.text.includes("Sign Up") &&
            !result.page.text.includes("Author: u/Genceryx") &&
            !result.page.text.includes("Community Bookmarks"),
          "Ranked page.text excludes top nav, card metadata, and external sidebar"
        );

        const translationChecks = await SpecialPowers.spawn(
          browser,
          [],
          async () => {
            const { DOMHeuristics } = ChromeUtils.importESModule(
              "resource:///modules/agent/observation/DOMHeuristics.sys.mjs"
            );
            const h = new DOMHeuristics(content);
            const doc = content.document;
            return {
              title1: h.shouldTranslateNode(doc.querySelector("#post-title-t3_1")),
              title2Share: h.shouldTranslateNode(
                doc.querySelector("#post-title-t3_2")
              ),
              title3Save: h.shouldTranslateNode(
                doc.querySelector("#post-title-t3_3")
              ),
              bodyInlineLink: h.shouldTranslateNode(
                doc.querySelector("#inline-link-1")
              ),
              metaAuthor: h.shouldTranslateNode(
                doc.querySelector('[slot="authorName"]')
              ),
              upvoteBtn: h.shouldTranslateNode(doc.querySelector("#upvote-btn")),
              upvoteAria: h.shouldTranslateAttribute(
                doc.querySelector("#upvote-btn"),
                "aria-label"
              ),
            };
          }
        );
        Assert.ok(
          translationChecks.title1 &&
            translationChecks.title2Share &&
            translationChecks.title3Save &&
            translationChecks.bodyInlineLink,
          "Selective translation includes post titles and inline links inside body sentences"
        );
        Assert.ok(
          !translationChecks.metaAuthor &&
            !translationChecks.upvoteBtn &&
            !translationChecks.upvoteAria,
          "Selective translation excludes metadata, buttons, and control aria-labels"
        );
      } finally {
        session.destroy();
      }
    });
  }
);

