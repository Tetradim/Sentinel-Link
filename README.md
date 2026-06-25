# Extension External

Chrome-extension and localhost-helper toolkit for authorized Discord alert testing.

The repo contains three user-facing pieces:

1. `apps/external-helper`: local queue, configuration, retry, auth, and status service.
2. `extensions/copy-repost`: Chrome extension that watches configured Discord source channels and recreates alerts in configured destination channels.
3. `extensions/trading-bridge`: integration surface for the trading bridge Chrome extension currently installed on trading bots.

`packages/shared` supports those pieces with shared validation, Discord channel URL parsing, dedupe keys, and repost message formatting.

## Safety Model

This project is intentionally UI-visible and permission-bound.

- It uses the Discord web UI that the logged-in Chrome user can already see and type into.
- It does not read Discord user tokens, bot tokens, `localStorage`, or `sessionStorage`.
- It does not call hidden Discord APIs.
- It does not bypass Discord channel permissions.
- Attachments and images are not re-uploaded. Visible Discord CDN/media URLs are included as text when available.
- The localhost helper requires an `x-helper-token` header for every non-OPTIONS request.

Use this only in servers and channels where you are authorized to read source messages and post test messages.

## Architecture

```text
Discord web source tab
  -> extensions/copy-repost content script
  -> extensions/copy-repost background service worker
  -> apps/external-helper /events
  -> durable helper queue
  -> apps/external-helper /jobs/next
  -> extensions/copy-repost background service worker
  -> Discord web destination tab composer
  -> apps/external-helper /jobs/:id/result
```

The trading bridge extension uses the same helper event endpoint:

```text
Trading bridge parser
  -> extensions/trading-bridge/helper-client.js
  -> apps/external-helper /events
  -> durable helper queue
```

## Component Responsibilities

### 1. External Helper

Path: `apps/external-helper`

The helper is a local Node.js HTTP service bound to `127.0.0.1`. It owns the canonical runtime state:

- source-to-destination mappings
- helper auth token enforcement
- alert dedupe
- one queued job per destination channel
- retry timing and max attempts
- job leases for extension workers
- durable JSON state
- recent event log and queue status

Default URL:

```text
http://127.0.0.1:17654
```

Default config:

```text
apps/external-helper/config/config.example.json
```

Default state file:

```text
apps/external-helper/data/state.json
```

The helper does not monitor Discord directly. It monitors its own queue and accepts normalized alert payloads from extensions.

### 2. Copy/Repost Extension

Path: `extensions/copy-repost`

This is the new Chrome extension that watches configured Discord source channels and recreates alerts in configured destination channels.

It has three runtime parts:

- `src/content.js`: runs inside Discord channel tabs.
- `src/background.js`: owns helper communication, config filtering, polling, tab coordination, and result reporting.
- `src/popup.html` / `src/popup.js`: stores enable state, helper token, Listen channel URLs, and Post channel URLs.

The content script monitors visible Discord message DOM nodes matching:

```text
[id^="chat-messages-"]
```

It extracts visible alert data through `src/parser.js`:

- source URL and source channel ID
- message ID or stable DOM fallback ID
- author text when visible
- timestamp text when visible
- message text
- embed title, description, fields, and footer
- visible button/label text
- visible Discord CDN/media attachment URLs

The content script does not talk to the helper directly. It sends payloads to the background service worker so the helper token stays centralized in extension storage.

The background worker:

- reads `/config` from the helper
- prefers popup-managed Listen/Post routes when any popup channel URLs are locked
- filters source observations before calling `/events`
- uses `chrome.alarms` for MV3-compatible polling
- claims helper jobs through `/jobs/next?clientId=copy-repost-extension`
- opens or reuses destination Discord tabs
- injects content scripts if needed
- posts through the visible Discord composer
- reports `sent` or `failed` through `/jobs/:id/result`

Before it posts, the content script verifies it is on the same Discord channel as the job destination. After it clicks Send or dispatches Enter, it only reports success when the composer clears or a new visible matching message appears.

### 3. Trading Bridge Integration

Path: `extensions/trading-bridge`

This directory is for the trading bridge Chrome extension currently installed on trading bots. It provides:

- `helper-client.js`: dependency-free browser-global client for the helper `/events` endpoint.
- `README.md`: integration notes for content scripts and MV3 background service workers.
- `test/helper-client.test.js`: token, storage fallback, and helper error tests.

The trading bridge integration does not replace the existing installed extension. Place the installed extension source in `extensions/trading-bridge`, preserve its manifest/runtime files, load `helper-client.js`, and call:

```javascript
await window.TradingBridgeHelperClient.submitTradingBridgeAlert(payload, {
  helperToken: "paste-helper-token-here"
});
```

In an MV3 background service worker, use:

```javascript
await globalThis.TradingBridgeHelperClient.submitTradingBridgeAlert(payload, {
  helperToken: "paste-helper-token-here"
});
```

If the extension relies on `chrome.storage.local` token lookup, its manifest needs the `"storage"` permission.

## Helper Configuration

The easiest runtime setup is now through the Copy/Repost extension popup:

