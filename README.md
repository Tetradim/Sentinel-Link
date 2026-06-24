# Extension External

Toolkit for authorized Discord alert testing with Chrome extensions and a local helper app.

## Components

- `apps/external-helper`: localhost helper that owns config, queueing, dedupe, retries, auth, and logs.
- `extensions/copy-repost`: Chrome extension that watches configured visible Discord channels and recreates alerts in configured destination channels.
- `extensions/trading-bridge`: integration area for the trading bridge extension currently installed on trading bots.
- `packages/shared`: shared schemas and formatting helpers.

## Start Helper

Set a helper token explicitly:

```powershell
$env:HELPER_TOKEN="change-this-local-token"
npm run helper:start
```

If `HELPER_TOKEN` is omitted, the helper prints a random token at startup. Copy that token into the copy/repost extension popup or pass it to the trading bridge helper client.

By default, the helper reads `apps/external-helper/config/config.example.json` and writes state to `apps/external-helper/data/state.json`.

For local channel mappings, create `apps/external-helper/config/config.local.json` and start with:

```powershell
$env:HELPER_CONFIG="apps/external-helper/config/config.local.json"
$env:HELPER_TOKEN="change-this-local-token"
npm run helper:start
```

## Load Copy/Repost Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `extensions/copy-repost`.
5. Open the extension popup and paste the helper token.
6. Open configured Discord source channels in Chrome.

## Trading Bridge Integration

Place the current installed trading bridge extension source in `extensions/trading-bridge`, preserving its manifest and runtime files. Load `helper-client.js` and call `TradingBridgeHelperClient.submitTradingBridgeAlert(...)` at the point where the trading bridge parses a visible alert.

Content scripts can use `window.TradingBridgeHelperClient`. MV3 background service workers should use `globalThis.TradingBridgeHelperClient`. If the trading bridge reads the helper token from `chrome.storage.local`, its manifest needs the `"storage"` permission.

## Safety Boundaries

This project uses only visible Discord web UI behavior. It does not read Discord tokens, call hidden Discord APIs, or bypass permissions. Attachments and images are reproduced as visible URLs when available.
