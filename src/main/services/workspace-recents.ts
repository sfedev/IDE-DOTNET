/**
 * Estado real de los workspaces recientes.
 *
 * El historial de recientes guarda rutas, y una ruta puede dejar de existir entre dos sesiones:
 * la carpeta se borra, se renombra o vive en un disco que hoy no está conectado. Sin comprobarlo,
 * el arranque intentaba reabrir la primera de la lista y el proceso principal escupía un ENOENT
 * crudo al log por cada arranque.
 *
 * Aquí se resuelve una sola pregunta —¿se puede abrir esto ahora mismo?— y se resuelve una vez,
 * en Node puro, para poder probarla con carpetas de verdad sin arrancar Electron.
 */
import { existsSync, statSync } from 'node:fs';

import type { RecentWorkspace } from '../../shared/contracts.js';

/**
 * ¿Es esta ruta un workspace abrible?
 *
 * Se exige que exista **y** que sea un directorio: si alguien deja un archivo con el nombre de la
 * carpeta que había, abrirlo fallaría más adelante y con un mensaje peor.
 */
export function isOpenableWorkspace(path: string): boolean {
  if (typeof path !== 'string' || path.trim() === '') return false;

  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    // Permisos, unidad desconectada, ruta inválida: para el caso, no se puede abrir.
    return false;
  }
}

/**
 * Anota el historial con su disponibilidad.
 *
 * **No se borra nada.** Una carpeta en un USB desconectado sigue en la lista, marcada como no
 * disponible: perder el historial de un proyecto por haber arrancado sin el disco puesto sería
 * peor que enseñar una entrada apagada.
 */
export function describeRecents(paths: readonly string[]): RecentWorkspace[] {
  const seen = new Set<string>();
  const result: RecentWorkspace[] = [];

  for (const path of paths) {
    if (typeof path !== 'string' || path.trim() === '' || seen.has(path)) continue;
    seen.add(path);
    result.push({ path, available: isOpenableWorkspace(path) });
  }

  return result;
}

/** Primer reciente que se puede abrir de verdad, o `null` si ninguno lo está. */
export function firstAvailable(recents: readonly RecentWorkspace[]): string | null {
  return recents.find((entry) => entry.available)?.path ?? null;
}
