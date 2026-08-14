/**
 * services/ItemDetector.ts
 * ------------------------
 * Boucle de detection : curseur -> capture -> OCR -> matching -> resume de prix.
 *
 * Budget CPU
 * ----------
 * Le seul travail permanent est la lecture de la position du curseur toutes les
 * 60 ms (un appel systeme, cout negligeable). La chaine couteuse
 * (capture + OCR, ~150 a 400 ms) n'est declenchee que si **toutes** ces
 * conditions sont reunies :
 *
 *   - l'overlay est actif ;
 *   - le cache de prix est rempli ;
 *   - Tarkov est la fenetre au premier plan ;
 *   - le curseur est immobile depuis `hoverSettleMs` ;
 *   - `minOcrIntervalMs` s'est ecoule depuis le dernier OCR ;
 *   - les budgets de tentatives de cette position ne sont pas epuises.
 *
 * Resultat : en deplacement continu de souris, aucun OCR n'est lance. A l'arret
 * sur un item, un a trois OCR sont lances puis plus rien tant que la souris ne
 * bouge pas. Au repos sur le bureau, la consommation est nulle.
 *
 * Deux budgets, pas un
 * --------------------
 * Le retry par position existe parce que le tooltip Tarkov apparait ~300 ms
 * apres l'immobilisation : les premiers cycles tombent sur une zone encore vide.
 * Ces cycles-la ne coutent que capture + localisation et sont comptes a part
 * (`MAX_LOCATE_ATTEMPTS_PER_SPOT`) ; seuls les cycles ayant reellement lu une
 * infobulle entament `MAX_OCR_ATTEMPTS_PER_SPOT`.
 *
 * Avec un budget unique, les trois tentatives etaient consommees avant que le
 * jeu ait dessine l'infobulle, et l'objet survole restait sans prix jusqu'au
 * prochain mouvement de souris.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { nativeImage, screen } from 'electron';
import type { AppConfig, DebugFrame, PriceSummary, TarkovItem } from '../types/index';
import { buildSummary, referenceFleaPrice, type ItemIndex } from './ItemIndex';
import { ScreenCapture } from './ScreenCapture';
import { OcrEngine } from './OcrEngine';
import type { ForegroundWatcher } from './ForegroundWatcher';
import { createLogger } from './Logger';

const log = createLogger('detector');

/**
 * Periode d'echantillonnage du curseur.
 *
 * Fixe aussi la fluidite du suivi de la carte : a 60 ms, elle accusait jusqu'a
 * une trame et demie de retard sur le curseur, visible comme un trainage. 25 ms
 * la colle au curseur.
 *
 * Le tick reste tres bon marche — une lecture de position et un booleen en
 * cache — et il ne declenche aucun travail lourd : capture et OCR restent
 * gouvernes par `hoverSettleMs` et `minOcrIntervalMs`.
 */
const CURSOR_POLL_MS = 25;

/**
 * Inactivite au-dela de laquelle le flux de capture est relache.
 *
 * Le flux coute du GPU en permanence : le garder ouvert pendant qu'on code ou
 * qu'on lit ses mails n'a aucun interet. Mais le **reconstruire** coute bien plus
 * cher qu'il ne rapporte — enumeration des sources (~168 ms), creation de fenetre
 * et negociation `getUserMedia`, soit environ une seconde de travail lourd.
 *
 * A 3 s, chaque aller-retour vers la fenetre de reglages declenchait ce cycle
 * complet, en plein jeu : l'optimisation produisait exactement les saccades
 * qu'elle devait supprimer. 30 s ne se declenche que sur une vraie pause.
 */
const STREAM_IDLE_RELEASE_MS = 30_000;

/**
 * Nombre d'echantillons de calibration collectes par session de debug.
 * Assez pour couvrir plusieurs tailles de grille, assez peu pour ne pas remplir
 * le disque : une fenetre de recherche en pleine resolution pese ~1 Mo.
 */
const MAX_CALIBRATION_SAMPLES = 40;
/**
 * Tentatives d'OCR autorisees sur une meme position avant abandon.
 * Ne comptabilise que les cycles ou l'infobulle a ete trouvee et lue : c'est le
 * poste couteux (~70 ms d'OCR), et trois lectures infructueuses du meme texte
 * n'ont aucune raison d'en produire une quatrieme differente.
 */
