const DEFAULTS = {
  enabled: false,
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
  nextRestartAt: "",
  generalApiEnabled: false,
  generalApiBaseUrl: "http://127.0.0.1:9200/api/general",
  generalApiRunId: "",
  generalApiParticipantId: "sentinel-link",
  generalApiToken: "",
  generalApiSymbols: [],
  lastGeneralApiStatus: "",
  lastGeneralApiAt: "",
};

const enabled = document.getElementById("enabled");
const forwardExistingOnEnable = document.getElementById("forwardExistingOnEnable");
const autoRestartEnabled = document.getElementById("autoRestartEnabled");
const targetUrl = document.getElementById("targetUrl");
const heartbeatUrl = document.getElementById("heartbeatUrl");
const apiKey = document.getElementById("apiKey");
const targetsJson = document.getElementById("targetsJson");
const status = document.getElementById("status");
const generalApiEnabled = document.getElementById("generalApiEnabled");
const generalApiBaseUrl = document.getElementById("generalApiBaseUrl");
const generalApiRunId = document.getElementById("generalApiRunId");
const generalApiParticipantId = document.getElementById("generalApiParticipantId");
const generalApiSymbols = document.getElementById("generalApiSymbols");
const generalApiToken = document.getElementById("generalApiToken");
const generalApiStatus = document.getElementById("generalApiStatus");

chrome.storage.local.get(DEFAULTS, (settings) => {
  const targets = normalizeBridgeTargets(settings);
  const firstTarget = targets[0] || normalizeBridgeTargets(DEFAULTS)[0];
  enabled.checked = Boolean(settings.enabled);
  forwardExistingOnEnable.checked = Boolean(settings.forwardExistingOnEnable);
  autoRestartEnabled.checked = settings.autoRestartEnabled !== false;
  targetUrl.value = firstTarget.messageUrl;
  heartbeatUrl.value = firstTarget.heartbeatUrl || heartbeatUrlFor(firstTarget.messageUrl);
  apiKey.value = firstTarget.apiKey || "";
  targetsJson.value = JSON.stringify(targets, null, 2);
  renderStatus(settings);
  generalApiEnabled.checked = Boolean(settings.generalApiEnabled);
  generalApiBaseUrl.value = settings.generalApiBaseUrl || DEFAULTS.generalApiBaseUrl;
  generalApiRunId.value = settings.generalApiRunId || "";
  generalApiParticipantId.value = settings.generalApiParticipantId || "sentinel-link";
  generalApiSymbols.value = (settings.generalApiSymbols || []).join(", ");
  generalApiToken.value = settings.generalApiToken || "";
  generalApiStatus.textContent = settings.lastGeneralApiStatus
    ? `Last: ${settings.lastGeneralApiStatus}${settings.lastGeneralApiAt ? ` at ${new Date(settings.lastGeneralApiAt).toLocaleTimeString()}` : ""}`
    : "Not connected.";
});

document.getElementById("save").addEventListener("click", () => {
  let parsedTargets;
  try {
    parsedTargets = targetsJson.value.trim() ? JSON.parse(targetsJson.value) : [];
  } catch (error) {
    status.textContent = `Targets JSON is invalid: ${error.message}`;
    return;
  }

  const targets = normalizeBridgeTargets({ ...DEFAULTS, targets: Array.isArray(parsedTargets) ? parsedTargets : [] });
  const fallbackTarget = normalizeBridgeTargets({
    targetUrl: targetUrl.value.trim() || DEFAULTS.targetUrl,
    heartbeatUrl: heartbeatUrl.value.trim() || heartbeatUrlFor(targetUrl.value.trim() || DEFAULTS.targetUrl),
    apiKey: apiKey.value.trim(),
  })[0];
  if (targets.length === 0) {
    targets.push(fallbackTarget);
  } else {
    targets[0] = {
      ...targets[0],
      messageUrl: targetUrl.value.trim() || targets[0].messageUrl,
      heartbeatUrl: heartbeatUrl.value.trim() || heartbeatUrlFor(targetUrl.value.trim() || targets[0].messageUrl),
      apiKey: apiKey.value.trim(),
    };
  }

  chrome.storage.local.set(
    {
      enabled: enabled.checked,
      forwardExistingOnEnable: forwardExistingOnEnable.checked,
      autoRestartEnabled: autoRestartEnabled.checked,
      targetUrl: targets[0].messageUrl,
      heartbeatUrl: targets[0].heartbeatUrl || heartbeatUrlFor(targets[0].messageUrl),
      apiKey: targets[0].apiKey || "",
      targets,
    },
    () => {
      targetsJson.value = JSON.stringify(targets, null, 2);
      status.textContent = enabled.checked ? "Bridge enabled." : "Bridge disabled.";
    },
  );
});

