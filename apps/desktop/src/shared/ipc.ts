import type { ContextUsage } from "@sinapse/core";

export const IPC = {
  BRAIN_DATA: "brain:data",
  BRAIN_RESIZE: "brain:resize",
  BRAIN_INPUT: "brain:input",
  BRAIN_INFO: "brain:info",
  BRAIN_SET_MODEL: "brain:set-model",
  BRAIN_USAGE: "brain:usage",
  BRAIN_INFO_CHANGED: "brain:info-changed",
  DAEMON_INFO: "daemon:info",
  DAEMON_EVENT: "daemon:event",
  DAEMON_STATUS: "daemon:status",
  WORKER_ASK: "worker:ask",
  WORKER_SPAWN: "worker:spawn",
  WORKER_LIST: "worker:list",
  WORKER_STOP: "worker:stop",
  WORKER_UPDATE: "worker:update",
  MODELS_LIST: "models:list",
  NOTES_LIST: "notes:list",
  NOTE_READ: "note:read",
  NOTE_WRITE: "note:write",
  NOTE_DELETE: "note:delete",
  APP_OPEN_EXTERNAL: "app:open-external",
} as const;

export interface DaemonInfo {
  port: number;
  token: string;
}

export interface WorkerAskPayload {
  name: string;
  prompt: string;
}

export interface WorkerSpawnPayload {
  name: string;
  provider: "claude" | "agy";
  cwd?: string;
  role: string;
  autonomy: "read" | "edit" | "full";
  model?: string;
}

export interface WorkerUpdatePayload {
  name: string;
  model: string | null;
}

export interface NoteWritePayload {
  name: string;
  content: string;
}

export interface BrainInfo {
  model: string | null;
  usage?: ContextUsage;
}
