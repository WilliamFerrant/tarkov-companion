/**
 * services/TooltipLocator.ts
 * --------------------------
 * Localise automatiquement l'infobulle de Tarkov autour du curseur, ce qui
 * supprime toute calibration manuelle de zone de capture.
 *
 * Signal exploite
 * ---------------
 * L'infobulle est un **grand rectangle plein, uniforme, nettement plus contraste
 * que la scene**, ancre pres du curseur. Aucune autre chose a l'ecran ne reunit
 * ces quatre proprietes :
 *
 *   - les cases d'inventaire sont texturees et de luminance moyenne ;
 *   - les icones d'objets tranchent mais leur silhouette ne remplit pas son
 *     rectangle englobant (faible taux de remplissage) ;
 *   - les panneaux d'interface existent, mais loin du curseur.
 *
 * Les deux polarites sont explorees
 * ---------------------------------
 * Tarkov n'affiche pas toujours l'infobulle sur fond sombre : selon le contexte
 * elle apparait aussi en clair sur fond sombre. Une recherche limitee aux
 * rectangles sombres rate purement et simplement le second cas — constate en
 * jeu, l'outil n'affichait alors plus rien. On balaie donc les seuils **des deux
 * cotes de la mediane**, et on retient la meilleure candidate toutes polarites
 * confondues.
 *
 * Algorithme
 * ----------
 *   1. Sous-echantillonnage par moyenne de blocs (fond le texte dans le fond,
 *      ce qui est souhaitable : on cherche la boite, pas les lettres).
 *   2. Pour chaque seuil d'une echelle adaptative : masque « sombre », fermeture
 *      morphologique horizontale puis verticale (rebouche les trous laisses par
 *      le texte), etiquetage en composantes connexes.
 *   3. **Plus grand rectangle plein** de chaque composante (voir plus bas).
 *   4. Filtrage par taille et distance au curseur, puis selection de la
 *      meilleure (aire ponderee par la proximite du curseur).
 *
 * Plusieurs seuils sont essayes plutot qu'un seul : la luminosite de l'infobulle
 * depend du gamma et des reglages video du joueur. Un seuil unique calibre sur
 * une seule configuration serait exactement le probleme qu'on cherche a
 * eliminer. Chaque passe coute ~2 ms sur une grille sous-echantillonnee.
 *
 * Pourquoi le plus grand rectangle plein
 * --------------------------------------
 * L'infobulle se superpose a l'inventaire : ses bords touchent forcement les
 * icones sombres qui se trouvent derriere. Les composantes connexes fusionnent
 * alors l'infobulle avec ces icones, et le rectangle englobant deborde largement
 * — la boite est perdue alors qu'elle etait parfaitement detectee. Ce cas n'a
 * rien d'un cas limite : c'est la situation normale, reproduite par
 * `npm run test:ocr`.
 *
 * Le corps de l'infobulle est, par construction, le plus grand rectangle
 * entierement plein de la forme fusionnee : on le calcule donc exactement, plutot
 * que de l'approcher en rognant les bords les moins couverts. Un rognage glouton
 * depend de l'ordre dans lequel on retire lignes et colonnes, et sur une forme
 * en L il converge vers le mauvais bras — face a une icone plus haute que
 * l'infobulle, il tronquait le texte a lire.
 *
 * Tous les seuils dimensionnels sont exprimes en pixels a 1080p puis mis a
 * l'echelle par `sizeScale`, ce qui rend la detection independante de la
 * resolution.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocateOptions {
  /** Position du curseur dans le repere de la fenetre de recherche, en pixels physiques. */
  cursorX: number;
  cursorY: number;
  /** Hauteur physique de l'ecran divisee par 1080. Met les seuils a l'echelle. */
  sizeScale: number;
  /**
   * Zone a ignorer, dans le repere de la fenetre de recherche.
   *
   * Sert a exclure la carte de prix elle-meme. Sans cela, l'outil se mord la
   * queue : la carte est un grand rectangle sombre, plein, pres du curseur —
   * exactement le motif recherche. Elle serait donc detectee a la place de
   * l'infobulle du jeu, et l'OCR relirait ses propres libelles.
   */
  excludeRect?: Rect | null;
}

