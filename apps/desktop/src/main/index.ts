import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import type {
  DaemonEvent,
  ContextUsage,
  ModelCatalog,
  NoteSummary,
  Note,
  AgentState,
  HandoffResponse,
  Workspace,
  TurnRecord,
  AgentDeleteResult,
  SquadApplyResult,
  SquadCatalog,
} from "@sinapse/core";
import {
  IPC,
  type SquadApplyPayload,
  type DaemonInfo,
  type WorkerAskPayload,
  type WorkerSpawnPayload,
  type WorkerUpdatePayload,
  type WorkerDiffResult,
  type NoteWritePayload,
  type BrainInfo,
  type DesktopSettings,
  type DesktopSettingsPatch,
  type FolderKey,
  type DaemonDetails,
  type WorkspaceCreatePayload,
  type WorkspaceUpdatePayload,
  type CanvasLayout,
} from "../shared/ipc.js";

const _require = createRequire(import.meta.url);
const pty: typeof import("node-pty") = _require("node-pty");
const {
  startDaemon,
  shutdownDaemon,
  sweepEnvMarker,
  agentEnv,
  sinapseDir,
  estimateContextWindow,
  DEFAULT_AGY_MODEL,
  normalizeAgyModelId,
  buildAgyContextUsage,
  routes,
  AUTHOR_HEADER,
  ORCHESTRATOR_AUTHOR,
  USER_AUTHOR,
  ENV,
}: typeof import("@sinapse/core") = _require("@sinapse/core");

// The packaged `sinapse` CLI shim runs through Electron's own binary in node mode, so users need no system Node.
if (app.isPackaged) process.env.SINAPSE_NODE = process.execPath;

interface Brain {
  pty: IPty | null;
  session: string;
  sessionId: string | null;
  usage?: ContextUsage;
  scrollback: string;
  cols: number;
  rows: number;
  provider: "claude" | "agy";
  model: string | null;
  ptyStartTime: number;
}

const MAX_SCROLLBACK = 256 * 1024; // 256 KB ring buffer
const brains = new Map<string, Brain>();

const DIFF_MAX_BYTES = 200 * 1024;

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
        const message = err && !stderr ? (err as Error).message : stderr;
        resolve({ code, stdout: stdout ?? "", stderr: message ?? "" });
      }
    );
  });
}

async function gitDiff(cwd: string): Promise<WorkerDiffResult> {
  const fail = (error: string): WorkerDiffResult => ({ ok: false, error, status: "", diff: "", truncated: false });
  const status = await runGit(cwd, ["status", "--porcelain"]);
  if (status.code !== 0) return fail(status.stderr.trim() || "Não é um repositório git");

  // Before the first commit there is no HEAD: plain `git diff` (unstaged only) is the best available.
  let diffRes = await runGit(cwd, ["diff", "--no-color", "--no-ext-diff", "HEAD"]);
  if (diffRes.code !== 0) diffRes = await runGit(cwd, ["diff", "--no-color", "--no-ext-diff"]);
  if (diffRes.code !== 0) return fail(diffRes.stderr.trim() || "Falha ao executar git diff");

  let diff = diffRes.stdout;
  const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const files = untracked.stdout.split("\n").filter(Boolean);
  if (files.length > 0) {
    const shown = files.slice(0, 100).map((f) => `?? ${f}`);
    if (files.length > shown.length) shown.push(`… e mais ${files.length - shown.length} arquivo(s)`);
    diff += `${diff && !diff.endsWith("\n") ? "\n" : ""}\n# Arquivos não rastreados (conteúdo omitido):\n${shown.join("\n")}\n`;
  }

  const truncated = Buffer.byteLength(diff) > DIFF_MAX_BYTES;
  if (truncated) diff = Buffer.from(diff).subarray(0, DIFF_MAX_BYTES).toString("utf8");
  return { ok: true, status: status.stdout, diff, truncated };
}

function getDefaultSettings(): DesktopSettings {
  return {
    workerDefaults: {
      provider: "agy",
      autonomy: "edit",
    },
    appearance: {
      chromaticBar: "animada",
      motion: "sistema",
      terminalFontSize: 13,
    },
  };
}

let mainWindow: BrowserWindow | null = null;
let daemonInfo: DaemonInfo | null = null;
let ownsDaemon = false;
let isDaemonConnected = false;
let sseAbortController: AbortController | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isQuitting = false;
let brainUsageTimer: NodeJS.Timeout | null = null;

let settings: DesktopSettings = getDefaultSettings();

const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;

function appendScrollback(brain: Brain, data: string): void {
  brain.scrollback += data;
  if (brain.scrollback.length > MAX_SCROLLBACK) {
    brain.scrollback = brain.scrollback.slice(brain.scrollback.length - MAX_SCROLLBACK);
  }
}

function brainDir(ws: Workspace | string): string {
  const id = typeof ws === "string" ? ws : ws.id;
  const dir = path.join(sinapseDir(), "workspaces", id, "orquestrador");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateBrainGuide(ws: Workspace): string {
  return `# Orquestrador do Sinapse — Workspace ${ws.name}

Você é o orquestrador do workspace ${ws.name}. O projeto está em ${ws.folder} (acessível via --add-dir). Conversa com o usuário e delega trabalho a workers pela skill \`sinapse\`.

- Esta pasta é a sua base. O projeto principal está em ${ws.folder}: trabalhe nele diretamente ou por caminho absoluto e passe a pasta certa aos workers com \`--cwd\`.
- O canvas mostra ao vivo os workers, as delegações e as notas (\`sinapse note\`).
`;
}

function getCliBinDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin")
    : path.resolve(app.getAppPath(), "../../node_modules/.bin");
}

function getSkillSourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "skill", "sinapse")
    : path.resolve(app.getAppPath(), "../../skill/sinapse");
}

