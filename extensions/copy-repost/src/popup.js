const helperBaseUrl = "http://127.0.0.1:17654";
const listenStorageKey = "listenChannelUrls";
const listenOnlyStorageKey = "listenOnlyChannelUrls";
const postStorageKey = "postChannelUrls";
const maxMessageAgeMinutesStorageKey = "maxMessageAgeMinutes";
const launcherStatusStorageKey = "launcherStatus";
const bridgeDefaults = {
  enabled: true,
  targetUrl: DEFAULT_MESSAGE_URL,
  heartbeatUrl: DEFAULT_HEARTBEAT_URL,
  apiKey: "",
  targets: [],
  forwardExistingOnEnable: false,
  autoRestartEnabled: true,
  lastForwardStatus: "",
  lastForwardAt: "",
  lastForwardEventId: "",
  lastForwardTargets: [],
  lastHeartbeatStatus: "",
  lastHeartbeatAt: "",
  lastHeartbeatTargets: [],
  lastRestartStatus: "",
  nextRestartAt: ""
};
const routes = globalThis.CopyRepostChannelRoutes;
const freshness = globalThis.CopyRepostFreshness;
const destinationWindow = globalThis.CopyRepostDestinationWindow;
const destinationWindowKeys = destinationWindow.keys;

const enabledInput = document.querySelector("#enabled");
const launchHelperButton = document.querySelector("#launch-helper");
const shutdownAllButton = document.querySelector("#shutdown-all");
const tokenInput = document.querySelector("#helper-token");
const showTokenInput = document.querySelector("#show-token");
const maxMessageAgeMinutesInput = document.querySelector("#max-message-age-minutes");
const dedicatedPostWindowEnabledInput = document.querySelector("#dedicated-post-window-enabled");
const dedicatedPostWindowMinimizedInput = document.querySelector("#dedicated-post-window-minimized");
const closePostWindowsOnShutdownInput = document.querySelector("#close-post-windows-on-shutdown");
const openDedicatedPostWindowButton = document.querySelector("#open-dedicated-post-window");
const lifecycleMessage = document.querySelector("#lifecycle-message");
const bridgeForwardExistingInput = document.querySelector("#bridge-forward-existing");
const bridgeAutoRestartInput = document.querySelector("#bridge-auto-restart");
const bridgeTargetUrlInput = document.querySelector("#bridge-target-url");
const bridgeHeartbeatUrlInput = document.querySelector("#bridge-heartbeat-url");
const bridgeApiKeyInput = document.querySelector("#bridge-api-key");
const bridgeShowApiKeyInput = document.querySelector("#bridge-show-api-key");
const bridgeTargetsJsonInput = document.querySelector("#bridge-targets-json");
const bridgeStatus = document.querySelector("#bridge-status");
const listenUrlInput = document.querySelector("#listen-url");
const listenLockButton = document.querySelector("#listen-lock");
const listenRevertButton = document.querySelector("#listen-revert");
const listenRevertAllButton = document.querySelector("#listen-revert-all");
const listenMessage = document.querySelector("#listen-message");
const listenSummary = document.querySelector("#listen-summary");
const listenStoredUrlsSelect = document.querySelector("#listen-stored-urls");
const listenOnlyUrlInput = document.querySelector("#listen-only-url");
const listenOnlyMessage = document.querySelector("#listen-only-message");
const listenOnlySummary = document.querySelector("#listen-only-summary");
const listenOnlyStoredUrlsSelect = document.querySelector("#listen-only-stored-urls");
const postUrlInput = document.querySelector("#post-url");
const postLockButton = document.querySelector("#post-lock");
const postRevertButton = document.querySelector("#post-revert");
const postMessage = document.querySelector("#post-message");
const postSummary = document.querySelector("#post-summary");
const postStoredUrlsSelect = document.querySelector("#post-stored-urls");
const launcherStatus = document.querySelector("#launcher-status");
const helperStatus = document.querySelector("#helper-status");
const lastStatus = document.querySelector("#last-status");
const saveButton = document.querySelector("#save");
const refreshButton = document.querySelector("#refresh");

