import type {
  DaemonEvent,
  ContextUsage,
  ModelCatalog,
  NoteSummary,
  Note,
  AgentState,
  Workspace,
} from "@sinapse/core";
import type {
  DaemonInfo,
  WorkerAskPayload,
  WorkerSpawnPayload,
  WorkerUpdatePayload,
  NoteWritePayload,
  BrainInfo,
  DesktopSettings,
  DesktopSettingsPatch,
  FolderKey,
  DaemonDetails,
  WorkspaceCreatePayload,
  WorkspaceUpdatePayload,
} from "../shared/ipc.js";

export interface SinapseBridge {
  /** One orchestrator terminal per workspace; started lazily when the workspace first becomes active. */
  brain: {
    onData: (cb: (workspaceId: string, data: string) => void) => () => void;
    write: (workspaceId: string, data: string) => void;
    resize: (workspaceId: string, cols: number, rows: number) => void;
    getInfo: (workspaceId: string) => Promise<BrainInfo>;
    /** Recent terminal output (ring buffer) to redraw the terminal after switching workspaces. */
    replay: (workspaceId: string) => Promise<string>;
    onUsage: (cb: (workspaceId: string, usage: ContextUsage) => void) => () => void;
    onInfoChanged: (cb: (info: BrainInfo) => void) => () => void;
  };
  daemon: {
    onInfo: (cb: (info: DaemonInfo) => void) => () => void;
    onEvent: (cb: (e: DaemonEvent) => void) => () => void;
    onStatus: (cb: (s: { connected: boolean }) => void) => () => void;
    details: () => Promise<DaemonDetails>;
  };
  workspaces: {
    list: () => Promise<Workspace[]>;
    /** Rejects with a Portuguese message (duplicate name, missing folder…). */
    create: (payload: WorkspaceCreatePayload) => Promise<Workspace>;
    update: (payload: WorkspaceUpdatePayload) => Promise<Workspace>;
    /** Stops its turns and orchestrator and removes its Sinapse data; never the project folder. Rejects for the last workspace. */
    delete: (workspaceId: string) => Promise<void>;
    getActive: () => Promise<string>;
    /** Starts that workspace's orchestrator if needed; persists the choice. */
    setActive: (workspaceId: string) => Promise<void>;
    onActiveChanged: (cb: (workspaceId: string) => void) => () => void;
  };
  settings: {
    get: () => Promise<DesktopSettings>;
    /** Resolves with the full saved settings; rejects with a Portuguese message on invalid input. */
    set: (patch: DesktopSettingsPatch) => Promise<DesktopSettings>;
    onChanged: (cb: (settings: DesktopSettings) => void) => () => void;
  };
  windowControls: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizedChanged: (cb: (maximized: boolean) => void) => () => void;
  };
  workers: {
    list: (workspaceId: string) => Promise<AgentState[]>;
    spawn: (payload: WorkerSpawnPayload) => Promise<AgentState>;
    update: (payload: WorkerUpdatePayload) => Promise<AgentState>;
    ask: (payload: WorkerAskPayload) => Promise<{ turnId: string }>;
    stop: (workspaceId: string, agent: string) => Promise<any>;
    /** Removes the worker; a running turn is interrupted first. Emits agent_deleted on the bus. */
    delete: (workspaceId: string, agent: string) => Promise<void>;
  };
  models: {
    list: () => Promise<ModelCatalog>;
  };
  /** Notes written from the canvas are authored by "usuario". */
  notes: {
    list: (workspaceId: string) => Promise<NoteSummary[]>;
    read: (workspaceId: string, name: string) => Promise<Note>;
    write: (payload: NoteWritePayload) => Promise<Note>;
    delete: (workspaceId: string, name: string) => Promise<boolean>;
  };
  app: {
    openExternal: (url: string) => Promise<void>;
    /** "dados" ignores workspaceId; the others resolve that workspace's folders. */
    openFolder: (key: FolderKey, workspaceId?: string) => Promise<void>;
    /** Native folder picker; null when cancelled. */
    pickFolder: () => Promise<string | null>;
  };
}

declare global {
  interface Window {
    sinapse: SinapseBridge;
  }
}
