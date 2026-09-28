importScripts("channel-routes.js", "freshness.js", "destination-window.js", "source-routing.js", "trading-bridge-config.js");

const helperBaseUrl = "http://127.0.0.1:17654";
const clientId = "sentinel-link-extension-0.2.4";
const nativeHostName = "com.tetradim.discord_copy_repost";
const pollAlarmName = "copy-repost-poll";
const pollAlarmPeriodMinutes = 1;
const configCacheTtlMs = 60_000;
const discordTabLoadTimeoutMs = 90_000;
const contentScriptVersion = "0.1.16";
const listenStorageKey = "listenChannelUrls";
const listenOnlyStorageKey = "listenOnlyChannelUrls";
const postStorageKey = "postChannelUrls";
const maxMessageAgeMinutesStorageKey = "maxMessageAgeMinutes";
const launcherStatusStorageKey = "launcherStatus";
const tradingBridgeHeartbeatAlarmName = "sentinel-link-trading-bridge-heartbeat";
const tradingBridgeSupervisorAlarmName = "sentinel-link-trading-bridge-supervisor";
const tradingBridgeRestartRetryAlarmName = "sentinel-link-trading-bridge-restart-retry";
const tradingBridgeFetchTimeoutMs = 5000;
const tradingBridgeDiscordTabUrls = ["https://discord.com/*", "https://*.discord.com/*"];
const tradingBridgeDefaults = {
  enabled: true,
  targetUrl: DEFAULT_MESSAGE_URL,
  heartbeatUrl: DEFAULT_HEARTBEAT_URL,
  apiKey: "",
  targets: [],
  forwardExistingOnEnable: false,
  autoRestartEnabled: true,
  bridgeRestartAttempt: 0
};
const routeHelpers = globalThis.CopyRepostChannelRoutes;
const freshnessHelpers = globalThis.CopyRepostFreshness;
const destinationWindowHelpers = globalThis.CopyRepostDestinationWindow;
const sourceRoutingHelpers = globalThis.CopyRepostSourceRouting;
const destinationWindowKeys = destinationWindowHelpers.keys;

let pollInFlight = false;
let sourceConfigCache = null;
let nativePort = null;
let nativeRequestId = 0;
let nativeShutdownRequested = false;
let nativeHelperEnsurePromise = null;
const pendingNativeRequests = new Map();
const contentScriptEnsurePromises = new Map();
const destinationTabOpenPromises = new Map();

void ensurePollAlarm();
void ensureTradingBridgeAlarms();

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    await initializeStorageDefaults();
    await ensureNativeHelper();
    await ensurePollAlarm();
    await ensureTradingBridgeAlarms();
    void publishTradingBridgeHeartbeat("ok", { reason: "installed" });
    void superviseTradingBridgeTabs("installed");
    void pollHelper();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await ensureNativeHelper();
    await ensurePollAlarm();
    await ensureTradingBridgeAlarms();
    void publishTradingBridgeHeartbeat("ok", { reason: "startup" });
    void superviseTradingBridgeTabs("startup");
    void pollHelper();
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "submit-payload") {
    submitPayload(message.payload)
      .then((result) => {
        sendResponse(result);
        if (result?.ok && !result?.ignored) {
          void pollHelper();
        }
      })
      .catch((error) => sendResponse({ ok: false, reason: readableError(error) }));
    return true;
  }

  if (message?.type === "trading-bridge:discord-message") {
    forwardTradingBridgeMessage(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message?.type === "trading-bridge:bridge-heartbeat") {
    forwardTradingBridgeHeartbeat(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message?.type === "launch-helper") {
    launchHelper(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, reason: readableError(error) }));
    return true;
  }

  if (message?.type === "shutdown-all") {
    shutdownAll()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, reason: readableError(error) }));
    return true;
  }

  if (message?.type === "open-dedicated-post-window") {
    openDedicatedPostWindowFromPopup(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, reason: readableError(error) }));
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === pollAlarmName) {
    void pollHelper();
    return;
  }

  if (alarm.name === tradingBridgeHeartbeatAlarmName) {
    void publishTradingBridgeHeartbeat("ok", { reason: "alarm" });
    return;
  }

  if (alarm.name === tradingBridgeSupervisorAlarmName || alarm.name === tradingBridgeRestartRetryAlarmName) {
    void superviseTradingBridgeTabs(alarm.name);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (
    changes.helperToken ||
    changes.enabled ||
    changes[listenStorageKey] ||
    changes[listenOnlyStorageKey] ||
    changes[postStorageKey] ||
    changes[maxMessageAgeMinutesStorageKey] ||
    changes[destinationWindowKeys.dedicatedPostWindowEnabled] ||
    changes[destinationWindowKeys.dedicatedPostWindowMinimized] ||
    changes[destinationWindowKeys.closePostWindowsOnShutdown] ||
    changes.targetUrl ||
    changes.heartbeatUrl ||
    changes.apiKey ||
    changes.targets ||
    changes.forwardExistingOnEnable ||
    changes.autoRestartEnabled
  ) {
    sourceConfigCache = null;
    void ensurePollAlarm();
    void ensureTradingBridgeAlarms();
    void publishTradingBridgeHeartbeat("ok", { reason: "settings_changed" });
    void superviseTradingBridgeTabs("settings_changed");
    void pollHelper();
  }
});

