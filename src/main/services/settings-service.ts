/**
 * Persistencia de preferencias en `userData/settings.json`.
 *
 * Se valida campo a campo al leer: un settings.json corrupto o editado a mano no debe impedir
 * que el IDE arranque, sólo hacer que se ignoren los valores inválidos.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AppSettings } from '../../shared/contracts.js';
import { DEFAULT_SETTINGS } from '../../shared/contracts.js';
import { normalizeActivityOrder } from '../../shared/activity-bar.js';
import { coerceVerbosity } from '../../shared/dotnet-verbosity.js';
import { parseJsonText } from '../../shared/json-text.js';
import { coerceAiSettings } from './ai/preferences.js';

let settingsPath: string;
let cached: AppSettings = { ...DEFAULT_SETTINGS };

const MAX_RECENT = 10;

export function initialize(userDataPath: string): void {
  settingsPath = join(userDataPath, 'settings.json');
}

function coerce(raw: unknown): AppSettings {
  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return settings;

  const source = raw as Record<string, unknown>;

  if (source['theme'] === 'dotforge-dark' || source['theme'] === 'dotforge-light') {
    settings.theme = source['theme'];
  }
  if (typeof source['fontSize'] === 'number' && source['fontSize'] >= 8 && source['fontSize'] <= 32) {
    settings.fontSize = Math.round(source['fontSize']);
  }
  if (typeof source['fontFamily'] === 'string' && source['fontFamily'].trim() !== '') {
    settings.fontFamily = source['fontFamily'];
  }
  if (typeof source['tabSize'] === 'number' && source['tabSize'] >= 1 && source['tabSize'] <= 8) {
    settings.tabSize = Math.round(source['tabSize']);
  }
  for (const flag of ['wordWrap', 'minimap', 'formatOnSave', 'lspEnabled', 'autoUpdateCheck'] as const) {
    if (typeof source[flag] === 'boolean') settings[flag] = source[flag];
  }
  if (source['autoSave'] === 'off' || source['autoSave'] === 'afterDelay') {
    settings.autoSave = source['autoSave'];
  }
  if (typeof source['autoSaveDelayMs'] === 'number' && source['autoSaveDelayMs'] >= 200) {
    settings.autoSaveDelayMs = Math.round(source['autoSaveDelayMs']);
  }
  // Un nivel desconocido (de otra versión, o escrito a mano) vuelve al de por defecto en vez de
  // acabar como argumento de `dotnet build`.
  settings.dotnetVerbosity = coerceVerbosity(source['dotnetVerbosity']);

  // El orden de la barra lo puede haber escrito otra versión del IDE o una mano humana: se
  // normaliza a un orden completo en vez de creérselo. Una barra a la que le falta una herramienta
  // porque el archivo venía de la versión anterior es un icono que desaparece sin explicación.
  const activityBar = (source['activityBar'] ?? {}) as Record<string, unknown>;
  settings.activityBar = { order: normalizeActivityOrder(activityBar['order']) };

  // El asistente valida sus propias preferencias: el endpoint acaba siendo el destino de una
  // petición con la clave de API dentro, así que no basta con "es una cadena".
  settings.ai = coerceAiSettings(source['ai']);

  if (Array.isArray(source['recentWorkspaces'])) {
    settings.recentWorkspaces = source['recentWorkspaces']
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, MAX_RECENT);
  }

  return settings;
}

export async function load(): Promise<AppSettings> {
  if (!settingsPath || !existsSync(settingsPath)) {
    cached = { ...DEFAULT_SETTINGS };
    return cached;
  }

  try {
    cached = coerce(parseJsonText(await readFile(settingsPath, 'utf8')));
  } catch {
    // Preferencias ilegibles: se vuelve a los valores por defecto en vez de romper el arranque.
    cached = { ...DEFAULT_SETTINGS };
  }

  return cached;
}

export function current(): AppSettings {
  return cached;
}

export async function save(patch: Partial<AppSettings>): Promise<AppSettings> {
  cached = coerce({ ...cached, ...patch });
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(cached, null, 2)}\n`, 'utf8');
  return cached;
}

/** Añade un workspace al historial reciente, sin duplicados y con el más reciente primero. */
export async function rememberWorkspace(path: string): Promise<AppSettings> {
  const recent = [path, ...cached.recentWorkspaces.filter((entry) => entry !== path)].slice(0, MAX_RECENT);
  return save({ recentWorkspaces: recent });
}
