import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const routesPath = path.resolve("extensions/copy-repost/src/channel-routes.js");

async function loadRoutes() {
  const source = await readFile(routesPath, "utf8");
  const sandbox = {
    window: {},
    URL
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: routesPath });

  return sandbox.CopyRepostChannelRoutes;
}

function fromSandbox(value) {
  return JSON.parse(JSON.stringify(value));
}

test("channel routes normalize Discord channel URLs before storing them", async () => {
  const routes = await loadRoutes();

  const result = routes.addChannelUrl([], "https://discord.com/channels/111/222/333");

  assert.deepEqual(fromSandbox(result.urls), ["https://discord.com/channels/111/222"]);
  assert.equal(result.addedUrl, "https://discord.com/channels/111/222");
});

test("channel routes reject duplicate stored URLs", async () => {
  const routes = await loadRoutes();
  const existing = ["https://discord.com/channels/111/222"];

  assert.throws(
    () => routes.addChannelUrl(existing, "https://discord.com/channels/111/222"),
    /duplicate Discord channel URL/
  );
});

test("channel routes revert the most recently stored URL", async () => {
  const routes = await loadRoutes();

  const result = routes.revertLastChannelUrl([
    "https://discord.com/channels/111/222",
    "https://discord.com/channels/333/444"
  ]);

  assert.deepEqual(fromSandbox(result.urls), ["https://discord.com/channels/111/222"]);
  assert.equal(result.removedUrl, "https://discord.com/channels/333/444");
});

test("channel routes build one mapping per listen URL with all post URLs", async () => {
  const routes = await loadRoutes();

  const config = routes.buildRuntimeConfig({
    listenChannelUrls: [
      "https://discord.com/channels/111/222",
      "https://discord.com/channels/333/444"
    ],
    postChannelUrls: ["https://discord.com/channels/555/666"],
    prefix: "[copied-alert]"
  });

  assert.equal(config.enabled, true);
  assert.deepEqual(fromSandbox(config.mappings), [
    {
      id: "popup-route-222",
      enabled: true,
      sourceUrl: "https://discord.com/channels/111/222",
      destinationUrls: ["https://discord.com/channels/555/666"],
      prefix: "[copied-alert]"
    },
    {
      id: "popup-route-444",
      enabled: true,
      sourceUrl: "https://discord.com/channels/333/444",
      destinationUrls: ["https://discord.com/channels/555/666"],
      prefix: "[copied-alert]"
    }
  ]);
});

test("channel routes format stored URL dropdown options", async () => {
  const routes = await loadRoutes();

  const options = routes.toStoredUrlOptions(
    [
      "https://discord.com/channels/111/222",
      "https://discord.com/channels/333/444"
    ],
    "No listen URLs locked"
  );

  assert.deepEqual(fromSandbox(options), [
    {
      value: "https://discord.com/channels/111/222",
      label: "1. https://discord.com/channels/111/222"
    },
    {
      value: "https://discord.com/channels/333/444",
      label: "2. https://discord.com/channels/333/444"
    }
  ]);
  assert.deepEqual(fromSandbox(routes.toStoredUrlOptions([], "No post URLs locked")), [
    {
      value: "",
      label: "No post URLs locked"
    }
  ]);
});
