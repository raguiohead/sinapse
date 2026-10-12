import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
let ptyProcess: pty.IPty | null = null;

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

function createWindow(): BrowserWindow {
  const currentDir = getCurrentDir();
  const preloadPath = resolvePreloadPath();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a0f",
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
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (daemonInfo && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.DAEMON_INFO, daemonInfo);
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

  const userPath = process.env.PATH || "";
  const extraPaths = [
    path.join(process.env.HOME || "", ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const combinedPath = Array.from(new Set([...userPath.split(":"), ...extraPaths]))
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

    ptyProcess.onExit(({ exitCode, signal }) => {
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

    const response = await fetch(`http://127.0.0.1:${daemonInfo.port}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonInfo.token}`,
      },
      body: JSON.stringify(payload),
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
      body: JSON.stringify({ prompt: payload.prompt }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to ask worker ${payload.name}: ${response.status} ${errText}`);
    }

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const eventData = JSON.parse(trimmed);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.WORKER_EVENTS, {
                agent: payload.name,
                ...eventData,
              });
            }
          } catch (err) {
            console.error("Failed to parse worker NDJSON event line:", trimmed, err);
          }
        }
      }

      if (buffer.trim()) {
        try {
          const eventData = JSON.parse(buffer.trim());
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.WORKER_EVENTS, {
              agent: payload.name,
              ...eventData,
            });
          }
        } catch (err) {
          console.error("Failed to parse final worker NDJSON event line:", buffer, err);
        }
      }
    } catch (streamErr) {
      console.error("Error reading stream from worker ask:", streamErr);
      throw streamErr;
    }
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
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {}
  }
});
