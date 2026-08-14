/**
 * services/TarkovApi.ts
 * ---------------------
 * Client GraphQL de https://api.tarkov.dev/graphql (public, sans cle API).
 *
 * Responsabilites :
 *   - Construire et envoyer la requete « tous les items » pour un mode de jeu.
 *   - Retenter avec backoff exponentiel sur erreur reseau ou 5xx.
 *   - Normaliser la reponse vers `TarkovItem[]` (le reste de l'app ne voit
 *     jamais la forme brute de l'API).
 *
 * Tolerance au schema
 * -------------------
 * L'argument `gameMode` n'existe que sur les versions recentes du schema
 * tarkov.dev. Si le serveur rejette la requete pour cette raison precise, on
 * rejoue automatiquement la requete sans l'argument et on signale que les prix
 * correspondent au mode « regular ». Cela evite qu'une evolution du schema
 * amont ne rende l'outil totalement inutilisable.
 */

import type { GameMode, TarkovItem, VendorOffer } from '../types/index';
import { createLogger } from './Logger';

const log = createLogger('api');

const ENDPOINT = 'https://api.tarkov.dev/graphql';
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

/** Champs demandes. Extrait en constante pour rester identique dans les deux variantes. */
const ITEM_FIELDS = `
    id
    name
    shortName
    basePrice
    avg24hPrice
    lastLowPrice
    width
    height
    iconLink
    types
    sellFor {
      priceRUB
      vendor {
        name
        normalizedName
      }
    }`;

const QUERY_WITH_MODE = `query ItemsByMode($gameMode: GameMode) {
  items(gameMode: $gameMode) {${ITEM_FIELDS}
  }
}`;

const QUERY_WITHOUT_MODE = `query AllItems {
  items {${ITEM_FIELDS}
  }
}`;

/** Forme brute d'un item telle que renvoyee par l'API. Tous les champs sont faillibles. */
interface RawItem {
  id?: unknown;
  name?: unknown;
  shortName?: unknown;
  basePrice?: unknown;
  avg24hPrice?: unknown;
  lastLowPrice?: unknown;
  width?: unknown;
  height?: unknown;
  iconLink?: unknown;
  types?: unknown;
  sellFor?: unknown;
}

export interface FetchResult {
  items: TarkovItem[];
  /** `true` si le serveur ne supporte pas `gameMode` : les prix sont ceux du mode regular. */
  gameModeIgnored: boolean;
}

/** Erreur applicative du client API, distinguee des erreurs de programmation. */
export class TarkovApiError extends Error {
  constructor(
    message: string,
    /** `true` si retenter plus tard a une chance d'aboutir. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TarkovApiError';
  }
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Convertit un `sellFor` brut en liste d'offres exploitables (prix > 0 uniquement). */
function normalizeSellFor(raw: unknown): VendorOffer[] {
  if (!Array.isArray(raw)) return [];
  const offers: VendorOffer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { priceRUB?: unknown; vendor?: { name?: unknown; normalizedName?: unknown } };
    const priceRUB = toNumberOrNull(e.priceRUB);
    if (priceRUB === null || priceRUB <= 0) continue;
    const vendorName = typeof e.vendor?.name === 'string' ? e.vendor.name : 'Unknown';
    const vendorSlug =
      typeof e.vendor?.normalizedName === 'string'
        ? e.vendor.normalizedName
        : vendorName.toLowerCase().replace(/\s+/g, '-');
    offers.push({ vendorName, vendorSlug, priceRUB });
  }
  return offers;
}

/** Filtre et normalise la liste brute. Un item sans `id` ou sans `name` est ignore. */
function normalizeItems(raw: unknown): TarkovItem[] {
  if (!Array.isArray(raw)) throw new TarkovApiError('champ `items` absent de la reponse', false);

  const items: TarkovItem[] = [];
  for (const entry of raw as RawItem[]) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : null;
    const name = typeof entry.name === 'string' ? entry.name.trim() : null;
    if (!id || !name) continue;

    items.push({
      id,
      name,
      shortName: typeof entry.shortName === 'string' ? entry.shortName.trim() : name,
      basePrice: toNumber(entry.basePrice, 0),
      avg24hPrice: toNumberOrNull(entry.avg24hPrice),
      lastLowPrice: toNumberOrNull(entry.lastLowPrice),
      // Un item a toujours au moins 1x1 case : 0 casserait le prix au slot.
      width: Math.max(1, toNumber(entry.width, 1)),
      height: Math.max(1, toNumber(entry.height, 1)),
      iconLink: toStringOrNull(entry.iconLink),
      types: Array.isArray(entry.types) ? entry.types.filter((t): t is string => typeof t === 'string') : [],
      sellFor: normalizeSellFor(entry.sellFor),
    });
  }
  return items;
}

