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

## Load The Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `extensions/copy-repost`.
5. Open the extension popup.
6. Paste the helper token and choose **Save**.
7. Open the configured source Discord channel pages in Chrome.

## Runtime Boundaries

- Uses the visible Discord web page only.
- Does not read Discord tokens.
- Does not call hidden Discord APIs.
- Does not bypass Discord channel permissions.
- Posts only jobs returned by the local helper.
- Attachments and images are included as visible URLs when the parser can see them.
