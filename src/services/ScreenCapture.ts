/**
 * services/ScreenCapture.ts
 * -------------------------
 * Capture d'ecran autour du curseur et pretraitement pour l'OCR.
 *
 * Tout passe par les APIs Electron (`desktopCapturer`, `screen`, `nativeImage`) :
 * aucune dependance native, aucun binaire externe, aucune interaction avec le
 * process du jeu. C'est strictement la meme capacite qu'un logiciel de capture
 * d'ecran classique.
 *
 * Deux modes de cadrage
 * ---------------------
 *   `auto` (defaut) — une large fenetre de recherche est capturee autour du
 *   curseur, puis `TooltipLocator` y trouve le rectangle exact de l'infobulle.
 *   Aucune calibration n'est demandee au joueur, et le cadrage suit l'infobulle
 *   ou qu'elle apparaisse (Tarkov la place au-dessus, en dessous, a gauche ou a
 *   droite du curseur selon la place disponible).
 *
 *   `manual` — rectangle fixe relatif au curseur, conserve comme filet de
 *   securite si la detection automatique echoue sur une configuration donnee.
 *
 * Pipeline commun
 * ---------------
 *   1. Position du curseur -> ecran concerne (multi-moniteurs gere).
 *   2. Capture plein ecran de cet ecran uniquement.
 *   3. Determination du rectangle a analyser (auto ou manuel).
 *   4. Pretraitement : niveaux de gris -> agrandissement x2 -> normalisation
 *      Otsu -> inversion si le texte est plus clair que le fond.
 *
 * Pourquoi ce pretraitement : Tesseract est entraine sur du texte sombre sur
 * fond clair, a une taille de l'ordre de 30 px. L'infobulle Tarkov est l'inverse
 * exact (texte clair, fond sombre) et fait ~14 px de haut en 1080p.
 */

import { desktopCapturer, screen, nativeImage, type NativeImage } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CaptureRegion } from '../types/index';
import { locateTooltip, type LocateResult, type Rect } from './TooltipLocator';
import { FrameGrabber, type Frame } from './FrameGrabber';
import { RegionGrabber } from './RegionGrabber';
import { createLogger } from './Logger';

const log = createLogger('capture');

/** Hauteur de caractere visee avant OCR : l'optimum de Tesseract. */
const TARGET_TEXT_HEIGHT = 30;

/** Hauteur mesuree du texte d'infobulle Tarkov, en pixels a 1080p. */
const TOOLTIP_TEXT_AT_1080P = 14;

/**
 * Echelle de travail visee, exprimee comme `hauteur capturee / 1080`.
 *
 * Le cout de tout le pipeline suit la surface capturee. Le rendement, lui,
 * plafonne : au-dela de cette echelle, le texte est deja plus grand que ce dont
 * Tesseract a besoin, et l'agrandissement du pretraitement compense de toute
 * facon en dessous. Un ecran 4K est donc reduit d'environ 42 % avant tout
 * traitement, un 1080p n'est pas touche.
 *
 * 1,15 place le texte d'infobulle vers 16 px, soit ~32 px apres l'agrandissement
 * x2 — l'optimum de Tesseract. C'est aussi l'echelle a laquelle les 13 cas de
 * `npm run test:ocr` sont reconnus a 1,00.
 */
const TARGET_SIZE_SCALE = 1.15;

/**
 * Ecart minimal entre les moyennes des deux classes Otsu pour considerer que la
 * zone contient reellement du texte. En dessous, la zone est quasi uniforme et
 * la normaliser ne ferait qu'amplifier du bruit en motifs parasites.
 */
const MIN_CLASS_SEPARATION = 25;

/**
 * Demi-dimensions de la fenetre de recherche en mode auto, en pixels a 1080p.
 * Assez large pour contenir une infobulle de nom long placee de n'importe quel
 * cote du curseur, assez etroite pour que les panneaux d'interface eloignes
 * n'entrent pas en concurrence.
 */
/**
 * Extension de la fenetre de recherche **du cote ou l'infobulle se deploie**,
 * en pixels a 1080p.
 *
 * Tarkov ancre l'infobulle au curseur et l'etend vers la droite. Il suffit donc
 * de couvrir sa largeur maximale (`MAX_WIDTH`, 620) plus une marge d'ancrage.
 */
const SEARCH_FORWARD = 700;

/**
 * Extension du cote oppose. Volontairement courte : elle ne sert qu'a absorber
 * le jeu de l'ancrage, mesure entre -53 et +36 px.
 */
