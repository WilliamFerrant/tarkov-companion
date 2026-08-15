/**
 * services/Updater.ts
 * -------------------
 * Mise a jour automatique depuis les releases GitHub du depot.
 *
 * Politique : ne jamais interrompre une partie
 * --------------------------------------------
 * Une mise a jour qui redemarre l'application au milieu d'un raid est pire que
 * pas de mise a jour du tout. Le telechargement se fait donc en arriere-plan et
 * l'installation est **differee a la fermeture** (`autoInstallOnAppQuit`). Rien
 * n'est jamais impose : l'utilisateur redemarre quand il veut, via le tray.
 *
 * Le depot est public, donc aucun jeton n'est necessaire — c'est ce qui rend ce
 * mecanisme utilisable dans une application distribuee telle quelle. Un depot
 * prive obligerait a embarquer un jeton GitHub dans le binaire, ce qui reviendrait
 * a le publier.
 *
 * En developpement
 * ----------------
 * `electron-updater` exige `app-update.yml`, un fichier genere par
 * electron-builder au moment du packaging. Lance depuis les sources, il echoue
 * donc systematiquement. Le service se met en sommeil quand l'application n'est
 * pas empaquetee : c'est un etat normal, pas une erreur a signaler.
 */

import { EventEmitter } from 'node:events';
import { app } from 'electron';
import type { UpdateState } from '../types/index';
import { createLogger } from './Logger';

const log = createLogger('updater');

/** Delai avant la premiere verification, pour laisser le demarrage se terminer. */
const FIRST_CHECK_DELAY_MS = 20_000;

/** Periode des verifications suivantes. */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

export type { UpdateState };

/** Sous-ensemble de l'API `autoUpdater` reellement utilise. */
interface AutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: never[]) => void): void;
}

export class Updater extends EventEmitter {
  private updater: AutoUpdater | null = null;
  private state: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private lastCheck: number | null = null;
  private readonly currentVersion = app.getVersion();

  constructor() {
    super();
    this.state = app.isPackaged
      ? { status: 'idle', currentVersion: this.currentVersion, lastCheck: null }
      : {
          status: 'disabled',
          reason: "application lancee depuis les sources : les mises a jour ne s'appliquent qu'a une version installee",
        };
  }

  current(): UpdateState {
    return this.state;
  }

  /** `true` si une version est telechargee et n'attend plus qu'un redemarrage. */
  get isReady(): boolean {
    return this.state.status === 'ready';
  }

  /**
   * Arme le mecanisme. Sans effet hors build empaquete.
   * Ne rejette jamais : un updater en panne ne doit pas empecher l'outil de servir.
   */
  start(): void {
    if (!app.isPackaged) {
      log.info('mises a jour inactives : application non empaquetee');
      return;
    }

    try {
      // Require differe : le module tire une chaine de dependances inutile en
      // developpement, et son chargement echoue sans `app-update.yml`.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { autoUpdater } = require('electron-updater') as { autoUpdater: AutoUpdater };
      this.updater = autoUpdater;

      autoUpdater.autoDownload = true;
      // Installation a la fermeture : jamais pendant que l'utilisateur joue.
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.logger = {
        info: (m: unknown) => log.debug(String(m)),
        warn: (m: unknown) => log.warn(String(m)),
        error: (m: unknown) => log.warn(String(m)),
        debug: () => undefined,
      };

      autoUpdater.on('checking-for-update', () => {
        this.setState({ status: 'checking', currentVersion: this.currentVersion });
      });

      autoUpdater.on('update-available', (info: never) => {
        const version = versionOf(info);
        log.info(`version ${version} disponible, telechargement en arriere-plan`);
        this.setState({ status: 'available', currentVersion: this.currentVersion, version });
      });

      autoUpdater.on('update-not-available', () => {
        this.lastCheck = Date.now();
        this.setState({ status: 'idle', currentVersion: this.currentVersion, lastCheck: this.lastCheck });
      });

      autoUpdater.on('download-progress', (progress: never) => {
        const percent = Math.round(Number((progress as { percent?: number })?.percent ?? 0));
        const version = this.state.status === 'available' || this.state.status === 'downloading' ? this.state.version : '';
        this.setState({ status: 'downloading', currentVersion: this.currentVersion, version, percent });
      });

      autoUpdater.on('update-downloaded', (info: never) => {
        const version = versionOf(info);
        this.lastCheck = Date.now();
        log.info(`version ${version} prete, elle s'installera a la fermeture`);
        this.setState({ status: 'ready', currentVersion: this.currentVersion, version });
      });

      autoUpdater.on('error', (error: never) => {
        this.lastCheck = Date.now();
        const message = String((error as { message?: string })?.message ?? error);
        // Une panne reseau est frequente et sans gravite : on n'alarme pas.
        log.warn(`verification impossible : ${message}`);
        this.setState({
          status: 'error',
          currentVersion: this.currentVersion,
          message,
          lastCheck: this.lastCheck,
        });
      });

      setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS).unref?.();
      this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
      this.timer.unref?.();
      log.info(`mises a jour actives (version ${this.currentVersion})`);
    } catch (err) {
      log.warn('initialisation des mises a jour impossible', err);
      this.setState({
        status: 'error',
        currentVersion: this.currentVersion,
        message: String((err as Error)?.message ?? err),
        lastCheck: null,
      });
    }
  }

  /** Verification immediate. Sans effet si le mecanisme est inactif. */
  async check(): Promise<UpdateState> {
    if (!this.updater) return this.state;
    // Une version deja telechargee n'a plus rien a verifier.
    if (this.state.status === 'ready') return this.state;

    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      // Les erreurs remontent aussi par l'evenement `error` ; ce filet couvre
      // les rejets synchrones (URL malformee, provider absent).
      log.warn('verification en echec', err);
    }
    return this.state;
  }

  /**
   * Ferme l'application et applique la mise a jour.
   * Action explicite de l'utilisateur uniquement — jamais declenchee seule.
   */
  quitAndInstall(): void {
    if (!this.updater || this.state.status !== 'ready') return;
    log.info('redemarrage pour appliquer la mise a jour');
    (app as { isQuitting?: boolean }).isQuitting = true;
    this.updater.quitAndInstall(false, true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private setState(next: UpdateState): void {
    this.state = next;
    this.emit('changed', next);
  }
}

/** Numero de version porte par les evenements d'electron-updater. */
function versionOf(info: unknown): string {
  const version = (info as { version?: unknown })?.version;
  return typeof version === 'string' ? version : 'inconnue';
}
