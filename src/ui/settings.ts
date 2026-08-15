/**
 * ui/settings.ts
 * --------------
 * Logique de la fenetre de configuration.
 *
 * Les champs sont relies a la configuration par attributs de donnees plutot que
 * par du code champ par champ :
 *
 *   data-config="minPriceFilter"   -> AppConfig.minPriceFilter
 *   data-region="offsetX"          -> AppConfig.captureRegion.offsetX
 *   data-hotkey="toggleOverlay"    -> AppConfig.hotkeys.toggleOverlay
 *
 * Ajouter un reglage ne demande donc qu'une ligne de HTML et une entree dans
 * `AppConfig`. Le type de valeur est deduit du type de l'element.
 *
 * Boucle de retour : le process principal renvoie la configuration assainie
 * apres chaque ecriture. On repeuple alors les champs, en epargnant celui qui a
 * le focus pour ne pas ecraser une saisie en cours.
 */

import type { AppConfig, CacheStatus, DebugFrame, UpdateState } from '../types/index';
import type { SettingsApi } from '../types/ipc';

declare global {
  interface Window {
    settingsApi: SettingsApi;
  }
}

const api = window.settingsApi;

/** Score en dessous duquel un candidat est affiche en grise. */
const WEAK_SCORE = 0.62;
/** Anti-rebond des champs texte et curseurs. */
const DEBOUNCE_MS = 220;

let current: AppConfig | null = null;
/** Vrai pendant le repeuplement programmatique : neutralise les handlers. */
let populating = false;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.section;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('is-active', n === button));
    document.querySelectorAll<HTMLElement>('.section').forEach((section) => {
      section.classList.toggle('is-active', section.dataset.section === target);
    });
  });
});

// ---------------------------------------------------------------------------
// Liaison configuration <-> champs
// ---------------------------------------------------------------------------

type BoundInput = HTMLInputElement | HTMLSelectElement;

function boundInputs(): BoundInput[] {
  return Array.from(document.querySelectorAll<BoundInput>('[data-config], [data-region], [data-hotkey]'));
}

/** Ecrit une valeur de configuration dans un champ. */
function writeToInput(input: BoundInput, value: unknown): void {
  if (input instanceof HTMLInputElement && input.type === 'checkbox') {
    input.checked = Boolean(value);
  } else {
    input.value = value === null || value === undefined ? '' : String(value);
  }
}

