/**
 * main/hotkeys.ts
 * ---------------
 * Enregistrement des raccourcis globaux (actifs meme quand le jeu a le focus).
 *
 * `globalShortcut.register` renvoie `false` — sans lever d'exception — quand un
 * autre logiciel a deja capture la combinaison, cas frequent avec Discord,
 * NVIDIA Overlay ou Steam. On journalise et on remonte l'echec a l'UI plutot
 * que d'echouer silencieusement : sinon l'utilisateur croit a un bug de l'outil.
 */

import { globalShortcut } from 'electron';
import type { AppConfig } from '../types/index';
import { createLogger } from '../services/Logger';

const log = createLogger('hotkeys');

export interface HotkeyHandlers {
  toggleOverlay(): void;
  toggleDebug(): void;
  openSettings(): void;
}

/**
 * Re-enregistre l'integralite des raccourcis a partir de la configuration.
 * @returns la liste des accelerateurs qui n'ont pas pu etre enregistres.
 */
export function registerHotkeys(config: AppConfig, handlers: HotkeyHandlers): string[] {
  globalShortcut.unregisterAll();

  const bindings: Array<[accelerator: string, handler: () => void, label: string]> = [
    [config.hotkeys.toggleOverlay, handlers.toggleOverlay, 'basculer l\'overlay'],
    [config.hotkeys.toggleDebug, handlers.toggleDebug, 'basculer le mode debug'],
    [config.hotkeys.openSettings, handlers.openSettings, 'ouvrir la configuration'],
  ];

  const failed: string[] = [];
  for (const [accelerator, handler, label] of bindings) {
    if (!accelerator || accelerator.trim().length === 0) continue;
    try {
      // Un accelerateur syntaxiquement invalide leve, un accelerateur deja pris
      // renvoie false : les deux cas doivent etre traites.
      if (globalShortcut.register(accelerator, handler)) {
        log.info(`raccourci ${accelerator} -> ${label}`);
      } else {
        failed.push(accelerator);
        log.warn(`raccourci ${accelerator} refuse (deja utilise par une autre application ?)`);
      }
    } catch (err) {
      failed.push(accelerator);
      log.error(`accelerateur invalide : ${accelerator}`, err);
    }
  }
  return failed;
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
