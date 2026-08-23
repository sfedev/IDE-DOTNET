/**
 * Localiza el directorio de plantillas.
 *
 * El mismo código corre en cuatro situaciones distintas y cada una las tiene en otro sitio:
 *  1. CLI compilada        -> build/templates
 *  2. Electron empaquetado -> process.resourcesPath/templates (fuera del asar: se leen con fs)
 *  3. Ejecución en fuentes -> src/scaffold/templates
 *  4. Tests                -> lo que indique DOTFORGE_TEMPLATES
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function resolveTemplatesRoot(baseDir: string): string {
  const candidates: string[] = [];

  const fromEnv = process.env['DOTFORGE_TEMPLATES'];
  if (fromEnv) candidates.push(resolve(fromEnv));

  candidates.push(join(baseDir, 'templates'));

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(join(resourcesPath, 'templates'));

  // Ejecución desde el árbol de fuentes: build/ -> raíz -> src/scaffold/templates
  candidates.push(join(dirname(baseDir), 'src', 'scaffold', 'templates'));
  candidates.push(join(baseDir, '..', 'src', 'scaffold', 'templates'));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, '_common'))) return candidate;
  }

  throw new Error(
    `no se encuentra el directorio de plantillas. Rutas probadas:\n  ${candidates.join('\n  ')}\n` +
      'Define DOTFORGE_TEMPLATES o ejecuta `npm run build` para copiarlas a build/templates.',
  );
}
