/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function centerOf(element) {
  let { x, y, width, height } = element.getBoundingClientRect();
  return { x: x + width / 2, y: y + height / 2 };
}

function movePointerTo(x, y) {
  EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove" }, window);
}

add_setup(async function () {
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("custom-sidebar-navigation"),
    "The custom navigation has initialized"
  );
});

add_task(async function test_controls_reveal_from_the_window_corner() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    let controls = document.getElementById("custom-window-controls");
    let close = document.getElementById("custom-window-close");
    let { x, y } = centerOf(close);
    let page = centerOf(gBrowser.selectedBrowser);

    movePointerTo(page.x, page.y);
    ok(!controls.hasAttribute("revealed"), "The controls start hidden");
    isnot(
      document.elementFromPoint(x, y)?.closest("#custom-window-controls"),
      controls,
      "Hidden controls let the page under them take the pointer"
    );

    movePointerTo(x, y);
    ok(
      !window.CustomSidebarNavigation.windowControlsHovered,
      "Pointing at the page corner does not count as reaching the controls"
    );

    let corner = document
      .getElementById("custom-window-controls-hotspot")
      .getBoundingClientRect();
    movePointerTo(corner.right - 2, corner.top + 2);
    await TestUtils.waitForCondition(
      () => controls.hasAttribute("revealed"),
      "The window margin at the corner reveals the controls"
    );

    movePointerTo(x, y);
    let { windowControlsHideDelayMs } = window.CustomSidebarNavigation;
    // Wait past the hide delay to check the controls stay shown.
    await new Promise(resolve =>
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      setTimeout(resolve, windowControlsHideDelayMs * 2)
    );
    ok(
      controls.hasAttribute("revealed"),
      "Moving from the margin onto the controls keeps them shown"
    );
    is(
      document.elementFromPoint(x, y)?.closest("button"),
      close,
      "Shown controls take the pointer"
    );

    movePointerTo(page.x, page.y);
    await TestUtils.waitForCondition(
      () => !controls.hasAttribute("revealed"),
      "Leaving the controls hides them again"
    );
  });
});

add_task(async function test_controls_reveal_on_focus() {
  let controls = document.getElementById("custom-window-controls");
  let minimize = document.getElementById("custom-window-minimize");
  minimize.focus();
  ok(controls.hasAttribute("revealed"), "Keyboard focus reveals the controls");
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(
    () => !controls.hasAttribute("revealed"),
    "Moving focus away hides the controls"
  );
});