const SEARCH_BACKWARD = 90;
/**
 * En hauteur, la fenetre peut etre bien plus etroite qu'en largeur.
 *
 * Mesures en jeu : l'infobulle se place systematiquement juste au-dessus du
 * curseur, son bord haut a 61 a 84 px et son bord bas a ~13 px, pour une hauteur
 * de 50 a 70 px. Elle tient donc dans une bande de ~150 px, et de ~150 px de
 * l'autre cote lorsque Tarkov la bascule sous le curseur faute de place en haut.
 *
 * 200 px a 1080p (267 px a la resolution de capture) laissent 1,8 fois cette
 * marge. L'ancienne valeur de 320 balayait deux fois plus de surface que
 * necessaire : autant de sous-echantillonnage, de seuils et d'etiquetages payes
 * a chaque survol, et autant de distracteurs offerts au localisateur.
 *
 * La largeur, elle, ne peut pas etre reduite : l'infobulle mesure jusqu'a
 * `MAX_WIDTH` et Tarkov la bascule a gauche du curseur pres du bord droit de
 * l'ecran — il faut donc couvrir sa largeur maximale des deux cotes.
 */
const SEARCH_ABOVE = 130;

/**
 * Extension sous le curseur. L'infobulle est **toujours au-dessus** — sur dix
 * detections mesurees en jeu, son bord haut se situe entre 36 et 68 px au-dessus
 * du curseur, et son bord bas au-dessus de lui. Cette marge ne couvre donc que
 * les cas limites.
 */
const SEARCH_BELOW = 40;

/** Largeur maximale de l'apercu de debug. Limite la taille des data URL. */
const PREVIEW_MAX_WIDTH = 640;

export interface CaptureSettings {
  captureMode: 'auto' | 'manual';
  captureRegion: CaptureRegion;
  /** Voir `AppConfig.useCaptureStream`. */
  useCaptureStream: boolean;
  /**
   * Voir `AppConfig.debugMode`.
   *
   * Commande l'ecriture des echantillons d'echec, et **pas** `wantPreview` : ce
   * dernier exige la fenetre de reglages ouverte, ce qui retire le premier plan
   * au jeu et empeche justement toute analyse. Les echecs a diagnostiquer se
   * produisent en jeu, fenetre de reglages fermee.
   */
  debugMode: boolean;
}

/** Decoupage des temps, pour savoir quelle etape coute reellement. */
export interface CaptureTimings {
  /** Capture plein ecran par Electron. Poste le plus lourd en general. */
  grabMs: number;
  /** Localisation de l'infobulle. */
  locateMs: number;
  /** Niveaux de gris, agrandissement, Otsu, encodage PNG. */
  preprocessMs: number;
  totalMs: number;
}

export type CaptureOutcome =
  | {
      ok: true;
      /** Image PNG pretraitee, prete pour Tesseract. */
      png: Buffer;
      width: number;
      height: number;
      timings: CaptureTimings;
      /** Rectangle analyse, en pixels physiques de l'ecran. */
      rect: Rect;
      /** Le meme rectangle en pixels logiques globaux, pour placer la carte. */
      rectDip: Rect;
      /** Resultat de la localisation automatique, `null` en mode manuel. */
      locate: LocateResult | null;
      /** Apercu de la fenetre de recherche (mode debug uniquement). */
      previewPng: Buffer | null;
      /**
       * Fenetre de recherche en pleine resolution, et position du curseur dans
       * son repere. Produit uniquement pour la calibration (mode debug).
       *
       * L'apercu `previewPng` est reduit a 640 px : suffisant pour l'oeil, mais
       * inutilisable pour mesurer un pas de grille ou comparer une icone au
       * pixel pres.
       */
      searchFull: { png: Buffer; cursorX: number; cursorY: number; sizeScale: number } | null;
    }
  | {
      ok: false;
      /** Cause de l'echec, affichee telle quelle dans le panneau debug. */
      reason: string;
      timings: CaptureTimings;
      previewPng: Buffer | null;
    };

/**
 * Largeur maximale demandee a `desktopCapturer` sur le chemin de repli. Au-dela,
 * le cout grimpe sans benefice : le texte est deja largement assez grand pour
 * Tesseract, qui recoit de toute facon un agrandissement x2.
 */
const FALLBACK_MAX_WIDTH = 2560;

/** Plafond d'echantillons d'echec ecrits par session. Voir dumpFailure. */
const MAX_FAILURE_DUMPS = 12;

export class ScreenCapture {
  private readonly frames: FrameGrabber;
  private readonly regions: RegionGrabber;
  /** Nombre d'echantillons d'echec deja ecrits. Voir dumpFailure. */
  private failureDumps = 0;

  constructor(private readonly userDataPath: string) {
    this.frames = new FrameGrabber(userDataPath);
    this.regions = new RegionGrabber(userDataPath);

    // La geometrie physique des ecrans est mise en cache : brancher un moniteur
    // ou changer une resolution la rendrait fausse, et toutes les captures
    // seraient decalees jusqu'au redemarrage.
    const forget = (): void => this.regions.forgetMonitors();
    screen.on('display-added', forget);
    screen.on('display-removed', forget);
    screen.on('display-metrics-changed', forget);
  }

  /** Prepare le flux rapide. Sans effet s'il est deja actif ou indisponible. */
  async warmUp(): Promise<void> {
    await this.frames.start();
  }

