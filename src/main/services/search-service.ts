/**
 * Búsqueda de texto en los archivos del workspace.
 *
 * El modelo —qué casa, qué archivos entran, cómo se recorta la línea— vive en
 * `src/shared/file-search.ts` y es puro. Aquí sólo está lo que necesita disco, y con ello las tres
 * decisiones que hacen que una búsqueda no se sienta como un cuelgue:
 *
 *  - **Nada síncrono.** Ni `readdirSync` ni `readFileSync`. Es la misma regla que el ADR-051: en
 *    Electron, el hilo que lee el disco es el que repinta la ventana y atiende el IPC, así que un
 *    recorrido síncrono por una solución grande **es** una aplicación colgada. Cada `await` es
 *    además un respiro para el bucle de eventos.
 *  - **Los resultados salen antes de terminar.** Se emiten por lotes según se resuelven los
 *    archivos. Una búsqueda de "Product" en una solución mediana tarda un segundo largo, y un
 *    panel que no enseña nada hasta el final se percibe como roto aunque tarde lo mismo.
 *  - **Sólo manda la última.** Se teclea mientras se busca: cada consulta nueva invalida la
 *    anterior, que abandona en cuanto lo nota. Sin esto, dos recorridos compiten por el disco y el
 *    panel enseña una mezcla de los dos.
 *
 * No importa `electron` a propósito: la raíz del workspace se le pasa, así que las pruebas pueden
 * buscar en un árbol de verdad creado en un directorio temporal.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { SearchFileResult, SearchOptions, SearchProgress, SearchSummary } from '../../shared/file-search.js';
import {
  compileGlobs,
  buildSearchRegExp,
  hasBinaryExtension,
  looksBinary,
  matchesGlobs,
  MAX_SEARCHABLE_BYTES,
  searchContent,
  SearchPatternError,
  shouldSkipDirectory,
} from '../../shared/file-search.js';

/**
 * Cuántos archivos se leen a la vez.
 *
 * Ni uno (el disco se queda esperando) ni cien (la memoria se llena de contenidos que aún no se
 * han mirado y el resto del IDE se queda sin turnos). Ocho es el orden de magnitud que usan las
 * herramientas de línea de órdenes que hacen esto mismo.
 */
const READ_CONCURRENCY = 8;

/** Tope de archivos recorridos. Un workspace con más que esto no es una solución: es un disco. */
const MAX_FILES_VISITED = 40000;

/** Cada cuántos archivos con resultado se manda un avance al renderer. */
const PROGRESS_BATCH = 8;

/** …y cada cuánto tiempo, para que un lote incompleto no se quede esperando compañía. */
const PROGRESS_INTERVAL_MS = 150;

export interface SearchHooks {
  /** Avances parciales. El último lote llega también dentro del resumen final. */
  onProgress?: (progress: SearchProgress) => void;
}

/**
 * Número de orden de la búsqueda viva.
 *
 * Es a la vez el identificador que viaja al renderer y el testigo de cancelación: si sube mientras
 * una búsqueda corre, esa búsqueda ya no es la actual y se abandona.
 */
let generation = 0;

/** Cancela lo que haya en marcha. Lo llama el canal `search:cancel` y cada búsqueda nueva. */
export function cancel(): void {
  generation += 1;
}

/** Sólo para las pruebas: deja el contador donde estaba al empezar. */
export function reset(): void {
  generation = 0;
}

/**
 * Recorre el árbol dando archivos.
 *
 * Es un generador asíncrono para que quien lo consume pueda ir leyendo mientras se sigue
 * recorriendo, en vez de esperar a tener la lista entera. Los directorios ilegibles se saltan: una
 * carpeta sin permisos deja la búsqueda incompleta, no rota.
 */
async function* walk(directory: string, visited: { count: number }): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  // Los archivos antes que los subdirectorios: así los primeros resultados son los de arriba del
  // árbol, que es donde está lo que se acaba de tocar.
  const directories: string[] = [];

  for (const entry of entries) {
    if (visited.count >= MAX_FILES_VISITED) return;

    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) directories.push(join(directory, entry.name));
      continue;
    }

    if (!entry.isFile()) continue;
    if (hasBinaryExtension(entry.name)) continue;

    visited.count += 1;
    yield join(directory, entry.name);
  }

  for (const child of directories) {
    yield* walk(child, visited);
  }
}

