import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/protocol.js";

test("compiled native host launcher forwards native messaging frames", async (t) => {
  if (process.platform !== "win32") {
    t.skip("compiled launcher is only installed on Windows");
    return;
  }

  const launcherPath = resolve("apps/native-host/bin/copy-repost-native-host.exe");
  await access(launcherPath);

  const child = spawn(launcherPath, [], {
    cwd: resolve("."),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const response = new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error(`timed out waiting for native launcher response; stderr=${stderr.trim()}`));
    }, 5000);

    const decoder = new NativeMessageDecoder((message) => {
      clearTimeout(timeout);
      resolveResponse(message);
    });

    child.stdout.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  child.stdin.write(encodeNativeMessage({ requestId: "launcher-test", type: "status" }));

  const message = await response;
  child.stdin.end(encodeNativeMessage({ requestId: "launcher-test-shutdown", type: "shutdown" }));
  await Promise.race([once(child, "exit"), wait(1000).then(() => killProcessTree(child.pid))]);

  assert.equal(message.requestId, "launcher-test");
  assert.equal(message.type, "status-result");
  assert.equal(message.ok, true);
});

function killProcessTree(pid) {
  if (!pid || process.platform !== "win32") {
    return;
  }

  spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
