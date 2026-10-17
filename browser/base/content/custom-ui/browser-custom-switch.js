/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Icon tabs on a track with a selection surface that slides under the
 * selected tab, shared by the archive's views and the sidebar's site switch.
 *
 * A horizontal scroll over the switch's areas grows the surface into glass
 * and steps it one tab for every `swipeStep` pixels in the direction the
 * fingers move, so one gesture can move across several tabs. The tab under it
 * is chosen once the gesture ends. Arrow keys, Home and End move between tabs.
 *
 * The owner shows a choice by calling select(); onSelect only asks for it.
 */
class CustomSwitch {
  swipeStep = 36;
  swipeNudge = 6;
  swipeEndDelay = 120;
  swipeReleaseRatio = 0.35;
  swipeReleasePeak = 8;
  inertiaGap = 120;

  /**
   * @param {object} options
   * @param {Element} options.tablist The track, holding a
   *   .custom-switch-indicator and the [role="tab"] buttons.
   * @param {Function} options.onSelect Called with the index of a tab the
   *   user chose.
   * @param {Element[]} [options.areas] Elements whose horizontal scroll
   *   moves the switch; the track itself by default.
   */
  constructor({ tablist, onSelect, areas = [tablist] }) {
    this.tablist = tablist;
    this.indicator = tablist.querySelector(".custom-switch-indicator");
    this.tabs = [...tablist.querySelectorAll('[role="tab"]')];
    this.onSelect = onSelect;
    this.index = Math.max(
      0,
      this.tabs.findIndex(tab => tab.getAttribute("aria-selected") == "true")
    );
    this.swipe = null;
    this.inertia = null;
    this.swipeTimer = 0;
    tablist.addEventListener("click", this);
    tablist.addEventListener("keydown", this);
    for (let area of areas) {
      this.addArea(area);
    }
    this.resizeObserver = new ResizeObserver(() => this.updateIndicator());
    this.resizeObserver.observe(tablist);
  }

  /**
   * Lets a horizontal scroll over an element move the switch. The listener
   * makes scrolling there wait for the window's script, so it's best only
   * added while the switch is in use.
   *
   * @param {Element} area
   */
  addArea(area) {
    area.addEventListener("wheel", this, { passive: false });
  }

  removeArea(area) {
    area.removeEventListener("wheel", this);
  }

  handleEvent(event) {
    switch (event.type) {
      case "click": {
        let tab = event.target.closest('[role="tab"]');
        if (tab) {
          this.choose(this.tabs.indexOf(tab));
        }
        break;
      }
      case "keydown":
        this.onKeyDown(event);
        break;
      case "wheel":
        this.onWheel(event);
        break;
    }
  }

  choose(index) {
    if (index < 0 || index == this.index) {
      this.updateIndicator(true);
      return;
    }
    this.onSelect(index);
  }

  /**
   * Shows a tab as selected.
   *
   * @param {number} index
   * @param {object} [options]
   * @param {boolean} [options.animate] Whether the surface slides there.
   */
  select(index, { animate = true } = {}) {
    this.index = index;
    this.tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i == index));
      tab.tabIndex = i == index ? 0 : -1;
    });
    this.updateIndicator(animate);
  }

  isRTL() {
    return window.getComputedStyle(this.tablist).direction == "rtl";
  }

  onKeyDown(event) {
    let rtl = this.isRTL();
    let last = this.tabs.length - 1;
    let next;
    switch (event.key) {
      case "ArrowDown":
      case rtl ? "ArrowLeft" : "ArrowRight":
        next = this.index == last ? 0 : this.index + 1;
        break;
      case "ArrowUp":
      case rtl ? "ArrowRight" : "ArrowLeft":
        next = this.index == 0 ? last : this.index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.choose(next);
    this.tabs[next].focus();
  }

  onWheel(event) {
    if (
      this.tablist.hidden ||
      Math.abs(event.deltaX) <= Math.abs(event.deltaY)
    ) {
      return;
    }
    event.preventDefault();
    let rtl = this.isRTL();
    let raw =
      event.deltaMode == WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaX
        : event.deltaX * this.swipeStep;
    let speed = Math.abs(raw);
    let now = event.timeStamp;
    // The touchpad keeps sending decaying scroll events after the fingers
    // lift. They are ignored until they stop or speed up again, which means
    // a new gesture.
    let inertia = this.inertia;
    if (inertia) {
      if (now - inertia.time < this.inertiaGap && speed <= inertia.speed + 1) {
        inertia.time = now;
        inertia.speed = speed;
        return;
      }
      this.inertia = null;
    }
    if (!this.swipe) {
      this.swipe = { index: this.index, delta: 0, peak: 0 };
      this.tablist.toggleAttribute("swiping", true);
    }
    let swipe = this.swipe;
    // A sharp drop from the gesture's peak speed is taken as the fingers
    // lifting, so the tab switches at once instead of after the inertia.
    swipe.peak = Math.max(swipe.peak, speed);
    if (
      swipe.peak >= this.swipeReleasePeak &&
      speed < swipe.peak * this.swipeReleaseRatio
    ) {
      this.inertia = { time: now, speed };
      this.endSwipe();
      return;
    }
    let delta = raw * (rtl ? 1 : -1);
    let last = this.tabs.length - 1;
    swipe.delta += delta;
    while (swipe.delta >= this.swipeStep && swipe.index < last) {
      swipe.index++;
      swipe.delta -= this.swipeStep;
    }
    while (swipe.delta <= -this.swipeStep && swipe.index > 0) {
      swipe.index--;
      swipe.delta += this.swipeStep;
    }
    swipe.delta = Math.max(
      -this.swipeStep,
      Math.min(this.swipeStep, swipe.delta)
    );
    this.tabs.forEach((tab, i) =>
      tab.toggleAttribute("candidate", i == swipe.index)
    );
    this.updateIndicator(
      true,
      swipe.index,
      (swipe.delta / this.swipeStep) * this.swipeNudge * (rtl ? -1 : 1)
    );
    clearTimeout(this.swipeTimer);
    this.swipeTimer = setTimeout(() => this.endSwipe(), this.swipeEndDelay);
  }

  endSwipe() {
    clearTimeout(this.swipeTimer);
    let index = this.swipe.index;
    this.swipe = null;
    this.tablist.removeAttribute("swiping");
    for (let tab of this.tabs) {
      tab.removeAttribute("candidate");
    }
    this.choose(index);
  }

  /**
   * Moves the selection surface under a tab. It follows the tab's box, so it
   * also works when the collapsed sidebar stacks the tabs.
   *
   * @param {boolean} [animate]
   * @param {number} [index]
   * @param {number} [nudge] Extra inline offset while swiping, in pixels.
   */
  updateIndicator(animate = false, index = this.index, nudge = 0) {
    let tab = this.tabs[index];
    let style = this.indicator.style;
    this.indicator.toggleAttribute("instant", !animate);
    style.width = `${tab.offsetWidth}px`;
    style.height = `${tab.offsetHeight}px`;
    style.translate = `${tab.offsetLeft + nudge}px ${tab.offsetTop}px`;
    if (!animate) {
      // Flush the position before transitions are allowed again.
      this.indicator.getBoundingClientRect();
      this.indicator.removeAttribute("instant");
    }
  }
}
