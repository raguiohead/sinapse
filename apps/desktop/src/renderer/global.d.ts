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
  };
  workers: {
    list: () => Promise<AgentState[]>;
    spawn: (payload: WorkerSpawnPayload) => Promise<AgentState>;
    update: (payload: WorkerUpdatePayload) => Promise<AgentState>;
    ask: (payload: WorkerAskPayload) => Promise<{ turnId: string }>;
    stop: (name: string) => Promise<any>;
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
  };
}

declare global {
  interface Window {
    sinapse: SinapseBridge;
  }
}
