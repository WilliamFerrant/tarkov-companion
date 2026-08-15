/**
 * main/tray.ts
 * ------------
 * Icone de zone de notification et son menu contextuel.
 *
 * Le tray est le point d'entree principal de l'outil : l'application n'a pas de
 * fenetre principale visible et ne doit jamais apparaitre dans la barre des
 * taches pendant une partie.
 *
 * Le menu est integralement reconstruit a chaque changement de configuration.
 * Un `Menu` Electron est immuable : muter un `MenuItem` existant ne rafraichit
 * pas systematiquement l'affichage sous Windows.
 */

import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'node:path';
import type { AppConfig, CacheStatus, UpdateState } from '../types/index';
import { createLogger } from '../services/Logger';

const log = createLogger('tray');

export interface TrayHandlers {
  toggleOverlay(): void;
  toggleClickThrough(): void;
  toggleDebug(): void;
  setGameMode(mode: 'regular' | 'pve'): void;
  refreshPrices(): void;
  openSettings(): void;
  checkForUpdate(): void;
  installUpdate(): void;
  quit(): void;
}

let tray: Tray | null = null;

/**
 * Dernier etat connu du mecanisme de mise a jour, plus le contexte necessaire
 * pour reconstruire le menu.
 *
 * Le tray est reconstruit a chaque changement, qu'il vienne de la configuration,
 * du cache ou de l'updater. Memoriser ces trois elements evite de propager un
 * parametre supplementaire jusqu'a chaque appelant.
 */
let lastUpdateState: UpdateState = { status: 'disabled', reason: 'non initialise' };
let lastContext: { config: AppConfig; status: CacheStatus; handlers: TrayHandlers } | null = null;

/** Libelle de l'entree « mise a jour », selon l'etat courant. */
function updateLabel(state: UpdateState): string {
  switch (state.status) {
    case 'disabled':
      return 'Mises a jour : version de developpement';
    case 'checking':
      return 'Recherche de mise a jour...';
    case 'available':
      return `Version ${state.version} trouvee, telechargement...`;
    case 'downloading':
      return `Telechargement ${state.percent} %`;
    case 'ready':
      return `Redemarrer pour installer ${state.version}`;
    case 'error':
      return 'Mise a jour indisponible (voir les logs)';
    default:
      return 'Rechercher une mise a jour';
  }
}

/** Met a jour l'etat des mises a jour et reconstruit le menu. */
export function setTrayUpdateState(state: UpdateState): void {
  lastUpdateState = state;
  if (lastContext) updateTray(lastContext.config, lastContext.status, lastContext.handlers);
}

export function createTray(config: AppConfig, status: CacheStatus, handlers: TrayHandlers): Tray {
  const iconPath = path.join(app.getAppPath(), 'assets', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // Sans icone valide, `new Tray` echoue sous Windows : on fournit un carre vide.
    log.warn(`icone de tray introuvable (${iconPath}), utilisation d'une icone vide`);
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Tarkov Price Hover');
  // Double-clic : ouvrir la configuration, comportement attendu sous Windows.
  tray.on('double-click', () => handlers.openSettings());
  updateTray(config, status, handlers);
  return tray;
}

/** Reconstruit le menu contextuel avec l'etat courant. */
export function updateTray(config: AppConfig, status: CacheStatus, handlers: TrayHandlers): void {
  lastContext = { config, status, handlers };
  if (!tray || tray.isDestroyed()) return;

  const menu = Menu.buildFromTemplate([
    {
      label: `Prix : ${status.itemCount} items${status.stale ? ' (cache)' : ''}`,
      enabled: false,
    },
    {
      label: status.refreshing
        ? 'Mise a jour en cours...'
        : `Dernier refresh : ${formatAge(status.fetchedAt)}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Overlay actif',
      type: 'checkbox',
      checked: config.overlayEnabled,
      click: () => handlers.toggleOverlay(),
      accelerator: config.hotkeys.toggleOverlay,
    },
    {
      label: 'Transparent aux clics',
      type: 'checkbox',
      checked: config.clickThrough,
      click: () => handlers.toggleClickThrough(),
    },
    {
      label: 'Mode debug',
      type: 'checkbox',
      checked: config.debugMode,
      click: () => handlers.toggleDebug(),
      accelerator: config.hotkeys.toggleDebug,
    },
    { type: 'separator' },
    {
      label: 'Mode de jeu',
      submenu: [
        {
          label: 'PvP (regular)',
          type: 'radio',
          checked: config.gameMode === 'regular',
          click: () => handlers.setGameMode('regular'),
        },
        {
          label: 'PvE',
          type: 'radio',
          checked: config.gameMode === 'pve',
          click: () => handlers.setGameMode('pve'),
        },
      ],
    },
    {
      label: 'Rafraichir les prix',
      enabled: !status.refreshing,
      click: () => handlers.refreshPrices(),
    },
    { type: 'separator' },
    {
      label: 'Configuration...',
      click: () => handlers.openSettings(),
      accelerator: config.hotkeys.openSettings,
    },
    { type: 'separator' },
    {
      label: updateLabel(lastUpdateState),
      // Cliquable seulement quand il y a quelque chose a faire : verifier, ou
      // redemarrer pour appliquer. Les etats transitoires restent informatifs.
      enabled: lastUpdateState.status === 'idle' || lastUpdateState.status === 'ready' || lastUpdateState.status === 'error',
      click: () => {
        if (lastUpdateState.status === 'ready') handlers.installUpdate();
        else handlers.checkForUpdate();
      },
    },
    { label: 'Quitter', click: () => handlers.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(
    `Tarkov Price Hover — ${config.gameMode === 'pve' ? 'PvE' : 'PvP'} — overlay ${config.overlayEnabled ? 'actif' : 'inactif'}`,
  );
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

/** « il y a 3 min », lisible d'un coup d'oeil dans le menu. */
function formatAge(timestamp: number | null): string {
  if (!timestamp) return 'jamais';
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "a l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `il y a ${hours} h`;
}