function ensureAgySkill(bDir: string): void {
  try {
    const skillsDir = path.join(bDir, ".agent", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const linkPath = path.join(skillsDir, "sinapse");
    const skillSource = getSkillSourceDir();

    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(linkPath);
        if (target !== skillSource) {
          fs.unlinkSync(linkPath);
          fs.symlinkSync(skillSource, linkPath, process.platform === "win32" ? "junction" : "dir");
        }
      } else {
        fs.rmSync(linkPath, { recursive: true, force: true });
        fs.symlinkSync(skillSource, linkPath, process.platform === "win32" ? "junction" : "dir");
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        fs.symlinkSync(skillSource, linkPath, process.platform === "win32" ? "junction" : "dir");
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (process.platform === "win32") {
      console.warn("Falha ao criar symlink da skill AGY no Windows:", err);
    } else {
      console.warn("Falha ao criar symlink da skill AGY:", err);
    }
  }
}

function getBrainInfo(workspaceId: string, ws?: Workspace): BrainInfo {
  const brain = brains.get(workspaceId);
  const provider = brain?.provider ?? ws?.orchestrator.provider ?? "agy";
  const model = brain ? brain.model : (ws?.orchestrator.model ?? null);
  return {
    workspaceId,
    provider,
    model,
    usage: brain?.usage,
    running: brain?.pty != null,
  };
}

function getOrCreateBrain(ws: Workspace): Brain {
  let brain = brains.get(ws.id);
  if (!brain) {
    brain = {
      pty: null,
      session: "",
      sessionId: null,
      usage: undefined,
      scrollback: "",
      cols: 80,
      rows: 24,
      provider: ws.orchestrator.provider,
      model: ws.orchestrator.model ?? null,
      ptyStartTime: 0,
    };
    brains.set(ws.id, brain);
  } else {
    brain.provider = ws.orchestrator.provider;
    brain.model = ws.orchestrator.model ?? null;
  }
  return brain;
}

async function killBrain(ws: Workspace | string): Promise<void> {
  const id = typeof ws === "string" ? ws : ws.id;
  const brain = brains.get(id);
  if (!brain) return;

  const session = brain.session;
  if (brain.pty) {
    try {
      brain.pty.kill();
    } catch {}
    brain.pty = null;
  }

  return new Promise((resolve) =>
    setTimeout(() => {
      if (session) {
        sweepEnvMarker("SINAPSE_BRAIN_SESSION", session);
      }
      resolve();
    }, 1000)
  );
}

async function spawnBrain(ws: Workspace, resumeSessionId?: string | null): Promise<void> {
  if (!daemonInfo) return;
  const brain = getOrCreateBrain(ws);
  if (brain.pty) {
    await killBrain(ws.id);
  }

  const home = os.homedir();
  const cliBinPath = getCliBinDir();
  const localBin = path.join(home, ".local", "bin");
  const userPath = (process.env.PATH || "").split(path.delimiter);
  const extraPaths =
    process.platform !== "win32" ? ["/usr/local/bin", "/usr/bin", "/bin"] : [];
  const combinedPath = Array.from(new Set([cliBinPath, localBin, ...userPath, ...extraPaths]))
    .filter(Boolean)
    .join(path.delimiter);

  const provider = ws.orchestrator.provider;
  const model = ws.orchestrator.model;
  const args: string[] = [];

  if (provider === "claude") {
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    if (model) {
      args.push("--model", model);
    }
    args.push("--add-dir", ws.folder);
  } else {
    // agy
    if (resumeSessionId) {
      args.push("--conversation", resumeSessionId);
    }
    if (model) {
      args.push("--model", model);
    }
    args.push("--add-dir", ws.folder);
  }

  const bDir = brainDir(ws.id);
  const guideFilename = provider === "claude" ? "CLAUDE.md" : "AGENTS.md";
  fs.writeFileSync(path.join(bDir, guideFilename), generateBrainGuide(ws), "utf-8");

  if (provider === "agy") {
    ensureAgySkill(bDir);
  }

  try {
    brain.ptyStartTime = Date.now();
    brain.session = randomUUID();
    brain.provider = provider;
    brain.model = model ?? null;
    brain.sessionId = resumeSessionId ?? null;
    if (!resumeSessionId) {
      brain.scrollback = "";
      brain.usage = undefined;
    } else if (brain.usage && model) {
      brain.usage = {
        ...brain.usage,
        windowTokens: estimateContextWindow(model) ?? brain.usage.windowTokens,
        model,
      };
    }

    const command = provider === "claude" ? "claude" : "agy";
    const proc = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: brain.cols || 80,
      rows: brain.rows || 24,
      cwd: bDir,
      env: agentEnv({
        PATH: combinedPath,
        SINAPSE_URL: `http://127.0.0.1:${daemonInfo.port}`,
        SINAPSE_TOKEN: daemonInfo.token,
        SINAPSE_BRAIN_SESSION: brain.session,
        [ENV.workspace]: ws.id,
        [ENV.agentId]: ORCHESTRATOR_AUTHOR,
      }) as Record<string, string>,
    });

    brain.pty = proc;

    proc.onData((data: string) => {
      // A killed PTY can still flush output; only the current one may write to the terminal.
      const currentBrain = brains.get(ws.id);
      if (!currentBrain || proc !== currentBrain.pty) return;
      appendScrollback(currentBrain, data);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.BRAIN_DATA, ws.id, data);
      }
    });

    proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      console.log(`Brain PTY for ${ws.id} exited (exitCode=${exitCode}, signal=${signal})`);
      const currentBrain = brains.get(ws.id);
      if (currentBrain && currentBrain.pty === proc) {
        currentBrain.pty = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.BRAIN_INFO_CHANGED, getBrainInfo(ws.id, ws));
        }
      }
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.BRAIN_INFO_CHANGED, getBrainInfo(ws.id, ws));
    }
  } catch (err) {
    console.error(`Failed to spawn ${provider} PTY process for workspace ${ws.id}:`, err);
  }
}

function isUsageEqual(a?: ContextUsage, b?: ContextUsage): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.usedTokens === b.usedTokens &&
    a.windowTokens === b.windowTokens &&
    a.windowEstimated === b.windowEstimated &&
    a.model === b.model
  );
}

const AGY_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getAgyConversationMtime(agyDir: string, convId: string): number {
  let maxMtime = -1;
  const candidates = [
    path.join(agyDir, "brain", convId, ".system_generated", "logs", "transcript.jsonl"),
    path.join(agyDir, "conversations", `${convId}.db-wal`),
    path.join(agyDir, "conversations", `${convId}.db`),
    path.join(agyDir, "presence", `${convId}.lock`),
  ];
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {}
  }
  return maxMtime;
}

function findAgyConversationByProc(agyDir: string, pid: number | undefined, minMtime: number, currentSessionId: string | null): string | null {
  if (!pid || process.platform !== "linux") return null;
  try {
    const fdDir = `/proc/${pid}/fd`;
    if (!fs.existsSync(fdDir)) return null;
    const entries = fs.readdirSync(fdDir);
    const ids = new Set<string>();
    for (const fd of entries) {
      try {
        const target = fs.readlinkSync(path.join(fdDir, fd));
        const m = target.match(/\/(?:presence|conversations)\/([0-9a-f-]{36})\.(?:lock|db)$/i);
        if (m && AGY_UUID_REGEX.test(m[1])) {
          ids.add(m[1]);
        }
      } catch {}
    }
    if (ids.size === 0) return null;
    let bestId: string | null = null;
    let bestMtime = -1;
    for (const id of ids) {
      const mtime = getAgyConversationMtime(agyDir, id);
      if (mtime >= minMtime || id === currentSessionId) {
        if (mtime > bestMtime) {
          bestMtime = mtime;
          bestId = id;
        }
      }
    }
    return bestId;
  } catch {
    return null;
  }
}

