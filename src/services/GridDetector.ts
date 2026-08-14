/**
 * services/GridDetector.ts
 * ------------------------
 * Retrouve le pas de la grille d'inventaire de Tarkov dans une image capturee.
 *
 * A quoi ca sert
 * --------------
 * Identifier un objet par son **icone** suppose de savoir ou commence et ou finit
 * sa case. RatScanner s'appuie sur une taille de slot configuree ; on la deduit
 * ici de l'image, ce qui evite toute calibration manuelle et suit
 * automatiquement la resolution comme le reglage d'echelle de l'interface.
 *
 * Signal exploite
 * ---------------
 * La grille est faite de bordures fines, regulierement espacees, sur toute la
 * hauteur et toute la largeur de la zone d'inventaire. En projetant l'energie
 * des contours sur chaque axe, on obtient un signal **periodique** dont la
 * periode est exactement le pas de la grille.
 *
 *   1. Gradient horizontal cumule par colonne -> signal 1D
 *   2. Autocorrelation sur les periodes plausibles -> pas
 *   3. Phase : decalage qui maximise l'energie aux multiples du pas
 *
 * Pourquoi une projection et non une detection de lignes : le contenu des cases
 * (icones, chiffres, barres de durabilite) produit des contours partout. La
 * somme sur une colonne entiere noie ce bruit, alors qu'une bordure de grille,
 * presente sur toute la hauteur, ressort nettement.
 *
 * Robustesse : la fonction renvoie `null` des que la periodicite n'est pas
 * franche. Mieux vaut pas de grille du tout qu'une grille fausse, qui
 * decouperait les cases de travers et produirait des identifications erronees.
 */

/** Pas de slot minimal et maximal, en pixels a 1080p. Tarkov tourne autour de 63. */
const MIN_PITCH_AT_1080P = 40;
const MAX_PITCH_AT_1080P = 130;

/**
 * Rapport minimal entre le pic d'autocorrelation et la moyenne du signal.
 *
 * En dessous, l'image ne contient pas de grille franche — un ecran de raid, une
 * carte, un menu. Le seuil est ce qui garantit qu'on ne « trouve » pas une
 * grille dans du bruit.
 */
const MIN_PEAK_RATIO = 1.15;

/**
 * Part du score du maximum qu'une periode divisee doit conserver pour etre
 * retenue a sa place.
 *
 * Volontairement permissif : une sous-harmonique reelle atteint presque toujours
 * un score comparable au multiple qu'elle engendre, et se tromper vers le plus
 * petit est sans consequence — une grille de 84 lue comme 42 decoupe deux
 * demi-cases, la ou une grille de 84 lue comme 168 fusionne deux objets.
 */
const SUBHARMONIC_TOLERANCE = 0.7;

export interface Grid {
  /** Pas horizontal et vertical, en pixels de l'image. */
  pitchX: number;
  pitchY: number;
  /** Position de la premiere bordure, dans [0, pitch). */
  phaseX: number;
  phaseY: number;
  /** Force de la periodicite retenue. Expose pour le panneau debug. */
  strength: number;
}

/**
 * Projette l'energie des contours sur un axe.
 *
 * @param axis `x` cumule les gradients horizontaux par colonne (revele les
 *             bordures verticales), `y` fait l'inverse.
 */
function edgeProjection(
  bgra: Buffer,
  width: number,
  height: number,
  axis: 'x' | 'y',
): Float64Array {
  const length = axis === 'x' ? width : height;
  const projection = new Float64Array(length);

  if (axis === 'x') {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let previous = luminance(bgra, row);
      for (let x = 1; x < width; x++) {
        const current = luminance(bgra, row + x);
        projection[x] = projection[x]! + Math.abs(current - previous);
        previous = current;
      }
    }
  } else {
    for (let y = 1; y < height; y++) {
      const row = y * width;
      const above = (y - 1) * width;
      let sum = 0;
      for (let x = 0; x < width; x++) {
        sum += Math.abs(luminance(bgra, row + x) - luminance(bgra, above + x));
      }
      projection[y] = sum;
    }
  }
  return projection;
}

/** Luminance Rec. 601 du pixel d'indice `pixel` (et non d'octet). */
function luminance(bgra: Buffer, pixel: number): number {
  const offset = pixel * 4;
  return (bgra[offset + 2]! * 299 + bgra[offset + 1]! * 587 + bgra[offset]! * 114) / 1000;
}

/**
 * Cherche la periode dominante d'un signal, par autocorrelation.
 *
 * Le signal est d'abord centre sur sa moyenne : sans cela, l'autocorrelation
 * serait dominee par la composante continue et croitrait avec le decalage, ce
 * qui donnerait systematiquement la periode maximale.
 */
