/**
 * tools/ocr-selftest.ts
 * ---------------------
 * Auto-test de bout en bout de la chaine OCR, sans avoir besoin de lancer Tarkov.
 *
 * Le test rend un faux tooltip — meme palette, meme taille de police que celui
 * du jeu — dans une fenetre Electron hors ecran, le capture, puis le fait
 * traverser **exactement** le meme code que la detection reelle :
 *
 *     capturePage() -> preprocessForOcr() -> OcrEngine -> ItemIndex.search()
 *
 * Il repond a la question « le pretraitement et le matching flou fonctionnent-ils
 * vraiment ? » sans dependre de l'API tarkov.dev ni d'une partie en cours.
 *
 * Les images pretraitees sont ecrites dans `dist/selftest/` : les ouvrir donne
 * une idee precise de ce que voit Tesseract.
 *
 * Usage : `npm run test:ocr`
 */

import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { preprocessForOcr } from '../services/ScreenCapture';
import { locateTooltip, type Rect } from '../services/TooltipLocator';
import { OcrEngine } from '../services/OcrEngine';
import { ItemIndex } from '../services/ItemIndex';
import { initLogger } from '../services/Logger';
import type { TarkovItem } from '../types/index';

/**
 * Echantillon representatif de la difficulte reelle : noms courts, noms tres
 * longs, chiffres, ponctuation, et paires volontairement proches
 * (« AK-74N » / « AKS-74N ») pour verifier que le matching ne confond pas.
 */
const SAMPLE_NAMES = [
  'Salewa first aid kit',
  'Physical bitcoin',
  'GPU graphics card',
  'AK-74N 5.45x39 assault rifle',
  'AKS-74N 5.45x39 assault rifle',
  '5.45x39mm BP gs',
  'LEDX Skin Transilluminator',
  'Golden neck chain',
  'Paca soft armor',
  'Grizzly medical kit',
  'Tetriz portable game console',
  'Can of TarCola soda',
  'HK MP5 9x19 30-round magazine',
];

/** Items minimalistes suffisants pour construire l'index de recherche. */
function buildSampleItems(): TarkovItem[] {
  return SAMPLE_NAMES.map((name, i) => ({
    id: `sample-${i}`,
    name,
    shortName: name.split(' ')[0] ?? name,
    basePrice: 1000,
    avg24hPrice: 50_000,
    lastLowPrice: 48_000,
    width: 1,
    height: 1,
    iconLink: null,
    types: [],
    sellFor: [],
  }));
}

/**
 * HTML imitant le tooltip de Tarkov : fond tres sombre legerement translucide,
 * texte creme, police d'interface, ~15 px — les conditions qui rendent l'OCR
 * difficile et que le pretraitement doit corriger.
 */
function tooltipHtml(name: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html><body style="margin:0;background:#0d0b09;">
      <div style="
        margin:14px;padding:8px 12px;
        background:rgba(20,18,15,0.92);
        border:1px solid #3a342a;
        font-family:'Bahnschrift','Segoe UI',sans-serif;
        font-size:15px;color:#d6d0c2;letter-spacing:0.01em;">
        <div>${name}</div>
        <div style="font-size:12px;color:#8c8574;margin-top:4px;">Weight: 0.42 kg</div>
      </div>
    </body></html>`)}`;
}

// ---------------------------------------------------------------------------
// Phase 2 : localisation automatique de l'infobulle
// ---------------------------------------------------------------------------

/**
 * Dimensions de la scene synthetique, en pixels logiques.
 *
 * Dimensionnee pour que le rapport infobulle / ecran soit **celui mesure en
 * jeu**. L'ancienne scene (900x450) portait des infobulles de 210 a 500 px de
 * large, soit 504 a 1200 px ramenes a 1080p — quatre fois la taille reelle
 * (~296x41). Le test validait donc des bornes dimensionnelles bien trop laxistes,
 * et ne pouvait pas detecter qu'un pan entier d'inventaire passait le filtre.
 */
const SCENE_WIDTH = 1600;
const SCENE_HEIGHT = 900;

interface SceneCase {
  label: string;
  /** Position du curseur dans la scene. */
  cursor: { x: number; y: number };
  /** Rectangle attendu de l'infobulle, ou `null` si aucune n'est affichee. */
  tooltip: (Rect & { name: string }) | null;
}

