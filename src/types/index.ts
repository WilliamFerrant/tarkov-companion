/**
 * types/index.ts
 * --------------
 * Contrats de donnees partages entre le process principal, les preloads et les
 * fenetres. Ce fichier ne contient aucune logique : uniquement des types et les
 * valeurs par defaut de la configuration.
 */

/**
 * Nom de l'application, tel qu'Electron le derive du package.json.
 *
 * Il determine le dossier `userData`, donc l'emplacement de la configuration,
 * des caches et des journaux. Les outils lances par `--entry <fichier.js>` ne
 * demarrent pas sur le dossier du projet et n'heritent pas de ce nom : ils
 * doivent le reposer explicitement pour viser le meme dossier que l'application.
 */
export const APP_NAME = 'tarkov-price-hover';

/** Mode de jeu supporte par l'API tarkov.dev. Les prix different entre les deux. */
export type GameMode = 'regular' | 'pve';

/** Un vendeur (trader ou Flea Market) tel que renvoye par `sellFor`. */
export interface VendorOffer {
  /** Nom lisible, ex. "Therapist", "Flea Market". */
  vendorName: string;
  /** Slug stable, ex. "therapist", "flea-market". Utilise pour les comparaisons. */
  vendorSlug: string;
  /** Prix converti en roubles par l'API. C'est la seule valeur comparable. */
  priceRUB: number;
}

/** Item tel que stocke en cache, apres normalisation de la reponse GraphQL. */
export interface TarkovItem {
  id: string;
  name: string;
  shortName: string;
  basePrice: number;
  /** Prix moyen Flea sur 24h. `null` si l'item n'est pas vendable au Flea. */
  avg24hPrice: number | null;
  /** Derniere offre la plus basse observee au Flea. */
  lastLowPrice: number | null;
  /** Largeur en cases d'inventaire. */
  width: number;
  /** Hauteur en cases d'inventaire. */
  height: number;
  iconLink: string | null;
  /** Categories tarkov.dev ("gun", "barter", "noFlea", ...). */
  types: string[];
  sellFor: VendorOffer[];
  /**
   * Libelles supplementaires indexes pour la correspondance OCR, en plus de
   * `name` et `shortName`. L'API JSON y place le slug `normalizedName`, qui
   * couvre 100 % des items la ou le nom reconstruit depuis le wiki en manque
   * quelques pourcents.
   */
  searchAliases?: string[];
}

/**
 * Source de donnees des prix.
 *   `json`    — https://json.tarkov.dev, la voie vivante et recommandee.
 *   `graphql` — https://api.tarkov.dev/graphql, hors service depuis 07/2026.
 *   `auto`    — JSON en premier, repli sur GraphQL en cas d'echec.
 */
export type DataSource = 'auto' | 'json' | 'graphql';

/** Contenu du fichier de cache sur disque, par mode de jeu. */
export interface CacheFile {
  /** Version du format. Un increment invalide les caches plus anciens. */
  version: number;
  gameMode: GameMode;
  /** Epoch ms de la derniere recuperation reussie. */
  fetchedAt: number;
  items: TarkovItem[];
}

/**
 * Donnees pretes a l'affichage, calculees a partir d'un `TarkovItem`.
 * Le renderer overlay ne manipule que ce type.
 */
export interface PriceSummary {
  id: string;
  name: string;
  shortName: string;
  iconLink: string | null;
  width: number;
  height: number;
  slots: number;
  avg24hPrice: number | null;
  lastLowPrice: number | null;
  basePrice: number;
  /** Meilleure offre trader (Flea exclu), ou `null` si aucun trader n'achete. */
  bestTrader: VendorOffer | null;
  /** Prix Flea de reference divise par le nombre de slots. */
  pricePerSlot: number | null;
  /**
   * Delta entre la reference Flea et le meilleur trader.
   * Positif = vendre au Flea rapporte plus. `null` si l'un des deux manque.
   */
  fleaVsTrader: number | null;
  /** L'item est interdit au Flea Market (type "noFlea"). */
  noFlea: boolean;
  /** Score de confiance du matching OCR, entre 0 et 1. */
  matchScore: number;
  /** Texte OCR brut ayant produit ce match. Utile en mode debug. */
  matchedFrom: string;
}

