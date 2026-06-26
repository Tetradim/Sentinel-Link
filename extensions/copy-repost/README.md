# Discord Copy Repost Helper

This Chrome extension watches visible Discord web messages, sends normalized alert payloads to the local helper, polls helper jobs, and reposts job text through the visible Discord composer.

## Start The Helper

Set a stable helper token before starting:

```powershell
$env:HELPER_TOKEN = "replace-with-a-private-token"
npm run helper:start
```

Or start without `HELPER_TOKEN` and copy the random token printed by `npm run helper:start` into the extension popup:

```powershell
npm run helper:start
```

The helper listens on `http://127.0.0.1:17654`. Every non-OPTIONS helper request requires the `x-helper-token` header, so the extension will report `missing token` until a token is saved in the popup.

## Native Lifecycle Mode

Install the Chrome native messaging host when you want extension startup/shutdown to own the local helper:

```powershell
.\scripts\install-copy-repost-native-host.ps1 -ExtensionId bfnjhgnbompdhdakmfohoahoohalkhpi
```

Reload the unpacked extension after installing the native host. With native lifecycle installed, extension startup starts or adopts the helper. The popup **Launch** button manually starts or adopts the helper and restores polling if Chrome startup did not wake the service worker. The popup **Shutdown** button stops parsing, closes managed post surfaces when enabled, stops the helper, and stops the watchdog.

The installer registers a compiled native launcher executable with Chrome Native Messaging. If launch fails, the popup status changes from `launch requested` to the specific native-message timeout or startup error.

## Load The Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `extensions/copy-repost`.
5. Open the extension popup.
6. Paste the helper token and choose **Save**.
7. Leave the freshness window at `10` minutes or set the desired recent-message window.
8. Open the configured source Discord channel pages in Chrome.

## Runtime Boundaries

- Uses the visible Discord web page only.
- Does not read Discord tokens.
- Does not call hidden Discord APIs.
- Does not bypass Discord channel permissions.
- Posts only jobs returned by the local helper.
- Repost text includes source, author/time, copied body text, embeds, and visible attachment URLs.
- Discord UI labels, profile badges, server tags, and button text are not included in reposts.
- Source messages older than the popup freshness window are ignored before helper queueing.
- If helper config also enables `freshness`, stale queued jobs are failed server-side instead of being handed back to the extension.
- Dedicated post-window mode routes destination jobs through a managed same-profile Chrome window so reposting does not activate destination tabs in the main Chrome workspace.
- Duplicate suppression uses both Discord message IDs and a visible-message signature, so Discord replacing a temporary local message node with the confirmed server message does not create a second repost.