  /** Libere le flux. A appeler des que la detection s'arrete. */
  releaseStream(): void {
    this.frames.stop();
    this.regions.stop();
  }

  /**
   * Capture et pretraite la zone contenant l'infobulle.
   * @param wantPreview produit l'apercu de la fenetre de recherche (mode debug)
   */
  async capture(
    settings: CaptureSettings,
    wantPreview: boolean,
    /** Bounds de la carte de prix en pixels logiques globaux, a ignorer. */
    excludeDip: Rect | null = null,
    /** Produit aussi la fenetre de recherche en pleine resolution (calibration). */
    wantFullSearch = false,
  ): Promise<CaptureOutcome> {
    const started = Date.now();
    const timings: CaptureTimings = { grabMs: 0, locateMs: 0, preprocessMs: 0, totalMs: 0 };
    const finish = <T extends { ok: boolean }>(result: T): T => {
      timings.totalMs = Date.now() - started;
      return result;
    };

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);

    // --- Chemin nominal : capture par region ---
    //
    // Ne lire que la fenetre de recherche plutot qu'un ecran entier est le seul
    // levier qui agisse a la fois sur la latence et sur les saccades du jeu :
    // 8 ms au lieu de 197, et aucune duplication d'ecran permanente qui forcerait
    // le DWM a recomposer Tarkov image par image.
    //
    // Deux cas en sont exclus. La calibration a besoin de l'image entiere, par
    // definition. Le mode manuel definit sa propre zone, que l'appelant peut
    // avoir placee n'importe ou.
    if (settings.captureMode === 'auto' && !wantFullSearch) {
      const viaRegion = await this.captureViaRegion(
        settings,
        display,
        cursor,
        wantPreview,
        excludeDip,
        timings,
      );
      if (viaRegion) return finish(viaRegion);
    }

    const grabStarted = Date.now();
    // Chemin rapide : image tiree du flux persistant (~15 ms au lieu de ~230).
    // Desactive, on ne le sollicite pas du tout : c'est precisement son existence
    // permanente qui coute des FPS au jeu.
    let frame = settings.useCaptureStream ? await this.frames.grab() : null;
    if (!frame) {
      frame = await this.grabSlow(display);
      if (!frame) {
        return finish({
          ok: false,
          reason: "aucune source d'ecran exploitable",
          timings,
          previewPng: null,
          searchFull: null,
        });
      }
      // Le flux n'a pas repondu : on tente de le (re)monter pour la prochaine
      // fois — sauf s'il est desactive, auquel cas ce chemin est le nominal.
      if (settings.useCaptureStream) void this.frames.start();
    }
    timings.grabMs = Date.now() - grabStarted;

    const fullscreen = frame.image;
    const size = fullscreen.getSize();
    const { scaleX, scaleY } = frame;

    // Curseur en pixels image, dans le repere de l'ecran courant.
    const cursorX = (cursor.x - display.bounds.x) * scaleX;
    const cursorY = (cursor.y - display.bounds.y) * scaleY;

    // Bounds de la carte, ramenes dans le meme repere.
    const excludePhysical: Rect | null = excludeDip
      ? {
          x: (excludeDip.x - display.bounds.x) * scaleX,
          y: (excludeDip.y - display.bounds.y) * scaleY,
          width: excludeDip.width * scaleX,
          height: excludeDip.height * scaleY,
        }
      : null;

    const locateStarted = Date.now();
    const framed =
      settings.captureMode === 'manual'
        ? this.frameManually(settings.captureRegion, cursorX, cursorY, scaleX, scaleY, size)
        : this.frameAutomatically(fullscreen, cursorX, cursorY, size, wantPreview, excludePhysical);
    timings.locateMs = Date.now() - locateStarted;

    // Capture de calibration : la fenetre de recherche telle quelle, plus la
    // position du curseur dans son repere. C'est le materiau qui permet de
    // mesurer le pas de la grille et de comparer une case reelle a l'icone du
    // catalogue, au lieu de les supposer.
    let searchFull: { png: Buffer; cursorX: number; cursorY: number; sizeScale: number } | null = null;
    if (wantFullSearch && framed.ok) {
      try {
        // L'image **entiere**, pas la fenetre de recherche.
        //
        // La detection du pas de grille est une autocorrelation : elle a besoin
        // de plusieurs periodes pour trancher. Mesure sur echantillons reels, la
        // fenetre de recherche (~534 px de haut pour un pas cherche jusqu'a 174)
        // n'en contient que trois — le detecteur echouait 18 fois sur 20. Le
        // plein ecran en offre plus de dix.
        searchFull = {
          png: fullscreen.toPNG(),
          cursorX: Math.round(cursorX),
          cursorY: Math.round(cursorY),
          sizeScale: size.height / 1080,
        };
      } catch {
        /* la calibration est un confort : son echec ne doit rien interrompre */
      }
    }

    if (!framed.ok) return finish({ ...framed, timings, searchFull: null });