/** Lit la valeur d'un champ dans le type attendu par la configuration. */
function readFromInput(input: BoundInput): string | number | boolean {
  if (input instanceof HTMLInputElement) {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number' || input.type === 'range') {
      const parsed = Number(input.value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }
  return input.value;
}

function populate(config: AppConfig): void {
  populating = true;
  current = config;

  for (const input of boundInputs()) {
    // Ne pas ecraser le champ en cours d'edition.
    if (input === document.activeElement) continue;

    const configKey = input.dataset.config;
    const regionKey = input.dataset.region;
    const hotkeyKey = input.dataset.hotkey;

    if (configKey) writeToInput(input, (config as unknown as Record<string, unknown>)[configKey]);
    else if (regionKey) writeToInput(input, (config.captureRegion as unknown as Record<string, unknown>)[regionKey]);
    else if (hotkeyKey) writeToInput(input, (config.hotkeys as unknown as Record<string, unknown>)[hotkeyKey]);
  }

  updateRangeOutputs(config);
  // Les champs de zone fixe n'ont aucun sens en mode automatique : les afficher
  // suggererait a tort qu'il y a quelque chose a calibrer.
  const manualRegion = document.getElementById('manual-region');
  if (manualRegion) manualRegion.hidden = config.captureMode !== 'manual';
  populating = false;
}

function updateRangeOutputs(config: AppConfig): void {
  const opacity = document.getElementById('out-opacity');
  const scale = document.getElementById('out-scale');
  if (opacity) opacity.textContent = `${Math.round(config.overlayOpacity * 100)} %`;
  if (scale) scale.textContent = `${config.overlayScale.toFixed(2)} x`;
}

let debounceTimer: number | undefined;

/** Construit le patch correspondant a un champ et l'envoie au process principal. */
function pushChange(input: BoundInput): void {
  if (populating || !current) return;

  const value = readFromInput(input);
  let patch: Partial<AppConfig>;

  if (input.dataset.config) {
    patch = { [input.dataset.config]: value } as unknown as Partial<AppConfig>;
  } else if (input.dataset.region) {
    patch = { captureRegion: { ...current.captureRegion, [input.dataset.region]: value } } as Partial<AppConfig>;
  } else if (input.dataset.hotkey) {
    patch = { hotkeys: { ...current.hotkeys, [input.dataset.hotkey]: value } } as Partial<AppConfig>;
  } else {
    return;
  }

  void api.setConfig(patch).then(populate);
}

for (const input of boundInputs()) {
  const isImmediate =
    input instanceof HTMLSelectElement ||
    (input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'number'));

  if (isImmediate) {
    input.addEventListener('change', () => pushChange(input));
  } else {
    // Texte et curseurs : anti-rebond, sinon chaque frappe declencherait une
    // ecriture disque et un re-enregistrement des raccourcis globaux.
    input.addEventListener('input', () => {
      if (input instanceof HTMLInputElement && input.type === 'range' && current) {
        // Retour visuel immediat, sans attendre l'aller-retour IPC.
        updateRangeOutputs({ ...current, [input.dataset.config as string]: Number(input.value) } as AppConfig);
      }
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => pushChange(input), DEBOUNCE_MS);
    });
    input.addEventListener('change', () => {
      window.clearTimeout(debounceTimer);
      pushChange(input);
    });
  }
}

// ---------------------------------------------------------------------------
// Etat du cache
// ---------------------------------------------------------------------------

const cacheInfo = document.getElementById('cache-info')!;
const cacheError = document.getElementById('cache-error')!;
const statusPill = document.getElementById('status-pill')!;
const refreshButton = document.getElementById('btn-refresh') as HTMLButtonElement;

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return 'jamais';
  return new Date(timestamp).toLocaleString('fr-FR');
}

/**
 * Traduit une erreur de recuperation en message actionnable.
 *
 * Afficher « HTTP 422 Unprocessable Entity » brut est trompeur : ce code suggere
 * une requete invalide alors que c'est la reponse de la passerelle tarkov.dev
 * quand leur backend est en panne. Le detail technique reste affiche a la fin,
 * mais apres l'explication et la conduite a tenir.
 */
function describeError(status: CacheStatus): string {
  const detail = `Detail : ${status.lastError}`;

  const serviceDown = /unavailable|try again later|502|503|504|522|timeout/i.test(status.lastError ?? '');

  if (status.stale) {
    return `Mise a jour impossible — les prix affiches proviennent du cache local et restent utilisables. ${detail}`;
  }

  if (serviceDown) {
    const retry =
      status.nextRetryAt !== null
        ? ` Nouvelle tentative automatique dans ${Math.max(1, Math.round((status.nextRetryAt - Date.now()) / 1000))} s.`
        : ' Nouvelle tentative automatique programmee.';
    return (
      "L'API tarkov.dev est momentanement indisponible : la panne est de leur cote, " +
      "il n'y a rien a corriger ici." +
      retry +
      ` Des qu'elle repond, les prix se chargent seuls. ${detail}`
    );
  }

  return `${status.lastError}`;
}

