/**
 * Persistencia de la disposición de las pestañas de terminal, en `userData/terminal-layouts.json`.
 *
 * Va aparte de `settings.json` a propósito: aquello son preferencias del usuario, esto es estado de
 * una solución concreta y hay una entrada por cada una. Mezclarlos haría crecer el archivo de
 * preferencias con datos que no se editan a mano y que caducan solos.
 *
 * Dos decisiones que lo mantienen simple:
 *
 *  - **Se guarda en cada cambio de pestaña**, no al cerrar. Abrir otra solución cambia el
 *    workspace actual, y con él la clave del archivo: guardar "al salir" obligaría a capturar el
 *    estado *antes* del cambio, que es una carrera esperando a pasar. Guardando eagermente, la
 *    entrada siempre está al día y cambiar de solución no tiene que hacer nada.
 *  - **La clave es la ruta del workspace y la pone el proceso principal.** Sin solución abierta no
 *    se guarda nada: no habría de qué colgarlo.
 *
 * Como todo lo que lee JSON ajeno, se lee con `parseJsonText` (ADR-058) y se sanea entrada a
 * entrada: este archivo lo escribe una versión del IDE y lo lee otra.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parseJsonText } from '../../shared/json-text.js';
import {
  coerceStoredLayout,
  emptyLayout,
  MAX_REMEMBERED_WORKSPACES,
  type TerminalLayout,
} from '../../shared/terminal-layout.js';

let storePath: string;

/** Disposiciones por ruta de workspace. Se mantiene en memoria y se vuelca entera al guardar. */
let cached: Map<string, TerminalLayout> | null = null;

export function initialize(userDataPath: string): void {
  storePath = join(userDataPath, 'terminal-layouts.json');
  cached = null;
}

/** Sólo para las pruebas: olvida lo leído para volver a leerlo del disco. */
export function resetCache(): void {
  cached = null;
}

async function readStore(platform: string): Promise<Map<string, TerminalLayout>> {
  if (cached !== null) return cached;

  const store = new Map<string, TerminalLayout>();
  cached = store;

  if (!storePath || !existsSync(storePath)) return store;

  try {
    const raw = parseJsonText<unknown>(await readFile(storePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return store;

    for (const [workspace, value] of Object.entries(raw as Record<string, unknown>)) {
      if (workspace.trim() === '') continue;
      store.set(workspace, coerceStoredLayout(value, platform));
    }
  } catch {
    // Un archivo ilegible no puede impedir abrir una solución: se empieza de cero. Lo peor que
    // pasa es que las pestañas no se restauren esta vez, y la primera escritura lo arregla.
  }

  return store;
}

/**
 * Guarda la disposición de una solución.
 *
 * `tabs` ya viene saneado (`coerceIncomingLayout`) y `cwd` lo pone quien llama desde la sesión de
 * la terminal, nunca el renderer.
 */
export async function save(
  workspace: string,
  layout: TerminalLayout,
  platform: string,
): Promise<void> {
  if (!storePath || workspace.trim() === '') return;

  const store = await readStore(platform);

  // El más reciente al final: al podar se van los que llevan más tiempo sin tocarse.
  store.delete(workspace);
  store.set(workspace, layout);

  while (store.size > MAX_REMEMBERED_WORKSPACES) {
    const oldest = store.keys().next();
    if (oldest.done === true) break;
    store.delete(oldest.value);
  }

  const serialized = Object.fromEntries(store);
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8');
}

/** Disposición guardada de una solución, o una vacía si no hay ninguna. */
export async function load(workspace: string, platform: string): Promise<TerminalLayout> {
  if (!storePath || workspace.trim() === '') return emptyLayout();

  const store = await readStore(platform);
  return store.get(workspace) ?? emptyLayout();
}

/** Olvida lo guardado de una solución. */
export async function forget(workspace: string, platform: string): Promise<void> {
  if (!storePath) return;

  const store = await readStore(platform);
  if (!store.delete(workspace)) return;

  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(Object.fromEntries(store), null, 2)}\n`, 'utf8');
}
