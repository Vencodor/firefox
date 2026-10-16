/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { rankContextBlocks } from "resource:///modules/agent/observation/CandidateRanking.sys.mjs";
import { filterCandidates } from "resource:///modules/agent/observation/DOMObservation.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

let registered = false;
const sessions = new WeakMap();

function registerActor() {
  if (registered) {
    return;
  }
  ChromeUtils.registerWindowActor("AgentObservation", {
    parent: {
      esModuleURI: "resource:///actors/AgentObservationParent.sys.mjs",
    },
    child: { esModuleURI: "resource:///actors/AgentObservationChild.sys.mjs" },
    allFrames: true,
    includeChrome: false,
    safeForUntrustedWebProcess: true,
  });
  registered = true;
}

async function query(actor, name, data, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([
      actor.sendQuery(name, data),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Observation timed out")),
          timeout
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns a tab's observation and its document-scoped target handles. */
export class AgentObservationSession {
  constructor(browser, { onInvalidated = () => {} } = {}) {
    registerActor();
    sessions.get(browser)?.destroy();
    sessions.set(browser, this);
    this.browser = browser;
    this.onInvalidated = onInvalidated;
    this.frames = [];
    this.generation = 0;
    this.destroyed = false;
    this.observer = (subject, topic, data) => {
      if (subject === this.browser) {
        const notice = JSON.parse(data);
        if (notice.id === this.id) {
          this.invalidate(notice.reason);
        }
      }
    };
    Services.obs.addObserver(this.observer, "agent-observation-invalidated");
    this.progressListener = {
      onLocationChange: (changedBrowser, webProgress) => {
        if (changedBrowser === browser && webProgress.isTopLevel && this.id) {
          this.invalidate("navigation");
        }
      },
    };
    this.tabbrowser = browser.documentGlobal.gBrowser;
    this.tabbrowser.addTabsProgressListener(this.progressListener);
  }

  async observe(options = {}) {
    if (this.destroyed) {
      throw new Error("Observation session is closed");
    }
    const clearing = this.clear();
    const generation = this.generation;
    await clearing;
    if (this.destroyed || generation !== this.generation) {
      throw new Error("Observation session was cleared");
    }
    if (!["http", "https", "file"].includes(this.browser.currentURI.scheme)) {
      throw new Error("Unsupported page");
    }
    const started = Date.now();
    const captureDeadline = started + 5000;
    const id = Services.uuid.generateUUID().toString();
    this.id = id;
    const top = this.browser.browsingContext;
    const topDocument = top.currentWindowGlobal;
    const collected = [];
    const audit = [];
    const config = {
      textLimit: 6000,
      contextLimit: 320,
      textMode: "ranked",
      ...options,
    };
    const visit = async (context, depth, clip, smallIframe = false) => {
      if (generation !== this.generation) {
        throw new Error("Observation changed while collecting");
      }
      const global = context.currentWindowGlobal;
      if (!global) {
        throw new Error("Frame is unavailable");
      }
      const actor = global.getActor("AgentObservation");
      const record = {
        actor,
        context,
        documentId: global.innerWindowId,
        id,
        items: [],
      };
      this.frames.push(record);
      let snapshot;
      try {
        snapshot = await query(
          actor,
          "AgentObservation:Capture",
          {
            id,
            options: { ...config, clip, smallIframe },
          },
          Math.max(1, captureDeadline - Date.now())
        );
      } catch (error) {
        this.frames = this.frames.filter(frame => frame !== record);
        actor.sendAsyncMessage("AgentObservation:Clear", { id });
        throw error;
      }
      if (
        generation !== this.generation ||
        context.currentWindowGlobal !== global
      ) {
        actor.sendAsyncMessage("AgentObservation:Clear", { id });
        throw new Error("Observation changed while collecting");
      }
      collected.push({ snapshot, record });
      for (const frame of snapshot.frames) {
        const entry = { frameId: frame.browsingContextId, status: "skipped" };
        audit.push(entry);
        if (Date.now() >= captureDeadline) {
          entry.reason = "deadline";
          continue;
        }
        const child =
          frame.browsingContextId &&
          BrowsingContext.get(frame.browsingContextId);
        if (
          !child ||
          child.parent !== context ||
          depth >= 3 ||
          this.frames.length >= 16
        ) {
          entry.reason = !child ? "unavailable" : "budget";
          continue;
        }
        try {
          const childClip = {
            left: frame.clip.left - frame.offset_x,
            right: frame.clip.right - frame.offset_x,
            top: frame.clip.top - frame.offset_y,
            bottom: frame.clip.bottom - frame.offset_y,
          };
          const topViewport = collected[0]?.snapshot?.viewport;
          const topArea = topViewport
            ? Math.max(0, topViewport.width) * Math.max(0, topViewport.height)
            : 0;
          const frameArea =
            Math.max(0, frame.rect.width) * Math.max(0, frame.rect.height);
          const childSmallIframe = topArea > 0 && frameArea / topArea < 0.15;
          await visit(
            child,
            depth + 1,
            childClip,
            smallIframe || childSmallIframe
          );
          entry.status = "collected";
        } catch (error) {
          if (generation !== this.generation) {
            throw error;
          }
          entry.reason = "collection-failed";
        }
      }
    };
    try {
      await visit(top, 0);
      if (
        generation !== this.generation ||
        top.currentWindowGlobal !== topDocument
      ) {
        throw new Error("Observation changed while collecting");
      }
      const rows = [];
      const handles = new Map();
      const contextBlocks = [];
      let nextBlockOrder = 0;
      let text = "";
      let textTruncated = false;
      const stateSignals = {
        hasAlert: false,
        hasDialog: false,
        isIsolatedMainState: Boolean(
          collected[0]?.snapshot?.state_signals?.isIsolatedMainState
        ),
        primaryHeading: "",
      };
      for (const { snapshot, record } of collected) {
        text += (text ? "\n" : "") + snapshot.text;
        textTruncated ||= snapshot.text_truncated;
        if (snapshot.state_signals) {
          stateSignals.hasAlert ||= Boolean(snapshot.state_signals.hasAlert);
          stateSignals.hasDialog ||= Boolean(snapshot.state_signals.hasDialog);
          if (!stateSignals.primaryHeading && snapshot.state_signals.primaryHeading) {
            stateSignals.primaryHeading = snapshot.state_signals.primaryHeading;
          }
        }
        for (const block of snapshot.context_blocks || []) {
          contextBlocks.push({
            ...block,
            frame_id: record.context.id,
            order: nextBlockOrder++,
          });
        }
        for (const row of snapshot.candidates) {
          const nodeId = `${record.context.id}:${row.node_id}`;
          handles.set(nodeId, {
            observationId: id,
            frameId: record.context.id,
            documentId: record.documentId,
            nodeId: row.node_id,
          });
          rows.push({
            ...row,
            node_id: nodeId,
            ...(row.context
              ? {
                  context: {
                    ...row.context,
                    id: `${record.context.id}:${row.context.id}`,
                  },
                }
              : {}),
            frame: {
              id: record.context.id,
              url: snapshot.url,
              title: snapshot.title,
            },
          });
        }
      }
      let pageText = text.slice(0, config.textLimit);
      if (!config.legacyMode && config.textMode !== "raw" && contextBlocks.length) {
        const rankedContext = rankContextBlocks(contextBlocks, {
          textLimit: config.textLimit,
          isIsolatedMainState: stateSignals.isIsolatedMainState,
        });
        pageText = rankedContext.text;
        textTruncated ||= rankedContext.text_truncated;
      } else {
        textTruncated ||= text.length > config.textLimit;
      }
      const filtered = filterCandidates(
        { candidates: rows },
        {
          maxActions: options.maxActions ?? 250,
          legacyMode: Boolean(config.legacyMode),
        }
      );
      for (const element of filtered.elements) {
        element.handle = handles.get(element.node_id);
        const record = this.frames.find(
          frame => frame.context.id === element.handle.frameId
        );
        record.items.push({
          nodeId: element.handle.nodeId,
          index: element.index,
          rect: element.rect,
        });
      }
      const snapshot = collected[0].snapshot;
      const result = {
        schemaVersion: 1,
        id,
        page: {
          url: snapshot.url,
          title: snapshot.title,
          text: pageText,
          text_truncated: textTruncated,
          state_signals: stateSignals,
        },
        viewport: snapshot.viewport,
        elements: filtered.elements,
        targets_by_operation: filtered.targets_by_operation,
        coverage: {
          viewportOnly: true,
          textTruncated,
          framesCollected: collected.length,
          framesSkipped: audit.filter(frame => frame.status !== "collected")
            .length,
          actionsOmitted: filtered.coverage.omitted_actions,
          ...filtered.coverage,
          frameAudit: audit,
        },
        timing: {
          total_ms: Date.now() - started,
          collection_ms: collected.reduce(
            (sum, item) => sum + item.snapshot.timing.browser_collect_ms,
            0
          ),
        },
      };
      this.result = result;
      if (!(await this.#show())) {
        throw new Error("Observation changed before highlighting");
      }
      if (generation !== this.generation) {
        throw new Error("Observation is stale");
      }
      result.timing.total_ms = Date.now() - started;
      return result;
    } catch (error) {
      if (this.id === id) {
        await this.clear();
      }
      throw error;
    }
  }

  async #show(selectedHandle = null) {
    const id = this.id;
    if (!id || !this.result) {
      return false;
    }
    const replies = await Promise.all(
      this.frames.map(async frame => {
        if (
          frame.context.currentWindowGlobal?.innerWindowId !== frame.documentId
        ) {
          return false;
        }
        try {
          return await query(frame.actor, "AgentObservation:Show", {
            id,
            documentId: frame.documentId,
            items: frame.items,
            selected:
              selectedHandle?.frameId === frame.context.id
                ? selectedHandle.nodeId
                : null,
          });
        } catch {
          return false;
        }
      })
    );
    if (id !== this.id) {
      return false;
    }
    if (!replies.every(Boolean)) {
      this.invalidate("stale");
      return false;
    }
    return true;
  }

  async highlight(handle) {
    const element = this.result?.elements.find(item =>
      ["observationId", "frameId", "documentId", "nodeId"].every(
        key => item.handle[key] === handle?.[key]
      )
    );
    return element ? this.#show(element.handle) : false;
  }

  invalidate(reason) {
    this.clear();
    this.onInvalidated(reason);
  }

  async clear() {
    this.generation++;
    this.id = null;
    this.result = null;
    const frames = this.frames;
    this.frames = [];
    await Promise.allSettled(
      frames.map(frame =>
        query(frame.actor, "AgentObservation:Clear", { id: frame.id })
      )
    );
  }

  destroy() {
    if (this.destroyed) {
      return Promise.resolve();
    }
    this.destroyed = true;
    const cleared = this.clear();
    Services.obs.removeObserver(this.observer, "agent-observation-invalidated");
    this.tabbrowser.removeTabsProgressListener(this.progressListener);
    if (sessions.get(this.browser) === this) {
      sessions.delete(this.browser);
    }
    return cleared;
  }
}
