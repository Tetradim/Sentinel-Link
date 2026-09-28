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
  const parser = await readText("parser.js");
  const canonicalParser = await readFile(path.resolve("extensions/copy-repost/src/parser.js"), "utf8");
  const content = await readText("content.js");
  const popup = await readText("popup.html");

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Trading Bridge");
  assert.deepEqual(manifest.content_scripts[0].js, ["parser.js", "bridge_config.js", "content.js"]);
  assert.match(serviceWorker, /importScripts\("bridge_config\.js"\)/);
  assert.match(serviceWorker, /discord-bridge:discord-message/);
  assert.match(serviceWorker, /files: \["parser\.js", "bridge_config\.js", "content\.js"\]/);
  assert.match(parser, /DiscordCopyRepostParser/);
  assert.equal(parser, canonicalParser);
  assert.match(content, /extractAlertFromMessageNode/);
  assert.match(content, /characterData: true/);
  assert.match(content, /discord-bridge:bridge-heartbeat/);
  assert.match(content, /discord-bridge:discord-message/);
  assert.match(popup, /targetsJson/);
  assert.match(popup, /autoRestartEnabled/);
});
