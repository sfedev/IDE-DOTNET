/**
 * Últimas opciones de publicación de cada proyecto, en `userData/publish-profiles.json`.
 *
 * Va aparte de `settings.json` por lo mismo que la disposición de las terminales (ADR-061):
 * aquello son preferencias del usuario, esto es estado de un proyecto concreto y hay una entrada
 * por cada uno. Y no va dentro del repositorio del usuario: publicar en `D:\\entregas\\cliente` es
 * una decisión de esta máquina, no del proyecto, y un `.pubxml` versionado diría lo contrario
 * (ADR-015, la misma regla que con los perfiles de inicio).
 *
 * La clave es la ruta del `.csproj`, que la pone el proceso principal ya validada contra el
 * workspace. Lo leído del disco se sanea con `coercePublishOptions` exactamente igual que lo que
 * llega del renderer: este archivo lo escribe una versión del IDE y lo lee otra, y su contenido
 * acaba siendo argumentos de `dotnet`.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PublishOptions } from '../../shared/dotnet-publish.js';
import { coercePublishOptions } from '../../shared/dotnet-publish.js';
import { parseJsonText } from '../../shared/json-text.js';

/** Tope de proyectos recordados. Al pasarlo se van los que llevan más tiempo sin publicarse. */
export const MAX_REMEMBERED_PROJECTS = 60;

let storePath: string;

/** Opciones por ruta de proyecto. Se mantiene en memoria y se vuelca entero al guardar. */
let cached: Map<string, PublishOptions> | null = null;

export function initialize(userDataPath: string): void {
  storePath = join(userDataPath, 'publish-profiles.json');
  cached = null;
}

/** Sólo para las pruebas: olvida lo leído para volver a leerlo del disco. */
export function resetCache(): void {
  cached = null;
}

async function readStore(): Promise<Map<string, PublishOptions>> {
  if (cached !== null) return cached;

  const store = new Map<string, PublishOptions>();
  cached = store;

  if (!storePath || !existsSync(storePath)) return store;

  try {
    const raw = parseJsonText<unknown>(await readFile(storePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return store;

    for (const [project, value] of Object.entries(raw as Record<string, unknown>)) {
      if (project.trim() === '') continue;
      store.set(project, coercePublishOptions(value));
    }
  } catch {
    // Un archivo ilegible no puede impedir publicar: se empieza de cero. Lo peor que pasa es que
    // el diálogo se abra con los valores de fábrica una vez.
  }

  return store;
}

/** Opciones guardadas de un proyecto, o `null` si nunca se ha publicado desde aquí. */
export async function load(projectPath: string): Promise<PublishOptions | null> {
  if (!storePath || projectPath.trim() === '') return null;

  const store = await readStore();
  return store.get(projectPath) ?? null;
}

/** Anota con qué opciones se ha publicado. Se llama al lanzar, no al terminar. */
export async function save(projectPath: string, options: PublishOptions): Promise<void> {
  if (!storePath || projectPath.trim() === '') return;

  const store = await readStore();

  // El más reciente al final: al podar se van los que llevan más tiempo sin tocarse.
  store.delete(projectPath);
  store.set(projectPath, coercePublishOptions(options));

  while (store.size > MAX_REMEMBERED_PROJECTS) {
    const oldest = store.keys().next();
    if (oldest.done === true) break;
    store.delete(oldest.value);
  }

  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(Object.fromEntries(store), null, 2)}\n`, 'utf8');
}
