/**
 * services/RegionGrabber.ts
 * -------------------------
 * Capture d'ecran **par region**, via un helper GDI persistant.
 *
 * Le probleme resolu
 * ------------------
 * Electron ne sait capturer que des ecrans entiers. Les deux voies disponibles
 * paient donc le prix d'une image plein ecran alors qu'on ne lit jamais plus que
 * ~900x220 px autour du curseur :
 *
 *   desktopCapturer.getSources      ~197 ms  (dont 168 ms d'enumeration)
 *   flux getUserMedia persistant     ~40 ms  mais **cout permanent** : le DWM
 *                                            recompose le jeu en continu, ce qui
 *                                            se voit directement sur les FPS
 *
 * Mesure du helper sur la meme machine, region 900x220 : **mediane 8,3 ms**,
 * p90 10,2 ms, sans flux permanent ni duplication d'ecran. La meme mesure sur
 * 1920x1080 donne 148 ms : le cout suit la surface, ce qui est precisement la
 * propriete que les APIs Electron n'offrent pas.
 *
 * Pourquoi un processus separe et non un module natif
 * ---------------------------------------------------
 * `csc.exe` est livre avec le .NET Framework, present sur toute installation de
 * Windows depuis la 8. Le projet garde ainsi sa propriete « aucune dependance
 * native a compiler » : ni CMake, ni Visual Studio Build Tools, ni node-gyp, ni
 * `.node` a reconstruire a chaque version d'Electron. Cout : ~7 Mo de memoire
 * residente pour le helper.
 *
 * Le processus est lance **une fois** et vit tant que la detection tourne : on
 * ne paie jamais le demarrage d'un processus par capture.
 *
 * Defaillance : `fail-soft`. Toute erreur — helper absent, compilation
 * impossible, plantage, delai depasse — fait renvoyer `null`, et l'appelant
 * retombe sur la capture Electron. Le mecanisme n'est jamais un point de panne.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from './Logger';

const log = createLogger('region');

/**
 * Delai au-dela duquel une capture est consideree perdue.
 *
 * Une capture normale prend moins de 15 ms. Un helper qui ne repond pas en
 * 1,5 s est bloque, pas lent : on le tue et on repasse en capture Electron
 * plutot que de figer la boucle de detection.
 */
const CAPTURE_TIMEOUT_MS = 1500;

/**
 * Nombre de redemarrages tolerés avant abandon definitif.
 *
 * Sans ce plafond, un helper qui plante a chaque appel serait relance
 * indefiniment — chaque redemarrage coutant plus cher que la capture Electron
 * qu'il est cense remplacer.
 */
const MAX_RESTARTS = 3;

export interface RegionFrame {
  /** Pixels BGRA, lignes du haut vers le bas, sans remplissage de fin de ligne. */
  data: Buffer;
  width: number;
  height: number;
}

interface PendingRequest {
  resolve: (frame: Buffer | null) => void;
  /** Taille attendue du payload, ou `-1` pour une reponse de taille libre. */
  expectedBytes: number;
  timer: NodeJS.Timeout;
}

