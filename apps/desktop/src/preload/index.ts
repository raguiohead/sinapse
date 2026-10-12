import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type DaemonInfo,
  type WorkerAskPayload,
  type WorkerSpawnPayload,
} from "../shared/ipc.js";

const api = {
  brain: {
    onData: (cb: (data: string) => void): void => {
      ipcRenderer.on(IPC.BRAIN_DATA, (_event, data: string) => cb(data));
    },
    write: (data: string): void => {
      ipcRenderer.send(IPC.BRAIN_INPUT, data);
    },
    resize: (cols: number, rows: number): void => {
      ipcRenderer.send(IPC.BRAIN_RESIZE, cols, rows);
    },
  },
  daemon: {
    onInfo: (cb: (info: DaemonInfo) => void): void => {
      ipcRenderer.on(IPC.DAEMON_INFO, (_event, info: DaemonInfo) => cb(info));
    },
  },
  workers: {
    list: (): Promise<any[]> => {
      return ipcRenderer.invoke(IPC.WORKER_LIST);
    },
    spawn: (payload: WorkerSpawnPayload): Promise<any> => {
      return ipcRenderer.invoke(IPC.WORKER_SPAWN, payload);
    },
    ask: (payload: WorkerAskPayload): Promise<void> => {
      return ipcRenderer.invoke(IPC.WORKER_ASK, payload);
    },
    onEvents: (cb: (event: any) => void): void => {
      ipcRenderer.on(IPC.WORKER_EVENTS, (_event, event: any) => cb(event));
    },
    stop: (name: string): Promise<void> => {
      return ipcRenderer.invoke(IPC.WORKER_STOP, name);
    },
  },
};

contextBridge.exposeInMainWorld("sinapse", api);