/** Detecte le cas precis « le serveur ne connait pas l'argument gameMode ». */
function isGameModeUnsupported(errors: string[]): boolean {
  return errors.some((e) => /gamemode/i.test(e) && /(unknown|not defined|cannot query|undefined|invalid)/i.test(e));
}

/** Extrait les messages d'erreur GraphQL, quel que soit leur format (string[] ou objet[]). */
function extractErrors(payload: unknown): string[] {
  const errs = (payload as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errs)) return [];
  return errs.map((e) => (typeof e === 'string' ? e : String((e as { message?: unknown })?.message ?? JSON.stringify(e))));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TarkovApiClient {
  /** Memorise qu'un serveur a rejete `gameMode`, pour ne pas retenter a chaque cycle. */
  private gameModeSupported = true;

  /**
   * Recupere la totalite des items pour un mode de jeu.
   * @throws {TarkovApiError} si toutes les tentatives echouent.
   */
  async fetchAllItems(gameMode: GameMode, signal?: AbortSignal): Promise<FetchResult> {
    let lastError: TarkovApiError = new TarkovApiError('aucune tentative effectuee', true);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new TarkovApiError('recuperation annulee', false);
      try {
        const useMode = this.gameModeSupported;
        const started = Date.now();
        const payload = await this.request(
          useMode ? QUERY_WITH_MODE : QUERY_WITHOUT_MODE,
          useMode ? { gameMode } : undefined,
          signal,
        );

        const errors = extractErrors(payload);
        if (errors.length > 0) {
          if (useMode && isGameModeUnsupported(errors)) {
            // Le schema amont a change : on bascule definitivement en mode legacy.
            log.warn('le serveur ne supporte pas l\'argument gameMode, repli sur la requete sans mode');
            this.gameModeSupported = false;
            // Ne consomme pas de tentative : le repli ne peut se produire qu'une
            // seule fois puisque `gameModeSupported` reste faux ensuite.
            attempt--;
            continue;
          }
          // Une erreur GraphQL avec des donnees partielles reste exploitable.
          const data = (payload as { data?: { items?: unknown } }).data;
          if (!data?.items) throw new TarkovApiError(errors.join(' | '), true);
          log.warn('reponse GraphQL partiellement en erreur', errors);
        }

        const items = normalizeItems((payload as { data?: { items?: unknown } }).data?.items);
        if (items.length === 0) throw new TarkovApiError('l\'API a renvoye 0 item', true);

        log.info(`${items.length} items recuperes (${gameMode}) en ${Date.now() - started} ms`);
        return { items, gameModeIgnored: !useMode };
      } catch (err) {
        lastError = err instanceof TarkovApiError ? err : new TarkovApiError(String((err as Error)?.message ?? err), true);
        if (!lastError.retryable || attempt === MAX_ATTEMPTS) break;
        // Backoff exponentiel : 1s, 2s. Suffisant pour absorber un redemarrage amont.
        const delay = 1000 * 2 ** (attempt - 1);
        log.warn(`tentative ${attempt}/${MAX_ATTEMPTS} echouee (${lastError.message}), nouvel essai dans ${delay} ms`);
        await sleep(delay);
      }
    }

    log.error('recuperation des prix impossible', lastError.message);
    throw lastError;
  }

  /** Envoie une requete POST GraphQL et renvoie le JSON brut. */
  private async request(query: string, variables: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
    // Combine le timeout interne et l'annulation externe (arret de l'app).
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'tarkov-price-hover/1.0 (personal use)',
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
        signal: combined,
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError') throw new TarkovApiError(`timeout apres ${REQUEST_TIMEOUT_MS} ms`, true);
      if (name === 'AbortError') throw new TarkovApiError('requete annulee', false);
      throw new TarkovApiError(`erreur reseau : ${(err as Error)?.message ?? err}`, true);
    }

    if (!response.ok) {
      // 4xx = requete invalide (inutile de retenter), 5xx / 429 = probleme transitoire.
      let retryable = response.status >= 500 || response.status === 429;

      // Exception observee en production : quand l'origine de tarkov.dev est
      // indisponible, leur passerelle repond « 422 Unprocessable Entity » avec
      // un corps « GraphQL server unavailable. Try again later. ». C'est une
      // panne transitoire deguisee en erreur client — il faut donc retenter.
      const body = await response.text().catch(() => '');
      if (/unavailable|try again later|bad gateway|timeout/i.test(body)) retryable = true;

      const detail = body.slice(0, 200).replace(/\s+/g, ' ').trim();
      throw new TarkovApiError(
        `HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
        retryable,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new TarkovApiError('reponse illisible (JSON invalide)', true);
    }
  }
}
