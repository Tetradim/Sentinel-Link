# Sentinel Link

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
- The copy/repost extension uses Chrome's `debugger` permission only to send visible keyboard/text input to the active Discord destination composer. It does not inspect cookies, storage, passwords, or Discord tokens.
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

The Sentinel Link Trading Bridge uses the same helper event endpoint:

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
- visible-message duplicate suppression when Discord changes a message node ID
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
- `src/popup.html` / `src/popup.js`: stores enable state, helper token, Listen channel URLs, Post channel URLs, and the freshness window.

The content script monitors visible Discord message DOM nodes matching:

```text
[id^="chat-messages-"]
```

It extracts visible alert data through `src/parser.js`:

- source URL and source channel ID
- message ID or stable DOM fallback ID
- author text when visible
- timestamp text when visible
- Discord timestamp ISO value from the message `<time datetime="...">`
- message text
- embed title, description, fields, and footer
- visible Discord CDN/media attachment URLs

The content script does not talk to the helper directly. It sends payloads to the background service worker so the helper token stays centralized in extension storage.

The background worker:

- reads `/config` from the helper
- connects to the native messaging launcher when installed
- starts or adopts the local helper through the native launcher when the extension starts
- uses popup-managed Listen/Post routes for matching popup Listen sources, while keeping helper config active for other sources
- filters source observations before calling `/events`
- drops source observations outside the configured freshness window before calling `/events`
- uses `chrome.alarms` for MV3-compatible polling
- claims helper jobs through `/jobs/next?clientId=copy-repost-extension`
- opens or reuses destination Discord tabs
- optionally routes destination posts through a managed dedicated post window
- injects content scripts if needed
- focuses and verifies the visible Discord composer
- types and sends through Chrome trusted input so Discord receives real composer events
- reports `sent` or `failed` through `/jobs/:id/result`

Before it posts, the content script verifies it is on the same Discord channel as the job destination. It protects normal user drafts by refusing to overwrite non-repost composer text. Repost drafts created by the extension can be replaced so a failed retry does not jam the queue. After trusted input sends the message, the extension only reports success when the composer clears or a new visible matching message appears.

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
- When a source matches a popup Listen URL, the extension sends that event to the helper with popup runtime mappings.
- When a source does not match a popup Listen URL, the extension falls back to the helper file config for that source.
- The helper still owns dedupe, queueing, retries, and job state.

The helper file config remains useful for scripted setups and for sources not covered by popup Listen URLs. Popup routes override helper config only for the same source channel, preventing accidental duplicate routes from one source into multiple destinations.

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
  "freshness": {
    "enabled": true,
    "maxAgeMinutes": 10,
    "requireTimestamp": true
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
- `freshness.enabled`: helper-side stale-source guard. When true, `/events` skips stale submissions and `/jobs/next` fails stale queued jobs instead of handing them to clients.
- `freshness.maxAgeMinutes`: maximum source-message age accepted by the helper. Default is 10 when freshness is enabled.
- `freshness.requireTimestamp`: when true, source messages without `timestampIso` are treated as stale. This protects against older extension builds that scan channel history without Discord timestamps.
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
  "timestampIso": "2026-06-24T17:00:00.000Z",
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
  "attachmentUrls": ["https://cdn.discordapp.com/file.png"],
  "capturedAt": "2026-06-24T17:00:00.000Z"
}
```

Required practical input:

- `sourceUrl`
- at least one copied-alert content field: `text`, non-empty `embeds`, or `attachmentUrls`

`labels` from Discord UI buttons, profile badges, and server tags are intentionally ignored by the copy/repost formatter. Reposts include only source, author/time, copied body text, embeds, and visible attachment URLs.

The copy/repost extension also uses `timestampIso` to prevent old channel history from being reposted when a source channel is opened or refreshed. By default, only Discord messages from the last 10 minutes are submitted. Messages without a Discord timestamp are skipped by the freshness gate.

When helper `freshness.enabled` is true, the same stale-source rule is enforced again in the local helper. This second guard prevents stale jobs already stored in `state.json`, or submissions from an older extension build, from being reposted.

The shared package derives `sourceChannelId` from `sourceUrl`. The helper dedupes by source channel and message ID, and also by a visible-message signature made from source, author/minute, body, embeds, and attachment URLs. The visible signature intentionally ignores Discord's exact seconds-level timestamp so two otherwise identical alerts observed a second or two apart do not create duplicate reposts. That second signature prevents double posts when Discord briefly exposes both a temporary local message node and the confirmed server message node with different IDs. When a real Discord message ID is unavailable, the parser uses stable DOM-derived fallbacks for the current page session.

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

## Native Lifecycle Host

The Copy/Repost extension can start and stop the helper through Chrome Native Messaging. This is the recommended local mode when you want Chrome/extension lifecycle to own the helper app.

Install the native host registration for the current unpacked extension ID:

```powershell
.\scripts\install-copy-repost-native-host.ps1 -ExtensionId bfnjhgnbompdhdakmfohoahoohalkhpi
```

The installer compiles a local native launcher executable under `apps/native-host/bin/`, writes the Chrome native host manifest under `apps/native-host/native-messaging/`, and registers:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tetradim.discord_copy_repost
```

