export const IPC = {
  BRAIN_DATA: "brain:data",
  BRAIN_RESIZE: "brain:resize",
  BRAIN_INPUT: "brain:input",
  DAEMON_INFO: "daemon:info",
  DAEMON_EVENT: "daemon:event",
  DAEMON_STATUS: "daemon:status",
  WORKER_ASK: "worker:ask",
  WORKER_SPAWN: "worker:spawn",
  WORKER_LIST: "worker:list",
  WORKER_STOP: "worker:stop",
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
}

