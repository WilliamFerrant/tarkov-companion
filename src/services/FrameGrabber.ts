/**
 * services/FrameGrabber.ts
 * ------------------------
 * Capture d'ecran rapide, via un flux video persistant.
 *
 * Pourquoi ce detour
 * ------------------
 * `desktopCapturer.getSources()` coute ~230 ms par appel sur un ecran 1440p/1.5,
 * dont **168 ms de pure enumeration des sources** — mesure faite avec une
 * vignette 1x1, donc sans capturer le moindre pixel. Cette API reconstruit toute
 * la liste des ecrans a chaque appel : elle convient pour un selecteur de
 * source, pas pour une capture repetee.
 *
 * A la place, on ouvre **une seule fois** un flux `getUserMedia` de type
 * `desktop` dans une fenetre cachee, et on lit une image a la demande via
 * `capturePage()`. Mesure sur la meme machine : **52 ms au lieu de 228 ms**.
 *
 * Compromis assume
 * ----------------
 * Un flux permanent consomme du CPU en continu. Deux garde-fous :
 *   - la cadence est bridee (`FRAME_RATE`), on n'a besoin que d'une image
 *     lorsque le curseur s'immobilise, pas de 60 par seconde ;
 *   - le flux est arrete des que la detection l'est (overlay desactive, jeu au
 *     second plan) et relance a la demande.
 *
 * Defaillance : `fail-soft`. Si le flux ne demarre pas — pilote, permission,
 * changement d'ecran — `grab()` renvoie `null` et `ScreenCapture` retombe sur
 * `desktopCapturer`, plus lent mais toujours fonctionnel.
 */

import { BrowserWindow, desktopCapturer, screen, type NativeImage } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from './Logger';

const log = createLogger('frames');

/**
 * Cadence du flux, en images par seconde.
 *
 * Le flux tourne en continu tant que la detection est active : sa cadence est
 * donc un cout **permanent**, paye meme quand rien n'est survole. Sur un ecran
 * 4K, encoder et composer 2561x1440 quinze fois par seconde par-dessus un jeu
 * qui sature deja le GPU se voit directement sur les FPS — rapporte en jeu.
 *
 * Or on n'a jamais besoin que d'**une** image : celle du moment ou le curseur
 * s'immobilise. 5 img/s borne la peremption a ~200 ms, ce que le budget de
 * `MAX_LOCATE_ATTEMPTS_PER_SPOT` tentatives absorbe sans peine, pour un tiers du
 * cout continu.
 */
const FRAME_RATE = 5;

/** Delai maximal d'etablissement du flux avant abandon. */
const STREAM_TIMEOUT_MS = 6000;

/**
 * Largeur visee pour l'image capturee, en pixels.
 *
 * Capturer a la resolution physique d'un ecran HiDPI est du gaspillage pur :
 * en 4K, cela produit des images 3840x2160 dont le seul effet est de gonfler la
 * memoire et le GPU — et ce cout est **permanent**, paye a chaque image du flux,
 * meme quand rien n'est survole.
 *
 * La valeur est calibree sur la seule contrainte reelle : la taille du texte
 * recu par Tesseract, qui est au mieux vers 30 px. Mesure sur un ecran 4K, le
 * texte d'infobulle fait ~28 px en natif :
 *
 *   capture a 2560 -> ~19 px -> ~37 px apres l'agrandissement x2
 *   capture a 2048 -> ~15 px -> ~30 px          <- la cible
 *
 * Descendre de 2560 a 2048 place donc le texte **plus pres** de l'optimum de
 * Tesseract tout en retirant 36 % du debit de pixels du flux permanent.
 */
const TARGET_CAPTURE_WIDTH = 2048;

export interface Frame {
  image: NativeImage;
  /** Facteurs pixels-image / pixels-logiques, calcules sur l'image reelle. */
  scaleX: number;
  scaleY: number;
}

export class FrameGrabber {
  private window: BrowserWindow | null = null;
  private ready = false;
  private starting: Promise<boolean> | null = null;
  /** Passe a vrai apres un echec definitif : on ne retente plus a chaque frame. */
  private unavailable = false;
  private displayId: number | null = null;