saveButton.addEventListener("click", saveSettings);
refreshButton.addEventListener("click", loadState);
launchHelperButton.addEventListener("click", launchHelper);
shutdownAllButton.addEventListener("click", shutdownAll);
openDedicatedPostWindowButton.addEventListener("click", openDedicatedPostWindow);
dedicatedPostWindowEnabledInput.addEventListener("change", saveLifecycleSettings);
dedicatedPostWindowMinimizedInput.addEventListener("change", saveLifecycleSettings);
closePostWindowsOnShutdownInput.addEventListener("change", saveLifecycleSettings);
listenLockButton.addEventListener("click", lockListenUrl);
listenRevertButton.addEventListener("click", revertListenUrl);
listenRevertAllButton.addEventListener("click", revertAllListenUrls);
document.querySelector("#listen-only-lock").addEventListener("click", () => updateListenOnlyUrls("lock"));
document.querySelector("#listen-only-revert").addEventListener("click", () => updateListenOnlyUrls("revert"));
document.querySelector("#listen-only-revert-all").addEventListener("click", () => updateListenOnlyUrls("clear"));
postLockButton.addEventListener("click", lockPostUrl);
postRevertButton.addEventListener("click", revertPostUrl);
postUrlInput.addEventListener("input", () => {
  postUrlInput.classList.remove("locked");
});
showTokenInput.addEventListener("change", () => {
  tokenInput.type = showTokenInput.checked ? "text" : "password";
});
bridgeShowApiKeyInput.addEventListener("change", () => {
  bridgeApiKeyInput.type = bridgeShowApiKeyInput.checked ? "text" : "password";
});

void loadState();

async function loadState() {
  const state = await chrome.storage.local.get([
    "enabled",
    "helperToken",
    "lastStatus",
    "lastStatusAt",
    launcherStatusStorageKey,
    "launcherStatusState",
    "launcherStatusAt",
    maxMessageAgeMinutesStorageKey,
    listenStorageKey,
    listenOnlyStorageKey,
    postStorageKey,
    destinationWindowKeys.dedicatedPostWindowEnabled,
    destinationWindowKeys.dedicatedPostWindowMinimized,
    destinationWindowKeys.closePostWindowsOnShutdown,
    "targetUrl",
    "heartbeatUrl",
    "apiKey",
    "targets",
    "forwardExistingOnEnable",
    "autoRestartEnabled",
    "lastForwardStatus",
    "lastForwardAt",
    "lastForwardTargets",
    "lastHeartbeatStatus",
    "lastHeartbeatAt",
    "lastRestartStatus",
    "nextRestartAt"
  ]);
  enabledInput.checked = state.enabled !== false;
  tokenInput.value = typeof state.helperToken === "string" ? state.helperToken : "";
  maxMessageAgeMinutesInput.value = freshness.normalizeFreshnessWindowMinutes(
    state[maxMessageAgeMinutesStorageKey]
  );
  renderLifecycleState(state);
  renderBridgeState(state);
  renderChannelState(state);
  renderLauncherStatus(state);
  renderLastStatus(state);
  await checkHealth(tokenInput.value);
}

async function saveSettings() {
  const helperToken = tokenInput.value.trim();
  const maxMessageAgeMinutes = freshness.normalizeFreshnessWindowMinutes(maxMessageAgeMinutesInput.value);
  let bridgeSettings;
  try {
    bridgeSettings = currentBridgeSettings();
  } catch (error) {
    setMessage(bridgeStatus, readableError(error), "error");
    return;
  }
  await chrome.storage.local.set({
    enabled: enabledInput.checked,
    helperToken,
    maxMessageAgeMinutes,
    ...currentLifecycleSettings(),
    ...bridgeSettings,
    lastStatus: "settings saved",
    lastStatusAt: new Date().toISOString()
  });
  maxMessageAgeMinutesInput.value = maxMessageAgeMinutes;
  bridgeTargetsJsonInput.value = JSON.stringify(bridgeSettings.targets, null, 2);
  setMessage(bridgeStatus, bridgeSettings.apiKey ? "Echo bridge settings saved" : "Echo bridge saved; API key is empty", bridgeSettings.apiKey ? "ok" : "warn");
  renderLastStatus({
    lastStatus: "settings saved",
    lastStatusAt: new Date().toISOString()
  });
  await checkHealth(helperToken);
}

