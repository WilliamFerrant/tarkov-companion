/**
 * services/IconIndex.ts
 * ---------------------
 * Index des icones d'objets, pour identifier ce qui est survole **sans attendre
 * l'infobulle du jeu**.
 *
 * Ce que ca resout
 * ----------------
 * La lecture OCR de l'infobulle est plafonnee par Tarkov lui-meme : le jeu met
 * ~300 ms a la dessiner, et rien ne peut etre lu avant. L'icone, elle, est
 * affichee des que le curseur entre dans la case. Identifier l'objet par son
 * icone supprime donc ce plancher — c'est la raison pour laquelle les outils
 * injectes paraissent instantanes.
 *
 * Construction de l'index
 * -----------------------
 * Les icones viennent de tarkov.dev (`iconLink`), en WebP pour 5234 des 5312
 * objets. `nativeImage.createFromBuffer` ne decode pas le WebP — verifie — et la
 * variante `.jpg` du CDN est une vignette carree de 64x64 quelle que soit la
 * taille de l'objet : le rapport d'aspect y est perdu, elle ne peut donc pas
 * servir de reference pour une case rectangulaire lue a l'ecran.
 *
 * Le decodage passe donc par **Chromium**, qui lit le WebP nativement : les
 * octets sont telecharges cote main (aucune contrainte CORS), passes en data URL
 * a une fenetre cachee qui les decode et renvoie les pixels. L'empreinte, elle,
 * est calculee cote main par `IconHash`, la meme fonction que celle appliquee a
 * la capture d'ecran a l'execution — c'est cette unicite qui garantit que les
 * deux chemins produisent des empreintes comparables.
 *
 * L'operation est faite **une fois** puis mise en cache sur disque.
 *
 * Filtrage par taille de slot
 * ---------------------------
 * Comme RatScanner, on ne compare qu'aux objets de la meme taille de grille. Un
 * objet 1x1 ne peut pas etre confondu avec un fusil 5x2, et le nombre de
 * candidats s'effondre — ce qui reduit d'autant le risque de collision.
 */

import { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TarkovItem } from '../types/index';
import { computeHash, hammingDistance, hashToHex, hashFromHex } from './IconHash';
import { createLogger } from './Logger';

const log = createLogger('icons');

/**
 * Version du format de cache. Un increment invalide les caches precedents.
 * v2 : empreinte 24x24 sur trois canaux au lieu de 16x16 en niveaux de gris.
 * v3 : ajout de l'empreinte des octets bruts, pour reperer les icones partagees.
 */
const CACHE_VERSION = 3;

/**
 * Cote maximal auquel l'icone est decodee avant empreinte.
 *
 * L'empreinte reduit de toute facon a une grille 17x16 : decoder au-dela ne
 * change pas le resultat et ne ferait que gonfler les echanges avec la fenetre
 * de decodage. 96 px conserve une marge confortable sur les objets tres allonges
 * (un 5x2 tombe a 96x38, soit encore deux fois la grille d'echantillonnage).
 */
const DECODE_MAX_SIDE = 96;

/** Icones decodees par appel a la fenetre. Compromis taille de message / trajets. */
const DECODE_BATCH = 16;

/** Telechargements simultanes. Au-dela, le CDN throttle sans rien gagner. */
const DOWNLOAD_CONCURRENCY = 12;

/** Delai maximal par icone. Une icone manquante n'est pas bloquante. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

export interface IconEntry {
  id: string;
  /** Taille en slots d'inventaire. Sert a restreindre les candidats. */
  w: number;
  h: number;
  hash: Uint32Array;
  /**
   * Empreinte cryptographique des octets bruts de l'icone, tronquee.
   *
   * Sert a distinguer deux causes d'indistinguabilite qu'aucune mesure sur les
   * empreintes perceptuelles ne separe : des objets dont l'icone est le **meme
   * fichier** (Tarkov reutilise une seule image pour toutes les cles de dortoir,
   * par exemple) et des objets dont les icones different mais que l'empreinte
   * ecrase. Les premiers sont hors de portee de toute methode par image ; les
   * seconds relevent d'un descripteur plus fin.
   */
  sha: string;
}

export interface IconMatch {
  id: string;
  /** Nombre de bits differents, de 0 (identique) a 256. */
  distance: number;
}

/** Octets d'une icone, prets pour le decodage et deja empreintes. */
interface Download {
  /** Les octets en data URL : aucune contrainte CORS, aucun canvas teinte. */
  dataUrl: string;
  sha: string;
}

/** Pixels renvoyes par la fenetre de decodage. */
interface DecodedIcon {
  w: number;
  h: number;
  /** RGBA encode en base64. */
  data: string;
}

