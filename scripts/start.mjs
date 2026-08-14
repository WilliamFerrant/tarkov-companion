/**
 * scripts/start.mjs
 * -----------------
 * Lanceur de l'application.
 *
 * Il existe pour une raison precise : le terminal integre de VS Code (et
 * quelques autres outils bases sur Electron) exporte `ELECTRON_RUN_AS_NODE=1`
 * dans l'environnement. Avec cette variable, le binaire Electron demarre comme
 * un simple Node : `require('electron')` renvoie alors le module npm — une
 * chaine contenant le chemin de l'executable — au lieu du runtime. Le
 * demarrage echoue sur un `Cannot read properties of undefined (reading 'app')`
 * parfaitement obscur.
 *
 * Ce lanceur supprime la variable avant de demarrer Electron, ce qui rend
 * `npm start` fiable quel que soit le terminal utilise.
 *
 * Usage :
 *   node scripts/start.mjs [--dev]                  lance l'application
 *   node scripts/start.mjs --entry <fichier.js>     lance un autre point d'entree
 *                                                   (utilise par `npm run test:ocr`)
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Le module npm `electron` exporte le chemin absolu de l'executable. */
let electronBinary;
try {
  electronBinary = require('electron');
} catch {
  console.error('Electron introuvable. Lancez `npm install` d\'abord.');
  process.exit(1);
}

if (typeof electronBinary !== 'string') {
  console.error('Chemin du binaire Electron inattendu. Essayez de supprimer node_modules puis `npm install`.');
  process.exit(1);
}

// `--entry <fichier>` remplace le point d'entree par defaut (le dossier du
// projet, dont le `main` de package.json pointe vers l'application).
const args = process.argv.slice(2);
const entryFlag = args.indexOf('--entry');
let entry = root;
let forwarded = args;
if (entryFlag !== -1) {
  const value = args[entryFlag + 1];
  if (!value) {
    console.error('--entry attend un chemin de fichier.');
    process.exit(1);
  }
  entry = path.resolve(root, value);
  forwarded = args.filter((_, i) => i !== entryFlag && i !== entryFlag + 1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [entry, ...forwarded], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

child.on('error', (err) => {
  console.error('Lancement d\'Electron impossible :', err.message);
  process.exit(1);
});
