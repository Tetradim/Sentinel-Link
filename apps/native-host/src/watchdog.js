import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { killProcessTree, isProcessRunning } from "./process-tree.js";

const args = parseArgs(process.argv.slice(2));
const hostPid = Number.parseInt(args["host-pid"] ?? "", 10);
const helperPid = Number.parseInt(args["helper-pid"] ?? "", 10);
const stopFile = args["stop-file"] ?? "";
const logFile = args["log-file"] ?? "";

if (!Number.isInteger(hostPid) || !Number.isInteger(helperPid)) {
  await log("watchdog missing host/helper pid");
  process.exit(1);
}

while (true) {
  if (stopFile && existsSync(stopFile)) {
    await log("stop file observed; exiting watchdog");
    process.exit(0);
  }

  if (!isProcessRunning(hostPid)) {
    await log(`host ${hostPid} exited; killing helper ${helperPid}`);
    await killProcessTree(helperPid);
    process.exit(0);
  }

  await delay(1000);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    if (!key) {
      continue;
    }
    parsed[key] = values[index + 1] ?? "";
  }
  return parsed;
}

async function log(message) {
  if (!logFile) {
    return;
  }
  try {
    await appendFile(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Watchdog logging must not prevent cleanup.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
