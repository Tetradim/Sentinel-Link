(function runDiscordCopyRepostContentScript() {
  const contentScriptVersion = "0.1.10";
  if (window.__discordCopyRepostContentVersion === contentScriptVersion) {
    return;
  }
  window.__discordCopyRepostContentLoaded = true;
  window.__discordCopyRepostContentVersion = contentScriptVersion;

  const messageSelector = '[id^="chat-messages-"]';
  const composerSelectors = [
    '[role="textbox"][contenteditable="true"]',
    '[data-slate-editor="true"][contenteditable="true"]',
    '[aria-label*="Message"][contenteditable="true"]'
  ];
  const composerWaitTimeoutMs = 60_000;
  const trustedDraftWaitTimeoutMs = 5_000;
  const trustedSendConfirmationTimeoutMs = 15_000;
  const submittedMessageKeys = new Set();
  const pendingMessageKeys = new Set();

  if (window.__DISCORD_COPY_REPOST_TEST__) {
    window.DiscordCopyRepostContentTest = {
      captureVisibleMessageKeys,
      messageNodeTextMatches,
      messageNodesForAddedNode,
      payloadKey,
      normalizeComposerText,
      prepareComposerForTrustedInput,
      verifyComposerDraft,
      waitForComposerDraft,
      contentScriptVersion,
      waitForComposer,
      waitForSendConfirmation
    };
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ping") {
      sendResponse({ ok: true, version: contentScriptVersion });
      return false;
    }

    if (message?.type === "post-job") {
      sendResponse({
        ok: false,
        reason: "Stale copy/repost service worker: reload the unpacked extension."
      });
      return false;
    }

    if (message?.type === "prepare-composer") {
      prepareComposerForTrustedInput(message.job)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, reason: readableError(error) }));
      return true;
    }

    if (message?.type === "verify-composer-draft") {
      waitForComposerDraft(message.expectedText)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, reason: readableError(error) }));
      return true;
    }

    if (message?.type === "confirm-posted") {
      confirmPostedMessage(message.job, message.beforeMessageKeys)
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
        inspectMutation(mutation);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function inspectMutation(mutation) {
    if (mutation?.type === "characterData") {
      inspectAddedNode(mutation.target);
      return;
    }

    for (const node of mutation?.addedNodes || []) {
      inspectAddedNode(node);
    }
  }

  function inspectAddedNode(node) {
    messageNodesForAddedNode(node).forEach(inspectMessageNode);
  }

  function messageNodesForAddedNode(node) {
    if (!node) {
      return [];
    }

    const nodes = [];
    const element = asElement(node);
    if (element?.matches?.(messageSelector)) {
      nodes.push(element);
    }

    element?.querySelectorAll?.(messageSelector).forEach((messageNode) => {
      nodes.push(messageNode);
    });

    const ancestor = closestMessageNode(node);
    if (ancestor) {
      nodes.push(ancestor);
    }

    return uniqueElements(nodes);
  }

  function closestMessageNode(node) {
    let current = asElement(node) || parentElement(node);
    while (current) {
      if (current.matches?.(messageSelector)) {
        return current;
      }
      current = parentElement(current);
    }
    return null;
  }

  function uniqueElements(nodes) {
    const seen = new Set();
    const unique = [];
    for (const node of nodes) {
      if (node && !seen.has(node)) {
        seen.add(node);
        unique.push(node);
      }
    }
    return unique;
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

    const beforeMessageKeys = captureVisibleMessageKeys();

    if (clickSendButton()) {
      if (await waitForSendConfirmation(editor, job.messageText, beforeMessageKeys)) {
        return successfulPostResult(job);
      }

      return { ok: false, reason: "Unable to verify Discord send after button click" };
    }

    pressEnter(editor);
    if (await waitForSendConfirmation(editor, job.messageText, beforeMessageKeys)) {
      return successfulPostResult(job);
    }

    return { ok: false, reason: "Unable to verify Discord send after Enter fallback" };
  }

  async function prepareComposerForTrustedInput(job) {
    const validation = validatePostJob(job);
    if (validation) {
      return validation;
    }

    const editor = await waitForComposer();
    const currentText = composerText(editor).trim();
    const matchingDraft = composerDraftMatches(editor, job.messageText);
    if (currentText && !matchingDraft && !isRepostDraft(currentText)) {
      return { ok: false, reason: "Discord composer is not empty" };
    }

    editor.focus();
    selectComposerContents(editor);

    return {
      ok: true,
      beforeMessageKeys: Array.from(captureVisibleMessageKeys()),
      replacingDraft: Boolean(currentText && !matchingDraft)
    };
  }

  function validatePostJob(job) {
    if (!job || typeof job.messageText !== "string" || !job.messageText.trim()) {
      return { ok: false, reason: "job messageText is required" };
    }

    if (!sameDiscordChannel(location.href, job.destinationUrl)) {
      return { ok: false, reason: "Destination channel mismatch" };
    }

    return null;
  }

  function verifyComposerDraft(expectedText) {
    const editor = findComposer();
    if (!editor || !isVisible(editor)) {
      return { ok: false, reason: "Discord composer not found" };
    }

    if (!composerDraftMatches(editor, expectedText)) {
      return { ok: false, reason: "Discord composer did not contain the expected repost text" };
    }

    return { ok: true };
  }

  async function waitForComposerDraft(expectedText, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : trustedDraftWaitTimeoutMs;
    const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 100;
    const deadline = Date.now() + timeoutMs;
    let lastResult = verifyComposerDraft(expectedText);

    while (!lastResult.ok && Date.now() < deadline) {
      await delay(Math.max(0, pollMs));
      lastResult = verifyComposerDraft(expectedText);
    }

    return lastResult;
  }

  async function confirmPostedMessage(job, beforeMessageKeys = []) {
    const validation = validatePostJob(job);
    if (validation) {
      return validation;
    }

    const editor = await waitForComposer();
    const confirmed = await waitForSendConfirmation(
      editor,
      job.messageText,
      new Set(Array.isArray(beforeMessageKeys) ? beforeMessageKeys : []),
      { timeoutMs: trustedSendConfirmationTimeoutMs }
    );

    if (!confirmed) {
      return { ok: false, reason: "Unable to verify Discord send after trusted input" };
    }

    return successfulPostResult(job);
  }

  async function waitForComposer() {
    const deadline = Date.now() + composerWaitTimeoutMs;
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

  async function waitForSendConfirmation(editor, expectedText, beforeMessageKeys = new Set(), options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2500;
    const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 100;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const currentEditor = findComposer() || editor;
      const currentText = normalizeComposerText(composerText(currentEditor));
      if (!currentText || findNewMatchingMessageNode(expectedText, beforeMessageKeys)) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(Math.max(0, pollMs));
    }
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

  function selectComposerContents(editor) {
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    if (!selection || !range) {
      return;
    }
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function composerText(editor) {
    return editor.innerText || editor.textContent || "";
  }

  function composerDraftMatches(editor, expectedText) {
    const currentText = normalizeComposerText(composerText(editor));
    const expected = normalizeComposerText(expectedText);
    return Boolean(currentText && expected && (currentText === expected || currentText.includes(expected)));
  }

  function isRepostDraft(text) {
    const normalized = normalizeComposerText(text);
    return normalized.startsWith("[copied-alert]") || normalized.includes("Source: https://discord.com/channels/");
  }

  function normalizeComposerText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function captureVisibleMessageKeys() {
    return new Set(
      visibleMessageNodes()
        .map(messageNodeKey)
        .filter(Boolean)
    );
  }

  function findNewMatchingMessageNode(expectedText, beforeMessageKeys) {
    return visibleMessageNodes().find((messageNode) => {
      const key = messageNodeKey(messageNode);
      return key && !beforeMessageKeys.has(key) && messageNodeTextMatches(messageNode, expectedText);
    });
  }

  function visibleMessageNodes() {
    return Array.from(document.querySelectorAll(messageSelector)).filter(isVisible);
  }

  function messageNodeTextMatches(messageNode, expectedText) {
    const messageText = normalizeComposerText(messageNode.innerText || messageNode.textContent || "");
    const expected = normalizeComposerText(expectedText);
    if (!messageText || !expected) {
      return false;
    }
    if (messageText.includes(expected)) {
      return true;
    }

    const prefix = meaningfulMessagePrefix(expected);
    return Boolean(prefix && messageText.includes(prefix));
  }

  function meaningfulMessagePrefix(expectedText) {
    const words = expectedText.split(" ").filter(Boolean);
    if (words.length >= 6) {
      return words.slice(0, 6).join(" ");
    }
    if (expectedText.length >= 24) {
      return expectedText.slice(0, 24);
    }
    return expectedText;
  }

  function hasVisibleContent(payload) {
    return Boolean(
      payload?.text?.trim() ||
        payload?.embeds?.length ||
        payload?.attachmentUrls?.length
    );
  }

  function payloadKey(payload) {
    return `${payload.sourceChannelId || "unknown"}:visible:${hashString(
      JSON.stringify({
        sourceUrl: discordChannelPrefix(payload?.sourceUrl || location.href),
        author: normalizeVisibleText(payload?.author),
        timestampText: normalizeVisibleText(payload?.timestampText),
        timestampIso: typeof payload?.timestampIso === "string" ? payload.timestampIso.trim() : "",
        text: normalizeVisibleText(payload?.text),
        embeds: normalizeVisibleEmbeds(payload?.embeds),
        attachmentUrls: Array.isArray(payload?.attachmentUrls)
          ? payload.attachmentUrls.filter((url) => typeof url === "string").map((url) => url.trim()).filter(Boolean)
          : []
      })
    )}`;
  }

  function normalizeVisibleEmbeds(embeds) {
    if (!Array.isArray(embeds)) {
      return [];
    }
    return embeds.map((embed) => ({
      title: normalizeVisibleText(embed?.title),
      description: normalizeVisibleText(embed?.description),
      fields: Array.isArray(embed?.fields)
        ? embed.fields.map((field) => ({
            name: normalizeVisibleText(field?.name),
            value: normalizeVisibleText(field?.value)
          }))
        : [],
      footer: normalizeVisibleText(embed?.footer)
    }));
  }

  function normalizeVisibleText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function hashString(value) {
    let hash = 0;
    for (const character of String(value || "")) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return hash.toString(16);
  }

  function messageNodeKey(messageNode) {
    return (
      getAttribute(messageNode, "data-list-item-id") ||
      getAttribute(messageNode, "id") ||
      messageNode.id ||
      ""
    );
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

  function asElement(node) {
    return isElement(node) ? node : null;
  }

  function parentElement(node) {
    const parent = node?.parentElement || node?.parentNode || null;
    return isElement(parent) ? parent : null;
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

  function getAttribute(node, name) {
    if (!node || typeof node.getAttribute !== "function") {
      return "";
    }
    try {
      return node.getAttribute(name) || "";
    } catch {
      return "";
    }
  }

  function readableError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
