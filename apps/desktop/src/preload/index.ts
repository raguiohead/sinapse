import { contextBridge, ipcRenderer } from "electron";
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
  type WorkspaceCreatePayload,
  type WorkspaceUpdatePayload,
  type CanvasLayout,
} from "../shared/ipc.js";

const api = {
  brain: {
    onData: (cb: (workspaceId: string, data: string) => void): (() => void) => {
      const listener = (_event: any, workspaceId: string, data: string) => cb(workspaceId, data);
      ipcRenderer.on(IPC.BRAIN_DATA, listener);
      return () => {
        ipcRenderer.removeListener(IPC.BRAIN_DATA, listener);
      };
    },
    write: (workspaceId: string, data: string): void => {
      ipcRenderer.send(IPC.BRAIN_INPUT, workspaceId, data);
    },
    resize: (workspaceId: string, cols: number, rows: number): void => {
      ipcRenderer.send(IPC.BRAIN_RESIZE, workspaceId, cols, rows);
    },
    getInfo: (workspaceId: string): Promise<BrainInfo> => {
      return ipcRenderer.invoke(IPC.BRAIN_INFO, workspaceId);
    },
    replay: (workspaceId: string): Promise<string> => {
      return ipcRenderer.invoke(IPC.BRAIN_REPLAY, workspaceId);
    },
    onUsage: (cb: (workspaceId: string, usage: ContextUsage) => void): (() => void) => {
      const listener = (_event: any, workspaceId: string, usage: ContextUsage) => cb(workspaceId, usage);
      ipcRenderer.on(IPC.BRAIN_USAGE, listener);
      return () => {
        ipcRenderer.removeListener(IPC.BRAIN_USAGE, listener);
      };
    },
    onInfoChanged: (cb: (info: BrainInfo) => void): (() => void) => {
      const listener = (_event: any, info: BrainInfo) => cb(info);
      ipcRenderer.on(IPC.BRAIN_INFO_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.BRAIN_INFO_CHANGED, listener);
      };
    },
  },
  daemon: {
    onInfo: (cb: (info: DaemonInfo) => void): (() => void) => {
      const listener = (_event: any, info: DaemonInfo) => cb(info);
      ipcRenderer.on(IPC.DAEMON_INFO, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_INFO, listener);
      };
    },
    onEvent: (cb: (e: DaemonEvent) => void): (() => void) => {
      const listener = (_event: any, e: DaemonEvent) => cb(e);
      ipcRenderer.on(IPC.DAEMON_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_EVENT, listener);
      };
    },
    onStatus: (cb: (s: { connected: boolean }) => void): (() => void) => {
      const listener = (_event: any, s: { connected: boolean }) => cb(s);
      ipcRenderer.on(IPC.DAEMON_STATUS, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_STATUS, listener);
      };
    },
    details: (): Promise<DaemonDetails> => {
      return ipcRenderer.invoke(IPC.DAEMON_DETAILS);
    },
  },
  workspaces: {
    list: (): Promise<Workspace[]> => {
      return ipcRenderer.invoke(IPC.WORKSPACES_LIST);
    },
    create: (payload: WorkspaceCreatePayload): Promise<Workspace> => {
      return ipcRenderer.invoke(IPC.WORKSPACES_CREATE, payload);
    },
    update: (payload: WorkspaceUpdatePayload): Promise<Workspace> => {
      return ipcRenderer.invoke(IPC.WORKSPACES_UPDATE, payload);
    },
    delete: (workspaceId: string): Promise<void> => {
      return ipcRenderer.invoke(IPC.WORKSPACES_DELETE, workspaceId);
    },
    getActive: (): Promise<string> => {
      return ipcRenderer.invoke(IPC.WORKSPACE_GET_ACTIVE);
    },
    setActive: (workspaceId: string): Promise<void> => {
      return ipcRenderer.invoke(IPC.WORKSPACE_SET_ACTIVE, workspaceId);
    },
    onActiveChanged: (cb: (workspaceId: string) => void): (() => void) => {
      const listener = (_event: any, workspaceId: string) => cb(workspaceId);
      ipcRenderer.on(IPC.WORKSPACE_ACTIVE_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.WORKSPACE_ACTIVE_CHANGED, listener);
      };
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
      const listener = (_event: any, settings: DesktopSettings) => cb(settings);
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
      const listener = (_event: any, maximized: boolean) => cb(maximized);
      ipcRenderer.on(IPC.WINDOW_MAXIMIZED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZED, listener);
      };
    },
  },
  workers: {
    list: (workspaceId: string): Promise<AgentState[]> => {
      return ipcRenderer.invoke(IPC.WORKER_LIST, workspaceId);
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
    stop: (workspaceId: string, agent: string): Promise<any> => {
      return ipcRenderer.invoke(IPC.WORKER_STOP, workspaceId, agent);
    },
    delete: (workspaceId: string, agent: string): Promise<void> => {
      return ipcRenderer.invoke(IPC.WORKER_DELETE, workspaceId, agent);
    },
    handoff: (workspaceId: string, agent: string): Promise<HandoffResponse> => {
      return ipcRenderer.invoke(IPC.WORKER_HANDOFF, workspaceId, agent);
    },
    history: (workspaceId: string, agent: string, limit?: number): Promise<TurnRecord[]> => {
      return ipcRenderer.invoke(IPC.WORKER_HISTORY, workspaceId, agent, limit);
    },
  },
  layout: {
    get: (workspaceId: string): Promise<CanvasLayout | null> => {
      return ipcRenderer.invoke(IPC.LAYOUT_GET, workspaceId);
    },
    save: (workspaceId: string, layout: CanvasLayout): Promise<void> => {
      return ipcRenderer.invoke(IPC.LAYOUT_SAVE, workspaceId, layout);
    },
  },
  models: {
    list: (): Promise<ModelCatalog> => {
      return ipcRenderer.invoke(IPC.MODELS_LIST);
    },
  },
  notes: {
    list: (workspaceId: string): Promise<NoteSummary[]> => {
      return ipcRenderer.invoke(IPC.NOTES_LIST, workspaceId);
    },
    read: (workspaceId: string, name: string): Promise<Note> => {
      return ipcRenderer.invoke(IPC.NOTE_READ, workspaceId, name);
    },
    write: (payload: NoteWritePayload): Promise<Note> => {
      return ipcRenderer.invoke(IPC.NOTE_WRITE, payload);
    },
    delete: (workspaceId: string, name: string): Promise<boolean> => {
      return ipcRenderer.invoke(IPC.NOTE_DELETE, workspaceId, name);
    },
  },
  app: {
    openExternal: (url: string): Promise<void> => {
      return ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, url);
    },
    openFolder: (key: FolderKey, workspaceId?: string): Promise<void> => {
      return ipcRenderer.invoke(IPC.APP_OPEN_FOLDER, key, workspaceId);
    },
    pickFolder: (): Promise<string | null> => {
      return ipcRenderer.invoke(IPC.APP_PICK_FOLDER);
    },
  },
};

contextBridge.exposeInMainWorld("sinapse", api);
