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

test("chooseWorkspaceUrls opens all unique listen, listen-only, and post channels", async () => {
  const destinationWindow = await loadDestinationWindow();

  const urls = destinationWindow.chooseWorkspaceUrls({
    listenChannelUrls: [
      "https://discord.com/channels/111/222",
      "https://discord.com/channels/333/444"
    ],
    listenOnlyChannelUrls: [
      "https://discord.com/channels/777/888",
      "https://discord.com/channels/111/222"
    ],
    postChannelUrls: [
      "https://discord.com/channels/333/444",
      "https://discord.com/channels/555/666"
    ]
  });

  assert.deepEqual(JSON.parse(JSON.stringify(urls)), [
    "https://discord.com/channels/111/222",
    "https://discord.com/channels/333/444",
    "https://discord.com/channels/777/888",
    "https://discord.com/channels/555/666"
  ]);
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

test("findDiscordChannelTab reuses an already loaded destination tab", async () => {
  const destinationWindow = await loadDestinationWindow();
  const tab = destinationWindow.findDiscordChannelTab([
    { id: 11, url: "https://discord.com/channels/111/222/333" },
    { id: 12, url: "https://discord.com/channels/333/444" }
  ], "https://discord.com/channels/111/222");

  assert.equal(tab?.id, 11);
});

test("findDiscordChannelTab reuses a destination tab that is still navigating", async () => {
  const destinationWindow = await loadDestinationWindow();
  const tab = destinationWindow.findDiscordChannelTab([
    {
      id: 21,
      url: "chrome://newtab/",
      pendingUrl: "https://discord.com/channels/111/222"
    }
  ], "https://discord.com/channels/111/222");

  assert.equal(tab?.id, 21);
});

test("findDiscordChannelTab does not confuse different Discord channels", async () => {
  const destinationWindow = await loadDestinationWindow();
  const tab = destinationWindow.findDiscordChannelTab([
    { id: 31, url: "https://discord.com/channels/111/223" }
  ], "https://discord.com/channels/111/222");

  assert.equal(tab, null);
});
