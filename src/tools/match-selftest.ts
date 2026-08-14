/**
 * tools/match-selftest.ts
 * -----------------------
 * Test du moteur de correspondance floue face a du bruit OCR realiste.
 *
 * L'auto-test OCR (`npm run test:ocr`) travaille sur des tooltips synthetiques
 * parfaitement nets ; il valide le pretraitement mais pas la tolerance au bruit.
 * Ici on attaque `ItemIndex` directement avec les degradations reellement
 * produites par Tesseract sur un tooltip translucide pose sur une scene de jeu :
 *
 *   - substitutions classiques : l <-> I <-> 1, O <-> 0, S <-> 5, rn -> m
 *   - lettres manquantes ou dupliquees
 *   - texte d'interface capture en marge de la zone (poids, durabilite, prix)
 *   - nom tronque par une zone de capture trop etroite
 *
 * Deux familles de cas :
 *   POSITIFS — doivent trouver le bon item au-dessus du seuil.
 *   NEGATIFS — texte d'interface sans rapport ; doivent rester SOUS le seuil.
 *              Ce sont les plus importants : un faux positif affiche un prix
 *              faux, ce qui est pire que ne rien afficher.
 *
 * Ce script tourne en Node pur (aucune dependance Electron).
 * Usage : `npm run test:match`
 */

import { ItemIndex } from '../services/ItemIndex';
import { DEFAULT_CONFIG, type TarkovItem } from '../types/index';

const THRESHOLD = DEFAULT_CONFIG.matchThreshold;

/** Noms reels d'items Tarkov, dont plusieurs paires volontairement proches. */
const ITEM_NAMES = [
  'Salewa first aid kit',
  'Car first aid kit',
  'AI-2 medkit',
  'Grizzly medical kit',
  'IFAK personal tactical first aid kit',
  'Physical bitcoin',
  'GPU graphics card',
  'LEDX Skin Transilluminator',
  'Ophthalmoscope',
  'Golden neck chain',
  'Gold skull ring',
  'Bronze lion figurine',
  'AK-74N 5.45x39 assault rifle',
  'AKS-74N 5.45x39 assault rifle',
  'AKS-74U 5.45x39 assault rifle',
  'M4A1 5.56x45 assault rifle',
  '5.45x39mm BP gs',
  '5.45x39mm BS gs',
  'Paca soft armor',
  '6B43 Zabralo-Sh body armor',
  'Tetriz portable game console',
  'Can of TarCola soda',
  'Bottle of water',
  'Pack of sugar',
  'Military COFDM Wireless Signal Transmitter',
  'Tank battery',
  'Car battery',
  'Wires',
  'Gunpowder "Kite"',
  'Graphics card',
];

function makeItems(): TarkovItem[] {
  return ITEM_NAMES.map((name, i) => ({
    id: `item-${i}`,
    name,
    shortName: name.split(' ')[0] ?? name,
    basePrice: 1000,
    avg24hPrice: 10_000,
    lastLowPrice: 9_000,
    width: 1,
    height: 1,
    iconLink: null,
    types: [],
    sellFor: [],
  }));
}

interface Case {
  /** Texte tel que le rendrait Tesseract. */
  ocr: string;
  /** Nom d'item attendu, ou `null` si aucun match ne doit passer le seuil. */
  expected: string | null;
  /** Ce que le cas eprouve, affiche en cas d'echec. */
  note: string;
}

