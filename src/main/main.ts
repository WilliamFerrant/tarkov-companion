/**
 * main/main.ts
 * ------------
 * Point d'entree du process principal : assemble tous les services et cable les
 * evenements. Ce fichier ne contient volontairement aucune logique metier, il
 * n'orchestre que le cycle de vie.
 *
 * Sequence de demarrage
 *   1. Verrou d'instance unique (deux overlays simultanes se battraient pour
 *      l'affichage et doubleraient la charge OCR).
 *   2. Logger et configuration : disponibles avant tout le reste.
 *   3. Fenetres, tray, raccourcis — l'UI repond immediatement.
 *   4. Cache de prix : charge depuis le disque puis rafraichi en arriere-plan.
 *   5. Detection : demarree seulement quand des prix sont disponibles.
 */

import { app, ipcMain, screen, shell, type BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig, CacheStatus, DebugFrame, GameMode, PriceSummary } from '../types/index';
import { IPC } from '../types/ipc';
import { initLogger, createLogger, getLogDir, setVerbose } from '../services/Logger';
import { ConfigStore } from '../services/ConfigStore';
import { PriceCache } from '../services/PriceCache';
import { ItemIndex } from '../services/ItemIndex';
import { ForegroundWatcher } from '../services/ForegroundWatcher';
import { ItemDetector } from '../services/ItemDetector';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { createTray, updateTray, destroyTray, type TrayHandlers } from './tray';
import {
  createOverlayWindow,
  createSettingsWindow,
  getOverlayWindow,
  getSettingsWindow,
  showSettings,
  showOverlayAt,
  followCursor,
  hideOverlay,
  getVisibleOverlayBounds,
  applyClickThrough,
  setOverlayHeight,
} from './windows';

/**
 * Verrou d'instance unique. Deux instances se disputeraient l'overlay, les
 * raccourcis globaux et doubleraient la charge OCR.
 *
 * `app.quit()` ne suffit pas ici : avant `whenReady`, il ne fait que *demander*
 * l'arret, et le reste du module continue de s'executer — l'instance en trop
 * demarrait entierement malgre le verrou (constate en conditions reelles).
 * `app.exit(0)` termine immediatement le process.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // eslint-disable-next-line no-console
  console.log('Une instance de Tarkov Price Hover est deja en cours. Arret.');
  app.exit(0);
}

const isDev = process.argv.includes('--dev');

let log = createLogger('main');
let config: ConfigStore;
let cache: PriceCache;
let detector: ItemDetector;
const index = new ItemIndex();
const foreground = new ForegroundWatcher();

app.setAppUserModelId('local.tarkov.price.hover');

/**
 * Acceleration materielle de Chromium.
 *
 * Elle avait ete coupee sur une hypothese : que la simple presence d'Electron,
 * client GPU supplementaire, prenait des images au jeu. **Cette hypothese est
 * fausse**, et la mesure l'a etablie — trois tests successifs, chacun isolant
 * une couche :
 *
 *   capture de region seule, sans Electron       aucune saccade
 *   Electron lance, detection coupee             aucune saccade
 *   chaine complete, carte jamais affichee       aucune saccade
 *   chaine complete, carte affichee              saccades
 *
 * Le cout ne vient donc ni du pipeline, ni d'Electron, mais de **l'affichage de
 * la carte**. Or couper le GPU aggrave precisement ce cas : une fenetre
 * transparente est alors composee par le processeur, image par image, et remise
 * au DWM par le chemin logiciel.
 *
 * L'acceleration est donc retablie. Le reglage `hardwareAcceleration` permet de
 * la recouper sur une machine ou elle poserait probleme.
 *
 * Lu directement dans le fichier : ce choix doit etre fait **avant**
 * `whenReady`, alors que `ConfigStore` n'est construit qu'apres.
 */
if (!readEarlyFlag('hardwareAcceleration', true)) {
  app.disableHardwareAcceleration();
}

/**
 * Lit un booleen de la configuration avant l'initialisation d'Electron.
 *
 * Volontairement minimal et silencieux : un fichier absent, illisible ou
 * invalide rend la valeur par defaut. Aucun journal n'est possible ici, le
 * logger n'etant pas encore construit — et `ConfigStore` signalera de toute
 * facon le probleme quelques millisecondes plus tard.
 */