const MAX_OCR_ATTEMPTS_PER_SPOT = 3;

/**
 * Tentatives de *reperage* autorisees sur une meme position.
 *
 * Budget distinct, et volontairement plus large. Un cycle qui ne localise aucune
 * infobulle coute seulement capture + localisation (~80 ms) et signifie « le jeu
 * ne l'a pas encore dessinee », pas « il n'y a rien ici ».
 *
 * Tarkov affiche son infobulle ~300 ms apres l'immobilisation du curseur. Avec
 * un budget unique de 3 partage avec l'OCR, les tentatives etaient consommees
 * avant meme son apparition, et plus rien n'etait retente jusqu'au prochain
 * mouvement de souris — l'objet survole restait sans prix indefiniment.
 *
 * 8 tentatives espacees de `minOcrIntervalMs` couvrent ~1 s, ce qui laisse une
 * marge confortable sur ce delai d'affichage.
 */
const MAX_LOCATE_ATTEMPTS_PER_SPOT = 8;

/**
 * Echecs consecutifs au-dela desquels la boucle ralentit.
 *
 * Le budget par position ne protege de rien quand la souris bouge : chaque
 * mouvement le remet a zero, et huit nouvelles tentatives repartent. En raid,
 * viser fait bouger la souris en permanence alors qu'aucune infobulle n'existe —
 * la boucle tournait donc a plein regime pendant tout le raid, ce qui est
 * exactement le moment ou le jeu a besoin de la machine. Rapporte en jeu :
 * « quand je ferme l'inventaire ca arrive que ca continue de regarder et donc de
 * me faire stutter a mort ».
 *
 * 15 echecs de suite valent environ une seconde et demie sans la moindre
 * infobulle : hors inventaire, avec certitude.
 */
const MISSES_BEFORE_BACKOFF = 15;

/**
 * Plafond de l'intervalle en mode ralenti, en millisecondes.
 *
 * Le cout residuel devient alors une capture de region toutes les deux secondes,
 * soit ~8 ms de travail — indetectable. Assez court, cependant, pour que la
 * reprise soit immediate a la reouverture de l'inventaire : le premier survol
 * tombe au pire deux secondes plus tard, et un seul succes suffit a revenir au
 * regime nominal.
 */
const BACKOFF_MAX_INTERVAL_MS = 2000;

/** Facteur applique a l'intervalle a chaque echec au-dela du seuil. */
const BACKOFF_GROWTH = 1.35;
/**
 * Marge autour de l'infobulle au-dela de laquelle la carte est retiree.
 *
 * On mesure la sortie de l'infobulle elle-meme, pas un rayon autour du point de
 * detection : c'est le signal exact de « l'utilisateur ne survole plus cet
 * objet ». Un rayon fixe est soit trop nerveux sur une grande infobulle, soit
 * trop laxiste sur une petite.
 */
const DISMISS_MARGIN_PX = 90;

/** Repli quand aucun rectangle d'infobulle n'est connu (mode zone fixe). */
const DISMISS_DISTANCE_PX = 160;

/**
 * Deplacement du curseur, en pixels logiques, au-dela duquel l'objet survole est
 * reverifie alors qu'une carte est deja affichee.
 *
 * Plus petit qu'une case d'inventaire (~63 px a 1080p) : passer a la case
 * voisine declenche donc toujours une verification, ce qui est exactement le cas
 * a rattraper — sans cela, la carte gardait le prix de l'objet precedent tant
 * que le curseur restait dans la marge de l'ancienne infobulle.
 *
 * Le cout d'une verification est une chaine complete sans aucune operation de
 * fenetre : ~60 ms de processeur, et rien de plus si l'objet n'a pas change.
 * Les mesures ont etabli que c'est l'affichage, pas le calcul, qui fait saccader
 * le jeu — ce budget-la est donc sans consequence.
 */
const RECHECK_DISTANCE_PX = 35;

