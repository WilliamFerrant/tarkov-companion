/**
 * build.mjs
 * ---------
 * Bundler du projet (esbuild). Produit trois familles d'artefacts :
 *
 *   1. dist/main/main.js          -> process principal Electron (CommonJS, Node)
 *   2. dist/preload/*.js          -> scripts de preload (CommonJS, sandbox-compatible)
 *   3. dist/renderer/*.js         -> code des fenetres (IIFE, navigateur)
 *
 * Points critiques :
 *   - `electron` est marque external : il est fourni par le runtime, jamais bundle.
 *   - `tesseract.js` est marque external : la lib resout dynamiquement le chemin de
 *     ses workers/wasm a l'execution. La bundler casse ce mecanisme. Elle doit donc
 *     rester dans node_modules (et etre `asarUnpack` lors du packaging).
 *   - `electron-updater` est marque external pour la meme raison : il charge ses
 *     fournisseurs par require dynamique et cherche `app-update.yml` relativement
 *     a sa propre position dans node_modules. Le bundler ajoutait 258 Ko au
 *     process principal pour un module qui n'aurait pas fonctionne empaquete.
 *   - Les fichiers HTML/CSS sont simplement copies vers dist/renderer.
 *
 * Usage : `node build.mjs` ou `node build.mjs --watch`
 */

import * as esbuild from 'esbuild';
import { mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** Dependances resolues a l'execution, jamais incluses dans le bundle. */
const EXTERNAL = ['electron', 'tesseract.js', 'electron-updater'];

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

/** @type {esbuild.BuildOptions[]} */
const configs = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/main/main.ts')],
    outfile: path.join(outdir, 'main/main.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/tools/ocr-selftest.ts')],
    outfile: path.join(outdir, 'tools/ocr-selftest.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/tools/grid-selftest.ts')],
    outfile: path.join(outdir, 'tools/grid-selftest.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/tools/failure-selftest.ts')],
    outfile: path.join(outdir, 'tools/failure-selftest.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/tools/region-selftest.ts')],
    outfile: path.join(outdir, 'tools/region-selftest.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/tools/icon-selftest.ts')],
    outfile: path.join(outdir, 'tools/icon-selftest.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
  },
  {
    ...common,
    // Ce test tourne en Node pur : il ne doit dependre d'aucune API Electron.
    entryPoints: [path.join(root, 'src/tools/match-selftest.ts')],
    outfile: path.join(outdir, 'tools/match-selftest.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
  },
  {
    ...common,
    entryPoints: [
      path.join(root, 'src/preload/overlay.preload.ts'),
      path.join(root, 'src/preload/settings.preload.ts'),
    ],
    outdir: path.join(outdir, 'preload'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
  },
  // Les deux renderers sont bundles separement avec `outfile` plutot qu'en un
  // seul `outdir` : esbuild recreerait sinon l'arborescence source
  // (renderer/ui/settings.js), alors que les HTML attendent des fichiers plats.
  {
    ...common,
    entryPoints: [path.join(root, 'src/overlay/overlay.ts')],
    outfile: path.join(outdir, 'renderer/overlay.js'),
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/ui/settings.ts')],
    outfile: path.join(outdir, 'renderer/settings.js'),
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
  },
];

/** Copie les assets statiques (HTML/CSS) vers dist/renderer. */
async function copyStatic() {
  await mkdir(path.join(outdir, 'renderer'), { recursive: true });
  const files = [
    ['src/overlay/index.html', 'renderer/overlay.html'],
    ['src/overlay/overlay.css', 'renderer/overlay.css'],
    ['src/ui/index.html', 'renderer/settings.html'],
    ['src/ui/settings.css', 'renderer/settings.css'],
  ];
  for (const [from, to] of files) {
    const src = path.join(root, from);
    if (existsSync(src)) await cp(src, path.join(outdir, to));
  }
}

/**
 * Compile le helper de capture par region (`native/RegionCapture.cs`).
 *
 * Le compilateur utilise est le `csc.exe` livre avec le .NET Framework, present
 * sur toute installation de Windows depuis la 8 : le projet garde ainsi sa
 * propriete « aucun outil de compilation a installer ». Un echec n'interrompt
 * pas le build — `RegionGrabber` sait compiler a la volee au premier lancement,
 * et retombe sur la capture Electron si meme cela echoue.
 */
async function buildNativeHelper() {
  const source = path.join(root, 'native/RegionCapture.cs');
  if (process.platform !== 'win32' || !existsSync(source)) return;

  const compiler = path.join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  if (!existsSync(compiler)) {
    console.warn('[build] csc.exe introuvable — helper de capture non compile');
    return;
  }

  await mkdir(path.join(outdir, 'native'), { recursive: true });
  const output = path.join(outdir, 'native/RegionCapture.exe');
  const result = spawnSync(
    compiler,
    ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`, source],
    { windowsHide: true },
  );
  if (result.status !== 0) {
    console.warn('[build] compilation du helper echouee :', result.stderr?.toString().trim());
    return;
  }
  // La source accompagne l'executable : elle permet a `RegionGrabber` de
  // recompiler si le binaire livre est refuse (antivirus, architecture).
  await cp(source, path.join(outdir, 'native/RegionCapture.cs'));
  console.log('[build] helper de capture ->', output);
}

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await buildNativeHelper();

  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    await copyStatic();
    console.log('[build] watch actif — Ctrl+C pour quitter');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    await copyStatic();
    console.log('[build] OK ->', outdir);
  }
}

main().catch((err) => {
  console.error('[build] echec :', err);
  process.exit(1);
});