async function initializeStorageDefaults() {
  const state = await chrome.storage.local.get([
    "enabled",
    "helperToken",
    "targetUrl",
    "heartbeatUrl",
    "apiKey",
    "targets",
    "forwardExistingOnEnable",
    "autoRestartEnabled",
    listenStorageKey,
    listenOnlyStorageKey,
    postStorageKey,
    maxMessageAgeMinutesStorageKey,
    destinationWindowKeys.dedicatedPostWindowEnabled,
    destinationWindowKeys.dedicatedPostWindowMinimized,
    destinationWindowKeys.closePostWindowsOnShutdown,
    destinationWindowKeys.managedDestinationWindowId,
    destinationWindowKeys.managedDestinationTabIds
  ]);
  const defaults = {
    lastStatus: "installed",
    lastStatusAt: new Date().toISOString(),
    [launcherStatusStorageKey]: "not connected"
  };

  if (typeof state.enabled !== "boolean") {
    defaults.enabled = true;
  }

  if (typeof state.autoRestartEnabled !== "boolean") {
    defaults.autoRestartEnabled = true;
  }

  if (typeof state.forwardExistingOnEnable !== "boolean") {
    defaults.forwardExistingOnEnable = false;
  }

  if (typeof state.targetUrl !== "string") {
    defaults.targetUrl = DEFAULT_MESSAGE_URL;
  }

  if (typeof state.heartbeatUrl !== "string") {
    defaults.heartbeatUrl = DEFAULT_HEARTBEAT_URL;
  }

  if (typeof state.apiKey !== "string") {
    defaults.apiKey = "";
  }

  if (!Array.isArray(state.targets)) {
    defaults.targets = [];
  }

  if (typeof state.helperToken !== "string") {
    defaults.helperToken = "";
  }

  if (!Array.isArray(state[listenStorageKey])) {
    defaults[listenStorageKey] = [];
  }

  if (!Array.isArray(state[listenOnlyStorageKey])) {
    defaults[listenOnlyStorageKey] = [];
  }

  if (!Array.isArray(state[postStorageKey])) {
    defaults[postStorageKey] = [];
  }

  if (typeof state[maxMessageAgeMinutesStorageKey] !== "number") {
    defaults[maxMessageAgeMinutesStorageKey] = freshnessHelpers.defaultFreshnessWindowMinutes;
  }

  if (typeof state[destinationWindowKeys.dedicatedPostWindowEnabled] !== "boolean") {
    defaults[destinationWindowKeys.dedicatedPostWindowEnabled] = false;
  }

  if (typeof state[destinationWindowKeys.dedicatedPostWindowMinimized] !== "boolean") {
    defaults[destinationWindowKeys.dedicatedPostWindowMinimized] = true;
  }

  if (typeof state[destinationWindowKeys.closePostWindowsOnShutdown] !== "boolean") {
    defaults[destinationWindowKeys.closePostWindowsOnShutdown] = true;
  }

  if (typeof state[destinationWindowKeys.managedDestinationWindowId] !== "number") {
    defaults[destinationWindowKeys.managedDestinationWindowId] = null;
  }

  if (!Array.isArray(state[destinationWindowKeys.managedDestinationTabIds])) {
    defaults[destinationWindowKeys.managedDestinationTabIds] = [];
  }

  await chrome.storage.local.set(defaults);
}

async function submitPayload(payload) {
  const {
    enabled = true,
    maxMessageAgeMinutes = freshnessHelpers.defaultFreshnessWindowMinutes
  } = await chrome.storage.local.get(["enabled", maxMessageAgeMinutesStorageKey]);
  if (!enabled) {
    await setStatus("disabled");
    return { ok: false, reason: "extension disabled" };
  }

  let sourceConfig;
  try {
    sourceConfig = await getEnabledSourceConfig();
  } catch (error) {
    const reason = readableError(error);
    const status = reason === "missing helper token" ? "missing helper token" : `config unavailable: ${reason}`;
    await setStatus(status);
    return { ok: false, reason: status };
  }

  const submission = sourceRoutingHelpers.selectSubmissionForPayload(payload, sourceConfig);
  if (!submission.allowed) {
    const source = payload?.sourceChannelId || payload?.sourceUrl || "unknown source";
    await setStatus(`ignored non-source channel: ${source}`);
    return { ok: true, ignored: true, reason: "ignored non-source channel" };
  }

  const freshness = freshnessHelpers.payloadFreshness(payload, { maxAgeMinutes: maxMessageAgeMinutes });
  if (!freshness.fresh) {
    await setStatus(`ignored stale message: ${freshness.reason}`);
    return { ok: true, ignored: true, reason: freshness.reason, freshness };
  }

  const result = await helperFetch("/events", {
    method: "POST",
    body: submission.body
  });
  const createdCount = Array.isArray(result?.createdJobs) ? result.createdJobs.length : 0;
  if (submission.mode === "listen-only" && result?.capturedOnly !== true) {
    throw new Error("Helper must be restarted or updated to support listen-only capture");
  }
  await setStatus(
    result?.skippedDuplicate ? "event skipped duplicate" : result?.capturedOnly
      ? "captured locally (listen only, no repost)"
      : `event submitted (${createdCount} jobs, ${submission.mode})`
  );
  return { ok: true, result };
}

