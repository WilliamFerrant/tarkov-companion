/**
 * services/ItemIndex.ts
 * ---------------------
 * Index de recherche floue nom d'item -> item, et calcul du resume de prix.
 *
 * Pourquoi du flou : la sortie de Tesseract sur un tooltip de jeu contient
 * presque toujours du bruit (caracteres parasites, lettres manquantes, bouts de
 * l'interface capturee en marge). Un lookup exact ne matcherait quasiment jamais.
 *
 * Strategie de scoring, du signal le plus fort au plus faible :
 *
 *   1. Egalite exacte apres normalisation           -> 1.00
 *   2. Le texte OCR *contient* le nom de l'item     -> 0.90 a 0.99
 *      C'est le cas dominant : la ligne OCR vaut souvent « Salewa FIRST AID KIT 3/12 ».
 *      A egalite on garde le nom le plus long, donc le plus specifique
 *      (« AK-74N 5.45x39 assault rifle » plutot que « AK-74N »).
 *   3. Coefficient de Dice sur bigrammes de caracteres -> 0.00 a 0.89
 *      Tolerant aux substitutions et omissions, contrairement a une distance
 *      d'edition brute, et calculable en O(n) sur des ensembles pre-calcules.
 *
 * Les chiffres ne sont volontairement pas replies vers des lettres (0->O, 1->l) :
 * les noms Tarkov en sont pleins (« 5.45x39mm BP », « M4A1 », « AK-74N ») et le
 * repli detruirait plus d'information qu'il n'en recupererait.
 */

import type { PriceSummary, TarkovItem, VendorOffer } from '../types/index';

/** Slug du Flea Market dans le champ `sellFor` de tarkov.dev. */
const FLEA_SLUG = 'flea-market';

/** Longueur minimale d'un nom pour autoriser un match par inclusion. */
const MIN_CONTAINMENT_LEN = 4;

/**
 * Normalise une chaine pour la comparaison :
 * minuscules, tout caractere non alphanumerique devient une espace, espaces
 * collapses. « 5.45x39mm BP gs » -> « 5 45x39mm bp gs ».
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Ensemble des bigrammes de caracteres d'une chaine normalisee (espaces retires). */
function bigrams(normalized: string): Set<string> {
  const compact = normalized.replace(/ /g, '');
  const set = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) set.add(compact.slice(i, i + 2));
  return set;
}

/**
 * Coefficient de Dice : 2*|A∩B| / (|A|+|B|). Renvoie 0 a 1.
 * Robuste au bruit OCR car une lettre erronee ne casse que 2 bigrammes.
 */
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  // Itere sur le plus petit ensemble pour limiter les lookups.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Entree d'index : un alias (nom complet ou nom court) pointant vers un item. */
interface IndexEntry {
  normalized: string;
  bigrams: Set<string>;
  item: TarkovItem;
  /** Le nom court est moins fiable (souvent ambigu) : son score est legerement penalise. */
  isShortName: boolean;
}

export interface MatchCandidate {
  item: TarkovItem;
  score: number;
  /** Le libelle indexe qui a produit le match. */
  matchedName: string;
}

export class ItemIndex {
  private entries: IndexEntry[] = [];
  private exact = new Map<string, TarkovItem>();
  private byId = new Map<string, TarkovItem>();

  /** (Re)construit l'index. Cout : ~30 ms pour 3000 items, uniquement au refresh. */
  build(items: readonly TarkovItem[]): void {
    this.entries = [];
    this.exact = new Map();
    this.byId = new Map();

    for (const item of items) {
      this.byId.set(item.id, item);
      this.addAlias(item.name, item, false);
      // Le nom court n'est indexe que s'il differe et reste discriminant.
      if (item.shortName && item.shortName !== item.name && item.shortName.length >= 3) {
        this.addAlias(item.shortName, item, true);
      }
      // Alias supplementaires (slug de l'API JSON). Indexes comme des noms
      // complets : ce sont des libelles entiers, pas des abreviations.
      for (const alias of item.searchAliases ?? []) {
        if (alias && normalize(alias) !== normalize(item.name)) this.addAlias(alias, item, false);
      }
    }
  }

  get size(): number {
    return this.byId.size;
  }

  getById(id: string): TarkovItem | undefined {
    return this.byId.get(id);
  }

  private addAlias(rawName: string, item: TarkovItem, isShortName: boolean): void {
    const normalized = normalize(rawName);
    if (normalized.length < 2) return;
    // Le premier alias enregistre gagne : les noms complets sont ajoutes avant
    // les noms courts, donc un conflit favorise le nom complet.
    if (!this.exact.has(normalized)) this.exact.set(normalized, item);
    this.entries.push({ normalized, bigrams: bigrams(normalized), item, isShortName });
  }

