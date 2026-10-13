import { spawn } from "node:child_process";

export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
      child.on("error", () => {
        // ignore errors if taskkill fails or is not found
      });
    } catch {
      // ignore spawn errors
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err: any) {
      if (err?.code !== "ESRCH") {
        throw err;
      }
    }
  }
}
