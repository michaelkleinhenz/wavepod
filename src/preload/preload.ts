import { contextBridge, ipcRenderer } from 'electron';
import { INVOKE_METHODS, IPC, type SoundPodApi } from '../shared/api';

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const api: Record<string, unknown> = {
  onTransport: subscribe(IPC.transport),
  onStatus: subscribe(IPC.status),
  onRecordingFinished: subscribe(IPC.recordingFinished),
  onExportProgress: subscribe(IPC.exportProgress),
  onMenu: subscribe(IPC.menu),
  platform: process.platform,
};
for (const method of INVOKE_METHODS) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(IPC.invoke, method, ...args);
}

contextBridge.exposeInMainWorld('soundpod', api as unknown as SoundPodApi);
