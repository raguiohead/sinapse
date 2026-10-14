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
  APP_OPEN_FOLDER: "app:open-folder",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SETTINGS_CHANGED: "settings:changed",
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_TOGGLE_MAXIMIZE: "window:toggle-maximize",
  WINDOW_CLOSE: "window:close",
  WINDOW_MAXIMIZED: "window:maximized",
  WINDOW_IS_MAXIMIZED: "window:is-maximized",
  DAEMON_DETAILS: "daemon:details",
} as const;

export type Autonomy = "read" | "edit" | "full";

export interface WorkerDefaults {
  provider: "claude" | "agy";
  /** Undefined = provider default. */
  model?: string;
  autonomy: Autonomy;
  /** Absolute path. */
  cwd: string;
}

export interface AppearanceSettings {
  chromaticBar: "animada" | "estatica" | "desligada";
  motion: "sistema" | "reduzido";
  /** 10–22. */
  terminalFontSize: number;
}

/** Persisted in <sinapseDir>/desktop.json. */
export interface DesktopSettings {
  /** Undefined = account default. */
  brainModel?: string;
  workerDefaults: WorkerDefaults;
  appearance: AppearanceSettings;
}

/**
 * settings:set payload: any subset; nested objects merge field by field.
 * brainModel: null clears it (account default); a changed brainModel restarts the brain (resuming its session).
 */
export interface DesktopSettingsPatch {
  brainModel?: string | null;
  workerDefaults?: Partial<WorkerDefaults> & { model?: string | null };
  appearance?: Partial<AppearanceSettings>;
}

/** Only these known folders can be opened; the renderer never sends a path. */
export type FolderKey = "dados" | "cerebro" | "notas";

export interface DaemonDetails {
  port: number;
  dataDir: string;
  brainDir: string;
  notesDir: string;
  /** False when the app reuses a daemon started by the CLI. */
  ownsDaemon: boolean;
}

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
  autonomy: Autonomy;
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
