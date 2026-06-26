const helperBaseUrl = "http://127.0.0.1:17654";
const listenStorageKey = "listenChannelUrls";
const postStorageKey = "postChannelUrls";
const maxMessageAgeMinutesStorageKey = "maxMessageAgeMinutes";
const launcherStatusStorageKey = "launcherStatus";
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
const listenUrlInput = document.querySelector("#listen-url");
const listenLockButton = document.querySelector("#listen-lock");
const listenRevertButton = document.querySelector("#listen-revert");
const listenRevertAllButton = document.querySelector("#listen-revert-all");
const listenMessage = document.querySelector("#listen-message");
const listenSummary = document.querySelector("#listen-summary");
const listenStoredUrlsSelect = document.querySelector("#listen-stored-urls");
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
postLockButton.addEventListener("click", lockPostUrl);
postRevertButton.addEventListener("click", revertPostUrl);
postUrlInput.addEventListener("input", () => {
  postUrlInput.classList.remove("locked");
});
showTokenInput.addEventListener("change", () => {
  tokenInput.type = showTokenInput.checked ? "text" : "password";
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
    postStorageKey,
    destinationWindowKeys.dedicatedPostWindowEnabled,
    destinationWindowKeys.dedicatedPostWindowMinimized,
    destinationWindowKeys.closePostWindowsOnShutdown
  ]);
  enabledInput.checked = state.enabled !== false;
  tokenInput.value = typeof state.helperToken === "string" ? state.helperToken : "";
  maxMessageAgeMinutesInput.value = freshness.normalizeFreshnessWindowMinutes(
    state[maxMessageAgeMinutesStorageKey]
  );
  renderLifecycleState(state);
  renderChannelState(state);
  renderLauncherStatus(state);
  renderLastStatus(state);
  await checkHealth(tokenInput.value);
}

async function saveSettings() {
  const helperToken = tokenInput.value.trim();
  const maxMessageAgeMinutes = freshness.normalizeFreshnessWindowMinutes(maxMessageAgeMinutesInput.value);
  await chrome.storage.local.set({
    enabled: enabledInput.checked,
    helperToken,
    maxMessageAgeMinutes,
    ...currentLifecycleSettings(),
    lastStatus: "settings saved",
    lastStatusAt: new Date().toISOString()
  });
  maxMessageAgeMinutesInput.value = maxMessageAgeMinutes;
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
      lastStatus: "launch requested",
      lastStatusAt: new Date().toISOString()
    });
    maxMessageAgeMinutesInput.value = maxMessageAgeMinutes;

    const response = await chrome.runtime.sendMessage({
      type: "launch-helper",
      helperToken
    });
    setMessage(
      lifecycleMessage,
      response?.ok ? "Launch complete" : response?.reason || "Launch failed",
      response?.ok ? "ok" : "error"
    );
    await loadState();
  } catch (error) {
    setMessage(lifecycleMessage, readableError(error), "error");
  } finally {
    launchHelperButton.disabled = false;
  }
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
      response?.ok ? `Opened ${shortUrl(response.url)}` : response?.reason || "Open failed",
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
  const state = await chrome.storage.local.get([listenStorageKey, postStorageKey, "lastStatus", "lastStatusAt"]);
  renderChannelState(state);
  renderLastStatus(state);
}

function renderChannelState(state) {
  const listenUrls = routes.normalizeUrlList(state[listenStorageKey]);
  const postUrls = routes.normalizeUrlList(state[postStorageKey]);
  listenSummary.textContent = summarizeUrls(listenUrls, "listen URL");
  postSummary.textContent = summarizeUrls(postUrls, "post URL");
  renderUrlOptions(listenStoredUrlsSelect, routes.toStoredUrlOptions(listenUrls, "No listen URLs locked"));
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