enabled.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabled.checked }, () => {
    status.textContent = enabled.checked ? "Bridge enabled." : "Bridge disabled.";
  });
});

autoRestartEnabled.addEventListener("change", () => {
  chrome.storage.local.set({ autoRestartEnabled: autoRestartEnabled.checked }, () => {
    status.textContent = autoRestartEnabled.checked ? "Auto-restart enabled." : "Auto-restart disabled.";
  });
});

function generalApiSettings() {
  return {
    generalApiEnabled: generalApiEnabled.checked,
    generalApiBaseUrl: generalApiBaseUrl.value.trim().replace(/\/+$/, "") || DEFAULTS.generalApiBaseUrl,
    generalApiRunId: generalApiRunId.value.trim(),
    generalApiParticipantId: generalApiParticipantId.value.trim() || "sentinel-link",
    generalApiToken: generalApiToken.value.trim(),
    generalApiSymbols: generalApiSymbols.value.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean),
  };
}

document.getElementById("saveGeneralApi").addEventListener("click", () => {
  chrome.storage.local.set(generalApiSettings(), () => {
    generalApiStatus.textContent = "General API settings saved.";
  });
});

document.getElementById("testGeneralApi").addEventListener("click", async () => {
  try {
    const settings = generalApiSettings();
    await chrome.storage.local.set(settings);
    const spec = await generalApiRequest(settings, "GET", "spec");
    let authenticated = false;
    if (settings.generalApiRunId && settings.generalApiToken) {
      await generalApiRequest(settings, "GET", `runs/${encodeURIComponent(settings.generalApiRunId)}/participants/${encodeURIComponent(settings.generalApiParticipantId)}/account`, undefined, true);
      authenticated = true;
    }
    generalApiStatus.textContent = `Connected: ${spec.contract_version || "archive.general.v1"}; authenticated: ${authenticated ? "yes" : "no"}.`;
  } catch (error) {
    generalApiStatus.textContent = `General API test failed: ${error.message}`;
  }
});

document.getElementById("registerGeneralApi").addEventListener("click", async () => {
  try {
    const settings = generalApiSettings();
    if (!settings.generalApiRunId) throw new Error("Replay run ID is required");
    const registration = await generalApiRequest(settings, "POST", `runs/${encodeURIComponent(settings.generalApiRunId)}/participants`, {
      participant_id: settings.generalApiParticipantId,
      bot_id: "sentinel-link",
      display_name: "Sentinel Link",
      roles: ["observer"],
      subscribed_symbols: settings.generalApiSymbols,
      starting_cash: 100000,
      commission_per_order: 0,
      slippage_bps: 0,
    });
    generalApiToken.value = registration.api_token || "";
    await chrome.storage.local.set({ ...settings, generalApiEnabled: true, generalApiToken: registration.api_token || "" });
    generalApiEnabled.checked = true;
    generalApiStatus.textContent = "Sentinel Link registered; participant token saved locally.";
  } catch (error) {
    generalApiStatus.textContent = `Registration failed: ${error.message}`;
  }
});

async function generalApiRequest(settings, method, endpoint, body, authenticated = false) {
  const response = await fetch(`${settings.generalApiBaseUrl}/${endpoint.replace(/^\/+/, "")}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(authenticated ? { "X-Archive-Bot-Token": settings.generalApiToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
  return payload;
}

function renderStatus(settings) {
  if (!settings.lastForwardAt) {
    status.textContent = settings.enabled ? "Enabled. Waiting for Discord messages." : "Disabled.";
    return;
  }
  status.textContent = `Last: ${settings.lastForwardStatus} at ${new Date(settings.lastForwardAt).toLocaleTimeString()}`;
  if (Array.isArray(settings.lastForwardTargets) && settings.lastForwardTargets.length > 0) {
    status.textContent += ` to ${settings.lastForwardTargets.map((target) => target.name || target.id).join(", ")}`;
  }
  if (settings.lastHeartbeatAt) {
    status.textContent += `; health ${settings.lastHeartbeatStatus} at ${new Date(settings.lastHeartbeatAt).toLocaleTimeString()}`;
  }
  if (settings.nextRestartAt) {
    status.textContent += `; retry ${new Date(settings.nextRestartAt).toLocaleTimeString()}`;
  }
}
