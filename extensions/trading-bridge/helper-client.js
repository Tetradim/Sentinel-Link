(function attachTradingBridgeHelperClient(global) {
  "use strict";

  const defaultHelperBaseUrl = "http://127.0.0.1:17654";

  async function submitTradingBridgeAlert(payload, options = {}) {
    const clientOptions = options || {};
    const helperBaseUrl = normalizeHelperBaseUrl(clientOptions.helperBaseUrl);
    const helperToken = await resolveHelperToken(clientOptions);

    if (!helperToken) {
      throw new Error(
        "Trading bridge helper token is required. Pass options.helperToken or store helperToken in chrome.storage.local."
      );
    }

    if (typeof global.fetch !== "function") {
      throw new Error("Trading bridge helper client requires fetch.");
    }

    const response = await global.fetch(`${helperBaseUrl}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-helper-token": helperToken
      },
      body: JSON.stringify(payload)
    });

    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      throw new Error(formatHelperError(response, responseBody));
    }

    if (typeof responseBody === "string") {
      throw new Error(`Trading bridge helper returned non-JSON response with status ${response.status}.`);
    }

    return responseBody;
  }

  async function resolveHelperToken(options) {
    const explicitToken = normalizeToken(options.helperToken);
    if (explicitToken) {
      return explicitToken;
    }

    return readChromeStorageHelperToken();
  }

  async function readChromeStorageHelperToken() {
    const chromeStorage = global.chrome?.storage?.local;
    if (!chromeStorage || typeof chromeStorage.get !== "function") {
      return "";
    }

    const result = await chromeStorage.get("helperToken");
    return normalizeToken(result?.helperToken);
  }

  function normalizeHelperBaseUrl(helperBaseUrl) {
    const baseUrl =
      typeof helperBaseUrl === "string" && helperBaseUrl.trim() ? helperBaseUrl.trim() : defaultHelperBaseUrl;
    return baseUrl.replace(/\/+$/, "");
  }

  function normalizeToken(token) {
    return typeof token === "string" ? token.trim() : "";
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

  function formatHelperError(response, responseBody) {
    const error = responseBody && typeof responseBody === "object" ? responseBody.error : null;
    const code = typeof error?.code === "string" ? error.code : "";
    const message = typeof error?.message === "string" ? error.message : "";
    const detail = message || code || (typeof responseBody === "string" ? responseBody.trim() : "") || response.statusText;
    const codeSuffix = code ? ` ${code}` : "";

    return `Trading bridge helper request failed with status ${response.status}${codeSuffix}: ${detail}`;
  }

  global.TradingBridgeHelperClient = {
    submitTradingBridgeAlert
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
