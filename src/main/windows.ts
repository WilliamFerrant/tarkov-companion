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
/** Hauteur initiale, corrigee des que le renderer a mesure son contenu. */
const OVERLAY_DEFAULT_HEIGHT = 130;
/** Ecart entre le curseur et le coin de la carte, sur le repli au-dessus. */
const CURSOR_GAP = 22;

/**
 * Decalage de la carte par rapport au curseur, en pixels logiques.
 *
 * Calques sur la geometrie mesuree de l'infobulle de Tarkov, qui s'ancre au
 * curseur avec un decalage constant de (-16, -83) : la carte reprend le meme
 * bord gauche, et se pose sous le curseur pour ne jamais empieter sur la boite
 * du jeu, qui se developpe vers le haut.
 */
const CARD_OFFSET_X = -16;
const CARD_OFFSET_Y = 24;
/** Ecart entre l'infobulle du jeu et la carte, pour qu'elles restent distinctes. */
const TOOLTIP_GAP = 8;

const rendererDir = path.join(__dirname, '..', 'renderer');
const preloadDir = path.join(__dirname, '..', 'preload');

let overlayWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
/** Derniere hauteur rapportee par le renderer overlay. */
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
  if (config.overlayFollowCursor) return OVERLAY_PAD;
  // Sans transparence, la marge serait un aplat visible autour de la carte.
  return config.overlayTransparent ? OVERLAY_PAD_STATIC : 0;
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
  window.setIgnoreMouseEvents(clickThrough, { forward: true });
}

/** Memorise la hauteur mesuree cote renderer et redimensionne la fenetre. */
export function setOverlayHeight(height: number, config: AppConfig): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Plancher abaisse a 60 : la carte compacte, sans icone ni badge, descend
  // sous les 80 px d'autrefois. Un plancher trop haut laisserait une bande vide.
  const clamped = Math.max(60, Math.min(700, Math.round(height)));
  if (clamped === overlayHeight) return;
  overlayHeight = clamped;
  overlayWindow.setBounds({
    ...overlayWindow.getBounds(),
    // La marge fait partie de la fenetre : sans elle, la carte serait rognee des
    // qu'elle glisse vers le bas.
    height: Math.round(clamped * config.overlayScale) + overlayPad(config) * 2,
  });
}

/**
 * Positionne la carte pres du curseur puis l'affiche.
 * La carte bascule a gauche ou au-dessus du curseur si elle depasserait de
 * l'ecran, de sorte qu'elle reste toujours entierement visible.
 */
export function showOverlayAt(
  cursor: { x: number; y: number },
  config: AppConfig,
  /** Rectangle de l'infobulle du jeu, en pixels logiques. La carte ne doit pas le couvrir. */
  avoid: { x: number; y: number; width: number; height: number } | null = null,
): void {
  const window = overlayWindow;
  if (!window || window.isDestroyed()) return;

  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const width = Math.round(OVERLAY_WIDTH * config.overlayScale);
  const height = Math.round(overlayHeight * config.overlayScale);

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
  // hauteur reelle. `avoid` ne sert plus qu'au repli ci-dessous.
  let x = cursor.x + CARD_OFFSET_X;
  let y = cursor.y + CARD_OFFSET_Y;

  // Pas la place en dessous : on repasse au-dessus de l'infobulle plutot que du
  // curseur, pour ne pas la masquer.
  if (y + height > area.y + area.height) {
    y = avoid ? avoid.y - height - TOOLTIP_GAP : cursor.y - height - CURSOR_GAP;
  }
  if (x + width > area.x + area.width) x = area.x + area.width - width;

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
  const pad = overlayPad(config);
  const frame = {
    x: Math.round(Math.max(area.x, Math.min(x - pad, area.x + area.width - (width + pad * 2)))),
    y: Math.round(Math.max(area.y, Math.min(y - pad, area.y + area.height - (height + pad * 2)))),
    width: width + pad * 2,
    height: height + pad * 2,
  };
  window.setBounds(frame);
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
  if (!config.overlayFollowCursor) return;

  const window = overlayWindow;
  if (!window || window.isDestroyed() || !window.isVisible() || !anchorOffset) return;

  const frame = window.getBounds();
  const width = Math.round(OVERLAY_WIDTH * config.overlayScale);
  const height = Math.round(overlayHeight * config.overlayScale);

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

/** Derniers bounds occupes par la carte, et instant de son masquage. */
let lastOverlayBounds: { x: number; y: number; width: number; height: number } | null = null;
let overlayHiddenAt = 0;

/**
 * Bounds a exclure de la recherche d'infobulle : ceux de la carte si elle est
 * visible, ou ses derniers bounds si elle vient tout juste d'etre masquee.
 * `null` au-dela du delai de grace. Voir `DetectorDeps`.
 */
export function getVisibleOverlayBounds(): { x: number; y: number; width: number; height: number } | null {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  if (overlayWindow.isVisible()) {
    lastOverlayBounds = overlayWindow.getBounds();
    return lastOverlayBounds;
  }
  if (lastOverlayBounds && Date.now() - overlayHiddenAt < OVERLAY_EXCLUSION_GRACE_MS) {
    return lastOverlayBounds;
  }
  return null;
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    // Memorise avant de masquer : apres coup, `getBounds()` reste valable mais
    // l'instant du masquage est ce qui borne le delai de grace.
    lastOverlayBounds = overlayWindow.getBounds();
    overlayHiddenAt = Date.now();
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