function dominantPeriod(
  signal: Float64Array,
  minPeriod: number,
  maxPeriod: number,
): { period: number; ratio: number } | null {
  const n = signal.length;
  if (n < maxPeriod * 3) return null;

  let mean = 0;
  for (const value of signal) mean += value;
  mean /= n;

  const centred = new Float64Array(n);
  for (let i = 0; i < n; i++) centred[i] = signal[i]! - mean;

  let bestPeriod = 0;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;

  for (let period = minPeriod; period <= maxPeriod; period++) {
    let sum = 0;
    const limit = n - period;
    for (let i = 0; i < limit; i++) sum += centred[i]! * centred[i + period]!;
    const score = sum / limit;
    scoreSum += score;
    scoreCount++;
    if (score > bestScore) {
      bestScore = score;
      bestPeriod = period;
    }
  }

  if (bestPeriod === 0 || scoreCount === 0) return null;
  const average = scoreSum / scoreCount;
  // Un pic doit dominer la moyenne des autres periodes pour etre credible.
  if (average <= 0 || bestScore <= 0) return null;

  // --- Retour a la periode fondamentale ---
  //
  // L'autocorrelation d'un signal periodique culmine autant a 2P, 3P... qu'a P :
  // un signal de periode 84 s'aligne parfaitement avec lui-meme decale de 168.
  // Le maximum brut retient donc souvent un **multiple** de la vraie periode.
  // Mesure sur des captures reelles : le detecteur renvoyait 132 et 168 px la ou
  // la grille en fait ~84, et deux echantillons du meme ecran donnaient des
  // valeurs differentes selon le multiple accroche.
  //
  // On redescend donc explicitement : si P/2, P/3 ou P/4 tiennent encore un score
  // comparable, c'est l'un d'eux la periode reelle. On garde le plus petit.
  let period = bestPeriod;
  for (const divisor of [4, 3, 2]) {
    const candidate = Math.round(bestPeriod / divisor);
    if (candidate < minPeriod || candidate > maxPeriod) continue;
    let sum = 0;
    const limit = n - candidate;
    for (let i = 0; i < limit; i++) sum += centred[i]! * centred[i + candidate]!;
    const score = sum / limit;
    if (score >= bestScore * SUBHARMONIC_TOLERANCE) {
      period = candidate;
      break;
    }
  }

  const ratio = bestScore / average;
  return { period, ratio };
}

/**
 * Decalage, dans [0, period), qui aligne au mieux les multiples de `period` sur
 * les maxima du signal. C'est la position de la premiere bordure.
 */
function bestPhase(signal: Float64Array, period: number): number {
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < period; phase++) {
    let sum = 0;
    for (let i = phase; i < signal.length; i += period) sum += signal[i]!;
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
    }
  }
  return bestPhase;
}

/**
 * Detecte la grille d'inventaire dans une image BGRA.
 *
 * @param sizeScale hauteur de l'ecran divisee par 1080, comme dans `TooltipLocator`
 * @returns la grille, ou `null` si aucune periodicite franche n'est trouvee
 */
export function detectGrid(
  bgra: Buffer,
  width: number,
  height: number,
  sizeScale: number,
): Grid | null {
  const minPitch = Math.max(8, Math.round(MIN_PITCH_AT_1080P * sizeScale));
  const maxPitch = Math.round(MAX_PITCH_AT_1080P * sizeScale);
  if (width < maxPitch * 3 || height < maxPitch * 3) return null;
  if (bgra.length < width * height * 4) return null;

  const columns = edgeProjection(bgra, width, height, 'x');
  const rows = edgeProjection(bgra, width, height, 'y');

  const horizontal = dominantPeriod(columns, minPitch, maxPitch);
  const vertical = dominantPeriod(rows, minPitch, maxPitch);
  if (!horizontal || !vertical) return null;
  if (horizontal.ratio < MIN_PEAK_RATIO || vertical.ratio < MIN_PEAK_RATIO) return null;

  // Les cases de Tarkov sont carrees : deux pas tres differents signalent que
  // l'un des deux axes a accroche autre chose que la grille.
  const larger = Math.max(horizontal.period, vertical.period);
  const smaller = Math.min(horizontal.period, vertical.period);
  if (larger / smaller > 1.12) return null;

  return {
    pitchX: horizontal.period,
    pitchY: vertical.period,
    phaseX: bestPhase(columns, horizontal.period),
    phaseY: bestPhase(rows, vertical.period),
    strength: Math.min(horizontal.ratio, vertical.ratio),
  };
}

/** Indice de la case contenant une coordonnee, selon le pas et la phase. */
export function cellIndex(coordinate: number, pitch: number, phase: number): number {
  return Math.floor((coordinate - phase) / pitch);
}

/** Coordonnee du bord d'une case, a partir de son indice. */
export function cellEdge(index: number, pitch: number, phase: number): number {
  return Math.round(index * pitch + phase);
}
