import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import type {
  DaemonEvent,
  ContextUsage,
  ModelCatalog,
  NoteSummary,
  Note,
  AgentState,
} from "@sinapse/core";
import {
  IPC,
  type DaemonInfo,
  type WorkerAskPayload,
  type WorkerSpawnPayload,
  type WorkerUpdatePayload,
  type NoteWritePayload,
  type BrainInfo,
} from "../shared/ipc.js";

const _require = createRequire(import.meta.url);
const pty: typeof import("node-pty") = _require("node-pty");
const {
  startDaemon,
  shutdownDaemon,
  sweepEnvMarker,
  sinapseDir,
  estimateContextWindow,
}: typeof import("@sinapse/core") = _require("@sinapse/core");

let mainWindow: BrowserWindow | null = null;
let daemonInfo: DaemonInfo | null = null;
let ptyProcess: IPty | null = null;
let isDaemonConnected = false;
let sseAbortController: AbortController | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isQuitting = false;

let brainModel: string | null = null;
let latestBrainUsage: ContextUsage | undefined = undefined;
let brainUsageTimer: NodeJS.Timeout | null = null;
let ptyStartTime = 0;
let brainSession = "";

/**
 * Ends the brain PTY, then sweeps what it left behind once it had a moment to exit cleanly:
 * some MCP servers detach from the brain, but they inherit SINAPSE_BRAIN_SESSION.
 */
function killBrain(): Promise<void> {
  const session = brainSession;
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {}
    ptyProcess = null;
  }
  return new Promise((resolve) =>
    setTimeout(() => {
      sweepEnvMarker("SINAPSE_BRAIN_SESSION", session);
      resolve();
    }, 1000)
  );
}
let currentCols = 80;
let currentRows = 24;

const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;

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

function loadSavedBrainModel(): string | null {
  try {
    const configPath = getDesktopConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const data = JSON.parse(content);
      if (typeof data.brainModel === "string" && MODEL_REGEX.test(data.brainModel)) {
        return data.brainModel;
      }
    }
  } catch (err) {
    console.warn("Failed to load desktop.json:", err);
  }
  return null;
}

function saveBrainModel(model: string | null): void {
  try {
    const dir = sinapseDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const configPath = getDesktopConfigPath();
    let data: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      try {
        data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch {}
    }
    if (model) {
      data.brainModel = model;
    } else {
      delete data.brainModel;
    }
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save desktop.json:", err);
  }
}

function getTranscriptDir(): string {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    os.homedir().replace(/[^a-zA-Z0-9]/g, "-")
  );
}

// Session of the brain's own transcript (written after its PTY started). Resuming by id, not `--continue`,
// because the home folder also holds the user's unrelated Claude Code sessions.
let brainSessionId: string | null = null;

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

function pollBrainUsage(): void {
  try {
    const dir = getTranscriptDir();
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return;

    const minMtime = ptyStartTime - 5000;
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
    brainSessionId = path.basename(newestFile, ".jsonl");

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

          if (!isUsageEqual(latestBrainUsage, newUsage)) {
            latestBrainUsage = newUsage;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.BRAIN_USAGE, newUsage);
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

function broadcastDaemonStatus(connected: boolean): void {
  isDaemonConnected = connected;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.DAEMON_STATUS, { connected });
  }
}