function findAgyConversationByFiles(agyDir: string, bDir: string, minMtime: number): string | null {
  // 1. Check history.jsonl tail for { workspace: bDir, conversationId }
  try {
    const historyPath = path.join(agyDir, "history.jsonl");
    if (fs.existsSync(historyPath)) {
      const st = fs.statSync(historyPath);
      if (st.mtimeMs >= minMtime && st.size > 0) {
        const readSize = Math.min(st.size, 64 * 1024);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(historyPath, "r");
        try {
          fs.readSync(fd, buf, 0, readSize, Math.max(0, st.size - readSize));
        } finally {
          fs.closeSync(fd);
        }
        const lines = buf.toString("utf-8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (
              parsed.workspace === bDir &&
              typeof parsed.conversationId === "string" &&
              AGY_UUID_REGEX.test(parsed.conversationId) &&
              (!parsed.timestamp || Number(parsed.timestamp) >= minMtime)
            ) {
              return parsed.conversationId;
            }
          } catch {}
        }
      }
    }
  } catch {}

  // 2. Check conversations/*.db modified since minMtime whose trajectory_metadata_blob contains the workspace URI
  try {
    const convDir = path.join(agyDir, "conversations");
    if (fs.existsSync(convDir)) {
      const bDirUri = pathToFileURL(bDir).href;
      const uriBytes = Buffer.from(bDirUri, "utf-8");
      // In trajectory_metadata_blob protobuf, workspace_uris (field 1, wire type 2 = 0x0a) prefixes the URI with its byte length.
      const protoNeedle =
        uriBytes.length < 128
          ? Buffer.concat([Buffer.from([0x0a, uriBytes.length]), uriBytes])
          : uriBytes;

      const entries = fs.readdirSync(convDir).filter((f) => f.endsWith(".db"));
      const recent: { id: string; mtime: number }[] = [];
      for (const file of entries) {
        const id = file.slice(0, -3);
        if (!AGY_UUID_REGEX.test(id)) continue;
        const mtime = getAgyConversationMtime(agyDir, id);
        if (mtime >= minMtime) {
          recent.push({ id, mtime });
        }
      }
      recent.sort((a, b) => b.mtime - a.mtime);

      for (const cand of recent.slice(0, 10)) {
        const dbPath = path.join(convDir, `${cand.id}.db`);
        const walPath = path.join(convDir, `${cand.id}.db-wal`);
        for (const p of [walPath, dbPath]) {
          try {
            if (!fs.existsSync(p)) continue;
            const buf = fs.readFileSync(p);
            if (buf.includes(protoNeedle)) {
              return cand.id;
            }
          } catch {}
        }
      }
    }
  } catch {}

  return null;
}

