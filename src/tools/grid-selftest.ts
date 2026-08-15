/**
 * tools/grid-selftest.ts
 * ----------------------
 * Verifie `detectGrid` sur des captures **reelles** d'inventaire.
 *
 * Le matching par icone repose entierement sur une mesure : le pas de la grille.
 * Une valeur fausse decoupe les cases de travers et rend toute comparaison
 * d'icone absurde. Ce test est donc la condition prealable a tout branchement.
 *
 * La verification ne suppose aucune valeur attendue — elle serait invention.
 * Elle exploite une propriete verifiable : tous les echantillons proviennent du
 * meme ecran, a la meme resolution et a la meme echelle d'interface. **Le pas
 * doit donc etre identique partout.** Une dispersion signale un detecteur qui
 * accroche du bruit ; une constante signale qu'il a trouve la grille.
 *
 * Les echantillons sont ceux que l'application ecrit quand `collectCalibration`
 * est actif : la fenetre de recherche en pleine resolution, plus l'objet que
 * l'OCR y a identifie avec certitude.
 *
 * Usage : `npm run test:grid`
 */

import { app, nativeImage } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '../types/index';
import { detectGrid, cellIndex, cellEdge } from '../services/GridDetector';
import { initLogger } from '../services/Logger';

// Voir `icon-selftest.ts` : lance par `--entry`, Electron ignore le nom du
// package et `getPath('userData')` designerait un dossier vide.
app.setName(APP_NAME);

interface Sample {
  file: string;
  itemName: string;
  slotWidth: number;
  slotHeight: number;
  cursorX: number;
  cursorY: number;
  sizeScale: number;
}

/**
 * Demi-cote de la fenetre analysee autour du curseur, en pixels a 1080p.
 *
 * Mesure sur les echantillons reels : a +-350 px l'autocorrelation accroche
 * encore la seconde harmonique (135 px au lieu de 67), faute de periodes en
 * nombre suffisant pour que la fondamentale ressorte. A +-500 elle tranche
 * correctement. Au-dela, les panneaux voisins reviennent dans le champ.
 */
const SEARCH_HALF_AT_1080P = 500;

/** Ecart-type d'une serie. Mesure la dispersion des pas trouves. */
function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