/**
 * Strategie de cadrage de la zone analysee.
 *   `auto`   — l'infobulle est localisee automatiquement autour du curseur.
 *              Aucune calibration, s'adapte a toute resolution et a la position
 *              variable de l'infobulle (Tarkov la place au-dessus, en dessous,
 *              a gauche ou a droite selon la place disponible).
 *   `manual` — rectangle fixe relatif au curseur. Filet de securite si la
 *              detection automatique echoue sur une configuration donnee.
 */
export type CaptureMode = 'auto' | 'manual';

/** Zone de capture ecran, en pixels logiques relatifs au curseur (mode manuel). */
export interface CaptureRegion {
  /** Decalage horizontal du bord gauche de la zone par rapport au curseur. */
  offsetX: number;
  /** Decalage vertical du bord haut de la zone par rapport au curseur. */
  offsetY: number;
  width: number;
  height: number;
}

/** Configuration persistante complete (config.json). */
export interface AppConfig {
  gameMode: GameMode;
  /** Source des prix. Voir `DataSource`. */
  dataSource: DataSource;
  /** Periode de rafraichissement des prix, en minutes. */
  refreshIntervalMinutes: number;
  /** L'overlay est-il actif (bascule par hotkey). */
  overlayEnabled: boolean;
  /** L'overlay laisse passer les clics vers le jeu. */
  clickThrough: boolean;
  /** Affiche le panneau debug et conserve les captures OCR. */
  debugMode: boolean;
  /** N'analyse l'ecran que si Tarkov est la fenetre au premier plan. */
  onlyWhenGameFocused: boolean;
  /** Nom de process (sans .exe) considere comme etant le jeu. */
  gameProcessName: string;
  /** Strategie de cadrage. `auto` par defaut : rien a calibrer. */
  captureMode: CaptureMode;
  /** Zone capturee autour du curseur. Utilisee uniquement si `captureMode` vaut `manual`. */
  captureRegion: CaptureRegion;
  /** Immobilite du curseur requise avant de declencher un OCR, en ms. */
  hoverSettleMs: number;
  /** Intervalle minimal entre deux OCR, en ms. Garde-fou CPU. */
  minOcrIntervalMs: number;
  /** Deplacement (px) au-dela duquel on considere que le curseur a bouge. */
  cursorMoveThresholdPx: number;
  /** Score minimal de similarite pour accepter un match. */
  matchThreshold: number;
  /** N'affiche pas les items dont le prix de reference est sous ce seuil. */
  minPriceFilter: number;
  /** Masque l'overlay apres ce delai sans nouveau match, en ms. */
  autoHideMs: number;
  /**
   * Ecrit des echantillons de calibration sur disque a chaque identification.
   *
   * Volontairement separe de `debugMode` et desactive par defaut : chaque
   * echantillon encode une image de 1,2 Mpx en PNG puis l'ecrit sur disque, de
   * facon **synchrone** dans le process principal. C'est plusieurs dizaines de
   * millisecondes de blocage par detection — imperceptible hors jeu, mais un
   * generateur de saccades par-dessus Tarkov.
   *
   * A n'activer que le temps de collecter des donnees.
   */
  collectCalibration: boolean;
  /**
   * Maintient un flux de capture d'ecran permanent.
   *
   * C'est le seul poste qui consomme **en continu**, meme quand rien n'est
   * survole : une duplication de bureau ouverte en permanence coute des images
   * par seconde au jeu, d'autant plus en 4K. C'est aussi ce qui rend la capture
   * quasi instantanee (~15 ms au lieu de ~230).
   *
   * L'arbitrage est reel et personnel, d'ou ce reglage :
   *
   *   true   capture ~15 ms, carte affichee plus tot, cout GPU permanent
   *   false  capture ~230 ms, ~200 ms de plus par survol, **aucun cout au repos**
   *
   * Par defaut a `false` : un jeu fluide prime sur deux dixiemes de seconde.
   */
  useCaptureStream: boolean;
  /** Affiche l'icone de l'item. Necessite un acces reseau. */
  showIcon: boolean;
  /**
   * La carte suit le curseur tant qu'elle est affichee.
   *
   * Desactive par defaut, et ce n'est pas un choix esthetique. Une fenetre
   * transparente ne peut pas etre presentee en « independent flip » : chacune de
   * ses images repasse par le DWM, qui recompose alors la fenetre du jeu. Le
   * suivi, emis a la cadence du sondage curseur, impose donc ~40 recompositions
   * par seconde tant qu'une carte est visible — la ou la detection elle-meme n'en
   * demande que huit. Il oblige de plus a dimensionner la fenetre bien plus
   * grande que la carte (550x566 pour 230x246), pour que celle-ci puisse y
   * glisser : cinq fois plus de surface a recomposer a chaque image.
   *
   * Activez-le si votre machine l'absorbe ; c'est plus agreable a l'oeil.
   */
  overlayFollowCursor: boolean;
  /**
   * Fenetre overlay transparente.
   *
   * Trois tests successifs ont etabli que **l'affichage de la carte est la seule
   * cause de saccade restante** : capture de region seule, Electron sans
   * detection, puis chaine complete sans carte affichee — aucun des trois ne
   * fait saccader le jeu ; la carte affichee, si.
   *
   * Une fenetre transparente coute nettement plus cher a composer par-dessus un
   * jeu qu'une fenetre opaque : chaque image doit etre melangee au fond, et
   * Windows ne peut plus presenter le jeu par le chemin direct. Passer a
   * `false` rend la carte rectangulaire, sans coins arrondis ni fondu, mais
   * supprime ce melange.
   */
  overlayTransparent: boolean;
  /**
   * La fenetre overlay reste visible en permanence, et couvre l'ecran.
   *
   * Un jeu en borderless est presente par Windows en **flip direct** : le jeu
   * ecrit sa frame, l'ecran l'affiche, le DWM ne touche a rien. Des qu'une
   * fenetre au premier plan recouvre la sienne, Windows abandonne ce chemin et
   * repasse en composition complete.
   *
   * Ce n'est pas la presence de la fenetre qui coute le plus, c'est le
   * **basculement**. Constate en jeu, une fois toutes les autres causes
   * eliminees : la saccade tombe exactement a l'instant ou la carte apparait,
   * puis tout est fluide tant qu'elle reste affichee, et recommence a la
   * suivante.
   *
   * Ce mode echange les a-coups contre un cout constant : le jeu s'installe une
   * fois en composition et n'en sort plus. On y perd quelques images par
   * seconde en permanence, on n'y subit plus de micro-blocages. Selon la
   * machine et la sensibilite, l'un ou l'autre gene davantage — d'ou le
   * reglage plutot qu'un choix impose.
   */
  overlayPersistent: boolean;
  /**
   * Acceleration materielle de Chromium.
   *
   * Coupee un temps sur l'hypothese — fausse — que la presence d'Electron
   * volait des images au jeu. Sans elle, une fenetre transparente est composee
   * par le processeur : cela aggrave exactement le seul cout qui restait.
   *
   * Lu directement dans `config.json` au demarrage, avant l'initialisation
   * d'Electron : ce choix ne peut pas etre fait plus tard.
   */
  hardwareAcceleration: boolean;
  /** Opacite de la carte overlay, 0.1 a 1. */
  overlayOpacity: number;
  /** Facteur d'echelle de la carte overlay. */
  overlayScale: number;
  hotkeys: {
    toggleOverlay: string;
    toggleDebug: string;
    openSettings: string;
  };
}