/** Lee un archivo y busca dentro. Devuelve `null` si no aporta nada (binario, enorme, ilegible). */
async function searchFile(
  path: string,
  relativePath: string,
  regex: RegExp,
  options: SearchOptions,
  budget: number,
): Promise<SearchFileResult | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SEARCHABLE_BYTES) return null;

    const bytes = await readFile(path);
    if (looksBinary(bytes)) return null;

    return searchContent(bytes.toString('utf8'), path, relativePath, regex, options, budget);
  } catch {
    // Un archivo que desaparece a mitad de búsqueda, o que otro proceso tiene bloqueado, no puede
    // tumbar el resto: se salta.
    return null;
  }
}

/**
 * Busca en el workspace.
 *
 * Devuelve el resumen completo **y** va emitiendo avances por `hooks.onProgress`. Lo segundo es lo
 * que llena el panel mientras se busca; lo primero es lo que cierra la operación y lo que usan las
 * pruebas, que no quieren depender de cuántos lotes hayan salido.
 */
export async function searchWorkspace(
  root: string,
  options: SearchOptions,
  hooks: SearchHooks = {},
): Promise<SearchSummary> {
  const searchId = ++generation;
  const started = Date.now();

  const summary: SearchSummary = {
    searchId,
    files: [],
    totalMatches: 0,
    filesScanned: 0,
    filesMatched: 0,
    truncated: false,
    cancelled: false,
    elapsedMs: 0,
    error: null,
  };

  const finish = (): SearchSummary => {
    summary.elapsedMs = Date.now() - started;
    return summary;
  };

  let regex: RegExp;
  try {
    regex = buildSearchRegExp(options);
  } catch (error) {
    // Una expresión regular a medias no es una excepción que propagar: es el estado normal de
    // quien está escribiéndola. Viaja como resultado, igual que un fallo de red en el cliente HTTP.
    summary.error = error instanceof SearchPatternError ? error.message : String(error);
    return finish();
  }

  const globs = compileGlobs(options.include, options.exclude);
  const visited = { count: 0 };
  const iterator = walk(root, visited)[Symbol.asyncIterator]();

  let pending: SearchFileResult[] = [];
  let lastFlush = started;

  const flush = (force: boolean): void => {
    if (pending.length === 0) return;
    if (!force && pending.length < PROGRESS_BATCH && Date.now() - lastFlush < PROGRESS_INTERVAL_MS) return;

    hooks.onProgress?.({
      searchId,
      files: pending,
      totalMatches: summary.totalMatches,
      filesScanned: summary.filesScanned,
    });

    pending = [];
    lastFlush = Date.now();
  };

  const cancelled = (): boolean => generation !== searchId;

  /**
   * Un lector.
   *
   * Se lanzan `READ_CONCURRENCY` sobre el **mismo** iterador: cada uno pide el siguiente archivo
   * cuando termina con el suyo, así que ninguno se queda parado esperando a un archivo grande de
   * otro. Los generadores asíncronos serializan sus `next()`, de modo que no hay carrera.
   */
  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled() || summary.truncated) return;

      const next = await iterator.next();
      if (next.done === true) return;

      const path = next.value;
      const relativePath = relative(root, path).split(sep).join('/');

      if (!matchesGlobs(relativePath, globs)) continue;

      summary.filesScanned += 1;

      const budget = options.maxResults - summary.totalMatches;
      if (budget <= 0) {
        summary.truncated = true;
        return;
      }

      const result = await searchFile(path, relativePath, regex, options, budget);
      if (result === null) continue;
      if (cancelled()) return;

      summary.files.push(result);
      summary.filesMatched += 1;
      summary.totalMatches += result.matches.length;
      if (result.truncated) summary.truncated = true;

      pending.push(result);
      flush(false);
    }
  };

  await Promise.all(Array.from({ length: READ_CONCURRENCY }, () => worker()));

  if (cancelled()) {
    summary.cancelled = true;
    return finish();
  }

  flush(true);
  return finish();
}
