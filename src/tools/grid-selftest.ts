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

    const started = Date.now();
    const grid = detectGrid(image.toBitmap(), size.width, size.height, sample.sizeScale);
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
    const cx = cellIndex(sample.cursorX, grid.pitchX, grid.phaseX);
    const cy = cellIndex(sample.cursorY, grid.pitchY, grid.phaseY);
    const left = cellEdge(cx, grid.pitchX, grid.phaseX);
    const top = cellEdge(cy, grid.pitchY, grid.phaseY);
    const encloses =
      sample.cursorX >= left &&
      sample.cursorX < left + grid.pitchX &&
      sample.cursorY >= top &&
      sample.cursorY < top + grid.pitchY;

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
  // Tous les echantillons viennent du meme ecran : le pas doit etre constant.
  if (failures === 0 && max - min <= 1) {
    console.log(`VERDICT : fiable. Pas constant a ${Math.round(mean)} px sur tous les echantillons.`);
  } else if (max - min <= 3) {
    console.log(`VERDICT : exploitable. Pas a ${Math.round(mean)} px, dispersion de ${max - min} px.`);
  } else {
    console.log(
      `VERDICT : instable. Le pas varie de ${min} a ${max} px alors que tous les ` +
        'echantillons proviennent du meme ecran : le detecteur accroche autre chose que la grille.',
    );
  }
  console.log('');

  app.exit(0);
}

app.whenReady().then(main).catch((err) => {
  console.error('auto-test en echec :', err);
  app.exit(1);
});