- Add source channels under **Listen**.
- Add destination channels under **Post**.
- The extension stores those URLs in `chrome.storage.local`.
- When popup routes exist, the extension sends matching alert events to the helper with runtime mappings.
- The helper still owns dedupe, queueing, retries, and job state.

The helper file config remains useful for scripted setups and fallback operation when no popup routes are saved.

Create a local config file for real channels:

```text
apps/external-helper/config/config.local.json
```

`config.local.json` is intentionally gitignored. Keep real workspace/server channel routing there for the local machine; commit reusable examples or documentation instead.

Example:

```json
{
  "enabled": true,
  "retry": {
    "maxAttempts": 3,
    "baseDelayMs": 2000
  },
  "sendPacingMs": 1500,
  "mappings": [
    {
      "id": "alerts-to-bot-test",
      "enabled": true,
      "sourceUrl": "https://discord.com/channels/111111111111111111/222222222222222222",
      "destinationUrls": [
        "https://discord.com/channels/333333333333333333/444444444444444444",
        "https://discord.com/channels/333333333333333333/555555555555555555"
      ],
      "prefix": "[copied-alert]"
    }
  ]
}
```

Config fields:

- `enabled`: global helper enable switch. When false, mappings do not create jobs.
- `retry.maxAttempts`: total attempts per destination job. Default is 3.
- `retry.baseDelayMs`: exponential retry base delay. With default config, failures retry after 2 seconds, then 4 seconds, then fail after the third failed attempt.
- `sendPacingMs`: reserved pacing value for clients/operators. Current queue claiming is lease-based.
- `mappings[].id`: stable mapping identifier used in jobs and logs.
- `mappings[].enabled`: per-mapping enable switch.
- `mappings[].sourceUrl`: Discord source channel URL.
- `mappings[].destinationUrls`: one or more Discord destination channel URLs.
- `mappings[].prefix`: optional text prepended to recreated messages.

Discord channel URLs must use this shape:

```text
https://discord.com/channels/<guild-id>/<channel-id>
```

## Normalized Alert Input

Both extensions submit the same payload shape to the helper:

```json
{
  "sourceUrl": "https://discord.com/channels/111111111111111111/222222222222222222",
  "messageId": "999999999999999999",
  "author": "Alert Bot",
  "timestampText": "Today at 12:00 PM",
  "text": "Entry alert",
  "embeds": [
    {
      "title": "AAPL",
      "description": "Breakout",
      "fields": [
        { "name": "Price", "value": "190" }
      ],
      "footer": "Trading alerts"
    }
  ],
  "labels": ["Open Chart"],
  "attachmentUrls": ["https://cdn.discordapp.com/file.png"],
  "capturedAt": "2026-06-24T17:00:00.000Z"
}
```

Required practical input:

- `sourceUrl`
- at least one visible content field: `text`, non-empty `embeds`, `labels`, or `attachmentUrls`

The shared package derives `sourceChannelId` from `sourceUrl`. The helper dedupes by source channel and message ID. When a real Discord message ID is unavailable, the parser uses stable DOM-derived fallbacks for the current page session.

## Helper HTTP API

Every non-OPTIONS request requires:

```text
x-helper-token: <helper-token>
```

Routes:

- `GET /health`: returns helper status.
- `GET /config`: returns sanitized active config for extensions.
- `POST /events`: accepts normalized alert payloads and creates destination jobs.
- `GET /jobs/next?clientId=<id>`: leases the next due job to a client.
- `POST /jobs/:id/result`: records `sent` or `failed` for the claiming client.
- `GET /status`: returns queue counts and recent events.

`POST /events` accepts the original raw alert payload shape, which uses the helper file config. It also accepts the popup-managed route shape:

```json
{
  "alert": {
    "sourceUrl": "https://discord.com/channels/111111111111111111/222222222222222222",
    "messageId": "999999999999999999",
    "text": "Entry alert"
  },
  "mappings": [
    {
      "id": "popup-route-222222222222222222",
      "enabled": true,
      "sourceUrl": "https://discord.com/channels/111111111111111111/222222222222222222",
      "destinationUrls": [
        "https://discord.com/channels/333333333333333333/444444444444444444"
      ],
      "prefix": "[copied-alert]"
    }
  ]
}
```

Result bodies must include the claiming `clientId`:

```json
{
  "status": "sent",
  "clientId": "copy-repost-extension",
  "degradation": ["attachments_included_as_urls"]
}
```

or:

```json
{
  "status": "failed",
  "clientId": "copy-repost-extension",
  "reason": "Discord composer not found"
}
```

Important queue states:

- `queued`: job is waiting for a client.
- `in_progress`: job is leased to a client.
- `retry_wait`: failed job is waiting for its next retry.
- `sent`: destination post was confirmed.
- `failed`: final failure after max attempts.
- `skipped_duplicate`: duplicate source message was ignored.
- `no_matching_mapping`: payload did not match any enabled mapping and was not marked duplicate.

Leases expire after 180 seconds. Expired `in_progress` jobs become claimable again without being lost. This longer lease gives cold Discord destination tabs time to load and expose the message composer before another client retries the same job.

## Local Setup

Install dependencies:

```powershell
npm install
```