function readAgyDefaultModel(agyDir: string): string | undefined {
  try {
    const settingsPath = path.join(agyDir, "settings.json");
    if (!fs.existsSync(settingsPath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (typeof parsed?.model === "string") {
      return normalizeAgyModelId(parsed.model);
    }
  } catch {}
  return undefined;
}

function extractAgyModelFromLines(lines: string[], minTimestampMs?: number): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed.type === "USER_INPUT" &&
        typeof parsed.content === "string" &&
        parsed.content.includes("Model Selection")
      ) {
        if (minTimestampMs !== undefined && typeof parsed.created_at === "string") {
          const ts = Date.parse(parsed.created_at);
          if (Number.isFinite(ts) && ts < minTimestampMs) {
            continue;
          }
        }
        const m = parsed.content.match(/Model Selection` from [^\n]+? to ([^\n<]+?)\.(?:\s|$)/);
        if (m) {
          const normalized = normalizeAgyModelId(m[1]);
          if (normalized) return normalized;
        }
      }
    } catch {}
  }
  return undefined;
}

function pollClaudeBrainUsage(workspaceId: string, brain: Brain): void {
  try {
    const bDir = brainDir(workspaceId);
    const dir = path.join(os.homedir(), ".claude", "projects", bDir.replace(/[^a-zA-Z0-9]/g, "-"));
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return;

    const minMtime = brain.ptyStartTime - 5000;
    let newestFile: string | null = null;
    let newestMtime = -1;

    for (const file of files) {
      try {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= minMtime && stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = fullPath;
        }
      } catch {}
    }

    if (!newestFile) return;
    brain.sessionId = path.basename(newestFile, ".jsonl");

    const stat = fs.statSync(newestFile);
    const size = stat.size;
    if (size === 0) return;

    const readSize = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(newestFile, "r");
    try {
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, size - readSize));
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString("utf-8");
    const lines = text.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "assistant" && parsed.message?.usage) {
          const usage = parsed.message.usage;
          const inputTokens = usage.input_tokens || 0;
          const cacheCreation = usage.cache_creation_input_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const usedTokens = inputTokens + cacheCreation + cacheRead;
          const model = parsed.message.model;
          const windowTokens = estimateContextWindow(model);
          const newUsage: ContextUsage = {
            usedTokens,
            windowTokens,
            windowEstimated: true,
            model,
          };

          if (!isUsageEqual(brain.usage, newUsage)) {
            brain.usage = newUsage;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.BRAIN_USAGE, workspaceId, newUsage);
            }
          }
          break;
        }
      } catch {
        // Skip malformed/partial line
      }
    }
  } catch {
    // Never crash on poll errors
  }
}

const AGY_FILE_SCAN_INTERVAL_MS = 15_000;
const agyFileScanAt = new Map<string, number>();

function pollAgyBrainUsage(workspaceId: string, brain: Brain): void {
  try {
    const agyDir = path.join(os.homedir(), ".gemini", "antigravity-cli");
    if (!fs.existsSync(agyDir)) return;

    const bDir = brainDir(workspaceId);
    const minMtime = brain.ptyStartTime - 5000;

    // The file scan reads whole .db files synchronously, so it only runs while the id is unknown, at most every 15s.
    let discoveredId = findAgyConversationByProc(agyDir, brain.pty?.pid, minMtime, brain.sessionId);
    if (!discoveredId && !brain.sessionId && Date.now() - (agyFileScanAt.get(workspaceId) ?? 0) >= AGY_FILE_SCAN_INTERVAL_MS) {
      agyFileScanAt.set(workspaceId, Date.now());
      discoveredId = findAgyConversationByFiles(agyDir, bDir, minMtime);
    }

    if (discoveredId) {
      brain.sessionId = discoveredId;
    }

    const convId = brain.sessionId;
    if (!convId) return;

    const logsDir = path.join(agyDir, "brain", convId, ".system_generated", "logs");
    let transcriptPath = path.join(logsDir, "transcript.jsonl");
    if (!fs.existsSync(transcriptPath)) {
      transcriptPath = path.join(logsDir, "transcript_full.jsonl");
      if (!fs.existsSync(transcriptPath)) return;
    }

    const stat = fs.statSync(transcriptPath);
    const size = stat.size;
    if (size === 0) return;

    const readSize = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, "r");
    try {
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, size - readSize));
    } finally {
      fs.closeSync(fd);
    }

    const lines = buffer.toString("utf-8").split("\n");
    let rawUsage: { input_tokens?: number; cache_read_tokens?: number } | undefined;
    let hasModelResponse = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "PLANNER_RESPONSE" || parsed.source === "MODEL") {
          hasModelResponse = true;
        }
        if (
          typeof parsed.input_tokens === "number" ||
          typeof parsed.cache_read_tokens === "number"
        ) {
          rawUsage = {
            input_tokens: parsed.input_tokens,
            cache_read_tokens: parsed.cache_read_tokens,
          };
          break;
        }
      } catch {
        // Skip malformed/partial line
      }
    }

    if (!rawUsage && hasModelResponse) {
      rawUsage = { input_tokens: Math.max(1, Math.round(size / 4)) };
    }
    if (!rawUsage) return;

    // Resolve the active model:
    // 1. A model selection recorded in the current PTY run's USER_INPUT steps
    // 2. Explicit workspace orchestrator model (brain.model)
    // 3. Any earlier model selection in the conversation transcript (tail or head)
    // 4. User's AGY settings.json model or DEFAULT_AGY_MODEL
    let resolvedModel = extractAgyModelFromLines(lines, minMtime) ?? (brain.model || undefined);
    if (!resolvedModel) {
      resolvedModel = extractAgyModelFromLines(lines);
    }
    if (!resolvedModel && size > readSize) {
      try {
        const headSize = Math.min(size, 32 * 1024);
        const headBuf = Buffer.alloc(headSize);
        const hfd = fs.openSync(transcriptPath, "r");
        try {
          fs.readSync(hfd, headBuf, 0, headSize, 0);
        } finally {
          fs.closeSync(hfd);
        }
        resolvedModel = extractAgyModelFromLines(headBuf.toString("utf-8").split("\n"));
      } catch {}
    }
    if (!resolvedModel) {
      resolvedModel = readAgyDefaultModel(agyDir) ?? DEFAULT_AGY_MODEL;
    }

    const newUsage = buildAgyContextUsage(rawUsage, brain.model ?? undefined, resolvedModel);
    if (newUsage && !isUsageEqual(brain.usage, newUsage)) {
      brain.usage = newUsage;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.BRAIN_USAGE, workspaceId, newUsage);
      }
    }
  } catch {
    // Never crash on poll errors
  }
}

function pollBrainUsage(): void {
  for (const [workspaceId, brain] of brains.entries()) {
    if (!brain.pty) continue;
    if (brain.provider === "claude") {
      pollClaudeBrainUsage(workspaceId, brain);
    } else if (brain.provider === "agy") {
      pollAgyBrainUsage(workspaceId, brain);
    }
  }
}

function getCurrentDir(): string {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolvePreloadPath(): string {
  const currentDir = getCurrentDir();
  const mjsPath = path.join(currentDir, "../preload/index.mjs");
  if (fs.existsSync(mjsPath)) {
    return mjsPath;
  }
  return path.join(currentDir, "../preload/index.js");
}

function resolveRendererPath(): string {
  const currentDir = getCurrentDir();
  const directPath = path.join(currentDir, "../renderer/index.html");
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  const rootDistPath = path.join(currentDir, "../../dist/renderer/index.html");
  if (fs.existsSync(rootDistPath)) {
    return rootDistPath;
  }
  return directPath;
}

function getDesktopConfigPath(): string {
  return path.join(sinapseDir(), "desktop.json");
}

function loadSettings(): DesktopSettings {
  const current = getDefaultSettings();
  try {
    const configPath = getDesktopConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const data = JSON.parse(content);
      if (data && typeof data === "object") {
        if (typeof data.activeWorkspaceId === "string" && data.activeWorkspaceId.trim() !== "") {
          current.activeWorkspaceId = data.activeWorkspaceId.trim();
        }
        if (data.workerDefaults && typeof data.workerDefaults === "object") {
          const wd = data.workerDefaults;
          if (wd.provider === "claude" || wd.provider === "codex" || wd.provider === "agy") {
            current.workerDefaults.provider = wd.provider;
          }
          if (wd.autonomy === "read" || wd.autonomy === "edit" || wd.autonomy === "full") {
            current.workerDefaults.autonomy = wd.autonomy;
          }
          if (typeof wd.model === "string" && MODEL_REGEX.test(wd.model.trim())) {
            current.workerDefaults.model = wd.model.trim();
          }
        }
        if (data.appearance && typeof data.appearance === "object") {
          const appSettings = data.appearance;
          if (
            appSettings.chromaticBar === "animada" ||
            appSettings.chromaticBar === "estatica" ||
            appSettings.chromaticBar === "desligada"
          ) {
            current.appearance.chromaticBar = appSettings.chromaticBar;
          }
          if (appSettings.motion === "sistema" || appSettings.motion === "reduzido") {
            current.appearance.motion = appSettings.motion;
          }
          if (
            typeof appSettings.terminalFontSize === "number" &&
            Number.isInteger(appSettings.terminalFontSize) &&
            appSettings.terminalFontSize >= 10 &&
            appSettings.terminalFontSize <= 22
          ) {
            current.appearance.terminalFontSize = appSettings.terminalFontSize;
          }
        }
      }
    }
  } catch (err) {
    console.warn("Failed to load desktop.json:", err);
  }
  return current;
}

function saveSettings(s: DesktopSettings): void {
  try {
    const dir = sinapseDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const configPath = getDesktopConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(s, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save desktop.json:", err);
  }
}

const LAYOUT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_LAYOUT_NODES = 2000;

function getLayoutPath(workspaceId: string): string | undefined {
  if (typeof workspaceId !== "string" || !LAYOUT_ID_REGEX.test(workspaceId)) return undefined;
  return path.join(sinapseDir(), "layouts", `${workspaceId}.json`);
}

const finiteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Re-validates whatever came over IPC or from disk so a bad file can't put NaN positions on the canvas. */
function sanitizeLayout(raw: unknown): CanvasLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as { nodes?: unknown; viewport?: unknown };
  const nodes: CanvasLayout["nodes"] = {};
  if (input.nodes && typeof input.nodes === "object") {
    for (const [id, value] of Object.entries(input.nodes as Record<string, unknown>).slice(0, MAX_LAYOUT_NODES)) {
      const n = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
      if (!n || !finiteNumber(n.x) || !finiteNumber(n.y)) continue;
      nodes[id] = {
        x: n.x,
        y: n.y,
        ...(finiteNumber(n.width) && n.width > 0 ? { width: n.width } : {}),
        ...(finiteNumber(n.height) && n.height > 0 ? { height: n.height } : {}),
      };
    }
  }
  const vp = input.viewport as { x?: unknown; y?: unknown; zoom?: unknown } | undefined;
  const viewport =
    vp && finiteNumber(vp.x) && finiteNumber(vp.y) && finiteNumber(vp.zoom) && vp.zoom > 0
      ? { x: vp.x, y: vp.y, zoom: vp.zoom }
      : undefined;
  return { nodes, ...(viewport ? { viewport } : {}) };
}

function loadLayout(workspaceId: string): CanvasLayout | null {
  const file = getLayoutPath(workspaceId);
  if (!file) return null;
  try {
    return sanitizeLayout(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    return null;
  }
}

function saveLayout(workspaceId: string, layout: unknown): void {
  const file = getLayoutPath(workspaceId);
  const clean = sanitizeLayout(layout);
  if (!file || !clean) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean), "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error("Failed to save canvas layout:", err);
  }
}

function deleteLayout(workspaceId: string): void {
  const file = getLayoutPath(workspaceId);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

function broadcastDaemonStatus(connected: boolean): void {
  isDaemonConnected = connected;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.DAEMON_STATUS, { connected });
  }
}

async function daemonFetch(endpoint: string, init?: RequestInit): Promise<Response> {
  if (!daemonInfo) {
    throw new Error("Sinapse daemon is not ready");
  }
  return fetch(`http://127.0.0.1:${daemonInfo.port}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemonInfo.token}`,
      ...(init?.headers || {}),
    },
  });
}

