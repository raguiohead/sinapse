import type { ContextUsage, OrchestratorConfig, Provider } from "@sinapse/core";

export const IPC = {
  // Orchestrator ("brain") terminals — one per workspace, all calls carry the workspaceId.
  BRAIN_DATA: "brain:data",
  BRAIN_RESIZE: "brain:resize",
  BRAIN_INPUT: "brain:input",
  BRAIN_INFO: "brain:info",
  BRAIN_REPLAY: "brain:replay",
  BRAIN_USAGE: "brain:usage",
  BRAIN_INFO_CHANGED: "brain:info-changed",
  DAEMON_INFO: "daemon:info",
  DAEMON_EVENT: "daemon:event",
  DAEMON_STATUS: "daemon:status",
  DAEMON_DETAILS: "daemon:details",
  WORKSPACES_LIST: "workspaces:list",
  WORKSPACES_CREATE: "workspaces:create",
  WORKSPACES_UPDATE: "workspaces:update",
  WORKSPACES_DELETE: "workspaces:delete",
  WORKSPACE_GET_ACTIVE: "workspace:get-active",
  WORKSPACE_SET_ACTIVE: "workspace:set-active",
  WORKSPACE_ACTIVE_CHANGED: "workspace:active-changed",
  WORKER_ASK: "worker:ask",
  WORKER_SPAWN: "worker:spawn",
  WORKER_LIST: "worker:list",
  WORKER_STOP: "worker:stop",
  WORKER_UPDATE: "worker:update",
  WORKER_DELETE: "worker:delete",
  WORKER_HANDOFF: "worker:handoff",
  WORKER_HISTORY: "worker:history",
  LAYOUT_GET: "layout:get",
  LAYOUT_SAVE: "layout:save",
  MODELS_LIST: "models:list",
  SQUADS_LIST: "squads:list",
  SQUADS_APPLY: "squads:apply",
  NOTES_LIST: "notes:list",
  NOTE_READ: "note:read",
  NOTE_WRITE: "note:write",
  NOTE_DELETE: "note:delete",
  APP_OPEN_EXTERNAL: "app:open-external",
  APP_OPEN_FOLDER: "app:open-folder",
  APP_PICK_FOLDER: "app:pick-folder",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SETTINGS_CHANGED: "settings:changed",
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_TOGGLE_MAXIMIZE: "window:toggle-maximize",
  WINDOW_CLOSE: "window:close",
  WINDOW_MAXIMIZED: "window:maximized",
  WINDOW_IS_MAXIMIZED: "window:is-maximized",
} as const;

export type Autonomy = "read" | "edit" | "full";

/** New workers default to the active workspace's folder; there is no global default folder. */
export interface WorkerDefaults {
  provider: Provider;
  /** Undefined = provider default. */
  model?: string;
  autonomy: Autonomy;
}

export interface AppearanceSettings {
  chromaticBar: "animada" | "estatica" | "desligada";
  motion: "sistema" | "reduzido";
  /** 10–22. */
  terminalFontSize: number;
}

/** Persisted in <sinapseDir>/desktop.json. The orchestrator model lives in each workspace, not here. */
export interface DesktopSettings {
  activeWorkspaceId?: string;
  workerDefaults: WorkerDefaults;
  appearance: AppearanceSettings;
}

/** settings:set payload: any subset; nested objects merge field by field. Use workspace:set-active for the active workspace. */
export interface DesktopSettingsPatch {
  workerDefaults?: Partial<WorkerDefaults> & { model?: string | null };
  appearance?: Partial<AppearanceSettings>;
}

/** Only these known folders can be opened; the renderer never sends a path. Main resolves them from the registry. */
export type FolderKey = "dados" | "projeto" | "orquestrador" | "notas";

export interface DaemonDetails {
  port: number;
  dataDir: string;
  /** False when the app reuses a daemon started by the CLI. */
  ownsDaemon: boolean;
}

export interface DaemonInfo {
  port: number;
  token: string;
}

export interface WorkspaceCreatePayload {
  name: string;
  /** Absolute path chosen by the user (app:pick-folder or typed); main/daemon validate it exists. */
  folder: string;
  orchestrator: OrchestratorConfig;
}

export interface WorkspaceUpdatePayload {
  workspaceId: string;
  name?: string;
  /** Changing it restarts that workspace's orchestrator (Claude → Claude resumes its session; a provider change starts fresh). */
  orchestrator?: OrchestratorConfig;
}

/** `agent` accepts the agentId (preferred from the canvas) or the name. */
export interface WorkerAskPayload {
  workspaceId: string;
  agent: string;
  prompt: string;
}

export interface WorkerSpawnPayload {
  workspaceId: string;
  name: string;
  provider: Provider;
  /** Defaults to the workspace folder when omitted. */
  cwd?: string;
  role: string;
  autonomy: Autonomy;
  model?: string;
  /** Run the worker in its own git worktree (branch sinapse/<name>). */
  worktree?: boolean;
}

export interface SquadApplyPayload {
  workspaceId: string;
  preset: string;
  prefix?: string;
  worktree?: boolean;
}

export interface WorkerUpdatePayload {
  workspaceId: string;
  agent: string;
  model: string | null;
}

export interface NoteWritePayload {
  workspaceId: string;
  name: string;
  content: string;
}

export interface BrainInfo {
  workspaceId: string;
  provider: "claude" | "agy";
  /** Requested model; null = provider default. */
  model: string | null;
  /** Claude only (read from its transcript); AGY has no usage. */
  usage?: ContextUsage;
  running: boolean;
}

export interface NodeLayout {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface ViewportLayout {
  x: number;
  y: number;
  zoom: number;
}

/** Persisted per workspace in <sinapseDir>/layouts/<workspaceId>.json. Node ids: "brain", "worker-<id>", "note-<name>". */
export interface CanvasLayout {
  nodes: Record<string, NodeLayout>;
  viewport?: ViewportLayout;
}
