import type {
  DaemonEvent,
  ContextUsage,
  ModelCatalog,
  NoteSummary,
  Note,
  AgentState,
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
} from "../shared/ipc.js";

export interface SinapseBridge {
  brain: {
    onData: (cb: (data: string) => void) => () => void;
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    getInfo: () => Promise<BrainInfo>;
    setModel: (model: string | null) => Promise<BrainInfo>;
    onUsage: (cb: (usage: ContextUsage) => void) => () => void;
    onInfoChanged: (cb: (info: { model: string | null }) => void) => () => void;
  };
  daemon: {
    onInfo: (cb: (info: DaemonInfo) => void) => () => void;
    onEvent: (cb: (e: DaemonEvent) => void) => () => void;
    onStatus: (cb: (s: { connected: boolean }) => void) => () => void;
    details: () => Promise<DaemonDetails>;
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
    list: () => Promise<AgentState[]>;
    spawn: (payload: WorkerSpawnPayload) => Promise<AgentState>;
    update: (payload: WorkerUpdatePayload) => Promise<AgentState>;
    ask: (payload: WorkerAskPayload) => Promise<{ turnId: string }>;
    stop: (name: string) => Promise<any>;
    /** Removes the worker; a running turn is interrupted first. Emits agent_deleted on the bus. */
    delete: (name: string) => Promise<void>;
  };
  models: {
    list: () => Promise<ModelCatalog>;
  };
  notes: {
    list: () => Promise<NoteSummary[]>;
    read: (name: string) => Promise<Note>;
    write: (payload: NoteWritePayload) => Promise<Note>;
    delete: (name: string) => Promise<boolean>;
  };
  app: {
    openExternal: (url: string) => Promise<void>;
    openFolder: (key: FolderKey) => Promise<void>;
  };
}

declare global {
  interface Window {
    sinapse: SinapseBridge;
  }
}