function renderCache(status: CacheStatus): void {
  cacheInfo.innerHTML = [
    `<strong>${status.itemCount.toLocaleString('fr-FR')}</strong> items en cache`,
    `Mode : ${status.gameMode === 'pve' ? 'PvE' : 'PvP (regular)'}`,
    `Dernier refresh : ${formatTimestamp(status.fetchedAt)}`,
  ].join('<br />');

  refreshButton.disabled = status.refreshing;
  refreshButton.textContent = status.refreshing ? 'Mise a jour…' : 'Rafraichir maintenant';

  cacheError.hidden = !status.lastError;
  if (status.lastError) cacheError.textContent = describeError(status);

  statusPill.className = 'pill';
  if (status.refreshing) {
    statusPill.textContent = 'mise a jour…';
  } else if (status.itemCount === 0) {
    statusPill.textContent = 'aucun prix';
    statusPill.classList.add('is-error');
  } else if (status.stale) {
    statusPill.textContent = `${status.itemCount} items (cache)`;
    statusPill.classList.add('is-stale');
  } else {
    statusPill.textContent = `${status.itemCount} items`;
  }
}

refreshButton.addEventListener('click', () => {
  refreshButton.disabled = true;
  void api.refreshCache().then(renderCache);
});

document.getElementById('btn-logs')?.addEventListener('click', () => void api.openLogs());
document.getElementById('btn-config')?.addEventListener('click', () => void api.openConfig());

// ---------------------------------------------------------------------------
// Mises a jour
// ---------------------------------------------------------------------------

const updateInfo = document.getElementById('update-info')!;
const updateError = document.getElementById('update-error')!;
const updateCheckButton = document.getElementById('btn-update-check') as HTMLButtonElement;
const updateInstallButton = document.getElementById('btn-update-install') as HTMLButtonElement;

function renderUpdate(state: UpdateState): void {
  updateError.hidden = true;
  updateInstallButton.hidden = true;
  updateCheckButton.disabled = false;
  updateCheckButton.textContent = 'Verifier';

  switch (state.status) {
    case 'disabled':
      // Etat normal en developpement : ce n'est pas une panne, on ne l'annonce
      // pas comme telle et on desactive simplement le bouton.
      updateInfo.textContent = state.reason;
      updateCheckButton.disabled = true;
      break;
    case 'checking':
      updateInfo.textContent = `Version ${state.currentVersion} — recherche en cours…`;
      updateCheckButton.disabled = true;
      updateCheckButton.textContent = 'Recherche…';
      break;
    case 'available':
      updateInfo.textContent = `Version ${state.version} disponible — telechargement en arriere-plan…`;
      updateCheckButton.disabled = true;
      break;
    case 'downloading':
      updateInfo.textContent = `Telechargement de la version ${state.version} : ${state.percent} %`;
      updateCheckButton.disabled = true;
      break;
    case 'ready':
      updateInfo.innerHTML =
        `<strong>Version ${state.version} prete.</strong><br />` +
        `Elle s'installera a la prochaine fermeture, ou immediatement via le bouton.`;
      updateInstallButton.hidden = false;
      break;
    case 'error':
      updateInfo.textContent = `Version ${state.currentVersion} — derniere verification en echec`;
      updateError.hidden = false;
      updateError.textContent =
        'Verification impossible. Sans consequence : elle sera retentee automatiquement. ' +
        `Detail : ${state.message}`;
      break;
    default:
      updateInfo.innerHTML =
        `Version <strong>${state.currentVersion}</strong> — a jour.<br />` +
        `Derniere verification : ${state.lastCheck ? formatTimestamp(state.lastCheck) : 'jamais'}`;
  }
}

updateCheckButton.addEventListener('click', () => {
  updateCheckButton.disabled = true;
  void api.checkForUpdate().then(renderUpdate);
});

updateInstallButton.addEventListener('click', () => {
  updateInstallButton.disabled = true;
  void api.installUpdate();
});

// ---------------------------------------------------------------------------
// Panneau debug
// ---------------------------------------------------------------------------

