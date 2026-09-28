import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const src = path.resolve("extensions/copy-repost/src");
const sourceUrl = "https://discord.com/channels/111/222";

function runtime(state = {}) {
  const nodes = new Map();
  const sandbox = {
    URL, Date, console, setTimeout, clearTimeout, AbortController,
    fetch: async () => { throw new Error("unexpected outbound request"); },
    window: { setTimeout, clearTimeout },
    document: {
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, {
          value: "", textContent: "", checked: false, dataset: {}, children: [],
          classList: { add() {}, remove() {}, toggle() {} },
          addEventListener() {}, replaceChildren() { this.children = []; },
          append(child) { this.children.push(child); }
        });
        return nodes.get(selector);
      },
      createElement: () => ({})
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === "string") return { [keys]: state[keys] };
            return Array.isArray(keys) ? Object.fromEntries(keys.map(key => [key, state[key]])) : { ...keys, ...state };
          },
          async set(values) { Object.assign(state, values); }
        },
        onChanged: { addListener() {} }
      },
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
      alarms: { get: async () => ({ periodInMinutes: 1 }), create: async () => {}, onAlarm: { addListener() {} } }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const load = name => vm.runInContext(readFileSync(path.join(src, name), "utf8"), context, { filename: name });
  sandbox.importScripts = (...names) => names.forEach(load);
  return { sandbox, context, load, state, nodes };
}

test("listen-only worker forwards enrollment proof to Echo API but suppresses previously queued reposts", async () => {
  const { sandbox, load, state } = runtime({ listenOnlyChannelUrls: [sourceUrl] });
  const requests = [];
  sandbox.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, text: async () => JSON.stringify({ status: "accepted" }) };
  };
  load("background.js");
  const result = await sandbox.forwardTradingBridgePayload({ channel_id: "222", channel_url: sourceUrl, source_mode: "listen-only" }, "message");
  assert.equal(result.status, "accepted");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /chrome-bridge\/message$/);
  assert.equal(requests[0].body.channel_id, "222");
  assert.equal(requests[0].body.source_mode, "listen-only");
  await assert.rejects(sandbox.assertRepostAllowed({ payload: { sourceUrl } }), /listen-only/);
  await sandbox.assertRepostAllowed({ payload: { sourceChannelId: "333" } });
  state.listenOnlyChannelUrls = [];
  await sandbox.assertRepostAllowed({ payload: { sourceUrl } });
});

test("listen-only popup locks, rejects duplicates, restores, reverts, and clears without touching repost routes", async () => {
  const { load, sandbox, nodes, state } = runtime({ listenChannelUrls: [sourceUrl], postChannelUrls: ["https://discord.com/channels/111/333"] });
  for (const file of ["channel-routes.js", "freshness.js", "destination-window.js", "trading-bridge-config.js", "popup.js"]) load(file);
  await new Promise(resolve => setImmediate(resolve));
  const input = nodes.get("#listen-only-url");
  input.value = "not-a-channel";
  await sandbox.updateListenOnlyUrls("lock");
  assert.equal(nodes.get("#listen-only-message").dataset.state, "error");
  input.value = sourceUrl;
  await sandbox.updateListenOnlyUrls("lock");
  assert.equal(state.listenOnlyChannelUrls[0], sourceUrl);
  assert.equal(input.value, "");
  input.value = sourceUrl;
  await sandbox.updateListenOnlyUrls("lock");
  assert.match(nodes.get("#listen-only-message").textContent, /duplicate/);
  assert.equal(state.listenOnlyChannelUrls.length, 1);
  await sandbox.loadState();
  assert.equal(nodes.get("#listen-only-stored-urls").children[0].value, sourceUrl);
  await sandbox.updateListenOnlyUrls("revert");
  assert.equal(input.value, sourceUrl);
  assert.equal(state.listenOnlyChannelUrls.length, 0);
  await sandbox.updateListenOnlyUrls("lock");
  await sandbox.updateListenOnlyUrls("clear");
  assert.equal(state.listenOnlyChannelUrls.length, 0);
  assert.deepEqual(state.listenChannelUrls, [sourceUrl]);
  assert.deepEqual(state.postChannelUrls, ["https://discord.com/channels/111/333"]);
});
