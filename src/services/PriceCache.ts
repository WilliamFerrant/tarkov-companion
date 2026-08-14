/**
 * services/PriceCache.ts
 * ----------------------
 * Source de verite des prix pour le reste de l'application.
 *
 * Cycle de vie :
 *   1. `init()` charge le cache disque (affichage immediat, meme hors ligne).
 *   2. Un refresh reseau est declenche si le cache est absent ou perime.
 *   3. Un timer relance un refresh toutes les N minutes (configurable).
 *   4. Tout echec reseau laisse le cache existant en place : l'outil reste
 *      utilisable en mode degrade, avec `stale = true` remonte a l'UI.
 *
 * Le cache est stocke par mode de jeu (`prices-regular.json`, `prices-pve.json`)
 * pour que basculer PvP <-> PvE soit instantane et fonctionne hors ligne.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { CacheFile, CacheStatus, DataSource, GameMode, TarkovItem } from '../types/index';
import { TarkovApiClient, TarkovApiError, type FetchResult } from './TarkovApi';
import { TarkovJsonClient } from './TarkovJsonApi';
import { createLogger } from './Logger';

const log = createLogger('cache');

/**
 * Increment a chaque changement incompatible de `TarkovItem`.
 * v2 : ajout de `searchAliases` et bascule sur l'API JSON, dont les noms sont
 * reconstruits differemment — les caches v1 doivent etre rebatis.
 */
const CACHE_VERSION = 2;

/**
 * Rattrapage quand le cache est totalement vide.
 *
 * Le rafraichissement normal (12 min par defaut) convient a des prix qui
 * vieillissent, pas a une application inutilisable. Si l'API est indisponible au
 * demarrage et revient trois minutes plus tard, attendre le cycle suivant
 * laisserait l'outil vide neuf minutes de plus sans raison.
 *
 * On retente donc rapidement, avec un doublement du delai plafonne, tant qu'il
 * n'y a aucune donnee : reactif si la panne est breve, respectueux du serveur si
 * elle dure.
 */
const INITIAL_RECOVERY_MS = 30_000;
const MAX_RECOVERY_MS = 5 * 60_000;

export class PriceCache extends EventEmitter {
  private readonly dir: string;
  private readonly graphqlApi = new TarkovApiClient();
  private readonly jsonApi = new TarkovJsonClient();
  private dataSource: DataSource = 'auto';

  private items: TarkovItem[] = [];
  private gameMode: GameMode = 'regular';
  private fetchedAt: number | null = null;
  private refreshing = false;
  private lastError: string | null = null;
  private stale = false;

  private timer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private refreshIntervalMs = 12 * 60_000;

  /** Voir INITIAL_RECOVERY_MS. Actif uniquement tant qu'aucun prix n'est disponible. */
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryDelayMs = INITIAL_RECOVERY_MS;
  private nextRetryAt: number | null = null;

  /**
   * Incremente a chaque remplacement du jeu de donnees (refresh reseau ou
   * changement de mode). Les consommateurs — l'index de recherche notamment —
   * comparent cette valeur pour savoir s'ils doivent se reconstruire. Se fier au
   * seul nombre d'items serait faux : PvP et PvE contiennent les memes items
   * avec des prix differents.
   */
  private revisionCounter = 0;

