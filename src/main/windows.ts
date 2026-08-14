/**
 * main/windows.ts
 * ---------------
 * Creation et pilotage des deux fenetres de l'application.
 *
 * Fenetre overlay
 *   Sans cadre, transparente, sans ombre, non focalisable, hors barre des taches.
 *   Elle est volontairement *petite* et repositionnee a chaque affichage, plutot
 *   que d'occuper tout l'ecran en permanence : une surface transparente plein
 *   ecran doit etre recomposee par le DWM a chaque frame du jeu, ce qui coute
 *   des FPS. Une petite fenetre affichee ponctuellement est quasi gratuite.
 *
 *   `setAlwaysOnTop(true, 'screen-saver')` est le niveau necessaire pour passer
 *   au-dessus d'un jeu en plein ecran fenetre (borderless). Le plein ecran
 *   exclusif, lui, ne peut pas etre survole : voir README.
 *
 * Fenetre de configuration
 *   Fenetre classique, creee au demarrage mais masquee. La recreer a chaque
 *   ouverture couterait ~300 ms ; la garder en memoire coute quelques Mo.
 */

import { BrowserWindow, screen, app } from 'electron';
import path from 'node:path';
import type { AppConfig } from '../types/index';
import { IPC } from '../types/ipc';
import { createLogger } from '../services/Logger';

const log = createLogger('windows');

/**
 * Largeur fixe de la carte overlay, en pixels logiques (avant `overlayScale`).
 *
 * 250 au lieu de 380 : la carte ne reprend plus le nom de l'objet, qui dictait
 * sa largeur. Il ne reste que des libelles courts et des montants, et une carte
 * etroite masque d'autant moins l'inventaire.
 */
const OVERLAY_WIDTH = 170;
/**
 * Hauteur initiale de la carte, avant mise a l'echelle, en pixels logiques.
 * Corrigee des que le renderer a mesure son contenu reel.
 */
const OVERLAY_DEFAULT_HEIGHT = 130;

/**
 * Decalage de la carte par rapport au curseur, en pixels logiques.
 *
 * En bas a droite, comme une infobulle classique. L'infobulle de Tarkov, elle,
 * se developpe vers le **haut** (bord haut mesure a -83, bord bas a -33) : se
 * poser sous le curseur garantit donc de ne jamais la recouvrir, sans avoir a
 * connaitre sa hauteur.
 *
 * `CARD_OFFSET_X` sert aussi d'ecart symetrique lors de la bascule a gauche pres
 * du bord droit de l'ecran.
 */
const CARD_OFFSET_X = 14;
const CARD_OFFSET_Y = 22;

/**
 * Ecart minimal entre l'infobulle du jeu et la carte.
 *
 * Le localisateur ne cadre que la ligne du nom, alors que la boite dessinee par
 * le jeu est un peu plus haute : cet ecart absorbe la difference, sans quoi la
 * carte mordrait encore sur son bord.
 */
const TOOLTIP_GAP = 10;

/** Les deux rectangles se recouvrent-ils ? */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

const rendererDir = path.join(__dirname, '..', 'renderer');
const preloadDir = path.join(__dirname, '..', 'preload');

let overlayWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
/**
 * Hauteur de la carte, en pixels **deja mis a l'echelle**.
 *
 * Le renderer applique `--scale` a chacune de ses dimensions : la hauteur qu'il
 * mesure inclut donc deja `overlayScale`. La remultiplier cote principal
 * surestimait la carte de 60 % a l'echelle 1,6 — 346 px reserves pour 216 px
 * reels. Consequences constatees en jeu : pres du bord bas, la carte remontait
 * de 130 px de trop et recouvrait le curseur ; et le test de recouvrement avec
 * l'infobulle declenchait a tort la bascule laterale.
 *
 * La largeur, elle, n'a jamais eu ce defaut : elle est calculee de la meme
 * facon des deux cotes, `OVERLAY_WIDTH * overlayScale`.
 */
let overlayHeight = OVERLAY_DEFAULT_HEIGHT;
/**
 * Decalage entre le curseur et le coin haut-gauche de la carte, fige lors du
 * dernier affichage. Permet de faire suivre la carte sans nouvelle analyse.
 */
let anchorOffset: { dx: number; dy: number } | null = null;