async function launchHelper() {
  launchHelperButton.disabled = true;
  try {
    const helperToken = tokenInput.value.trim();
    const maxMessageAgeMinutes = freshness.normalizeFreshnessWindowMinutes(maxMessageAgeMinutesInput.value);
    enabledInput.checked = true;
    await chrome.storage.local.set({
      enabled: true,
      helperToken,
      maxMessageAgeMinutes,
      ...currentLifecycleSettings(),
      ...currentBridgeSettings(),
      lastStatus: "launch requested",
      lastStatusAt: new Date().toISOString()
    });
    maxMessageAgeMinutesInput.value = maxMessageAgeMinutes;

    const response = await sendRuntimeMessage({
      type: "launch-helper",
      helperToken
    }, 50_000);
    setMessage(
      lifecycleMessage,
      response?.ok ? "Launch complete" : response?.reason || "Launch failed",
      response?.ok ? "ok" : "error"
    );
    await loadState();
  } catch (error) {
    const message = `launch failed: ${readableError(error)}`;
    await chrome.storage.local.set({
      lastStatus: message,
      lastStatusAt: new Date().toISOString()
    });
    renderLastStatus({
      lastStatus: message,
      lastStatusAt: new Date().toISOString()
    });
    setMessage(lifecycleMessage, message, "error");
  } finally {
    launchHelperButton.disabled = false;
  }
}

function sendRuntimeMessage(message, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      reject(new Error(`runtime message timed out: ${message?.type || "unknown"}`));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function saveLifecycleSettings() {
  await chrome.storage.local.set({
    ...currentLifecycleSettings(),
    lastStatus: "lifecycle settings saved",
    lastStatusAt: new Date().toISOString()
  });
  setMessage(lifecycleMessage, "Lifecycle settings saved", "ok");
}

function currentLifecycleSettings() {
  return {
    [destinationWindowKeys.dedicatedPostWindowEnabled]: dedicatedPostWindowEnabledInput.checked,
    [destinationWindowKeys.dedicatedPostWindowMinimized]: dedicatedPostWindowMinimizedInput.checked,
    [destinationWindowKeys.closePostWindowsOnShutdown]: closePostWindowsOnShutdownInput.checked
  };
}

async function shutdownAll() {
  shutdownAllButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "shutdown-all" });
    enabledInput.checked = false;
    setMessage(lifecycleMessage, response?.ok ? "Shutdown complete" : response?.reason || "Shutdown failed", response?.ok ? "ok" : "error");
    await loadState();
  } catch (error) {
    setMessage(lifecycleMessage, readableError(error), "error");
  } finally {
    shutdownAllButton.disabled = false;
  }
}

async function openDedicatedPostWindow() {
  await saveLifecycleSettings();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "open-dedicated-post-window",
      requestedPostUrl: postUrlInput.value
    });
    setMessage(
      lifecycleMessage,
      response?.ok
        ? `Opened ${(response.urls || [response.url]).filter(Boolean).length} channel tab(s)`
        : response?.reason || "Open failed",
      response?.ok ? "ok" : "error"
    );
    await loadState();
  } catch (error) {
    setMessage(lifecycleMessage, readableError(error), "error");
  }
}

