importScripts("channel-routes.js");

const helperBaseUrl = "http://127.0.0.1:17654";
const clientId = "copy-repost-extension";
const pollAlarmName = "copy-repost-poll";
const pollAlarmPeriodMinutes = 1;
const configCacheTtlMs = 60_000;
const discordTabLoadTimeoutMs = 90_000;
const listenStorageKey = "listenChannelUrls";
const postStorageKey = "postChannelUrls";
const routeHelpers = globalThis.CopyRepostChannelRoutes;

let pollInFlight = false;
let sourceConfigCache = null;

void ensurePollAlarm();

chrome.runtime.onInstalled.addListener(() => {
  Promise.all([initializeStorageDefaults(), ensurePollAlarm()]).then(() => {
    void pollHelper();
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensurePollAlarm().then(() => {
    void pollHelper();
  });
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

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === pollAlarmName) {
    void pollHelper();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.helperToken || changes.enabled || changes[listenStorageKey] || changes[postStorageKey]) {
    sourceConfigCache = null;
    void ensurePollAlarm();
    void pollHelper();
  }
});

async function initializeStorageDefaults() {
  const state = await chrome.storage.local.get(["enabled", "helperToken", listenStorageKey, postStorageKey]);
  const defaults = {
    lastStatus: "installed",
    lastStatusAt: new Date().toISOString()
  };

  if (typeof state.enabled !== "boolean") {
    defaults.enabled = true;
  }

  if (typeof state.helperToken !== "string") {
    defaults.helperToken = "";
  }

  if (!Array.isArray(state[listenStorageKey])) {
    defaults[listenStorageKey] = [];
  }

  if (!Array.isArray(state[postStorageKey])) {
    defaults[postStorageKey] = [];
  }

  await chrome.storage.local.set(defaults);
}

async function submitPayload(payload) {
  const { enabled = true } = await chrome.storage.local.get("enabled");
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

  if (!isAllowedSourcePayload(payload, sourceConfig)) {
    const source = payload?.sourceChannelId || payload?.sourceUrl || "unknown source";
    await setStatus(`ignored non-source channel: ${source}`);
    return { ok: true, ignored: true, reason: "ignored non-source channel" };
  }

  const result = await helperFetch("/events", {
    method: "POST",
    body: sourceConfig.runtimeMappings
      ? {
          alert: payload,
          mappings: sourceConfig.runtimeMappings
        }
      : payload
  });
  const createdCount = Array.isArray(result?.createdJobs) ? result.createdJobs.length : 0;
  await setStatus(result?.skippedDuplicate ? "event skipped duplicate" : `event submitted (${createdCount} jobs)`);
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

async function processJob(job) {
  let sendResult;
  try {
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

  await typeRepostWithDebugger(tabId, job.messageText);

  const draftResult = await chrome.tabs.sendMessage(tabId, {
    type: "verify-composer-draft",
    expectedText: job.messageText
  });
  if (!draftResult?.ok) {
    return draftResult;
  }

  await pressEnterWithDebugger(tabId);

  return chrome.tabs.sendMessage(tabId, {
    type: "confirm-posted",
    job,
    beforeMessageKeys: Array.isArray(prepareResult.beforeMessageKeys) ? prepareResult.beforeMessageKeys : []
  });
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

async function openOrReuseDestinationTab(destinationUrl) {
  if (!isDiscordChannelUrl(destinationUrl)) {
    throw new Error("Job destinationUrl must be a Discord channel URL");
  }

  const tabs = await chrome.tabs.query({ url: "https://discord.com/channels/*" });
  const existing = tabs.find((tab) => tab.url && sameDiscordChannel(tab.url, destinationUrl));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    return chrome.tabs.get(existing.id);
  }

  return chrome.tabs.create({ url: destinationUrl, active: true });
}

async function ensureContentScript(tabId) {
  if (await pingContentScript(tabId)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/parser.js", "src/content.js"]
  });

  if (!(await pingContentScript(tabId))) {
    throw new Error("Discord content script is unavailable");
  }
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return response?.ok === true;
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
    postChannelUrls = []
  } = await chrome.storage.local.get(["helperToken", listenStorageKey, postStorageKey]);
  const token = normalizeToken(helperToken);
  const listenUrls = routeHelpers.normalizeUrlList(listenChannelUrls);
  const postUrls = routeHelpers.normalizeUrlList(postChannelUrls);
  const usesPopupRoutes = routeHelpers.hasStoredRoutes(listenUrls, postUrls);
  const cacheKey = usesPopupRoutes
    ? `${token}|popup|${listenUrls.join(",")}|${postUrls.join(",")}`
    : `${token}|helper-config`;
  const now = Date.now();
  if (sourceConfigCache && sourceConfigCache.cacheKey === cacheKey && sourceConfigCache.expiresAt > now) {
    return sourceConfigCache;
  }

  if (usesPopupRoutes) {
    if (listenUrls.length > 0 && postUrls.length === 0) {
      throw new Error("no post channels configured");
    }

    const runtimeConfig = routeHelpers.buildRuntimeConfig({
      listenChannelUrls: listenUrls,
      postChannelUrls: postUrls
    });
    const enabledSources = extractEnabledSources(runtimeConfig);
    sourceConfigCache = {
      token,
      cacheKey,
      expiresAt: now + configCacheTtlMs,
      runtimeMappings: runtimeConfig.mappings,
      ...enabledSources
    };
    return sourceConfigCache;
  }

  const config = await helperFetch("/config");
  const enabledSources = extractEnabledSources(config);
  sourceConfigCache = {
    token,
    cacheKey,
    expiresAt: now + configCacheTtlMs,
    ...enabledSources
  };
  return sourceConfigCache;
}

function extractEnabledSources(config) {
  const sourceChannelIds = new Set();
  const sourceUrls = new Set();
  if (config?.enabled === false || !Array.isArray(config?.mappings)) {
    return { sourceChannelIds, sourceUrls };
  }

  for (const mapping of config.mappings) {
    if (!mapping || mapping.enabled === false) {
      continue;
    }

    const sourceChannelId = normalizeSourceChannelId(mapping.sourceChannelId);
    if (sourceChannelId) {
      sourceChannelIds.add(sourceChannelId);
    }

    const sourceUrl = discordChannelPrefix(mapping.sourceUrl);
    if (sourceUrl) {
      sourceUrls.add(sourceUrl);
    }
  }

  return { sourceChannelIds, sourceUrls };
}

function isAllowedSourcePayload(payload, sourceConfig) {
  const sourceChannelId = normalizeSourceChannelId(payload?.sourceChannelId);
  if (sourceChannelId && sourceConfig.sourceChannelIds.has(sourceChannelId)) {
    return true;
  }

  const sourceUrl = discordChannelPrefix(payload?.sourceUrl);
  return Boolean(sourceUrl && sourceConfig.sourceUrls.has(sourceUrl));
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

function normalizeSourceChannelId(sourceChannelId) {
  return typeof sourceChannelId === "string" ? sourceChannelId.trim() : "";
}

function isDiscordChannelUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "discord.com" && /^\/channels\/\d+\/\d+/.test(url.pathname);
  } catch {
    return false;
  }
}

function sameDiscordChannel(tabUrl, destinationUrl) {
  const tabChannel = discordChannelPrefix(tabUrl);
  const destinationChannel = discordChannelPrefix(destinationUrl);
  return Boolean(tabChannel && destinationChannel && tabChannel === destinationChannel);
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

async function setStatus(lastStatus) {
  await chrome.storage.local.set({
    lastStatus,
    lastStatusAt: new Date().toISOString()
  });
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
