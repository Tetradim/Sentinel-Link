# Copy/Repost Native Lifecycle Design

## Goal

Tie the Discord Copy Repost Helper extension to the external helper app so extension startup can start or adopt the helper, Chrome shutdown can stop it, and the popup can shut down the copier stack deliberately.

## Accepted Approach

Use Chrome Native Messaging for the extension-to-desktop lifecycle link. Chrome can start a registered native host process with `runtime.connectNative`; the native host starts or adopts the local helper on `127.0.0.1:17654` and owns cleanup. The native host uses Sentinel-Pulse-style process-tree cleanup and a watchdog so helper processes do not remain orphaned when Chrome or the launcher path disappears.

## Components

- `extensions/copy-repost`: adds `nativeMessaging` permission, connects to `com.tetradim.discord_copy_repost`, sends helper-start heartbeats, exposes a popup shutdown control, and routes destination jobs into a managed post window when enabled.
- `apps/native-host`: Node native messaging host. It implements Chrome's 4-byte-length-prefixed JSON protocol, starts/adopts the helper, launches a watchdog, and kills the helper process tree on explicit shutdown or stale disconnect.
- `scripts/install-copy-repost-native-host.ps1`: registers the native messaging host for the current Windows user and the installed Copy/Repost extension ID.
- `apps/external-helper`: remains the HTTP queue/helper service. It does not start Chrome and does not own extension state.

## Dedicated Post Window

The dedicated post target is a managed Chrome window in the same Chrome profile, not a separate profile. This keeps the user's Discord login and installed extension available without creating a second extension instance. When enabled, repost jobs use that managed window/tab and avoid activating destination tabs in the user's main Chrome window. The popup can open the post window to the latest stored Post URL, keep it minimized, and close it during shutdown.

## Shutdown Semantics

The popup shutdown button disables the copier, clears polling alarms, optionally closes managed post tabs/windows, sends a native-host shutdown command, stops the watchdog, and updates status. If the extension/native host disconnects without an explicit shutdown, the host waits through a grace period before stopping the helper so transient MV3 service-worker restarts do not immediately kill the app.

## Non-Goals

- Do not read Discord user tokens or call hidden Discord APIs.
- Do not close arbitrary user Discord tabs that the extension did not create or mark as managed.
- Do not require a separate Discord login/profile for `#echo`.