/**
 * Cas calques sur la geometrie **mesuree en jeu**, et non supposee.
 *
 * Sur dix detections reelles, l'infobulle est ancree au curseur avec un decalage
 * horizontal de -53 a +36 px, et se trouve **toujours au-dessus** de lui : bord
 * haut entre 36 et 68 px plus haut, bord bas au-dessus du curseur. Elle se
 * deploie vers la droite, sauf pres du bord droit de l'ecran ou Tarkov la
 * bascule a gauche — troisieme cas ci-dessous.
 *
 * Les longueurs de nom couvrent la plage reelle : de « Chainlet » (92 px
 * capturees) aux noms sur deux lignes.
 */
const SCENE_CASES: SceneCase[] = [
  {
    label: 'nom long, au-dessus a droite',
    cursor: { x: 400, y: 620 },
    tooltip: { x: 410, y: 545, width: 400, height: 40, name: 'HK MP5 9x19 30-round magazine' },
  },
  {
    label: 'nom moyen, plus haut dans la grille',
    cursor: { x: 400, y: 400 },
    tooltip: { x: 412, y: 328, width: 340, height: 40, name: 'Salewa first aid kit' },
  },
  {
    label: 'curseur pres du bord droit (bascule a gauche)',
    cursor: { x: 1550, y: 620 },
    tooltip: { x: 1170, y: 545, width: 370, height: 40, name: 'LEDX Skin Transilluminator' },
  },
  {
    label: 'nom court, infobulle etroite',
    cursor: { x: 800, y: 500 },
    tooltip: { x: 812, y: 425, width: 210, height: 40, name: 'Physical bitcoin' },
  },
  {
    label: 'aucune infobulle affichee (cas negatif)',
    cursor: { x: 800, y: 500 },
    tooltip: null,
  },
];

/**
 * Scene d'inventaire synthetique : grille olive, icones d'objets sombres,
 * etiquettes de quantite, barre laterale — les distracteurs qui doivent *ne pas*
 * etre pris pour une infobulle. Les icones sont dessinees en silhouettes
 * (`clip-path`) car c'est precisement leur faible taux de remplissage qui les
 * distingue d'un panneau d'interface.
 */
function sceneHtml(testCase: SceneCase): string {
  // La scene est ecrite dans un fichier temporaire plutot que passee en data URL :
  // Chromium refuse de naviguer vers une data URL de cette taille (ERR_FAILED).
  const cells = Array.from({ length: 48 }, (_, i) => {
    const x = 100 + (i % 8) * 155;
    const y = 40 + Math.floor(i / 8) * 125;
    return `<div style="position:absolute;left:${x}px;top:${y}px;width:150px;height:120px;
      background:#6f785c;border:1px solid #5c6449;"></div>`;
  }).join('');

  // Silhouettes sombres inclinees, comme les chargeurs de la capture reelle.
  const icons = [0, 1, 2, 3, 4].map((i) => {
    const x = 130 + i * 155;
    return `<div style="position:absolute;left:${x}px;top:${350}px;width:100px;height:230px;
      background:#26262a;clip-path:polygon(30% 0,70% 4%,58% 100%,12% 96%);"></div>`;
  }).join('');

  const labels = [0, 1, 2, 3, 4].map((i) => {
    const x = 110 + i * 155;
    return `<div style="position:absolute;left:${x}px;top:${545}px;color:#e2e2d8;
      font:600 23px 'Bahnschrift','Segoe UI',sans-serif;">30/30</div>`;
  }).join('');

  const sidebar = `<div style="position:absolute;left:0;top:0;width:94px;height:100%;background:#22251d;"></div>`;

  // Police a 22 px : c'est la taille qu'occupe reellement le texte d'infobulle
  // dans une capture 2561x1440 (28 px en 4K natif, ramenes par la reduction).
  const tooltip = testCase.tooltip
    ? `<div style="position:absolute;left:${testCase.tooltip.x}px;top:${testCase.tooltip.y}px;
        width:${testCase.tooltip.width}px;height:${testCase.tooltip.height}px;
        background:#191919;border:1px solid #4a4a4a;
        display:flex;align-items:center;justify-content:center;
        color:#dcdcd2;font:400 22px 'Bahnschrift','Segoe UI',sans-serif;letter-spacing:0.01em;">
        ${testCase.tooltip.name}</div>`
    : '';

  return `<html><body style="margin:0;width:${SCENE_WIDTH}px;height:${SCENE_HEIGHT}px;
      background:#5f6a4d;overflow:hidden;position:relative;">
      ${cells}${icons}${labels}${sidebar}${tooltip}
    </body></html>`;
}

