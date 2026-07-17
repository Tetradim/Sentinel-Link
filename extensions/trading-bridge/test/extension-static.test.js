import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const extensionRoot = path.resolve("extensions/trading-bridge");

async function readText(fileName) {
  return readFile(path.join(extensionRoot, fileName), "utf8");
}

test("trading bridge is a loadable Chrome extension", async () => {
  const manifest = JSON.parse(await readText("manifest.json"));
  const serviceWorker = await readText("service_worker.js");
  const content = await readText("content.js");
  const popup = await readText("popup.html");

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Trading Bridge");
  assert.deepEqual(manifest.content_scripts[0].js, ["bridge_config.js", "content.js"]);
  assert.match(serviceWorker, /importScripts\("bridge_config\.js"\)/);
  assert.match(serviceWorker, /discord-bridge:discord-message/);
  assert.match(serviceWorker, /files: \["bridge_config\.js", "content\.js"\]/);
  assert.match(content, /discord-bridge:bridge-heartbeat/);
  assert.match(content, /discord-bridge:discord-message/);
  assert.match(popup, /targetsJson/);
  assert.match(popup, /autoRestartEnabled/);
  assert.match(popup, /General API/);
  assert.match(serviceWorker, /publishGeneralApiObservation/);
});
