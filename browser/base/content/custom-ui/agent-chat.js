/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var AgentChatPage = {
  messages: [],
  request: null,
  retry: null,
  statusId: "agent-chat-disconnected",

  get browserWindow() {
    return window.browsingContext.topChromeWindow;
  },

  get agent() {
    return this.browserWindow?.CustomAgentChatUI?.agent ?? null;
  },

  get pending() {
    return !!this.request;
  },

  get canSend() {
    let text = this.input.value.trim();
    return !!this.agent && !this.pending && !!text && text.length <= 32000;
  },

  init() {
    this.conversationId = Services.uuid.generateUUID().toString();
    this.input = document.getElementById("chat-input");
    this.form = document.getElementById("chat-form");
    this.sendButton = document.getElementById("chat-send");
    this.stopButton = document.getElementById("chat-stop");
    this.newButton = document.getElementById("chat-new");
    this.list = document.getElementById("chat-messages");
    this.empty = document.getElementById("chat-empty");
    this.status = document.getElementById("chat-status");
    this.form.addEventListener("submit", event => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener("input", () => this.updateAvailability());
    this.input.addEventListener("keydown", event => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        this.submit();
      }
    });
    this.stopButton.addEventListener("click", () => {
      this.cancel();
      this.input.focus();
    });
    this.newButton.addEventListener("click", () => {
      this.browserWindow.CustomAgentChatUI.openChat();
    });
    this.newButton.disabled = !this.browserWindow?.CustomAgentChatUI?.enabled;
    for (let suggestion of document.querySelectorAll(".chat-suggestion")) {
      suggestion.addEventListener("click", () => {
        this.input.value = suggestion.dataset.prompt;
        this.updateAvailability();
        this.input.focus();
      });
    }
    this.connectionListener = () => {
      if (this.request && this.request.agent !== this.agent) {
        this.cancel();
      }
      this.updateAvailability();
    };
    window.addEventListener("pageshow", () => {
      this.rebindWindow();
    });
    window.addEventListener("pagehide", () => {
      this.cancel();
      this.connectionWindow?.removeEventListener(
        "CustomAgentConnectionChanged",
        this.connectionListener
      );
    });
    this.rebindWindow();
    let query = this.browserWindow?.CustomAgentChatUI?.takeInitialQuery(
      window.browsingContext.embedderElement
    );
    if (query) {
      this.input.value = query;
      this.updateAvailability();
      if (this.canSend) {
        this.submit();
      }
    }
    document.l10n.ready.then(() => this.input.focus());
  },

  rebindWindow() {
    let owner = this.browserWindow;
    if (this.connectionWindow !== owner) {
      this.cancel();
      this.connectionWindow?.removeEventListener(
        "CustomAgentConnectionChanged",
        this.connectionListener
      );
      this.connectionWindow = owner;
    }
    this.connectionWindow?.addEventListener(
      "CustomAgentConnectionChanged",
      this.connectionListener
    );
    this.updateAvailability();
  },

  updateAvailability(statusId) {
    if (this.pending) {
      this.statusId = "agent-chat-responding";
    } else if (!this.agent) {
      this.statusId = "agent-chat-disconnected";
    } else if (statusId) {
      this.statusId = statusId;
    } else if (
      ["agent-chat-disconnected", "agent-chat-responding"].includes(
        this.statusId
      )
    ) {
      this.statusId = "agent-chat-ready";
    }
    document.l10n.setAttributes(this.status, this.statusId);
    this.sendButton.disabled = !this.canSend;
    this.newButton.disabled = !this.browserWindow?.CustomAgentChatUI?.enabled;
    this.sendButton.hidden = this.pending;
    this.stopButton.hidden = !this.pending;
    this.list.setAttribute("aria-busy", String(this.pending));
  },

  appendMessage(role, content) {
    let article = document.createElement("article");
    article.className = "chat-message";
    article.dataset.role = role;
    let author = document.createElement("div");
    author.className = "chat-message-author";
    document.l10n.setAttributes(author, `agent-chat-author-${role}`);
    let body = document.createElement("div");
    body.className = "chat-message-body";
    body.textContent = content;
    article.append(author, body);
    this.list.append(article);
    this.empty.hidden = true;
    this.list.hidden = false;
    this.scrollToEnd();
    return { article, body };
  },

  scrollToEnd() {
    this.list.scrollTop = this.list.scrollHeight;
  },

  async submit() {
    if (!this.canSend) {
      return;
    }
    let query = this.input.value.trim();
    let agent = this.agent;
    let userMessage = this.retry?.message;
    if (
      userMessage === this.messages.at(-1) &&
      userMessage?.content === query
    ) {
      this.retry.response.article.remove();
    } else {
      userMessage = { role: "user", content: query };
      this.messages.push(userMessage);
      this.appendMessage("user", query);
    }
    this.retry = null;
    this.input.value = "";
    let response = this.appendMessage("assistant", "");
    response.article.dataset.pending = "true";
    document.l10n.setAttributes(response.body, "agent-chat-pending-message");
    let request = {
      ...response,
      agent,
      text: "",
      controller: new AbortController(),
    };
    this.request = request;
    this.updateAvailability();
    this.input.focus();
    try {
      let answer = await agent.chat({
        conversationId: this.conversationId,
        messages: this.messages.map(message => ({ ...message })),
        signal: request.controller.signal,
        onDelta: delta => {
          if (this.request !== request || typeof delta !== "string") {
            return;
          }
          let atEnd =
            this.list.scrollHeight -
              this.list.scrollTop -
              this.list.clientHeight <
            80;
          request.text += delta;
          request.body.removeAttribute("data-l10n-id");
          request.body.textContent = request.text;
          if (atEnd) {
            this.scrollToEnd();
          }
        },
      });
      if (this.request !== request) {
        return;
      }
      if (answer !== undefined && typeof answer !== "string") {
        throw new TypeError("Agent chat must return text or stream a response");
      }
      let content = typeof answer === "string" ? answer : request.text;
      if (!content.trim()) {
        request.article.remove();
        this.request = null;
        this.input.value ||= query;
        this.retry = { message: userMessage, response: request };
        this.updateAvailability("agent-chat-empty-response");
        return;
      }
      request.body.removeAttribute("data-l10n-id");
      request.body.textContent = content;
      delete request.article.dataset.pending;
      this.messages.push({ role: "assistant", content });
      this.request = null;
      this.updateAvailability("agent-chat-ready");
    } catch (error) {
      if (this.request !== request) {
        return;
      }
      this.finishInterrupted(request);
      this.request = null;
      this.input.value ||= query;
      this.retry = { message: userMessage, response: request };
      this.updateAvailability("agent-chat-error");
      console.error("Agent chat request failed", error);
    }
  },

  finishInterrupted(request) {
    if (!request.text) {
      request.article.remove();
      return;
    }
    delete request.article.dataset.pending;
    request.article.dataset.interrupted = "true";
  },

  cancel() {
    let request = this.request;
    if (!request) {
      return;
    }
    this.request = null;
    request.controller.abort();
    this.finishInterrupted(request);
    this.updateAvailability("agent-chat-stopped");
  },
};

AgentChatPage.init();