Run all tests:

```powershell
npm test
```

Start the helper with an explicit token:

```powershell
$env:HELPER_CONFIG="apps/external-helper/config/config.local.json"
$env:HELPER_TOKEN="change-this-local-token"
npm run helper:start
```

If `HELPER_TOKEN` is not set, the helper prints a random token at startup:

```text
Token: <generated-token>
```

Copy that token into the copy/repost extension popup or pass it to the trading bridge helper client.

## Loading The Copy/Repost Extension

1. Start the helper.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select `extensions/copy-repost`.
6. Open the extension popup.
7. Paste the helper token.
8. Add Listen and Post channel URLs.
9. Keep the extension enabled.
10. Open each configured Discord source channel in Chrome.

The extension popup shows:

- enabled/disabled state
- helper token input
- helper connection status
- last background status
- Listen URL input with Lock, Revert, and Revert All
- Post URL input with Lock and Revert

### Popup Channel Inputs

The **Listen** input stores Discord source channel URLs.

- Paste a Discord channel URL.
- Click **Lock**.
- The URL is normalized, saved, and cleared from the input.
- A duplicate Listen URL shows an error and is not saved.
- **Revert** removes the most recently locked Listen URL and places it back in the input.
- Repeated **Revert** clicks continue walking backward through the Listen stack.
- **Revert All** clears all saved Listen URLs.

The **Post** input stores destination channel URLs.

- Paste a Discord channel URL.
- Click **Lock**.
- The URL is normalized, saved, and left visible in the input with a grey locked style.
- Typing or pasting a new URL removes the locked styling so another destination can be added.
- **Revert** removes only the most recently locked Post URL and shows the previous saved Post URL when one exists.

Popup routes are active as soon as at least one Listen or Post URL is saved. If Listen URLs exist but no Post URL exists, matching alerts are not submitted and the extension status reports that no post channels are configured.

## Runtime Timing

The copy/repost workflow uses longer waits than a normal localhost API because Discord can cold-load slowly:

- Helper job lease: 180 seconds.
- Destination Discord tab load wait: 90 seconds.
- Destination composer lookup wait: 60 seconds.

If Discord still reports `Discord tab did not finish loading` or `Discord composer not found`, reload the destination channel manually once, confirm the message box is visible, then let the helper retry or submit a new alert.

## End-To-End Flow

1. A configured source Discord channel is open in Chrome.
2. `extensions/copy-repost/src/content.js` observes visible message nodes.
3. `src/parser.js` extracts visible alert data.
4. The content script sends the payload to `src/background.js`.
5. The background worker loads `/config` and drops payloads that do not match enabled source mappings.
6. The background worker submits matching payloads to `POST /events`.
7. The helper dedupes the source message and creates one `queued` job per destination URL.
8. The background worker polls `/jobs/next?clientId=copy-repost-extension`.
9. The background worker opens or reuses the destination Discord tab.
10. The content script validates the destination channel, writes to the composer, sends, and confirms.
11. The background worker reports `sent` or `failed` to `/jobs/:id/result`.
12. The helper either finalizes the job or schedules an exponential-backoff retry.

## What Each Piece Monitors

- External helper: watches its durable queue and receives HTTP events/jobs/results.
- Copy/repost content script: watches visible Discord message DOM nodes in loaded Discord channel tabs.
- Copy/repost background worker: watches helper jobs through `chrome.alarms` polling and extension messages from content scripts.
- Copy/repost popup: watches local extension storage and helper `/health` when refreshed/saved.
- Trading bridge helper client: does not monitor by itself; it submits alerts when the trading bridge extension calls it.

## Troubleshooting

`missing helper token`

- The extension popup has no token saved.
- Start helper with `HELPER_TOKEN`, or copy the random startup token into the popup.

`401 unauthorized`

- The saved extension token does not match the helper token.
- Restart helper with a known `HELPER_TOKEN` and update the popup.

`ignored non-source channel`

- The content script saw a Discord message, but helper config does not list that channel as an enabled source.
- Check `sourceUrl` in `config.local.json`.

`Destination channel mismatch`

- The destination tab navigated or Discord SPA routing changed before posting.
- The job is reported failed so the helper can retry.

`Discord composer is not empty`

- The extension refuses to overwrite text already in the destination composer.
- Clear the composer and let the helper retry.

`retry_wait`

- A job failed but has attempts remaining.
- With the default retry config, attempts occur immediately, after 2 seconds, and after 4 seconds.

`failed`

- A job exhausted `retry.maxAttempts`.
- Inspect `apps/external-helper/data/state.json` or `GET /status` for recent errors.

## Development Notes

Useful commands:

```powershell
npm test
npm run test:shared
npm run test:helper
npm run test:copy-repost
```

Syntax checks:

```powershell
node --check extensions/copy-repost/src/background.js
node --check extensions/copy-repost/src/content.js
node --check extensions/copy-repost/src/popup.js
node --check extensions/trading-bridge/helper-client.js
```

The helper HTTP tests avoid Fetch/browser blocked ephemeral ports in their test-only server bootstrap. Production helper startup remains fixed to `127.0.0.1:17654` by default.