After installing, reload the unpacked Copy/Repost extension in `chrome://extensions` so the new `nativeMessaging` permission and background worker are active.

Native lifecycle behavior:

- Extension install/startup connects to `com.tetradim.discord_copy_repost`.
- The native host starts `apps/external-helper/src/main.js` when port `17654` is closed.
- If a managed helper is already listening on port `17654`, the native host adopts it.
- The native host starts a watchdog that kills the helper if the native host disappears unexpectedly.
- The popup **Launch** button manually starts or adopts the helper, re-enables the copier, and restores polling when Chrome startup does not wake the helper automatically.
- Launch failures and native-message timeouts are written back into the popup status area instead of leaving the UI stuck at `launch requested`.
- The popup **Shutdown** button disables the copier, clears polling, optionally closes managed destination windows/tabs, stops the helper, and stops the watchdog.
- If Chrome closes and the native pipe disconnects, the native host waits through a grace period before stopping the helper. This avoids killing the helper during transient MV3 service-worker restarts.

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

When updating an unpacked copy/repost extension, reload it from `chrome://extensions` after pulling code changes. Manifest, service worker, permission, and content-script changes are not applied reliably until the unpacked extension is reloaded. Current builds version-check the Discord content script and reinject the current script when an open Discord tab still has an older listener.

The extension popup shows:

- enabled/disabled state
- Launch button
- Shutdown button
- helper token input
- launcher connection status
- helper connection status
- last background status
- Freshness window input, in minutes
- dedicated post-window controls
- Listen URL input with Lock, Revert, and Revert All
- Post URL input with Lock and Revert
- Stored URL dropdowns for both Listen and Post

### Dedicated Post Window

The popup lifecycle controls include:

- **Use dedicated post window**: routes destination jobs to an extension-managed Chrome window. This setting is saved immediately when toggled.
- **Keep post window minimized**: minimizes that managed window after opening or selecting a destination tab.
- **Close post window on shutdown**: closes only managed destination windows/tabs when **Shutdown** is pressed.
- **Open Post Window**: opens the latest locked Post URL in the managed post window.

The dedicated post window uses the same Chrome profile as the rest of Chrome. It does not require a second Discord login and does not create a second extension instance. The extension creates the managed window normally, then minimizes it when requested; this avoids Chrome rejecting direct minimized-window creation. When dedicated mode is enabled, the extension does not activate destination tabs in the user's main Chrome window.

### Popup Channel Inputs

The **Listen** input stores Discord source channel URLs.

- Paste a Discord channel URL.
- Click **Lock**.
- The URL is normalized, saved, and cleared from the input.
- Open **Stored Listen URLs** to view every Listen URL currently saved.
- A duplicate Listen URL shows an error and is not saved.
- **Revert** removes the most recently locked Listen URL and places it back in the input.
- Repeated **Revert** clicks continue walking backward through the Listen stack.
- **Revert All** clears all saved Listen URLs.

