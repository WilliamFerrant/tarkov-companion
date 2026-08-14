/**
 * preload/overlay.preload.ts
 * --------------------------
 * Pont securise entre le process principal et la fenetre overlay.
 *
 * La fenetre tourne en `contextIsolation: true` + `sandbox: true` : elle n'a
 * acces ni a Node, ni a `ipcRenderer` brut. Seules les quatre fonctions ci-dessous
 * sont exposees, et aucune ne permet au renderer d'appeler un canal arbitraire.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type OverlayApi } from '../types/ipc';
import type { AppConfig, PriceSummary } from '../types/index';

const api: OverlayApi = {
  onShow: (cb) => {
    ipcRenderer.on(IPC.OVERLAY_SHOW, (_event, summary: PriceSummary) => cb(summary));
  },
  onHide: (cb) => {
    ipcRenderer.on(IPC.OVERLAY_HIDE, () => cb());
  },
  onConfig: (cb) => {
    ipcRenderer.on(IPC.OVERLAY_CONFIG, (_event, config: AppConfig) => cb(config));
  },
  onFollow: (cb) => {
    ipcRenderer.on(IPC.OVERLAY_FOLLOW, (_event, position: { x: number; y: number }) => cb(position));
  },
  reportHeight: (height) => {
    ipcRenderer.send(IPC.OVERLAY_MEASURED, height);
  },
};

contextBridge.exposeInMainWorld('overlayApi', api);