/**
 * Marge, en pixels logiques, entre la carte et le bord de sa fenetre.
 *
 * C'est cette marge qui rend le suivi fluide. Deplacer une fenetre transparente
 * au premier plan force le DWM a recomposer tout l'ecran ; le faire a la cadence
 * du curseur, par-dessus un jeu en 4K, produit des saccades — constate en jeu.
 *
 * La fenetre est donc dimensionnee plus grande que la carte, positionnee une
 * seule fois a l'apparition, et la carte glisse **a l'interieur** par une simple
 * translation CSS, prise en charge par le compositeur du renderer.
 *
 * 160 px est superieur a `DISMISS_MARGIN_PX` (90) : la carte disparait avant que
 * le curseur ait pu s'eloigner assez pour obliger la fenetre a bouger.
 */
const OVERLAY_PAD = 160;

/**
 * Marge lorsque le suivi du curseur est desactive.
 *
 * La marge n'existe que pour laisser la carte **glisser** a l'interieur de la
 * fenetre. Sans suivi, elle ne sert plus a rien — et elle coute cher : une
 * fenetre de 550x566 pour une carte de 230x246, soit 5,4 fois la surface a
 * recomposer a chaque image.
 *
 * Quelques pixels suffisent alors a loger l'ombre portee du liseré.
 */
const OVERLAY_PAD_STATIC = 4;

/**
 * Fond de la carte, repris de `overlay.css` (`--bg`).
 *
 * Sert uniquement lorsque la fenetre n'est pas transparente : elle doit alors
 * peindre quelque chose, et toute autre couleur laisserait un liseré visible.
 */
const CARD_BACKGROUND = '#0b0b0b';

/**
 * Marge effective, selon que la carte suit le curseur ou non.
 *
 * Pourquoi le suivi coute si cher : une fenetre **transparente** ne peut pas
 * etre presentee en « independent flip » par Chromium — chacune de ses images
 * repasse obligatoirement par le DWM, qui doit alors recomposer la fenetre du
 * jeu. Le suivi, emis a la cadence du sondage curseur, imposait donc ~40
 * recompositions par seconde tant que la carte etait affichee, la ou le pipeline
 * de detection n'en demande que huit. Le commentaire d'origine de `followCursor`
 * affirmait l'inverse — que le glissement restait interne au renderer — ce qui
 * n'est vrai que pour une fenetre opaque.
 */
function overlayPad(config: AppConfig): number {
  if (isFollowing(config)) return OVERLAY_PAD;
  // Sans transparence, la marge serait un aplat visible autour de la carte.
  return config.overlayTransparent ? OVERLAY_PAD_STATIC : 0;
}

/**
 * Le suivi est-il reellement actif ?
 *
 * Il repose entierement sur la marge : la carte glisse **a l'interieur** d'une
 * fenetre plus grande qu'elle. Sur une fenetre opaque, cette marge n'est plus
 * invisible — elle devient un grand rectangle noir autour de la carte, constate
 * en jeu. Les deux reglages sont donc incompatibles, et la transparence
 * l'emporte : sans elle, pas de suivi.
 */
export function isFollowing(config: AppConfig): boolean {
  return config.overlayFollowCursor && config.overlayTransparent;
}