async function lockListenUrl() {
  try {
    const state = await chrome.storage.local.get(listenStorageKey);
    const currentUrls = routes.normalizeUrlList(state[listenStorageKey]);
    const result = routes.addChannelUrl(currentUrls, listenUrlInput.value);
    await chrome.storage.local.set({
      [listenStorageKey]: result.urls,
      lastStatus: "listen channel locked",
      lastStatusAt: new Date().toISOString()
    });
    listenUrlInput.value = "";
    await renderStoredChannels();
    setMessage(listenMessage, `Locked ${shortUrl(result.addedUrl)}`, "ok");
  } catch (error) {
    setMessage(listenMessage, readableError(error), "error");
  }
}

async function revertListenUrl() {
  const state = await chrome.storage.local.get(listenStorageKey);
  const result = routes.revertLastChannelUrl(state[listenStorageKey]);
  await chrome.storage.local.set({
    [listenStorageKey]: result.urls,
    lastStatus: result.removedUrl ? "listen channel reverted" : "no listen channel to revert",
    lastStatusAt: new Date().toISOString()
  });
  listenUrlInput.value = result.removedUrl;
  await renderStoredChannels();
  setMessage(
    listenMessage,
    result.removedUrl ? `Removed ${shortUrl(result.removedUrl)}` : "No listen URLs stored",
    result.removedUrl ? "warn" : "error"
  );
}

async function revertAllListenUrls() {
  await chrome.storage.local.set({
    [listenStorageKey]: routes.clearChannelUrls(),
    lastStatus: "listen channels cleared",
    lastStatusAt: new Date().toISOString()
  });
  listenUrlInput.value = "";
  await renderStoredChannels();
  setMessage(listenMessage, "Cleared listen URLs", "warn");
}

async function updateListenOnlyUrls(action) {
  try {
    const state = await chrome.storage.local.get(listenOnlyStorageKey);
    const current = routes.normalizeUrlList(state[listenOnlyStorageKey]);
    let result;
    if (action === "lock") {
      result = routes.addChannelUrl(current, listenOnlyUrlInput.value);
    } else if (action === "revert") {
      result = routes.revertLastChannelUrl(current);
    } else {
      result = { urls: routes.clearChannelUrls() };
    }
    await chrome.storage.local.set({
      [listenOnlyStorageKey]: result.urls,
      lastStatus: `listen-only channels ${action === "lock" ? "locked" : action === "revert" ? "reverted" : "cleared"}`,
      lastStatusAt: new Date().toISOString()
    });
    listenOnlyUrlInput.value = result.removedUrl || "";
    await renderStoredChannels();
    setMessage(listenOnlyMessage, action === "lock" ? `Locked ${shortUrl(result.addedUrl)} (Echo bridge, no repost)`
      : result.removedUrl ? `Removed ${shortUrl(result.removedUrl)}` : "No listen-only URLs stored", "ok");
  } catch (error) {
    setMessage(listenOnlyMessage, readableError(error), "error");
  }
}

async function lockPostUrl() {
  try {
    const state = await chrome.storage.local.get(postStorageKey);
    const currentUrls = routes.normalizeUrlList(state[postStorageKey]);
    const result = routes.addChannelUrl(currentUrls, postUrlInput.value);
    await chrome.storage.local.set({
      [postStorageKey]: result.urls,
      lastStatus: "post channel locked",
      lastStatusAt: new Date().toISOString()
    });
    postUrlInput.value = result.addedUrl;
    postUrlInput.classList.add("locked");
    await renderStoredChannels();
    setMessage(postMessage, `Locked ${shortUrl(result.addedUrl)}`, "ok");
  } catch (error) {
    setMessage(postMessage, readableError(error), "error");
  }
}

