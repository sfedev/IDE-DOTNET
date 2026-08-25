/**
 * Persistencia de los perfiles de inicio, en `userData/startup-profiles.json`.
 *
 * Se guarda **por workspace**, no globalmente: "Backend + Web" significa una cosa en una solución
 * y nada en otra. La clave es la ruta del directorio del workspace.
 *
 * No se escribe dentro del repositorio del usuario a propósito: un archivo que el IDE crea sin
 * pedir permiso dentro de un proyecto acaba en un commit ajeno o en el `.gitignore` de otro.
 * Quien quiera compartir configuración de arranque tiene `launchSettings.json`, que es el
 * mecanismo del ecosistema.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { StartupConfig } from '../../shared/startup.js';
import { parseJsonText } from '../../shared/json-text.js';
import { coerceStartupConfig, DEFAULT_STARTUP_CONFIG } from '../../shared/startup.js';

let storePath: string;

/** Todo el archivo: workspace -> configuración. */
type Store = Record<string, unknown>;

export function initialize(userDataPath: string): void {
  storePath = join(userDataPath, 'startup-profiles.json');
}

async function readStore(): Promise<Store> {
  if (!storePath || !existsSync(storePath)) return {};

  try {
    const parsed: unknown = parseJsonText(await readFile(storePath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Store) : {};
  } catch {
    // Archivo corrupto: se ignora en vez de impedir que el IDE arranque. La siguiente escritura
    // lo deja sano otra vez.
    return {};
  }
}

/**
 * Configuración del workspace indicado.
 *
 * `knownProjects` permite depurar la lista: los proyectos que ya no están en la solución se caen
 * del perfil, y un perfil que se queda sin proyectos desaparece. Así, renombrar un proyecto no
 * deja un botón de Play que apunta a un `.csproj` inexistente.
 */
export async function load(workspaceDirectory: string, knownProjects?: readonly string[]): Promise<StartupConfig> {
  if (!workspaceDirectory) return { ...DEFAULT_STARTUP_CONFIG };

  const store = await readStore();
  return coerceStartupConfig(store[workspaceDirectory], knownProjects);
}

/** Guarda la configuración del workspace y devuelve lo que realmente ha quedado escrito. */
export async function save(workspaceDirectory: string, config: unknown): Promise<StartupConfig> {
  const validated = coerceStartupConfig(config);
  if (!workspaceDirectory || !storePath) return validated;

  const store = await readStore();
  store[workspaceDirectory] = validated;

  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');

  return validated;
}