// Retire : masquage de la carte au-dela de 40 px de deplacement.
//
// La regle visait a ne pas laisser un prix faux a l'ecran en passant a l'objet
// voisin. Elle se retournait contre son but : 40 px valent une demi-case, mais
// un objet en occupe souvent deux ou trois. Balayer un seul gilet suffisait donc
// a franchir le seuil, et la carte etait masquee puis reaffichee en boucle.
//
// Or chaque **apparition** de la carte est precisement ce qui fait saccader le
// jeu — quatre tests successifs l'ont etabli, la chaine complete sans carte
// affichee ne coutant rien. Releve en jeu sur un seul gilet survole, curseur en
// 408, 626, 570, 482, 504 : cinq masquages et cinq reaffichages en 2,7 s.
//
// `movedAway` couvre deja le cas vise, et mieux : il mesure la sortie de
// l'infobulle elle-meme, augmentee de `DISMISS_MARGIN_PX`, au lieu d'un rayon
// fixe qui ignore la taille de l'objet.

/**
 * Au-dessus de ce score, la correspondance est jugee sure et le garde-fou
 * d'ambiguite ne s'applique pas.
 *
 * Calibre a 0,75 et non 0,8 : les noms affiches par le jeu different parfois de
 * ceux de tarkov.dev (« Mk 17 » contre « FN SCAR-H »), ce qui plafonne des
 * correspondances pourtant correctes autour de 0,79. Les rejeter revenait a ne
 * rien afficher sur des objets courants.
 */
const CONFIDENT_SCORE = 0.75;

/**
 * Ecart minimal avec le second candidat lorsque le score est faible.
 * Volontairement etroit : le seuil de correspondance fait deja le gros du tri,
 * ce garde-fou ne vise que les quasi-egalites, signe d'un texte qui ne
 * correspond a rien en particulier.
 */
const AMBIGUITY_MARGIN = 0.03;

/**
 * Confiance Tesseract minimale, de 0 a 100.
 *
 * Certaines zones passent tous les filtres geometriques sans contenir la moindre
 * lettre : les emplacements vides de Tarkov, hachures diagonales, se moyennent en
 * un gris uniforme au sous-echantillonnage et forment un rectangle « plein »
 * parfaitement credible. Tesseract y lit alors deux ou trois caracteres au hasard.
 *
 * Ce bruit se distingue sans ambiguite d'une vraie lecture : mesure en jeu, une
 * infobulle correctement cadree sort a **91 %**, une zone hachuree a **4 %**.
 * Le seuil est place tres bas dans cet ecart pour ne jamais rejeter une lecture
 * legitime, meme degradee.
 */
const MIN_OCR_CONFIDENCE = 30;

/**
 * Petite image blanche servant uniquement a declencher le premier passage dans
 * Tesseract. Son contenu n'a aucune importance : c'est l'initialisation du
 * moteur que l'on cherche a provoquer, pas un resultat.
 */
function blankPng(): Buffer {
  const side = 32;
  return nativeImage
    .createFromBitmap(Buffer.alloc(side * side * 4, 255), { width: side, height: side })
    .toPNG();
}

interface Point {
  x: number;
  y: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Le point est-il dans le rectangle, elargi de `margin` de chaque cote ? */
function isInsideWithMargin(point: Point, rect: Rect, margin: number): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x <= rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y <= rect.y + rect.height + margin
  );
}

export interface DetectorDeps {
  index: ItemIndex;
  foreground: ForegroundWatcher;
  getConfig(): AppConfig;
  /** Le cache contient-il des donnees exploitables ? */
  hasPrices(): boolean;
  /**
   * Bounds de la carte de prix si elle est visible, en pixels logiques globaux.
   *
   * Indispensable : la carte est un grand rectangle sombre pres du curseur,
   * c'est-a-dire exactement ce que cherche le localisateur. Sans exclusion, elle
   * se detecte elle-meme et l'OCR relit ses propres libelles.
   */
  getOverlayBounds(): { x: number; y: number; width: number; height: number } | null;
  /**
   * La fenetre de reglages est-elle ouverte ?
   *
   * Les apercus du panneau debug n'ont de destinataire que dans ce cas. Les
   * encoder alors qu'elle est fermee, c'est payer un PNG et un base64 par cycle
   * pour des images que personne ne verra — et des saccades en jeu.
   */
  wantsDebugImages(): boolean;
}

/**
 * Emet :
 *   - `match` (summary: PriceSummary, cursor: Point) — afficher la carte
 *   - `hide`  ()                                     — masquer la carte
 *   - `debug` (frame: DebugFrame)                    — alimenter le panneau debug
 */