export interface LocateResult {
  /** Rectangle de l'infobulle, repere de la fenetre de recherche, pixels physiques. */
  rect: Rect;
  /** Part du rectangle englobant reellement couverte par la composante (0 a 1). */
  fillRatio: number;
  /** Seuil de luminance retenu. Expose pour le panneau debug. */
  threshold: number;
}

// --- Seuils dimensionnels, exprimes en pixels a 1080p ---------------------

/**
 * Bornes dimensionnelles de l'infobulle, en pixels a 1080p.
 *
 * Calibrees sur des mesures reelles, et non estimees : sur une capture 2561x1440
 * (ecran 4K a 150 %, `sizeScale` = 1,333), les infobulles effectivement lues en
 * jeu mesurent **395x55 px** pour un nom long (« AR-15 SureFire SF4P 5.56x45
 * flash hider ») et **250x50 px** pour un nom moyen. Ramene a 1080p : **296x41**
 * et **188x37**. Les bornes ci-dessous laissent environ deux fois cette marge.
 *
 * Les anciennes valeurs (1250 x 280) etaient environ quatre fois trop larges.
 * Elles autorisaient des composantes telles qu'un pan entier d'inventaire de
 * 1450x285 px, que le score — proportionnel a l'aire — elisait forcement contre
 * une infobulle trente fois plus petite. L'OCR y lisait du charabia, et ce
 * charabia finissait par matcher un objet au hasard.
 *
 * La hauteur est le discriminant le plus fort : une infobulle de nom d'objet
 * tient sur une ou deux lignes, la aucun panneau d'interface ne peut la suivre.
 */
/**
 * Largeur minimale, en pixels a 1080p.
 *
 * 110 rejetait les noms courts : l'infobulle de « Chainlet » mesure ~182 px
 * physiques sur un ecran 4K, soit ~91 px ramenes a 1080p — sous l'ancien seuil.
 * Les objets a nom bref (`Bolts`, `Wires`, `Nuts`) n'etaient donc jamais
 * detectes, alors que rien d'autre ne clochait dans la chaine.
 *
 * 55 laisse passer un nom de cinq lettres. La protection contre les fragments
 * d'interface ne repose plus sur la largeur — elle est assuree par la borne de
 * hauteur, le rejet des rectangles contenant le curseur, le plancher de
 * confiance Tesseract et le seuil de similarite.
 */
const MIN_WIDTH = 55;
const MAX_WIDTH = 620;
const MIN_HEIGHT = 22;
/**
 * Hauteur maximale, en pixels a 1080p.
 *
 * Reserree de 90 a 68 sur mesures reelles : les infobulles effectivement lues en
 * jeu font 36 a 60 px capturees (`sizeScale` 1,07), soit 34 a 56 ramenees a
 * 1080p — deux lignes de texte comprises. 90 laissait passer l'en-tete
 * « NEW PRESET 1 » du jeu, haut de 96 px capturees, qui matchait « Intelligence
 * folder » a 0,73.
 *
 * C'est le discriminant le plus fort dont on dispose : une infobulle de nom
 * d'objet tient sur une ou deux lignes, la ou aucun panneau d'interface ne peut
 * la suivre.
 */
const MAX_HEIGHT = 68;
/** Distance maximale entre le curseur et le rectangle. L'infobulle y est ancree. */
const MAX_CURSOR_DISTANCE = 260;
/**
 * Raideur de la decroissance du score avec la distance au curseur, en fraction
 * de `MAX_CURSOR_DISTANCE`.
 *
 * Resserree de 0,35 a 0,20. Le score vaut `largeur x proximite` : une bande
 * large et lointaine peut donc battre une infobulle etroite et collee au
 * curseur, ce qui est exactement l'inverse du signal recherche.
 *
 * Constate en jeu sur un objet place en haut d'un conteneur : la **barre de
 * titre** du conteneur, 705x65 px a ~120 px du curseur, etait retenue a la place
 * de l'infobulle.
 *
 *                   largeur   proximite   score
 *   barre de titre     705      0,318       224
 *   infobulle          170      0,875       149
 *
 * A 0,20 les memes candidats donnent 95 et 134 : l'ancrage au curseur redevient
 * decisif, ce qu'il aurait toujours du etre. Une boite collee au curseur garde un
 * facteur ~0,9, une boite a la distance limite tombe a ~0,007.
 *
 * Les cinq cas de `npm run test:ocr` passent encore a 0,15, ce qui laisse de la
 * marge sous la valeur retenue.
 */