/** Un moniteur tel que Windows le voit, en pixels physiques du bureau virtuel. */
export interface PhysicalMonitor {
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export class RegionGrabber {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queue: PendingRequest[] = [];
  private restarts = 0;
  /** Passe a vrai apres un echec definitif : on ne retente plus a chaque frame. */
  private unavailable = false;
  private executable: string | null = null;
  private cachedMonitors: PhysicalMonitor[] | null = null;

  constructor(private readonly userDataPath: string) {}

  get isReady(): boolean {
    return this.child !== null && !this.unavailable;
  }

  /**
   * Lit un rectangle de l'ecran **virtuel**, en pixels physiques.
   *
   * Les coordonnees peuvent etre negatives sur une configuration multi-ecrans
   * dont le moniteur principal n'est pas le plus a gauche : c'est le repere
   * natif de `GetDC(NULL)`, et l'appelant y travaille deja.
   *
   * @returns l'image, ou `null` si le helper est indisponible — l'appelant doit
   *          alors utiliser la capture Electron.
   */
  async capture(
    x: number,
    y: number,
    width: number,
    height: number,
    /**
     * Taille voulue en sortie. Par defaut, la taille source.
     *
     * Reduire ici plutot que cote Node divise d'un coup le cout de tous les
     * postes en aval — transfert, remplissage de l'alpha, construction de
     * l'image, sous-echantillonnage du localisateur.
     */
    outWidth = width,
    outHeight = height,
  ): Promise<RegionFrame | null> {
    if (width <= 0 || height <= 0 || outWidth <= 0 || outHeight <= 0) return null;

    const w = Math.round(width);
    const h = Math.round(height);
    const dw = Math.min(w, Math.round(outWidth));
    const dh = Math.min(h, Math.round(outHeight));

    const data = await this.request(
      `${Math.round(x)} ${Math.round(y)} ${w} ${h} ${dw} ${dh}`,
      dw * dh * 4,
    );
    if (!data) return null;
    return { data, width: dw, height: dh };
  }

  /**
   * Geometrie physique des moniteurs, telle que Windows la rapporte.
   *
   * Mise en cache : la disposition des ecrans ne change qu'a un evenement
   * systeme, et l'appelant invalide alors le cache via `forgetMonitors()`.
   */
  async monitors(): Promise<PhysicalMonitor[] | null> {
    if (this.cachedMonitors) return this.cachedMonitors;

    const payload = await this.request('info', -1);
    if (!payload) return null;

    const parsed: PhysicalMonitor[] = [];
    for (const line of payload.toString('utf8').split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 5) continue;
      const numbers = parts.map((part) => Number(part));
      if (numbers.some((value) => !Number.isFinite(value))) continue;
      const [x, y, width, height, primary] = numbers as [number, number, number, number, number];
      if (width <= 0 || height <= 0) continue;
      parsed.push({ x, y, width, height, primary: primary === 1 });
    }

    if (parsed.length === 0) return null;
    this.cachedMonitors = parsed;
    return parsed;
  }

  /** Oublie la geometrie memorisee. A appeler sur changement d'affichage. */
  forgetMonitors(): void {
    this.cachedMonitors = null;
  }

  /** Envoie une requete et attend sa reponse, ou `null` en cas d'echec. */
  private async request(command: string, expectedBytes: number): Promise<Buffer | null> {
    if (this.unavailable) return null;
    if (!this.child && !this.start()) return null;

    const child = this.child;
    if (!child) return null;

    return new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => {
        // La reponse ne viendra plus : la file est desynchronisee, tout octet
        // recu ensuite serait attribue a la mauvaise requete.
        log.warn(`helper muet apres ${CAPTURE_TIMEOUT_MS} ms, redemarrage`);
        this.kill();
        resolve(null);
      }, CAPTURE_TIMEOUT_MS);

