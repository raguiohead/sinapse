import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SINAPSE_HOME lets tests and parallel setups use an isolated data dir without touching the real ~/.sinapse.
export function sinapseDir(): string {
  return process.env.SINAPSE_HOME || path.join(os.homedir(), ".sinapse");
}

/** Where a workspace's git worktrees live: <data>/workspaces/<id>/worktrees. `workspaceId` must already be validated. */
export function worktreesDir(workspaceId: string): string {
  return path.join(sinapseDir(), "workspaces", workspaceId, "worktrees");
}

/** Nearest bin directory containing the `sinapse` CLI (resourcesPath in packaged app, or walking up node_modules/.bin in dev). */
export function findCliBinDir(): string | undefined {
  const binName = process.platform === "win32" ? "sinapse.cmd" : "sinapse";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const candidate = path.join(resourcesPath, "bin");
    if (fs.existsSync(path.join(candidate, binName))) return candidate;
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, "node_modules", ".bin");
    if (fs.existsSync(path.join(candidate, binName))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
