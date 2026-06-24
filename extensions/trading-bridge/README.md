# Trading Bridge Extension

This directory is for the trading bridge Chrome extension currently installed on trading bots.

## Helper Event Endpoint

The local helper accepts normalized alert payloads at:

```text
POST http://127.0.0.1:17654/events
```

Every non-OPTIONS helper call requires the `x-helper-token` header. The token comes from `HELPER_TOKEN` when the helper is started, or from the random helper startup log when `HELPER_TOKEN` is not set. Store or pass that token from the extension before submitting alerts.

## Example Call

```javascript
await window.TradingBridgeHelperClient.submitTradingBridgeAlert(
  {
    sourceUrl: "https://discord.com/channels/111111111111111111/222222222222222222",
    messageId: "999999999999999999",
    author: "Alert Bot",
    timestampText: "Today at 12:00 PM",
    text: "Entry alert",
    embeds: [],
    labels: [],
    attachmentUrls: [],
    capturedAt: new Date().toISOString()
  },
  { helperToken: "paste-helper-token-here" }
);
```

## Source Import Guidance

Place the current installed trading bridge extension source in this directory, preserving its manifest and runtime files. Wire the existing parsed alert point to `window.TradingBridgeHelperClient.submitTradingBridgeAlert(...)` after `helper-client.js` is loaded by the extension.

The helper client posts to `http://127.0.0.1:17654/events` by default. Pass `helperBaseUrl` only when the helper is intentionally running somewhere else. Pass `helperToken` explicitly, or store it as `helperToken` in `chrome.storage.local` for the helper client to read.

## Boundaries

- Do not read Discord tokens.
- Do not call hidden Discord APIs.
- Do not bypass Discord or Chrome extension permissions.
- Preserve existing trading bridge behavior while adding helper event emission.