    const preprocessStarted = Date.now();
    const processed = preprocessForOcr(fullscreen.crop(framed.rect), size.height / 1080);
    timings.preprocessMs = Date.now() - preprocessStarted;

    if (!processed) {
      return finish({
        ok: false,
        reason: 'zone trop petite ou illisible apres pretraitement',
        timings,
        previewPng: framed.previewPng,
        searchFull,
      });
    }

    return finish({
      ok: true,
      ...processed,
      rect: framed.rect,
      // Repere logique global : c'est ce qu'attend le positionnement de fenetre.
      rectDip: {
        x: Math.round(display.bounds.x + framed.rect.x / scaleX),
        y: Math.round(display.bounds.y + framed.rect.y / scaleY),
        width: Math.round(framed.rect.width / scaleX),
        height: Math.round(framed.rect.height / scaleY),
      },
      locate: framed.locate,
      previewPng: framed.previewPng,
      searchFull,
      timings,
    });
  }

  /**
   * Capture par region : seule la fenetre de recherche est lue.
   *
   * @returns le resultat complet, ou `null` pour signaler a l'appelant de
   *          reprendre le chemin Electron — helper indisponible, configuration
   *          d'ecrans non geree, ou capture refusee.
   */
  private async captureViaRegion(
    settings: CaptureSettings,
    display: Electron.Display,
    cursor: { x: number; y: number },
    wantPreview: boolean,
    excludeDip: Rect | null,
    timings: CaptureTimings,
  ): Promise<CaptureOutcome | null> {
    const scale = display.scaleFactor || 1;

    if (process.platform !== 'win32') return null;

    // Le helper travaille en pixels physiques du bureau virtuel ; Electron
    // raisonne en pixels logiques avec un facteur propre a chaque ecran. Les
    // deux reperes ne se deduisent pas l'un de l'autre par une multiplication
    // des que les facteurs different, et Electron n'expose pas l'origine
    // physique de ses ecrans. On la demande donc au systeme.
    const origin = await this.physicalOriginOf(display);
    if (!origin) return null;

    // --- Echelle de travail ---
    //
    // Capturer en pixels natifs est un piege sur un ecran HiDPI : en 4K, la
    // fenetre de recherche fait 1490x340 px, soit 2,5 fois la surface d'un
    // ecran 1080p. Tout le pipeline paie ce facteur — mesure en jeu apres le
    // passage au natif : cadrage remonte de 15 a 56 ms, capture a 72 ms, pour
    // ~90 ms de processus principal par cycle. Toutes les 120 ms, cela saccade.
    //
    // Or la resolution supplementaire ne sert a rien : le pretraitement
    // ré-agrandit le texte pour viser la taille ou Tesseract est le meilleur.
    // On travaille donc a une echelle fixe, proche du 1080p, quelle que soit la
    // definition de l'ecran — et c'est GDI qui reduit, pendant la copie.
    const nativeHeight = Math.round(display.bounds.height * scale);
    const captureScale = Math.min(1, TARGET_SIZE_SCALE / (nativeHeight / 1080));

    // A partir d'ici, tout est exprime dans ce repere reduit : curseur, fenetre
    // de recherche, rectangle trouve. Seule la requete au helper repasse en
    // pixels natifs, puisque c'est le repere de l'ecran.
    const workScale = scale * captureScale;
    const size = {
      width: Math.round(display.bounds.width * workScale),
      height: Math.round(display.bounds.height * workScale),
    };
    const sizeScale = size.height / 1080;

    const cursorX = (cursor.x - display.bounds.x) * workScale;
    const cursorY = (cursor.y - display.bounds.y) * workScale;

    const search = computeSearchRect(cursorX, cursorY, size, sizeScale);
    if (!search) return null;

    const grabStarted = Date.now();
    const frame = await this.regions.capture(
      origin.x + Math.round(search.x / captureScale),
      origin.y + Math.round(search.y / captureScale),
      Math.round(search.width / captureScale),
      Math.round(search.height / captureScale),
      search.width,
      search.height,
    );
    timings.grabMs = Date.now() - grabStarted;
    if (!frame) return null;

    const window = nativeImage.createFromBitmap(frame.data, {
      width: frame.width,
      height: frame.height,
    });

    const excludePhysical: Rect | null = excludeDip
      ? {
          x: (excludeDip.x - display.bounds.x) * workScale,
          y: (excludeDip.y - display.bounds.y) * workScale,
          width: excludeDip.width * workScale,
          height: excludeDip.height * workScale,
        }
      : null;

    const locateStarted = Date.now();
    const framed = locateWithin(
      window,
      search,
      cursorX,
      cursorY,
      size,
      sizeScale,
      wantPreview,
      excludePhysical,
    );
    timings.locateMs = Date.now() - locateStarted;

    if (!framed.ok) {
      // Echec de cadrage en mode debug : la fenetre de recherche est ecrite sur
      // disque, en pleine resolution.
      //
      // L'apercu du panneau debug est reduit a 640 px et encode en base64 : bon
      // pour l'oeil, inutilisable pour rejouer le localisateur dessus. Or les
      // echecs restants sont **intermittents** — meme objet, meme position,
      // detecte une fois sur cent — et une scene synthetique ne les reproduit
      // pas. Sans les pixels exacts qui echouent, chaque correctif est une
      // hypothese de plus.
      if (settings.debugMode) this.dumpFailure(window, framed.search);
      return { ok: false, reason: framed.reason, timings, previewPng: framed.previewPng };
    }

    // `framed.rect` est dans le repere de l'ecran ; la fenetre capturee commence
    // en `search`. Le recadrage se fait donc en coordonnees locales.
    const preprocessStarted = Date.now();
    const processed = preprocessForOcr(
      window.crop({
        x: framed.rect.x - search.x,
        y: framed.rect.y - search.y,
        width: framed.rect.width,
        height: framed.rect.height,
      }),
      sizeScale,
    );
    timings.preprocessMs = Date.now() - preprocessStarted;

    if (!processed) {
      return {
        ok: false,
        reason: 'zone trop petite ou illisible apres pretraitement',
        timings,
        previewPng: framed.previewPng,
      };
    }

    return {
      ok: true,
      ...processed,
      rect: framed.rect,
      rectDip: {
        x: Math.round(display.bounds.x + framed.rect.x / workScale),
        y: Math.round(display.bounds.y + framed.rect.y / workScale),
        width: Math.round(framed.rect.width / workScale),
        height: Math.round(framed.rect.height / workScale),
      },
      locate: framed.locate,
      previewPng: framed.previewPng,
      searchFull: null,
      timings,
    };
  }

  /**
   * Ecrit sur disque la fenetre de recherche d'un cadrage rate.
   *
   * Ces fichiers sont le materiau qui manque pour traiter les echecs
   * intermittents : ils permettent de rejouer le localisateur sur les pixels
   * exacts qui ont echoue, au lieu de raisonner sur une scene synthetique qui,
   * par construction, ne reproduit que les cas deja compris.
   *
   * Plafonne a `MAX_FAILURE_DUMPS` fichiers par session : le but est d'obtenir
   * quelques echantillons representatifs, pas de remplir le disque pendant qu'un
   * joueur balaie son stash.
   */
  private dumpFailure(window: NativeImage, search: Rect | null): void {
    if (this.failureDumps >= MAX_FAILURE_DUMPS) return;
    try {
      const dir = path.join(this.userDataPath, 'debug');
      mkdirSync(dir, { recursive: true });
      const name = `echec-${Date.now()}.png`;
      writeFileSync(path.join(dir, name), window.toPNG());
      this.failureDumps++;
      log.info(
        `cadrage rate : fenetre de recherche ecrite dans ${path.join(dir, name)}` +
          `${search ? ` (${search.width}x${search.height})` : ''}`,
      );
    } catch {
      /* le diagnostic est un confort : son echec ne doit rien interrompre */
    }
  }

  /**
   * Coin superieur gauche d'un ecran Electron, en pixels physiques du bureau
   * virtuel — le repere du helper.
   *
   * Windows et Electron enumerent les ecrans dans le meme ordre spatial, mais
   * n'exposent aucun identifiant commun. On apparie donc les deux listes triees
   * par position, puis on **verifie chaque paire** : la taille physique attendue
   * cote Electron (`bounds x scaleFactor`) doit correspondre a celle rapportee
   * par Windows. Un desaccord, meme sur un seul ecran, invalide tout
   * l'appariement et fait repasser par la capture Electron — capturer un
   * rectangle decale serait pire que capturer lentement.
   *
   * @returns `null` si la configuration ne peut pas etre appariee de facon sure.
   */
  private async physicalOriginOf(display: Electron.Display): Promise<{ x: number; y: number } | null> {
    const monitors = await this.regions.monitors();
    if (!monitors) return null;

    const displays = screen.getAllDisplays();
    if (displays.length !== monitors.length) return null;

    const byPosition = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      a.x - b.x || a.y - b.y;
    const sortedDisplays = [...displays].sort((a, b) => byPosition(a.bounds, b.bounds));
    const sortedMonitors = [...monitors].sort(byPosition);

    for (let i = 0; i < sortedDisplays.length; i++) {
      const candidate = sortedDisplays[i]!;
      const monitor = sortedMonitors[i]!;
      const factor = candidate.scaleFactor || 1;
      // Tolerance de 2 px : `bounds` logiques et facteur d'echelle sont tous deux
      // arrondis, et leur produit peut manquer la taille physique d'un pixel.
      if (Math.abs(monitor.width - candidate.bounds.width * factor) > 2) return null;
      if (Math.abs(monitor.height - candidate.bounds.height * factor) > 2) return null;
    }

    const index = sortedDisplays.findIndex((candidate) => candidate.id === display.id);
    if (index < 0) return null;
    const monitor = sortedMonitors[index]!;
    return { x: monitor.x, y: monitor.y };
  }

  /**
   * Chemin de repli : `desktopCapturer`, ~230 ms dont 168 ms d'enumeration.
   * Utilise uniquement si le flux persistant n'est pas disponible.
   */
  private async grabSlow(display: Electron.Display): Promise<Frame | null> {
    const scale = display.scaleFactor || 1;
    const nativeWidth = Math.round(display.bounds.width * scale);
    // Plafonnee : au-dela, le cout grimpe sans gain de lisibilite.
    const width = Math.min(nativeWidth, FALLBACK_MAX_WIDTH);
    const height = Math.round((width / nativeWidth) * display.bounds.height * scale);

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      });
      // `display_id` relie une source a un ecran. En cas d'absence (certains
      // pilotes), on retombe sur la premiere source disponible.
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (!source || source.thumbnail.isEmpty()) return null;

      const size = source.thumbnail.getSize();
      return {
        image: source.thumbnail,
        scaleX: size.width / display.bounds.width,
        scaleY: size.height / display.bounds.height,
      };
    } catch (err) {
      log.error("capture d'ecran impossible", err);
      return null;
    }
  }

  /** Mode manuel : rectangle fixe relatif au curseur. */
  private frameManually(
    region: CaptureRegion,
    cursorX: number,
    cursorY: number,
    scaleX: number,
    scaleY: number,
    size: { width: number; height: number },
  ): FrameResult {
    const rect = clampRect(
      {
        x: Math.round(cursorX + region.offsetX * scaleX),
        y: Math.round(cursorY + region.offsetY * scaleY),
        width: Math.round(region.width * scaleX),
        height: Math.round(region.height * scaleY),
      },
      size.width,
      size.height,
    );
    if (!rect) return { ok: false, reason: 'zone manuelle entierement hors ecran', previewPng: null, search: null };
    // Mode manuel : aucune fenetre de recherche n'est balayee.
    return { ok: true, rect, locate: null, previewPng: null, search: null };
  }

  /** Mode auto : fenetre de recherche large, puis localisation de l'infobulle. */
  private frameAutomatically(
    fullscreen: NativeImage,
    cursorX: number,
    cursorY: number,
    size: { width: number; height: number },
    wantPreview: boolean,
    excludePhysical: Rect | null,
  ): FrameResult {
    // Les seuils de TooltipLocator sont exprimes a 1080p : ce facteur les porte
    // a la resolution reelle, y compris en 1440p et 4K.
    const sizeScale = size.height / 1080;

    const search = computeSearchRect(cursorX, cursorY, size, sizeScale);
    if (!search) return { ok: false, reason: 'fenetre de recherche hors ecran', previewPng: null, search: null };

    return locateWithin(
      fullscreen.crop(search),
      search,
      cursorX,
      cursorY,
      size,
      sizeScale,
      wantPreview,
      excludePhysical,
    );
  }
}

