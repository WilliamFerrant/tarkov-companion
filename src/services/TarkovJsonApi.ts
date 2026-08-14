/**
 * services/TarkovJsonApi.ts
 * -------------------------
 * Client de l'API JSON de tarkov.dev (https://json.tarkov.dev).
 *
 * Pourquoi cette source
 * ---------------------
 * L'API GraphQL `api.tarkov.dev/graphql` est hors service depuis le 21/07/2026
 * (issue the-hideout/tarkov-api#474, toujours ouverte). Un mainteneur y indique
 * que l'API JSON est la voie vivante, et que le site tarkov.dev s'appuie
 * dessus. Meme projet, meme organisation, toujours publique et sans cle.
 *
 * Differences de structure a absorber
 * -----------------------------------
 *   1. `data.items` est un objet indexe par id, pas un tableau.
 *   2. **Les noms sont des placeholders** : `name` vaut litteralement
 *      « <id> Name ». Les libelles reels ne sont pas dans cette reponse — le
 *      champ `translations` ne contient que des JSONPath decrivant quels champs
 *      sont traduisibles. Aucun parametre de langue teste (`?language`, `?lang`,
 *      `?locale`, en-tete `Accept-Language`) ne les renseigne.
 *
 *      Deux champs sauvent la situation, tous deux en anglais reel :
 *        - `wikiLink` (96,8 % des items) porte le nom exact, souligne :
 *          « .../wiki/Colt_M4A1_5.56x45_assault_rifle »
 *        - `normalizedName` (100 %) est le slug : « colt-m4a1-556x45-assault-rifle »
 *
 *      Le nom d'affichage vient du wiki quand il existe, du slug sinon. Les
 *      deux formes sont indexees pour la correspondance : le slug perd les
 *      points (« 556x45 »), mais le moteur compare des bigrammes sans espaces,
 *      ou « 5 56x45 » et « 556x45 » se rejoignent.
 *
 *   3. `shortName` est irrecuperable (placeholder, aucun equivalent). C'est la
 *      seule perte face a GraphQL : le badge de nom court disparait de la carte.
 *      Sans consequence sur la detection, qui lit le nom complet de l'infobulle.
 *
 *   4. Pas de `sellFor` mais `sellToTrader`, qui designe les traders par id.
 *      Une requete sur `/{gameMode}/traders` fournit la table de correspondance.
 *
 *   5. Le mode de jeu est un segment de chemin, pas un argument.
 */

import type { GameMode, TarkovItem, VendorOffer } from '../types/index';
import { TarkovApiError, type FetchResult } from './TarkovApi';
import { createLogger } from './Logger';

const log = createLogger('api-json');

const BASE_URL = 'https://json.tarkov.dev';
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;

/** Reponse brute d'un item. Tous les champs sont faillibles. */
interface RawItem {
  id?: unknown;
  normalizedName?: unknown;
  wikiLink?: unknown;
  basePrice?: unknown;
  avg24hPrice?: unknown;
  lastLowPrice?: unknown;
  width?: unknown;
  height?: unknown;
  iconLink?: unknown;
  types?: unknown;
  sellToTrader?: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Reconstruit le nom d'affichage depuis l'URL du wiki.
 * « https://escapefromtarkov.fandom.com/wiki/TerraGroup_Labs_keycard_(Blue) »
 * -> « TerraGroup Labs keycard (Blue) »
 */
function nameFromWikiLink(wikiLink: unknown): string | null {
  if (typeof wikiLink !== 'string' || wikiLink.length === 0) return null;
  const last = wikiLink.split('/').pop();
  if (!last) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Une URL mal encodee ne doit pas faire perdre l'item entier.
    decoded = last;
  }
  const name = decoded.replace(/_/g, ' ').trim();
  return name.length > 1 ? name : null;
}

/** « map-piece » -> « Map piece ». Repli quand le wiki manque. */
function nameFromSlug(slug: string): string {
  const words = slug.split('-').filter(Boolean);
  if (words.length === 0) return slug;
  const [first, ...rest] = words;
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(' ');
}

