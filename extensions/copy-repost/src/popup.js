const helperBaseUrl = "http://127.0.0.1:17654";

const enabledInput = document.querySelector("#enabled");
const tokenInput = document.querySelector("#helper-token");
const showTokenInput = document.querySelector("#show-token");
const helperStatus = document.querySelector("#helper-status");
const lastStatus = document.querySelector("#last-status");
const saveButton = document.querySelector("#save");
const refreshButton = document.querySelector("#refresh");

saveButton.addEventListener("click", saveSettings);
refreshButton.addEventListener("click", loadState);
showTokenInput.addEventListener("change", () => {
  tokenInput.type = showTokenInput.checked ? "text" : "password";
});

void loadState();

async function loadState() {
  const state = await chrome.storage.local.get(["enabled", "helperToken", "lastStatus", "lastStatusAt"]);
  enabledInput.checked = state.enabled !== false;
  tokenInput.value = typeof state.helperToken === "string" ? state.helperToken : "";
  renderLastStatus(state);
  await checkHealth(tokenInput.value);
}

async function saveSettings() {
  const helperToken = tokenInput.value.trim();
  await chrome.storage.local.set({
    enabled: enabledInput.checked,
    helperToken,
    lastStatus: "settings saved",
    lastStatusAt: new Date().toISOString()
  });
  renderLastStatus({
    lastStatus: "settings saved",
    lastStatusAt: new Date().toISOString()
  });
  await checkHealth(helperToken);
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
