/**
 * services/ForegroundWatcher.ts
 * -----------------------------
 * Surveille quel process possede la fenetre au premier plan, afin de n'analyser
 * l'ecran que lorsque Tarkov est reellement affiche.
 *
 * Sans ce garde-fou, l'outil ferait un OCR chaque fois que la souris s'immobilise
 * sur le bureau, dans un navigateur, etc. : pur gaspillage CPU.
 *
 * Implementation : un unique process PowerShell persistant qui appelle
 * `GetForegroundWindow` / `GetWindowThreadProcessId` (user32) toutes les secondes
 * et ecrit le nom du process sur stdout. C'est une lecture d'etat global de
 * l'interface Windows, pas une lecture du process du jeu : rien n'est ouvert,
 * injecte ni inspecte dans Tarkov.
 *
 * Alternative ecartee : un module natif (`node-ffi`, `active-win`) imposerait une
 * chaine de compilation C++ pour une information obtenue ici gratuitement.
 *
 * Politique de defaillance : `fail-open`. Si PowerShell est indisponible ou que
 * le watcher meurt, `isGameFocused()` renvoie `true` et l'application continue
 * de fonctionner, quitte a analyser un peu trop souvent.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createLogger } from './Logger';

const log = createLogger('foreground');

/** Periode d'echantillonnage cote PowerShell. */
const POLL_MS = 1000;
/** Au-dela de ce delai sans nouvelle valeur, l'information est jugee perimee. */
const STALE_AFTER_MS = 5000;
/** Nombre de redemarrages avant abandon definitif du watcher. */
const MAX_RESTARTS = 3;

/**
 * Script PowerShell execute en boucle.
 * `$pid` etant une variable automatique reservee, le PID est stocke dans `$procId`.
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
}
'@
while ($true) {
  $handle = [FgWin]::GetForegroundWindow()
  $procId = 0
  [void][FgWin]::GetWindowThreadProcessId($handle, [ref]$procId)
  $name = ''
  if ($procId -gt 0) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc) { $name = $proc.ProcessName }
  }
  Write-Output $name
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;

/** stdin ignore, stdout et stderr en pipe : correspond au `stdio` passe a `spawn`. */
type WatcherProcess = ChildProcessByStdio<null, Readable, Readable>;

export class ForegroundWatcher {
  private child: WatcherProcess | null = null;
  private lastProcessName = '';
  private lastUpdate = 0;
  private restarts = 0;
  private stopped = false;
  private available = false;
  /** Tampon des donnees stdout partielles entre deux lignes completes. */
  private buffer = '';

  start(): void {
    if (process.platform !== 'win32') {
      log.warn('plateforme non Windows : la detection du premier plan est desactivee');
      return;
    }
    this.stopped = false;
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.stopped) return;

    // -EncodedCommand evite tout probleme d'echappement du script multiligne.
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

    let child: WatcherProcess;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      log.error('lancement du watcher impossible, repli sur « toujours actif »', err);
      this.available = false;
      return;
    }

    this.child = child;
    this.available = true;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      // Le dernier fragment peut etre incomplet : on le garde pour le prochain chunk.
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        this.lastProcessName = line.trim();
        this.lastUpdate = Date.now();
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      // PowerShell emet une entete CLIXML des que stderr est redirige, meme sans
      // la moindre erreur. Ce bruit n'a aucune valeur diagnostique.
      if (!message || message.startsWith('#< CLIXML')) return;
      log.warn('stderr du watcher', message);
    });

    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      if (this.restarts >= MAX_RESTARTS) {
        log.error(`watcher arrete ${MAX_RESTARTS} fois, abandon — l'OCR ne sera plus filtre par le focus`);
        this.available = false;
        return;
      }
      this.restarts++;
      log.warn(`watcher termine (code ${code}), redemarrage ${this.restarts}/${MAX_RESTARTS}`);
      setTimeout(() => this.spawnChild(), 2000).unref?.();
    });

    child.on('error', (err) => {
      log.error('erreur du process watcher', err);
      this.available = false;
    });
  }

  /**
   * Le process passe en parametre est-il au premier plan ?
   * Renvoie `true` par defaut si l'information n'est pas disponible ou perimee,
   * pour ne jamais bloquer l'outil a cause d'un composant secondaire.
   */
  isGameFocused(expectedProcessName: string): boolean {
    if (!this.available) return true;
    if (Date.now() - this.lastUpdate > STALE_AFTER_MS) return true;
    return this.lastProcessName.toLowerCase() === expectedProcessName.trim().toLowerCase();
  }

  /** Dernier nom de process observe, expose pour le panneau debug. */
  get foregroundProcess(): string {
    return this.available ? this.lastProcessName : '(indisponible)';
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }
}