/**
 * Rectangle a analyser autour du curseur, en pixels physiques de l'ecran.
 *
 * Extrait de `frameAutomatically` parce que le chemin de capture par region a
 * besoin de connaitre cette zone **avant** de capturer : c'est tout l'interet du
 * procede — ne lire que ces pixels-la, au lieu d'une image plein ecran dont on
 * jette 95 %.
 */
function computeSearchRect(
  cursorX: number,
  cursorY: number,
  size: { width: number; height: number },
  sizeScale: number,
): Rect | null {
  // Fenetre **asymetrique**, calee sur la geometrie reelle de l'infobulle.
  //
  // Mesure sur dix detections en jeu : l'infobulle est ancree au curseur avec un
  // decalage horizontal de -53 a +36 px, et se trouve **toujours au-dessus** de
  // lui (bord haut entre 36 et 68 px plus haut). Elle se deploie ensuite vers la
  // droite, sauf pres du bord droit de l'ecran ou Tarkov la bascule a gauche
  // faute de place.
  //
  // L'ancienne fenetre symetrique de 850x200 explorait presque tout l'ecran pour
  // un objet tenant dans une bande de 160 px : environ cinq fois plus de surface
  // a capturer, sous-echantillonner, seuiller et etiqueter a chaque cycle.
  const forward = SEARCH_FORWARD * sizeScale;
  const backward = SEARCH_BACKWARD * sizeScale;

  // Pres du bord droit, on couvre les **deux** cotes.
  //
  // Tarkov ne bascule l'infobulle a gauche que si elle deborde reellement, ce qui
  // depend de la longueur du nom — inconnue avant de l'avoir lue. Deduire le cote
  // de la seule place restante etait donc un pari, et il etait perdant : avec le
  // curseur a 1900 px sur 2560, il restait 660 px, assez pour une infobulle qui
  // s'est deployee a droite pendant que la fenetre ne couvrait que 120 px de ce
  // cote. Elle a ete tranchee en deux, et le fragment « FN Five-s / magazine » a
  // matche un autre objet a 0,78.
  //
  // A droite on va donc jusqu'au bord de l'ecran ; a gauche on n'ajoute la
  // largeur complete que s'il n'y avait pas la place a droite. Le seul cas ou la
  // fenetre s'elargit est celui, rare, du bord d'ecran.
  const roomRight = size.width - cursorX;
  const rightExtent = Math.min(forward, roomRight);
  const leftExtent = roomRight < forward ? forward : backward;

  return clampRect(
    {
      x: Math.round(cursorX - leftExtent),
      y: Math.round(cursorY - SEARCH_ABOVE * sizeScale),
      width: Math.round(leftExtent + rightExtent),
      height: Math.round((SEARCH_ABOVE + SEARCH_BELOW) * sizeScale),
    },
    size.width,
    size.height,
  );
}

