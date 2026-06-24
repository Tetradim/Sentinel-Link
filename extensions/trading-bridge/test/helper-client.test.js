import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const helperClientPath = path.resolve("extensions/trading-bridge/helper-client.js");

async function loadHelperClient(overrides = {}) {
  const source = await readFile(helperClientPath, "utf8");
  const sandbox = {
    console,
    URL,
    ...overrides
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: helperClientPath });

  return sandbox;
}

function guardedStorage(name) {
  return {
    get() {
      throw new Error(`${name} must not be read`);
    }
  };
}

test("submitTradingBridgeAlert posts JSON alerts with explicit helper token", async () => {
  const requests = [];
  const sandbox = await loadHelperClient({
    fetch: async (url, request) => {
      requests.push({ url, request });
      return new Response(JSON.stringify({ queued: true }), { status: 202 });
    },
    localStorage: guardedStorage("localStorage"),
    sessionStorage: guardedStorage("sessionStorage")
  });

  const payload = { sourceUrl: "https://discord.com/channels/111/222", text: "Entry alert" };
  const result = await sandbox.TradingBridgeHelperClient.submitTradingBridgeAlert(payload, {
    helperToken: " test-token "
  });

  assert.equal(result.queued, true);
  assert.equal(requests[0].url, "http://127.0.0.1:17654/events");
  assert.equal(requests[0].request.method, "POST");
  assert.equal(requests[0].request.headers["content-type"], "application/json");
  assert.equal(requests[0].request.headers["x-helper-token"], "test-token");
  assert.deepEqual(JSON.parse(requests[0].request.body), payload);
});

test("submitTradingBridgeAlert reads helper token from chrome storage when option is absent", async () => {
  let storageKey = "";
  let tokenHeader = "";
  const sandbox = await loadHelperClient({
    chrome: {
      storage: {
        local: {
          async get(key) {
            storageKey = key;
            return { helperToken: "stored-token" };
          }
        }
      }
    },
    fetch: async (_url, request) => {
      tokenHeader = request.headers["x-helper-token"];
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }
  });

  await sandbox.TradingBridgeHelperClient.submitTradingBridgeAlert({ text: "Entry alert" });

  assert.equal(storageKey, "helperToken");
  assert.equal(tokenHeader, "stored-token");
});

test("submitTradingBridgeAlert throws before fetch when helper token is unavailable", async () => {
  let fetchCalled = false;
  const sandbox = await loadHelperClient({
    fetch: async () => {
      fetchCalled = true;
      return new Response("{}", { status: 202 });
    },
    chrome: {
      storage: {
        local: {
          async get() {
            return { helperToken: "   " };
          }
        }
      }
    }
  });

  await assert.rejects(
    sandbox.TradingBridgeHelperClient.submitTradingBridgeAlert({ text: "Entry alert" }),
    /helper token is required/
  );
  assert.equal(fetchCalled, false);
});

test("submitTradingBridgeAlert includes status and helper JSON error details for non-OK responses", async () => {
  const sandbox = await loadHelperClient({
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: "A valid helper token is required."
          }
        }),
        { status: 401, statusText: "Unauthorized" }
      )
  });

  await assert.rejects(
    sandbox.TradingBridgeHelperClient.submitTradingBridgeAlert(
      { text: "Entry alert" },
      { helperBaseUrl: "http://127.0.0.1:9999/", helperToken: "wrong-token" }
    ),
    /401 unauthorized: A valid helper token is required\./
  );
});
