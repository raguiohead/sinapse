import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import type { DaemonEvent } from "@sinapse/core";
import {
  IPC,
  type DaemonInfo,
  type WorkerAskPayload,
  type WorkerSpawnPayload,
} from "../shared/ipc.js";

const _require = createRequire(import.meta.url);
const pty: typeof import("node-pty") = _require("node-pty");
const { startDaemon }: typeof import("@sinapse/core") = _require("@sinapse/core");

let mainWindow: BrowserWindow | null = null;
let daemonInfo: DaemonInfo | null = null;
let ptyProcess: IPty | null = null;
let isDaemonConnected = false;
let sseAbortController: AbortController | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isQuitting = false;

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
          // Comment line (e.g. heartbeat ping or initial connected notice)
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

function spawnClaudePTY(): void {
  if (!daemonInfo) return;

  const cliBinPath = path.resolve(app.getAppPath(), "../../node_modules/.bin");
  const userPath = process.env.PATH || "";
  const extraPaths = [
    path.join(process.env.HOME || "", ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const combinedPath = Array.from(new Set([cliBinPath, ...userPath.split(":"), ...extraPaths]))
    .filter(Boolean)
    .join(":");

  try {
    ptyProcess = pty.spawn("claude", [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || process.cwd(),
      env: {
        ...process.env,
        PATH: combinedPath,
        SINAPSE_URL: `http://127.0.0.1:${daemonInfo.port}`,
        SINAPSE_TOKEN: daemonInfo.token,
      },
    });

    ptyProcess.onData((data: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.BRAIN_DATA, data);
      }
    });

    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      console.log(`Claude PTY exited (exitCode=${exitCode}, signal=${signal})`);
    });
  } catch (err) {
    console.error("Failed to spawn claude PTY process:", err);
  }
}

function registerIpcHandlers(): void {
  ipcMain.on(IPC.BRAIN_INPUT, (_event, data: string) => {
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  });

  ipcMain.on(IPC.BRAIN_RESIZE, (_event, cols: number, rows: number) => {
    if (ptyProcess) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (err) {
        console.error("Error resizing PTY:", err);
      }
    }
  });

  ipcMain.handle(IPC.WORKER_LIST, async () => {
    if (!daemonInfo) {
      throw new Error("Sinapse daemon is not ready");
    }
    const response = await fetch(`http://127.0.0.1:${daemonInfo.port}/agents`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${daemonInfo.token}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to list workers: ${response.status} ${errText}`);
    }

    return await response.json();
  });

  ipcMain.handle(IPC.WORKER_SPAWN, async (_event, payload: WorkerSpawnPayload) => {
    if (!daemonInfo) {
      throw new Error("Sinapse daemon is not ready");
    }

    const cwd =
      payload.cwd && payload.cwd.trim() !== ""
        ? path.resolve(payload.cwd)
        : (process.env.HOME || process.cwd());

    const response = await fetch(`http://127.0.0.1:${daemonInfo.port}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonInfo.token}`,
      },
      body: JSON.stringify({
        ...payload,
        cwd,
        autonomy: payload.autonomy || "edit",
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to spawn worker: ${response.status} ${errText}`);
    }

    return await response.json();
  });

  ipcMain.handle(IPC.WORKER_ASK, async (_event, payload: WorkerAskPayload) => {
    if (!daemonInfo) {
      throw new Error("Sinapse daemon is not ready");
    }

    const url = `http://127.0.0.1:${daemonInfo.port}/agents/${encodeURIComponent(payload.name)}/ask`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonInfo.token}`,
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
    if (!daemonInfo) {
      throw new Error("Sinapse daemon is not ready");
    }

    const url = `http://127.0.0.1:${daemonInfo.port}/agents/${encodeURIComponent(name)}/stop`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonInfo.token}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to stop worker ${name}: ${response.status} ${errText}`);
    }

    return await response.json();
  });
}

async function init(): Promise<void> {
  try {
    const started = await startDaemon();
    daemonInfo = { port: started.port, token: started.token };
    console.log(`Daemon started on port ${daemonInfo.port}`);
    connectDaemonSSE();
  } catch (err) {
    console.error("Failed to start daemon:", err);
  }

  registerIpcHandlers();
  createWindow();
  spawnClaudePTY();
}

app.whenReady().then(() => {
  init();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  isQuitting = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sseAbortController) {
    sseAbortController.abort();
  }
  if (process.platform !== "darwin") {
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {}
    }
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sseAbortController) {
    sseAbortController.abort();
  }
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {}
  }
});
