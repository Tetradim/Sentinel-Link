(function runDiscordCopyRepostContentScript() {
  const contentScriptVersion = "0.1.16";
  if (typeof window.__discordCopyRepostContentCleanup === "function") {
    try {
      window.__discordCopyRepostContentCleanup();
    } catch {
      // A previous extension context may already be invalidated.
    }
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
  const submittedTradingBridgeKeys = new Set();
  const pendingTradingBridgeKeys = new Set();
  const bridgeRevisionByMessageId = new Map();
  let initialScanComplete = false;
  let tradingBridgeHeartbeatTimer = null;
  let messageObserver = null;

  if (window.__DISCORD_COPY_REPOST_TEST__) {
    window.DiscordCopyRepostContentTest = {
      captureVisibleMessageKeys,
      isBridgeListenSource,
      sourceModeForBridge,
      chromeBridgePayload,
      enrichPayloadWithLocalOcr,
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

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === "copy-repost:ping") {
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
  }

  window.__discordCopyRepostContentCleanup = () => {
    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    } catch {
      // The old extension context can no longer remove its listener.
    }
    messageObserver?.disconnect?.();
    messageObserver = null;
    if (tradingBridgeHeartbeatTimer) {
      window.clearInterval(tradingBridgeHeartbeatTimer);
      tradingBridgeHeartbeatTimer = null;
    }
  };
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

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

    document.querySelectorAll(messageSelector).forEach((messageNode) => {
      inspectMessageNode(messageNode, { initial: true });
    });
    initialScanComplete = true;
    startTradingBridgeHeartbeat();

    messageObserver?.disconnect?.();
    messageObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        inspectMutation(mutation);
      }
    });
    messageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
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

  function inspectMessageNode(messageNode, options = {}) {
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

    void processParsedPayload(messageNode, payload, options);
  }

  async function processParsedPayload(messageNode, payload, options) {
    payload = await enrichPayloadWithLocalOcr(messageNode, payload);
    if (!hasVisibleContent(payload)) return;
    const previousRevision = bridgeRevisionByMessageId.get(payload.messageId);
    payload.eventType = previousRevision && previousRevision !== payload.revisionHash ? "updated" : "created";
    bridgeRevisionByMessageId.set(payload.messageId, payload.revisionHash || "");

    const messageKey = payloadKey(payload);
    void submitTradingBridgePayload(payload, messageKey, options);
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

  async function enrichPayloadWithLocalOcr(_messageNode, payload) {
    if (
      payload?.text?.trim() ||
      payload?.embeds?.length ||
      !payload?.attachmentUrls?.length ||
      typeof globalThis.TextDetector !== "function" ||
      typeof globalThis.createImageBitmap !== "function" ||
      typeof globalThis.fetch !== "function"
    ) {
      return payload;
    }

    const recognized = [];
    const confidences = [];
    try {
      const detector = new globalThis.TextDetector();
      for (const url of payload.attachmentUrls.slice(0, 3)) {
        const response = await globalThis.fetch(url);
        if (!response.ok) continue;
        const bitmap = await globalThis.createImageBitmap(await response.blob());
        try {
          const blocks = await detector.detect(bitmap);
          for (const block of blocks || []) {
            const value = String(block?.rawValue || "").trim();
            if (value) recognized.push(value);
            if (Number.isFinite(Number(block?.confidence))) confidences.push(Number(block.confidence));
          }
        } finally {
          if (typeof bitmap.close === "function") bitmap.close();
        }
      }
    } catch (error) {
      console.warn("Local attachment OCR failed.", error);
      return payload;
    }

    if (!recognized.length) return payload;
    const ocrText = recognized.join("\n");
    const confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : structuredOcrConfidence(ocrText);
    return { ...payload, ocrText, ocrConfidence: Math.min(1, Math.max(0, confidence)) };
  }

  function structuredOcrConfidence(value) {
    const text = String(value || "").toUpperCase();
    const hasTicker = /(?:^|\s)\$?[A-Z]{1,5}(?:\s|$)/.test(text);
    const hasContract = /\b\d+(?:\.\d+)?\s*(?:C|P|CALLS?|PUTS?)\b/.test(text);
    const hasEntryPrice = /(?:@|ENTRY|IN\s+AT)\s*\$?\s*\d*\.\d+/.test(text);
    return hasTicker && hasContract && hasEntryPrice ? 0.85 : 0.65;
  }

  async function submitTradingBridgePayload(payload, messageKey, options = {}) {
    const settings = await chrome.storage.local.get({
      enabled: true,
      forwardExistingOnEnable: false,
      targetUrl: DEFAULT_MESSAGE_URL,
      heartbeatUrl: DEFAULT_HEARTBEAT_URL,
      listenChannelUrls: [],
      listenOnlyChannelUrls: [],
      targets: []
    });
    if (!settings.enabled || !isTradingBridgeChannelEnabled(settings, payload.sourceUrl, payload.sourceChannelId)) {
      return;
    }
    if (!isBridgeListenSource(settings, payload.sourceUrl, payload.sourceChannelId)) {
      publishTradingBridgeHeartbeat("ignored_post_channel_for_bridge", {
        channel_url: payload.sourceUrl || channelUrlFromPage()
      });
      return;
    }
    const sourceMode = sourceModeForBridge(settings, payload.sourceUrl, payload.sourceChannelId);

    if ((options.initial || !initialScanComplete) && !settings.forwardExistingOnEnable) {
      submittedTradingBridgeKeys.add(messageKey);
      return;
    }

    if (submittedTradingBridgeKeys.has(messageKey) || pendingTradingBridgeKeys.has(messageKey)) {
      return;
    }

    pendingTradingBridgeKeys.add(messageKey);
    chrome.runtime.sendMessage(
      {
        type: "trading-bridge:discord-message",
        payload: chromeBridgePayload(payload, sourceMode)
      },
      (response) => {
        pendingTradingBridgeKeys.delete(messageKey);
        if (chrome.runtime.lastError) {
          console.warn("Trading bridge submit failed:", chrome.runtime.lastError.message);
          publishTradingBridgeHeartbeat("forward_error", { error: chrome.runtime.lastError.message });
          return;
        }
        if (response?.ok) {
          submittedTradingBridgeKeys.add(messageKey);
          publishTradingBridgeHeartbeat("ok", { last_event_id: payload.messageId || messageKey });
          return;
        }
        const error = response?.error || "unknown failure";
        console.warn("Trading bridge submit failed:", error);
        publishTradingBridgeHeartbeat("forward_error", { error });
      }
    );
  }

  function startTradingBridgeHeartbeat() {
    if (tradingBridgeHeartbeatTimer) {
      return;
    }
    publishTradingBridgeHeartbeat();
    tradingBridgeHeartbeatTimer = window.setInterval(publishTradingBridgeHeartbeat, 30_000);
  }

  function publishTradingBridgeHeartbeat(status = "ok", details = {}) {
    chrome.storage.local.get({ enabled: true }, (settings) => {
      const payload = {
        status,
        bridge_enabled: Boolean(settings.enabled),
        url: location.href,
        channel_id: channelIdFromPage(),
        channel_url: channelUrlFromPage(),
        channel_name: channelNameFromPage(),
        observed_at: new Date().toISOString(),
        details
      };
      chrome.runtime.sendMessage({ type: "trading-bridge:bridge-heartbeat", payload }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("Trading bridge heartbeat failed:", chrome.runtime.lastError.message);
          return;
        }
        if (!response?.ok) {
          console.warn("Trading bridge heartbeat failed:", response?.error || "unknown failure");
        }
      });
    });
  }

  function chromeBridgePayload(payload, sourceMode = "") {
    return {
      event_id: payload.messageId || payloadKey(payload),
      channel_id: payload.sourceChannelId || channelIdFromPage(),
      channel_name: channelNameFromPage(),
      author_id: "",
      author_name: payload.author || "",
      author_raw: payload.authorRaw || payload.author || "",
      content: payload.text || "",
      embeds: Array.isArray(payload.embeds) ? payload.embeds.map(embed => ({
        ...embed,
        footer_text: embed.footer_text || embed.footer || ""
      })) : [],
      url: /^\d+$/.test(String(payload.messageId || "")) && payload.sourceUrl
        ? `${payload.sourceUrl.replace(/\/$/, "")}/${payload.messageId}`
        : location.href,
      channel_url: payload.sourceUrl || channelUrlFromPage(),
      observed_at: payload.capturedAt || new Date().toISOString(),
      timestampIso: payload.timestampIso || "",
      revision_hash: payload.revisionHash || "",
      event_type: payload.eventType === "updated" ? "updated" : "created",
      attachment_urls: Array.isArray(payload.attachmentUrls) ? payload.attachmentUrls : [],
      ocr_text: payload.ocrText || "",
      ocr_confidence: Number.isFinite(payload.ocrConfidence) ? payload.ocrConfidence : null,
      source: "sentinel-link",
      source_mode: sourceMode
    };
  }

  function sourceModeForBridge(settings, url, channelId) {
    if (matchesSavedListenChannel(settings.listenOnlyChannelUrls, url, channelId)) {
      return "listen-only";
    }
    if (matchesSavedListenChannel(settings.listenChannelUrls, url, channelId)) {
      return "listen";
    }
    return "";
  }

  function isBridgeListenSource(settings, url, channelId) {
    return isSavedListenChannel([
      ...(Array.isArray(settings.listenChannelUrls) ? settings.listenChannelUrls : []),
      ...(Array.isArray(settings.listenOnlyChannelUrls) ? settings.listenOnlyChannelUrls : [])
    ], url, channelId);
  }

  function isSavedListenChannel(listenChannelUrls, url, channelId) {
    const listenUrls = Array.isArray(listenChannelUrls)
      ? listenChannelUrls.map((value) => canonicalDiscordChannelUrl(String(value || ""))).filter(Boolean)
      : [];
    if (listenUrls.length === 0) {
      return true;
    }

    return matchesNormalizedListenChannels(listenUrls, url, channelId);
  }

  function matchesSavedListenChannel(listenChannelUrls, url, channelId) {
    const listenUrls = Array.isArray(listenChannelUrls)
      ? listenChannelUrls.map((value) => canonicalDiscordChannelUrl(String(value || ""))).filter(Boolean)
      : [];
    return listenUrls.length > 0 && matchesNormalizedListenChannels(listenUrls, url, channelId);
  }

  function matchesNormalizedListenChannels(listenUrls, url, channelId) {
    const canonicalUrl = canonicalDiscordChannelUrl(url || location.href);
    if (canonicalUrl && listenUrls.includes(canonicalUrl)) {
      return true;
    }

    const listenIds = listenUrls.map((value) => channelIdFromDiscordUrl(value)).filter(Boolean);
    const resolvedChannelId = String(channelId || channelIdFromPage() || "");
    return Boolean(resolvedChannelId && listenIds.includes(resolvedChannelId));
  }

  function isTradingBridgeChannelEnabled(settings, url, channelId) {
    if (typeof targetsForDiscordChannel !== "function") {
      return true;
    }
    return targetsForDiscordChannel(settings, url || location.href, channelId || channelIdFromPage()).length > 0;
  }

  function channelUrlFromPage() {
    if (typeof canonicalDiscordChannelUrl === "function") {
      return canonicalDiscordChannelUrl(location.href) || location.href;
    }
    return location.href;
  }

  function channelIdFromPage() {
    if (typeof channelIdFromDiscordUrl === "function") {
      return channelIdFromDiscordUrl(location.href);
    }
    const match = location.pathname.match(/^\/channels\/(?:@me|\d+)\/(\d+)/);
    return match ? match[1] : "";
  }

  function channelNameFromPage() {
    return (document.title || "Discord").replace(/\s+-\s+Discord$/i, "").trim();
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