async function pollHelper() {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    const { enabled = true, helperToken = "" } = await chrome.storage.local.get(["enabled", "helperToken"]);
    if (!enabled) {
      await setStatus("disabled");
      return;
    }

    if (!normalizeToken(helperToken)) {
      await setStatus("missing helper token");
      return;
    }

    await ensureNativeHelper(helperToken);

    const response = await helperFetch(`/jobs/next?clientId=${encodeURIComponent(clientId)}`);
    const job = normalizeJob(response);
    if (!job) {
      await setStatus("idle");
      return;
    }

    await processJob(job);
  } catch (error) {
    await setStatus(`helper error: ${readableError(error)}`);
  } finally {
    pollInFlight = false;
  }
}

async function ensurePollAlarm() {
  const existing = await chrome.alarms.get(pollAlarmName);
  if (existing?.periodInMinutes === pollAlarmPeriodMinutes) {
    return;
  }

  await chrome.alarms.create(pollAlarmName, {
    delayInMinutes: pollAlarmPeriodMinutes,
    periodInMinutes: pollAlarmPeriodMinutes
  });
}

async function ensureNativeHelper(knownToken = "", options = {}) {
  const { enabled = true, helperToken = knownToken || "" } = await chrome.storage.local.get(["enabled", "helperToken"]);
  const token = normalizeToken(knownToken || helperToken);
  if (!enabled || !token) {
    return null;
  }

  if (nativeHelperEnsurePromise) {
    return nativeHelperEnsurePromise;
  }

  nativeHelperEnsurePromise = ensureNativeHelperOnce(token, options).finally(() => {
    nativeHelperEnsurePromise = null;
  });
  return nativeHelperEnsurePromise;
}

async function ensureNativeHelperOnce(token, options = {}) {
  try {
    nativeShutdownRequested = false;
    const helperTimeoutMs = Number.isFinite(options.helperTimeoutMs) ? options.helperTimeoutMs : 30_000;
    const nativeTimeoutMs = Number.isFinite(options.nativeTimeoutMs) ? options.nativeTimeoutMs : 45_000;
    const result = await nativeRequest("ensure-helper", {
      helperToken: token,
      port: 17654,
      timeoutMs: helperTimeoutMs
    }, nativeTimeoutMs);
    await setLauncherStatus(result?.started ? "helper started" : result?.adopted ? "helper adopted" : "helper running", "ok");
    return result;
  } catch (error) {
    await setLauncherStatus(`launcher unavailable: ${readableError(error)}`, "warn");
    return null;
  }
}

async function launchHelper(message = {}) {
  const token = normalizeToken(message.helperToken || "");
  if (!token) {
    await setStatus("missing helper token");
    await setLauncherStatus("missing helper token", "warn");
    return { ok: false, reason: "missing helper token" };
  }

  await chrome.storage.local.set({
    enabled: true,
    helperToken: token,
    lastStatus: "launch requested",
    lastStatusAt: new Date().toISOString()
  });
  await ensurePollAlarm();

  const nativeResult = await ensureNativeHelper(token, {
    helperTimeoutMs: 30_000,
    nativeTimeoutMs: 45_000
  });
  if (!nativeResult) {
    await setStatus("launch failed");
    return { ok: false, reason: "native launcher unavailable" };
  }

  await setStatus("launch complete");
  void pollHelper();
  return { ok: true, nativeResult };
}

function connectNativeHost() {
  if (nativePort) {
    return nativePort;
  }
  if (!chrome.runtime.connectNative) {
    throw new Error("native messaging is unavailable");
  }

  const port = chrome.runtime.connectNative(nativeHostName);
  nativePort = port;
  port.onMessage.addListener((message) => {
    const pending = pendingNativeRequests.get(message?.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingNativeRequests.delete(message.requestId);
    if (message?.ok === false) {
      pending.reject(new Error(message.error || "native host request failed"));
    } else {
      pending.resolve(message);
    }
  });
  port.onDisconnect.addListener(() => {
    const lastError = chrome.runtime.lastError?.message || "native host disconnected";
    nativePort = null;
    for (const pending of pendingNativeRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(lastError));
    }
    pendingNativeRequests.clear();
    if (!nativeShutdownRequested) {
      void setLauncherStatus(lastError, "warn");
    }
  });
  return port;
}

function nativeRequest(type, body = {}, timeoutMs = 5000) {
  const requestId = `${Date.now()}-${++nativeRequestId}`;
  const port = connectNativeHost();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNativeRequests.delete(requestId);
      reject(new Error(`native host request timed out: ${type}`));
    }, timeoutMs);
    pendingNativeRequests.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({ requestId, type, ...body });
    } catch (error) {
      clearTimeout(timer);
      pendingNativeRequests.delete(requestId);
      reject(error);
    }
  });
}

async function shutdownAll() {
  await chrome.storage.local.set({
    enabled: false,
    lastStatus: "shutdown requested",
    lastStatusAt: new Date().toISOString()
  });
  await chrome.alarms.clear(pollAlarmName);

  const state = await chrome.storage.local.get([
    destinationWindowKeys.closePostWindowsOnShutdown,
    destinationWindowKeys.managedDestinationWindowId,
    destinationWindowKeys.managedDestinationTabIds
  ]);
  const windowState = destinationWindowHelpers.normalizeDedicatedWindowState(state);
  if (windowState.closePostWindowsOnShutdown) {
    await closeManagedDestinationSurfaces(windowState);
  }

  let nativeResult = null;
  try {
    nativeShutdownRequested = true;
    nativeResult = await nativeRequest("shutdown", { reason: "popup shutdown" }, 10_000);
    await setLauncherStatus("shutdown", "ok");
  } catch (error) {
    await setLauncherStatus(`shutdown incomplete: ${readableError(error)}`, "warn");
  }
  await setStatus("shutdown complete");
  return { ok: true, nativeResult };
}