async function main(): Promise<void> {
  const userData = app.getPath('userData');
  initLogger(userData, true);

  const dir = path.join(userData, 'calibration');
  const indexFile = path.join(dir, 'index.jsonl');

  console.log('\nAuto-test du detecteur de grille\n');

  if (!existsSync(indexFile)) {
    console.error(
      `Aucun echantillon dans ${dir}.\n` +
        'Active `collectCalibration` dans config.json, joue quelques minutes, puis relance.',
    );
    app.exit(1);
    return;
  }

  const samples = readFileSync(indexFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Sample);

  console.log(`${samples.length} echantillons\n`);

  const pitches: number[] = [];
  let failures = 0;

  for (const sample of samples) {
    const file = path.join(dir, sample.file);
    if (!existsSync(file)) continue;

    const image = nativeImage.createFromPath(file);
    const size = image.getSize();
    if (image.isEmpty()) {
      console.log(`[ECHEC] ${sample.file.padEnd(16)} image illisible`);
      failures++;
      continue;
    }

    // Fenetre centree sur le curseur, et non l'ecran entier.
    //
    // Un ecran complet contient plusieurs structures periodiques concurrentes —
    // panneau personnage, gilet tactique, poches, barre d'acces rapide — chacune
    // avec son propre pas. Leurs projections se superposent et aucune periode ne
    // ressort : mesure faite, la detection echouait sur les trois echantillons.
    // Restreinte au voisinage du curseur, elle ne voit que la grille survolee.
    //
    // La taille est un compromis : trop etroite, il n'y a pas assez de periodes
    // pour que l'autocorrelation tranche ; trop large, les panneaux voisins
    // reviennent. +-350 px a 1080p tient environ dix cases.
    const half = Math.round(SEARCH_HALF_AT_1080P * sample.sizeScale);
    const wx = Math.max(0, Math.min(sample.cursorX - half, size.width - 1));
    const wy = Math.max(0, Math.min(sample.cursorY - half, size.height - 1));
    const ww = Math.min(half * 2, size.width - wx);
    const wh = Math.min(half * 2, size.height - wy);
    const window = image.crop({ x: wx, y: wy, width: ww, height: wh });

    const started = Date.now();
    const grid = detectGrid(window.toBitmap(), ww, wh, sample.sizeScale);
    const elapsed = Date.now() - started;

    if (!grid) {
      console.log(
        `[ECHEC] ${sample.file.padEnd(16)} ${sample.itemName.slice(0, 26).padEnd(28)} ` +
          `aucune grille detectee  (${elapsed} ms)`,
      );
      failures++;
      continue;
    }

    pitches.push(grid.pitchX);

    // Case contenant le curseur, d'apres le pas et la phase trouves. Ses bords
    // doivent encadrer le curseur : c'est la verification que la phase est juste,
    // et non seulement la periode.
    // La phase est exprimee dans le repere de la fenetre analysee : le curseur
    // doit y etre ramene avant toute comparaison.
    const localX = sample.cursorX - wx;
    const localY = sample.cursorY - wy;
    const cx = cellIndex(localX, grid.pitchX, grid.phaseX);
    const cy = cellIndex(localY, grid.pitchY, grid.phaseY);
    const left = cellEdge(cx, grid.pitchX, grid.phaseX);
    const top = cellEdge(cy, grid.pitchY, grid.phaseY);
    const encloses =
      localX >= left && localX < left + grid.pitchX && localY >= top && localY < top + grid.pitchY;

    console.log(
      `[OK]    ${sample.file.padEnd(16)} ${sample.itemName.slice(0, 26).padEnd(28)} ` +
        `pas ${String(grid.pitchX).padStart(3)}x${String(grid.pitchY).padStart(3)}  ` +
        `phase ${String(grid.phaseX).padStart(3)},${String(grid.phaseY).padStart(3)}  ` +
        `force ${grid.strength.toFixed(2)}  ` +
        `case ${encloses ? 'coherente' : 'INCOHERENTE'}  (${elapsed} ms)`,
    );
  }

  console.log('');
  if (pitches.length === 0) {
    console.log('VERDICT : aucune grille detectee. Le detecteur est inexploitable en l\'etat.');
    app.exit(1);
    return;
  }

  const min = Math.min(...pitches);
  const max = Math.max(...pitches);
  const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
  const deviation = standardDeviation(pitches);

  console.log('Pas detecte sur l\'ensemble des echantillons');
  console.log(`  detections   ${pitches.length}/${samples.length}  (${failures} echecs)`);
  console.log(`  minimum      ${min}`);
  console.log(`  maximum      ${max}`);
  console.log(`  moyenne      ${mean.toFixed(1)}`);
  console.log(`  ecart-type   ${deviation.toFixed(2)}`);

  console.log('');

  // Deux criteres independants, tous deux necessaires.
  //
  // 1. La **constance** : tous les echantillons viennent du meme ecran, a la
  //    meme resolution et a la meme echelle d'interface, donc le pas doit y etre
  //    identique. Une dispersion signale un detecteur qui accroche du bruit.
  //
  // 2. Le **taux de detection** : la constance ne veut rien dire sur une seule
  //    mesure. Un detecteur qui ne repond qu'une fois sur trois n'est pas
  //    exploitable, meme si cette unique reponse est juste — c'est precisement
  //    ce que l'ancien verdict declarait « exploitable » a tort.
  //
  // Certains echecs sont legitimes : un curseur pose sur les poches ou le gilet
  // ne survole pas une grille assez etendue pour qu'une periode ressorte. D'ou
  // un seuil a la majorite plutot qu'a l'unanimite.
  const detectionRate = pitches.length / samples.length;
  const consistent = max - min <= 3;
  const enough = pitches.length >= 2 && detectionRate >= 0.5;

  if (!enough) {
    console.log(
      `VERDICT : insuffisant. ${pitches.length} detection(s) sur ${samples.length} — ` +
        'trop peu pour conclure quoi que ce soit sur la constance du pas.',
    );
  } else if (!consistent) {
    console.log(
      `VERDICT : instable. Le pas varie de ${min} a ${max} px alors que tous les ` +
        'echantillons proviennent du meme ecran : le detecteur accroche autre chose que la grille.',
    );
  } else if (failures === 0 && max - min <= 1) {
    console.log(`VERDICT : fiable. Pas constant a ${Math.round(mean)} px sur tous les echantillons.`);
  } else {
    console.log(
      `VERDICT : exploitable. Pas a ${Math.round(mean)} px, dispersion de ${max - min} px, ` +
        `detecte sur ${pitches.length}/${samples.length} echantillons.`,
    );
  }
  console.log('');

  app.exit(enough && consistent ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error('auto-test en echec :', err);
  app.exit(1);
});