async function extractDaemonError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json && typeof json.error === "string") return json.error;
      if (json && typeof json.message === "string") return json.message;
    } catch {}
    if (text && text.trim()) return text.trim();
  } catch {}
  return fallback;
}

async function connectDaemonSSE(): Promise<void> {
  if (!daemonInfo || isQuitting) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  sseAbortController = new AbortController();
  const url = `http://127.0.0.1:${daemonInfo.port}${routes.events()}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${daemonInfo.token}`,
      },
      signal: sseAbortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE stream failed with status ${response.status}`);
    }

    broadcastDaemonStatus(true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) {
          continue;
        }
        if (trimmed.startsWith("data:")) {
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr) {
            try {
              const event: DaemonEvent = JSON.parse(jsonStr);

              if (event.kind === "workspace_deleted") {
                void killBrain(event.workspaceId).then(() => {
                  brains.delete(event.workspaceId);
                });
              }

              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(IPC.DAEMON_EVENT, event);
              }
            } catch (err) {
              console.error("Failed to parse SSE event JSON:", jsonStr, err);
            }
          }
        }
      }
    }
  } catch (err: any) {
    if (!isQuitting) {
      console.warn("Daemon SSE disconnected, retrying in 2s:", err?.message || err);
    }
  } finally {
    broadcastDaemonStatus(false);
    if (!isQuitting) {
      reconnectTimer = setTimeout(() => {
        connectDaemonSSE();
      }, 2000);
    }
  }
}

function createWindow(): BrowserWindow {
  const preloadPath = resolvePreloadPath();

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#07080d",
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (process.platform === "darwin") {
    windowOptions.titleBarStyle = "hidden";
  } else {
    windowOptions.frame = false;
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.on("maximize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.WINDOW_MAXIMIZED, true);
    }
  });

  mainWindow.on("unmaximize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.WINDOW_MAXIMIZED, false);
    }
  });

  // Navigation safety: deny opening popups/new windows
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Navigation safety: prevent renderer from navigating away
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl && navigationUrl.startsWith(rendererUrl)) {
      return;
    }
    const resolvedRenderer = resolveRendererPath();
    const fileUrl = `file://${resolvedRenderer}`;
    if (navigationUrl === fileUrl || navigationUrl.startsWith(`${fileUrl}#`)) {
      return;
    }
    event.preventDefault();
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
    if (daemonInfo && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.DAEMON_INFO, daemonInfo);
      mainWindow.webContents.send(IPC.DAEMON_STATUS, { connected: isDaemonConnected });
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (daemonInfo && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.DAEMON_INFO, daemonInfo);
      mainWindow.webContents.send(IPC.DAEMON_STATUS, { connected: isDaemonConnected });
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(resolveRendererPath());
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function registerIpcHandlers(): void {
  // Window controls
  ipcMain.on(IPC.WINDOW_MINIMIZE, () => {
    mainWindow?.minimize();
  });

  ipcMain.on(IPC.WINDOW_TOGGLE_MAXIMIZE, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on(IPC.WINDOW_CLOSE, () => {
    mainWindow?.close();
  });

  ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, (): boolean => {
    return mainWindow?.isMaximized() ?? false;
  });

  // Settings
  ipcMain.handle(IPC.SETTINGS_GET, async (): Promise<DesktopSettings> => {
    return settings;
  });

  ipcMain.handle(IPC.SETTINGS_SET, async (_event, patch: DesktopSettingsPatch): Promise<DesktopSettings> => {
    if (!patch || typeof patch !== "object") {
      throw new Error("Configurações inválidas");
    }

    let nextWorkerModel: string | null | undefined = undefined;
    if (patch.workerDefaults !== undefined) {
      if (!patch.workerDefaults || typeof patch.workerDefaults !== "object") {
        throw new Error("Configurações do worker inválidas");
      }
      if (patch.workerDefaults.provider !== undefined) {
        if (
          patch.workerDefaults.provider !== "claude" &&
          patch.workerDefaults.provider !== "codex" &&
          patch.workerDefaults.provider !== "agy"
        ) {
          throw new Error("Provedor inválido: deve ser 'claude', 'codex' ou 'agy'");
        }
      }
      if (patch.workerDefaults.autonomy !== undefined) {
        if (
          patch.workerDefaults.autonomy !== "read" &&
          patch.workerDefaults.autonomy !== "edit" &&
          patch.workerDefaults.autonomy !== "full"
        ) {
          throw new Error("Autonomia inválida: deve ser 'read', 'edit' ou 'full'");
        }
      }
      if ("model" in patch.workerDefaults && patch.workerDefaults.model !== undefined) {
        if (
          patch.workerDefaults.model === null ||
          (typeof patch.workerDefaults.model === "string" && patch.workerDefaults.model.trim() === "")
        ) {
          nextWorkerModel = null;
        } else if (
          typeof patch.workerDefaults.model === "string" &&
          MODEL_REGEX.test(patch.workerDefaults.model.trim())
        ) {
          nextWorkerModel = patch.workerDefaults.model.trim();
        } else {
          throw new Error("Modelo inválido");
        }
      }
    }

    if (patch.appearance !== undefined) {
      if (!patch.appearance || typeof patch.appearance !== "object") {
        throw new Error("Configurações de aparência inválidas");
      }
      if (patch.appearance.chromaticBar !== undefined) {
        if (
          patch.appearance.chromaticBar !== "animada" &&
          patch.appearance.chromaticBar !== "estatica" &&
          patch.appearance.chromaticBar !== "desligada"
        ) {
          throw new Error("Barra cromática inválida: deve ser 'animada', 'estatica' ou 'desligada'");
        }
      }
      if (patch.appearance.motion !== undefined) {
        if (patch.appearance.motion !== "sistema" && patch.appearance.motion !== "reduzido") {
          throw new Error("Configuração de movimento inválida: deve ser 'sistema' ou 'reduzido'");
        }
      }
      if (patch.appearance.terminalFontSize !== undefined) {
        if (
          typeof patch.appearance.terminalFontSize !== "number" ||
          !Number.isInteger(patch.appearance.terminalFontSize) ||
          patch.appearance.terminalFontSize < 10 ||
          patch.appearance.terminalFontSize > 22
        ) {
          throw new Error("Tamanho de fonte do terminal inválido: deve ser um número inteiro entre 10 e 22");
        }
      }
    }

    // Merge field by field
    if (patch.workerDefaults) {
      if (patch.workerDefaults.provider !== undefined) {
        settings.workerDefaults.provider = patch.workerDefaults.provider;
      }
      if (patch.workerDefaults.autonomy !== undefined) {
        settings.workerDefaults.autonomy = patch.workerDefaults.autonomy;
      }
      if (nextWorkerModel !== undefined) {
        if (nextWorkerModel) {
          settings.workerDefaults.model = nextWorkerModel;
        } else {
          delete settings.workerDefaults.model;
        }
      }
    }

    if (patch.appearance) {
      if (patch.appearance.chromaticBar !== undefined) {
        settings.appearance.chromaticBar = patch.appearance.chromaticBar;
      }
      if (patch.appearance.motion !== undefined) {
        settings.appearance.motion = patch.appearance.motion;
      }
      if (patch.appearance.terminalFontSize !== undefined) {
        settings.appearance.terminalFontSize = patch.appearance.terminalFontSize;
      }
    }

    saveSettings(settings);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SETTINGS_CHANGED, settings);
    }

    return settings;
  });

  // Brain
  ipcMain.on(IPC.BRAIN_INPUT, (_event, workspaceId: string, data: string) => {
    const brain = brains.get(workspaceId);
    if (brain?.pty) {
      brain.pty.write(data);
    }
  });

  ipcMain.on(IPC.BRAIN_RESIZE, (_event, workspaceId: string, cols: number, rows: number) => {
    let brain = brains.get(workspaceId);
    if (!brain) {
      brain = {
        pty: null,
        session: "",
        sessionId: null,
        usage: undefined,
        scrollback: "",
        cols,
        rows,
        provider: "agy",
        model: null,
        ptyStartTime: 0,
      };
      brains.set(workspaceId, brain);
    } else {
      brain.cols = cols;
      brain.rows = rows;
    }
    if (brain.pty) {
      try {
        brain.pty.resize(cols, rows);
      } catch (err) {
        console.error(`Error resizing PTY for ${workspaceId}:`, err);
      }
    }
  });

  ipcMain.handle(IPC.BRAIN_INFO, async (_event, workspaceId: string): Promise<BrainInfo> => {
    const brain = brains.get(workspaceId);
    if (brain) {
      return getBrainInfo(workspaceId);
    }
    try {
      const res = await daemonFetch(routes.workspace(workspaceId));
      if (res.ok) {
        const ws = (await res.json()) as Workspace;
        return getBrainInfo(workspaceId, ws);
      }
    } catch {}
    return {
      workspaceId,
      provider: "agy",
      model: null,
      running: false,
    };
  });

  ipcMain.handle(IPC.BRAIN_REPLAY, async (_event, workspaceId: string): Promise<string> => {
    const brain = brains.get(workspaceId);
    return brain?.scrollback ?? "";
  });

  // Workspaces
  ipcMain.handle(IPC.WORKSPACES_LIST, async (): Promise<Workspace[]> => {
    const res = await daemonFetch(routes.workspaces());
    if (!res.ok) {
      throw new Error(await extractDaemonError(res, "Não foi possível listar os workspaces"));
    }
    return (await res.json()) as Workspace[];
  });

  ipcMain.handle(IPC.WORKSPACES_CREATE, async (_event, payload: WorkspaceCreatePayload): Promise<Workspace> => {
    const res = await daemonFetch(routes.workspaces(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(await extractDaemonError(res, "Não foi possível criar o workspace"));
    }
    return (await res.json()) as Workspace;
  });

  ipcMain.handle(IPC.WORKSPACES_UPDATE, async (_event, payload: WorkspaceUpdatePayload): Promise<Workspace> => {
    const body: Record<string, any> = {};
    if (payload.name !== undefined) body.name = payload.name;
    if (payload.orchestrator !== undefined) body.orchestrator = payload.orchestrator;

    const res = await daemonFetch(routes.workspace(payload.workspaceId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(await extractDaemonError(res, "Não foi possível atualizar o workspace"));
    }
    const updated = (await res.json()) as Workspace;

    if (payload.orchestrator) {
      const brain = brains.get(payload.workspaceId);
      if (brain && brain.pty) {
        pollBrainUsage();
        const sameProvider = brain.provider === payload.orchestrator.provider;
        const resumeSessionId = sameProvider ? brain.sessionId : null;
        await killBrain(payload.workspaceId);
        await spawnBrain(updated, resumeSessionId);
      } else if (brain) {
        if (brain.provider !== updated.orchestrator.provider) {
          brain.sessionId = null;
          brain.usage = undefined;
        }
        brain.provider = updated.orchestrator.provider;
        brain.model = updated.orchestrator.model ?? null;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.BRAIN_INFO_CHANGED, getBrainInfo(updated.id, updated));
      }
    }

    return updated;
  });

  ipcMain.handle(IPC.WORKSPACES_DELETE, async (_event, workspaceId: string): Promise<void> => {
    // Check before killing: the daemon refuses to delete the last workspace, and its orchestrator must survive that.
    const before = await daemonFetch(routes.workspaces());
    if (before.ok && ((await before.json()) as Workspace[]).length <= 1) {
      throw new Error("Não é possível apagar o último workspace");
    }
    await killBrain(workspaceId);
    brains.delete(workspaceId);

    const res = await daemonFetch(routes.workspace(workspaceId), {
      method: "DELETE",
    });
    if (!res.ok) {
      throw new Error(await extractDaemonError(res, "Não foi possível excluir o workspace"));
    }
    deleteLayout(workspaceId);

    if (settings.activeWorkspaceId === workspaceId) {
      try {
        const listRes = await daemonFetch(routes.workspaces());
        if (listRes.ok) {
          const remaining = (await listRes.json()) as Workspace[];
          if (remaining.length > 0) {
            const nextActive = remaining[0];
            settings.activeWorkspaceId = nextActive.id;
            saveSettings(settings);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.WORKSPACE_ACTIVE_CHANGED, nextActive.id);
            }
          }
        }
      } catch (err) {
        console.warn("Failed to update active workspace after delete:", err);
      }
    }
  });

  ipcMain.handle(IPC.WORKSPACE_GET_ACTIVE, async (): Promise<string> => {
    try {
      const listRes = await daemonFetch(routes.workspaces());
      if (listRes.ok) {
        const list = (await listRes.json()) as Workspace[];
        if (list.length > 0) {
          if (settings.activeWorkspaceId && list.some((w) => w.id === settings.activeWorkspaceId)) {
            return settings.activeWorkspaceId;
          }
          const fallback = list[0].id;
          settings.activeWorkspaceId = fallback;
          saveSettings(settings);
          return fallback;
        }
      }
    } catch {}
    return settings.activeWorkspaceId || "geral";
  });

  ipcMain.handle(IPC.WORKSPACE_SET_ACTIVE, async (_event, workspaceId: string): Promise<void> => {
    const listRes = await daemonFetch(routes.workspaces());
    if (!listRes.ok) {
      throw new Error(await extractDaemonError(listRes, "Não foi possível validar o workspace"));
    }
    const list = (await listRes.json()) as Workspace[];
    const ws = list.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new Error(`Workspace não encontrado: ${workspaceId}`);
    }

    settings.activeWorkspaceId = ws.id;
    saveSettings(settings);

    const brain = getOrCreateBrain(ws);
    if (!brain.pty) {
      await spawnBrain(ws, brain.sessionId);
    }
    if (brain.pty && brain.cols && brain.rows) {
      try {
        brain.pty.resize(brain.cols, brain.rows);
      } catch {}
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.WORKSPACE_ACTIVE_CHANGED, ws.id);
    }
  });

  // Daemon details
  ipcMain.handle(IPC.DAEMON_DETAILS, async (): Promise<DaemonDetails> => {
    if (!daemonInfo) {
      throw new Error("Sinapse daemon is not ready");
    }
    return {
      port: daemonInfo.port,
      dataDir: sinapseDir(),
      ownsDaemon,
    };
  });

  // Models
  ipcMain.handle(IPC.MODELS_LIST, async (): Promise<ModelCatalog> => {
    const res = await daemonFetch(routes.models());
    if (!res.ok) {
      throw new Error(await extractDaemonError(res, `Não foi possível listar os modelos: ${res.status}`));
    }
    return (await res.json()) as ModelCatalog;
  });

  // Squads
  ipcMain.handle(IPC.SQUADS_LIST, async (): Promise<SquadCatalog> => {
    const res = await daemonFetch(routes.squads());
    if (!res.ok) {
      throw new Error(await extractDaemonError(res, `Não foi possível listar os squads: ${res.status}`));
    }
    return (await res.json()) as SquadCatalog;
  });

  ipcMain.handle(IPC.SQUADS_APPLY, async (_event, payload: SquadApplyPayload): Promise<SquadApplyResult> => {
    const res = await daemonFetch(routes.squadApply(payload.workspaceId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUTHOR_HEADER]: USER_AUTHOR,
      },
      body: JSON.stringify({
        preset: payload.preset,
        ...(payload.prefix ? { prefix: payload.prefix } : {}),
        ...(payload.worktree ? { worktree: true } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(await extractDaemonError(res, `Não foi possível aplicar o squad: ${res.status}`));
    }
    return (await res.json()) as SquadApplyResult;
  });

  // Workers
  ipcMain.handle(IPC.WORKER_LIST, async (_event, workspaceId: string): Promise<AgentState[]> => {
    const response = await daemonFetch(routes.agents(workspaceId), { method: "GET" });
    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível listar os workers: ${response.status}`));
    }
    return (await response.json()) as AgentState[];
  });

  ipcMain.handle(IPC.WORKER_SPAWN, async (_event, payload: WorkerSpawnPayload): Promise<AgentState> => {
    const body: Record<string, any> = {
      name: payload.name,
      provider: payload.provider,
      role: payload.role,
      autonomy: payload.autonomy || "edit",
    };
    if (payload.cwd && payload.cwd.trim() !== "") {
      body.cwd = path.resolve(payload.cwd);
    }
    if (payload.model) {
      body.model = payload.model;
    }
    if (payload.worktree) {
      body.worktree = true;
    }

    const response = await daemonFetch(routes.agents(payload.workspaceId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUTHOR_HEADER]: USER_AUTHOR,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível criar o worker: ${response.status}`));
    }

    return (await response.json()) as AgentState;
  });

  ipcMain.handle(IPC.WORKER_UPDATE, async (_event, payload: WorkerUpdatePayload): Promise<AgentState> => {
    const response = await daemonFetch(routes.agent(payload.workspaceId, payload.agent), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...("model" in payload ? { model: payload.model } : {}),
        ...(payload.autonomy !== undefined ? { autonomy: payload.autonomy } : {}),
        ...(payload.role !== undefined ? { role: payload.role } : {}),
        ...(Array.isArray(payload.pinnedNotes) ? { pinnedNotes: payload.pinnedNotes } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível atualizar o worker: ${response.status}`));
    }

    return (await response.json()) as AgentState;
  });

  ipcMain.handle(IPC.WORKER_ASK, async (_event, payload: WorkerAskPayload): Promise<{ turnId: string }> => {
    const response = await daemonFetch(routes.agentAsk(payload.workspaceId, payload.agent), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: payload.prompt, async: true }),
    });

    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível enviar mensagem ao worker: ${response.status}`));
    }

    return (await response.json()) as { turnId: string };
  });

  ipcMain.handle(IPC.WORKER_STOP, async (_event, workspaceId: string, agent: string): Promise<any> => {
    const response = await daemonFetch(routes.agentStop(workspaceId, agent), {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível parar o worker: ${response.status}`));
    }

    return await response.json();
  });

  ipcMain.handle(IPC.WORKER_DELETE, async (_event, workspaceId: string, agent: string): Promise<AgentDeleteResult> => {
    const response = await daemonFetch(routes.agent(workspaceId, agent), { method: "DELETE" });
    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível excluir o worker: ${response.status}`));
    }
    return (await response.json()) as AgentDeleteResult;
  });

  ipcMain.handle(
    IPC.WORKER_HANDOFF,
    async (_event, workspaceId: string, agent: string): Promise<HandoffResponse> => {
      const response = await daemonFetch(routes.agentHandoff(workspaceId, agent), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error(await extractDaemonError(response, `Não foi possível iniciar o handoff: ${response.status}`));
      }
      return (await response.json()) as HandoffResponse;
    }
  );

  ipcMain.handle(
    IPC.WORKER_HISTORY,
    async (_event, workspaceId: string, agent: string, limit?: number): Promise<TurnRecord[]> => {
      const query = typeof limit === "number" && Number.isFinite(limit) ? `?limit=${Math.floor(limit)}` : "";
      const response = await daemonFetch(routes.agentHistory(workspaceId, agent) + query, { method: "GET" });
      if (!response.ok) {
        throw new Error(await extractDaemonError(response, `Não foi possível ler o histórico: ${response.status}`));
      }
      return (await response.json()) as TurnRecord[];
    }
  );

  ipcMain.handle(
    IPC.WORKER_DIFF,
    async (_event, workspaceId: string, agent: string): Promise<WorkerDiffResult> => {
      const empty = { status: "", diff: "", truncated: false };
      try {
        const response = await daemonFetch(routes.agents(workspaceId), { method: "GET" });
        if (!response.ok) {
          return { ok: false, error: await extractDaemonError(response, `Não foi possível listar os workers: ${response.status}`), ...empty };
        }
        const worker = ((await response.json()) as AgentState[]).find((a) => a.id === agent || a.name === agent);
        if (!worker) return { ok: false, error: "Worker não encontrado", ...empty };
        return await gitDiff(worker.cwd);
      } catch (err: any) {
        return { ok: false, error: err?.message || "Falha ao ler o diff", ...empty };
      }
    }
  );

  ipcMain.handle(IPC.LAYOUT_GET, async (_event, workspaceId: string): Promise<CanvasLayout | null> => {
    return loadLayout(workspaceId);
  });

  ipcMain.handle(IPC.LAYOUT_SAVE, async (_event, workspaceId: string, layout: CanvasLayout): Promise<void> => {
    saveLayout(workspaceId, layout);
  });

  // Notes
  ipcMain.handle(IPC.NOTES_LIST, async (_event, workspaceId: string): Promise<NoteSummary[]> => {
    const response = await daemonFetch(routes.notes(workspaceId), { method: "GET" });
    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível listar as notas: ${response.status}`));
    }
    return (await response.json()) as NoteSummary[];
  });

  ipcMain.handle(IPC.NOTE_READ, async (_event, workspaceId: string, name: string): Promise<Note> => {
    const response = await daemonFetch(routes.note(workspaceId, name), { method: "GET" });
    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível ler a nota: ${response.status}`));
    }
    return (await response.json()) as Note;
  });

  ipcMain.handle(IPC.NOTE_WRITE, async (_event, payload: NoteWritePayload): Promise<Note> => {
    const response = await daemonFetch(routes.note(payload.workspaceId, payload.name), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        [AUTHOR_HEADER]: USER_AUTHOR,
      },
      body: JSON.stringify({ content: payload.content }),
    });
    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível salvar a nota: ${response.status}`));
    }
    return (await response.json()) as Note;
  });

  ipcMain.handle(IPC.NOTE_DELETE, async (_event, workspaceId: string, name: string): Promise<boolean> => {
    const response = await daemonFetch(routes.note(workspaceId, name), {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(await extractDaemonError(response, `Não foi possível excluir a nota: ${response.status}`));
    }
    return true;
  });

  // App
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, async (_event, url: string): Promise<void> => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        await shell.openExternal(url);
      }
    } catch (err) {
      console.warn("Invalid external URL:", url, err);
    }
  });

  ipcMain.handle(IPC.APP_OPEN_FOLDER, async (_event, key: FolderKey, workspaceId?: string): Promise<void> => {
    let targetDir: string;
    if (key === "dados") {
      targetDir = sinapseDir();
    } else if (key === "projeto") {
      if (!workspaceId) {
        throw new Error("workspaceId é necessário para abrir a pasta do projeto");
      }
      const res = await daemonFetch(routes.workspace(workspaceId));
      if (!res.ok) {
        throw new Error(await extractDaemonError(res, "Workspace não encontrado"));
      }
      const ws = (await res.json()) as Workspace;
      targetDir = ws.folder;
    } else if (key === "orquestrador") {
      if (!workspaceId) {
        throw new Error("workspaceId é necessário para abrir a pasta do orquestrador");
      }
      targetDir = brainDir(workspaceId);
    } else if (key === "notas") {
      if (!workspaceId) {
        throw new Error("workspaceId é necessário para abrir a pasta de notas");
      }
      targetDir = path.join(sinapseDir(), "workspaces", workspaceId, "notes");
    } else {
      throw new Error(`Pasta inválida: ${String(key)}`);
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    await shell.openPath(targetDir);
  });

  ipcMain.handle(IPC.APP_PICK_FOLDER, async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
}

// A daemon started by the CLI may already serve this data dir; a second one would overwrite its state.json.
async function findRunningDaemon(): Promise<DaemonInfo | null> {
  try {
    const raw = fs.readFileSync(path.join(sinapseDir(), "daemon.json"), "utf8");
    const { port, token } = JSON.parse(raw);
    if (!port || !token) return null;
    const res = await fetch(`http://127.0.0.1:${port}${routes.health()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? { port, token } : null;
  } catch {
    return null;
  }
}