async function revertPostUrl() {
  const state = await chrome.storage.local.get(postStorageKey);
  const result = routes.revertLastChannelUrl(state[postStorageKey]);
  await chrome.storage.local.set({
    [postStorageKey]: result.urls,
    lastStatus: result.removedUrl ? "post channel reverted" : "no post channel to revert",
    lastStatusAt: new Date().toISOString()
  });
  const previousUrl = result.urls.at(-1) || "";
  postUrlInput.value = previousUrl;
  postUrlInput.classList.toggle("locked", Boolean(previousUrl));
  await renderStoredChannels();
  setMessage(
    postMessage,
    result.removedUrl ? `Removed ${shortUrl(result.removedUrl)}` : "No post URLs stored",
    result.removedUrl ? "warn" : "error"
  );
}

async function renderStoredChannels() {
  const state = await chrome.storage.local.get([listenStorageKey, listenOnlyStorageKey, postStorageKey, "lastStatus", "lastStatusAt"]);
  renderChannelState(state);
  renderLastStatus(state);
}

function renderChannelState(state) {
  const listenUrls = routes.normalizeUrlList(state[listenStorageKey]);
  const listenOnlyUrls = routes.normalizeUrlList(state[listenOnlyStorageKey]);
  const postUrls = routes.normalizeUrlList(state[postStorageKey]);
  listenSummary.textContent = summarizeUrls(listenUrls, "listen URL");
  listenOnlySummary.textContent = summarizeUrls(listenOnlyUrls, "listen-only URL");
  postSummary.textContent = summarizeUrls(postUrls, "post URL");
  renderUrlOptions(listenStoredUrlsSelect, routes.toStoredUrlOptions(listenUrls, "No listen URLs locked"));
  renderUrlOptions(listenOnlyStoredUrlsSelect, routes.toStoredUrlOptions(listenOnlyUrls, "No listen-only URLs locked"));
  renderUrlOptions(postStoredUrlsSelect, routes.toStoredUrlOptions(postUrls, "No post URLs locked"));
  if (!postUrlInput.value && postUrls.length > 0) {
    postUrlInput.value = postUrls.at(-1);
    postUrlInput.classList.add("locked");
  }
}

function renderLifecycleState(state) {
  const normalized = destinationWindow.normalizeDedicatedWindowState(state);
  dedicatedPostWindowEnabledInput.checked = normalized.dedicatedPostWindowEnabled;
  dedicatedPostWindowMinimizedInput.checked = normalized.dedicatedPostWindowMinimized;
  closePostWindowsOnShutdownInput.checked = normalized.closePostWindowsOnShutdown;
}

function renderBridgeState(state) {
  const settings = { ...bridgeDefaults, ...state };
  const targets = normalizeBridgeTargets(settings);
  const firstTarget = targets[0] || normalizeBridgeTargets(bridgeDefaults)[0];
  bridgeForwardExistingInput.checked = Boolean(settings.forwardExistingOnEnable);
  bridgeAutoRestartInput.checked = settings.autoRestartEnabled !== false;
  bridgeTargetUrlInput.value = firstTarget?.messageUrl || DEFAULT_MESSAGE_URL;
  bridgeHeartbeatUrlInput.value = firstTarget?.heartbeatUrl || heartbeatUrlFor(firstTarget?.messageUrl || DEFAULT_MESSAGE_URL);
  bridgeApiKeyInput.value = firstTarget?.apiKey || "";
  bridgeTargetsJsonInput.value = JSON.stringify(targets, null, 2);
  renderBridgeStatus(settings);
}

