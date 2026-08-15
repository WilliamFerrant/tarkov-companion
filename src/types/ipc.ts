/**
 * types/ipc.ts
 * ------------
 * Noms de canaux IPC et forme des APIs exposees aux fenetres via `contextBridge`.
 * Centraliser les chaines ici evite les fautes de frappe silencieuses entre le
 * process principal et les preloads.
 */

import type { AppConfig, CacheStatus, DebugFrame, PriceSummary, UpdateState } from './index';

export const IPC = {
  /** main -> overlay : afficher une carte de prix. */
  OVERLAY_SHOW: 'overlay:show',
  /** main -> overlay : masquer la carte. */
  OVERLAY_HIDE: 'overlay:hide',
  /** overlay -> main : hauteur mesuree de la carte, pour redimensionner la fenetre. */
  OVERLAY_MEASURED: 'overlay:measured',
  /** main -> overlay : nouvelle configuration (opacite, echelle...). */
  OVERLAY_CONFIG: 'overlay:config',
  /**
   * main -> overlay : position de la carte **dans** la fenetre, en pixels
   * logiques.
   *
   * Deplacer la carte par ce canal plutot qu'en deplacant la fenetre est ce qui
   * rend le suivi fluide : une translation CSS est repeinte par le compositeur
   * du renderer, sans jamais demander au DWM de deplacer une fenetre au premier
   * plan — operation qui, elle, force une recomposition de tout l'ecran.
   */
  OVERLAY_FOLLOW: 'overlay:follow',

  /** settings -> main : lire la configuration courante. */
  CONFIG_GET: 'config:get',
  /** settings -> main : appliquer un patch de configuration. */
  CONFIG_SET: 'config:set',
  /** main -> settings : la configuration a change (hotkey, tray...). */
  CONFIG_CHANGED: 'config:changed',

  /** settings -> main : etat du cache de prix. */
  CACHE_STATUS: 'cache:status',
  /** settings -> main : forcer un rafraichissement immediat. */
  CACHE_REFRESH: 'cache:refresh',
  /** main -> settings : l'etat du cache a change. */
  CACHE_CHANGED: 'cache:changed',

  /** main -> settings : nouvelle frame de debug. */
  DEBUG_FRAME: 'debug:frame',
  /** settings -> main : declencher une detection immediate (bouton de test). */
  DEBUG_PROBE: 'debug:probe',

  /** settings -> main : ouvrir le dossier des logs dans l'explorateur. */
  OPEN_LOGS: 'app:open-logs',
  /** settings -> main : ouvrir le fichier config.json. */
  OPEN_CONFIG: 'app:open-config',

  /** settings -> main : etat de la mise a jour. */
  UPDATE_STATUS: 'update:status',
  /** settings -> main : verifier maintenant. */
  UPDATE_CHECK: 'update:check',
  /** settings -> main : redemarrer pour appliquer la version telechargee. */
  UPDATE_INSTALL: 'update:install',
  /** main -> settings : l'etat de la mise a jour a change. */
  UPDATE_CHANGED: 'update:changed',
} as const;

/** API injectee dans la fenetre overlay (`window.overlayApi`). */
export interface OverlayApi {
  onShow(cb: (summary: PriceSummary) => void): void;
  onHide(cb: () => void): void;
  onConfig(cb: (config: AppConfig) => void): void;
  onFollow(cb: (position: { x: number; y: number }) => void): void;
  reportHeight(height: number): void;
}

/** API injectee dans la fenetre de configuration (`window.settingsApi`). */
export interface SettingsApi {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  onConfigChanged(cb: (config: AppConfig) => void): void;
  getCacheStatus(): Promise<CacheStatus>;
  refreshCache(): Promise<CacheStatus>;
  onCacheChanged(cb: (status: CacheStatus) => void): void;
  onDebugFrame(cb: (frame: DebugFrame) => void): void;
  probe(): Promise<void>;
  openLogs(): Promise<void>;
  openConfig(): Promise<void>;
  getUpdateStatus(): Promise<UpdateState>;
  checkForUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  onUpdateChanged(cb: (state: UpdateState) => void): void;
}
