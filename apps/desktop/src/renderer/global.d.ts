import type { DaemonEvent } from "@sinapse/core";
import type {
  DaemonInfo,
  WorkerAskPayload,
  WorkerSpawnPayload,
} from "../shared/ipc.js";

export interface SinapseBridge {
  brain: {
    onData: (cb: (data: string) => void) => () => void;
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
  };
  daemon: {
    onInfo: (cb: (info: DaemonInfo) => void) => () => void;
    onEvent: (cb: (e: DaemonEvent) => void) => () => void;
    onStatus: (cb: (s: { connected: boolean }) => void) => () => void;
  };
  workers: {
    list: () => Promise<any[]>;
    spawn: (payload: WorkerSpawnPayload) => Promise<any>;
    ask: (payload: WorkerAskPayload) => Promise<{ turnId: string }>;
    stop: (name: string) => Promise<any>;
  };
}

declare global {
  interface Window {
    sinapse: SinapseBridge;
  }
}