  constructor(private readonly userDataPath: string) {}

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Demarre le flux pour l'ecran contenant le curseur.
   * Idempotent, et sans effet si un demarrage est deja en cours.
   */
  async start(): Promise<boolean> {
    if (this.ready) return true;
    if (this.unavailable) return false;
    if (this.starting) return this.starting;

    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    let sourceId: string;
    try {
      // Seul appel a `getSources` de tout le cycle de vie : on ne paie
      // l'enumeration qu'une fois.
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (!source) {
        log.warn("aucune source d'ecran, repli sur la capture lente");
        this.unavailable = true;
        return false;
      }
      sourceId = source.id;
    } catch (err) {
      log.warn('enumeration des sources impossible, repli sur la capture lente', err);
      this.unavailable = true;
      return false;
    }

    // `capturePage` rend `contentSize * scaleFactor` pixels. On dimensionne donc
    // la fenetre pour viser TARGET_CAPTURE_WIDTH pixels, et non la resolution
    // physique de l'ecran. La fenetre reste bornee par la zone de travail :
    // au-dela, Windows la rognerait. Les facteurs d'echelle sont de toute facon
    // recalcules sur l'image reellement obtenue.
    const scaleFactor = display.scaleFactor || 1;
    const targetWidth = Math.min(display.bounds.width, TARGET_CAPTURE_WIDTH);
    const ratio = targetWidth / display.bounds.width;
    const width = Math.min(
      Math.round((display.bounds.width * ratio) / scaleFactor),
      display.workArea.width,
    );
    const height = Math.min(
      Math.round((display.bounds.height * ratio) / scaleFactor),
      display.workArea.height,
    );

    const file = this.writeStreamPage(sourceId, targetWidth, Math.round(display.bounds.height * ratio));

    const window = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      useContentSize: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Sans cela, Chromium gele le rendu d'une fenetre cachee et l'image
        // capturee reste figee sur la derniere frame.
        backgroundThrottling: false,
      },
    });

    try {
      await window.loadURL(pathToFileURL(file).href);
      const ok = await this.waitForStream(window);
      if (!ok) {
        window.destroy();
        this.unavailable = true;
        return false;
      }
    } catch (err) {
      log.warn('chargement de la page de flux impossible', err);
      window.destroy();
      this.unavailable = true;
      return false;
    }

    this.window = window;
    this.displayId = display.id;
    this.ready = true;
    log.info(
      `flux de capture actif — fenetre ${width}x${height} logiques ` +
        `-> ~${Math.round(width * scaleFactor)}x${Math.round(height * scaleFactor)} pixels, ${FRAME_RATE} img/s`,
    );
    return true;
  }

  /** Page minimale : un `<video>` etire pour couvrir exactement l'ecran. */
  private writeStreamPage(sourceId: string, screenWidth: number, screenHeight: number): string {
    const dir = path.join(this.userDataPath, 'runtime');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'frame-source.html');

    // `object-fit: fill` garantit une correspondance lineaire entre coordonnees
    // ecran et coordonnees image, meme si la fenetre est plus petite que l'ecran.
    const html = `<!doctype html>
<html><body style="margin:0;overflow:hidden;background:#000">
<video id="v" autoplay muted playsinline
       style="width:100vw;height:100vh;object-fit:fill;display:block"></video>
<script>
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: ${JSON.stringify(sourceId)},
      maxWidth: ${screenWidth},
      maxHeight: ${screenHeight},
      maxFrameRate: ${FRAME_RATE}
    } }
  }).then(function (stream) {
    var v = document.getElementById('v');
    v.srcObject = stream;
    v.onplaying = function () { document.title = 'STREAM_OK'; };
  }).catch(function (e) {
    document.title = 'STREAM_FAIL:' + (e && e.name ? e.name : 'inconnu');
  });
</script></body></html>`;

    writeFileSync(file, html, 'utf8');
    return file;
  }

  /** Attend que la page signale l'etat du flux via son titre. */
  private async waitForStream(window: BrowserWindow): Promise<boolean> {
    const deadline = Date.now() + STREAM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (window.isDestroyed()) return false;
      const title = window.getTitle();
      if (title === 'STREAM_OK') return true;
      if (title.startsWith('STREAM_FAIL')) {
        log.warn(`flux refuse (${title}), repli sur la capture lente`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    log.warn(`flux non etabli apres ${STREAM_TIMEOUT_MS} ms, repli sur la capture lente`);
    return false;
  }

  /**
   * Lit une image du flux.
   * Renvoie `null` si le flux n'est pas disponible : l'appelant doit alors
   * utiliser la capture lente.
   */
  async grab(): Promise<Frame | null> {
    if (!this.ready || !this.window || this.window.isDestroyed()) return null;

    // Le curseur a change d'ecran : le flux pointe sur le mauvais moniteur.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (this.displayId !== null && display.id !== this.displayId) {
      log.info("changement d'ecran detecte, redemarrage du flux");
      this.restart();
      return null;
    }

    try {
      const image = await this.window.webContents.capturePage();
      const size = image.getSize();
      if (size.width < 2 || size.height < 2) return null;

      // Les facteurs sont deduits de l'image obtenue, jamais supposes : la
      // fenetre a pu etre rognee par la zone de travail.
      return {
        image,
        scaleX: size.width / display.bounds.width,
        scaleY: size.height / display.bounds.height,
      };
    } catch (err) {
      log.warn('lecture du flux impossible, redemarrage', err);
      this.restart();
      return null;
    }
  }

  /** Ferme le flux. Le prochain `start()` le reconstruira. */
  stop(): void {
    this.ready = false;
    this.displayId = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private restart(): void {
    this.stop();
    // `unavailable` n'est pas remis a vrai : un changement d'ecran est normal.
    void this.start();
  }
}