async function connectDaemonSSE(): Promise<void> {
  if (!daemonInfo || isQuitting) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  sseAbortController = new AbortController();
  const url = `http://127.0.0.1:${daemonInfo.port}/events`;

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

  mainWindow = new BrowserWindow({
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

function spawnClaudePTY(model?: string | null, resumeSessionId?: string | null): void {
  if (!daemonInfo) return;
  if (ptyProcess) void killBrain();

  const home = os.homedir();
  const cliBinPath = path.resolve(app.getAppPath(), "../../node_modules/.bin");
  const localBin = path.join(home, ".local", "bin");
  const userPath = (process.env.PATH || "").split(path.delimiter);
  const extraPaths =
    process.platform !== "win32" ? ["/usr/local/bin", "/usr/bin", "/bin"] : [];
  const combinedPath = Array.from(new Set([cliBinPath, localBin, ...userPath, ...extraPaths]))
    .filter(Boolean)
    .join(path.delimiter);

  const args: string[] = [];
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  if (model) {
    args.push("--model", model);
  }

  try {
    ptyStartTime = Date.now();
    brainSession = randomUUID();
    const proc = pty.spawn("claude", args, {
      name: "xterm-256color",
      cols: currentCols,
      rows: currentRows,
      cwd: os.homedir(),
      env: {
        ...process.env,
        PATH: combinedPath,
        SINAPSE_URL: `http://127.0.0.1:${daemonInfo.port}`,
        SINAPSE_TOKEN: daemonInfo.token,
        SINAPSE_BRAIN_SESSION: brainSession,
      },
    });

    ptyProcess = proc;

    proc.onData((data: string) => {
      // A killed PTY can still flush output; only the current one may write to the terminal.
      if (proc !== ptyProcess) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.BRAIN_DATA, data);
      }
    });

    proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      console.log(`Claude PTY exited (exitCode=${exitCode}, signal=${signal})`);
    });
  } catch (err) {
    console.error("Failed to spawn claude PTY process:", err);
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

function registerIpcHandlers(): void {
  ipcMain.on(IPC.BRAIN_INPUT, (_event, data: string) => {
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  });

  ipcMain.on(IPC.BRAIN_RESIZE, (_event, cols: number, rows: number) => {
    currentCols = cols;
    currentRows = rows;
    if (ptyProcess) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (err) {
        console.error("Error resizing PTY:", err);
      }
    }
  });

  ipcMain.handle(IPC.BRAIN_INFO, async (): Promise<BrainInfo> => {
    return {
      model: brainModel,
      usage: latestBrainUsage,
    };
  });

  ipcMain.handle(IPC.BRAIN_SET_MODEL, async (_event, model: string | null): Promise<BrainInfo> => {
    let validatedModel: string | null = null;
    if (typeof model === "string" && model.trim() !== "") {
      const trimmed = model.trim();
      if (!MODEL_REGEX.test(trimmed)) {
        throw new Error("Modelo inválido");
      }
      validatedModel = trimmed;
    }

    brainModel = validatedModel;
    saveBrainModel(validatedModel);

    void killBrain();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.BRAIN_DATA, "\x1bc");
    }

    spawnClaudePTY(brainModel, brainSessionId);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.BRAIN_INFO_CHANGED, { model: brainModel });
    }

    return {
      model: brainModel,
      usage: latestBrainUsage,
    };
  });

  ipcMain.handle(IPC.MODELS_LIST, async (): Promise<ModelCatalog> => {
    const res = await daemonFetch("/models");
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to list models: ${res.status} ${errText}`);
    }
    return (await res.json()) as ModelCatalog;
  });

  ipcMain.handle(IPC.WORKER_LIST, async () => {
    const response = await daemonFetch("/agents", { method: "GET" });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to list workers: ${response.status} ${errText}`);
    }
    return await response.json();
  });

  ipcMain.handle(IPC.WORKER_SPAWN, async (_event, payload: WorkerSpawnPayload) => {
    const cwd =
      payload.cwd && payload.cwd.trim() !== ""
        ? path.resolve(payload.cwd)
        : (process.env.HOME || process.cwd());

    const body: Record<string, any> = {
      ...payload,
      cwd,
      autonomy: payload.autonomy || "edit",
    };
    if (payload.model) {
      body.model = payload.model;
    }

    const response = await daemonFetch("/agents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to spawn worker: ${response.status} ${errText}`);
    }

    return await response.json();
  });

  ipcMain.handle(IPC.WORKER_UPDATE, async (_event, payload: WorkerUpdatePayload): Promise<AgentState> => {
    const response = await daemonFetch(`/agents/${encodeURIComponent(payload.name)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: payload.model }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `Failed to update worker: ${response.status}`);
    }

    return (await response.json()) as AgentState;
  });

  ipcMain.handle(IPC.WORKER_ASK, async (_event, payload: WorkerAskPayload) => {
    const url = `/agents/${encodeURIComponent(payload.name)}/ask`;
    const response = await daemonFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: payload.prompt, async: true }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to ask worker ${payload.name}: ${response.status} ${errText}`);
    }

    return (await response.json()) as { turnId: string };
  });

  ipcMain.handle(IPC.WORKER_STOP, async (_event, name: string) => {
    const url = `/agents/${encodeURIComponent(name)}/stop`;
    const response = await daemonFetch(url, {
      method: "POST",
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to stop worker ${name}: ${response.status} ${errText}`);
    }

    return await response.json();
  });

  ipcMain.handle(IPC.NOTES_LIST, async (): Promise<NoteSummary[]> => {
    const response = await daemonFetch("/notes", { method: "GET" });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to list notes: ${response.status} ${errText}`);
    }
    return (await response.json()) as NoteSummary[];
  });

  ipcMain.handle(IPC.NOTE_READ, async (_event, name: string): Promise<Note> => {
    const response = await daemonFetch(`/notes/${encodeURIComponent(name)}`, { method: "GET" });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to read note ${name}: ${response.status} ${errText}`);
    }
    return (await response.json()) as Note;
  });

  ipcMain.handle(IPC.NOTE_WRITE, async (_event, payload: NoteWritePayload): Promise<Note> => {
    const response = await daemonFetch(`/notes/${encodeURIComponent(payload.name)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: payload.content }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to write note ${payload.name}: ${response.status} ${errText}`);
    }
    return (await response.json()) as Note;
  });

  ipcMain.handle(IPC.NOTE_DELETE, async (_event, name: string): Promise<boolean> => {
    const response = await daemonFetch(`/notes/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to delete note ${name}: ${response.status} ${errText}`);
    }
    return true;
  });

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
}

let ownsDaemon = false;

// A daemon started by the CLI may already serve this data dir; a second one would overwrite its state.json.
async function findRunningDaemon(): Promise<DaemonInfo | null> {
  try {
    const raw = fs.readFileSync(path.join(sinapseDir(), "daemon.json"), "utf8");
    const { port, token } = JSON.parse(raw);
    if (!port || !token) return null;
    const res = await fetch(`http://127.0.0.1:${port}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? { port, token } : null;
  } catch {
    return null;
  }
}

async function init(): Promise<void> {
  brainModel = loadSavedBrainModel();

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
  spawnClaudePTY(brainModel, null);

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
  Promise.race([Promise.all([killBrain(), daemonDone]), timeout]).finally(() => app.quit());
});