export class ItemDetector extends EventEmitter {
  private readonly capture: ScreenCapture;
  private readonly ocr: OcrEngine;

  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  private lastCursor: Point = { x: -1, y: -1 };
  /** Date a laquelle le curseur s'est immobilise. */
  private settledAt = 0;
  /** Position analysee lors du dernier OCR. */
  private lastOcrPoint: Point | null = null;
  /** Cycles lances sur cette position, quel qu'en soit le resultat. */
  private locateAttemptsAtSpot = 0;
  /** Sous-ensemble ayant reellement atteint l'OCR (infobulle localisee). */
  private ocrAttemptsAtSpot = 0;
  /**
   * Cycles consecutifs n'ayant trouve aucune infobulle, toutes positions
   * confondues. Voir `MISSES_BEFORE_BACKOFF`.
   */
  private consecutiveMisses = 0;
  private lastOcrAt = 0;
  /** Instant depuis lequel la detection ne sert a rien. 0 si elle est utile. */
  private idleSince = 0;
  /** Le flux a-t-il ete relache pour inactivite ? Evite tout cycle inutile. */
  private streamReleased = false;
  /** Echantillons de calibration deja ecrits durant cette session. */
  private calibrationCount = 0;

  /** Item actuellement affiche, pour eviter de re-emettre la meme carte. */
  private shownItemId: string | null = null;
  private shownAt = 0;
  private shownAtPoint: Point | null = null;
  /** Infobulle ayant produit la carte affichee, en pixels logiques. */
  private shownTooltipRect: Rect | null = null;

