/**
 * services/ConfigStore.ts
 * -----------------------
 * Lecture / ecriture de `config.json` dans le dossier userData d'Electron.
 *
 * Regles de robustesse :
 *   - Un fichier absent, vide ou corrompu ne bloque jamais le demarrage : on
 *     repart des valeurs par defaut et on sauvegarde l'ancien fichier en `.bak`.
 *   - Le merge est profond sur les deux seuls sous-objets (`hotkeys`,
 *     `captureRegion`), ce qui permet d'ajouter des cles dans une version
 *     ulterieure sans casser les configs existantes.
 *   - Les valeurs numeriques sont bornees a l'ecriture, pas seulement dans l'UI :
 *     l'utilisateur peut editer config.json a la main.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_CONFIG, type AppConfig } from '../types/index';
import { createLogger } from './Logger';

const log = createLogger('config');

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Applique les bornes de validite a une configuration potentiellement editee a la main. */
function sanitize(config: AppConfig): AppConfig {
  const d = DEFAULT_CONFIG;
  return {
    ...config,
    gameMode: config.gameMode === 'pve' ? 'pve' : 'regular',
    refreshIntervalMinutes: clamp(config.refreshIntervalMinutes, 1, 240, d.refreshIntervalMinutes),
    hoverSettleMs: clamp(config.hoverSettleMs, 50, 2000, d.hoverSettleMs),
    minOcrIntervalMs: clamp(config.minOcrIntervalMs, 120, 5000, d.minOcrIntervalMs),
    cursorMoveThresholdPx: clamp(config.cursorMoveThresholdPx, 1, 200, d.cursorMoveThresholdPx),
    matchThreshold: clamp(config.matchThreshold, 0.3, 0.99, d.matchThreshold),
    minPriceFilter: clamp(config.minPriceFilter, 0, 100_000_000, d.minPriceFilter),
    autoHideMs: clamp(config.autoHideMs, 300, 60_000, d.autoHideMs),
    overlayOpacity: clamp(config.overlayOpacity, 0.1, 1, d.overlayOpacity),
    overlayScale: clamp(config.overlayScale, 0.6, 2.5, d.overlayScale),
    captureRegion: {
      offsetX: clamp(config.captureRegion.offsetX, -2000, 2000, d.captureRegion.offsetX),
      offsetY: clamp(config.captureRegion.offsetY, -2000, 2000, d.captureRegion.offsetY),
      width: clamp(config.captureRegion.width, 60, 2000, d.captureRegion.width),
      height: clamp(config.captureRegion.height, 20, 1000, d.captureRegion.height),
    },
  };
}

export class ConfigStore extends EventEmitter {
  private readonly filePath: string;
  private config: AppConfig;
  /** Vrai si config.json vient d'etre cree : permet d'appliquer des defauts calcules. */
  readonly isFirstRun: boolean;

  constructor(userDataPath: string) {
    super();
    this.filePath = path.join(userDataPath, 'config.json');
    this.isFirstRun = !existsSync(this.filePath);
    this.config = this.load();
  }

  get path(): string {
    return this.filePath;
  }

  /** Copie immuable de la configuration courante. */
  get(): AppConfig {
    return structuredClone(this.config);
  }

  /**
   * Applique un patch partiel, persiste, puis emet `changed`.
   * Renvoie la configuration resultante (deja assainie).
   */
  set(patch: Partial<AppConfig>): AppConfig {
    this.config = sanitize({
      ...this.config,
      ...patch,
      hotkeys: { ...this.config.hotkeys, ...(patch.hotkeys ?? {}) },
      captureRegion: { ...this.config.captureRegion, ...(patch.captureRegion ?? {}) },
    });
    this.save();
    this.emit('changed', this.get());
    return this.get();
  }

  private load(): AppConfig {
    if (!existsSync(this.filePath)) {
      log.info('aucun config.json, creation depuis les valeurs par defaut');
      this.config = structuredClone(DEFAULT_CONFIG);
      this.save();
      return this.config;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      // Les cles prefixees par `_` sont des commentaires (voir config.example.json) :
      // on les retire pour qu'elles ne soient pas reecrites dans le fichier.
      const raw = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => !key.startsWith('_')),
      ) as Partial<AppConfig>;
      return sanitize({
        ...DEFAULT_CONFIG,
        ...raw,
        hotkeys: { ...DEFAULT_CONFIG.hotkeys, ...(raw.hotkeys ?? {}) },
        captureRegion: { ...DEFAULT_CONFIG.captureRegion, ...(raw.captureRegion ?? {}) },
      });
    } catch (err) {
      // Config illisible : on la met de cote pour diagnostic plutot que l'ecraser.
      log.error('config.json illisible, retour aux valeurs par defaut', err);
      try {
        copyFileSync(this.filePath, this.filePath + '.bak');
      } catch {
        /* best-effort */
      }
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      log.error('ecriture de config.json impossible', err);
    }
  }
}