const PROXIMITY_FALLOFF = 0.2;
/** Cote du bloc de sous-echantillonnage a 1080p. */
const BLOCK_AT_1080P = 4;

/**
 * Ecart horizontal maximal rebouche par la fermeture, en cellules.
 *
 * Ramene de 6 a 3. La fermeture sert a reconnecter la boite par-dessus les
 * espaces laisses par le texte — mais elle franchit tout aussi bien la **bordure
 * de l'infobulle**, et la soude alors a ce qui la jouxte. Quand ce voisin est
 * une grande zone sombre, typiquement des cases d'inventaire vides, la
 * composante fusionnee a pour plus grand rectangle plein cette zone vide : elle
 * est ecartee par les bornes de taille, et l'infobulle disparait avec elle.
 *
 * Constate en jeu sur « Key tool » place dans le POUCH, contre une grande zone
 * vide : aucune detection. Le meme objet ailleurs, entoure d'icones plus
 * claires, etait reconnu immediatement.
 *
 * 3 cellules valent ~12 px a 1080p, soit largement un espace entre deux mots.
 * Le sous-echantillonnage par moyenne de blocs a de toute facon deja fondu le
 * texte dans le fond : la fermeture n'a plus qu'un role d'appoint.
 *
 * Les valeurs 2, 3 et 4 passent toutes les cinq cas de `npm run test:ocr` — le
 * choix repose donc sur ce raisonnement, non sur une mesure qui les separerait.
 */
const CLOSE_GAP_X = 3;
/** Idem verticalement. Plus petit : le texte tient sur peu de lignes. */
const CLOSE_GAP_Y = 3;

/**
 * Localise l'infobulle dans une fenetre de recherche donnee.
 *
 * @param bgra   tampon BGRA de la fenetre de recherche (issu de `NativeImage.toBitmap()`)
 * @param width  largeur de la fenetre, en pixels physiques
 * @param height hauteur de la fenetre, en pixels physiques
 * @returns le rectangle trouve, ou `null` si aucune candidate ne passe les filtres
 */