/** Intersection sur union de deux rectangles. Mesure la qualite du cadrage. */
function intersectionOverUnion(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  const intersection = (x1 - x0) * (y1 - y0);
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

/** Seuil d'IoU accepte. Le cadrage n'a pas besoin d'etre au pixel : l'OCR tolere
 *  quelques pixels de marge, mais un recadrage decale couperait le nom. */
const MIN_IOU = 0.7;

async function runLocatorPhase(window: BrowserWindow, ocr: OcrEngine, index: ItemIndex, outDir: string): Promise<number> {
  console.log(`\nPhase 2 — localisation automatique de l'infobulle\n`);
  let failures = 0;

  const scenePath = path.join(outDir, 'scene.html');
  let sceneIndex = 0;

  for (const testCase of SCENE_CASES) {
    writeFileSync(scenePath, sceneHtml(testCase), 'utf8');
    // `loadFile` echoue (ERR_FAILED) des la deuxieme navigation : il ne normalise
    // plus les separateurs Windows. On construit l'URL explicitement, avec un
    // parametre unique pour qu'aucune navigation ne soit consideree comme un
    // rechargement de la page courante.
    await window.loadURL(`${pathToFileURL(scenePath).href}?scene=${sceneIndex++}`);
    await new Promise((resolve) => setTimeout(resolve, 140));

    const shot = await window.webContents.capturePage();
    const size = shot.getSize();
    // La capture peut etre en 2x sur un ecran HiDPI : tous les reperes logiques
    // doivent etre remis a la meme echelle que l'image.
    const scale = size.width / SCENE_WIDTH;

    const located = locateTooltip(shot.toBitmap(), size.width, size.height, {
      cursorX: testCase.cursor.x * scale,
      cursorY: testCase.cursor.y * scale,
      sizeScale: scale,
    });

    // --- Cas negatif : rien ne doit etre detecte ---
    if (!testCase.tooltip) {
      const ok = located === null;
      if (!ok) failures++;
      console.log(
        `${ok ? '[OK]  ' : '[ECHEC]'} ${testCase.label.padEnd(48)} ` +
          (located ? `detecte a tort ${located.rect.width}x${located.rect.height}` : 'rien detecte'),
      );
      continue;
    }

    if (!located) {
      failures++;
      console.log(`[ECHEC] ${testCase.label.padEnd(48)} aucune infobulle detectee`);
      continue;
    }

    const expected: Rect = {
      x: testCase.tooltip.x * scale,
      y: testCase.tooltip.y * scale,
      width: testCase.tooltip.width * scale,
      height: testCase.tooltip.height * scale,
    };
    const iou = intersectionOverUnion(located.rect, expected);

    // Le cadrage doit non seulement etre juste, mais aussi permettre de lire le nom.
    const processed = preprocessForOcr(shot.crop(located.rect));
    let matched: string | null = null;
    let score = 0;
    if (processed) {
      const slug = testCase.tooltip.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      writeFileSync(path.join(outDir, `scene-${slug}.png`), processed.png);
      const result = await ocr.recognize(processed.png);
      if (result) {
        for (const query of [...result.lines, result.lines.join(' ')]) {
          for (const candidate of index.search(query, 1)) {
            if (candidate.score > score) {
              score = candidate.score;
              matched = candidate.item.name;
            }
          }
        }
      }
    }

    const ok = iou >= MIN_IOU && matched === testCase.tooltip.name && score >= 0.62;
    if (!ok) failures++;
    console.log(
      `${ok ? '[OK]  ' : '[ECHEC]'} ${testCase.label.padEnd(48)} ` +
        `IoU ${iou.toFixed(2)}  remplissage ${(located.fillRatio * 100).toFixed(0)}%  ` +
        `-> ${matched ?? 'aucun match'} (${score.toFixed(2)})`,
    );
    // Un IoU insuffisant ne dit pas *comment* le cadrage a derape. Les deux
    // rectangles cote a cote le disent : trop large, decale, ou tronque.
    if (!ok) {
      const r = located.rect;
      console.log(
        `        attendu ${Math.round(expected.width)}x${Math.round(expected.height)} ` +
          `en ${Math.round(expected.x)},${Math.round(expected.y)} — ` +
          `obtenu ${Math.round(r.width)}x${Math.round(r.height)} en ${Math.round(r.x)},${Math.round(r.y)}`,
      );
    }
  }

  return failures;
}

async function main(): Promise<void> {
  // Relatif au bundle (dist/tools/) et non a `app.getAppPath()`, qui pointe sur
  // le dossier du fichier d'entree quand Electron demarre sur un script.
  const outDir = path.join(__dirname, '..', 'selftest');
  mkdirSync(outDir, { recursive: true });
  initLogger(app.getPath('userData'), false);

  const index = new ItemIndex();
  index.build(buildSampleItems());
  const ocr = new OcrEngine(app.getPath('userData'));

  // Une seule fenetre est creee puis redimensionnee entre les deux phases : sous
  // Electron 43, la navigation dans une *deuxieme* BrowserWindow de ce process
  // echoue systematiquement avec ERR_FAILED. Reutiliser la fenetre contourne le
  // probleme et evite au passage un cycle de creation/destruction.
  const window = new BrowserWindow({
    width: 520,
    height: 120,
    show: false,
    frame: false,
    useContentSize: true,
  });

  console.log(`\nAuto-test OCR — ${SAMPLE_NAMES.length} tooltips synthetiques\n`);

  let passed = 0;
  const failures: string[] = [];

  for (const expected of SAMPLE_NAMES) {
    await window.loadURL(tooltipHtml(expected));
    // Laisse le compositeur produire une frame avant la capture.
    await new Promise((resolve) => setTimeout(resolve, 120));

    const shot = await window.webContents.capturePage();
    const processed = preprocessForOcr(shot);
    if (!processed) {
      failures.push(`${expected} — pretraitement en echec`);
      continue;
    }

    const slug = expected.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    writeFileSync(path.join(outDir, `${slug}.png`), processed.png);

    const result = await ocr.recognize(processed.png);
    if (!result) {
      failures.push(`${expected} — OCR indisponible`);
      continue;
    }

    // Meme strategie que ItemDetector : chaque ligne, puis le bloc entier.
    const queries = [...result.lines, result.lines.join(' ')];
    let best: { name: string; score: number } | null = null;
    for (const query of queries) {
      for (const candidate of index.search(query, 1)) {
        if (!best || candidate.score > best.score) best = { name: candidate.item.name, score: candidate.score };
      }
    }

    const ok = best?.name === expected && best.score >= 0.62;
    if (ok) passed++;
    else failures.push(`${expected} — obtenu « ${best?.name ?? 'rien'} » (${best?.score.toFixed(3) ?? '—'})`);

    const label = ok ? '[OK]  ' : '[ECHEC]';
    console.log(
      `${label} ${expected.padEnd(34)} score ${best?.score.toFixed(3) ?? '—'}  ` +
        `OCR ${result.elapsedMs} ms  brut: ${JSON.stringify(result.lines[0] ?? '')}`,
    );
  }

  console.log(`\n${passed}/${SAMPLE_NAMES.length} reconnus.`);
  if (failures.length > 0) {
    console.log('\nEchecs :');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  // --- Phase 2 : cadrage automatique ---
  window.setContentSize(SCENE_WIDTH, SCENE_HEIGHT);
  const locatorFailures = await runLocatorPhase(window, ocr, index, outDir);
  window.destroy();

  console.log(`\n${SCENE_CASES.length - locatorFailures}/${SCENE_CASES.length} cadrages conformes.`);
  console.log(`\nImages pretraitees : ${outDir}\n`);

  await ocr.dispose();
  // Un seul echec suffit a faire echouer le script : utile en verification rapide.
  app.exit(failures.length === 0 && locatorFailures === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error('auto-test en erreur :', err);
  app.exit(1);
});