async function processJob(job) {
  let sendResult;
  try {
    await assertRepostAllowed(job);
    const tab = await openOrReuseDestinationTab(job.destinationUrl);
    await waitForTabComplete(tab.id);
    await ensureContentScript(tab.id);
    sendResult = await postJobWithTrustedInput(tab.id, job);
  } catch (error) {
    await reportFailure(job, readableError(error));
    return;
  }

  if (!sendResult?.ok) {
    await reportFailure(job, sendResult?.reason || "content script did not confirm send");
    return;
  }

  try {
    await reportJobResult(job.id, {
      status: "sent",
      clientId,
      degradation: Array.isArray(sendResult.degradation) ? sendResult.degradation : []
    });
    await setStatus(`sent ${job.id}`);
  } catch (error) {
    await setStatus(`sent ${job.id}; result report failed: ${readableError(error)}`);
  }
}

async function postJobWithTrustedInput(tabId, job) {
  const prepareResult = await chrome.tabs.sendMessage(tabId, { type: "prepare-composer", job });
  if (!prepareResult?.ok) {
    return prepareResult;
  }

  await assertRepostAllowed(job);
  await typeRepostWithDebugger(tabId, job.messageText);

  const draftResult = await chrome.tabs.sendMessage(tabId, {
    type: "verify-composer-draft",
    expectedText: job.messageText
  });
  if (!draftResult?.ok) {
    return draftResult;
  }

  await assertRepostAllowed(job);
  await pressEnterWithDebugger(tabId);

  return chrome.tabs.sendMessage(tabId, {
    type: "confirm-posted",
    job,
    beforeMessageKeys: Array.isArray(prepareResult.beforeMessageKeys) ? prepareResult.beforeMessageKeys : []
  });
}

async function assertRepostAllowed(job) {
  const state = await chrome.storage.local.get({ [listenOnlyStorageKey]: [] });
  if (sourceRoutingHelpers.isListenOnlyPayload(job.payload || job, state[listenOnlyStorageKey])) {
    throw new Error("source is listen-only; repost suppressed");
  }
}

async function typeRepostWithDebugger(tabId, text) {
  await withDebugger(tabId, async (target) => {
    await dispatchControlA(target);
    await dispatchKey(target, {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8
    });
    await dispatchKey(target, {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8
    });
    await chrome.debugger.sendCommand(target, "Input.insertText", { text });
  });
  await delay(150);
}

async function pressEnterWithDebugger(tabId) {
  await withDebugger(tabId, async (target) => {
    await dispatchKey(target, {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13
    });
    await dispatchKey(target, {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13
    });
  });
}

async function dispatchControlA(target) {
  await dispatchKey(target, {
    type: "rawKeyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    modifiers: 2
  });
  await dispatchKey(target, {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2
  });
  await dispatchKey(target, {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2
  });
  await dispatchKey(target, {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17
  });
}

async function dispatchKey(target, options) {
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    nativeVirtualKeyCode: options.windowsVirtualKeyCode,
    ...options
  });
}

async function withDebugger(tabId, callback) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    return await callback(target);
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      // The tab can close or detach after the send attempt; the job result still reports the original error.
    }
  }
}

async function reportFailure(job, reason) {
  try {
    await reportJobResult(job.id, {
      status: "failed",
      clientId,
      reason
    });
    await setStatus(`failed ${job.id}: ${reason}`);
  } catch (error) {
    await setStatus(`failed ${job.id}; result report failed: ${readableError(error)}`);
  }
}

function openOrReuseDestinationTab(destinationUrl) {
  const normalizedDestination = destinationWindowHelpers.normalizeDiscordChannelUrl(destinationUrl);
  if (!normalizedDestination) {
    throw new Error("Job destinationUrl must be a Discord channel URL");
  }

  const existingPromise = destinationTabOpenPromises.get(normalizedDestination.url);
  if (existingPromise) {
    return existingPromise;
  }

  const openPromise = openOrReuseDestinationTabOnce(normalizedDestination).finally(() => {
    if (destinationTabOpenPromises.get(normalizedDestination.url) === openPromise) {
      destinationTabOpenPromises.delete(normalizedDestination.url);
    }
  });
  destinationTabOpenPromises.set(normalizedDestination.url, openPromise);
  return openPromise;
}

