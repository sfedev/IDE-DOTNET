/**
 * Estado de Git del workspace, para la barra inferior.
 *
 * Se invoca `git` directamente en vez de leer `.git/HEAD` a mano porque hay que cubrir worktrees,
 * submódulos y HEAD desprendido, y `git` ya sabe hacerlo. El resultado se cachea unos segundos:
 * la barra de estado se repinta a menudo y no tiene sentido lanzar dos procesos por cada repintado.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GitStatus } from '../../shared/contracts.js';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 4000;

let cache: { at: number; directory: string; status: GitStatus | null } | null = null;

/**
 * Las ramas cambian mucho menos que el estado, y el autocompletado las pide en cada pulsación:
 * una caché más larga evita lanzar un proceso por tecla.
 */
const BRANCH_CACHE_TTL_MS = 15_000;

let branchCache: { at: number; directory: string; branches: string[] } | null = null;

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // Sin git instalado, o el directorio no es un repositorio: no es un error del IDE.
    return null;
  }
}

export async function readStatus(directory: string): Promise<GitStatus | null> {
  if (cache && cache.directory === directory && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.status;
  }

  const inside = await git(['rev-parse', '--is-inside-work-tree'], directory);

  if (inside === null || inside.trim() !== 'true') {
    cache = { at: Date.now(), directory, status: null };
    return null;
  }

  // `--short` da una línea por archivo modificado; contarlas basta para la insignia.
  const [branchOutput, statusOutput] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], directory),
    git(['status', '--porcelain'], directory),
  ]);

  const branch = branchOutput?.trim() ?? null;

  const status: GitStatus = {
    // En HEAD desprendido, `--abbrev-ref` devuelve "HEAD"; se muestra el hash corto.
    branch: branch === 'HEAD' ? ((await git(['rev-parse', '--short', 'HEAD'], directory))?.trim() ?? 'HEAD') : branch,
    dirtyFiles: statusOutput ? statusOutput.split(/\r?\n/).filter((line) => line.trim() !== '').length : 0,
  };

  cache = { at: Date.now(), directory, status };
  return status;
}

/**
 * Ramas locales y remotas del repositorio, para el autocompletado de la terminal.
 *
 * Formato: la rama actual primero —es la que más se escribe después de `git merge`— y luego el
 * resto en el orden en que las devuelve git (por fecha de commit descendente, que aproxima bien
 * "las que estoy tocando"). Las remotas llegan con su prefijo (`origin/main`) y se descarta
 * `origin/HEAD`, que es un puntero simbólico y no una rama a la que se pueda cambiar.
 */
export async function listBranches(directory: string): Promise<string[]> {
  if (branchCache && branchCache.directory === directory && Date.now() - branchCache.at < BRANCH_CACHE_TTL_MS) {
    return branchCache.branches;
  }

  const output = await git(
    ['branch', '--all', '--sort=-committerdate', '--format=%(refname:short)'],
    directory,
  );

  const branches: string[] = [];
  if (output !== null) {
    const seen = new Set<string>();
    for (const raw of output.split(new RegExp(String.raw`\r?\n`))) {
      const branch = raw.trim();
      if (branch === '' || branch.endsWith('/HEAD') || branch.includes('->')) continue;
      if (seen.has(branch)) continue;
      seen.add(branch);
      branches.push(branch);
    }
  }

  branchCache = { at: Date.now(), directory, branches };
  return branches;
}

/** Invalida la caché: se llama al cambiar de workspace. */
export function invalidate(): void {
  cache = null;
  branchCache = null;
}
