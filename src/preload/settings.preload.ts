/**
 * preload/settings.preload.ts
 * ---------------------------
 * Pont securise entre le process principal et la fenetre de configuration.
 *
 * Comme pour l'overlay, la surface exposee est une liste fermee d'operations :
 * le renderer ne peut pas choisir le canal IPC qu'il invoque.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type SettingsApi } from '../types/ipc';
import type { AppConfig, CacheStatus, DebugFrame } from '../types/index';

const api: SettingsApi = {
  getConfig: () => ipcRenderer.invoke(IPC.CONFIG_GET),
  setConfig: (patch) => ipcRenderer.invoke(IPC.CONFIG_SET, patch),
  onConfigChanged: (cb) => {
    ipcRenderer.on(IPC.CONFIG_CHANGED, (_event, config: AppConfig) => cb(config));
  },
  getCacheStatus: () => ipcRenderer.invoke(IPC.CACHE_STATUS),
  refreshCache: () => ipcRenderer.invoke(IPC.CACHE_REFRESH),
  onCacheChanged: (cb) => {
    ipcRenderer.on(IPC.CACHE_CHANGED, (_event, status: CacheStatus) => cb(status));
  },
  onDebugFrame: (cb) => {
    ipcRenderer.on(IPC.DEBUG_FRAME, (_event, frame: DebugFrame) => cb(frame));
  },
  probe: () => ipcRenderer.invoke(IPC.DEBUG_PROBE),
  openLogs: () => ipcRenderer.invoke(IPC.OPEN_LOGS),
  openConfig: () => ipcRenderer.invoke(IPC.OPEN_CONFIG),
};

contextBridge.exposeInMainWorld('settingsApi', api);