export function locateTooltip(
  bgra: Buffer,
  width: number,
  height: number,
  options: LocateOptions,
): LocateResult | null {
  const block = Math.max(3, Math.round(BLOCK_AT_1080P * options.sizeScale));
  const gridWidth = Math.floor(width / block);
  const gridHeight = Math.floor(height / block);
  if (gridWidth < 8 || gridHeight < 4) return null;

  const cells = downsampleToGray(bgra, width, height, block, gridWidth, gridHeight);

  // Masque d'exclusion separe plutot qu'une valeur sentinelle dans `cells` :
  // marquer les cellules a 255 exclurait aussi les vraies zones blanches, donc
  // les infobulles a fond clair — exactement ce qu'on cherche a detecter.
  const excluded = buildExclusionMask(options.excludeRect ?? null, block, gridWidth, gridHeight);

  // Deux echelles de seuils, de part et d'autre de la mediane de la scene. On ne
  // suppose jamais une luminance absolue de l'infobulle, seulement qu'elle
  // tranche sur ce qui l'entoure — dans un sens ou dans l'autre.
  const median = percentile(cells, 0.5);
  const darkest = percentile(cells, 0.01);
  const brightest = percentile(cells, 0.99);
  const passes: Array<{ threshold: number; darkSide: boolean }> = [
    ...buildThresholdLadder(darkest, median).map((threshold) => ({ threshold, darkSide: true })),
    ...buildThresholdLadder(median, brightest).map((threshold) => ({ threshold, darkSide: false })),
  ];
  if (passes.length === 0) return null;

  const scaled = (value: number) => value * options.sizeScale;
  const limits = {
    minWidth: scaled(MIN_WIDTH),
    maxWidth: scaled(MAX_WIDTH),
    minHeight: scaled(MIN_HEIGHT),
    maxHeight: scaled(MAX_HEIGHT),
    maxDistance: scaled(MAX_CURSOR_DISTANCE),
  };

  let best: LocateResult | null = null;
  let bestScore = 0;

  const mask = new Uint8Array(gridWidth * gridHeight);
  const labels = new Int32Array(gridWidth * gridHeight);
  const stack = new Int32Array(gridWidth * gridHeight);

  for (const { threshold, darkSide } of passes) {
    for (let i = 0; i < cells.length; i++) {
      if (excluded[i] === 1) {
        mask[i] = 0;
        continue;
      }
      const value = cells[i]!;
      mask[i] = (darkSide ? value <= threshold : value >= threshold) ? 1 : 0;
    }
    closeGaps(mask, gridWidth, gridHeight);

    // Reappliquer l'exclusion **apres** la fermeture morphologique.
    //
    // La fermeture dilate puis erode : elle rebouche les trous entoures de
    // cellules actives. Or la carte de prix est posee sur l'inventaire, sombre
    // lui aussi — la dilatation franchissait donc la zone exclue depuis ses
    // bords et la remplissait entierement. L'exclusion etait annulee juste apres
    // avoir ete posee, et la carte redevenait un candidat.
    //
    // Symptome en jeu : carte a gauche de l'infobulle, zone retenue « 57 159 P »,
    // c'est-a-dire la ligne de prix de la carte elle-meme au lieu du nom de
    // l'objet survole.
    if (options.excludeRect) {
      for (let i = 0; i < mask.length; i++) {
        if (excluded[i] === 1) mask[i] = 0;
      }
    }

    labels.fill(0);
    for (const component of findComponents(mask, labels, stack, gridWidth, gridHeight)) {
      // Un seul rectangle par composante : le plus grand rectangle plein.
      //
      // L'enumeration de **tous** les rectangles maximaux a ete essayee, pour
      // rattraper le cas d'une infobulle collee a une grande zone sombre. Elle
      // ne peut pas fonctionner, et pour une raison de fond : quand l'infobulle
      // touche du sombre de tous cotes, son rectangle exact n'est pas maximal —
      // on peut toujours l'etendre — donc il ne figure pas dans l'enumeration.
      // Elle n'ajoutait que des boites debordantes ou tranchantes, et le cadrage
      // tombait de 5/5 a 1/5.
      //
      // Le defaut est en amont, dans la fusion des composantes : voir
      // `CLOSE_GAP_X`.
      const trimmed = largestSolidRect(labels, gridWidth, component);
      if (!trimmed) continue;

      // Retour au repere pixels physiques de la fenetre de recherche.
      const rect: Rect = {
        x: trimmed.minX * block,
        y: trimmed.minY * block,
        width: (trimmed.maxX - trimmed.minX + 1) * block,
        height: (trimmed.maxY - trimmed.minY + 1) * block,
      };

      if (rect.width < limits.minWidth || rect.width > limits.maxWidth) continue;
      if (rect.height < limits.minHeight || rect.height > limits.maxHeight) continue;

      // Le curseur est dans la boite : c'est le panneau de fond, pas l'infobulle.
      if (containsPoint(options.cursorX, options.cursorY, rect)) continue;

      const distance = distanceToRect(options.cursorX, options.cursorY, rect);
      if (distance > limits.maxDistance) continue;

      // Une infobulle contient forcement du texte. Sans ce critere, un bloc
      // sombre uniforme l'emporte des que l'infobulle est etroite — le score
      // privilegiant la largeur, un nom court n'en offre que peu. Constate en
      // jeu sur « Key tool » : zone retenue 130x45, remplissage 100 %, puis
      // « aucun texte detecte dans la zone ».
      if (textCoverage(bgra, width, height, rect) === 0) continue;

      // L'infobulle est la boite pleine **collee** au curseur. La decroissance
      // exponentielle avec la distance ecarte les panneaux d'interface, plus
      // grands mais plus loin : a `maxDistance`, une boite doit etre ~17 fois
      // plus large que l'infobulle pour la supplanter.
      //
      // Score sur la **largeur** seule, jamais sur l'aire. Ponderer par l'aire
      // faisait gagner tout rectangle plus haut, alors que la hauteur d'une
      // infobulle est deja bornee par `MIN_HEIGHT` / `MAX_HEIGHT` : elle
      // n'apporte aucune information, et elle permettait a un compteur de
      // durabilite (200x80) de battre une infobulle courte mais correcte
      // (97x40) — observe en jeu sur « Chainlet ».
      const proximity = Math.exp(-distance / (PROXIMITY_FALLOFF * limits.maxDistance));
      const score = rect.width * proximity;
      if (score > bestScore) {
        bestScore = score;
        // Plein a 100 % par construction : `largestSolidRect` ne rend que des
        // rectangles entierement remplis. Le taux de remplissage d'autrefois est
        // donc devenu une constante, conservee pour le panneau debug.
        best = { rect, fillRatio: 1, threshold };
      }
    }
  }

  return best;
}