  constructor(
    private readonly userDataPath: string,
    private readonly deps: DetectorDeps,
  ) {
    super();
    this.ocr = new OcrEngine(userDataPath);
    this.capture = new ScreenCapture(userDataPath);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), CURSOR_POLL_MS);
    // Le premier OCR coute ~250 ms de plus que les suivants (JIT du WASM,
    // chargement du modele LSTM) : on paie ici plutot qu'au premier survol.
    void this.ocr.warmUp(blankPng());
    // Le flux, lui, n'est monte que s'il est demande — c'est le poste qui
    // consomme en permanence.
    if (this.deps.getConfig().useCaptureStream) {
      void this.capture.warmUp();
    } else {
      this.streamReleased = true;
    }
    log.info('boucle de detection demarree');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hide();
    // Un flux video permanent consomme du CPU : on le libere des l'arret.
    this.capture.releaseStream();
    log.info('boucle de detection arretee');
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.ocr.dispose();
  }

  /** Force une detection immediate, quels que soient les temporisateurs (bouton de test). */
  async probe(): Promise<void> {
    this.locateAttemptsAtSpot = 0;
    this.ocrAttemptsAtSpot = 0;
    this.lastOcrPoint = null;
    this.lastOcrAt = 0;
    await this.detect(screen.getCursorScreenPoint(), true);
  }

  /**
   * Ouvre ou relache le flux de capture selon que la detection peut servir.
   *
   * Le flux est le seul poste qui consomme en continu : le laisser tourner alors
   * que le jeu n'est pas au premier plan revient a payer des FPS pour rien.
   */
  private updateStream(config: AppConfig, now: number): void {
    const usable =
      config.overlayEnabled &&
      (!config.onlyWhenGameFocused || this.deps.foreground.isGameFocused(config.gameProcessName));

    // Flux desactive : on ne le monte jamais, et on s'assure qu'il est ferme.
    if (!config.useCaptureStream) {
      if (!this.streamReleased) {
        this.streamReleased = true;
        this.capture.releaseStream();
      }
      return;
    }

    if (usable) {
      // Ne remonte le flux que s'il a effectivement ete relache. Appeler
      // `warmUp()` a chaque tick etait sans effet mais creait une promesse
      // toutes les 60 ms, et masquait le vrai cycle relache / reconstruction.
      if (this.streamReleased) {
        this.streamReleased = false;
        void this.capture.warmUp();
      }
      this.idleSince = 0;
      return;
    }

    if (this.idleSince === 0) {
      this.idleSince = now;
    } else if (!this.streamReleased && now - this.idleSince > STREAM_IDLE_RELEASE_MS) {
      this.streamReleased = true;
      this.capture.releaseStream();
      log.debug('flux de capture relache (jeu hors du premier plan)');
    }
  }

  /** Appele a chaque `CURSOR_POLL_MS`. Doit rester tres bon marche. */
  private tick(): void {
    const config = this.deps.getConfig();
    const cursor = screen.getCursorScreenPoint();
    const now = Date.now();

    this.updateStream(config, now);

    // --- Suivi du mouvement ---
    if (distance(cursor, this.lastCursor) > config.cursorMoveThresholdPx) {
      this.lastCursor = cursor;
      this.settledAt = now;
      // Nouvelle position : les deux budgets repartent a zero.
      if (!this.lastOcrPoint || distance(cursor, this.lastOcrPoint) > config.cursorMoveThresholdPx) {
        this.locateAttemptsAtSpot = 0;
        this.ocrAttemptsAtSpot = 0;
      }
    }

    // --- Masquage de la carte affichee ---
    if (this.shownItemId) {
      const movedAway = this.shownTooltipRect
        ? !isInsideWithMargin(cursor, this.shownTooltipRect, DISMISS_MARGIN_PX)
        : Boolean(this.shownAtPoint && distance(cursor, this.shownAtPoint) > DISMISS_DISTANCE_PX);
      // Le curseur a change d'objet : la carte decrit desormais autre chose que
      // ce qui est survole. On la retire sans attendre la detection suivante.
      const expired = now - this.shownAt > config.autoHideMs;
      if (movedAway || expired || !config.overlayEnabled) {
        this.hide();
      } else if (config.overlayFollowCursor && config.overlayTransparent) {
        // La carte prolonge l'infobulle du jeu, qui suit le curseur : elle doit
        // le suivre aussi, sans attendre la prochaine analyse.
        //
        // Emis seulement si le suivi est demande : voir `overlayFollowCursor`,
        // chaque envoi provoque une recomposition de la fenetre du jeu par le
        // DWM, a la cadence du sondage curseur.
        this.emit('follow', cursor);
      }
    }

    if (this.busy || !config.overlayEnabled) return;

    // --- Rien de nouveau a decouvrir ---
    //
    // Une carte est affichee : faut-il verifier qu'elle decrit toujours le bon
    // objet ?
    //
    // Deux choses a ne pas confondre — **masquer** la carte, et **autoriser une
    // nouvelle analyse**. Les avoir liees a produit tour a tour les deux
    // defauts opposes :
    //
    //   masquage au moindre mouvement  -> la carte disparaissait et reapparaissait
    //                                     cinq fois sur un seul gilet survole, et
    //                                     chaque reapparition faisait saccader le jeu
    //   aucune nouvelle analyse tant   -> en passant a l'objet voisin, le curseur
    //   que la carte est affichee         restait dans la marge de l'ancienne
    //                                     infobulle : le prix affiche restait celui
    //                                     de l'objet precedent
    //
    // La carte reste donc affichee, mais l'analyse est relancee des que le
    // curseur a parcouru de quoi changer de case. Si l'objet est le meme, la
    // chaine se termine sans rien reafficher (voir le retour anticipe sur
    // `shownItemId === best.item.id`) : du travail processeur, mais aucune
    // operation de fenetre — et c'est bien l'affichage, pas le calcul, qui
    // saccade.
    if (this.shownItemId && !this.shouldRecheck(cursor)) return;

    if (now - this.settledAt < config.hoverSettleMs) return;
    if (now - this.lastOcrAt < this.currentInterval(config)) return;
    if (this.locateAttemptsAtSpot >= MAX_LOCATE_ATTEMPTS_PER_SPOT) return;
    if (this.ocrAttemptsAtSpot >= MAX_OCR_ATTEMPTS_PER_SPOT) return;

    this.locateAttemptsAtSpot++;
    this.lastOcrAt = now;
    this.lastOcrPoint = cursor;
    void this.detect(cursor, false);
  }

  /**
   * Le curseur a-t-il assez bouge pour qu'il faille reverifier l'objet survole ?
   *
   * Le point de reference est celui de la derniere identification, remis a jour
   * meme lorsqu'elle confirme l'objet deja affiche : la fenetre de tolerance
   * glisse donc avec le curseur au lieu de rester ancree a la premiere
   * detection.
   */
  private shouldRecheck(cursor: Point): boolean {
    if (!this.shownAtPoint) return true;
    return distance(cursor, this.shownAtPoint) > RECHECK_DISTANCE_PX;
  }

  /**
   * Intervalle minimal entre deux cycles, allonge apres une serie d'echecs.
   *
   * Voir `MISSES_BEFORE_BACKOFF` : sans ce ralentissement, la boucle tourne a
   * plein regime pendant tout un raid, ou aucune infobulle ne peut apparaitre.
   */
  private currentInterval(config: AppConfig): number {
    if (this.consecutiveMisses < MISSES_BEFORE_BACKOFF) return config.minOcrIntervalMs;
    const overshoot = this.consecutiveMisses - MISSES_BEFORE_BACKOFF;
    return Math.min(
      BACKOFF_MAX_INTERVAL_MS,
      Math.round(config.minOcrIntervalMs * BACKOFF_GROWTH ** overshoot),
    );
  }

  /** Chaine complete capture -> OCR -> matching. Ne rejette jamais. */
  private async detect(cursor: Point, forced: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    const config = this.deps.getConfig();
    const debug = config.debugMode;
    /**
     * Les apercus du panneau debug coutent un encodage PNG et un base64 par
     * cycle. Les produire alors que la fenetre de reglages est fermee, c'est
     * payer des saccades en jeu pour des images que personne ne regarde.
     */
    const debugImages = debug && this.deps.wantsDebugImages();
    const collecting = config.collectCalibration;
    /** Rectangle de l'infobulle en pixels logiques, pour ne pas la recouvrir. */
    let tooltipRect: { x: number; y: number; width: number; height: number } | null = null;
    const frame: DebugFrame = {
      timestamp: Date.now(),
      mode: config.captureMode,
      timings: null,
      imageDataUrl: null,
      searchDataUrl: null,
      rect: null,
      fillRatio: null,
      rawText: '',
      ocrConfidence: 0,
      candidates: [],
      captureMs: 0,
      ocrMs: 0,
      skippedReason: null,
    };

    try {
      // --- Gardes ---
      if (!this.deps.hasPrices()) {
        frame.skippedReason = 'cache de prix vide';
        return;
      }
      if (!forced && config.onlyWhenGameFocused && !this.deps.foreground.isGameFocused(config.gameProcessName)) {
        frame.skippedReason = `jeu non au premier plan (actif : ${this.deps.foreground.foregroundProcess || 'inconnu'})`;
        return;
      }

      // --- Capture et cadrage ---
      //
      // La zone exclue est retenue dans une variable : la relire plus tard pour
      // le journal donnerait un autre etat que celui reellement utilise, la
      // carte ayant pu etre masquee entre-temps. Un diagnostic qui ne decrit pas
      // ce qui s'est passe est pire qu'aucun diagnostic.
      const excludedCard = this.deps.getOverlayBounds();
      const shot = await this.capture.capture(config, debugImages, excludedCard, collecting);
      frame.captureMs = shot.timings.totalMs;
      frame.timings = shot.timings;
      if (debugImages && shot.previewPng) {
        frame.searchDataUrl = `data:image/png;base64,${shot.previewPng.toString('base64')}`;
      }
      if (!shot.ok) {
        // Aucune infobulle : la serie s'allonge, et avec elle l'intervalle.
        this.consecutiveMisses++;
        if (this.consecutiveMisses === MISSES_BEFORE_BACKOFF) {
          log.debug('aucune infobulle depuis 15 cycles — passage en veille');
        }
        frame.skippedReason = shot.reason;
        return;
      }
      // Une infobulle a ete cadree : l'inventaire est ouvert, on repasse au
      // regime nominal meme si l'OCR ou la correspondance echouent ensuite.
      if (this.consecutiveMisses >= MISSES_BEFORE_BACKOFF) {
        log.debug(`reprise du regime nominal apres ${this.consecutiveMisses} cycles en veille`);
      }
      this.consecutiveMisses = 0;
      frame.rect = shot.rect;
      frame.fillRatio = shot.locate?.fillRatio ?? null;
      tooltipRect = shot.rectDip;
      if (debugImages) frame.imageDataUrl = `data:image/png;base64,${shot.png.toString('base64')}`;

      // --- OCR ---
      // L'infobulle a ete localisee : ce cycle engage le budget couteux. Les
      // cycles precedents, qui n'avaient rien trouve, n'ont rien consomme.
      this.ocrAttemptsAtSpot++;
      const ocr = await this.ocr.recognize(shot.png);
      if (!ocr) {
        frame.skippedReason = 'moteur OCR indisponible';
        return;
      }
      frame.ocrMs = ocr.elapsedMs;
      frame.rawText = ocr.text;
      frame.ocrConfidence = ocr.confidence;

      if (ocr.lines.length === 0) {
        frame.skippedReason = 'aucun texte detecte dans la zone';
        return;
      }

      // Rejete avant le matching : du bruit a 4 % de confiance finit toujours par
      // ressembler vaguement a un nom d'objet, et un prix faux est pire que pas
      // de prix. Le filtrer ici evite de dependre du seul seuil de similarite.
      if (ocr.confidence < MIN_OCR_CONFIDENCE) {
        frame.skippedReason =
          `texte illisible (confiance Tesseract ${Math.round(ocr.confidence)} %, ` +
          `minimum ${MIN_OCR_CONFIDENCE} %)`;
        return;
      }

      // --- Matching ---
      // On teste chaque ligne separement puis le bloc entier : le nom d'un item
      // peut etre coupe sur deux lignes dans un tooltip etroit.
      const queries = [...ocr.lines];
      if (ocr.lines.length > 1) queries.push(ocr.lines.join(' '));

      let best: { item: TarkovItem; score: number; from: string } | null = null;
      const allCandidates: Array<{ name: string; score: number }> = [];

      for (const query of queries) {
        for (const candidate of this.deps.index.search(query, 3)) {
          allCandidates.push({ name: candidate.item.name, score: Number(candidate.score.toFixed(3)) });
          if (!best || candidate.score > best.score) {
            best = { item: candidate.item, score: candidate.score, from: query };
          }
        }
      }

      allCandidates.sort((a, b) => b.score - a.score);
      frame.candidates = allCandidates.slice(0, 6);

      if (!best || best.score < config.matchThreshold) {
        frame.skippedReason = best
          ? `meilleur score ${best.score.toFixed(2)} sous le seuil ${config.matchThreshold}`
          : 'aucun item correspondant';
        return;
      }

      // --- Garde-fou d'ambiguite ---
      // Un score eleve est fiable meme si un item proche suit de pres
      // (« AK-74N » et « AKS-74N » scorent tous deux tres haut, et le meilleur
      // est le bon). En revanche, un score faible *et* dispute signale du texte
      // qui ne correspond a rien en particulier : mieux vaut ne rien afficher.
      if (best.score < CONFIDENT_SCORE) {
        const runnerUp = allCandidates.find((c) => c.name !== best!.item.name);
        if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) {
          frame.skippedReason =
            `correspondance ambigue : ${best.item.name} (${best.score.toFixed(2)}) ` +
            `contre ${runnerUp.name} (${runnerUp.score.toFixed(2)})`;
          return;
        }
      }

      // --- Filtre de prix ---
      const reference = referenceFleaPrice(best.item);
      if (config.minPriceFilter > 0) {
        const value = reference ?? best.item.basePrice;
        if (value < config.minPriceFilter) {
          frame.skippedReason = `${best.item.name} filtre (valeur ${value} < ${config.minPriceFilter})`;
          return;
        }
      }

      // Journalise **avant** le retour anticipe ci-dessous : sinon un match
      // errone mais stable ne produit qu'une seule ligne, puis se re-affiche en
      // boucle silencieusement. C'est exactement le cas qu'on cherche a
      // diagnostiquer, il ne doit pas etre le seul a ne rien tracer.
      log.debug(
        `${best.item.name} (${best.score.toFixed(2)}) — capture ${shot.timings.grabMs} ms, ` +
          `cadrage ${shot.timings.locateMs} ms, pretraitement ${shot.timings.preprocessMs} ms, OCR ${ocr.elapsedMs} ms`,
      );
      // Le cadrage est la premiere chose a verifier quand l'item affiche ne
      // correspond pas : une zone bien plus large que l'infobulle signale que le
      // localisateur a pris un panneau d'interface pour cible.
      log.debug(
        `  zone lue ${shot.rect.width}x${shot.rect.height} px en ${shot.rect.x},${shot.rect.y} ` +
          `(remplissage ${shot.locate ? Math.round(shot.locate.fillRatio * 100) + '%' : 'n/a'}) — ` +
          `carte exclue ${excludedCard ? `${excludedCard.width}x${excludedCard.height} en ${excludedCard.x},${excludedCard.y}` : 'aucune'} — ` +
          `texte OCR ${JSON.stringify(ocr.text)}`,
      );

      // L'OCR vient d'identifier l'objet avec certitude : la fenetre capturee est
      // donc un echantillon **etiquete**. C'est exactement ce qu'il faut pour
      // calibrer le matching par icone sans deviner.
      if (collecting && shot.searchFull) {
        this.dumpCalibration(shot.searchFull, best.item, best.score);
      }

      // Match identique a la carte deja affichee : on prolonge simplement l'affichage.
      if (this.shownItemId === best.item.id) {
        this.shownAt = Date.now();
        this.shownAtPoint = cursor;
        this.shownTooltipRect = tooltipRect;
        return;
      }

      const summary = buildSummary(best.item, best.score, best.from);
      this.shownItemId = best.item.id;
      this.shownAt = Date.now();
      this.shownAtPoint = cursor;
      this.shownTooltipRect = tooltipRect;
      // Plus rien a tenter sur cette position : on a trouve.
      this.locateAttemptsAtSpot = MAX_LOCATE_ATTEMPTS_PER_SPOT;
      this.ocrAttemptsAtSpot = MAX_OCR_ATTEMPTS_PER_SPOT;
      this.emit('match', summary satisfies PriceSummary, cursor, tooltipRect);
    } catch (err) {
      frame.skippedReason = `erreur interne : ${(err as Error)?.message ?? err}`;
      log.error('cycle de detection en erreur', err);
    } finally {
      this.busy = false;
      if (debug) this.emit('debug', frame);
    }
  }

  /**
   * Ecrit un echantillon de calibration : la fenetre de recherche en pleine
   * resolution, plus l'objet que l'OCR vient d'y identifier.
   *
   * Le matching par icone a besoin de deux mesures qu'aucune lecture de code ne
   * donne : le pas reel de la grille d'inventaire, et l'ecart entre une case
   * telle que le jeu la rend (fond de slot colore, surcharges de quantite et de
   * durabilite) et l'icone du catalogue, propre et sur fond transparent. Les
   * supposer, c'est ce qui produit du code qui ne marche qu'en theorie.
   *
   * Ces echantillons sont **etiquetes** : l'objet est connu, sa taille en slots
   * aussi, et la position du curseur est enregistree. Ils permettent donc de
   * verifier une identification par icone contre une verite terrain.
   *
   * Plafonne pour ne pas remplir le disque, et strictement limite au mode debug.
   */
  private dumpCalibration(
    sample: { png: Buffer; cursorX: number; cursorY: number; sizeScale: number },
    item: TarkovItem,
    score: number,
  ): void {
    if (this.calibrationCount >= MAX_CALIBRATION_SAMPLES) return;
    try {
      const dir = path.join(this.userDataPath, 'calibration');
      mkdirSync(dir, { recursive: true });

      const index = String(this.calibrationCount).padStart(3, '0');
      const file = `${index}-${item.width}x${item.height}.png`;
      writeFileSync(path.join(dir, file), sample.png);
      appendFileSync(
        path.join(dir, 'index.jsonl'),
        JSON.stringify({
          file,
          itemId: item.id,
          itemName: item.name,
          slotWidth: item.width,
          slotHeight: item.height,
          cursorX: sample.cursorX,
          cursorY: sample.cursorY,
          sizeScale: Number(sample.sizeScale.toFixed(4)),
          ocrScore: Number(score.toFixed(3)),
        }) + '\n',
        'utf8',
      );

      this.calibrationCount++;
      if (this.calibrationCount === MAX_CALIBRATION_SAMPLES) {
        log.info(`calibration : ${MAX_CALIBRATION_SAMPLES} echantillons collectes dans ${dir}`);
      }
    } catch (err) {
      // La calibration est un outil de mise au point : son echec ne doit jamais
      // perturber la detection.
      log.warn('ecriture d\'un echantillon de calibration impossible', err);
    }
  }

  private hide(): void {
    if (!this.shownItemId) return;
    this.shownItemId = null;
    this.shownAtPoint = null;
    this.shownTooltipRect = null;
    this.emit('hide');
  }
}
