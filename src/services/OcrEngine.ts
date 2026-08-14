/**
 * services/OcrEngine.ts
 * ---------------------
 * Enveloppe autour de tesseract.js (WASM, aucune dependance native).
 *
 * Trois points importants :
 *
 *   1. Initialisation paresseuse. Le worker n'est cree qu'au premier OCR reel,
 *      ce qui garde le demarrage de l'application quasi instantane.
 *   2. Serialisation. Un worker Tesseract ne traite qu'une image a la fois ;
 *      un appel concurrent corromprait le resultat. Toutes les demandes passent
 *      par une file d'un seul element.
 *   3. Donnees de langue. `eng.traineddata` (~4 Mo) est telecharge au premier
 *      lancement puis mis en cache dans userData. C'est le seul moment ou l'OCR
 *      necessite une connexion.
 */

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createLogger } from './Logger';

const log = createLogger('ocr');

/**
 * Duree d'inactivite au-dela de laquelle le worker est libere.
 *
 * Le heap WASM de Tesseract pese **60 a 90 Mo**, et il est conserve tant que le
 * worker vit — soit, sans ce mecanisme, pour toute la duree de la session, y
 * compris pendant un raid entier ou plus rien n'est survole. C'est de loin le
 * plus gros poste memoire de l'application.
 *
 * Recharger coute ~180 ms (creation du worker, JIT du WASM, modele LSTM), paye
 * une seule fois au survol suivant. Le compromis est donc largement favorable
 * des que l'inactivite depasse quelques dizaines de secondes.
 *
 * 90 s : assez long pour ne jamais se declencher pendant une session de tri de
 * stash, assez court pour rendre la memoire pendant un raid.
 */
const IDLE_RELEASE_MS = 90_000;

/** Mode de segmentation 6 : « un bloc de texte uniforme ». Correspond a un tooltip. */
const PSM_SINGLE_BLOCK = '6';
/** Moteur 1 : LSTM seul. Nettement meilleur que l'ancien moteur sur du texte bruite. */
const OEM_LSTM_ONLY = 1;

export interface OcrResult {
  /** Texte complet reconnu, lignes separees par `\n`. */
  text: string;
  /** Lignes non vides, deja nettoyees. */
  lines: string[];
  /** Confiance globale rapportee par Tesseract, de 0 a 100. */
  confidence: number;
  elapsedMs: number;
}

/** Type minimal du worker tesseract.js, pour eviter de dependre de ses typings. */
interface TesseractWorker {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(image: Buffer): Promise<{ data: { text?: string; confidence?: number } }>;
  terminate(): Promise<unknown>;
}