/**
 * Convertit le tampon BGRA en grille de luminances moyennes par bloc.
 *
 * La moyenne (et non un echantillonnage ponctuel) est volontaire : elle fond le
 * texte clair dans le fond sombre de l'infobulle, si bien que la boite apparait
 * comme une zone pleine et non comme un rectangle troue de lettres.
 */
function downsampleToGray(
  bgra: Buffer,
  width: number,
  height: number,
  block: number,
  gridWidth: number,
  gridHeight: number,
): Uint8Array {
  const cells = new Uint8Array(gridWidth * gridHeight);
  const pixelsPerBlock = block * block;

  for (let gy = 0; gy < gridHeight; gy++) {
    const y0 = gy * block;
    for (let gx = 0; gx < gridWidth; gx++) {
      const x0 = gx * block;
      let sum = 0;
      for (let y = y0; y < y0 + block; y++) {
        let offset = (y * width + x0) * 4;
        for (let x = 0; x < block; x++, offset += 4) {
          // Ordre BGRA, luminance Rec. 601.
          sum += (bgra[offset + 2]! * 299 + bgra[offset + 1]! * 587 + bgra[offset]! * 114) / 1000;
        }
      }
      cells[gy * gridWidth + gx] = sum / pixelsPerBlock;
    }
  }
  return cells;
}

/**
 * Ecart minimal, en luminance, entre le texte et le fond d'une infobulle.
 *
 * Meme grandeur que `MIN_CLASS_SEPARATION` du pretraitement, et pour la meme
 * raison : en dessous, la zone est quasi uniforme et il n'y a rien a lire.
 * L'appliquer ici plutot qu'apres coup permet d'essayer le candidat suivant.
 */
const MIN_TEXT_SEPARATION = 25;

/**
 * Part minimale et maximale de pixels clairs attendue dans une infobulle.
 *
 * Le texte d'un nom d'objet couvre quelques pourcents de la boite : au-dessus de
 * la borne haute, ce n'est plus du texte sur un fond mais deux zones de
 * luminances differentes accolees — un bord d'icone, une bordure de case.
 */
const MIN_TEXT_COVERAGE = 0.012;
const MAX_TEXT_COVERAGE = 0.45;

/** Un pixel sur combien, par axe, est examine par `textCoverage`. */
const TEXT_SAMPLE_STEP = 2;


/**
 * Part de la surface occupee par du texte, ou 0 si le rectangle n'en contient
 * pas.
 *
 * Deux populations de luminance nettement separees, la minoritaire couvrant une
 * petite part de la surface : c'est la signature d'un nom d'objet sur son fond,
 * et ce que ne presente ni un aplat sombre, ni un degrade.
 *
 * La valeur, et pas seulement le verdict, sert au score. Depuis que tous les
 * rectangles pleins d'une composante sont proposes, il faut departager des
 * boites emboitees qui contiennent toutes le meme texte : la bonne est la plus
 * serree autour de lui, donc celle dont la couverture est la plus forte. Un
 * critere binaire les acceptait toutes, et le score, fonde sur la seule largeur,
 * elisait la plus large — celle qui debordait sur le fond, ou pire, une bande
 * qui tranchait le texte en deux.
 *
 * Travaille sur les pixels d'origine, un sur deux par axe : la grille
 * sous-echantillonnee du localisateur a justement efface le texte par moyennage,
 * elle ne peut donc pas servir ici.
 */
