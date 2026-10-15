/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Routes observation invalidation to the owning browser session. */
export class AgentObservationParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name === "AgentObservation:Invalidated") {
      Services.obs.notifyObservers(
        this.browsingContext.top.embedderElement,
        "agent-observation-invalidated",
        JSON.stringify(data)
      );
    }
  }
}
