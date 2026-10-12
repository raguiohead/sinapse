import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DaemonEvent } from "@sinapse/core";
import {
  IPC,
  type DaemonInfo,
  type WorkerAskPayload,
  type WorkerSpawnPayload,
} from "../shared/ipc.js";

const api = {
  brain: {
    onData: (cb: (data: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: string) => cb(data);
      ipcRenderer.on(IPC.BRAIN_DATA, listener);
      return () => {
        ipcRenderer.removeListener(IPC.BRAIN_DATA, listener);
      };
    },
    write: (data: string): void => {
      ipcRenderer.send(IPC.BRAIN_INPUT, data);
    },
    resize: (cols: number, rows: number): void => {
      ipcRenderer.send(IPC.BRAIN_RESIZE, cols, rows);
    },
  },
  daemon: {
    onInfo: (cb: (info: DaemonInfo) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, info: DaemonInfo) => cb(info);
      ipcRenderer.on(IPC.DAEMON_INFO, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_INFO, listener);
      };
    },
    onEvent: (cb: (e: DaemonEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, e: DaemonEvent) => cb(e);
      ipcRenderer.on(IPC.DAEMON_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_EVENT, listener);
      };
    },
    onStatus: (cb: (s: { connected: boolean }) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, s: { connected: boolean }) => cb(s);
      ipcRenderer.on(IPC.DAEMON_STATUS, listener);
      return () => {
        ipcRenderer.removeListener(IPC.DAEMON_STATUS, listener);
      };
    },
  },
  workers: {
    list: (): Promise<any[]> => {
      return ipcRenderer.invoke(IPC.WORKER_LIST);
    },
    spawn: (payload: WorkerSpawnPayload): Promise<any> => {
      return ipcRenderer.invoke(IPC.WORKER_SPAWN, payload);
    },
    ask: (payload: WorkerAskPayload): Promise<{ turnId: string }> => {
      return ipcRenderer.invoke(IPC.WORKER_ASK, payload);
    },
    stop: (name: string): Promise<any> => {
      return ipcRenderer.invoke(IPC.WORKER_STOP, name);
    },
  },
};

contextBridge.exposeInMainWorld("sinapse", api);
