/**
 * scripts/make-icons.mjs
 * ----------------------
 * Genere `assets/icon.png` (256x256) et `assets/tray.png` (32x32) sans aucune
 * dependance graphique : les pixels sont calcules a la main puis encodes en PNG
 * via zlib.
 *
 * L'icone est un carre arrondi sombre borde d'or, contenant trois barres de
 * hauteurs croissantes (metaphore « prix »). Le rendu est volontairement simple :
 * l'objectif est d'avoir un asset reel versionne dans le depot, pas une oeuvre.
 *
 * Usage : `node scripts/make-icons.mjs`
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BACKGROUND = [27, 23, 18, 255]; // #1b1712
const BORDER = [199, 179, 119, 255]; // #c7b377
const BAR = [199, 179, 119, 255];
const BAR_DIM = [138, 122, 78, 255];

/** Table CRC32 precalculee, requise par le format PNG. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode un buffer RGBA brut (largeur * hauteur * 4) en PNG. */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profondeur 8 bits
  ihdr[9] = 6; // type couleur RGBA
  // Chaque ligne est prefixee de son octet de filtre (0 = aucun).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 4 + 1);
    raw[offset] = 0;
    rgba.copy(raw, offset + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Dessine l'icone a la taille demandee et renvoie le PNG. */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const radius = size * 0.18;
  const borderWidth = Math.max(1, size * 0.035);

  const put = (x, y, color) => {
    const offset = (y * size + x) * 4;
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = color[3];
  };

  /** Distance signee au bord d'un carre arrondi centre. Negatif = interieur. */
  const roundedDistance = (x, y, inset) => {
    const half = size / 2 - inset;
    const dx = Math.abs(x - size / 2 + 0.5) - (half - radius);
    const dy = Math.abs(y - size / 2 + 0.5) - (half - radius);
    const outsideX = Math.max(dx, 0);
    const outsideY = Math.max(dy, 0);
    return Math.hypot(outsideX, outsideY) + Math.min(Math.max(dx, dy), 0) - radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const outer = roundedDistance(x, y, size * 0.02);
      if (outer > 0) continue; // hors de la forme : reste transparent
      const inner = roundedDistance(x, y, size * 0.02 + borderWidth);
      put(x, y, inner > 0 ? BORDER : BACKGROUND);
    }
  }

  // Trois barres verticales de hauteurs croissantes, centrees.
  const barWidth = Math.round(size * 0.12);
  const gap = Math.round(size * 0.07);
  const totalWidth = barWidth * 3 + gap * 2;
  const startX = Math.round((size - totalWidth) / 2);
  const baseY = Math.round(size * 0.74);
  const heights = [0.18, 0.3, 0.42].map((h) => Math.round(size * h));

  for (let index = 0; index < 3; index++) {
    const x0 = startX + index * (barWidth + gap);
    const color = index === 2 ? BAR : BAR_DIM;
    for (let y = baseY - heights[index]; y < baseY; y++) {
      for (let x = x0; x < x0 + barWidth; x++) {
        if (x >= 0 && x < size && y >= 0 && y < size) put(x, y, color);
      }
    }
  }

  return encodePng(rgba, size, size);
}

mkdirSync(path.join(root, 'assets'), { recursive: true });
writeFileSync(path.join(root, 'assets/icon.png'), drawIcon(256));
writeFileSync(path.join(root, 'assets/tray.png'), drawIcon(32));
console.log('[icons] assets/icon.png et assets/tray.png generes');
