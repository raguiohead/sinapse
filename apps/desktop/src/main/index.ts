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
  type DesktopSettings,
  type DesktopSettingsPatch,
  type FolderKey,
  type DaemonDetails,
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
}: typeof import("@sinapse/core") = _require("@sinapse/core");

function getDefaultSettings(): DesktopSettings {
  return {
    workerDefaults: {
      provider: "agy",
      autonomy: "edit",
      cwd: os.homedir(),
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
let ptyProcess: IPty | null = null;
let isDaemonConnected = false;
let sseAbortController: AbortController | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isQuitting = false;

let settings: DesktopSettings = getDefaultSettings();
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

function loadSettings(): DesktopSettings {
  const current = getDefaultSettings();
  try {
    const configPath = getDesktopConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const data = JSON.parse(content);
      if (data && typeof data === "object") {
        if (typeof data.brainModel === "string" && MODEL_REGEX.test(data.brainModel.trim())) {
          current.brainModel = data.brainModel.trim();
        }
        if (data.workerDefaults && typeof data.workerDefaults === "object") {
          const wd = data.workerDefaults;
          if (wd.provider === "claude" || wd.provider === "agy") {
            current.workerDefaults.provider = wd.provider;
          }
          if (wd.autonomy === "read" || wd.autonomy === "edit" || wd.autonomy === "full") {
            current.workerDefaults.autonomy = wd.autonomy;
          }
          if (typeof wd.cwd === "string" && wd.cwd.trim() !== "") {
            try {
              const resolved = path.resolve(wd.cwd);
              if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                current.workerDefaults.cwd = resolved;
              }
            } catch {}
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

const BRAIN_GUIDE = `# Cérebro do Sinapse

Você é o cérebro do Sinapse: conversa com o usuário e delega trabalho a workers pela skill \`sinapse\`.

- Esta pasta é só a sua base. Os projetos do usuário ficam em outras pastas: trabalhe neles por caminho absoluto e passe a pasta certa aos workers com \`--cwd\`.
- O canvas mostra ao vivo os workers, as delegações e as notas (\`sinapse note\`).
`;

/**
 * The brain runs in its own folder, not in home: Claude Code doesn't persist trust for the home folder
 * (it asks again on every new session), and home transcripts mix with the user's other sessions.
 */
function brainCwd(): string {
  const dir = path.join(sinapseDir(), "cerebro");
  fs.mkdirSync(dir, { recursive: true });
  const guide = path.join(dir, "CLAUDE.md");
  if (!fs.existsSync(guide)) fs.writeFileSync(guide, BRAIN_GUIDE);
  return dir;
}

// Claude Code names a project's transcript folder after its cwd, with every non-alphanumeric char as "-".
function getTranscriptDir(): string {
  return path.join(os.homedir(), ".claude", "projects", brainCwd().replace(/[^a-zA-Z0-9]/g, "-"));
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
      cwd: brainCwd(),
      env: agentEnv({
        PATH: combinedPath,
        SINAPSE_URL: `http://127.0.0.1:${daemonInfo.port}`,
        SINAPSE_TOKEN: daemonInfo.token,
        SINAPSE_BRAIN_SESSION: brainSession,
      }) as Record<string, string>,
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

function applyBrainModel(model: string | null): BrainInfo {
  brainModel = model;
  if (model) {
    settings.brainModel = model;
  } else {
    delete settings.brainModel;
  }
  saveSettings(settings);

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

    // 1. Validate everything before applying anything
    let nextBrainModel: string | null | undefined = undefined;
    if ("brainModel" in patch && patch.brainModel !== undefined) {
      if (patch.brainModel === null || (typeof patch.brainModel === "string" && patch.brainModel.trim() === "")) {
        nextBrainModel = null;
      } else if (typeof patch.brainModel === "string" && MODEL_REGEX.test(patch.brainModel.trim())) {
        nextBrainModel = patch.brainModel.trim();
      } else {
        throw new Error("Modelo inválido");
      }
    }

    let resolvedCwd: string | undefined = undefined;
    let nextWorkerModel: string | null | undefined = undefined;
    if (patch.workerDefaults !== undefined) {
      if (!patch.workerDefaults || typeof patch.workerDefaults !== "object") {
        throw new Error("Configurações do worker inválidas");
      }
      if (patch.workerDefaults.provider !== undefined) {
        if (patch.workerDefaults.provider !== "claude" && patch.workerDefaults.provider !== "agy") {
          throw new Error("Provedor inválido: deve ser 'claude' ou 'agy'");
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
      if (patch.workerDefaults.cwd !== undefined) {
        if (typeof patch.workerDefaults.cwd !== "string" || !patch.workerDefaults.cwd.trim()) {
          throw new Error("Pasta inválida");
        }
        resolvedCwd = path.resolve(patch.workerDefaults.cwd);
        try {
          if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
            throw new Error(`Pasta não encontrada: ${resolvedCwd}`);
          }
        } catch (err: any) {
          if (err.message && err.message.startsWith("Pasta não encontrada:")) {
            throw err;
          }
          throw new Error(`Pasta não encontrada: ${resolvedCwd}`);
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

    // 2. Merge field by field
    if (patch.workerDefaults) {
      if (patch.workerDefaults.provider !== undefined) {
        settings.workerDefaults.provider = patch.workerDefaults.provider;
      }
      if (patch.workerDefaults.autonomy !== undefined) {
        settings.workerDefaults.autonomy = patch.workerDefaults.autonomy;
      }
      if (resolvedCwd !== undefined) {
        settings.workerDefaults.cwd = resolvedCwd;
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

    const currentBrainModel = settings.brainModel ?? null;
    const brainModelChanged = nextBrainModel !== undefined && nextBrainModel !== currentBrainModel;

    if (brainModelChanged && nextBrainModel !== undefined) {
      applyBrainModel(nextBrainModel);
    } else {
      saveSettings(settings);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SETTINGS_CHANGED, settings);
    }

    return settings;
  });

  // Brain
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

    const info = applyBrainModel(validatedModel);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SETTINGS_CHANGED, settings);
    }

    return info;
  });

  // Daemon details
  ipcMain.handle(IPC.DAEMON_DETAILS, async (): Promise<DaemonDetails> => {
    if (!daemonInfo) {
      throw new Error("Sinapse daemon is not ready");
    }
    return {
      port: daemonInfo.port,
      dataDir: sinapseDir(),
      brainDir: brainCwd(),
      notesDir: path.join(sinapseDir(), "notes"),
      ownsDaemon,
    };
  });

  // Models
  ipcMain.handle(IPC.MODELS_LIST, async (): Promise<ModelCatalog> => {
    const res = await daemonFetch("/models");
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to list models: ${res.status} ${errText}`);
    }
    return (await res.json()) as ModelCatalog;
  });

  // Workers
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

  // Notes
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

  ipcMain.handle(IPC.APP_OPEN_FOLDER, async (_event, key: FolderKey): Promise<void> => {
    let targetDir: string;
    if (key === "dados") {
      targetDir = sinapseDir();
    } else if (key === "cerebro") {
      targetDir = brainCwd();
    } else if (key === "notas") {
      targetDir = path.join(sinapseDir(), "notes");
    } else {
      throw new Error(`Pasta inválida: ${String(key)}`);
    }
    fs.mkdirSync(targetDir, { recursive: true });
    await shell.openPath(targetDir);
  });
}

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
  settings = loadSettings();
  brainModel = settings.brainModel ?? null;

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