function textCoverage(bgra: Buffer, width: number, height: number, rect: Rect): number {
  const x1 = Math.min(width, rect.x + rect.width);
  const y1 = Math.min(height, rect.y + rect.height);

  const histogram = new Uint32Array(256);
  let total = 0;
  for (let y = Math.max(0, rect.y); y < y1; y += TEXT_SAMPLE_STEP) {
    const row = y * width;
    for (let x = Math.max(0, rect.x); x < x1; x += TEXT_SAMPLE_STEP) {
      const offset = (row + x) * 4;
      const value =
        (bgra[offset + 2]! * 299 + bgra[offset + 1]! * 587 + bgra[offset]! * 114) / 1000;
      histogram[value | 0]!++;
      total++;
    }
  }
  if (total < 64) return 0;

  // Seuil d'Otsu : la frontiere qui separe au mieux les deux populations, quelle
  // que soit leur proportion. Un percentile echouerait ici, le texte occupant
  // moins de 5 % des pixels.
  let sum = 0;
  for (let value = 0; value < 256; value++) sum += value * histogram[value]!;

  let bestThreshold = 0;
  let bestVariance = -1;
  let weightLow = 0;
  let sumLow = 0;
  for (let value = 0; value < 256; value++) {
    weightLow += histogram[value]!;
    if (weightLow === 0) continue;
    const weightHigh = total - weightLow;
    if (weightHigh === 0) break;
    sumLow += value * histogram[value]!;
    const meanLow = sumLow / weightLow;
    const meanHigh = (sum - sumLow) / weightHigh;
    const variance = weightLow * weightHigh * (meanLow - meanHigh) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = value;
    }
  }

  let weight = 0;
  let low = 0;
  for (let value = 0; value <= bestThreshold; value++) {
    weight += histogram[value]!;
    low += value * histogram[value]!;
  }
  if (weight === 0 || weight === total) return 0;

  const meanLow = low / weight;
  const meanHigh = (sum - low) / (total - weight);
  if (Math.abs(meanHigh - meanLow) < MIN_TEXT_SEPARATION) return 0;

  // La population minoritaire est le texte, quel que soit son cote : Tarkov
  // ecrit clair sur sombre, mais rien n'interdit l'inverse sur un fond clair.
  const coverage = Math.min(weight, total - weight) / total;
  if (coverage < MIN_TEXT_COVERAGE || coverage > MAX_TEXT_COVERAGE) return 0;
  return coverage;
}

/** Marque les cellules recouvertes par la zone a ignorer (la carte de prix). */
function buildExclusionMask(
  exclude: Rect | null,
  block: number,
  gridWidth: number,
  gridHeight: number,
): Uint8Array {
  const mask = new Uint8Array(gridWidth * gridHeight);
  if (!exclude) return mask;

  const x0 = Math.max(0, Math.floor(exclude.x / block));
  const y0 = Math.max(0, Math.floor(exclude.y / block));
  const x1 = Math.min(gridWidth - 1, Math.ceil((exclude.x + exclude.width) / block));
  const y1 = Math.min(gridHeight - 1, Math.ceil((exclude.y + exclude.height) / block));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) mask[y * gridWidth + x] = 1;
  }
  return mask;
}

/**
 * Fermeture morphologique : rebouche les interruptions courtes du masque, en
 * ligne puis en colonne. Sans elle, le texte de l'infobulle scinderait la boite
 * en plusieurs composantes et ferait chuter le taux de remplissage.
 */
function closeGaps(mask: Uint8Array, width: number, height: number): void {
  // --- Horizontal ---
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let lastSet = -1;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 1) continue;
      const gap = x - lastSet - 1;
      if (lastSet >= 0 && gap > 0 && gap <= CLOSE_GAP_X) {
        for (let fill = lastSet + 1; fill < x; fill++) mask[row + fill] = 1;
      }
      lastSet = x;
    }
  }

  // --- Vertical ---
  for (let x = 0; x < width; x++) {
    let lastSet = -1;
    for (let y = 0; y < height; y++) {
      if (mask[y * width + x] !== 1) continue;
      const gap = y - lastSet - 1;
      if (lastSet >= 0 && gap > 0 && gap <= CLOSE_GAP_Y) {
        for (let fill = lastSet + 1; fill < y; fill++) mask[fill * width + x] = 1;
      }
      lastSet = y;
    }
  }
}