export class OcrEngine {
  private worker: TesseractWorker | null = null;
  private initPromise: Promise<TesseractWorker> | null = null;
  /** Chaine de promesses garantissant un seul `recognize` a la fois. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly cachePath: string;

  constructor(userDataPath: string) {
    this.cachePath = path.join(userDataPath, 'tessdata');
    try {
      mkdirSync(this.cachePath, { recursive: true });
    } catch {
      /* Sans dossier de cache, tesseract.js retelechargera a chaque lancement. */
    }
  }

  /**
   * Cree le worker si necessaire. Les appels concurrents partagent la meme promesse.
   * @throws si le telechargement des donnees de langue echoue.
   */
  private async ensureWorker(): Promise<TesseractWorker> {
    if (this.worker) return this.worker;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      log.info('initialisation du worker Tesseract (premier lancement : telechargement de eng.traineddata)');
      // Require differe : tesseract.js reste hors du bundle (voir build.mjs).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createWorker } = require('tesseract.js') as {
        createWorker: (lang: string, oem: number, options: Record<string, unknown>) => Promise<TesseractWorker>;
      };

      const worker = await createWorker('eng', OEM_LSTM_ONLY, {
        cachePath: this.cachePath,
        // Le logger de tesseract.js est tres bavard : on ne garde que les erreurs.
        errorHandler: (err: unknown) => log.error('erreur interne Tesseract', err),
      });

      await worker.setParameters({
        tessedit_pageseg_mode: PSM_SINGLE_BLOCK,
        preserve_interword_spaces: '1',
      });

      log.info('worker Tesseract pret');
      this.worker = worker;
      return worker;
    })();

    try {
      return await this.initPromise;
    } catch (err) {
      // Reinitialise pour autoriser une nouvelle tentative au prochain survol.
      this.initPromise = null;
      log.error('initialisation de Tesseract impossible', err);
      throw err;
    }
  }

  /**
   * Prepare le moteur hors du chemin critique.
   *
   * Deux couts distincts sont ainsi payes au demarrage plutot qu'au premier
   * survol : la creation du worker (et le telechargement eventuel des donnees de
   * langue), puis la compilation JIT du WASM et le chargement du modele LSTM,
   * qui n'ont lieu qu'au premier `recognize` reel. Mesure par `npm run test:ocr` :
   * **318 ms au premier appel contre 55 a 80 ms ensuite**.
   *
   * @param sample petite image PNG quelconque, servant uniquement a declencher
   *               le premier passage dans le moteur. Son contenu est ignore.
   *
   * Ne rejette jamais : un echec de prechauffage laisse simplement le premier
   * survol payer le cout, comme avant.
   */
  async warmUp(sample: Buffer): Promise<void> {
    try {
      await this.ensureWorker();
      await this.recognize(sample);
    } catch {
      /* `ensureWorker` a deja journalise ; une nouvelle tentative aura lieu au premier survol. */
    }
  }

  /**
   * Lance un OCR sur une image PNG. Renvoie `null` si le moteur est indisponible
   * (echec d'initialisation, moteur arrete) : l'appelant doit simplement ignorer
   * ce cycle de detection.
   */
  async recognize(png: Buffer): Promise<OcrResult | null> {
    if (this.disposed) return null;

    // Chaine la demande derriere la precedente, sans propager ses erreurs.
    const task = this.queue.then(
      () => this.run(png),
      () => this.run(png),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async run(png: Buffer): Promise<OcrResult | null> {
    if (this.disposed) return null;
    const started = Date.now();
    try {
      const worker = await this.ensureWorker();
      const { data } = await worker.recognize(png);
      // Reprogramme apres la reconnaissance, pas avant : le compte a rebours doit
      // partir de la fin du travail, sinon un OCR long pourrait etre suivi d'une
      // liberation immediate.
      this.scheduleRelease();
      const text = (data.text ?? '').trim();
      return {
        text,
        lines: text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      log.warn('OCR echoue sur cette frame', err);
      return null;
    }
  }

  /**
   * Arme le minuteur de liberation, en annulant le precedent.
   *
   * Le worker n'est pas detruit ici mais dans `release()`, qui passe par la file
   * d'attente : terminer un worker pendant qu'il reconnait une image ferait
   * echouer l'appel en cours.
   */
  private scheduleRelease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.release();
    }, IDLE_RELEASE_MS);
    // Ce minuteur ne doit pas, a lui seul, maintenir le processus en vie.
    this.idleTimer.unref?.();
  }

  /**
   * Libere le worker et son heap WASM. Le prochain `recognize` le recreera.
   *
   * Passe par la file : si un OCR est en cours, la liberation attend son tour.
   */
  private async release(): Promise<void> {
    const task = this.queue.then(
      () => this.terminateWorker(),
      () => this.terminateWorker(),
    );
    this.queue = task.catch(() => undefined);
    await task;
  }

  private async terminateWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.initPromise = null;
    try {
      await worker.terminate();
      log.info(`worker Tesseract libere apres ${IDLE_RELEASE_MS / 1000} s d'inactivite`);
    } catch {
      /* best-effort : le processus enfant partira de toute facon a la fermeture */
    }
  }

  /** Arrete le worker. A appeler a la fermeture de l'application. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const worker = this.worker;
    this.worker = null;
    this.initPromise = null;
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* best-effort */
      }
    }
  }
}