async function openOrReuseDestinationTabOnce(normalizedDestination) {
  const tabs = await chrome.tabs.query({ url: "https://discord.com/channels/*" });
  const existing = destinationWindowHelpers.findDiscordChannelTab(tabs, normalizedDestination.url);
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    return chrome.tabs.get(existing.id);
  }

  const state = await chrome.storage.local.get([
    postStorageKey,
    destinationWindowKeys.dedicatedPostWindowEnabled,
    destinationWindowKeys.dedicatedPostWindowMinimized,
    destinationWindowKeys.closePostWindowsOnShutdown,
    destinationWindowKeys.managedDestinationWindowId,
    destinationWindowKeys.managedDestinationTabIds
  ]);
  const windowState = destinationWindowHelpers.normalizeDedicatedWindowState(state);
  if (windowState.dedicatedPostWindowEnabled) {
    return openOrReuseDedicatedDestinationTab(normalizedDestination.url, windowState, { minimizeOnCreate: false });
  }

  const tab = await chrome.tabs.create({ url: normalizedDestination.url, active: true });
  await trackManagedDestinationSurface({ tabIds: [tab.id] });
  return tab;
}

async function openDedicatedPostWindowFromPopup(message = {}) {
  const state = await chrome.storage.local.get([
    listenStorageKey,
    listenOnlyStorageKey,
    postStorageKey,
    destinationWindowKeys.dedicatedPostWindowEnabled,
    destinationWindowKeys.dedicatedPostWindowMinimized,
    destinationWindowKeys.closePostWindowsOnShutdown,
    destinationWindowKeys.managedDestinationWindowId,
    destinationWindowKeys.managedDestinationTabIds
  ]);
  const workspaceUrls = destinationWindowHelpers.chooseWorkspaceUrls({
    listenChannelUrls: state[listenStorageKey],
    listenOnlyChannelUrls: state[listenOnlyStorageKey],
    postChannelUrls: state[postStorageKey],
    fallbackUrl: message.requestedPostUrl || ""
  });
  const windowState = {
    ...destinationWindowHelpers.normalizeDedicatedWindowState(state),
    dedicatedPostWindowEnabled: true
  };
  await chrome.storage.local.set({
    [destinationWindowKeys.dedicatedPostWindowEnabled]: true
  });
  const tabs = [];
  for (const url of workspaceUrls) {
    tabs.push(await openOrReuseDedicatedDestinationTab(url, windowState, { minimizeOnCreate: true }));
  }
  await setStatus(`opened post workspace (${workspaceUrls.length} tabs)`);
  return { ok: true, tabIds: tabs.map((tab) => tab.id).filter(Boolean), urls: workspaceUrls, url: workspaceUrls.at(-1) };
}

async function openOrReuseDedicatedDestinationTab(destinationUrl, windowState, { minimizeOnCreate = false } = {}) {
  const normalized = destinationWindowHelpers.normalizeDiscordChannelUrl(destinationUrl);
  if (!normalized) {
    throw new Error("Job destinationUrl must be a Discord channel URL");
  }

  const storedWindow = await getManagedDestinationWindow(windowState.managedDestinationWindowId);
  if (storedWindow) {
    const existing = destinationWindowHelpers.findDiscordChannelTab(storedWindow.tabs || [], normalized.url);
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { active: true });
      await trackManagedDestinationSurface({ windowId: storedWindow.id, tabIds: [existing.id] });
      return chrome.tabs.get(existing.id);
    }

    const tab = await chrome.tabs.create({
      windowId: storedWindow.id,
      url: normalized.url,
      active: true
    });
    await trackManagedDestinationSurface({ windowId: storedWindow.id, tabIds: [tab.id] });
    return tab;
  }

  const createdWindow = await createManagedDestinationWindow(normalized.url);
  if (!createdWindow?.id) {
    throw new Error("Dedicated post window opened without a Chrome window id");
  }
  windowState.managedDestinationWindowId = createdWindow.id;
  if (minimizeOnCreate) {
    await maybeMinimizeManagedWindow(createdWindow.id, windowState);
  }
  const tab = createdWindow.tabs?.[0] || (await chrome.tabs.query({ windowId: createdWindow.id })).at(0);
  if (!tab?.id) {
    throw new Error("Dedicated post window opened without a Discord tab");
  }
  windowState.managedDestinationTabIds = addManagedTabId(windowState.managedDestinationTabIds, tab.id);
  await trackManagedDestinationSurface({ windowId: createdWindow.id, tabIds: [tab.id] });
  return tab;
}

function addManagedTabId(tabIds, tabId) {
  const normalizedIds = destinationWindowHelpers.normalizeDedicatedWindowState({
    managedDestinationTabIds: tabIds
  }).managedDestinationTabIds;
  return normalizedIds.includes(tabId) ? normalizedIds : [...normalizedIds, tabId];
}

async function createManagedDestinationWindow(url) {
  try {
    return await chrome.windows.create({
      url,
      type: "normal",
      focused: false
    });
  } catch {
    return chrome.windows.create({
      url,
      type: "normal"
    });
  }
}

async function getManagedDestinationWindow(windowId) {
  if (!windowId) {
    return null;
  }
  try {
    return await chrome.windows.get(windowId, { populate: true });
  } catch {
    await chrome.storage.local.set({
      [destinationWindowKeys.managedDestinationWindowId]: null
    });
    return null;
  }
}

async function maybeMinimizeManagedWindow(windowId, windowState) {
  if (!windowState.dedicatedPostWindowMinimized) {
    return;
  }
  try {
    await chrome.windows.update(windowId, { state: "minimized", focused: false });
  } catch {
    await chrome.windows.update(windowId, { state: "minimized" });
  }
}