interface Component {
  /** Identifiant attribue dans `labels`. Necessaire pour rogner la composante. */
  label: number;
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Construit l'echelle de seuils balayee, du plus sombre vers la mediane.
 *
 * Espacement **quadratique**, et non lineaire : les paliers se resserrent vers le
 * noir. Ce n'est pas un raffinement, c'est ce qui rend certaines infobulles
 * detectables.
 *
 * Mesure sur un echantillon preleve en jeu, la ou la detection echouait
 * systematiquement :
 *
 *   boite infobulle   mediane   0   (noir pur, texte jusqu'a 201)
 *   grille vide       mediane   6
 *   fenetre entiere   mediane  19
 *
 * L'infobulle est donc **plus sombre que ce qui l'entoure**, et non l'inverse
 * comme le supposait la conception d'origine. Pour l'isoler il faut un seuil a
 * 1, 2 ou 3 : au-dela, la grille vide entre dans le masque et fusionne avec
 * elle.
 *
 * L'echelle lineaire donnait `[3, 5, 8, 11, 14, 16]`, dont le plancher `>= 4`
 * retirait encore le 3. Le seuil le plus bas etait donc 5 — au-dessus de la
 * grille vide. Aucun palier ne pouvait separer les deux, quel que soit le
 * nombre de paliers, puisqu'ils etaient tous places dans la moitie haute de la
 * plage ou tout est deja fusionne.
 *
 * L'espacement quadratique donne `[1, 2, 3, 6, 10, 14]` sur la meme scene : les
 * trois premiers isolent l'infobulle, les trois derniers couvrent les cas ou
 * elle est plus claire que son fond. Meme nombre d'etiquetages, donc meme cout.
 */
function buildThresholdLadder(darkest: number, median: number): number[] {
  const span = median - darkest;
  if (span < 8) return [];
  // 6 paliers plutot que 8 : deux seuils voisins produisent le meme masque, et
  // chaque palier coute un etiquetage complet. Gain direct sur la latence.
  const STEPS = 6;
  const ladder: number[] = [];
  for (let i = 1; i <= STEPS; i++) {
    const fraction = i / (STEPS + 1);
    const value = Math.round(darkest + span * fraction * fraction);
    // Un seuil a 0 ne selectionne que le noir absolu, souvent rien du tout ; le
    // plancher a 1 est le premier qui puisse contenir une boite.
    // Deduplique : sur une scene peu contrastee plusieurs pas se confondent.
    if (value >= 1 && ladder[ladder.length - 1] !== value) ladder.push(value);
  }
  return ladder;
}

/**
 * Enumere les rectangles **entierement pleins** maximaux de la composante.
 *
 * C'est ce qui separe l'infobulle des icones sombres auxquelles elle touche.
 * L'infobulle se superpose a l'inventaire : ses bords touchent forcement les
 * icones situees derriere, et l'etiquetage en composantes connexes les fusionne
 * en une seule forme, souvent en L. Le corps rectangulaire plein de l'infobulle
 * est alors l'un des rectangles pleins de cette forme.
 *
 * Pourquoi enumerer, et non retenir le plus grand
 * -----------------------------------------------
 * La version precedente ne rendait qu'un rectangle par composante : le plus
 * grand. Cela suffit tant que l'infobulle domine sa composante — mais elle peut
 * toucher une **grande zone sombre**, par exemple les cases vides de
 * l'inventaire, qui sont aussi noires qu'elle. La composante fusionnee a alors
 * pour plus grand rectangle cette zone vide, laquelle est ecartee par les bornes
 * de taille ; et l'infobulle, pourtant dans la meme composante, n'etait jamais
 * evaluee.
 *
 * Constate en jeu sur « Key tool » place dans le POUCH, contre une grande zone
 * vide : aucune detection du tout. Le meme objet ailleurs, sur des icones plus
 * claires, etait reconnu immediatement — le defaut ne dependait pas de l'objet
 * mais de son voisinage. Meme cause pour la « zone noire » relevee plus tot a
 * cote de l'infobulle du FN SCAR-H.
 *
 * L'algorithme visitait deja tous ces rectangles ; il n'en gardait qu'un. Les
 * exposer tous ne coute donc rien de plus, et laisse l'appelant appliquer ses
 * criteres — taille, distance, presence de texte — a chacun.
 *
 * Algorithme du plus grand rectangle dans un histogramme, applique ligne par
 * ligne : `heights[i]` compte les cellules pleines consecutives se terminant a
 * la ligne courante, et une pile monotone croissante donne, en un seul parcours,
 * tous les rectangles maximaux s'appuyant sur cette ligne. Cout total O(largeur
 * x hauteur) de la boite englobante.
 */
interface TrimmedBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function largestSolidRect(
  labels: Int32Array,
  width: number,
  component: Component,
): TrimmedBox | null {
  let best: TrimmedBox | null = null;
  let bestArea = 0;

  forEachSolidRect(labels, width, component, (minX, maxX, minY, maxY) => {
    const area = (maxX - minX + 1) * (maxY - minY + 1);
    if (area > bestArea) {
      bestArea = area;
      best = { minX, maxX, minY, maxY };
    }
  });

  return best;
}

function forEachSolidRect(
  labels: Int32Array,
  width: number,
  component: Component,
  visit: (minX: number, maxX: number, minY: number, maxY: number) => void,
): void {
  const { minX, maxX, minY, maxY, label } = component;
  const span = maxX - minX + 1;

  const heights = new Int32Array(span);
  // Piles paralleles : hauteur de la barre, et abscisse ou elle commence.
  const stackHeight = new Int32Array(span + 1);
  const stackLeft = new Int32Array(span + 1);

  for (let y = minY; y <= maxY; y++) {
    const row = y * width;
    for (let i = 0; i < span; i++) {
      heights[i] = labels[row + minX + i] === label ? heights[i]! + 1 : 0;
    }

    let top = 0;
    // L'iteration va jusqu'a `span` inclus, avec une barre virtuelle de hauteur
    // nulle : elle force le depilement final sans dupliquer le code.
    for (let i = 0; i <= span; i++) {
      const height = i < span ? heights[i]! : 0;
      let left = i;
      while (top > 0 && stackHeight[top - 1]! > height) {
        top--;
        const barHeight = stackHeight[top]!;
        left = stackLeft[top]!;
        // Un rectangle degenere (une seule ligne ou colonne) n'est jamais une
        // infobulle : inutile de le proposer.
        if (barHeight > 1 && i - left > 1) {
          visit(minX + left, minX + i - 1, y - barHeight + 1, y);
        }
      }
      if (height > 0) {
        stackHeight[top] = height;
        stackLeft[top] = left;
        top++;
      }
    }
  }
}

/**
 * Etiquetage en composantes connexes (4-connexite), parcours en profondeur avec
 * pile explicite — une recursion deborderait sur les grandes composantes.
 * Les tampons `labels` et `stack` sont fournis par l'appelant pour eviter une
 * reallocation a chaque seuil essaye.
 */
function findComponents(
  mask: Uint8Array,
  labels: Int32Array,
  stack: Int32Array,
  width: number,
  height: number,
): Component[] {
  const components: Component[] = [];
  let label = 0;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || labels[start] !== 0) continue;

    label++;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;

    let area = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (top > 0) {
      const index = stack[--top]!;
      const x = index % width;
      const y = (index - x) / width;

      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (y > 0) push(index - width);
      if (y < height - 1) push(index + width);
    }

    components.push({ label, area, minX, maxX, minY, maxY });

    function push(neighbour: number): void {
      if (mask[neighbour] !== 1 || labels[neighbour] !== 0) return;
      labels[neighbour] = label;
      stack[top++] = neighbour;
    }
  }

