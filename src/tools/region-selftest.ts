/**
 * tools/region-selftest.ts
 * ------------------------
 * Verifie la capture par region de bout en bout, dans Electron.
 *
 * Ce que ce test prouve, et que les mesures en Node pur ne prouvent pas :
 *
 *   1. le helper GDI se lance depuis le processus principal d'Electron ;
 *   2. son tampon BGRA est accepte par `nativeImage.createFromBitmap` — le point
 *      qui a demande de forcer l'alpha cote C#, GDI le laissant a zero, ce qui
 *      aurait produit une image entierement transparente ;
 *   3. l'image survit a `crop()` et `toPNG()`, les deux operations que le
 *      pipeline applique ensuite ;
 *   4. le cout reel, mesure a la place ou il sera paye.
 *
 * Lancement : `npm run test:region`
 */

import { app, screen, nativeImage } from 'electron';
import path from 'node:path';
import { RegionGrabber } from '../services/RegionGrabber';
import { preprocessForOcr } from '../services/ScreenCapture';

/** Taille representative de la fenetre de recherche reelle, a 1440p. */
const WIDTH = 900;
const HEIGHT = 220;

/** Nombre de captures chronometrees. La premiere paie le demarrage du helper. */
const SAMPLES = 40;

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function main(): Promise<void> {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const width = Math.round(display.bounds.width * scale);
  const height = Math.round(display.bounds.height * scale);
  console.log(`\nEcran ${display.bounds.width}x${display.bounds.height} logiques ` +
    `@ ${scale} -> ${width}x${height} physiques\n`);

  const grabber = new RegionGrabber(app.getPath('userData'));

  // --- Appariement ecrans Electron / moniteurs Windows ---
  const monitors = await grabber.monitors();
  if (!monitors) {
    console.log('[ECHEC] le helper n\'a pas rapporte la geometrie des ecrans');
    grabber.stop();
    app.exit(1);
    return;
  }
  const displays = screen.getAllDisplays();
  console.log(`[${monitors.length === displays.length ? 'OK' : 'ECHEC'}]   ` +
    `${monitors.length} moniteurs rapportes, ${displays.length} ecrans Electron`);

  const byPosition = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    a.x - b.x || a.y - b.y;
  const sortedDisplays = [...displays].sort((a, b) => byPosition(a.bounds, b.bounds));
  const sortedMonitors = [...monitors].sort(byPosition);
  let paired = true;
  for (let i = 0; i < sortedDisplays.length; i++) {
    const d = sortedDisplays[i]!;
    const m = sortedMonitors[i]!;
    const factor = d.scaleFactor || 1;
    const fits =
      Math.abs(m.width - d.bounds.width * factor) <= 2 &&
      Math.abs(m.height - d.bounds.height * factor) <= 2;
    if (!fits) paired = false;
    console.log(
      `       ${fits ? 'ok  ' : 'HORS'} Electron ${d.bounds.x},${d.bounds.y} ` +
        `${d.bounds.width}x${d.bounds.height} @${factor}  ->  Windows ${m.x},${m.y} ${m.width}x${m.height}` +
        `${m.primary ? ' (primaire)' : ''}`,
    );
  }
  console.log(`[${paired ? 'OK' : 'ECHEC'}]   appariement des ecrans\n`);

  // Zone centrale : sur un bureau, c'est la plus susceptible d'avoir du contenu.
  const x = Math.max(0, Math.round(width / 2 - WIDTH / 2));
  const y = Math.max(0, Math.round(height / 2 - HEIGHT / 2));

  const times: number[] = [];
  let last: Awaited<ReturnType<RegionGrabber['capture']>> = null;
  for (let i = 0; i < SAMPLES; i++) {
    const started = process.hrtime.bigint();
    last = await grabber.capture(x, y, WIDTH, HEIGHT);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    if (!last) {
      console.log('[ECHEC] le helper n\'a rien renvoye — repli sur la capture Electron');
      grabber.stop();
      app.exit(1);
      return;
    }
    // La premiere capture inclut le demarrage du processus : hors statistiques.
    if (i > 0) times.push(elapsed);
  }

  const expected = WIDTH * HEIGHT * 4;
  console.log(`[${last!.data.length === expected ? 'OK' : 'ECHEC'}]   ` +
    `taille du tampon ${last!.data.length} octets (attendu ${expected})`);

  // --- Alpha : le point critique ---
  let opaque = 0;
  for (let i = 3; i < last!.data.length; i += 4) if (last!.data[i] === 255) opaque++;
  const totalPixels = expected / 4;
  console.log(`[${opaque === totalPixels ? 'OK' : 'ECHEC'}]   ` +
    `alpha opaque sur ${opaque}/${totalPixels} pixels`);

  // --- Passage en NativeImage ---
  const image = nativeImage.createFromBitmap(last!.data, { width: WIDTH, height: HEIGHT });
  const size = image.getSize();
  console.log(`[${size.width === WIDTH && size.height === HEIGHT ? 'OK' : 'ECHEC'}]   ` +
    `NativeImage ${size.width}x${size.height}`);

  // Le tampon relu doit correspondre a celui envoye : c'est ce qui garantit
  // qu'aucune premultiplication n'a altere les couleurs au passage.
  const roundTrip = image.toBitmap();
  let differing = 0;
  for (let i = 0; i < roundTrip.length; i++) if (roundTrip[i] !== last!.data[i]) differing++;
  console.log(`[${differing === 0 ? 'OK' : 'ECHEC'}]   ` +
    `aller-retour BGRA : ${differing} octets alteres`);

  // --- Operations appliquees ensuite par le pipeline ---
  const cropped = image.crop({ x: 10, y: 10, width: 200, height: 60 });
  console.log(`[${cropped.getSize().width === 200 ? 'OK' : 'ECHEC'}]   ` +
    `crop -> ${cropped.getSize().width}x${cropped.getSize().height}`);

  const processed = preprocessForOcr(cropped, height / 1080);
  console.log(`[${processed ? 'OK' : 'ECHEC'}]   ` +
    `pretraitement -> ${processed ? `${processed.width}x${processed.height}, ${processed.png.length} octets PNG` : 'refuse'}`);

  // --- Reduction pendant la copie ---
  //
  // C'est le chemin reellement emprunte sur un ecran HiDPI : la fenetre de
  // recherche est capturee reduite, pour que le localisateur et le
  // pretraitement travaillent sur ~1080p quelle que soit la definition.
  const half = { width: Math.round(WIDTH * 0.575), height: Math.round(HEIGHT * 0.575) };
  const reducedTimes: number[] = [];
  let reduced: Awaited<ReturnType<RegionGrabber['capture']>> = null;
  for (let i = 0; i < SAMPLES; i++) {
    const started = process.hrtime.bigint();
    reduced = await grabber.capture(x, y, WIDTH, HEIGHT, half.width, half.height);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    if (i > 0) reducedTimes.push(elapsed);
  }
  console.log(`[${reduced ? 'OK' : 'ECHEC'}]   ` +
    `reduction ${WIDTH}x${HEIGHT} -> ${reduced ? `${reduced.width}x${reduced.height}` : 'echec'} ` +
    `(attendu ${half.width}x${half.height})`);

  if (reduced) {
    // Une reduction qui echouerait silencieusement rendrait une image noire ou
    // un seul aplat : on verifie qu'il reste de la structure.
    const seen = new Set<number>();
    for (let p = 0; p < reduced.data.length; p += 4) {
      if (seen.size < 5000) seen.add((reduced.data[p]! << 16) | (reduced.data[p + 1]! << 8) | reduced.data[p + 2]!);
    }
    const source = new Set<number>();
    for (let p = 0; p < last!.data.length; p += 4) {
      if (source.size < 5000) source.add((last!.data[p]! << 16) | (last!.data[p + 1]! << 8) | last!.data[p + 2]!);
    }
    console.log(`       ${seen.size} couleurs apres reduction, ${source.size} avant`);
  }

  times.sort((a, b) => a - b);
  reducedTimes.sort((a, b) => a - b);
  console.log(
    `\nCout de capture reduite ${WIDTH}x${HEIGHT} -> ${half.width}x${half.height} :\n` +
      `  mediane ${percentile(reducedTimes, 0.5).toFixed(2)} ms | ` +
      `p90 ${percentile(reducedTimes, 0.9).toFixed(2)} ms | ` +
      `min ${reducedTimes[0]!.toFixed(2)} ms`,
  );
  console.log(
    `\nCout de capture ${WIDTH}x${HEIGHT} sur ${times.length} mesures :\n` +
      `  mediane ${percentile(times, 0.5).toFixed(2)} ms | ` +
      `p90 ${percentile(times, 0.9).toFixed(2)} ms | ` +
      `min ${times[0]!.toFixed(2)} ms | max ${times[times.length - 1]!.toFixed(2)} ms`,
  );
  console.log(`\nPour comparaison, desktopCapturer.getSources plein ecran : ~197 ms.\n`);

  grabber.stop();
  app.exit(0);
}

app.setName('tarkov-price-hover');
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(main)
  .catch((err) => {
    console.error('echec du test :', err);
    app.exit(1);
  });

// Sans fenetre, Electron quitterait des la fin de l'initialisation.
app.on('window-all-closed', () => {
  /* volontairement vide */
});
void path;
