import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { killProcessTree } from "./process-tree.js";

const execFileAsync = promisify(execFile);
const srcDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(srcDir, "../../..");

export function createHelperController(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const port = options.port ?? Number.parseInt(process.env.HELPER_PORT || "17654", 10);
  const dataDir = options.dataDir ?? resolve(repoRoot, "apps", "external-helper", "data");
  const helperScript = options.helperScript ?? resolve(repoRoot, "apps", "external-helper", "src", "main.js");
  const defaultConfigPath = existsSync(resolve(repoRoot, "apps", "external-helper", "config", "config.local.json"))
    ? resolve(repoRoot, "apps", "external-helper", "config", "config.local.json")
    : resolve(repoRoot, "apps", "external-helper", "config", "config.example.json");
  const configPath = options.configPath ?? process.env.HELPER_CONFIG ?? defaultConfigPath;
  const statePath = options.statePath ?? process.env.HELPER_STATE ?? resolve(dataDir, "state.json");
  const logPath = options.logPath ?? resolve(dataDir, "native-helper.log");
  const errLogPath = options.errLogPath ?? resolve(dataDir, "native-helper.err.log");
  const watchdogStopFile = options.watchdogStopFile ?? resolve(dataDir, `native-watchdog-${process.pid}.stop`);

  let helperPid = null;
  let helperProcess = null;
  let watchdogProcess = null;

  const deps = {
    isPortOpen,
    findManagedHelperPidOnPort,
    startHelperProcess,
    waitForHelper,
    startWatchdog: startWatchdogProcess,
    stopWatchdog: stopWatchdogProcess,
    killProcessTree,
    ...options
  };

  async function ensureHelper(request = {}) {
    const helperToken = normalizeToken(request.helperToken ?? options.helperToken ?? process.env.HELPER_TOKEN);
    if (!helperToken) {
      throw new Error("helperToken is required to start helper");
    }

    const requestedPort = request.port ?? port;
    if (await deps.isPortOpen(requestedPort)) {
      const detectedPid = await deps.findManagedHelperPidOnPort(requestedPort);
      helperPid = detectedPid ?? helperPid;
      if (helperPid) {
        await deps.startWatchdog({ helperPid, stopFile: watchdogStopFile });
      }
      return {
        ok: true,
        running: true,
        started: false,
        adopted: Boolean(detectedPid),
        pid: detectedPid ?? null,
        port: requestedPort
      };
    }

    helperProcess = await deps.startHelperProcess({
      repoRoot,
      helperScript,
      helperToken,
      port: requestedPort,
      configPath,
      statePath,
      logPath,
      errLogPath
    });
    helperPid = helperProcess?.pid ?? null;

    const ready = await deps.waitForHelper({
      port: requestedPort,
      helperToken,
      timeoutMs: request.timeoutMs ?? 30_000
    });
    if (!ready) {
      throw new Error(`helper did not become ready on port ${requestedPort}`);
    }

    if (helperPid) {
      await deps.startWatchdog({ helperPid, stopFile: watchdogStopFile });
    }

    return {
      ok: true,
      running: true,
      started: true,
      adopted: false,
      pid: helperPid,
      port: requestedPort
    };
  }

  async function status() {
    return {
      ok: true,
      running: await deps.isPortOpen(port),
      pid: helperPid,
      port
    };
  }

  async function shutdown() {
    await deps.stopWatchdog({ stopFile: watchdogStopFile, watchdogProcess });
    const pid = helperPid ?? helperProcess?.pid ?? null;
    if (pid) {
      await deps.killProcessTree(pid);
      helperPid = null;
      helperProcess = null;
      return { ok: true, stopped: true, pid };
    }
    return { ok: true, stopped: false, pid: null };
  }

  async function startHelperProcess(startOptions) {
    await mkdir(dirname(startOptions.logPath), { recursive: true });
    const stdout = createWriteStream(startOptions.logPath, { flags: "a" });
    const stderr = createWriteStream(startOptions.errLogPath, { flags: "a" });
    const child = spawn(process.execPath, [startOptions.helperScript], {
      cwd: startOptions.repoRoot,
      env: {
        ...process.env,
        HELPER_TOKEN: startOptions.helperToken,
        HELPER_PORT: String(startOptions.port),
        HELPER_CONFIG: startOptions.configPath,
        HELPER_STATE: startOptions.statePath
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    return child;
  }

  async function startWatchdogProcess({ helperPid: pid, stopFile }) {
    if (watchdogProcess && !watchdogProcess.killed) {
      return { pid: watchdogProcess.pid };
    }

    await mkdir(dirname(stopFile), { recursive: true });
    await rm(stopFile, { force: true });
    const watchdogScript = resolve(srcDir, "watchdog.js");
    watchdogProcess = spawn(process.execPath, [
      watchdogScript,
      "--host-pid",
      String(process.pid),
      "--helper-pid",
      String(pid),
      "--stop-file",
      stopFile,
      "--log-file",
      resolve(dataDir, "native-watchdog.log")
    ], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    watchdogProcess.unref();
    return { pid: watchdogProcess.pid };
  }

  async function stopWatchdogProcess({ stopFile } = {}) {
    if (stopFile) {
      await mkdir(dirname(stopFile), { recursive: true });
      await writeFile(stopFile, "stop", "utf8");
    }
    watchdogProcess = null;
  }

  return {
    ensureHelper,
    status,
    shutdown
  };
}

export async function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function waitForHelper({ port, helperToken, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { "x-helper-token": helperToken }
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // Keep polling until the helper binds and accepts the token.
    }
    await delay(250);
  }
  return false;
}

export async function findManagedHelperPidOnPort(port) {
  if (process.platform !== "win32") {
    return null;
  }

  const script = [
    `$owners = @(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)`,
    "$items = @()",
    "foreach ($owner in $owners) {",
    "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $owner\" -ErrorAction SilentlyContinue",
    "  if ($p) { $items += [pscustomobject]@{ ProcessId = $p.ProcessId; CommandLine = $p.CommandLine } }",
    "}",
    "$items | ConvertTo-Json -Compress"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      timeout: 5000
    });
    const text = stdout.trim();
    if (!text) {
      return null;
    }
    const parsed = JSON.parse(text);
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    const match = processes.find((item) => isManagedHelperCommandLine(item?.CommandLine));
    return match ? Number(match.ProcessId) : null;
  } catch {
    return null;
  }
}

export function isManagedHelperCommandLine(commandLine) {
  return normalizeToken(commandLine)
    .replaceAll("\\", "/")
    .includes("apps/external-helper/src/main.js");
}

function normalizeToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