export function createOverlayWindow(config: AppConfig): BrowserWindow {
  const window = new BrowserWindow({
    width: Math.round(OVERLAY_WIDTH * config.overlayScale),
    height: Math.round(OVERLAY_DEFAULT_HEIGHT * config.overlayScale),
    show: false,
    frame: false,
    // Voir `AppConfig.overlayTransparent` : une fenetre transparente est
    // nettement plus couteuse a composer par-dessus un jeu qu'une fenetre
    // opaque, et la mesure a montre que l'affichage de la carte est la seule
    // cause de saccade qui subsiste.
    transparent: config.overlayTransparent,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Empeche l'overlay de voler le focus au jeu : critique, un alt-tab
    // involontaire en pleine raid serait inacceptable.
    focusable: false,
    // Sans transparence, la fenetre doit peindre un fond : celui de la carte,
    // pour que la marge residuelle ne se voie pas.
    backgroundColor: config.overlayTransparent ? '#00000000' : CARD_BACKGROUND,
    webPreferences: {
      preload: path.join(preloadDir, 'overlay.preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // L'overlay est purement passif : rien a animer en arriere-plan.
      backgroundThrottling: false,
    },
  });

  // `overlayHeight` est exprime en pixels deja mis a l'echelle : la valeur par
  // defaut, elle, ne l'est pas encore. Elle tient jusqu'a la premiere mesure du
  // renderer, qui la remplace par la hauteur reelle.
  overlayHeight = Math.round(OVERLAY_DEFAULT_HEIGHT * config.overlayScale);

  // 'screen-saver' est le niveau le plus haut expose par Electron ; c'est le seul
  // qui reste visible au-dessus d'un jeu en borderless fullscreen.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyClickThrough(window, config.clickThrough);

  void window.loadFile(path.join(rendererDir, 'overlay.html'));

  // `OVERLAY_CONFIG` n'etait diffuse que sur *changement* de configuration :
  // au demarrage le renderer ne recevait donc jamais `overlayScale` ni
  // `overlayOpacity`, et restait sur les valeurs par defaut du CSS jusqu'a la
  // premiere modification dans les reglages.
  window.webContents.once('did-finish-load', () => {
    if (!window.isDestroyed()) window.webContents.send(IPC.OVERLAY_CONFIG, config);
  });

  window.on('closed', () => {
    overlayWindow = null;
  });

  overlayWindow = window;
  return window;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}

/**
 * Active ou desactive la transparence aux clics.
 * `forward: true` permet au renderer de continuer a recevoir les evenements de
 * survol (utile pour d'eventuels effets visuels) tout en laissant passer les clics.
 */
export function applyClickThrough(window: BrowserWindow, clickThrough: boolean): void {
  // `forward: false` : le renderer n'a aucun effet de survol a produire, et la
  // fenetre couvre tout l'ecran en mode permanent — lui transmettre chaque
  // mouvement de souris serait du travail pur perte, a la cadence du curseur.
  window.setIgnoreMouseEvents(clickThrough, { forward: false });
}

/**
 * Memorise la hauteur mesuree cote renderer et redimensionne la fenetre.
 *
 * `height` arrive **deja mis a l'echelle** : le renderer applique `--scale` a
 * chacune de ses dimensions avant de mesurer. Aucune multiplication ici.
 */
export function setOverlayHeight(height: number, config: AppConfig): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Bornes larges : a l'echelle 2,5 une carte complete depasse 400 px, et le
  // plancher couvre la carte compacte sans icone ni badge.
  const clamped = Math.max(60, Math.min(900, Math.round(height)));
  if (clamped === overlayHeight) return;
  overlayHeight = clamped;
  // En mode permanent la fenetre couvre l'ecran : sa taille ne depend pas de
  // celle de la carte, et la redimensionner ferait justement le travail qu'on
  // cherche a supprimer.
  if (config.overlayPersistent) return;
  overlayWindow.setBounds({
    ...overlayWindow.getBounds(),
    // La marge fait partie de la fenetre : sans elle, la carte serait rognee des
    // qu'elle glisse vers le bas.
    height: clamped + overlayPad(config) * 2,
  });
}

/**
 * Positionne la carte sous le curseur, a sa droite, puis l'affiche.
 *
 * Position unique et previsible : c'est ce qu'on attend d'une infobulle, et la
 * seule chose qui permette de lire un prix sans chercher la carte des yeux.
 * Elle ne bascule a gauche que pres du bord droit de l'ecran, et ne remonte que
 * du strict necessaire pres du bord bas.
 */
