/**
 * tools/icon-selftest.ts
 * ----------------------
 * Auto-test de l'index d'icones. Repond a la seule question qui decide de la
 * viabilite du matching par icone :
 *
 *   **Deux objets differents produisent-ils des empreintes suffisamment
 *   eloignees pour etre distingues ?**
 *
 * Une empreinte de 256 bits n'a d'interet que si les objets d'une meme taille de
 * grille s'y repartissent largement. Si des dizaines d'objets tombent a moins de
 * quelques bits les uns des autres, aucun seuil ne pourra les separer et
 * l'approche est morte — mieux vaut le savoir avant de brancher quoi que ce soit
 * sur la boucle de detection.
 *
 * Le test mesure donc, pour chaque objet, la distance a son plus proche voisin
 * **different**, et resume la distribution. Il ne teste pas encore la
 * correspondance avec une capture reelle : c'est l'etape suivante.
 *
 * Usage : `npm run test:icons`
 */

import { app } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
// eslint-disable-next-line import/order
import { APP_NAME } from '../types/index';
import path from 'node:path';
import { IconIndex, type IconEntry } from '../services/IconIndex';
import { hammingDistance, HASH_WORDS } from '../services/IconHash';
import { initLogger } from '../services/Logger';
import type { TarkovItem } from '../types/index';

/**
 * Lance par `--entry <fichier.js>`, Electron ne demarre pas sur le dossier du
 * projet : il ignore donc le `name` du package.json et retient « Electron ».
 * `getPath('userData')` designerait alors un dossier vide, et le test ne
 * trouverait ni le catalogue de prix ni son propre cache d'empreintes.
 */
app.setName(APP_NAME);

/** Taille de l'empreinte, en bits. Depend de la grille et du nombre de canaux. */
const HASH_BITS = HASH_WORDS * 32;

/**
 * Distances en deca desquelles deux objets sont juges indistinguables.
 * Exprimees en fraction de l'empreinte plutot qu'en bits absolus, pour rester
 * comparables d'une version de `IconHash` a l'autre.
 */
const COLLISION_HARD = Math.round(HASH_BITS * 0.04);
const COLLISION_SOFT = Math.round(HASH_BITS * 0.08);

/** Lit le cache de prix ecrit par l'application. */
function loadItems(userData: string): TarkovItem[] {
  for (const name of ['prices-pve.json', 'prices-regular.json']) {
    const file = path.join(userData, 'cache', name);
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const items = Array.isArray(raw)
        ? raw
        : ((raw as { items?: unknown[]; data?: unknown[] }).items ??
           (raw as { items?: unknown[]; data?: unknown[] }).data ??
           []);
      if (Array.isArray(items) && items.length > 0) {
        console.log(`Catalogue : ${items.length} objets depuis ${name}\n`);
        return items as TarkovItem[];
      }
    } catch {
      /* fichier suivant */
    }
  }
  return [];
}

/** Quantile d'un tableau deja trie. */
function quantile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index]!;
}

/**
 * Pour chaque objet, distance a son plus proche voisin de meme taille de grille.
 * Comparaison exhaustive a l'interieur de chaque groupe : c'est un test hors
 * ligne, la simplicite prime sur la vitesse.
 */
