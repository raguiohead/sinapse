import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

function descendantsOf(pid: number): number[] {
  const ps = spawnSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" });
  if (ps.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

export const TURN_MARKER = "SINAPSE_TURN_SESSION";

// Markers of the Claude Code session that launched Sinapse (e.g. `npm start` from a Claude Code terminal).
// Inherited, they make the brain/workers believe they are its child sessions (transcripts off, so no
// usage or resume) and expose that session's messaging socket. User config vars are left untouched.
const PARENT_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_EFFORT",
  "CLAUDE_JOB_DIR",
  "CLAUDE_PID",
];

export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of PARENT_SESSION_VARS) delete env[name];
  return env;
}

/**
 * Some children (MCP servers) detach from the CLI that started them, so no tree walk finds them.
 * They still inherit the env, so callers tag a spawn with a unique NAME=value and sweep it afterwards (Linux /proc only).
 */
export function sweepEnvMarker(name: string, value: string): void {
  if (process.platform !== "linux" || !value) return;
  const marker = `${name}=${value}`;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!pid || pid === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(marker)) {
        process.kill(pid, "SIGTERM");
      }
    } catch {}
  }
}

/** Terminates a CLI and everything it started (shell commands, MCP servers), even those in other process groups. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      child.on("error", () => {});
    } catch {}
    return;
  }
  // Snapshot the tree first: once the parent dies its children are reparented and can't be found.
  for (const target of [...descendantsOf(pid), pid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch (err: any) {
      if (err?.code !== "ESRCH") throw err;
    }
  }
}
