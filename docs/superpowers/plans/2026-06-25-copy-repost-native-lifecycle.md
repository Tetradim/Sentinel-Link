# Copy/Repost Native Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native-host lifecycle control and a managed dedicated post window for the Discord Copy Repost Helper.

**Architecture:** The extension remains the Discord observer/poster. A new Node native messaging host owns local helper startup/shutdown and process cleanup. The extension popup stores lifecycle/window settings and sends background commands for shutdown and opening the managed destination window.

**Tech Stack:** Chrome MV3 extension APIs, Chrome Native Messaging, Node.js `node:test`, PowerShell Windows registration, existing localhost helper.

---

### Task 1: Native Host Protocol And Lifecycle

**Files:**
- Create: `apps/native-host/src/protocol.js`
- Create: `apps/native-host/src/process-tree.js`
- Create: `apps/native-host/src/helper-controller.js`
- Create: `apps/native-host/src/watchdog.js`
- Create: `apps/native-host/src/main.js`
- Create: `apps/native-host/test/protocol.test.js`
- Create: `apps/native-host/test/helper-controller.test.js`
- Modify: `package.json`

- [ ] Write failing tests for native message frame encoding/decoding and helper controller startup/shutdown command behavior.
- [ ] Implement the native messaging protocol with 32-bit little-endian JSON frames.
- [ ] Implement helper controller start/adopt/shutdown behavior for `apps/external-helper/src/main.js`.
- [ ] Implement watchdog process-tree cleanup for native host failure.
- [ ] Add tests to the root `npm test` command.

### Task 2: Extension Native Lifecycle

**Files:**
- Modify: `extensions/copy-repost/manifest.json`
- Modify: `extensions/copy-repost/src/background.js`
- Create: `extensions/copy-repost/test/lifecycle-static.test.js`

- [ ] Write failing static tests for `nativeMessaging` permission, native host connection, shutdown command handling, and dedicated post window command handling.
- [ ] Add native host connection/request helpers in the service worker.
- [ ] Start/adopt the helper on install/startup/poll when a helper token is configured.
- [ ] Add a `shutdown-all` background command that disables parsing, clears polling, closes managed destination surfaces, and asks the native host to stop helper/watchdog.

### Task 3: Dedicated Post Window

**Files:**
- Create: `extensions/copy-repost/src/destination-window.js`
- Create: `extensions/copy-repost/test/destination-window.test.js`
- Modify: `extensions/copy-repost/src/background.js`

- [ ] Write failing tests for choosing the latest stored Post URL and normalizing dedicated-window settings.
- [ ] Add a small destination-window helper script loaded by the background service worker and popup tests.
- [ ] Route repost jobs to a managed Chrome window when `dedicatedPostWindowEnabled` is true.
- [ ] Track managed window/tab IDs and close only those managed surfaces on shutdown when enabled.

### Task 4: Popup Controls And Installer

**Files:**
- Modify: `extensions/copy-repost/src/popup.html`
- Modify: `extensions/copy-repost/src/popup.js`
- Modify: `extensions/copy-repost/src/styles.css`
- Create: `scripts/install-copy-repost-native-host.ps1`
- Modify: `README.md`
- Modify: `extensions/copy-repost/README.md`

- [ ] Add popup controls for Shutdown, dedicated post window enablement, minimized post window, close managed post tabs on shutdown, and Open Post Window.
- [ ] Register event handlers that save settings and send background commands.
- [ ] Add the Windows native host installer script with the current extension ID default.
- [ ] Update README instructions for installing, reloading, running, and shutting down the lifecycle-linked helper.

### Task 5: Verification And Publish

**Files:**
- All changed files

- [ ] Run focused tests for native host and extension behavior.
- [ ] Run full `npm test`.
- [ ] Run syntax checks for new Node scripts and changed extension scripts.
- [ ] Install/register the native host locally.
- [ ] Commit and push to `origin/main`.
