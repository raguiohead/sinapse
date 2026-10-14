import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
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

const api = {
  brain: {
    onData: (cb: (data: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: string) => cb(data);
      ipcRenderer.on(IPC.BRAIN_DATA, listener);
      return () => {
        ipcRenderer.removeListener(IPC.BRAIN_DATA, listener);
      };
    },
    write: (data: string): void => {
      ipcRenderer.send(IPC.BRAIN_INPUT, data);
    },
    resize: (cols: number, rows: number): void => {
      ipcRenderer.send(IPC.BRAIN_RESIZE, cols, rows);
    },
    getInfo: (): Promise<BrainInfo> => {
      return ipcRenderer.invoke(IPC.BRAIN_INFO);
    },
    setModel: (model: string | null): Promise<BrainInfo> => {
      return ipcRenderer.invoke(IPC.BRAIN_SET_MODEL, model);
    },
    onUsage: (cb: (usage: ContextUsage) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, usage: ContextUsage) => cb(usage);
      ipcRenderer.on(IPC.BRAIN_USAGE, listener);
      return () => {
        ipcRenderer.removeListener(IPC.BRAIN_USAGE, listener);
      };
    },
    onInfoChanged: (cb: (info: { model: string | null }) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, info: { model: string | null }) => cb(info);
      ipcRenderer.on(IPC.BRAIN_INFO_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.BRAIN_INFO_CHANGED, listener);
      };
    },
  },
  daemon: {
    onInfo: (cb: (info: DaemonInfo) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, info: DaemonInfo) => cb(info);
      ipcRenderer.on(IPC.DAEMON_INFO, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_INFO, listener);
      };
    },
    onEvent: (cb: (e: DaemonEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, e: DaemonEvent) => cb(e);
      ipcRenderer.on(IPC.DAEMON_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_EVENT, listener);
      };
    },
    onStatus: (cb: (s: { connected: boolean }) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, s: { connected: boolean }) => cb(s);
      ipcRenderer.on(IPC.DAEMON_STATUS, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_STATUS, listener);
      };
    },
    details: (): Promise<DaemonDetails> => {
      return ipcRenderer.invoke(IPC.DAEMON_DETAILS);
    },
  },
  settings: {
    get: (): Promise<DesktopSettings> => {
      return ipcRenderer.invoke(IPC.SETTINGS_GET);
    },
    set: (patch: DesktopSettingsPatch): Promise<DesktopSettings> => {
      return ipcRenderer.invoke(IPC.SETTINGS_SET, patch);
    },
    onChanged: (cb: (settings: DesktopSettings) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, settings: DesktopSettings) => cb(settings);
      ipcRenderer.on(IPC.SETTINGS_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, listener);
      };
    },
  },
  windowControls: {
    minimize: (): void => {
      ipcRenderer.send(IPC.WINDOW_MINIMIZE);
    },
    toggleMaximize: (): void => {
      ipcRenderer.send(IPC.WINDOW_TOGGLE_MAXIMIZE);
    },
    close: (): void => {
      ipcRenderer.send(IPC.WINDOW_CLOSE);
    },
    isMaximized: (): Promise<boolean> => {
      return ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED);
    },
    onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, maximized: boolean) => cb(maximized);
      ipcRenderer.on(IPC.WINDOW_MAXIMIZED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZED, listener);
      };
    },
  },
  workers: {
    list: (): Promise<AgentState[]> => {
      return ipcRenderer.invoke(IPC.WORKER_LIST);
    },
    spawn: (payload: WorkerSpawnPayload): Promise<AgentState> => {
      return ipcRenderer.invoke(IPC.WORKER_SPAWN, payload);
    },
    update: (payload: WorkerUpdatePayload): Promise<AgentState> => {
      return ipcRenderer.invoke(IPC.WORKER_UPDATE, payload);
    },
    ask: (payload: WorkerAskPayload): Promise<{ turnId: string }> => {
      return ipcRenderer.invoke(IPC.WORKER_ASK, payload);
    },
    stop: (name: string): Promise<any> => {
      return ipcRenderer.invoke(IPC.WORKER_STOP, name);
    },
  },
  models: {
    list: (): Promise<ModelCatalog> => {
      return ipcRenderer.invoke(IPC.MODELS_LIST);
    },
  },
  notes: {
    list: (): Promise<NoteSummary[]> => {
      return ipcRenderer.invoke(IPC.NOTES_LIST);
    },
    read: (name: string): Promise<Note> => {
      return ipcRenderer.invoke(IPC.NOTE_READ, name);
    },
    write: (payload: NoteWritePayload): Promise<Note> => {
      return ipcRenderer.invoke(IPC.NOTE_WRITE, payload);
    },
    delete: (name: string): Promise<boolean> => {
      return ipcRenderer.invoke(IPC.NOTE_DELETE, name);
    },
  },
  app: {
    openExternal: (url: string): Promise<void> => {
      return ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, url);
    },
    openFolder: (key: FolderKey): Promise<void> => {
      return ipcRenderer.invoke(IPC.APP_OPEN_FOLDER, key);
    },
  },
};

contextBridge.exposeInMainWorld("sinapse", api);
