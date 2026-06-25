import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const destinationWindowPath = path.resolve("extensions/copy-repost/src/destination-window.js");

async function loadDestinationWindow() {
  const source = await readFile(destinationWindowPath, "utf8");
  const sandbox = {
    window: {},
    URL
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: destinationWindowPath });

  return sandbox.CopyRepostDestinationWindow;
}

test("choosePostWindowUrl uses the latest stored post URL before fallback", async () => {
  const destinationWindow = await loadDestinationWindow();

  const url = destinationWindow.choosePostWindowUrl({
    postChannelUrls: [
      "https://discord.com/channels/111/222",
      "https://discord.com/channels/333/444"
    ],
    fallbackUrl: "https://discord.com/channels/555/666"
  });

  assert.equal(url, "https://discord.com/channels/333/444");
});

test("choosePostWindowUrl falls back to the job destination URL", async () => {
  const destinationWindow = await loadDestinationWindow();

  const url = destinationWindow.choosePostWindowUrl({
    postChannelUrls: [],
    fallbackUrl: "https://discord.com/channels/555/666/777"
  });

  assert.equal(url, "https://discord.com/channels/555/666");
});

test("normalizeDedicatedWindowState applies conservative defaults", async () => {
  const destinationWindow = await loadDestinationWindow();

  assert.deepEqual(JSON.parse(JSON.stringify(destinationWindow.normalizeDedicatedWindowState({}))), {
    dedicatedPostWindowEnabled: false,
    dedicatedPostWindowMinimized: true,
    closePostWindowsOnShutdown: true,
    managedDestinationWindowId: null,
    managedDestinationTabIds: []
  });
});