function nearestNeighbourDistances(entries: readonly IconEntry[]): {
  distances: number[];
  worstPairs: Array<{ a: string; b: string; distance: number; slot: string }>;
} {
  const groups = new Map<string, IconEntry[]>();
  for (const entry of entries) {
    const key = `${entry.w}x${entry.h}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const distances: number[] = [];
  const worstPairs: Array<{ a: string; b: string; distance: number; slot: string }> = [];

  for (const [slot, group] of groups) {
    // Un objet seul dans sa taille de grille ne peut etre confondu avec rien.
    if (group.length < 2) {
      for (const _ of group) distances.push(HASH_BITS);
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      let best = HASH_BITS;
      let bestOther = '';
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const d = hammingDistance(group[i]!.hash, group[j]!.hash);
        if (d < best) {
          best = d;
          bestOther = group[j]!.id;
        }
      }
      distances.push(best);
      if (best < COLLISION_HARD) {
        worstPairs.push({ a: group[i]!.id, b: bestOther, distance: best, slot });
      }
    }
  }
  return { distances, worstPairs };
}

async function main(): Promise<void> {
  const userData = app.getPath('userData');
  initLogger(userData, true);

  console.log('\nAuto-test de l\'index d\'icones\n');

  const items = loadItems(userData);
  if (items.length === 0) {
    console.error(
      'Aucun catalogue en cache. Lance l\'application une fois (`npm start`) pour ' +
        'qu\'elle telecharge les prix, puis relance ce test.',
    );
    app.exit(1);
    return;
  }

  const index = new IconIndex(userData);

  if (index.load()) {
    console.log(`Index charge depuis le cache : ${index.size} empreintes\n`);
  } else {
    console.log('Aucun cache : construction de l\'index (telechargement des icones)...\n');
    let lastPercent = -1;
    await index.build(items, ({ done, total, failed }) => {
      const percent = Math.floor((done / total) * 100);
      // Une ligne tous les 5 % : un journal par icone noierait le resultat.
      if (percent >= lastPercent + 5) {
        lastPercent = percent;
        console.log(`  ${String(percent).padStart(3)} %  ${done}/${total}  (${failed} echecs)`);
      }
    });
    console.log('');
  }

  const entries = index.all;
  if (entries.length === 0) {
    console.error('Index vide : aucune icone n\'a pu etre decodee.');
    app.exit(1);
    return;
  }

  // --- Couverture ---
  const withIcon = items.filter((i) => i.iconLink && i.width > 0 && i.height > 0).length;
  console.log('Couverture');
  console.log(`  objets avec icone      ${withIcon}`);
  console.log(`  empreintes calculees   ${entries.length}  (${Math.round((entries.length / withIcon) * 100)} %)`);

  // --- Repartition par taille de grille ---
  const groups = new Map<string, number>();
  for (const e of entries) groups.set(`${e.w}x${e.h}`, (groups.get(`${e.w}x${e.h}`) ?? 0) + 1);
  const biggest = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`  tailles de grille      ${groups.size}`);
  console.log(`  groupes les plus gros  ${biggest.map(([k, v]) => `${k}:${v}`).join('  ')}`);

  // --- Pouvoir discriminant ---
  const { distances, worstPairs } = nearestNeighbourDistances(entries);
  const sorted = [...distances].sort((a, b) => a - b);
  const hard = distances.filter((d) => d < COLLISION_HARD).length;
  const soft = distances.filter((d) => d < COLLISION_SOFT).length;

  console.log(`\nDistance au plus proche voisin de meme taille (0 = identique, ${HASH_BITS} bits au total)`);
  console.log(`  minimum                ${sorted[0]}`);
  console.log(`  1er centile            ${quantile(sorted, 0.01)}`);
  console.log(`  5e centile             ${quantile(sorted, 0.05)}`);
  console.log(`  mediane                ${quantile(sorted, 0.5)}`);
  console.log(`  moyenne                ${Math.round(distances.reduce((a, b) => a + b, 0) / distances.length)}`);
  console.log(`\n  sous ${COLLISION_HARD} bits (indistinguables)  ${hard}  (${((hard / distances.length) * 100).toFixed(1)} %)`);
  console.log(`  sous ${COLLISION_SOFT} bits (a risque)          ${soft}  (${((soft / distances.length) * 100).toFixed(1)} %)`);

  if (worstPairs.length > 0) {
    const byId = new Map(items.map((i) => [i.id, i.name]));
    console.log('\nCollisions les plus serrees');
    for (const pair of worstPairs.sort((a, b) => a.distance - b.distance).slice(0, 10)) {
      console.log(
        `  ${String(pair.distance).padStart(3)} bits  ${pair.slot.padEnd(4)} ` +
          `${(byId.get(pair.a) ?? pair.a).slice(0, 32).padEnd(34)} <-> ${(byId.get(pair.b) ?? pair.b).slice(0, 32)}`,
      );
    }
  }

  // --- Icones partagees ---
  // Distingue l'irremediable du perfectible : Tarkov reutilise une meme image
  // pour des objets differents (toutes les cles de dortoir, par exemple).
  // Aucune methode par image ne les separera jamais, quel que soit le
  // descripteur — ces objets exigent la lecture du nom.
  const bySha = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.sha) continue;
    const bucket = bySha.get(e.sha);
    if (bucket) bucket.push(e.id);
    else bySha.set(e.sha, [e.id]);
  }
  const sharedIds = new Set<string>();
  for (const ids of bySha.values()) {
    if (ids.length > 1) for (const id of ids) sharedIds.add(id);
  }

  const collidingIds = new Set<string>();
  for (const pair of worstPairs) collidingIds.add(pair.a);
  const sharedAmongColliding = [...collidingIds].filter((id) => sharedIds.has(id)).length;

  console.log('\nOrigine de l\'indistinguabilite');
  console.log(`  objets a icone partagee    ${sharedIds.size}  (${((sharedIds.size / entries.length) * 100).toFixed(1)} %)  -> irremediable`);
  console.log(
    `  dont parmi les collisions  ${sharedAmongColliding} / ${collidingIds.size}` +
      `  -> les ${collidingIds.size - sharedAmongColliding} autres relevent du descripteur`,
  );

  // --- Verdict ---
  const ratio = hard / distances.length;
  console.log('');
  if (ratio < 0.02) {
    console.log(`VERDICT : viable. ${(ratio * 100).toFixed(1)} % d'objets indistinguables, l'OCR suffira en repli.`);
  } else if (ratio < 0.1) {
    console.log(`VERDICT : utilisable avec reserve. ${(ratio * 100).toFixed(1)} % d'objets indistinguables.`);
  } else {
    console.log(`VERDICT : insuffisant seul. ${(ratio * 100).toFixed(1)} % d'objets indistinguables.`);
  }
  console.log('');

  app.exit(0);
}

app.whenReady().then(main).catch((err) => {
  console.error('auto-test en echec :', err);
  app.exit(1);
});
