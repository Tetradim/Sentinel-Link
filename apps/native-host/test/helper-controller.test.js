import test from "node:test";
import assert from "node:assert/strict";
import { createHelperController } from "../src/helper-controller.js";

test("helper controller starts helper when port is closed", async () => {
  const calls = [];
  const controller = createHelperController({
    port: 17654,
    helperToken: "test-token",
    isPortOpen: async () => false,
    findManagedHelperPidOnPort: async () => null,
    startHelperProcess: async (options) => {
      calls.push(["start", options.helperToken, options.port]);
      return { pid: 1234 };
    },
    waitForHelper: async () => true,
    startWatchdog: async (options) => calls.push(["watchdog", options.helperPid])
  });

  const result = await controller.ensureHelper();

  assert.equal(result.started, true);
  assert.equal(result.pid, 1234);
  assert.deepEqual(calls, [
    ["start", "test-token", 17654],
    ["watchdog", 1234]
  ]);
});

test("helper controller adopts managed helper already on port", async () => {
  const calls = [];
  const controller = createHelperController({
    port: 17654,
    helperToken: "test-token",
    isPortOpen: async () => true,
    findManagedHelperPidOnPort: async () => 2222,
    startHelperProcess: async () => {
      throw new Error("should not start");
    },
    waitForHelper: async () => true,
    startWatchdog: async (options) => calls.push(["watchdog", options.helperPid])
  });

  const result = await controller.ensureHelper();

  assert.equal(result.started, false);
  assert.equal(result.adopted, true);
  assert.equal(result.pid, 2222);
  assert.deepEqual(calls, [["watchdog", 2222]]);
});

test("helper controller shutdown kills adopted helper and stops watchdog", async () => {
  const calls = [];
  const controller = createHelperController({
    port: 17654,
    helperToken: "test-token",
    isPortOpen: async () => true,
    findManagedHelperPidOnPort: async () => 2222,
    waitForHelper: async () => true,
    startWatchdog: async () => calls.push(["watchdog"]),
    stopWatchdog: async () => calls.push(["stop-watchdog"]),
    killProcessTree: async (pid) => calls.push(["kill", pid])
  });

  await controller.ensureHelper();
  const result = await controller.shutdown();

  assert.equal(result.stopped, true);
  assert.deepEqual(calls, [["watchdog"], ["stop-watchdog"], ["kill", 2222]]);
});