/**
 * Localise l'infobulle dans une fenetre de recherche deja isolee, et ramene le
 * rectangle trouve dans le repere de l'ecran.
 *
 * `window` est la fenetre de recherche elle-meme — pas l'image plein ecran. Les
 * deux chemins de capture y arrivent differemment : par recadrage pour la
 * capture Electron, directement pour la capture par region.
 */
function locateWithin(
  window: NativeImage,
  search: Rect,
  cursorX: number,
  cursorY: number,
  size: { width: number; height: number },
  sizeScale: number,
  wantPreview: boolean,
  excludePhysical: Rect | null,
): FrameResult {
  {
    const previewPng = wantPreview ? shrinkToPng(window) : null;

    const located = locateTooltip(window.toBitmap(), search.width, search.height, {
      // Coordonnees du curseur ramenees dans le repere de la fenetre de recherche.
      cursorX: cursorX - search.x,
      cursorY: cursorY - search.y,
      sizeScale,
      excludeRect: excludePhysical
        ? {
            // Marge de 4 px : le liseré de la carte ne doit pas depasser de la zone exclue.
            x: excludePhysical.x - search.x - 4,
            y: excludePhysical.y - search.y - 4,
            width: excludePhysical.width + 8,
            height: excludePhysical.height + 8,
          }
        : null,
    });

    if (!located) {
      return {
        ok: false,
        reason: "aucune infobulle detectee autour du curseur (l'infobulle etait-elle affichee ?)",
        previewPng,
        search,
      };
    }

    // Retour au repere ecran.
    const rect = clampRect(
      {
        x: search.x + located.rect.x,
        y: search.y + located.rect.y,
        width: located.rect.width,
        height: located.rect.height,
      },
      size.width,
      size.height,
    );
    if (!rect) return { ok: false, reason: 'rectangle detecte invalide', previewPng, search };

    return { ok: true, rect, locate: located, previewPng, search };
  }
}

