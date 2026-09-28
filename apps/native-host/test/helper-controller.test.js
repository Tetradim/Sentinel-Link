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

test("helper controller coalesces concurrent startup requests", async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  let startCount = 0;
  let watchdogCount = 0;
  const controller = createHelperController({
    port: 17654,
    helperToken: "test-token",
    isPortOpen: async () => false,
    findManagedHelperPidOnPort: async () => null,
    startHelperProcess: async () => {
      startCount += 1;
      await startGate;
      return { pid: 3333 };
    },
    waitForHelper: async () => true,
    startWatchdog: async () => {
      watchdogCount += 1;
    }
  });

  const first = controller.ensureHelper();
  const second = controller.ensureHelper();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(startCount, 1);
  releaseStart();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(watchdogCount, 1);
});

test("helper controller shutdown waits for an in-flight startup before killing it", async () => {
  let releaseStart;
  let notifyStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const started = new Promise((resolve) => {
    notifyStart = resolve;
  });
  const calls = [];
  const controller = createHelperController({
    port: 17654,
    helperToken: "test-token",
    isPortOpen: async () => false,
    findManagedHelperPidOnPort: async () => null,
    startHelperProcess: async () => {
      notifyStart();
      await startGate;
      return { pid: 4444 };
    },
    waitForHelper: async () => true,
    startWatchdog: async () => calls.push(["watchdog"]),
    stopWatchdog: async () => calls.push(["stop-watchdog"]),
    killProcessTree: async (pid) => calls.push(["kill", pid])
  });

  const ensure = controller.ensureHelper();
  await started;
  const shutdown = controller.shutdown();
  releaseStart();

  await ensure;
  const result = await shutdown;
  assert.equal(result.stopped, true);
  assert.deepEqual(calls, [["watchdog"], ["stop-watchdog"], ["kill", 4444]]);
});
