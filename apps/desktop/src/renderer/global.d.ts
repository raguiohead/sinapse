import type {
  DaemonInfo,
  WorkerAskPayload,
  WorkerSpawnPayload,
} from "../shared/ipc.js";

export interface SinapseBridge {
  brain: {
    onData: (cb: (data: string) => void) => void;
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
  };
  daemon: {
    onInfo: (cb: (info: DaemonInfo) => void) => void;
  };
  workers: {
    list: () => Promise<any[]>;
    spawn: (payload: WorkerSpawnPayload) => Promise<any>;
    ask: (payload: WorkerAskPayload) => Promise<void>;
    onEvents: (cb: (event: any) => void) => void;
    stop: (name: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    sinapse: SinapseBridge;
  }
}