/** « btr-driver » -> « Btr Driver ». Suffisant pour un libelle de carte. */
function traderNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export class TarkovJsonClient {
  /**
   * Recupere tous les items d'un mode de jeu, prix traders inclus.
   * @throws {TarkovApiError} si toutes les tentatives echouent.
   */
  async fetchAllItems(gameMode: GameMode, signal?: AbortSignal): Promise<FetchResult> {
    const started = Date.now();

    // Les traders sont demandes d'abord : petite reponse, et un echec ici evite
    // de telecharger 16 Mo d'items pour rien.
    const traders = await this.fetchTraders(gameMode, signal);
    const payload = await this.request(`${BASE_URL}/${gameMode}/items`, signal);

    const rawItems = (payload as { data?: { items?: unknown } })?.data?.items;
    if (!rawItems || typeof rawItems !== 'object') {
      throw new TarkovApiError('champ `data.items` absent de la reponse JSON', false);
    }

    const items: TarkovItem[] = [];
    let missingWikiName = 0;

    for (const entry of Object.values(rawItems as Record<string, RawItem>)) {
      if (!entry || typeof entry !== 'object') continue;
      const id = typeof entry.id === 'string' ? entry.id : null;
      const slug = typeof entry.normalizedName === 'string' ? entry.normalizedName : null;
      if (!id || !slug) continue;

      const wikiName = nameFromWikiLink(entry.wikiLink);
      if (!wikiName) missingWikiName++;
      const name = wikiName ?? nameFromSlug(slug);

      items.push({
        id,
        name,
        // Le nom court n'existe pas dans cette source : on reprend le nom complet
        // plutot que d'exposer un placeholder illisible.
        shortName: name,
        basePrice: toNumber(entry.basePrice, 0),
        avg24hPrice: toNumberOrNull(entry.avg24hPrice),
        lastLowPrice: toNumberOrNull(entry.lastLowPrice),
        // Un item occupe au moins une case : 0 casserait le prix au slot.
        width: Math.max(1, toNumber(entry.width, 1)),
        height: Math.max(1, toNumber(entry.height, 1)),
        iconLink: typeof entry.iconLink === 'string' && entry.iconLink ? entry.iconLink : null,
        types: Array.isArray(entry.types) ? entry.types.filter((t): t is string => typeof t === 'string') : [],
        sellFor: this.normalizeSellToTrader(entry.sellToTrader, traders),
        // Le slug sert d'alias de recherche : il couvre 100 % des items, la ou
        // le nom du wiki en manque quelques pourcents.
        searchAliases: [slug.replace(/-/g, ' ')],
      });
    }

    if (items.length === 0) throw new TarkovApiError("l'API JSON a renvoye 0 item exploitable", true);

    log.info(
      `${items.length} items recuperes (${gameMode}) en ${Date.now() - started} ms, ` +
        `${traders.size} traders, ${missingWikiName} noms deduits du slug`,
    );
    return { items, gameModeIgnored: false };
  }

  /** Table id de trader -> nom affichable. */
  private async fetchTraders(gameMode: GameMode, signal?: AbortSignal): Promise<Map<string, string>> {
    const payload = await this.request(`${BASE_URL}/${gameMode}/traders`, signal);
    const raw = (payload as { data?: unknown })?.data;
    const traders = new Map<string, string>();

    if (!raw || typeof raw !== 'object') {
      // Sans la table, les prix traders seront simplement absents de la carte.
      log.warn('table des traders illisible, les prix traders seront masques');
      return traders;
    }

    for (const [id, value] of Object.entries(raw as Record<string, { normalizedName?: unknown }>)) {
      const slug = typeof value?.normalizedName === 'string' ? value.normalizedName : null;
      if (slug) traders.set(id, traderNameFromSlug(slug));
    }
    return traders;
  }

  /** `sellToTrader` -> `VendorOffer[]`, en resolvant les ids de traders. */
  private normalizeSellToTrader(raw: unknown, traders: Map<string, string>): VendorOffer[] {
    if (!Array.isArray(raw)) return [];
    const offers: VendorOffer[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const offer = entry as { trader?: unknown; priceRUB?: unknown };
      const priceRUB = toNumberOrNull(offer.priceRUB);
      if (priceRUB === null || priceRUB <= 0) continue;

      const traderId = typeof offer.trader === 'string' ? offer.trader : '';
      const vendorName = traders.get(traderId) ?? 'Trader';
      offers.push({
        vendorName,
        vendorSlug: vendorName.toLowerCase().replace(/\s+/g, '-'),
        priceRUB,
      });
    }
    return offers;
  }

  /** GET JSON avec timeout, annulation et backoff exponentiel. */
  private async request(url: string, signal?: AbortSignal): Promise<unknown> {
    let lastError: TarkovApiError = new TarkovApiError('aucune tentative effectuee', true);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new TarkovApiError('recuperation annulee', false);

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'tarkov-price-hover/1.0 (personal use)',
          },
          signal: combined,
        });

        if (!response.ok) {
          const retryable = response.status >= 500 || response.status === 429;
          throw new TarkovApiError(`HTTP ${response.status} ${response.statusText} sur ${url}`, retryable);
        }
        return await response.json();
      } catch (err) {
        if (err instanceof TarkovApiError) {
          lastError = err;
        } else {
          const name = (err as Error)?.name;
          if (name === 'TimeoutError') lastError = new TarkovApiError(`timeout apres ${REQUEST_TIMEOUT_MS} ms`, true);
          else if (name === 'AbortError') lastError = new TarkovApiError('requete annulee', false);
          else if (name === 'SyntaxError') lastError = new TarkovApiError('reponse JSON invalide', true);
          else lastError = new TarkovApiError(`erreur reseau : ${(err as Error)?.message ?? err}`, true);
        }

        if (!lastError.retryable || attempt === MAX_ATTEMPTS) break;
        const delay = 1000 * 2 ** (attempt - 1);
        log.warn(`tentative ${attempt}/${MAX_ATTEMPTS} echouee (${lastError.message}), nouvel essai dans ${delay} ms`);
        await sleep(delay);
      }
    }

    throw lastError;
  }
}
