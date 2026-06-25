import { randomUUID } from "node:crypto";
import { NativeMessageDecoder, encodeNativeMessage } from "./protocol.js";
import { createHelperController } from "./helper-controller.js";

const disconnectShutdownGraceMs = Number.parseInt(process.env.NATIVE_HOST_DISCONNECT_GRACE_MS || "120000", 10);
const controller = createHelperController();
const sessionId = randomUUID();
let disconnectTimer = null;
let shuttingDown = false;

const decoder = new NativeMessageDecoder((message) => {
  void handleMessage(message);
});

process.stdin.on("data", (chunk) => {
  clearDisconnectTimer();
  try {
    decoder.push(chunk);
  } catch (error) {
    writeMessage({ ok: false, error: readableError(error) });
  }
});

process.stdin.on("end", () => {
  scheduleDisconnectShutdown();
});

process.stdin.on("error", () => {
  scheduleDisconnectShutdown();
});

process.on("SIGINT", () => {
  void shutdownAndExit("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdownAndExit("SIGTERM");
});

async function handleMessage(message) {
  const requestId = message?.requestId ?? null;
  try {
    if (message?.type === "ensure-helper") {
      const result = await controller.ensureHelper({
        helperToken: message.helperToken,
        port: message.port,
        timeoutMs: message.timeoutMs
      });
      writeMessage({ requestId, type: "ensure-helper-result", sessionId, ...result });
      return;
    }

    if (message?.type === "heartbeat") {
      const status = await controller.status();
      writeMessage({ requestId, type: "heartbeat-result", sessionId, ...status });
      return;
    }

    if (message?.type === "status") {
      const status = await controller.status();
      writeMessage({ requestId, type: "status-result", sessionId, ...status });
      return;
    }

    if (message?.type === "shutdown") {
      const result = await controller.shutdown();
      writeMessage({ requestId, type: "shutdown-result", sessionId, ...result });
      setTimeout(() => process.exit(0), 50);
      return;
    }

    writeMessage({ requestId, ok: false, error: `unknown native host message: ${message?.type || "missing type"}` });
  } catch (error) {
    writeMessage({ requestId, ok: false, error: readableError(error), sessionId });
  }
}

function scheduleDisconnectShutdown() {
  if (disconnectTimer || shuttingDown) {
    return;
  }
  disconnectTimer = setTimeout(() => {
    void shutdownAndExit("native port disconnected");
  }, disconnectShutdownGraceMs);
}

function clearDisconnectTimer() {
  if (!disconnectTimer) {
    return;
  }
  clearTimeout(disconnectTimer);
  disconnectTimer = null;
}

async function shutdownAndExit(reason) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await controller.shutdown();
  } catch (error) {
    console.error(`native host shutdown after ${reason} failed: ${readableError(error)}`);
  } finally {
    process.exit(0);
  }
}

function writeMessage(message) {
  process.stdout.write(encodeNativeMessage(message));
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}
