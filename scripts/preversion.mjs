/**
 * scripts/preversion.mjs
 * ----------------------
 * Garde-fou execute automatiquement par npm avant `npm version`.
 *
 * Pourquoi ce script existe
 * -------------------------
 * Une release a ete taguee depuis `dev` au lieu de `main` : la commande
 * `git checkout main && git merge dev && git push` avait echoue en silence — le
 * `&&` n'est pas un separateur valide dans PowerShell 5.1 — et le `npm version`
 * qui suivait s'est execute sur la branche courante sans rien signaler.
 *
 * Le tag pointait donc en dehors de `main`, et la branche de production annoncait
 * une version inferieure a celle publiee. Rien ne l'avait empeche, et rien ne
 * l'aurait signale.
 *
 * Trois verifications, toutes bloquantes :
 *   1. on est bien sur `main` ;
 *   2. l'arbre de travail est propre ;
 *   3. `main` est a jour avec `origin/main`.
 *
 * npm interrompt `npm version` des que ce script sort avec un code non nul.
 */

import { execSync } from 'node:child_process';

const RELEASE_BRANCH = 'main';

/** Execute une commande git et rend sa sortie nettoyee. */
function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fail(title, detail) {
  console.error(`\n  Publication refusee : ${title}\n`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}

let branch;
try {
  branch = git('rev-parse --abbrev-ref HEAD');
} catch {
  fail('depot git illisible', ['La commande doit etre lancee depuis le depot.']);
}

// --- 1. Branche ---
if (branch !== RELEASE_BRANCH) {
  fail(`vous etes sur « ${branch} », pas sur « ${RELEASE_BRANCH} »`, [
    'Une version ne se tague que depuis la branche de production, sinon le tag',
    'pointe en dehors et `main` annonce une version inferieure a celle publiee.',
    '',
    'Sous PowerShell (le `&&` n\'y est pas un separateur valide) :',
    '',
    '  git checkout main',
    '  git merge --no-ff dev',
    '  git push',
    '  npm run release:patch',
  ]);
}

// --- 2. Arbre propre ---
const dirty = git('status --porcelain');
if (dirty) {
  fail('des modifications ne sont pas validees', [
    'Le tag figerait un etat different de ce qui sera compile.',
    '',
    'Fichiers concernes :',
    ...dirty.split('\n').slice(0, 10).map((line) => `  ${line}`),
  ]);
}

// --- 3. Synchronisation avec origin ---
try {
  git('fetch origin --quiet');
  const local = git(`rev-parse ${RELEASE_BRANCH}`);
  const remote = git(`rev-parse origin/${RELEASE_BRANCH}`);
  if (local !== remote) {
    const ahead = git(`rev-list --count origin/${RELEASE_BRANCH}..${RELEASE_BRANCH}`);
    const behind = git(`rev-list --count ${RELEASE_BRANCH}..origin/${RELEASE_BRANCH}`);
    fail(`« ${RELEASE_BRANCH} » n'est pas synchronisee avec origin`, [
      `${ahead} commit(s) en avance, ${behind} en retard.`,
      '',
      behind !== '0'
        ? 'Recuperez d\'abord : git pull'
        : 'Poussez d\'abord la branche : git push',
      '',
      'Sans quoi la release serait construite depuis un commit que personne d\'autre n\'a.',
    ]);
  }
} catch (err) {
  // Un `origin` injoignable ne doit pas bloquer une release hors ligne : on
  // avertit sans interrompre, les deux premieres verifications ayant deja
  // couvert les erreurs les plus courantes.
  console.warn(`\n  Avertissement : synchronisation avec origin non verifiee (${err.message?.split('\n')[0] ?? err}).\n`);
}

console.log(`  Pre-verification OK : ${RELEASE_BRANCH}, arbre propre, synchronisee avec origin.`);
