# Discord Extension And Helper Design

## Goal

Build a coordinated toolkit for Discord alert testing that can copy visible alerts from selected Discord channels and recreate them in selected test channels. The system is for authorized testing using the logged-in Discord web UI. It must not read Discord account tokens, call hidden Discord APIs, bypass channel permissions, or invite/install a bot into source channels.

## Repository Strategy

The repository will use a single monorepo layout on `main`:

- `extensions/trading-bridge/` for the already-made Chrome extension currently installed on all trading bots.
- `extensions/copy-repost/` for the new Chrome extension that copies visible alerts and recreates them in destination channels.
- `apps/external-helper/` for the local helper app that watches both extensions, owns durable queue state, and records retry history.
- `packages/shared/` for shared message, mapping, and event schemas used by the extensions and helper.

Implementation work will use short-lived feature branches:

- `feature/trading-bridge-extension`
- `feature/copy-repost-extension`
- `feature/external-helper-app`

Each branch should land a complete, independently reviewable vertical slice, then merge back into `main`. The branches are not intended to remain separate products forever; the final deliverable is one coordinated repo.

## Architecture

The system has three cooperating parts:

1. Trading bridge extension
   - Imported or adapted into `extensions/trading-bridge/`.
   - Emits normalized channel/message events to the helper when possible.
   - Keeps its original bot-helper behavior intact unless a compatibility change is needed.

2. Copy/repost Chrome extension
   - Manifest V3 extension scoped to `https://discord.com/channels/*`.
   - Uses content scripts to observe visible Discord channel messages and extract alert data from the DOM.
   - Uses the visible Discord composer to recreate alerts in configured destination channels.
   - Coordinates tabs through a background service worker, but does not rely on it for durable retry state.

3. External helper app
   - Local Node.js process.
   - Exposes a localhost WebSocket or HTTP interface for extensions.
   - Owns configuration, queueing, dedupe state, exponential backoff, retry history, and logs.
   - Provides a simple status view or CLI output for active mappings, queued alerts, sent alerts, and failures.

## Data Flow

1. User configures source channel URLs and destination channel URLs.
2. A Discord source channel tab is open or opened by the extension.
3. The copy/repost extension observes new visible message nodes.
4. The content script extracts a normalized alert payload:
   - source channel URL and channel ID when visible in the URL
   - destination mapping ID
   - detected author/name when visible
   - detected timestamp when visible
   - message text
   - embed title, description, fields, footer, and visible metadata when available
   - visible button or label text
   - visible image, attachment, and file URLs when Discord exposes them in the DOM
5. The extension sends the payload to the helper.
6. The helper dedupes and queues the payload for each configured destination.
7. The helper assigns work back to the extension.
8. The extension opens or reuses a destination Discord tab and posts through the visible composer.
9. The extension reports success or failure to the helper.
10. The helper stores final status in durable logs.

## Retry And Backoff

The helper owns retry state. Capture or send failures retry up to three total attempts. Delays use exponential backoff, starting from a configurable base delay. The default sequence is:

- attempt 1 immediately
- attempt 2 after 2 seconds
- attempt 3 after 4 seconds

After the third failed attempt, the helper marks the job failed and records the reason. The extension must not retry independently in a way that duplicates helper-managed attempts.

If labels, images, attachments, or files cannot be reproduced, the system should degrade by posting visible text and visible URLs when available. Re-uploading files is out of scope for the initial implementation.

## Configuration

Configuration should support multiple source and destination channels:

- global enable/disable
- one or more mappings from source channel URLs to one or more destination channel URLs
- per-mapping enable/disable
- optional message prefix including source channel metadata
- retry settings with default three-attempt exponential backoff
- send pacing to avoid rapid repeated posts

The helper stores canonical config. The extension popup can show status and allow import, export, or reload of config. Direct editing can start as a JSON file and later become a UI if needed.

## Safety Boundaries

The implementation must stay within these boundaries:

- No Discord token extraction.
- No local storage/session storage scraping for credentials.
- No hidden or private Discord API calls.
- No bypassing channel access controls.
- No automatic operation outside user-configured channel mappings.
- No mass broadcast feature beyond explicit source-to-destination mappings.
- Clear logs showing what was copied, where it was posted, and whether reproduction degraded.

## Error Handling

The extension reports structured errors to the helper for:

- source extraction failure
- unsupported Discord DOM shape
- helper connection failure
- destination tab open/focus failure
- composer not found
- paste or send failure
- partial reproduction where labels, images, attachments, or file URLs could not be included

The helper records status transitions for each queued job:

- `queued`
- `in_progress`
- `sent`
- `retry_wait`
- `failed`
- `skipped_duplicate`

## Testing

Initial verification should include:

- schema unit tests for shared payloads and config
- helper queue tests for dedupe, retry, and final failure after three attempts
- extension parser tests using saved Discord-like DOM fixtures
- manual Chrome extension loading through `chrome://extensions`
- manual test with a private Discord test server and at least one source-to-destination mapping

Browser-driven tests should verify that the extension can load, connect to the helper, parse a fixture page, and produce the expected normalized payload. Live Discord posting remains a manual integration test because it depends on an authenticated browser session and Discord UI behavior.

## Non-Goals

- Inviting or managing Discord bots.
- Reading or using Discord bot/user tokens.
- Calling Discord private APIs.
- Re-uploading source attachments in the first version.
- Guaranteeing perfect visual clone fidelity.
- Running as a hosted service.

## Acceptance Criteria

- The repo contains the monorepo structure for the existing extension, new copy/repost extension, helper app, and shared schemas.
- Each bot-helper area has a dedicated implementation branch before merge.
- The helper can persist queued jobs and retry failures up to three total attempts with exponential backoff.
- The copy/repost extension can watch multiple configured source channels and post to multiple configured destination channels through visible Discord web UI.
- Partial reproduction is logged when rich content cannot be captured or posted.
- The system operates without Discord token access or hidden API calls.
