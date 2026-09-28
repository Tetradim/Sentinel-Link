import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("copy-repost manifest requests native messaging permission", async () => {
  const manifest = JSON.parse(await readFile("extensions/copy-repost/manifest.json", "utf8"));

  assert.equal(manifest.name, "Sentinel Link");
  assert.equal(manifest.permissions.includes("nativeMessaging"), true);
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.deepEqual(manifest.content_scripts[0].js, [
    "src/parser.js",
    "src/trading-bridge-config.js",
    "src/content.js"
  ]);
});

test("background wires native host startup and shutdown commands", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.match(background, /com\.tetradim\.discord_copy_repost/);
  assert.match(background, /source-routing\.js/);
  assert.match(background, /connectNative/);
  assert.match(background, /launch-helper/);
  assert.match(background, /launchHelper/);
  assert.match(background, /shutdown-all/);
  assert.match(background, /open-dedicated-post-window/);
  assert.match(background, /closeManagedDestinationSurfaces/);
});

test("background coalesces overlapping native helper startup requests", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.match(background, /let nativeHelperEnsurePromise = null/);
  assert.match(background, /if \(nativeHelperEnsurePromise\) \{\s*return nativeHelperEnsurePromise/);
  assert.match(background, /nativeHelperEnsurePromise = ensureNativeHelperOnce/);
  assert.match(background, /nativeHelperEnsurePromise = null/);
});

test("background coalesces content-script recovery per Discord tab", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.match(background, /const contentScriptEnsurePromises = new Map\(\)/);
  assert.match(background, /contentScriptEnsurePromises\.get\(tabId\)/);
  assert.match(background, /contentScriptEnsurePromises\.set\(tabId, ensurePromise\)/);
  assert.match(background, /contentScriptEnsurePromises\.delete\(tabId\)/);
});

test("copy-repost health probes cannot be answered by legacy generic ping listeners", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");
  const content = await readFile("extensions/copy-repost/src/content.js", "utf8");

  assert.match(background, /sendMessage\(tabId, \{ type: "copy-repost:ping" \}\)/);
  assert.match(content, /message\?\.type === "copy-repost:ping"/);
});

test("popup exposes shutdown and dedicated post window controls", async () => {
  const popup = await readFile("extensions/copy-repost/src/popup.html", "utf8");

  assert.match(popup, /id="launch-helper"/);
  assert.match(popup, /id="shutdown-all"/);
  assert.match(popup, /id="dedicated-post-window-enabled"/);
  assert.match(popup, /id="dedicated-post-window-minimized"/);
  assert.match(popup, /id="close-post-windows-on-shutdown"/);
  assert.match(popup, /id="open-dedicated-post-window"/);
});

test("popup exposes combined Echo bridge controls", async () => {
  const popup = await readFile("extensions/copy-repost/src/popup.html", "utf8");
  const popupScript = await readFile("extensions/copy-repost/src/popup.js", "utf8");

  assert.match(popup, /id="bridge-target-url"/);
  assert.match(popup, /id="bridge-heartbeat-url"/);
  assert.match(popup, /id="bridge-api-key"/);
  assert.match(popup, /id="bridge-targets-json"/);
  assert.match(popup, /trading-bridge-config\.js/);
  assert.match(popupScript, /currentBridgeSettings/);
  assert.match(popupScript, /normalizeBridgeTargets/);
  assert.match(popupScript, /forwardExistingOnEnable/);
  assert.match(popupScript, /autoRestartEnabled/);
});

test("popup wires launch helper button", async () => {
  const popup = await readFile("extensions/copy-repost/src/popup.js", "utf8");

  assert.match(popup, /launchHelperButton\.addEventListener\("click", launchHelper\)/);
  assert.match(popup, /sendRuntimeMessage\(\{\s*type: "launch-helper"/);
  assert.match(popup, /launch failed/);
  assert.match(popup, /runtime message timed out/);
});

test("popup auto-saves dedicated window checkbox changes", async () => {
  const popup = await readFile("extensions/copy-repost/src/popup.js", "utf8");

  assert.match(popup, /dedicatedPostWindowEnabledInput\.addEventListener\("change", saveLifecycleSettings\)/);
  assert.match(popup, /dedicatedPostWindowMinimizedInput\.addEventListener\("change", saveLifecycleSettings\)/);
  assert.match(popup, /closePostWindowsOnShutdownInput\.addEventListener\("change", saveLifecycleSettings\)/);
});

test("background creates post windows normally before minimizing them", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.doesNotMatch(background, /chrome\.windows\.create\(\{[\s\S]*state:\s*windowState\.dedicatedPostWindowMinimized\s*\?/);
  assert.match(background, /if \(minimizeOnCreate\) \{\s*await maybeMinimizeManagedWindow\(createdWindow\.id, windowState\)/);
});

test("automatic reposts reuse destination tabs globally and never minimize Chrome", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.match(background, /destinationTabOpenPromises = new Map\(\)/);
  assert.match(background, /findDiscordChannelTab\(tabs, normalizedDestination\.url\)/);
  assert.match(background, /openOrReuseDedicatedDestinationTab\(normalizedDestination\.url, windowState, \{ minimizeOnCreate: false \}\)/);
  assert.match(background, /openOrReuseDedicatedDestinationTab\(url, windowState, \{ minimizeOnCreate: true \}\)/);
});

test("successful content-script injection allows the composer handshake to determine readiness", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.match(background, /ok: true,\s*restarted: true,\s*verified: ready/);
  assert.doesNotMatch(background, /ok: ready,\s*restarted: true/);
});

test("background does not re-minimize a managed window the user restored", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");
  const start = background.indexOf("async function openOrReuseDedicatedDestinationTab");
  const firstCreation = background.indexOf("const createdWindow", start);
  const reusePath = background.slice(start, firstCreation);

  assert.ok(start >= 0 && firstCreation > start);
  assert.doesNotMatch(reusePath, /maybeMinimizeManagedWindow/);
});

test("background carries a newly created dedicated window through the workspace batch", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.match(background, /windowState\.managedDestinationWindowId\s*=\s*createdWindow\.id/);
  assert.match(background, /windowState\.managedDestinationTabIds\s*=\s*addManagedTabId/);
});

test("open post workspace includes configured listen-only channels", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");
  const start = background.indexOf("async function openDedicatedPostWindowFromPopup");
  const end = background.indexOf("async function openOrReuseDedicatedDestinationTab", start);
  const workspaceOpener = background.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(workspaceOpener, /listenOnlyStorageKey/);
  assert.match(workspaceOpener, /listenOnlyChannelUrls:\s*state\[listenOnlyStorageKey\]/);
});

test("direct bridge forwarding applies the configured freshness window", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.match(background, /forwardTradingBridgeMessage[\s\S]+maxMessageAgeMinutesStorageKey/);
  assert.match(background, /forwardTradingBridgeMessage[\s\S]+payloadFreshness/);
  assert.match(background, /ignored stale bridge message/);
});

test("content bridge forwarding is constrained by saved Listen channels", async () => {
  const content = await readFile("extensions/copy-repost/src/content.js", "utf8");

  assert.match(content, /listenChannelUrls/);
  assert.match(content, /isSavedListenChannel/);
  assert.match(content, /ignored_post_channel_for_bridge/);
});