function readEarlyFlag(key: string, fallback: boolean): boolean {
  try {
    const file = path.join(app.getPath('userData'), 'config.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return typeof parsed[key] === 'boolean' ? (parsed[key] as boolean) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Bascule la capture d'ecran sur **Windows Graphics Capture** plutot que sur la
 * duplication de bureau DXGI.
 *
 * Par defaut, Chromium capture via l'ancien chemin DXGI. Or maintenir une
 * duplication de bureau ouverte force Windows a sortir le jeu du mode
 * *independent flip* : la presentation passe en composition par le DWM, et le
 * jeu perd des FPS — quelle que soit la cadence de capture. C'est le cout
 * permanent ressenti en jeu, celui qu'aucun reglage de cadence ne supprime.
 *
 * WGC est l'API introduite avec Windows 10 1803, celle qu'OBS emploie sous le
 * nom « Window Capture (WGC) » justement parce qu'elle ne penalise pas la
 * presentation du jeu.
 *
 * Les trois noms couvrent les variantes selon les versions de Chromium (le flag
 * unique d'origine, puis sa scission ecran / fenetre). Un nom inconnu est
 * ignore silencieusement : les lister tous est sans risque.
 *
 * Verification : si WGC est actif, les erreurs `CreateMouseCursorFromHCursor`
 * emises par le capteur DXGI disparaissent des logs.
 */
app.commandLine.appendSwitch(
  'enable-features',
  'AllowWgcDesktopCapturer,AllowWgcScreenCapturer,AllowWgcWindowCapturer',
);

// ---------------------------------------------------------------------------
// Diffusion d'etat vers les fenetres
// ---------------------------------------------------------------------------

/** Envoie un message a une fenetre si elle existe encore. */
function send(window: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function broadcastConfig(next: AppConfig): void {
  send(getSettingsWindow(), IPC.CONFIG_CHANGED, next);
  send(getOverlayWindow(), IPC.OVERLAY_CONFIG, next);
  updateTray(next, cache.status(), trayHandlers);
}

function broadcastCache(status: CacheStatus): void {
  send(getSettingsWindow(), IPC.CACHE_CHANGED, status);
  updateTray(config.get(), status, trayHandlers);
}

// ---------------------------------------------------------------------------
// Actions partagees entre tray, raccourcis et UI
// ---------------------------------------------------------------------------

function setConfig(patch: Partial<AppConfig>): AppConfig {
  const previous = config.get();
  const next = config.set(patch);

  if (patch.debugMode !== undefined) setVerbose(next.debugMode);

  if (patch.clickThrough !== undefined) {
    const overlay = getOverlayWindow();
    if (overlay) applyClickThrough(overlay, next.clickThrough);
  }

  // Desactiver l'overlay doit masquer la carte immediatement, sans attendre
  // le prochain tick de la boucle de detection.
  if (patch.overlayEnabled === false) hideOverlay();

  if (patch.hotkeys) {
    const failed = registerHotkeys(next, hotkeyHandlers);
    if (failed.length > 0) log.warn(`raccourcis non enregistres : ${failed.join(', ')}`);
  }

  if (patch.refreshIntervalMinutes !== undefined && patch.refreshIntervalMinutes !== previous.refreshIntervalMinutes) {
    cache.setRefreshInterval(next.refreshIntervalMinutes);
  }

  if (patch.gameMode !== undefined && patch.gameMode !== previous.gameMode) {
    void cache.setGameMode(next.gameMode);
  }

  // Changer de source n'a d'interet que si on recharge dans la foulee.
  if (patch.dataSource !== undefined && patch.dataSource !== previous.dataSource) {
    cache.setDataSource(next.dataSource);
    void cache.refresh();
  }

  broadcastConfig(next);
  return next;
}

const hotkeyHandlers = {
  toggleOverlay: () => {
    const enabled = !config.get().overlayEnabled;
    log.info(`overlay ${enabled ? 'active' : 'desactive'} via raccourci`);
    setConfig({ overlayEnabled: enabled });
  },
  toggleDebug: () => setConfig({ debugMode: !config.get().debugMode }),
  openSettings: () => showSettings(),
};

const trayHandlers: TrayHandlers = {
  toggleOverlay: hotkeyHandlers.toggleOverlay,
  toggleClickThrough: () => setConfig({ clickThrough: !config.get().clickThrough }),
  toggleDebug: hotkeyHandlers.toggleDebug,
  setGameMode: (mode: GameMode) => setConfig({ gameMode: mode }),
  refreshPrices: () => void cache.refresh(),
  openSettings: () => showSettings(),
  quit: () => {
    (app as { isQuitting?: boolean }).isQuitting = true;
    app.quit();
  },
};

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.CONFIG_GET, () => config.get());
  ipcMain.handle(IPC.CONFIG_SET, (_event, patch: Partial<AppConfig>) => setConfig(patch ?? {}));

  ipcMain.handle(IPC.CACHE_STATUS, () => cache.status());
  ipcMain.handle(IPC.CACHE_REFRESH, () => cache.refresh());

  ipcMain.handle(IPC.DEBUG_PROBE, async () => {
    await detector.probe();
  });

  ipcMain.handle(IPC.OPEN_LOGS, () => shell.openPath(getLogDir()));
  ipcMain.handle(IPC.OPEN_CONFIG, () => shell.openPath(config.path));

  // La hauteur mesuree arrive a chaque affichage : `on` (fire-and-forget) plutot
  // que `handle`, le renderer n'attend pas de reponse.
  ipcMain.on(IPC.OVERLAY_MEASURED, (_event, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) setOverlayHeight(height, config.get());
    // Preuve que le renderer a bien recu le resume et dessine la carte : ce
    // message n'est emis que depuis `render()`. S'il manque alors que
    // `showOverlayAt` a journalise `visible=true`, le probleme est dans le
    // renderer ; s'il est present, la carte est dessinee et c'est l'affichage
    // par-dessus le jeu qui echoue.
    log.debug(`renderer overlay : carte dessinee, hauteur mesuree ${height}`);
  });
}

// ---------------------------------------------------------------------------
// Demarrage
// ---------------------------------------------------------------------------

/** Revision du cache deja prise en compte par l'index de recherche. */
let indexedRevision = -1;

/**
 * Reconstruit l'index si le cache a change depuis la derniere fois.
 * Compare la revision et non le nombre d'items : PvP et PvE ont le meme nombre
 * d'items, seuls les prix different.
 */
function syncIndex(): void {
  if (cache.revision === indexedRevision) return;
  indexedRevision = cache.revision;
  index.build(cache.currentItems);
  log.info(`index de recherche reconstruit : ${index.size} items (revision ${indexedRevision})`);
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  initLogger(userData, isDev);
  log = createLogger('main');
  log.info(`demarrage — Electron ${process.versions.electron}, donnees dans ${userData}`);

  config = new ConfigStore(userData);

  // Au premier lancement, la carte est dimensionnee d'apres l'ecran principal.
  // Une echelle fixe donne un texte confortable en 1080p mais illisible en 1440p
  // ou 4K, ou tout est physiquement plus petit.
  if (config.isFirstRun) {
    const { height } = screen.getPrimaryDisplay().size;
    const suggested = Math.round(Math.min(2, Math.max(1, height / 1080)) * 20) / 20;
    if (suggested !== 1) {
      log.info(`ecran ${height} px de haut : echelle de la carte reglee sur ${suggested}`);
      config.set({ overlayScale: suggested });
    }
  }

  const initial = config.get();
  setVerbose(initial.debugMode || isDev);

  cache = new PriceCache(userData);
  detector = new ItemDetector(userData, {
    index,
    foreground,
    getConfig: () => config.get(),
    hasPrices: () => index.size > 0,
    getOverlayBounds: () => getVisibleOverlayBounds(),
    wantsDebugImages: () => {
      const settings = getSettingsWindow();
      return Boolean(settings && !settings.isDestroyed() && settings.isVisible());
    },
  });

  // --- Fenetres et UI ---
  // Seul l'overlay est cree au demarrage. La fenetre de configuration coute
  // ~70 Mo pour un usage occasionnel : `showSettings()` la construit a la
  // demande, au prix de ~300 ms a la premiere ouverture.
  createOverlayWindow(initial);
  registerIpc();
  createTray(initial, cache.status(), trayHandlers);

  const failedHotkeys = registerHotkeys(initial, hotkeyHandlers);
  if (failedHotkeys.length > 0) log.warn(`raccourcis non enregistres : ${failedHotkeys.join(', ')}`);

  // --- Detection ---
  if (initial.onlyWhenGameFocused) foreground.start();

  detector.on('match', (summary: PriceSummary, cursor: { x: number; y: number }, tooltipRect) => {
    const current = config.get();
    showOverlayAt(cursor, current, tooltipRect ?? null);
    send(getOverlayWindow(), IPC.OVERLAY_SHOW, summary);
  });
  detector.on('follow', (cursor: { x: number; y: number }) => followCursor(cursor, config.get()));
  detector.on('hide', () => {
    hideOverlay();
    send(getOverlayWindow(), IPC.OVERLAY_HIDE);
  });
  detector.on('debug', (frame: DebugFrame) => send(getSettingsWindow(), IPC.DEBUG_FRAME, frame));

  // --- Prix ---
  cache.on('changed', (status: CacheStatus) => {
    syncIndex();
    broadcastCache(status);
  });

  await cache.init(initial.gameMode, initial.refreshIntervalMinutes, initial.dataSource);
  syncIndex();
  broadcastCache(cache.status());

  detector.start();

  // Premier lancement sans cache : on guide l'utilisateur vers la configuration
  // plutot que de le laisser devant un outil silencieux.
  if (index.size === 0) {
    log.warn('aucun prix disponible au demarrage, ouverture de la fenetre de configuration');
    showSettings();
  }
}

app.on('second-instance', () => showSettings());

// Ceinture et bretelles : meme si `app.exit` n'avait pas encore coupe le
// process, l'instance en trop ne doit rien initialiser.
if (hasSingleInstanceLock) {
  app.whenReady().then(bootstrap).catch((err) => {
    log.error('echec du demarrage', err);
    app.quit();
  });
}

// L'application vit dans le tray : fermer toutes les fenetres ne doit pas quitter.
app.on('window-all-closed', () => {
  /* volontairement vide */
});

app.on('before-quit', () => {
  (app as { isQuitting?: boolean }).isQuitting = true;
});

app.on('will-quit', () => {
  log.info('arret en cours');
  unregisterHotkeys();
  foreground.stop();
  cache?.dispose();
  destroyTray();
  // `dispose` est asynchrone : on ne bloque pas la fermeture pour un worker OCR.
  void detector?.dispose();
});

// Un rejet non gere ne doit jamais faire disparaitre l'application sans trace.
process.on('unhandledRejection', (reason) => log.error('promesse rejetee non geree', reason));
process.on('uncaughtException', (err) => log.error('exception non capturee', err));