const debugEmpty = document.getElementById('debug-empty')!;
const debugBody = document.getElementById('debug-body') as HTMLElement;
const debugImage = document.getElementById('debug-image') as HTMLImageElement;
const debugSearch = document.getElementById('debug-search') as HTMLImageElement;
const debugTiming = document.getElementById('debug-timing')!;
const debugConf = document.getElementById('debug-conf')!;
const debugRect = document.getElementById('debug-rect')!;
const debugSkip = document.getElementById('debug-skip')!;
const debugText = document.getElementById('debug-text')!;
const debugCandidates = document.getElementById('debug-candidates')!;
const probeButton = document.getElementById('btn-probe') as HTMLButtonElement;

function renderDebug(frame: DebugFrame): void {
  debugEmpty.hidden = true;
  debugBody.hidden = false;

  if (frame.imageDataUrl) {
    debugImage.src = frame.imageDataUrl;
    debugImage.hidden = false;
  } else {
    debugImage.hidden = true;
  }

  if (frame.searchDataUrl) {
    debugSearch.src = frame.searchDataUrl;
    debugSearch.hidden = false;
  } else {
    debugSearch.hidden = true;
  }

  // Le detail permet de savoir quoi regler : une capture lente vient de l'ecran
  // (resolution, pilote), un OCR lent de la taille de la zone retenue.
  debugTiming.textContent = frame.timings
    ? `capture ${frame.timings.grabMs} ms · cadrage ${frame.timings.locateMs} ms · ` +
      `pretraitement ${frame.timings.preprocessMs} ms · OCR ${frame.ocrMs} ms ` +
      `= ${frame.timings.totalMs + frame.ocrMs} ms`
    : `capture ${frame.captureMs} ms · OCR ${frame.ocrMs} ms`;
  debugConf.textContent = `confiance Tesseract ${frame.ocrConfidence.toFixed(0)} %`;
  debugRect.textContent = frame.rect
    ? `zone ${frame.rect.width}x${frame.rect.height} @ ${frame.rect.x},${frame.rect.y}` +
      (frame.fillRatio === null ? ' (manuel)' : ` · remplissage ${(frame.fillRatio * 100).toFixed(0)} %`)
    : 'aucune zone retenue';

  debugSkip.hidden = !frame.skippedReason;
  if (frame.skippedReason) debugSkip.textContent = `Abandon : ${frame.skippedReason}`;

  debugText.textContent = frame.rawText || '(vide)';

  // `textContent` plutot que `innerHTML` : les noms d'items viennent d'une API
  // externe et ne doivent jamais etre interpretes comme du HTML.
  debugCandidates.replaceChildren(
    ...frame.candidates.map((candidate) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = candidate.name;
      const score = document.createElement('span');
      score.className = candidate.score < WEAK_SCORE ? 'score is-weak' : 'score';
      score.textContent = candidate.score.toFixed(3);
      item.append(name, score);
      return item;
    }),
  );

  if (frame.candidates.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'aucun candidat';
    debugCandidates.append(empty);
  }
}

probeButton.addEventListener('click', () => {
  probeButton.disabled = true;
  probeButton.textContent = 'Analyse…';
  void api.probe().finally(() => {
    probeButton.disabled = false;
    probeButton.textContent = 'Analyser maintenant';
  });
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

api.onConfigChanged(populate);
api.onCacheChanged(renderCache);
api.onDebugFrame(renderDebug);
api.onUpdateChanged(renderUpdate);

void Promise.all([api.getConfig(), api.getCacheStatus(), api.getUpdateStatus()])
  .then(([config, status, update]) => {
    populate(config);
    renderCache(status);
    renderUpdate(update);
  })
  .catch((err: unknown) => {
    // Sans ce garde-fou, un echec IPC laissait la fenetre indefiniment sur
    // « chargement… » avec des champs vides, sans le moindre indice.
    statusPill.textContent = 'erreur interne';
    statusPill.classList.add('is-error');
    cacheError.hidden = false;
    cacheError.textContent =
      'Impossible de lire la configuration depuis le processus principal. ' +
      'Redemarrez l\'application et consultez les logs. Detail : ' +
      String((err as Error)?.message ?? err);
  });
