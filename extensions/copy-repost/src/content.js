(function runDiscordCopyRepostContentScript() {
  if (window.__discordCopyRepostContentLoaded) {
    return;
  }
  window.__discordCopyRepostContentLoaded = true;

  const messageSelector = '[id^="chat-messages-"]';
  const composerSelectors = [
    '[role="textbox"][contenteditable="true"]',
    '[data-slate-editor="true"][contenteditable="true"]',
    '[aria-label*="Message"][contenteditable="true"]'
  ];
  const submittedMessageKeys = new Set();
  const pendingMessageKeys = new Set();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "post-job") {
      postJobToComposer(message.job)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, reason: readableError(error) }));
      return true;
    }

    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startMessageObserver, { once: true });
  } else {
    startMessageObserver();
  }

  function startMessageObserver() {
    if (!document.body) {
      window.setTimeout(startMessageObserver, 250);
      return;
    }

    document.querySelectorAll(messageSelector).forEach(inspectMessageNode);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          inspectAddedNode(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function inspectAddedNode(node) {
    if (!isElement(node)) {
      return;
    }

    if (node.matches?.(messageSelector)) {
      inspectMessageNode(node);
    }

    node.querySelectorAll?.(messageSelector).forEach(inspectMessageNode);
  }

  function inspectMessageNode(messageNode) {
    const parser = window.DiscordCopyRepostParser;
    if (typeof parser?.extractAlertFromMessageNode !== "function") {
      console.warn("Discord copy repost parser is unavailable.");
      return;
    }

    let payload;
    try {
      payload = parser.extractAlertFromMessageNode(messageNode, location.href);
    } catch (error) {
      console.warn("Discord copy repost parser failed.", error);
      return;
    }

    if (!hasVisibleContent(payload)) {
      return;
    }

    const messageKey = payloadKey(payload);
    if (submittedMessageKeys.has(messageKey) || pendingMessageKeys.has(messageKey)) {
      return;
    }

    pendingMessageKeys.add(messageKey);
    chrome.runtime.sendMessage({ type: "submit-payload", payload }, (response) => {
      pendingMessageKeys.delete(messageKey);

      if (chrome.runtime.lastError) {
        console.warn("Copy repost submit failed:", chrome.runtime.lastError.message);
        return;
      }

      if (response?.ok) {
        submittedMessageKeys.add(messageKey);
        return;
      }

      console.warn("Copy repost submit failed:", response?.reason || "unknown failure");
    });
  }

  async function postJobToComposer(job) {
    if (!job || typeof job.messageText !== "string" || !job.messageText.trim()) {
      return { ok: false, reason: "job messageText is required" };
    }

    if (!sameDiscordChannel(location.href, job.destinationUrl)) {
      return { ok: false, reason: "Destination channel mismatch" };
    }

    const editor = await waitForComposer();
    if (composerText(editor).trim()) {
      return { ok: false, reason: "Discord composer is not empty" };
    }

    editor.focus();
    placeCaretAtEnd(editor);

    if (!insertText(editor, job.messageText)) {
      return { ok: false, reason: "Unable to insert message text into Discord composer" };
    }

    await delay(150);

    if (clickSendButton()) {
      if (await waitForComposerClear(editor, job.messageText)) {
        return successfulPostResult(job);
      }

      return { ok: false, reason: "Unable to verify Discord send after button click" };
    }

    pressEnter(editor);
    if (await waitForComposerClear(editor, job.messageText)) {
      return successfulPostResult(job);
    }

    return { ok: false, reason: "Unable to verify Discord send after Enter fallback" };
  }

  async function waitForComposer() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const editor = findComposer();
      if (editor && isVisible(editor)) {
        return editor;
      }
      await delay(250);
    }
    throw new Error("Discord composer not found");
  }

  function findComposer() {
    for (const selector of composerSelectors) {
      const editor = document.querySelector(selector);
      if (editor) {
        return editor;
      }
    }
    return null;
  }

  function insertText(editor, text) {
    try {
      const inserted = document.execCommand("insertText", false, text);
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text
        })
      );
      return inserted || composerText(editor).includes(firstMeaningfulText(text));
    } catch {
      return false;
    }
  }

  function clickSendButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const sendButton = buttons.find((button) => {
      const ariaLabel = (button.getAttribute("aria-label") || "").trim().toLowerCase();
      const text = (button.textContent || "").trim().toLowerCase();
      const label = ariaLabel || text;
      return (
        (label === "send" || label === "send message" || label.includes("send message")) &&
        isVisible(button) &&
        !button.disabled
      );
    });

    if (!sendButton) {
      return false;
    }

    sendButton.click();
    return true;
  }

  function pressEnter(editor) {
    const eventOptions = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    editor.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
    editor.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
  }

  async function waitForComposerClear(editor, previousText) {
    const deadline = Date.now() + 2500;
    const expectedText = normalizeComposerText(previousText);
    while (Date.now() < deadline) {
      const currentEditor = findComposer() || editor;
      const currentText = normalizeComposerText(composerText(currentEditor));
      if (!currentText || (expectedText && !currentText.includes(expectedText))) {
        return true;
      }
      await delay(100);
    }
    return false;
  }

  function placeCaretAtEnd(editor) {
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    if (!selection || !range) {
      return;
    }
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function composerText(editor) {
    return editor.innerText || editor.textContent || "";
  }

  function normalizeComposerText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function hasVisibleContent(payload) {
    return Boolean(
      payload?.text?.trim() ||
        payload?.embeds?.length ||
        payload?.labels?.length ||
        payload?.attachmentUrls?.length
    );
  }

  function payloadKey(payload) {
    return `${payload.sourceChannelId || "unknown"}:${payload.messageId || ""}`;
  }

  function successfulPostResult(job) {
    return {
      ok: true,
      degradation: degradationForJob(job)
    };
  }

  function degradationForJob(job) {
    const degradation = [];
    if (Array.isArray(job.payload?.attachmentUrls) && job.payload.attachmentUrls.length > 0) {
      degradation.push("attachments_included_as_urls");
    }
    return degradation;
  }

  function sameDiscordChannel(currentUrl, destinationUrl) {
    const currentChannel = discordChannelPrefix(currentUrl);
    const destinationChannel = discordChannelPrefix(destinationUrl);
    return Boolean(currentChannel && destinationChannel && currentChannel === destinationChannel);
  }

  function discordChannelPrefix(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)/);
      return url.protocol === "https:" && url.hostname === "discord.com" && match
        ? `${url.origin}/channels/${match[1]}/${match[2]}`
        : "";
    } catch {
      return "";
    }
  }

  function isElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE;
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function firstMeaningfulText(text) {
    return String(text || "")
      .split(/\s+/)
      .find(Boolean) || "";
  }

  function readableError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