  constructor(userDataPath: string) {
    super();
    this.dir = path.join(userDataPath, 'cache');
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      log.error('creation du dossier de cache impossible', err);
    }
  }

  get currentItems(): readonly TarkovItem[] {
    return this.items;
  }

  get currentGameMode(): GameMode {
    return this.gameMode;
  }

  /** Voir `revisionCounter`. */
  get revision(): number {
    return this.revisionCounter;
  }

  status(): CacheStatus {
    return {
      gameMode: this.gameMode,
      itemCount: this.items.length,
      fetchedAt: this.fetchedAt,
      refreshing: this.refreshing,
      lastError: this.lastError,
      stale: this.stale,
      nextRetryAt: this.nextRetryAt,
    };
  }

  /**
   * Charge le cache disque puis planifie les refresh.
   * Ne rejette jamais : l'application doit demarrer meme sans reseau ni cache.
   */
  async init(gameMode: GameMode, refreshIntervalMinutes: number, dataSource: DataSource): Promise<void> {
    this.gameMode = gameMode;
    this.dataSource = dataSource;
    this.refreshIntervalMs = refreshIntervalMinutes * 60_000;

    this.loadFromDisk(gameMode);
    this.schedule();

    if (this.isExpired()) {
      // En arriere-plan : l'UI s'affiche immediatement avec les donnees disque.
      void this.refresh();
    }
  }

  /** Change de mode de jeu : recharge le cache correspondant et rafraichit si besoin. */
  async setGameMode(gameMode: GameMode): Promise<void> {
    if (gameMode === this.gameMode) return;
    log.info(`bascule du mode de jeu vers ${gameMode}`);
    this.abort?.abort();
    // Le rattrapage en attente visait l'ancien mode : il est reprogramme au
    // besoin par le refresh declenche juste apres.
    this.cancelRecovery();
    this.recoveryDelayMs = INITIAL_RECOVERY_MS;
    this.gameMode = gameMode;
    this.loadFromDisk(gameMode);
    this.emitChanged();
    if (this.isExpired()) void this.refresh();
  }

  /** Reprogramme le timer de refresh apres un changement de configuration. */
  setRefreshInterval(minutes: number): void {
    this.refreshIntervalMs = minutes * 60_000;
    this.schedule();
  }

  /**
   * Recuperation reseau. Les appels concurrents sont ignores (un seul fetch a la fois).
   * Ne rejette jamais : les erreurs sont exposees via `status().lastError`.
   */
  async refresh(): Promise<CacheStatus> {
    if (this.refreshing) return this.status();

    this.refreshing = true;
    this.emitChanged();

    const mode = this.gameMode;
    this.abort = new AbortController();

    try {
      const { items, gameModeIgnored } = await this.fetchFromSource(mode, this.abort.signal);

      // Le mode a pu changer pendant la requete : on jette le resultat obsolete.
      if (mode !== this.gameMode) {
        log.debug('resultat ignore : le mode de jeu a change pendant la requete');
        return this.status();
      }

      this.items = items;
      this.revisionCounter++;
      this.fetchedAt = Date.now();
      this.cancelRecovery();
      this.recoveryDelayMs = INITIAL_RECOVERY_MS;
      this.lastError = gameModeIgnored
        ? 'Le serveur ignore le parametre PvE/PvP : prix du mode regular affiches.'
        : null;
      this.stale = false;
      this.saveToDisk(mode);
    } catch (err) {
      const message = err instanceof TarkovApiError ? err.message : String((err as Error)?.message ?? err);
      this.lastError = message;
      // Cache existant conserve : mode degrade plutot qu'ecran vide.
      this.stale = this.items.length > 0;
      log.warn(`refresh echoue (${message}) — ${this.items.length} items conserves depuis le cache`);
      // Sans aucune donnee, l'outil ne sert a rien : on retente vite.
      if (this.items.length === 0) this.scheduleRecovery();
    } finally {
      this.refreshing = false;
      this.abort = null;
      this.emitChanged();
    }

    return this.status();
  }

  /** Annule tout travail en cours. A appeler a la fermeture de l'app. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelRecovery();
    this.abort?.abort();
  }

  /** Programme une tentative de rattrapage, sauf si une est deja en attente. */
  private scheduleRecovery(): void {
    if (this.recoveryTimer) return;

    const delay = this.recoveryDelayMs;
    this.nextRetryAt = Date.now() + delay;
    log.info(`aucun prix disponible — nouvelle tentative dans ${Math.round(delay / 1000)} s`);

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.nextRetryAt = null;
      void this.refresh();
    }, delay);
    this.recoveryTimer.unref?.();

    // Doublement plafonne : reactif sur une panne courte, sobre sur une longue.
    this.recoveryDelayMs = Math.min(this.recoveryDelayMs * 2, MAX_RECOVERY_MS);
  }

  private cancelRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.nextRetryAt = null;
  }

  /** Change la source de donnees. Le prochain refresh l'utilisera. */
  setDataSource(source: DataSource): void {
    this.dataSource = source;
  }

  /**
   * Interroge la source configuree.
   *
   * En mode `auto`, l'API JSON est tentee en premier — c'est la seule vivante
   * depuis juillet 2026 — et GraphQL sert de repli. L'ordre inverse ferait
   * attendre trois echecs GraphQL et ~3 s a chaque rafraichissement.
   */
  private async fetchFromSource(mode: GameMode, signal: AbortSignal): Promise<FetchResult> {
    if (this.dataSource === 'json') return this.jsonApi.fetchAllItems(mode, signal);
    if (this.dataSource === 'graphql') return this.graphqlApi.fetchAllItems(mode, signal);

    try {
      return await this.jsonApi.fetchAllItems(mode, signal);
    } catch (jsonError) {
      const message = (jsonError as Error)?.message ?? jsonError;
      log.warn(`API JSON indisponible (${message}), repli sur GraphQL`);
      try {
        return await this.graphqlApi.fetchAllItems(mode, signal);
      } catch (graphqlError) {
        // Les deux ont echoue : on remonte l'erreur JSON, la source de reference.
        log.warn(`repli GraphQL egalement en echec (${(graphqlError as Error)?.message ?? graphqlError})`);
        throw jsonError;
      }
    }
  }

  private isExpired(): boolean {
    return this.fetchedAt === null || Date.now() - this.fetchedAt > this.refreshIntervalMs;
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
    // N'empeche pas la fermeture du process si le timer est le dernier handle actif.
    this.timer.unref?.();
  }

  private fileFor(mode: GameMode): string {
    return path.join(this.dir, `prices-${mode}.json`);
  }

  private loadFromDisk(mode: GameMode): void {
    // Toute sortie de cette methode remplace `this.items` : la revision change
    // systematiquement, y compris quand on retombe sur une liste vide.
    this.revisionCounter++;
    const file = this.fileFor(mode);
    if (!existsSync(file)) {
      this.items = [];
      this.fetchedAt = null;
      this.stale = false;
      log.info(`aucun cache disque pour le mode ${mode}`);
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as CacheFile;
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.items)) {
        throw new Error(`format de cache incompatible (version ${parsed.version})`);
      }
      this.items = parsed.items;
      this.fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : null;
      this.stale = this.isExpired();
      log.info(`${this.items.length} items charges depuis le cache disque (${mode})`);
    } catch (err) {
      log.warn(`cache disque ${mode} illisible, il sera reconstruit`, err);
      this.items = [];
      this.fetchedAt = null;
      this.stale = false;
    }
  }

  private saveToDisk(mode: GameMode): void {
    const file = this.fileFor(mode);
    const payload: CacheFile = {
      version: CACHE_VERSION,
      gameMode: mode,
      fetchedAt: this.fetchedAt ?? Date.now(),
      items: this.items,
    };
    try {
      // Ecriture atomique : un crash en cours d'ecriture ne corrompt pas le cache.
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, file);
      log.debug(`cache ${mode} ecrit sur disque`);
    } catch (err) {
      log.error('ecriture du cache impossible', err);
    }
  }

  private emitChanged(): void {
    this.emit('changed', this.status());
  }
}
