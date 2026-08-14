/**
 * scripts/stutter-probe.mjs
 * -------------------------
 * Isole la capture d'ecran de tout le reste, pour savoir si c'est **elle** qui
 * fait saccader le jeu.
 *
 * Pourquoi ce test existe
 * -----------------------
 * Trois causes ont ete corrigees tour a tour — capture plein ecran, boucle qui
 * ne se calmait jamais, suivi de la carte a 40 Hz — et le jeu saccade toujours.
 * L'une des premisses est donc fausse. Plutot que d'en corriger une quatrieme au
 * hasard, ce script ne fait **qu'une seule chose** :
 *
 *   il copie une region de l'ecran, huit fois par seconde, et rien d'autre.
 *
 * Pas d'Electron, pas de fenetre, pas d'overlay, pas d'OCR, pas de traitement
 * d'image, pas de surveillance du curseur. Un processus Node et le helper GDI.
 *
 * Interpretation
 * --------------
 *   Le jeu saccade pendant le test
 *     -> c'est `BitBlt` sur le contexte du bureau qui coute, en soi. Windows
 *        doit alors serialiser la composition avec la presentation du jeu.
 *        Aucune optimisation du pipeline n'y changera rien : il faudrait
 *        capturer moins souvent, ou pas du tout entre deux survols.
 *
 *   Le jeu ne saccade pas
 *     -> la capture est hors de cause, et le cout est ailleurs : fenetre
 *        transparente always-on-top, processus Electron, surveillant de fenetre
 *        active. Le test suivant les isolera un a un.
 *
 * Les pics de duree sont eux-memes un indice : une copie qui passe de 8 a 130 ms
 * signale une attente sur le compositeur, donc une contention avec le jeu.
 *
 * Usage : `npm run test:stutter` puis basculer sur Tarkov et jouer 60 s.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = path.join(root, 'dist/native/RegionCapture.exe');

if (!existsSync(exe)) {
  console.error(`Helper introuvable : ${exe}\nLancez d'abord "npm run build".`);
  process.exit(1);
}

/** Cadence reelle de la detection : un cycle toutes les 125 ms au maximum. */
const INTERVAL_MS = 125;
/** Duree du test. Assez longue pour couvrir plusieurs minutes de jeu reel. */
const DURATION_MS = 60_000;
/** Taille de la fenetre de recherche a l'echelle de travail (voir TARGET_SIZE_SCALE). */
const WIDTH = 857;
const HEIGHT = 195;

const child = spawn(exe, ['--no-captureblt'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (chunk) => console.error('helper:', chunk.toString().trim()));

let buffer = Buffer.alloc(0);
const waiters = [];
child.stdout.on('data', (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  for (;;) {
    if (!waiters.length || buffer.length < 4) return;
    const length = buffer.readInt32LE(0);
    if (length === 0) {
      buffer = buffer.subarray(4);
      waiters.shift()(null);
      continue;
    }
    if (buffer.length < 4 + length) return;
    const payload = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    waiters.shift()(payload);
  }
});

const capture = (x, y, w, h) =>
  new Promise((resolve) => {
    waiters.push(resolve);
    child.stdin.write(`${x} ${y} ${w} ${h} ${w} ${h}\n`);
  });

console.log(`
Capture isolee : ${WIDTH}x${HEIGHT} px, toutes les ${INTERVAL_MS} ms, pendant ${DURATION_MS / 1000} s.
Rien d'autre ne tourne : ni Electron, ni overlay, ni OCR.

--> Basculez maintenant sur Tarkov et jouez normalement.
`);

const times = [];
const started = Date.now();

while (Date.now() - started < DURATION_MS) {
  const cycleStart = process.hrtime.bigint();
  await capture(600, 400, WIDTH, HEIGHT);
  const elapsed = Number(process.hrtime.bigint() - cycleStart) / 1e6;
  times.push(elapsed);

  const remaining = INTERVAL_MS - elapsed;
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

child.stdin.end();

times.sort((a, b) => a - b);
const at = (fraction) => times[Math.min(times.length - 1, Math.floor(times.length * fraction))];
const total = times.reduce((sum, value) => sum + value, 0);

console.log(`
${times.length} captures en ${((Date.now() - started) / 1000).toFixed(0)} s

  mediane  ${at(0.5).toFixed(2)} ms
  p90      ${at(0.9).toFixed(2)} ms
  p99      ${at(0.99).toFixed(2)} ms
  maximum  ${times[times.length - 1].toFixed(2)} ms

  charge   ${((total / (Date.now() - started)) * 100).toFixed(1)} % du temps ecoule

Un p99 tres au-dessus de la mediane signale une attente sur le compositeur,
donc une contention avec le jeu.
`);