async function trackManagedDestinationSurface({ windowId = null, tabIds = [] } = {}) {
  const state = await chrome.storage.local.get([
    destinationWindowKeys.managedDestinationWindowId,
    destinationWindowKeys.managedDestinationTabIds
  ]);
  const current = destinationWindowHelpers.normalizeDedicatedWindowState(state);
  const nextTabIds = Array.from(new Set([
    ...current.managedDestinationTabIds,
    ...tabIds.filter((tabId) => Number.isInteger(tabId) && tabId > 0)
  ]));
  await chrome.storage.local.set({
    [destinationWindowKeys.managedDestinationWindowId]: windowId || current.managedDestinationWindowId,
    [destinationWindowKeys.managedDestinationTabIds]: nextTabIds
  });
}

async function closeManagedDestinationSurfaces(windowState) {
  const tabIdsToRemove = new Set(windowState.managedDestinationTabIds);
  if (windowState.managedDestinationWindowId) {
    try {
      const managedWindow = await chrome.windows.get(windowState.managedDestinationWindowId, { populate: true });
      for (const tab of managedWindow.tabs || []) {
        if (tab.id) {
          tabIdsToRemove.delete(tab.id);
        }
      }
      await chrome.windows.remove(windowState.managedDestinationWindowId);
    } catch {
      // Already closed or inaccessible.
    }
  }

  for (const tabId of tabIdsToRemove) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Already closed or not owned by this run.
    }
  }

  await chrome.storage.local.set({
    [destinationWindowKeys.managedDestinationWindowId]: null,
    [destinationWindowKeys.managedDestinationTabIds]: []
  });
}

async function ensureContentScript(tabId) {
  const result = await ensureCombinedContentScript(tabId);
  if (!result.ok) {
    throw new Error(result.error || "Discord content script is unavailable");
  }
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "copy-repost:ping" });
    return response?.ok === true && response.version === contentScriptVersion;
  } catch {
    return false;
  }
}

async function waitForTabComplete(tabId) {
  const deadline = Date.now() + discordTabLoadTimeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return;
    }
    await delay(250);
  }
  throw new Error("Discord tab did not finish loading");
}

async function reportJobResult(jobId, body) {
  return helperFetch(`/jobs/${encodeURIComponent(jobId)}/result`, {
    method: "POST",
    body
  });
}

async function getEnabledSourceConfig() {
  const {
    helperToken = "",
    listenChannelUrls = [],
    listenOnlyChannelUrls = [],
    postChannelUrls = []
  } = await chrome.storage.local.get(["helperToken", listenStorageKey, listenOnlyStorageKey, postStorageKey]);
  const token = normalizeToken(helperToken);
  const listenUrls = routeHelpers.normalizeUrlList(listenChannelUrls);
  const postUrls = routeHelpers.normalizeUrlList(postChannelUrls);
  const listenOnlyUrls = routeHelpers.normalizeUrlList(listenOnlyChannelUrls);
  const usesPopupRoutes = routeHelpers.hasStoredRoutes(listenUrls, postUrls) || listenOnlyUrls.length > 0;
  const cacheKey = usesPopupRoutes
    ? `${token}|popup|${listenUrls.join(",")}|${postUrls.join(",")}|${listenOnlyUrls.join(",")}`
    : `${token}|helper-config`;
  const now = Date.now();
  if (sourceConfigCache && sourceConfigCache.cacheKey === cacheKey && sourceConfigCache.expiresAt > now) {
    return sourceConfigCache;
  }

  const helperConfig = await helperFetch("/config");
  let runtimeMappings = [];
  if (listenUrls.length > 0 && postUrls.length > 0) {
    runtimeMappings = routeHelpers.buildRuntimeConfig({
      listenChannelUrls: listenUrls,
      postChannelUrls: postUrls
    }).mappings;
  }

  sourceConfigCache = {
    token,
    cacheKey,
    expiresAt: now + configCacheTtlMs,
    ...sourceRoutingHelpers.buildSourceConfig({
      helperConfig,
      runtimeMappings,
      listenOnlyChannelUrls: listenOnlyUrls
    })
  };
  return sourceConfigCache;
}