export interface BuildProgress {
  done: number;
  total: number;
  failed: number;
}

export class IconIndex {
  private entries: IconEntry[] = [];
  /** Index par taille de slot, cle « LxH ». Evite un balayage complet. */
  private bySlot = new Map<string, IconEntry[]>();
  private readonly cachePath: string;
  private readonly runtimeDir: string;

  constructor(userDataPath: string) {
    this.cachePath = path.join(userDataPath, 'cache', 'icon-hashes.json');
    this.runtimeDir = path.join(userDataPath, 'runtime');
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Charge l'index depuis le cache disque.
   * @returns `false` si le cache est absent, illisible ou d'une version obsolete.
   */
  load(): boolean {
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8')) as {
        version?: number;
        entries?: Array<{ id: string; w: number; h: number; hash: string; sha: string }>;
      };
      if (raw.version !== CACHE_VERSION || !Array.isArray(raw.entries)) return false;

      const entries: IconEntry[] = [];
      for (const row of raw.entries) {
        const hash = hashFromHex(row.hash);
        if (!hash) continue;
        entries.push({ id: row.id, w: row.w, h: row.h, hash, sha: row.sha ?? '' });
      }
      if (entries.length === 0) return false;

      this.setEntries(entries);
      log.info(`${entries.length} empreintes d'icones chargees depuis le cache`);
      return true;
    } catch {
      return false;
    }
  }

  private setEntries(entries: IconEntry[]): void {
    this.entries = entries;
    this.bySlot = new Map();
    for (const entry of entries) {
      const key = `${entry.w}x${entry.h}`;
      const bucket = this.bySlot.get(key);
      if (bucket) bucket.push(entry);
      else this.bySlot.set(key, [entry]);
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.cachePath), { recursive: true });
      writeFileSync(
        this.cachePath,
        JSON.stringify({
          version: CACHE_VERSION,
          entries: this.entries.map((e) => ({
            id: e.id,
            w: e.w,
            h: e.h,
            hash: hashToHex(e.hash),
            sha: e.sha,
          })),
        }),
        'utf8',
      );
    } catch (err) {
      log.error('ecriture du cache d\'empreintes impossible', err);
    }
  }

  /**
   * Telecharge, decode et hache toutes les icones, puis persiste le resultat.
   *
   * Ne rejette jamais sur une icone individuelle : une icone absente ou illisible
   * retire simplement son objet de l'index, l'OCR restant le repli.
   */
  async build(items: readonly TarkovItem[], onProgress?: (p: BuildProgress) => void): Promise<void> {
    const targets = items.filter((item) => item.iconLink && item.width > 0 && item.height > 0);
    if (targets.length === 0) return;

    const started = Date.now();
    const decoder = await this.openDecoder();
    const entries: IconEntry[] = [];
    let failed = 0;

    try {
      for (let offset = 0; offset < targets.length; offset += DECODE_BATCH) {
        const batch = targets.slice(offset, offset + DECODE_BATCH);
        const payloads = await this.downloadBatch(batch);

        // Les entrees sans octets sont retirees avant l'envoi : la fenetre de
        // decodage n'a pas a connaitre les echecs reseau.
        const usable = batch
          .map((item, i) => ({ item, payload: payloads[i] ?? null }))
          .filter((row): row is { item: TarkovItem; payload: Download } => row.payload !== null);
        failed += batch.length - usable.length;
        if (usable.length === 0) {
          onProgress?.({ done: Math.min(offset + DECODE_BATCH, targets.length), total: targets.length, failed });
          continue;
        }

        const decoded = await this.decodeBatch(
          decoder,
          usable.map((row) => row.payload.dataUrl),
        );

        for (let i = 0; i < usable.length; i++) {
          const pixels = decoded[i];
          const { item, payload } = usable[i]!;
          if (!pixels) {
            failed++;
            continue;
          }
          const rgba = Buffer.from(pixels.data, 'base64');
          const hash = computeHash(rgba, pixels.w, pixels.h, 'rgba');
          if (!hash) {
            failed++;
            continue;
          }
          entries.push({ id: item.id, w: item.width, h: item.height, hash, sha: payload.sha });
        }

        onProgress?.({ done: Math.min(offset + DECODE_BATCH, targets.length), total: targets.length, failed });
      }
    } finally {
      if (!decoder.isDestroyed()) decoder.destroy();
    }

    this.setEntries(entries);
    this.save();
    log.info(
      `index d'icones construit : ${entries.length}/${targets.length} empreintes ` +
        `(${failed} echecs) en ${Math.round((Date.now() - started) / 1000)} s`,
    );
  }

  /** Telecharge les octets d'un lot d'icones. `null` par icone en echec. */
  private async downloadBatch(items: readonly TarkovItem[]): Promise<Array<Download | null>> {
    const results: Array<Download | null> = new Array(items.length).fill(null);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        const item = items[index]!;
        results[index] = await this.download(item.iconLink!);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, () => worker()),
    );
    return results;
  }

  /**
   * Recupere une icone et l'encode en data URL.
   *
   * Le telechargement a lieu ici, cote main, et non dans la fenetre de decodage :
   * une requete depuis le renderer serait soumise au CORS, et un canvas alimente
   * par une image distante devient « teinte », ce qui interdit precisement la
   * lecture des pixels dont on a besoin. Une data URL, elle, ne teinte rien.
   */
  private async download(url: string): Promise<Download | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) return null;
      const mime = url.endsWith('.jpg') || url.endsWith('.jpeg') ? 'image/jpeg' : 'image/webp';
      return {
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
        sha: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fait decoder un lot de data URLs par la fenetre cachee. */
  private async decodeBatch(window: BrowserWindow, dataUrls: string[]): Promise<Array<DecodedIcon | null>> {
    if (window.isDestroyed()) return dataUrls.map(() => null);
    try {
      return (await window.webContents.executeJavaScript(
        `decodeBatch(${JSON.stringify(dataUrls)}, ${DECODE_MAX_SIDE})`,
      )) as Array<DecodedIcon | null>;
    } catch (err) {
      log.warn('lot de decodage en echec', err);
      return dataUrls.map(() => null);
    }
  }

  /**
   * Ouvre la fenetre cachee qui decode le WebP.
   *
   * Chromium sait lire le WebP, contrairement a `nativeImage` cote main. La page
   * ne fait que decoder et renvoyer des pixels : aucune empreinte n'y est
   * calculee, pour que `IconHash` reste l'unique implementation et que les deux
   * chemins ne puissent pas diverger.
   */
  private async openDecoder(): Promise<BrowserWindow> {
    mkdirSync(this.runtimeDir, { recursive: true });
    const file = path.join(this.runtimeDir, 'icon-decoder.html');
    writeFileSync(file, DECODER_HTML, 'utf8');

    const window = new BrowserWindow({
      width: 200,
      height: 200,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Le decodage doit avancer meme si la fenetre n'est jamais affichee.
        backgroundThrottling: false,
      },
    });
    await window.loadURL(pathToFileURL(file).href);
    return window;
  }

  /**
   * Objets dont l'icone ressemble le plus a l'empreinte fournie.
   *
   * @param hash  empreinte de la case capturee
   * @param w     largeur de l'objet en slots
   * @param h     hauteur en slots
   * @param limit nombre de candidats renvoyes
   */
  match(hash: Uint32Array, w: number, h: number, limit = 3): IconMatch[] {
    const candidates = this.bySlot.get(`${w}x${h}`);
    if (!candidates || candidates.length === 0) return [];

    const scored: IconMatch[] = [];
    for (const entry of candidates) {
      scored.push({ id: entry.id, distance: hammingDistance(hash, entry.hash) });
    }
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, limit);
  }

  /** Toutes les entrees, pour l'auto-test. */
  get all(): readonly IconEntry[] {
    return this.entries;
  }
}

/**
 * Page de decodage. Volontairement minimale : elle expose une seule fonction,
 * appelee par `executeJavaScript`.
 *
 * `imageSmoothingQuality: 'high'` demande a Chromium une reduction par moyenne
 * de surface, la meme famille d'operation que le filtre de blocs d'`IconHash`.
 * Les deux chemins convergent ainsi vers la meme grille de luminances.
 */
const DECODER_HTML = `<!doctype html>
<html><body style="margin:0;background:#000">
<script>
window.decodeBatch = async function (dataUrls, maxSide) {
  const out = [];
  for (const src of dataUrls) {
    try {
      const img = new Image();
      img.src = src;
      await img.decode();
      const natural = Math.max(img.naturalWidth, img.naturalHeight);
      const scale = natural > maxSide ? maxSide / natural : 1;
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // Fond transparent conserve : IconHash ignore les pixels d'alpha nul.
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      const data = ctx.getImageData(0, 0, w, h).data;
      // btoa par tranches : String.fromCharCode deborde la pile sur un grand tableau.
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < data.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK));
      }
      out.push({ w: w, h: h, data: btoa(binary) });
    } catch (err) {
      out.push(null);
    }
  }
  return out;
};
</script></body></html>`;