export function showOverlayAt(
  cursor: { x: number; y: number },
  config: AppConfig,
  /**
   * Rectangle de l'infobulle du jeu, en pixels logiques.
   *
   * La carte ne doit jamais le recouvrir — pas par elegance, mais parce que
   * l'analyse suivante lirait alors une infobulle amputee. Constate en jeu :
   * « zone lue 95x40, texte OCR "t injector" », le debut du nom etant cache par
   * la carte.
   */
  avoid: { x: number; y: number; width: number; height: number } | null = null,
): void {
  const window = overlayWindow;
  if (!window || window.isDestroyed()) return;

  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const width = Math.round(OVERLAY_WIDTH * config.overlayScale);
  const height = overlayHeight;

  // Ancrage sur le **curseur**, pas sur l'infobulle detectee.
  //
  // L'ancrage sur l'infobulle supposait que le rectangle detecte couvre toute la
  // boite du jeu. C'est faux des qu'elle compte plusieurs lignes : le
  // localisateur ne cadre que la ligne du nom, et la carte, posee sous cette
  // hauteur partielle, atterrissait au milieu de l'infobulle et masquait sa
  // ligne de prix — visible en jeu.
  //
  // Le curseur, lui, est un repere exact et gratuit. Toutes les mesures montrent
  // l'infobulle **au-dessus** de lui (bord haut a -83, bord bas a -33) : une
  // carte posee en dessous ne peut donc jamais la recouvrir, quelle que soit sa
  // hauteur reelle.
  let x = cursor.x + CARD_OFFSET_X;
  let y = cursor.y + CARD_OFFSET_Y;

  // --- Descendre sous l'infobulle du jeu ---
  //
  // « L'infobulle est toujours au-dessus du curseur » etait une generalisation
  // abusive : pres du bas de l'ecran, Tarkov la place **a cote**, a hauteur du
  // curseur. La carte, posee en bas a droite, atterrissait alors dessus et en
  // cachait le debut — l'analyse suivante ne lisait plus que « t injector ».
  //
  // On se contente donc de passer sous son bord bas quand il descend plus bas
  // que le decalage nominal. Dans le cas courant, l'infobulle etant au-dessus,
  // ce maximum ne change rien.
  if (avoid) y = Math.max(y, avoid.y + avoid.height + TOOLTIP_GAP);

  // --- Bord droit : bascule a gauche du curseur ---
  //
  // Symetrique de la position nominale, et non un simple recalage contre le bord
  // de l'ecran : la carte reste ainsi a distance constante du curseur, d'un cote
  // ou de l'autre. C'est le comportement des infobulles du jeu lui-meme.
  if (x + width > area.x + area.width) {
    x = cursor.x - width - CARD_OFFSET_X;
  }

  // --- Bord bas : on remonte du strict minimum ---
  //
  // La version precedente repliait la carte **au-dessus** du curseur des qu'elle
  // depassait en bas. Sur un objet du bas de l'ecran, elle atterrissait donc a
  // plusieurs centaines de pixels au-dessus, sans rapport visuel avec ce qui
  // etait survole — rapporte en jeu, captures a l'appui.
  //
  // La carte reste desormais ancree en bas a droite du curseur en toute
  // circonstance ; pres du bord, elle se contente de glisser vers le haut juste
  // ce qu'il faut pour rester entiere. Le lien visuel avec le curseur est
  // conserve, ce qui est precisement ce qu'on attend d'une infobulle.
  if (y + height > area.y + area.height) {
    y = area.y + area.height - height;
  }

  // --- Dernier recours : se decaler lateralement ---
  //
  // Tout en bas de l'ecran, la remontee ci-dessus peut ramener la carte sur
  // l'infobulle qu'on venait d'eviter. Il n'y a alors plus de place verticale :
  // on passe a cote, de preference a gauche, ou l'infobulle laisse le plus
  // souvent la place puisqu'elle se developpe vers la droite.
  if (avoid && overlaps({ x, y, width, height }, avoid)) {
    const toLeft = avoid.x - width - TOOLTIP_GAP;
    x = toLeft >= area.x ? toLeft : avoid.x + avoid.width + TOOLTIP_GAP;
  }

  // Garde-fou final : la carte ne doit jamais sortir de la zone de travail.
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));

  // Fige le decalage carte <- curseur. L'infobulle de Tarkov est elle-meme
  // ancree au curseur a decalage constant (mesure en jeu : -16, -83) : reutiliser
  // ce decalage fait suivre la carte exactement comme l'infobulle qu'elle
  // prolonge, sans avoir a relocaliser quoi que ce soit entre deux analyses.
  anchorOffset = { dx: x - cursor.x, dy: y - cursor.y };

  // Avec le suivi actif, la fenetre est plus grande que la carte et ne bouge
  // plus qu'ici : la carte glisse ensuite **a l'interieur** de cette marge. Sans
  // suivi, la marge se reduit a l'ombre du liseré et la fenetre epouse la carte.
  // Bounds reels de la carte : c'est eux, et non ceux de la fenetre, qu'il faut
  // exclure de la recherche d'infobulle. La distinction devient essentielle en
  // mode permanent, ou la fenetre couvre tout l'ecran.
  cardBounds = { x: Math.round(x), y: Math.round(y), width, height };
  cardVisible = true;

  const frame = config.overlayPersistent
    ? coverDisplay(window, display)
    : (() => {
        const pad = overlayPad(config);
        const bounds = {
          x: Math.round(Math.max(area.x, Math.min(x - pad, area.x + area.width - (width + pad * 2)))),
          y: Math.round(Math.max(area.y, Math.min(y - pad, area.y + area.height - (height + pad * 2)))),
          width: width + pad * 2,
          height: height + pad * 2,
        };
        window.setBounds(bounds);
        return bounds;
      })();

  sendFollow(window, x - frame.x, y - frame.y);
  if (!window.isVisible()) window.showInactive();

  // Diagnostic d'affichage. Une carte « invisible » a trois causes possibles et
  // seul ce journal les distingue : bounds hors de l'ecran regarde, fenetre que
  // Windows refuse de rendre visible, ou fenetre bien visible mais recouverte
  // par un jeu en plein ecran exclusif (qui interdit toute surimpression).
  const actual = window.getBounds();
  log.debug(
    `carte -> demande ${x},${y} ${width}x${height} | obtenu ${actual.x},${actual.y} ${actual.width}x${actual.height} | ` +
      `visible=${window.isVisible()} onTop=${window.isAlwaysOnTop()} opacite=${window.getOpacity()} | ` +
      `ecran ${display.id} zone ${area.x},${area.y} ${area.width}x${area.height} | curseur ${cursor.x},${cursor.y}`,
  );
}