const CASES: Case[] = [
  // --- Positifs : bruit de substitution ---
  { ocr: 'Salewa flrst ald kit', expected: 'Salewa first aid kit', note: 'i -> l' },
  { ocr: 'Physlcal bitcoln', expected: 'Physical bitcoin', note: 'i -> l' },
  { ocr: 'G0lden neck chaln', expected: 'Golden neck chain', note: 'o -> 0' },
  { ocr: 'LEDX Skln Transllluminator', expected: 'LEDX Skin Transilluminator', note: 'i -> l multiple' },
  { ocr: 'Tetnz portable garne console', expected: 'Tetriz portable game console', note: 'ri -> n, m -> rn' },
  { ocr: 'Bronze Iion figurlne', expected: 'Bronze lion figurine', note: 'l -> I' },

  // --- Positifs : caracteres manquants ou en trop ---
  { ocr: 'Grizly medical kit', expected: 'Grizzly medical kit', note: 'lettre manquante' },
  { ocr: 'Cann of TarCola sodaa', expected: 'Can of TarCola soda', note: 'lettres dupliquees' },
  { ocr: 'Ophthalmoscop', expected: 'Ophthalmoscope', note: 'derniere lettre coupee' },

  // --- Positifs : texte d'interface capture autour du nom ---
  { ocr: 'Salewa first aid kit 12/12', expected: 'Salewa first aid kit', note: 'charges affichees' },
  { ocr: 'GPU graphics card Weight: 0.60 kg', expected: 'GPU graphics card', note: 'poids en marge' },
  { ocr: '| Physical bitcoin |', expected: 'Physical bitcoin', note: 'bordures capturees' },
  { ocr: 'Paca soft armor Durability: 40/40', expected: 'Paca soft armor', note: 'durabilite' },

  // --- Positifs : discrimination entre noms tres proches ---
  { ocr: 'AKS-74N 5.45x39 assault rifle', expected: 'AKS-74N 5.45x39 assault rifle', note: 'AKS vs AK' },
  { ocr: 'AK-74N 5.45x39 assault rifle', expected: 'AK-74N 5.45x39 assault rifle', note: 'AK vs AKS' },
  { ocr: '5.45x39mm BP gs', expected: '5.45x39mm BP gs', note: 'BP vs BS' },
  { ocr: 'Car first aid kit', expected: 'Car first aid kit', note: 'Car vs Salewa' },
  { ocr: 'Car battery', expected: 'Car battery', note: 'Car vs Tank battery' },

  // --- Negatifs : elements d'interface, aucun item ne doit correspondre ---
  { ocr: 'STASH', expected: null, note: 'titre de panneau' },
  { ocr: 'Search items', expected: null, note: 'champ de recherche' },
  { ocr: 'FILTER BY', expected: null, note: 'bouton de filtre' },
  { ocr: '1 234 567', expected: null, note: 'montant seul' },
  { ocr: 'Insurance', expected: null, note: "onglet d'interface" },
  { ocr: 'THERAPIST LL2', expected: null, note: 'nom de trader' },
  { ocr: '~~ ,,, ..', expected: null, note: 'bruit pur' },

  // --- Negatifs releves sur l'ecran d'equipement, ou un faux positif a ete
  //     observe en jeu : une correspondance a 63 % affichait « Aluminum splint »
  //     sur du texte d'interface quelconque. ---
  { ocr: 'TACTICAL RIG', expected: null, note: 'libelle d equipement' },
  { ocr: 'SPECIAL SLOTS', expected: null, note: 'libelle d equipement' },
  { ocr: 'QUICK USE', expected: null, note: 'barre d acces rapide' },
  { ocr: 'NEW PRESET 1', expected: null, note: 'nom de preset' },
  { ocr: 'ON SLING', expected: null, note: 'emplacement d arme' },
  { ocr: 'BODY ARMOR', expected: null, note: 'emplacement d armure' },
  { ocr: 'CUSTOMIZATION', expected: null, note: 'onglet' },
  { ocr: 'Aluminum spl', expected: null, note: 'nom tronque trop court pour trancher' },
];

function main(): void {
  const index = new ItemIndex();
  index.build(makeItems());

  console.log(`\nTest de correspondance floue — seuil ${THRESHOLD}, ${index.size} items indexes\n`);

  let passed = 0;
  const failures: string[] = [];

  for (const testCase of CASES) {
    const [best] = index.search(testCase.ocr, 1);
    const accepted = best && best.score >= THRESHOLD ? best : null;
    const got = accepted ? accepted.item.name : null;
    const ok = got === testCase.expected;

    if (ok) passed++;
    else {
      failures.push(
        `${testCase.note} — « ${testCase.ocr} » : attendu ${testCase.expected ?? 'aucun match'}, ` +
          `obtenu ${got ?? 'aucun match'} (score ${best?.score.toFixed(3) ?? '—'})`,
      );
    }

    const label = ok ? '[OK]  ' : '[ECHEC]';
    const scoreText = best ? best.score.toFixed(3) : '  —  ';
    console.log(`${label} ${scoreText}  ${testCase.ocr.padEnd(40)} ${testCase.note}`);
  }

  console.log(`\n${passed}/${CASES.length} cas conformes.`);
  if (failures.length > 0) {
    console.log('\nEchecs :');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  console.log();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main();