  /**
   * Cherche les meilleurs items correspondant a un texte OCR.
   * @param rawQuery texte brut (une ligne OCR, ou le bloc complet)
   * @param limit    nombre de candidats renvoyes, tries par score decroissant
   */
  search(rawQuery: string, limit = 5): MatchCandidate[] {
    const query = normalize(rawQuery);
    if (query.length < 3 || this.entries.length === 0) return [];

    // Chemin rapide : correspondance exacte.
    const exactHit = this.exact.get(query);
    if (exactHit) return [{ item: exactHit, score: 1, matchedName: exactHit.name }];

    const queryBigrams = bigrams(query);

    let bestContainment: MatchCandidate | null = null;
    const scored: MatchCandidate[] = [];

    for (const entry of this.entries) {
      // --- Inclusion : le texte OCR contient le nom de l'item ---
      if (entry.normalized.length >= MIN_CONTAINMENT_LEN && query.includes(entry.normalized)) {
        // Plus le nom couvre le texte OCR, plus le match est sur.
        const coverage = entry.normalized.length / query.length;
        let score = 0.9 + 0.09 * coverage;
        if (entry.isShortName) score -= 0.06;
        if (!bestContainment || score > bestContainment.score) {
          bestContainment = { item: entry.item, score, matchedName: entry.normalized };
        }
        continue;
      }

      // --- Similarite floue ---
      let score = diceCoefficient(queryBigrams, entry.bigrams);
      if (entry.isShortName) score *= 0.94;
      // Seuil plancher : evite d'accumuler 3000 candidats a 0.05.
      if (score >= 0.3) scored.push({ item: entry.item, score, matchedName: entry.normalized });
    }

    if (bestContainment) scored.push(bestContainment);

    scored.sort((a, b) => b.score - a.score || b.matchedName.length - a.matchedName.length);

    // Deduplique par item : un item indexe deux fois (nom + nom court) ne doit
    // pas occuper deux places dans la liste de candidats.
    const seen = new Set<string>();
    const unique: MatchCandidate[] = [];
    for (const candidate of scored) {
      if (seen.has(candidate.item.id)) continue;
      seen.add(candidate.item.id);
      unique.push(candidate);
      if (unique.length >= limit) break;
    }
    return unique;
  }
}

/** Meilleure offre trader (Flea exclu), ou `null` si aucun trader n'achete l'item. */
export function bestTraderOffer(item: TarkovItem): VendorOffer | null {
  let best: VendorOffer | null = null;
  for (const offer of item.sellFor) {
    if (offer.vendorSlug === FLEA_SLUG) continue;
    if (!best || offer.priceRUB > best.priceRUB) best = offer;
  }
  return best;
}

/**
 * Prix Flea de reference : la moyenne 24h est plus stable que le dernier prix bas,
 * qui peut refleter une offre isolee. On retombe sur `lastLowPrice` si besoin.
 */
export function referenceFleaPrice(item: TarkovItem): number | null {
  if (item.avg24hPrice && item.avg24hPrice > 0) return item.avg24hPrice;
  if (item.lastLowPrice && item.lastLowPrice > 0) return item.lastLowPrice;
  return null;
}

/** Transforme un item + son score de match en donnees pretes a afficher. */
export function buildSummary(item: TarkovItem, matchScore: number, matchedFrom: string): PriceSummary {
  const slots = Math.max(1, item.width * item.height);
  const flea = referenceFleaPrice(item);
  const bestTrader = bestTraderOffer(item);
  // Le prix au slot se calcule sur la meilleure valorisation reelle de l'item :
  // au Flea si disponible, sinon la meilleure offre trader.
  const perSlotBase = flea ?? bestTrader?.priceRUB ?? null;

  return {
    id: item.id,
    name: item.name,
    shortName: item.shortName,
    iconLink: item.iconLink,
    width: item.width,
    height: item.height,
    slots,
    avg24hPrice: item.avg24hPrice,
    lastLowPrice: item.lastLowPrice,
    basePrice: item.basePrice,
    bestTrader,
    pricePerSlot: perSlotBase === null ? null : Math.round(perSlotBase / slots),
    fleaVsTrader: flea !== null && bestTrader ? flea - bestTrader.priceRUB : null,
    noFlea: item.types.includes('noFlea'),
    matchScore,
    matchedFrom,
  };
}