The **Post** input stores destination channel URLs.

- Paste a Discord channel URL.
- Click **Lock**.
- The URL is normalized, saved, and left visible in the input with a grey locked style.
- Open **Stored Post URLs** to view every Post URL currently saved.
- Typing or pasting a new URL removes the locked styling so another destination can be added.
- **Revert** removes only the most recently locked Post URL and shows the previous saved Post URL when one exists.

Popup routes are active for channels saved under **Listen** when at least one **Post** URL is saved. For a source channel that is not saved under **Listen**, the extension uses the helper file config instead. If a Listen URL is saved without any Post URL, that popup route is ignored until a Post URL is added.

The **Freshness window** controls how far back the extension may copy messages from a source Discord channel. The default is `10` minutes. The accepted range is `1` to `1440` minutes. This filter is applied in the background worker before helper queueing, so opening a channel with older visible history does not create repost jobs for stale messages. Use `1` minute when you want near-new-only testing after opening a channel.

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
5. The background worker loads `/config`, applies popup routes for matching popup Listen sources, and otherwise uses helper config mappings.
6. The background worker drops payloads older than the configured freshness window.
7. The background worker submits matching fresh payloads to `POST /events`.
8. The helper dedupes the source message and creates one `queued` job per destination URL.
9. The background worker polls `/jobs/next?clientId=copy-repost-extension`.
10. The background worker opens or reuses the destination Discord tab.
11. The content script validates the destination channel and focuses the composer.
12. The background worker uses trusted Chrome input to clear extension-created drafts, type the repost, and press Enter.
13. The content script confirms that Discord accepted the post.
14. The background worker reports `sent` or `failed` to `/jobs/:id/result`.
15. The helper either finalizes the job or schedules an exponential-backoff retry.

## What Each Piece Monitors

- External helper: watches its durable queue and receives HTTP events/jobs/results.
- Copy/repost content script: watches visible Discord message DOM nodes in loaded Discord channel tabs.
- Copy/repost background worker: watches helper jobs through `chrome.alarms` polling and extension messages from content scripts.
- Copy/repost popup: watches local extension storage and helper `/health` when refreshed/saved.
- Trading bridge helper client: does not monitor by itself; it submits alerts when the Sentinel Link Trading Bridge calls it.

## Troubleshooting

`missing helper token`

- The extension popup has no token saved.
- Start helper with `HELPER_TOKEN`, or copy the random startup token into the popup.

`401 unauthorized`

- The saved extension token does not match the helper token.
- Restart helper with a known `HELPER_TOKEN` and update the popup.

`ignored non-source channel`

- The content script saw a Discord message, but neither the popup Listen URLs nor helper config list that channel as an enabled source.
- Check the popup Stored Listen URLs and `sourceUrl` in `config.local.json`.

`ignored stale message`

- The content script saw a Discord message, but the message timestamp was missing or older than the popup freshness window.
- Increase the Freshness window only when intentionally replaying recent channel history.

`Destination channel mismatch`

- The destination tab navigated or Discord SPA routing changed before posting.
- The job is reported failed so the helper can retry.

`Discord composer is not empty`

- The extension refuses to overwrite normal user text already in the destination composer.
- Extension-created repost drafts are replaced automatically after the current version is reloaded in Chrome.
- If this error persists after reload, clear the composer and let the helper retry.

`Unable to verify Discord send after Enter fallback`

- The installed extension is still running the older content-script path.
- Reload the unpacked extension in `chrome://extensions`; current builds use trusted input and content-script version checks instead.

Unreadable or shaded `[copied-alert]` text in the Discord composer

- This is a stale Discord rich-editor draft created by the older DOM/Enter fallback path.
- It is not a confirmed repost.
- Clear the destination composer, reload the unpacked extension, and submit a new source message.
- Current builds reject the legacy `post-job` message path so stale service workers fail visibly instead of creating another malformed draft.

`Discord composer did not contain the expected repost text`

- Chrome trusted input did not reach the active Discord composer.
- Click the destination channel message box once, reload the copy/repost extension, and let the helper retry.

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
