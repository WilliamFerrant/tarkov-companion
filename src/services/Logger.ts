/**
 * services/Logger.ts
 * ------------------
 * Logger fichier + console, sans dependance externe.
 *
 * Ecrit dans `<userData>/logs/app.log` avec rotation par taille (un seul fichier
 * de backup conserve). Les ecritures sont synchrones et volontairement rares :
 * la boucle de detection ne doit jamais logger a chaque frame, seulement sur
 * changement d'etat ou erreur.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 2 * 1024 * 1024;

let logDir = '';
let logFile = '';
let minLevel: Level = 'info';

/** Initialise le logger. A appeler une fois que `app.getPath('userData')` est disponible. */
export function initLogger(userDataPath: string, verbose: boolean): void {
  logDir = path.join(userDataPath, 'logs');
  logFile = path.join(logDir, 'app.log');
  minLevel = verbose ? 'debug' : 'info';
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* Si le dossier de logs est inaccessible on continue en console seule. */
  }
}

export function getLogDir(): string {
  return logDir;
}

export function setVerbose(verbose: boolean): void {
  minLevel = verbose ? 'debug' : 'info';
}

/** Fait tourner le fichier de log s'il depasse MAX_BYTES. */
function rotateIfNeeded(): void {
  try {
    if (!existsSync(logFile)) return;
    if (statSync(logFile).size < MAX_BYTES) return;
    renameSync(logFile, logFile + '.1');
  } catch {
    /* La rotation est best-effort : une erreur ici ne doit pas casser le log. */
  }
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (extra !== undefined) {
    line += ' ' + (extra instanceof Error ? (extra.stack ?? extra.message) : safeStringify(extra));
  }

  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line);

  if (!logFile) return;
  try {
    rotateIfNeeded();
    appendFileSync(logFile, line + '\n', 'utf8');
  } catch {
    /* Disque plein ou fichier verrouille : on garde au moins la sortie console. */
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Cree un logger prefixe par un nom de module. */
export function createLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => write('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => write('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => write('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => write('error', scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