async function init(): Promise<void> {
  settings = loadSettings();

  try {
    const running = await findRunningDaemon();
    if (running) {
      daemonInfo = running;
      console.log(`Using running daemon on port ${daemonInfo.port}`);
    } else {
      const started = await startDaemon();
      daemonInfo = { port: started.port, token: started.token };
      ownsDaemon = true;
      console.log(`Daemon started on port ${daemonInfo.port}`);
    }
    connectDaemonSSE();
  } catch (err) {
    console.error("Failed to start daemon:", err);
  }

  registerIpcHandlers();
  createWindow();

  // On startup, after the daemon is ready, start only the active workspace's brain.
  if (daemonInfo) {
    try {
      const listRes = await daemonFetch(routes.workspaces());
      if (listRes.ok) {
        const list = (await listRes.json()) as Workspace[];
        if (list.length > 0) {
          let activeWs = list.find((w) => w.id === settings.activeWorkspaceId);
          if (!activeWs) {
            activeWs = list[0];
            settings.activeWorkspaceId = activeWs.id;
            saveSettings(settings);
          }
          await spawnBrain(activeWs);
        }
      }
    } catch (err) {
      console.error("Failed to initialize active workspace brain:", err);
    }
  }

  if (brainUsageTimer) {
    clearInterval(brainUsageTimer);
  }
  brainUsageTimer = setInterval(pollBrainUsage, 2000);
}

// One app per data dir: a second launch would start a second daemon and brain over the same daemon.json.
// userData lives inside the data dir so an isolated SINAPSE_HOME gets its own lock.
app.setPath("userData", path.join(sinapseDir(), "electron"));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// Signals skip "before-quit", which is what kills the brain PTY; without this the brain and its MCP servers outlive the app.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => app.quit());
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  init();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let teardownDone = false;
app.on("before-quit", (event) => {
  if (teardownDone) return;
  // Hold the quit until the daemon has stopped running turns; otherwise worker CLIs outlive the app.
  event.preventDefault();
  teardownDone = true;
  isQuitting = true;
  if (brainUsageTimer) {
    clearInterval(brainUsageTimer);
    brainUsageTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sseAbortController) {
    sseAbortController.abort();
  }
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  const daemonDone = ownsDaemon ? shutdownDaemon() : Promise.resolve();
  const killAllBrains = Promise.all(Array.from(brains.keys()).map((wsId) => killBrain(wsId)));
  Promise.race([Promise.all([killAllBrains, daemonDone]), timeout]).finally(() => app.quit());
});