async function helperFetch(path, options = {}) {
  const { helperToken = "" } = await chrome.storage.local.get("helperToken");
  const token = normalizeToken(helperToken);
  if (!token) {
    await setStatus("missing helper token");
    throw new Error("missing helper token");
  }

  const headers = {
    "x-helper-token": token
  };

  const request = {
    method: options.method || "GET",
    headers
  };

  if (Object.hasOwn(options, "body")) {
    headers["content-type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${helperBaseUrl}${path}`, request);
  const responseBody = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(helperError(response, responseBody));
  }

  return responseBody;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function helperError(response, responseBody) {
  const message = responseBody?.error?.message || responseBody?.error?.code || response.statusText || "helper request failed";
  return `${response.status} ${message}`;
}

function normalizeJob(response) {
  if (!response || response.job === null) {
    return null;
  }
  if (response.job && response.job.id) {
    return response.job;
  }
  if (response.id) {
    return response;
  }
  return null;
}

function normalizeToken(token) {
  return typeof token === "string" ? token.trim() : "";
}

async function setStatus(lastStatus) {
  await chrome.storage.local.set({
    lastStatus,
    lastStatusAt: new Date().toISOString()
  });
}

async function setLauncherStatus(launcherStatus, state = "") {
  await chrome.storage.local.set({
    [launcherStatusStorageKey]: launcherStatus,
    launcherStatusState: state,
    launcherStatusAt: new Date().toISOString()
  });
}

async function ensureTradingBridgeAlarms() {
  await chrome.alarms.create(tradingBridgeHeartbeatAlarmName, { periodInMinutes: 1 });
  await chrome.alarms.create(tradingBridgeSupervisorAlarmName, { periodInMinutes: 1 });
}

async function publishTradingBridgeHeartbeat(status = "ok", details = {}) {
  try {
    const settings = await getTradingBridgeSettings();
    const payload = {
      status,
      bridge_enabled: Boolean(settings.enabled),
      url: "chrome-extension://sentinel-link-service-worker",
      channel_id: "sentinel-link-service-worker",
      channel_name: "Sentinel Link",
      observed_at: new Date().toISOString(),
      last_forward_at: settings.lastForwardAt || "",
      last_forward_status: settings.lastForwardStatus || "",
      details: {
        source: "sentinel_link_service_worker",
        targets: enabledBridgeTargets(settings).map((target) => ({
          id: target.id,
          name: target.name,
          messageUrl: target.messageUrl
        })),
        ...details
      }
    };
    return await forwardTradingBridgeHeartbeat(payload);
  } catch (error) {
    await scheduleTradingBridgeRetry(`heartbeat failed: ${readableError(error)}`);
    await chrome.storage.local.set({
      lastHeartbeatStatus: readableError(error),
      lastHeartbeatAt: new Date().toISOString()
    });
    return null;
  }
}

async function superviseTradingBridgeTabs(reason = "supervisor") {
  const settings = await getTradingBridgeSettings();
  if (!settings.enabled || !settings.autoRestartEnabled) {
    await publishTradingBridgeHeartbeat("disabled", { reason, supervisor: "disabled" });
    return;
  }

  try {
    const tabs = await queryTradingBridgeDiscordTabs();
    const matchingTabs = tabs.filter((tab) => targetsForDiscordChannel(settings, tab.url || "").length > 0);
    if (matchingTabs.length === 0) {
      const status = tabs.length === 0 ? "no_discord_tabs" : "no_matching_discord_tabs";
      await publishTradingBridgeHeartbeat(status, {
        reason,
        discord_tabs: tabs.length,
        configured_targets: enabledBridgeTargets(settings).length
      });
      await scheduleTradingBridgeRetry(tabs.length === 0 ? "no Discord tabs are open" : "no matching Discord channel tabs are open");
      return;
    }

    const results = [];
    for (const tab of matchingTabs) {
      results.push(await ensureCombinedContentScript(tab.id));
    }

    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      await publishTradingBridgeHeartbeat("restart_error", {
        reason,
        failures: failures.map((failure) => failure.error).slice(0, 5)
      });
      await scheduleTradingBridgeRetry(failures[0].error || "content script restart failed");
      return;
    }

    await resetTradingBridgeBackoff("content script healthy");
    await publishTradingBridgeHeartbeat("ok", {
      reason,
      supervised_tabs: results.length,
      restarted_tabs: results.filter((result) => result.restarted).length,
      unverified_tabs: results.filter((result) => result.verified === false).length
    });
  } catch (error) {
    await publishTradingBridgeHeartbeat("restart_error", { reason, error: readableError(error) });
    await scheduleTradingBridgeRetry(readableError(error));
  }
}

function ensureCombinedContentScript(tabId) {
  const existingPromise = contentScriptEnsurePromises.get(tabId);
  if (existingPromise) {
    return existingPromise;
  }

  const ensurePromise = ensureCombinedContentScriptOnce(tabId).finally(() => {
    if (contentScriptEnsurePromises.get(tabId) === ensurePromise) {
      contentScriptEnsurePromises.delete(tabId);
    }
  });
  contentScriptEnsurePromises.set(tabId, ensurePromise);
  return ensurePromise;
}

async function ensureCombinedContentScriptOnce(tabId) {
  try {
    if (await pingContentScript(tabId)) {
      return { ok: true, restarted: false };
    }
  } catch {
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/parser.js", "src/trading-bridge-config.js", "src/content.js"]
    });
  } catch (error) {
    return { ok: false, restarted: false, error: readableError(error) };
  }

  try {
    const ready = await pingContentScript(tabId);
    return {
      ok: true,
      restarted: true,
      verified: ready,
      warning: ready ? "" : "content script injection succeeded but ping was not acknowledged"
    };
  } catch (error) {
    return { ok: false, restarted: true, error: readableError(error) };
  }
}

function queryTradingBridgeDiscordTabs() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: tradingBridgeDiscordTabUrls }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve((tabs || []).filter((tab) => typeof tab.id === "number"));
    });
  });
}

async function forwardTradingBridgeHeartbeat(payload) {
  return forwardTradingBridgePayload(payload, "heartbeat");
}

async function forwardTradingBridgeMessage(payload) {
  const settings = await getTradingBridgeSettings();
  if (!settings.enabled) {
    return { status: "disabled" };
  }
  const {
    maxMessageAgeMinutes = freshnessHelpers.defaultFreshnessWindowMinutes
  } = await chrome.storage.local.get([maxMessageAgeMinutesStorageKey]);
  const normalizedPayload = {
    ...payload,
    timestampIso: payload?.timestampIso || ""
  };
  const freshness = freshnessHelpers.payloadFreshness(normalizedPayload, { maxAgeMinutes: maxMessageAgeMinutes });
  if (!freshness.fresh) {
    await chrome.storage.local.set({
      lastForwardStatus: `ignored stale bridge message: ${freshness.reason}`,
      lastForwardAt: new Date().toISOString()
    });
    return { status: "skipped", skip_reason: "ignored stale bridge message", freshness };
  }
  return forwardTradingBridgePayload(payload, "message");
}