/** Valeurs par defaut. Toute cle absente de config.json est comblee ici. */
export const DEFAULT_CONFIG: AppConfig = {
  gameMode: 'regular',
  dataSource: 'auto',
  refreshIntervalMinutes: 12,
  overlayEnabled: true,
  clickThrough: true,
  debugMode: false,
  onlyWhenGameFocused: true,
  gameProcessName: 'EscapeFromTarkov',
  captureMode: 'auto',
  // Utilise uniquement en mode manuel. Volontairement large et centre sur le
  // curseur : l'infobulle Tarkov peut apparaitre de n'importe quel cote.
  captureRegion: { offsetX: -260, offsetY: -140, width: 700, height: 300 },
  // Reactivite : ces deux valeurs dominent la latence ressentie, bien avant le
  // pipeline lui-meme (~70 ms). L'infobulle Tarkov apparait avec un leger delai,
  // donc le premier essai tombe souvent a vide : c'est `minOcrIntervalMs` qui
  // fixe le delai avant le second, et donc l'impression de lenteur.
  // Tarkov dessine son infobulle ~300 ms apres l'immobilisation : les premiers
  // cycles tombent forcement a vide. Sonder plus tot et plus souvent rapproche
  // la detection de l'instant exact ou l'infobulle apparait, et un cycle qui ne
  // trouve rien ne coute que capture + cadrage (~60 ms), sans OCR.
  hoverSettleMs: 50,
  minOcrIntervalMs: 90,
  cursorMoveThresholdPx: 6,
  // 0.62 laissait passer des correspondances a 63 % sur du texte d'interface
  // quelconque — un prix faux est pire que pas de prix. Les lectures OCR
  // legitimes, meme tres bruitees, scorent 0,71 et plus (voir test:match).
  matchThreshold: 0.68,
  minPriceFilter: 0,
  // La carte est ancree a l'infobulle, pas au curseur : elle peut rester
  // affichee longtemps sans gener. 2,5 s etait bien trop court en jeu.
  autoHideMs: 8000,
  collectCalibration: false,
  useCaptureStream: false,
  showIcon: true,
  overlayFollowCursor: false,
  overlayTransparent: true,
  // Actif par defaut : c'est le seul reglage qui ait supprime les saccades, une
  // fois toutes les autres causes eliminees par la mesure. Le cout — quelques
  // images par seconde en continu — est preferable aux micro-blocages qu'il
  // remplace. Voir `overlayPersistent`.
  overlayPersistent: true,
  hardwareAcceleration: true,
  overlayOpacity: 0.95,
  overlayScale: 1,
  hotkeys: {
    toggleOverlay: 'Control+Shift+P',
    toggleDebug: 'Control+Shift+D',
    openSettings: 'Control+Shift+O',
  },
};

