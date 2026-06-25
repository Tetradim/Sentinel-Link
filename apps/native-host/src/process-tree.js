import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function killProcessTree(processId, options = {}) {
  const pid = Number.parseInt(processId, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { killed: false, reason: "invalid pid" };
  }

  if ((options.platform ?? process.platform) === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: options.timeoutMs ?? 10_000
      });
      return { killed: true, pid };
    } catch (error) {
      if (String(error?.stdout || error?.stderr || error?.message || "").includes("not found")) {
        return { killed: false, pid, reason: "process not found" };
      }
      throw error;
    }
  }

  try {
    process.kill(pid, "SIGTERM");
    return { killed: true, pid };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { killed: false, pid, reason: "process not found" };
    }
    throw error;
  }
}

export function isProcessRunning(processId) {
  const pid = Number.parseInt(processId, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