async function forwardTradingBridgePayload(payload, kind) {
  const settings = await getTradingBridgeSettings();
  const targets = tradingBridgeTargetsForPayload(settings, payload);
  if (targets.length === 0) {
    const key = kind === "heartbeat" ? "lastHeartbeatStatus" : "lastForwardStatus";
    const atKey = kind === "heartbeat" ? "lastHeartbeatAt" : "lastForwardAt";
    await chrome.storage.local.set({
      [key]: "no_matching_target",
      [atKey]: new Date().toISOString()
    });
    return { status: "skipped", skip_reason: "no matching bridge target" };
  }

  const result = await forwardTradingBridgePayloadToTargets(targets, payload, kind);
  const updates = kind === "heartbeat"
    ? {
      lastHeartbeatStatus: result.status,
      lastHeartbeatAt: new Date().toISOString(),
      lastHeartbeatTargets: result.targets
    }
    : {
      lastForwardStatus: result.status,
      lastForwardAt: new Date().toISOString(),
      lastForwardEventId: payload.event_id,
      lastForwardTargets: result.targets
    };
  await chrome.storage.local.set(updates);
  return result;
}

async function forwardTradingBridgePayloadToTargets(targets, payload, kind) {
  const successes = [];
  const failures = [];
  for (const target of targets) {
    try {
      const body = await forwardTradingBridgePayloadToTarget(target, payload, kind);
      successes.push({
        id: target.id,
        name: target.name,
        status: body.status || (kind === "heartbeat" ? "healthy" : "accepted"),
        body
      });
    } catch (error) {
      failures.push({
        id: target.id,
        name: target.name,
        error: readableError(error)
      });
    }
  }

  if (successes.length === 0 && failures.length > 0) {
    throw new Error(failures.map((failure) => `${failure.name}: ${failure.error}`).join("; "));
  }

  return {
    status: failures.length > 0 ? "partial" : (kind === "heartbeat" ? "healthy" : "accepted"),
    targets: successes,
    failures
  };
}

async function forwardTradingBridgePayloadToTarget(target, payload, kind) {
  const headers = { "Content-Type": "application/json" };
  if (target.apiKey) {
    headers["X-API-Key"] = target.apiKey;
  }

  const primaryUrl = kind === "heartbeat" ? target.heartbeatUrl || heartbeatUrlFor(target.messageUrl) : target.messageUrl;
  const requestBody = JSON.stringify({
    ...payload,
    bridge_target_id: target.id,
    bridge_target_name: target.name
  });
  const urls = [primaryUrl, ...localSentinelEchoFallbackUrls(target, kind, primaryUrl)];
  const failures = [];

  for (const url of urls) {
    try {
      const body = await postTradingBridgeJson(url, headers, requestBody, kind);
      if (url !== primaryUrl && body && typeof body === "object" && !Array.isArray(body)) {
        body.bridge_fallback_url = url;
      }
      return body;
    } catch (error) {
      failures.push(`${url}: ${readableError(error)}`);
    }
  }

  throw new Error(failures.join("; ") || `${kind} request failed`);
}

async function postTradingBridgeJson(url, headers, requestBody, kind) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tradingBridgeFetchTimeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let responseBody = {};
  if (text) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = { text };
    }
  }

  if (!response.ok) {
    throw new Error(responseBody.detail || responseBody.text || `${kind} request failed with HTTP ${response.status}`);
  }

  return responseBody;
}

function tradingBridgeTargetsForPayload(settings, payload) {
  if (payload && canonicalDiscordChannelUrl(payload.url || "")) {
    return targetsForDiscordChannel(settings, payload.url, payload.channel_id);
  }
  return enabledBridgeTargets(settings);
}

async function getTradingBridgeSettings() {
  const settings = await chrome.storage.local.get(tradingBridgeDefaults);
  return { ...tradingBridgeDefaults, ...settings };
}

async function scheduleTradingBridgeRetry(reason) {
  const settings = await getTradingBridgeSettings();
  if (!settings.autoRestartEnabled) {
    return;
  }

  const attempt = Number(settings.bridgeRestartAttempt || 0);
  const delaySeconds = Math.min(300, 5 * Math.pow(2, attempt));
  const nextRestartAt = Date.now() + delaySeconds * 1000;
  await chrome.storage.local.set({
    bridgeRestartAttempt: attempt + 1,
    lastRestartStatus: String(reason || "restart scheduled"),
    lastRestartRetryAt: new Date().toISOString(),
    nextRestartAt: new Date(nextRestartAt).toISOString()
  });
  await chrome.alarms.create(tradingBridgeRestartRetryAlarmName, { when: nextRestartAt });
}

async function resetTradingBridgeBackoff(status) {
  await chrome.storage.local.set({
    bridgeRestartAttempt: 0,
    lastRestartStatus: status || "healthy",
    nextRestartAt: ""
  });
  await chrome.alarms.clear(tradingBridgeRestartRetryAlarmName);
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