/**
 * Repositionne la carte visible sur le curseur, sans nouvelle analyse.
 *
 * L'infobulle de Tarkov suit le curseur : une carte figee a l'endroit ou le
 * dernier match a eu lieu s'en detachait des le moindre mouvement. On rejoue
 * donc le decalage mesure au dernier affichage.
 *
 * Appele a la cadence du sondage curseur. `setBounds` n'est emis que si la
 * position change reellement, pour ne pas solliciter le compositeur a vide.
 */
export function followCursor(cursor: { x: number; y: number }, config: AppConfig): void {
  if (!isFollowing(config)) return;

  const window = overlayWindow;
  if (!window || window.isDestroyed() || !window.isVisible() || !anchorOffset) return;

  const frame = window.getBounds();
  const width = Math.round(OVERLAY_WIDTH * config.overlayScale);
  const height = overlayHeight;

  // Position voulue de la carte, puis position correspondante **dans** la
  // fenetre. Tant qu'elle tient dans la marge, la fenetre n'a pas a bouger : la
  // carte se contente de glisser par translation CSS.
  //
  // Attention a ne pas en conclure que le suivi est gratuit. Il l'aurait ete sur
  // une fenetre opaque ; sur une fenetre **transparente**, chaque image repasse
  // par le DWM, qui recompose alors le jeu. C'est pourquoi le suivi est
  // desactive par defaut — voir `overlayPad`.
  const wantedX = cursor.x + anchorOffset.dx;
  const wantedY = cursor.y + anchorOffset.dy;
  const insideX = wantedX - frame.x;
  const insideY = wantedY - frame.y;

  if (insideX >= 0 && insideY >= 0 && insideX + width <= frame.width && insideY + height <= frame.height) {
    sendFollow(window, insideX, insideY);
    return;
  }

  // Sortie de la marge : cas rare (grand ecart de curseur en un seul tick). On
  // recentre la fenetre, seule circonstance ou elle est encore deplacee.
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const pad = overlayPad(config);
  const x = Math.max(area.x, Math.min(wantedX - pad, area.x + area.width - (width + pad * 2)));
  const y = Math.max(area.y, Math.min(wantedY - pad, area.y + area.height - (height + pad * 2)));
  window.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: width + pad * 2,
    height: height + pad * 2,
  });
  sendFollow(window, Math.round(wantedX - x), Math.round(wantedY - y));
}

/**
 * Mode permanent : la fenetre couvre l'ecran et n'est deplacee qu'au changement
 * de moniteur.
 *
 * Pourquoi ce mode existe
 * -----------------------
 * Un jeu en borderless est presente par Windows en **flip direct** : le jeu
 * ecrit sa frame, l'ecran l'affiche, le DWM ne touche a rien. Des qu'une fenetre
 * au premier plan recouvre la sienne, Windows abandonne ce chemin et repasse en
 * composition complete.
 *
 * Ce n'est pas la presence de la fenetre qui coute le plus, c'est le
 * **basculement**. Constate en jeu : la saccade tombe exactement a l'instant ou
 * la carte apparait, puis tout est fluide tant qu'elle reste affichee, et
 * recommence a la suivante. Afficher et masquer la fenetre a chaque objet
 * survole, c'est imposer ce basculement plusieurs fois par minute.
 *
 * En mode permanent, la fenetre reste visible en continu : le jeu s'installe une
 * fois pour toutes en composition et n'en sort plus. Le cout devient constant —
 * quelques images par seconde en moins — au lieu d'a-coups. C'est un echange,
 * pas une suppression : a chacun de juger ce qui gene le plus.
 */
