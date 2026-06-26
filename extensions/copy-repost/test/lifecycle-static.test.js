import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("copy-repost manifest requests native messaging permission", async () => {
  const manifest = JSON.parse(await readFile("extensions/copy-repost/manifest.json", "utf8"));

  assert.equal(manifest.permissions.includes("nativeMessaging"), true);
  assert.equal(manifest.background.service_worker, "src/background.js");
});

test("background wires native host startup and shutdown commands", async () => {
  const background = await readFile("extensions/copy-repost/src/background.js", "utf8");

  assert.match(background, /com\.tetradim\.discord_copy_repost/);
  assert.match(background, /connectNative/);
  assert.match(background, /launch-helper/);
  assert.match(background, /launchHelper/);
  assert.match(background, /shutdown-all/);
  assert.match(background, /open-dedicated-post-window/);
  assert.match(background, /closeManagedDestinationSurfaces/);
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

test("popup wires launch helper button", async () => {
  const popup = await readFile("extensions/copy-repost/src/popup.js", "utf8");

  assert.match(popup, /launchHelperButton\.addEventListener\("click", launchHelper\)/);
  assert.match(popup, /chrome\.runtime\.sendMessage\(\{\s*type: "launch-helper"/);
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
  assert.match(background, /await maybeMinimizeManagedWindow\(createdWindow\.id, windowState\)/);
});
