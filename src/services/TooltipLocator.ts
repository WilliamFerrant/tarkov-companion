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
 * de `MAX_CURSOR_DISTANCE`. 0,35 donne un facteur ~0,9 pour une boite collee au
 * curseur et ~0,06 a la distance limite.
 */
const PROXIMITY_FALLOFF = 0.35;
/** Cote du bloc de sous-echantillonnage a 1080p. */
const BLOCK_AT_1080P = 4;

/** Ecart horizontal maximal rebouche par la fermeture, en cellules. */
const CLOSE_GAP_X = 6;
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
      // Retire les appendices (icones sombres touchant l'infobulle) pour ne
      // garder que le corps rectangulaire plein.
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

      // Plein a 100 % par construction : `largestSolidRect` ne renvoie que des
      // rectangles entierement remplis. Le seuil de remplissage d'autrefois est
      // donc devenu inutile — et le critere est desormais strictement plus fort
      // qu'un simple taux : une silhouette d'objet ne contient aucun grand
      // rectangle plein, elle est ecartee par les bornes dimensionnelles.
      const fillRatio = 1;

      // Le curseur est dans la boite : c'est le panneau de fond, pas l'infobulle.
      if (containsPoint(options.cursorX, options.cursorY, rect)) continue;

      const distance = distanceToRect(options.cursorX, options.cursorY, rect);
      if (distance > limits.maxDistance) continue;

      // L'infobulle est la boite pleine **collee** au curseur. Le remplissage
      // ecarte les composantes etendues mais creuses (grille, decor) ; la
      // decroissance exponentielle avec la distance ecarte les panneaux
      // d'interface, qui sont plus grands mais plus loin.
      //
      // Ponderer par la seule aire revenait a elire systematiquement le plus
      // grand rectangle sombre du voisinage. Avec ce facteur, une boite situee a
      // `maxDistance` doit etre ~17 fois plus grande que l'infobulle pour la
      // supplanter, au lieu de gagner des qu'elle est un peu plus large.
      // Score sur la **largeur** seule, jamais sur l'aire.
      //
      // Ponderer par l'aire faisait gagner tout rectangle plus haut, alors que la
      // hauteur d'une infobulle est deja bornee par `MIN_HEIGHT` / `MAX_HEIGHT` :
      // elle n'apporte donc aucune information supplementaire, et elle permettait
      // a un compteur de durabilite (200x80) de battre une infobulle courte mais
      // correcte (97x40) — observe en jeu sur « Chainlet ».
      //
      // La largeur, elle, discrimine reellement : une infobulle est un bandeau
      // large et bas, la plupart des fragments d'interface sont compacts.
      const proximity = Math.exp(-distance / (PROXIMITY_FALLOFF * limits.maxDistance));
      const score = rect.width * fillRatio * proximity;
      if (score > bestScore) {
        bestScore = score;
        best = { rect, fillRatio, threshold };
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
 * Un pas fin est inutile : deux seuils voisins produisent le meme masque.
 */
function buildThresholdLadder(darkest: number, median: number): number[] {
  const span = median - darkest;
  if (span < 8) return [];
  // 6 paliers plutot que 8 : deux seuils voisins produisent le meme masque, et
  // chaque palier coute un etiquetage complet. Gain direct sur la latence.
  const STEPS = 6;
  const ladder: number[] = [];
  for (let i = 1; i <= STEPS; i++) {
    const value = Math.round(darkest + (span * i) / (STEPS + 1));
    // Deduplique : sur une scene peu contrastee plusieurs pas se confondent.
    if (value >= 4 && ladder[ladder.length - 1] !== value) ladder.push(value);
  }
  return ladder;
}

interface TrimmedBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Nombre de cellules de la composante contenues dans la boite rognee. */
  area: number;
}

/**
 * Plus grand rectangle **entierement plein** contenu dans la composante.
 *
 * C'est ce qui separe l'infobulle des icones sombres auxquelles elle touche.
 * L'infobulle se superpose a l'inventaire : ses bords touchent forcement les
 * icones situees derriere, et l'etiquetage en composantes connexes les fusionne
 * en une seule forme, souvent en L. Le corps rectangulaire plein de l'infobulle
 * est alors le plus grand rectangle plein de cette forme.
 *
 * Remplace un rognage glouton qui retirait les lignes de bord avant les
 * colonnes. Sur une forme en L, cet ordre fixe convergeait vers le mauvais bras :
 * face a une icone plus haute que l'infobulle, il mangeait les lignes de
 * l'infobulle — texte compris — avant d'avoir retire les colonnes de l'icone.
 * Le nom devenait illisible alors que la boite etait parfaitement detectee.
 *
 * Algorithme du plus grand rectangle dans un histogramme, applique ligne par
 * ligne : `heights[i]` compte les cellules pleines consecutives se terminant a
 * la ligne courante, et une pile monotone croissante donne, en un seul parcours,
 * le plus grand rectangle s'appuyant sur cette ligne. Cout total O(largeur x
 * hauteur) de la boite englobante — du meme ordre que le rognage qu'il remplace,
 * mais exact au lieu d'approche.
 */
function largestSolidRect(labels: Int32Array, width: number, component: Component): TrimmedBox | null {
  const { minX, maxX, minY, maxY, label } = component;
  const span = maxX - minX + 1;

  const heights = new Int32Array(span);
  // Piles paralleles : hauteur de la barre, et abscisse ou elle commence.
  const stackHeight = new Int32Array(span + 1);
  const stackLeft = new Int32Array(span + 1);

  let best: TrimmedBox | null = null;
  let bestArea = 0;

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
        const area = barHeight * (i - left);
        if (area > bestArea) {
          bestArea = area;
          best = {
            minX: minX + left,
            maxX: minX + i - 1,
            minY: y - barHeight + 1,
            maxY: y,
            area,
          };
        }
      }
      if (height > 0) {
        stackHeight[top] = height;
        stackLeft[top] = left;
        top++;
      }
    }
  }

  // Un rectangle degenere (une seule ligne ou colonne) n'est jamais une infobulle.
  if (!best || best.maxX <= best.minX || best.maxY <= best.minY) return null;
  return best;
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