      this.queue.push({ resolve, expectedBytes, timer });
      try {
        child.stdin.write(`${command}\n`);
      } catch (err) {
        log.warn('ecriture vers le helper impossible', err);
        clearTimeout(timer);
        this.queue.pop();
        this.kill();
        resolve(null);
      }
    });
  }

  /** Arrete le helper. Le prochain `capture()` le relancera. */
  stop(): void {
    this.kill();
    this.restarts = 0;
  }

  // --- Cycle de vie du processus ---

  private start(): boolean {
    const executable = this.resolveExecutable();
    if (!executable) {
      this.unavailable = true;
      return false;
    }

    if (this.restarts > MAX_RESTARTS) {
      log.warn(`helper abandonne apres ${MAX_RESTARTS} redemarrages, repli sur la capture Electron`);
      this.unavailable = true;
      return false;
    }

    try {
      // `--no-captureblt` exclut les fenetres superposees de la copie. Le cout
      // est identique (mesure : 8,33 contre 8,42 ms), mais la carte de prix de
      // l'outil, elle, disparait de l'image : le detecteur ne peut plus relire
      // ses propres libelles.
      const child = spawn(executable, ['--no-captureblt'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
      child.stderr.on('data', (chunk: Buffer) => log.warn(`helper: ${chunk.toString().trim()}`));
      child.on('exit', (code) => {
        if (this.child === child) {
          log.warn(`helper termine (code ${code})`);
          this.child = null;
          this.failPending();
        }
      });
      child.on('error', (err) => {
        log.warn('helper injoignable', err);
        if (this.child === child) {
          this.child = null;
          this.failPending();
        }
      });

      this.child = child;
      this.buffer = Buffer.alloc(0);
      this.restarts++;
      log.info(`helper de capture par region actif (${path.basename(executable)})`);
      return true;
    } catch (err) {
      log.warn('lancement du helper impossible', err);
      this.unavailable = true;
      return false;
    }
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.failPending();
    if (child) {
      try {
        child.kill();
      } catch {
        // Le processus etait deja mort : rien a faire.
      }
    }
  }

  /**
   * Denoue toutes les requetes en attente.
   *
   * Indispensable a la mort du processus : sans cela, `capture()` resterait
   * suspendu jusqu'au delai de garde et la boucle de detection se figerait.
   */
  private failPending(): void {
    this.buffer = Buffer.alloc(0);
    while (this.queue.length > 0) {
      const pending = this.queue.shift()!;
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
  }

  /**
   * Assemble le flux d'octets en reponses.
   *
   * Le protocole est strictement sequentiel — une requete, une reponse — donc
   * l'ordre de la file suffit a associer chaque payload a son appelant.
   */
  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const pending = this.queue[0];
      if (!pending || this.buffer.length < 4) return;

      const length = this.buffer.readInt32LE(0);

      // Longueur nulle : le helper signale un echec de capture (DC invalide
      // apres un changement de resolution, region hors ecran).
      if (length === 0) {
        this.buffer = this.buffer.subarray(4);
        this.queue.shift();
        clearTimeout(pending.timer);
        pending.resolve(null);
        continue;
      }

      // Une longueur inattendue signifie que le flux est desynchronise. Le
      // reprendre en cours de route donnerait des images corrompues : mieux
      // vaut repartir d'un processus neuf. Les reponses de taille libre
      // (`expectedBytes` negatif) echappent a ce controle : `info` produit un
      // texte dont la longueur depend du nombre d'ecrans.
      if (length < 0 || (pending.expectedBytes >= 0 && length !== pending.expectedBytes)) {
        log.warn(`reponse de ${length} octets, ${pending.expectedBytes} attendus — flux desynchronise`);
        this.kill();
        return;
      }

      if (this.buffer.length < 4 + length) return;

      const payload = Buffer.from(this.buffer.subarray(4, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
      this.queue.shift();
      clearTimeout(pending.timer);
      pending.resolve(payload);
    }
  }

  // --- Localisation et compilation du helper ---

  /**
   * Trouve l'executable, en le compilant au besoin.
   *
   * Trois emplacements, dans l'ordre : la version empaquetee livree avec
   * l'application, celle produite par `npm run build`, puis une compilation a la
   * volee dans le dossier de donnees utilisateur. Le dernier cas couvre une
   * installation ou l'executable n'aurait pas ete livre.
   */
  private resolveExecutable(): string | null {
    if (this.executable) return this.executable;

    const candidates = [
      path.join(process.resourcesPath ?? '', 'native', 'RegionCapture.exe'),
      path.join(__dirname, '..', 'native', 'RegionCapture.exe'),
      path.join(this.userDataPath, 'native', 'RegionCapture.exe'),
    ];
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        this.executable = candidate;
        return candidate;
      }
    }

    const compiled = this.compile();
    if (compiled) this.executable = compiled;
    return compiled;
  }

  /** Compile le helper avec le `csc.exe` du .NET Framework livre avec Windows. */
  private compile(): string | null {
    if (process.platform !== 'win32') return null;

    const sources = [
      path.join(process.resourcesPath ?? '', 'native', 'RegionCapture.cs'),
      path.join(__dirname, '..', '..', 'native', 'RegionCapture.cs'),
    ];
    const source = sources.find((candidate) => candidate && existsSync(candidate));
    if (!source) {
      log.warn('source du helper introuvable, repli sur la capture Electron');
      return null;
    }

    const windir = process.env.WINDIR ?? 'C:\\Windows';
    const compiler = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!existsSync(compiler)) {
      log.warn('csc.exe introuvable, repli sur la capture Electron');
      return null;
    }

    const outputDir = path.join(this.userDataPath, 'native');
    const output = path.join(outputDir, 'RegionCapture.exe');
    try {
      mkdirSync(outputDir, { recursive: true });
      const result = spawnSync(
        compiler,
        ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`, source],
        { windowsHide: true, timeout: 60_000 },
      );
      if (result.status !== 0 || !existsSync(output)) {
        log.warn(`compilation du helper echouee: ${result.stderr?.toString().trim() ?? 'cause inconnue'}`);
        return null;
      }
      log.info(`helper compile dans ${output}`);
      return output;
    } catch (err) {
      log.warn('compilation du helper impossible', err);
      return null;
    }
  }
}
