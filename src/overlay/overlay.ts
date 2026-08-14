/**
 * overlay/overlay.ts
 * ------------------
 * Rendu de la carte de prix. Ce renderer est volontairement minimal : pas de
 * framework, pas d'etat, pas de boucle d'animation. Il recoit un `PriceSummary`
 * et met a jour une poignee de noeuds DOM deja presents dans le HTML.
 *
 * Pourquoi pas React ici : la carte compte une quinzaine de noeuds fixes et
 * change au plus quelques fois par seconde. Un runtime de framework ajouterait
 * du temps de demarrage et de la memoire resident dans un process qui doit
 * rester invisible pour le jeu, sans rien simplifier.
 *
 * Apres chaque rendu, la hauteur reelle est renvoyee au process principal, qui
 * redimensionne la fenetre : la carte n'a ainsi jamais de bande vide en bas.
 */

import type { AppConfig, PriceSummary } from '../types/index';
import type { OverlayApi } from '../types/ipc';

declare global {
  interface Window {
    overlayApi: OverlayApi;
  }
}

/** Recupere un element obligatoire du template. Echoue tot si le HTML a derive. */
function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`element #${id} absent du template overlay`);
  return node as T;
}

const ui = {
  card: element<HTMLElement>('card'),
  icon: element<HTMLImageElement>('icon'),
  size: element<HTMLElement>('size'),
  noFlea: element<HTMLElement>('noflea'),
  avg: element<HTMLElement>('avg'),
  low: element<HTMLElement>('low'),
  traderLabel: element<HTMLElement>('trader-label'),
  trader: element<HTMLElement>('trader'),
  slot: element<HTMLElement>('slot'),
  profit: element<HTMLElement>('profit'),
  confidence: element<HTMLElement>('confidence'),
};

/** Seuil sous lequel le score de match est signale comme incertain. */
const LOW_CONFIDENCE = 0.8;

let showIcons = true;

/** « 1 234 567 ₽ ». L'espace fine insecable evite les coupures de ligne. */
function formatRoubles(value: number): string {
  return `${Math.round(value).toLocaleString('fr-FR').replace(/ | /g, ' ')} ₽`;
}

/** Renseigne une valeur monetaire, ou un tiret grise si la donnee est absente. */
function setPrice(node: HTMLElement, value: number | null): void {
  if (value === null || value <= 0) {
    node.textContent = '—';
    node.classList.add('value-empty');
  } else {
    node.textContent = formatRoubles(value);
    node.classList.remove('value-empty');
  }
}

/** Signale au process principal la hauteur reelle du contenu. */
function reportHeight(): void {
  // `getBoundingClientRect` inclut les bordures, contrairement a offsetHeight
  // sur un element en `box-sizing: border-box` partiellement fractionnaire.
  const height = Math.ceil(ui.card.getBoundingClientRect().height);
  if (height > 0) window.overlayApi.reportHeight(height);
}

function render(summary: PriceSummary): void {
  // Le nom n'est pas repris : l'infobulle du jeu l'affiche deja juste au-dessus
  // de la carte. Le dupliquer coutait deux lignes et la moitie de la hauteur.
  ui.size.textContent = `${summary.width}x${summary.height}`;
  ui.noFlea.hidden = !summary.noFlea;

  setPrice(ui.avg, summary.avg24hPrice);
  setPrice(ui.low, summary.lastLowPrice);

  // Le libelle porte le nom du trader : « Prapor » est plus utile que « Trader ».
  ui.traderLabel.textContent = summary.bestTrader ? summary.bestTrader.vendorName : 'Trader';
  setPrice(ui.trader, summary.bestTrader?.priceRUB ?? null);

  setPrice(ui.slot, summary.pricePerSlot);

  // --- Ecart Flea / trader ---
  if (summary.fleaVsTrader === null) {
    ui.profit.textContent = '';
    ui.profit.className = 'profit';
  } else {
    const delta = summary.fleaVsTrader;
    const sign = delta >= 0 ? '+' : '−';
    // Le libelle « Flea vs trader » est retire : sur une carte de 170 px il
    // occupait plus de place que le montant qu'il annonce, et la couleur
    // (vert / rouge) porte deja l'information.
    ui.profit.textContent = `${sign}${formatRoubles(Math.abs(delta))}`;
    ui.profit.className = `profit ${delta >= 0 ? 'profit-positive' : 'profit-negative'}`;
  }

  // --- Confiance du match OCR ---
  const percent = Math.round(summary.matchScore * 100);
  ui.confidence.textContent = `match ${percent}%`;
  ui.confidence.className = summary.matchScore < LOW_CONFIDENCE ? 'confidence confidence-low' : 'confidence';

  // --- Icone ---
  if (showIcons && summary.iconLink) {
    // `src` n'est reaffecte que si l'URL change : sinon le navigateur
    // relancerait un chargement et l'icone clignoterait.
    if (ui.icon.getAttribute('src') !== summary.iconLink) ui.icon.src = summary.iconLink;
    ui.icon.hidden = false;
  } else {
    ui.icon.hidden = true;
  }

  ui.card.hidden = false;
  // Mesure apres application du layout, pas pendant.
  requestAnimationFrame(reportHeight);
}

// Une icone injoignable (hors ligne, URL morte) ne doit pas laisser un cadre vide.
ui.icon.addEventListener('error', () => {
  ui.icon.hidden = true;
  requestAnimationFrame(reportHeight);
});

function applyConfig(config: AppConfig): void {
  const root = document.documentElement;
  root.style.setProperty('--scale', String(config.overlayScale));
  root.style.setProperty('--opacity', String(config.overlayOpacity));
  showIcons = config.showIcon;
  if (!showIcons) ui.icon.hidden = true;
}

/**
 * Deplace la carte dans la fenetre.
 *
 * `transform` plutot que `left`/`top` : une translation est prise en charge par
 * le compositeur, sans recalcul de mise en page ni repeinture du contenu. C'est
 * ce qui permet de suivre le curseur a la cadence du sondage sans cout visible,
 * la ou deplacer la fenetre elle-meme forcait le DWM a recomposer l'ecran.
 */
function follow(position: { x: number; y: number }): void {
  ui.card.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
}

window.overlayApi.onShow(render);
window.overlayApi.onFollow(follow);
window.overlayApi.onHide(() => {
  ui.card.hidden = true;
});
window.overlayApi.onConfig(applyConfig);
