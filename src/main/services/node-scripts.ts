/**
 * Scripts del `package.json` del workspace.
 *
 * Existe para una sola cosa: que `npm run ` en la terminal integrada ofrezca **los scripts de este
 * repositorio**, no una lista inventada. Una solución .NET moderna suele traer un `package.json`
 * al lado (Tailwind, esbuild, herramientas de front), y ahí es donde vive lo que la gente ejecuta
 * y no recuerda.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonText } from '../../shared/json-text.js';

/** Nombres de los scripts declarados, en el orden del archivo. Vacío si no hay `package.json`. */
export async function readNpmScripts(directory: string): Promise<string[]> {
  try {
    const parsed: unknown = parseJsonText(await readFile(join(directory, 'package.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];

    const scripts = (parsed as Record<string, unknown>)['scripts'];
    if (typeof scripts !== 'object' || scripts === null) return [];

    return Object.keys(scripts as Record<string, unknown>);
  } catch {
    // Sin package.json, o con uno roto: no hay scripts que sugerir y no pasa nada.
    return [];
  }
}