function coverDisplay(
  window: BrowserWindow,
  display: Electron.Display,
): { x: number; y: number; width: number; height: number } {
  const area = display.workArea;
  const current = window.getBounds();
  const same =
    current.x === area.x &&
    current.y === area.y &&
    current.width === area.width &&
    current.height === area.height;
  // Ne redimensionner qu'au changement d'ecran : tout `setBounds` sur une
  // fenetre au premier plan provoque precisement le travail qu'on evite.
  if (!same) window.setBounds(area);
  return area;
}

/** Transmet au renderer la position de la carte dans la fenetre. */
function sendFollow(window: BrowserWindow, x: number, y: number): void {
  if (window.isDestroyed()) return;
  window.webContents.send(IPC.OVERLAY_FOLLOW, { x: Math.round(x), y: Math.round(y) });
}

/**
 * Duree pendant laquelle les bounds de la carte restent exclus apres son
 * masquage.
 *
 * Le flux de capture tourne a cadence bridee : l'image lue peut dater de
 * plusieurs dizaines de millisecondes. Juste apres un masquage, elle contient
 * donc encore la carte alors que `isVisible()` renvoie deja `false`. Sans ce
 * delai de grace, le localisateur cadrait la carte fantome, l'OCR relisait ses
 * propres libelles (« Flea 24h », « Dernier bas ») et les tentatives de la
 * position etaient consommees pour rien — constate en jeu.
 *
 * 400 ms couvrent largement la peremption d'une image, meme a cadence reduite.
 */
const OVERLAY_EXCLUSION_GRACE_MS = 400;

/**
 * Bounds de la carte a l'ecran, et instant de son masquage.
 *
 * Suivis a part des bounds de la **fenetre**, qui ne coincident avec eux qu'en
 * mode a la demande. En mode permanent, la fenetre couvre tout l'ecran : s'en
 * servir comme zone d'exclusion reviendrait a exclure l'ecran entier, et plus
 * aucune infobulle ne serait jamais detectee.
 */
let cardBounds: { x: number; y: number; width: number; height: number } | null = null;
let cardVisible = false;
let overlayHiddenAt = 0;

/**
 * Bounds a exclure de la recherche d'infobulle : ceux de la carte si elle est
 * visible, ou ses derniers bounds si elle vient tout juste d'etre masquee.
 * `null` au-dela du delai de grace. Voir `DetectorDeps`.
 */
export function getVisibleOverlayBounds(): { x: number; y: number; width: number; height: number } | null {
  if (!overlayWindow || overlayWindow.isDestroyed() || !cardBounds) return null;
  if (cardVisible) return cardBounds;
  if (Date.now() - overlayHiddenAt < OVERLAY_EXCLUSION_GRACE_MS) return cardBounds;
  return null;
}

/**
 * Masque la carte.
 *
 * En mode permanent, la fenetre reste visible : seul le renderer efface la
 * carte, sur `OVERLAY_HIDE` envoye en parallele par le process principal. C'est
 * tout l'interet du mode — ne jamais faire basculer Windows entre presentation
 * directe et composition.
 */
export function hideOverlay(config?: AppConfig): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!cardVisible) return;

  cardVisible = false;
  overlayHiddenAt = Date.now();

  if (!config?.overlayPersistent && overlayWindow.isVisible()) {
    overlayWindow.hide();
  }
}

export function createSettingsWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: 'Tarkov Price Hover',
    backgroundColor: '#14120f',
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(preloadDir, 'settings.preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(path.join(rendererDir, 'settings.html'));

  // Fermer la fenetre ne quitte pas l'application : l'outil vit dans le tray.
  window.on('close', (event) => {
    if (!(app as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on('closed', () => {
    settingsWindow = null;
  });

  settingsWindow = window;
  return window;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}

export function showSettings(): void {
  // La fenetre n'existe pas tant qu'on ne l'a pas ouverte : c'est le
  // fonctionnement nominal, pas une anomalie.
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    log.info('creation de la fenetre de configuration');
    createSettingsWindow();
  }
  settingsWindow?.show();
  settingsWindow?.focus();
}
