/**
 * services/IconHash.ts
 * --------------------
 * Empreinte perceptuelle d'une icone d'objet (« dHash »).
 *
 * Pourquoi une empreinte plutot qu'une correlation
 * ------------------------------------------------
 * Identifier l'objet survole par son **icone** au lieu du texte de l'infobulle
 * supprime le plancher de ~300 ms que Tarkov met a dessiner cette infobulle :
 * l'icone, elle, est affichee immediatement. RatScanner obtient ce resultat avec
 * `Cv2.MatchTemplate` d'OpenCV ; sans module natif, une correlation sur 5312
 * gabarits serait hors budget en JavaScript.
 *
 * Le dHash donne le meme pouvoir discriminant pour un cout sans commune mesure :
 * chaque icone se reduit a 256 bits, et la comparaison est un XOR suivi d'un
 * comptage de bits — quelques microsecondes sur tout le catalogue.
 *
 * Principe : l'image est reduite a une grille 17x16 de luminances, puis chaque
 * cellule est comparee a sa voisine de droite. On obtient 16x16 = 256 bits qui
 * decrivent les **variations locales de clarte**, et non les valeurs absolues.
 * L'empreinte resiste donc aux changements de luminosite et de contraste — ce
 * qui compte ici, car la case en jeu est rendue sur un fond de slot colore alors
 * que l'icone du catalogue est sur fond neutre.
 *
 * Contrainte centrale : agreement des deux chemins
 * ------------------------------------------------
 * L'empreinte est calculee sur deux sources differentes — l'icone du catalogue
 * (decodee par Chromium) a l'indexation, et la case capturee a l'ecran a
 * l'execution. Les deux **doivent** produire des empreintes comparables. C'est
 * pourquoi ce module est l'unique implementation : les deux chemins l'appellent,
 * et la reduction utilise un filtre de moyenne par blocs, tres peu sensible a la
 * facon dont l'image a ete redimensionnee en amont.
 */

/**
 * Cote de la grille d'echantillonnage.
 *
 * 24 plutot que 16 : mesure sur le catalogue reel, une grille 16x16 en niveaux
 * de gris laissait **31,5 % des objets a moins de 10 bits** de leur plus proche
 * voisin — indistinguables. Une grille plus fine retient les details courts qui
 * separent, par exemple, deux boites de munitions du meme calibre.
 */
const GRID = 24;
/** Une colonne de plus : chaque cellule a besoin d'une voisine a droite. */
const SAMPLE_WIDTH = GRID + 1;

/**
 * Canaux haches, dans l'ordre. L'empreinte les concatene.
 *
 * La luminance seule confondait des objets que seule la **couleur** separe :
 * `5.56x45mm M855` et `M856A1` ne different que par la teinte de la pointe,
 * `5.45x39mm BS gs` et `BT gs` que par l'etiquette de la boite. Les deux
 * tombaient a 0 bit d'ecart. Hacher les canaux separement conserve cette
 * information, pour un cout lineaire.
 */
const CHANNELS = 3;

/** Bits par canal. */
const BITS_PER_CHANNEL = GRID * GRID;
/** Nombre de mots de 32 bits d'une empreinte complete. */
export const HASH_WORDS = (BITS_PER_CHANNEL * CHANNELS) / 32;

/** Disposition des octets de la source. La capture d'ecran est en BGRA. */
export type PixelOrder = 'rgba' | 'bgra';

/**
 * Reduit une image a une grille `SAMPLE_WIDTH x GRID` de luminances, par moyenne
 * de blocs.
 *
 * La moyenne (et non un echantillonnage ponctuel) est ce qui rend l'empreinte
 * stable d'un chemin a l'autre : elle reproduit ce que fait n'importe quel
 * reducteur de qualite, y compris celui de Chromium. Un echantillonnage ponctuel
 * dependrait, lui, du pixel exact retenu, et les deux chemins divergeraient.
 */