  return components;
}

/** Distance euclidienne d'un point au rectangle. 0 si le point est dedans. */
function distanceToRect(x: number, y: number, rect: Rect): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/**
 * Le rectangle contient-il le curseur ?
 *
 * Tarkov ancre son infobulle **a cote** du curseur, jamais dessous : le curseur
 * survole l'icone de l'objet, et l'infobulle se place au-dessus, en dessous ou
 * sur le cote selon la place disponible. Un rectangle qui *contient* le curseur
 * n'est donc pas l'infobulle, mais le panneau d'interface situe derriere elle.
 *
 * Sans cette regle, `distanceToRect` renvoyait 0 pour tout rectangle englobant
 * le curseur : un grand panneau sombre passait le filtre de distance sans
 * difficulte, puis gagnait au score — qui recompense l'aire. Constate en jeu :
 * l'outil cadrait un panneau de ~1100 px de large a la place d'une infobulle de
 * ~200 px, lisait son contenu, et affichait un objet sans aucun rapport.
 */
function containsPoint(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/** Valeur sous laquelle se trouve `ratio` de la population. */
function percentile(values: Uint8Array, ratio: number): number {
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[value]!++;
  const target = values.length * ratio;
  let cumulative = 0;
  for (let value = 0; value < 256; value++) {
    cumulative += histogram[value]!;
    if (cumulative >= target) return value;
  }
  return 255;
}
