/**
 * tools/failure-selftest.ts
 * -------------------------
 * Rejoue le localisateur sur les **vraies** fenetres de recherche qui ont echoue
 * en jeu.
 *
 * Pourquoi cet outil existe
 * -------------------------
 * `npm run test:ocr` reconstruit une scene d'inventaire synthetique. Elle a
 * trouve de vrais defauts, mais elle a une limite de principe : elle ne
 * reproduit que les situations deja comprises. Les echecs restants sont
 * intermittents — meme objet, meme position, reconnu une fois sur cent — et
 * aucune scene ecrite a la main ne les reproduit.
 *
 * En mode debug, chaque cadrage rate ecrit sa fenetre de recherche en pleine
 * resolution dans `debug/`. Cet outil charge ces images et fait tourner
 * `locateTooltip` dessus, hors du jeu, autant de fois qu'on veut. On passe ainsi
 * de « je change un seuil et je demande a l'utilisateur de rejouer » a une mesure
 * reproductible en deux secondes.
 *
 * Le curseur est reconstruit a partir de la geometrie de la fenetre : elle est
 * cadree a `SEARCH_BACKWARD` a gauche du curseur et `SEARCH_ABOVE` au-dessus,
 * ce qui suffit a replacer le point exactement.
 *
 * Lancement : `npm run test:failures`
 */

import { app, nativeImage } from 'electron';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { locateTooltip, newLocateStats } from '../services/TooltipLocator';

/** Doit rester aligne sur `ScreenCapture`. */
const SEARCH_BACKWARD = 90;
const SEARCH_ABOVE = 130;
const SEARCH_BELOW = 40;

function main(): void {
  const dir = path.join(app.getPath('userData'), 'debug');
  if (!existsSync(dir)) {
    console.log(`\nAucun echantillon : ${dir} n'existe pas.`);
    console.log('Activez le mode debug (Ctrl+Shift+D) et jouez pour en produire.\n');
    app.exit(0);
    return;
  }

  const files = readdirSync(dir)
    .filter((name) => name.startsWith('echec-') && name.endsWith('.png'))
    .sort();

  if (files.length === 0) {
    console.log(`\nAucun fichier echec-*.png dans ${dir}.\n`);
    app.exit(0);
    return;
  }

  console.log(`\n${files.length} echantillons dans ${dir}\n`);

  let located = 0;
  for (const name of files) {
    const image = nativeImage.createFromPath(path.join(dir, name));
    const size = image.getSize();
    if (size.width < 2 || size.height < 2) {
      console.log(`[ILLISIBLE] ${name}`);
      continue;
    }

    // La hauteur de la fenetre vaut `(SEARCH_ABOVE + SEARCH_BELOW) * sizeScale`,
    // ce qui permet de retrouver l'echelle, donc la position du curseur.
    const sizeScale = size.height / (SEARCH_ABOVE + SEARCH_BELOW);
    const cursorX = SEARCH_BACKWARD * sizeScale;
    const cursorY = SEARCH_ABOVE * sizeScale;

    const stats = newLocateStats();
    const started = process.hrtime.bigint();
    const result = locateTooltip(image.toBitmap(), size.width, size.height, {
      cursorX,
      cursorY,
      sizeScale,
      excludeRect: null,
      stats,
    });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    // Le detail des rejets est ce qui distingue « aucun rectangle plein n'a
    // survecu aux bornes » de « le bon candidat existait mais a perdu au
    // score ». Ces deux situations appellent des correctifs opposes.
    const detail =
      `${stats.candidates} candidats : ` +
      `${stats.rejectedBySize} taille, ` +
      `${stats.rejectedByCursorInside} curseur dedans, ` +
      `${stats.rejectedByDistance} distance, ` +
      `${stats.rejectedByNoText} sans texte, ` +
      `${stats.accepted} retenus`;

    if (result) {
      located++;
      console.log(
        `[TROUVE] ${name}  -> ${result.rect.width}x${result.rect.height} en ` +
          `${result.rect.x},${result.rect.y} (seuil ${result.threshold})  ${elapsed.toFixed(1)} ms`,
      );
    } else {
      console.log(`[RIEN]   ${name}  ${elapsed.toFixed(1)} ms`);
    }
    console.log(`         ${detail}`);
    for (const reject of stats.rejects) console.log(`           ecarte : ${reject}`);
  }

  // Volontairement sans verdict global : ces echantillons sont des **echecs**,
  // et une partie d'entre eux est legitime — le joueur ne survolait rien. Seul
  // l'oeil, en regardant l'image, peut dire si une infobulle y figurait. Le
  // decompte sert a comparer deux versions du localisateur sur le meme lot.
  console.log(`\n${located}/${files.length} echantillons ont produit un cadrage.\n`);
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
app.on('window-all-closed', () => {
  /* volontairement vide */
});