function toChannelGrids(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  order: PixelOrder,
): Float64Array[] {
  const grids = [
    new Float64Array(SAMPLE_WIDTH * GRID),
    new Float64Array(SAMPLE_WIDTH * GRID),
    new Float64Array(SAMPLE_WIDTH * GRID),
  ];
  const redOffset = order === 'bgra' ? 2 : 0;
  const blueOffset = order === 'bgra' ? 0 : 2;

  for (let gy = 0; gy < GRID; gy++) {
    // Bornes du bloc source, en arithmetique exacte : aucun bloc n'est saute ni
    // compte deux fois, meme quand la taille source n'est pas multiple de GRID.
    const y0 = Math.floor((gy * height) / GRID);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GRID));

    for (let gx = 0; gx < SAMPLE_WIDTH; gx++) {
      const x0 = Math.floor((gx * width) / SAMPLE_WIDTH);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / SAMPLE_WIDTH));

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        let offset = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, offset += 4) {
          const alpha = pixels[offset + 3]!;
          // Les icones du catalogue sont sur fond transparent. Sans ce filtre,
          // le fond compterait comme du noir et ecraserait la silhouette.
          if (alpha === 0) continue;
          sumR += pixels[offset + redOffset]!;
          sumG += pixels[offset + 1]!;
          sumB += pixels[offset + blueOffset]!;
          count++;
        }
      }
      const cell = gy * SAMPLE_WIDTH + gx;
      if (count === 0) continue;
      grids[0]![cell] = sumR / count;
      grids[1]![cell] = sumG / count;
      grids[2]![cell] = sumB / count;
    }
  }
  return grids;
}

/**
 * Calcule l'empreinte d'une image RGBA ou BGRA quelconque.
 *
 * @param pixels tampon de 4 octets par pixel
 * @param width  largeur en pixels
 * @param height hauteur en pixels
 * @param order  disposition des octets (`bgra` pour une capture d'ecran)
 * @returns 8 mots de 32 bits, ou `null` si l'image est trop petite pour porter
 *          une information exploitable.
 */
export function computeHash(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  order: PixelOrder = 'rgba',
): Uint32Array | null {
  if (width < SAMPLE_WIDTH || height < GRID) return null;
  if (pixels.length < width * height * 4) return null;

  const grids = toChannelGrids(pixels, width, height, order);
  const hash = new Uint32Array(HASH_WORDS);

  let bit = 0;
  for (const grid of grids) {
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++, bit++) {
        const left = grid[y * SAMPLE_WIDTH + x]!;
        const right = grid[y * SAMPLE_WIDTH + x + 1]!;
        if (left > right) hash[bit >>> 5]! |= 1 << (bit & 31);
      }
    }
  }
  return hash;
}

/** Compte les bits a 1 d'un mot de 32 bits (Hamming weight, sans boucle). */
function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/**
 * Distance de Hamming entre deux empreintes : nombre de bits qui different.
 * 0 = images identiques, 128 = aucune correlation (moitie des bits).
 */
export function hammingDistance(a: Uint32Array, b: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < HASH_WORDS; i++) total += popcount32(a[i]! ^ b[i]!);
  return total;
}

/** Serialise une empreinte en hexadecimal, pour le cache disque. */
export function hashToHex(hash: Uint32Array): string {
  let out = '';
  for (let i = 0; i < HASH_WORDS; i++) out += hash[i]!.toString(16).padStart(8, '0');
  return out;
}

/** Inverse de `hashToHex`. Renvoie `null` si la chaine est malformee. */
export function hashFromHex(hex: string): Uint32Array | null {
  if (typeof hex !== 'string' || hex.length !== HASH_WORDS * 8) return null;
  const hash = new Uint32Array(HASH_WORDS);
  for (let i = 0; i < HASH_WORDS; i++) {
    const word = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16);
    if (!Number.isFinite(word)) return null;
    hash[i] = word >>> 0;
  }
  return hash;
}