function currentBridgeSettings() {
  let parsedTargets = [];
  const rawTargets = bridgeTargetsJsonInput.value.trim();
  if (rawTargets) {
    try {
      parsedTargets = JSON.parse(rawTargets);
    } catch (error) {
      throw new Error(`Bot targets JSON is invalid: ${error.message}`);
    }
    if (!Array.isArray(parsedTargets)) {
      throw new Error("Bot targets JSON must be an array");
    }
  }

  const targetUrl = bridgeTargetUrlInput.value.trim() || DEFAULT_MESSAGE_URL;
  const heartbeatUrl = bridgeHeartbeatUrlInput.value.trim() || heartbeatUrlFor(targetUrl);
  const targets = normalizeBridgeTargets({ ...bridgeDefaults, targets: parsedTargets });
  if (targets.length === 0) {
    targets.push(normalizeBridgeTargets({ targetUrl, heartbeatUrl, apiKey: bridgeApiKeyInput.value.trim() })[0]);
  }

  targets[0] = {
    ...targets[0],
    messageUrl: targetUrl || targets[0].messageUrl,
    heartbeatUrl: heartbeatUrl || heartbeatUrlFor(targets[0].messageUrl),
    apiKey: bridgeApiKeyInput.value.trim()
  };

  return {
    targetUrl: targets[0].messageUrl,
    heartbeatUrl: targets[0].heartbeatUrl || heartbeatUrlFor(targets[0].messageUrl),
    apiKey: targets[0].apiKey || "",
    targets,
    forwardExistingOnEnable: bridgeForwardExistingInput.checked,
    autoRestartEnabled: bridgeAutoRestartInput.checked
  };
}

function renderBridgeStatus(settings) {
  const heartbeat = settings.lastHeartbeatAt
    ? `heartbeat ${settings.lastHeartbeatStatus || "unknown"} ${formatTimestamp(settings.lastHeartbeatAt)}`
    : "no heartbeat yet";
  const forward = settings.lastForwardAt
    ? `last forward ${settings.lastForwardStatus || "unknown"} ${formatTimestamp(settings.lastForwardAt)}`
    : "waiting for Discord messages";
  const retry = settings.nextRestartAt ? `; retry ${formatTimestamp(settings.nextRestartAt)}` : "";
  const keyState = settings.apiKey ? "" : "; Echo API key empty";
  setMessage(bridgeStatus, `${forward}; ${heartbeat}${retry}${keyState}`, settings.apiKey ? "" : "warn");
}

function renderLauncherStatus(state) {
  const status = state[launcherStatusStorageKey] || "not connected";
  const at = state.launcherStatusAt ? formatTimestamp(state.launcherStatusAt) : "";
  launcherStatus.textContent = at ? `${status} (${at})` : status;
  launcherStatus.dataset.state = state.launcherStatusState || "";
}

function renderUrlOptions(select, options) {
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  select.disabled = options.length === 1 && !options[0].value;
}

function summarizeUrls(urls, singularLabel) {
  if (urls.length === 0) {
    return `No ${singularLabel}s locked`;
  }
  const label = urls.length === 1 ? singularLabel : `${singularLabel}s`;
  return `${urls.length} ${label} locked. Last: ${urls.at(-1)}`;
}

function setMessage(node, message, state = "") {
  node.textContent = message;
  node.dataset.state = state;
}

async function checkHealth(helperToken) {
  const token = helperToken.trim();
  if (!token) {
    helperStatus.textContent = "missing token";
    helperStatus.dataset.state = "warn";
    return;
  }

  helperStatus.textContent = "checking";
  helperStatus.dataset.state = "";

  try {
    const response = await fetch(`${helperBaseUrl}/health`, {
      headers: {
        "x-helper-token": token
      }
    });
    if (!response.ok) {
      helperStatus.textContent = response.status === 401 ? "unauthorized" : `error ${response.status}`;
      helperStatus.dataset.state = "error";
      return;
    }

    const body = await response.json();
    helperStatus.textContent = body?.ok ? "connected" : "unavailable";
    helperStatus.dataset.state = body?.ok ? "ok" : "error";
  } catch {
    helperStatus.textContent = "not connected";
    helperStatus.dataset.state = "error";
  }
}

function renderLastStatus(state) {
  const status = state.lastStatus || "idle";
  const at = state.lastStatusAt ? formatTimestamp(state.lastStatusAt) : "";
  lastStatus.textContent = at ? `${status} (${at})` : status;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function shortUrl(url) {
  try {
    const channel = routes.normalizeDiscordChannelUrl(url);
    return `.../${channel.guildId}/${channel.channelId}`;
  } catch {
    return url;
  }
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}
