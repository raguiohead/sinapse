import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorktreeInfo } from "./types.js";

export class GitError extends Error {}

const WORKTREE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || "").trim() || err.message;
          reject(new GitError(detail));
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

export function isValidWorktreeName(name: string): boolean {
  return WORKTREE_NAME_REGEX.test(name) && !name.includes("..") && !name.endsWith(".lock") && !name.endsWith(".");
}

/**
 * Creates `sinapse/<name>` as a new worktree under `targetRoot/<name>` from the repo that contains `cwd`.
 * Returns the info to store and the cwd the worker should use (same subfolder as `cwd`, inside the worktree).
 */
export async function createWorktree(
  cwd: string,
  name: string,
  targetRoot: string
): Promise<{ info: WorktreeInfo; cwd: string }> {
  if (!isValidWorktreeName(name)) {
    throw new GitError(
      `Nome "${name}" não pode virar branch/pasta de worktree (use letras, números, ".", "_" e "-")`
    );
  }

  let repo: string;
  try {
    repo = path.resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch (err) {
    if (err instanceof GitError && /ENOENT/.test(err.message)) {
      throw new GitError("git não encontrado no PATH");
    }
    throw new GitError(`"${cwd}" não é um repositório git; worktree não pode ser criada`);
  }

  let base: string;
  try {
    base = (await git(repo, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    throw new GitError(`O repositório "${repo}" não tem nenhum commit; crie um commit antes de usar worktree`);
  }

  const branch = `sinapse/${name}`;
  const branchExists = await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false
  );
  if (branchExists) {
    throw new GitError(`A branch "${branch}" já existe em "${repo}"; remova-a ou escolha outro nome`);
  }

  const wtPath = path.join(targetRoot, name);
  if (await fs.stat(wtPath).then(() => true, () => false)) {
    throw new GitError(`A pasta "${wtPath}" já existe; remova-a ou escolha outro nome`);
  }
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });

  try {
    await git(repo, ["worktree", "add", "-b", branch, wtPath]);
  } catch (err) {
    throw new GitError(`git worktree add falhou: ${(err as Error).message}`);
  }

  const rel = path.relative(repo, cwd);
  const inner = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(wtPath, rel) : wtPath;
  return { info: { path: wtPath, branch, repo, base }, cwd: inner };
}

export interface WorktreeCleanup {
  action: "removed" | "kept";
  reason?: string;
}

/** Removes the worktree and its branch only when nothing would be lost (or when `force`). Never merges. */
export async function removeWorktree(wt: WorktreeInfo, force: boolean): Promise<WorktreeCleanup> {
  const exists = await fs.stat(wt.path).then(() => true, () => false);

  if (!force) {
    if (exists) {
      let status: string;
      try {
        status = await git(wt.path, ["status", "--porcelain"]);
      } catch (err) {
        return { action: "kept", reason: `não foi possível verificar a worktree (${(err as Error).message})` };
      }
      if (status.trim()) return { action: "kept", reason: "há alterações não commitadas" };
    }
    if (!wt.base) return { action: "kept", reason: "base da branch desconhecida; não dá para saber se há commits novos" };
    try {
      const head = (await git(wt.repo, ["rev-parse", "--verify", `refs/heads/${wt.branch}`])).trim();
      if (head !== wt.base) return { action: "kept", reason: "a branch tem commits novos" };
    } catch {
      // Branch already gone: only the (clean) directory is left to remove.
    }
  }

  try {
    if (exists) {
      await git(wt.repo, ["worktree", "remove", ...(force ? ["--force"] : []), wt.path]);
    } else {
      await git(wt.repo, ["worktree", "prune"]);
    }
  } catch (err) {
    return { action: "kept", reason: `git worktree remove falhou: ${(err as Error).message}` };
  }
  try {
    await git(wt.repo, ["branch", "-D", wt.branch]);
  } catch {
    // Branch was already deleted; nothing left to clean.
  }
  return { action: "removed" };
}