/** Etat du cache expose a l'UI de configuration. */
export interface CacheStatus {
  gameMode: GameMode;
  itemCount: number;
  /** Epoch ms, ou `null` si aucun cache n'a jamais ete constitue. */
  fetchedAt: number | null;
  /** Une recuperation reseau est en cours. */
  refreshing: boolean;
  /** Message de la derniere erreur reseau, s'il y en a eu une. */
  lastError: string | null;
  /** Les donnees viennent du disque, pas du reseau (mode degrade). */
  stale: boolean;
  /**
   * Epoch ms de la prochaine tentative de rattrapage automatique, ou `null`.
   * Renseigne uniquement quand le cache est vide : voir `PriceCache`.
   */
  nextRetryAt: number | null;
}

/** Instantane transmis au panneau debug apres chaque tentative de detection. */
export interface DebugFrame {
  timestamp: number;
  /** Mode de cadrage utilise pour cette tentative. */
  mode: CaptureMode;
  /** Capture pretraitee envoyee a Tesseract, en data URL PNG. */
  imageDataUrl: string | null;
  /**
   * Apercu de la fenetre de recherche complete, en data URL PNG. Indispensable
   * quand la detection echoue : il montre si l'infobulle etait seulement
   * presente a l'ecran au moment de la capture.
   */
  searchDataUrl: string | null;
  /** Rectangle finalement analyse, en pixels physiques ecran. */
  rect: { x: number; y: number; width: number; height: number } | null;
  /** Taux de remplissage de la boite detectee, `null` en mode manuel. */
  fillRatio: number | null;
  /** Texte brut renvoye par l'OCR. */
  rawText: string;
  /** Confiance globale Tesseract (0-100). */
  ocrConfidence: number;
  /** Meilleurs candidats du matching flou. */
  candidates: Array<{ name: string; score: number }>;
  /** Duree totale capture + cadrage + pretraitement, en ms. */
  captureMs: number;
  /** Decoupage detaille des temps, pour identifier l'etape couteuse. */
  timings: { grabMs: number; locateMs: number; preprocessMs: number; totalMs: number } | null;
  /** Duree de l'OCR, en ms. */
  ocrMs: number;
  /** Raison d'un abandon precoce (jeu non focus, cache vide, ...). */
  skippedReason: string | null;
}