type FrameResult =
  | {
      ok: true;
      rect: Rect;
      locate: LocateResult | null;
      previewPng: Buffer | null;
      /** Fenetre de recherche balayee. Absente en mode manuel. */
      search: Rect | null;
    }
  | { ok: false; reason: string; previewPng: Buffer | null; search: Rect | null };

/** Reduit une image pour l'apercu de debug et l'encode en PNG. */
function shrinkToPng(image: NativeImage): Buffer | null {
  try {
    const { width } = image.getSize();
    const target = Math.min(PREVIEW_MAX_WIDTH, width);
    return image.resize({ width: target, quality: 'good' }).toPNG();
  } catch {
    // L'apercu est un confort de debug : son echec ne doit rien interrompre.
    return null;
  }
}

/**
 * Ramene un rectangle dans les limites de l'image.
 * Renvoie `null` si la zone est entierement hors ecran (curseur en bordure).
 */
function clampRect(rect: Rect, maxWidth: number, maxHeight: number): Rect | null {
  const x = Math.max(0, Math.min(rect.x, maxWidth - 1));
  const y = Math.max(0, Math.min(rect.y, maxHeight - 1));
  const width = Math.min(rect.width, maxWidth - x);
  const height = Math.min(rect.height, maxHeight - y);
  if (width < 10 || height < 6) return null;
  return { x, y, width, height };
}

export interface PreprocessedImage {
  /** Image PNG prete pour Tesseract. */
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Niveaux de gris -> agrandissement bilineaire -> normalisation Otsu ->
 * inversion conditionnelle. Travaille directement sur le tampon BGRA.
 *
 * Exporte pour que l'auto-test OCR (`npm run test:ocr`) applique exactement le
 * meme traitement que la capture reelle : un test qui divergerait du chemin de
 * production ne prouverait rien.
 */
export function preprocessForOcr(source: NativeImage, sizeScale = 1): PreprocessedImage | null {
  const { width: srcW, height: srcH } = source.getSize();
  if (srcW < 2 || srcH < 2) return null;

  // --- 0. Facteur d'agrandissement, deduit de la taille reelle du texte ---
  //
  // Tesseract est le plus fiable autour de 30 px de hauteur de caractere. Le
  // texte d'infobulle fait ~14 px a 1080p, donc ~14 * sizeScale px dans l'image
  // recue. Un facteur fixe de 2 convenait tant que la capture etait ramenee a
  // 2048 px de large ; la capture par region livre desormais les pixels
  // **natifs**, ou le texte fait deja ~28 px en 4K. L'agrandir encore
  // quadruplerait le travail de l'OCR pour degrader le resultat.
  const upscale = Math.max(1, Math.min(3, Math.round(TARGET_TEXT_HEIGHT / (TOOLTIP_TEXT_AT_1080P * sizeScale))));

  const bgra = source.toBitmap();
  if (bgra.length < srcW * srcH * 4) return null;

  // --- 1. Niveaux de gris (luminance perceptuelle Rec. 601) ---
  const gray = new Uint8Array(srcW * srcH);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // Ordre BGRA : bleu, vert, rouge, alpha.
    gray[i] = (bgra[p + 2]! * 299 + bgra[p + 1]! * 587 + bgra[p]! * 114) / 1000;
  }

  // --- 2. Agrandissement bilineaire ---
  const dstW = srcW * upscale;
  const dstH = srcH * upscale;
  const scaled = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = (y + 0.5) / upscale - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = (x + 0.5) / upscale - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;
      const top = gray[y0 * srcW + x0]! * (1 - fx) + gray[y0 * srcW + x1]! * fx;
      const bottom = gray[y1 * srcW + x0]! * (1 - fx) + gray[y1 * srcW + x1]! * fx;
      scaled[y * dstW + x] = top * (1 - fy) + bottom * fy;
    }
  }

  // --- 3. Separation texte / fond par la methode d'Otsu ---
  //
  // Un simple etirement de contraste sur percentiles ne convient pas ici : le
  // texte represente typiquement 2 a 4 % des pixels d'une infobulle, donc meme
  // un 95e percentile tombe encore dans le fond. L'etirement amplifie alors les
  // variations du fond et ecrase le texte — teste, verifie, le resultat etait
  // une image ou le texte disparaissait completement.
  //
  // Otsu cherche le seuil qui maximise la variance inter-classes, c'est-a-dire
  // exactement la frontiere texte / fond, quelle que soit leur proportion.
  const histogram = new Uint32Array(256);
  for (const value of scaled) histogram[value]!++;
  const otsu = otsuSplit(histogram, scaled.length);

  // On normalise sur les *moyennes de classe* plutot que sur les extremes :
  // le fond devient uniformement 0 et le texte 255, sans qu'un pixel isole
  // (curseur, icone, lisere) ne fausse l'echelle. L'anticrenelage est preserve.
  const separation = otsu.brightMean - otsu.darkMean;
  const usable = separation >= MIN_CLASS_SEPARATION;
  const low = usable ? otsu.darkMean : 0;
  const span = usable ? separation : 255;

  // --- 4. Polarite ---
  // Le texte est toujours la classe minoritaire. S'il s'agit de la classe
  // claire (cas de l'infobulle Tarkov : texte creme sur fond sombre), on
  // inverse pour retrouver du texte sombre sur fond clair, attendu par Tesseract.
  const invert = otsu.brightCount < otsu.darkCount;

  const out = Buffer.allocUnsafe(dstW * dstH * 4);
  for (let i = 0, p = 0; i < scaled.length; i++, p += 4) {
    let value = ((scaled[i]! - low) / span) * 255;
    value = value < 0 ? 0 : value > 255 ? 255 : value;
    if (invert) value = 255 - value;
    out[p] = value;
    out[p + 1] = value;
    out[p + 2] = value;
    out[p + 3] = 255;
  }

  return {
    png: nativeImage.createFromBitmap(out, { width: dstW, height: dstH }).toPNG(),
    width: dstW,
    height: dstH,
  };
}

interface OtsuSplit {
  threshold: number;
  darkMean: number;
  brightMean: number;
  darkCount: number;
  brightCount: number;
}

/**
 * Seuillage d'Otsu : parcourt les 256 seuils possibles et retient celui qui
 * maximise la variance inter-classes. Implementation incrementale en O(256).
 */
function otsuSplit(histogram: Uint32Array, total: number): OtsuSplit {
  let weightedTotal = 0;
  for (let value = 0; value < 256; value++) weightedTotal += value * histogram[value]!;

  let darkCount = 0;
  let darkWeighted = 0;
  let bestVariance = -1;
  let best: OtsuSplit = { threshold: 128, darkMean: 0, brightMean: 255, darkCount: total, brightCount: 0 };

  for (let threshold = 0; threshold < 256; threshold++) {
    darkCount += histogram[threshold]!;
    if (darkCount === 0) continue;
    const brightCount = total - darkCount;
    if (brightCount === 0) break;

    darkWeighted += threshold * histogram[threshold]!;
    const darkMean = darkWeighted / darkCount;
    const brightMean = (weightedTotal - darkWeighted) / brightCount;

    const variance = darkCount * brightCount * (darkMean - brightMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = { threshold, darkMean, brightMean, darkCount, brightCount };
    }
  }

  return best;
}
