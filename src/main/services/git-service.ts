/**
 * Control de código fuente: estado del repositorio y operaciones de git.
 *
 * Se invoca `git` directamente en vez de leer `.git/` a mano porque hay que cubrir worktrees,
 * submódulos, HEAD desprendido y repositorios sin commits, y `git` ya sabe hacerlo. Todo pasa por
 * `execFile` con un array de argumentos: nunca se construye una línea de shell, así que un archivo
 * llamado `; rm -rf /` es sólo un archivo con un nombre feo.
 *
 * Dos decisiones que conviene no perder de vista:
 *
 * 1. **El estado se cachea unos segundos**, porque la barra inferior lo sondea cada seis y no
 *    tiene sentido lanzar dos procesos por repintado. Cualquier operación de escritura invalida
 *    la caché en el acto: un `commit` que sigue enseñando los archivos como pendientes es peor
 *    que no tener panel.
 * 2. **Un fallo de git no es una excepción del IDE.** "No hay nada que confirmar" o "el remoto ha
 *    rechazado el push" son respuestas normales; se devuelven como resultado con su salida cruda
 *    para poder enseñarla, en vez de convertirse en un diálogo de error.
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative as relativePath, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { GitCommandResult, GitStatus } from '../../shared/contracts.js';
import type { GitDiffRequest, GitRepositoryStatus } from '../../shared/git.js';
import { describeCount, isValidBranchName, normalizeCommitMessage, parseGitStatus, revisionFor } from '../../shared/git.js';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 4000;

let cache: { at: number; directory: string; status: GitStatus | null } | null = null;

/**
 * Las ramas cambian mucho menos que el estado, y el autocompletado las pide en cada pulsación:
 * una caché más larga evita lanzar un proceso por tecla.
 */
const BRANCH_CACHE_TTL_MS = 15_000;

let branchCache: { at: number; directory: string; branches: string[] } | null = null;

/** El panel de control de fuentes pide el estado detallado al abrirse y tras cada acción. */
const REPOSITORY_CACHE_TTL_MS = 1500;

let repositoryCache: { at: number; directory: string; status: GitRepositoryStatus | null } | null = null;

let rootCache: { directory: string; root: string | null } | null = null;

/**
 * Entorno de todas las llamadas.
 *
 * `GIT_TERMINAL_PROMPT=0` es imprescindible: sin él, un `push` contra un remoto que pide
 * credenciales se queda esperando una respuesta por un terminal que aquí no existe, y el IDE se
 * queda colgado sin decir por qué. Con esto, git falla enseguida y el mensaje se puede enseñar.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GCM_INTERACTIVE: 'never',
};

/** Argumentos previos comunes: sin escapado octal de rutas no ASCII y sin paginador. */
const GIT_PREFIX = ['-c', 'core.quotePath=false', '--no-pager'];

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd: string, timeoutMs = 15_000): Promise<GitRun> {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...GIT_PREFIX, ...args], {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: GIT_ENV,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? 'git ha fallado',
    };
  }
}

/** Variante silenciosa: devuelve la salida o null. Para las lecturas de la barra de estado. */
async function git(args: string[], cwd: string): Promise<string | null> {
  const result = await run(args, cwd);
  // Sin git instalado, o el directorio no es un repositorio: no es un error del IDE.
  return result.ok ? result.stdout : null;
}

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

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
 * Raíz del repositorio que contiene el workspace.
 *
 * Importa porque `git status --porcelain` da las rutas **relativas a la raíz**, no al directorio
 * desde el que se invoca: sin resolver la raíz, abrir una subcarpeta de un repositorio haría que
 * cada clic en un archivo del panel apuntara a una ruta que no existe.
 */
export async function repositoryRoot(directory: string): Promise<string | null> {
  if (rootCache && rootCache.directory === directory) return rootCache.root;

  const output = await git(['rev-parse', '--show-toplevel'], directory);
  const root = output === null || output.trim() === '' ? null : resolve(output.trim());

  rootCache = { directory, root };
  return root;
}

/** Estado completo para el panel: rama, upstream, adelanto/retraso y archivos por sección. */
export async function readRepository(directory: string): Promise<GitRepositoryStatus | null> {
  if (
    repositoryCache &&
    repositoryCache.directory === directory &&
    Date.now() - repositoryCache.at < REPOSITORY_CACHE_TTL_MS
  ) {
    return repositoryCache.status;
  }

  const root = await repositoryRoot(directory);
  if (root === null) {
    repositoryCache = { at: Date.now(), directory, status: null };
    return null;
  }

  const output = await git(['status', '--porcelain', '--branch', '--untracked-files=all'], root);
  const status = output === null ? null : { ...parseGitStatus(output), root };

  repositoryCache = { at: Date.now(), directory, status };
  return status;
}

/**
 * Ramas locales y remotas del repositorio, para el autocompletado de la terminal y el selector
 * de rama del panel.
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

/**
 * Contenido de un archivo en una revisión (`HEAD:ruta` o `:ruta` para el índice).
 *
 * Un archivo que no existe en esa revisión no es un error: es un archivo nuevo. Se devuelve
 * cadena vacía y el editor de diferencias pinta un lado vacío, que es la verdad.
 */
export async function showFile(directory: string, revision: string): Promise<string> {
  const root = await repositoryRoot(directory);
  if (root === null) return '';

  const result = await run(['show', revision], root);
  return result.ok ? result.stdout : '';
}

// ---------------------------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------------------------

/** Invalida las cachés: se llama tras cada operación de escritura y al cambiar de workspace. */
export function invalidate(): void {
  cache = null;
  branchCache = null;
  repositoryCache = null;
  rootCache = null;
}

function failure(message: string, detail = ''): GitCommandResult {
  return { ok: false, message, detail, status: null };
}

/** Cierra una operación: invalida la caché y devuelve el estado ya releído. */
async function settle(directory: string, ok: boolean, message: string, detail: string): Promise<GitCommandResult> {
  invalidate();
  const status = await readRepository(directory);
  return { ok, message, detail: detail.trim(), status };
}

/**
 * Convierte las rutas que manda el renderer en rutas relativas a la raíz del repositorio.
 *
 * Acepta absolutas (las que salen del explorador) y relativas (las que salen del propio panel),
 * y rechaza cualquier cosa que se salga de la raíz. Es la misma idea que `assertInsideWorkspace`,
 * aplicada al repositorio: el renderer no decide sobre qué archivos actúa git.
 */
export function toRepositoryPaths(root: string, paths: readonly unknown[]): string[] {
  const normalized: string[] = [];

  for (const entry of paths) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;

    const absolute = isAbsolute(entry) ? resolve(entry) : resolve(join(root, entry));

    // `path.relative` compara con las reglas de la plataforma (en Windows, sin distinguir
    // mayúsculas), que es justo lo que hace falta para decidir si una ruta sale de la raíz.
    const inside = relativePath(resolve(root), absolute).replace(/\\/g, '/');

    if (inside === '' || inside.startsWith('../') || inside === '..' || isAbsolute(inside)) continue;

    normalized.push(inside);
  }

  return normalized;
}

/** Prepara archivos. `git add` sirve igual para nuevos, modificados y borrados. */
export async function stage(directory: string, paths: readonly unknown[]): Promise<GitCommandResult> {
  const root = await repositoryRoot(directory);
  if (root === null) return failure('Esta carpeta no es un repositorio de git.');

  const files = toRepositoryPaths(root, paths);
  if (files.length === 0) return failure('No hay archivos que preparar.');

  const result = await run(['add', '--', ...files], root);
  return settle(
    directory,
    result.ok,
    result.ok
      ? `${describeCount(files.length, 'archivo preparado', 'archivos preparados')}.`
      : 'No se han podido preparar los archivos.',
    `${result.stdout}\n${result.stderr}`,
  );
}

/**
 * Saca archivos del área de preparación.
 *
 * `git restore --staged` necesita un HEAD que resolver, y en un repositorio recién creado todavía
 * no lo hay. En ese caso se cae a `git rm --cached`, que hace lo mismo sobre un índice sin commit
 * previo. Sin esa caída, el primer "quitar de preparados" de cada repositorio nuevo fallaba.
 */
export async function unstage(directory: string, paths: readonly unknown[]): Promise<GitCommandResult> {
  const root = await repositoryRoot(directory);
  if (root === null) return failure('Esta carpeta no es un repositorio de git.');

  const files = toRepositoryPaths(root, paths);
  if (files.length === 0) return failure('No hay archivos que quitar de preparados.');

  let result = await run(['restore', '--staged', '--', ...files], root);
  if (!result.ok) result = await run(['rm', '--cached', '-r', '--quiet', '--', ...files], root);

  return settle(
    directory,
    result.ok,
    result.ok
      ? `${describeCount(files.length, 'archivo', 'archivos')} fuera de preparados.`
      : 'No se han podido quitar de preparados.',
    `${result.stdout}\n${result.stderr}`,
  );
}

/**
 * Descarta los cambios locales.
 *
 * Un archivo con seguimiento vuelve a su versión del índice (`git restore`). Uno sin rastrear no
 * tiene versión anterior: se borra del disco. Son dos operaciones distintas con la misma etiqueta
 * en la interfaz, y por eso la interfaz pide confirmación nombrando cuál va a pasar.
 */
export async function discard(directory: string, paths: readonly unknown[]): Promise<GitCommandResult> {
  const root = await repositoryRoot(directory);
  if (root === null) return failure('Esta carpeta no es un repositorio de git.');

  const files = toRepositoryPaths(root, paths);
  if (files.length === 0) return failure('No hay cambios que descartar.');

  const status = await readRepository(directory);
  const untracked = new Set(
    (status?.unstaged ?? []).filter((change) => change.untracked).map((change) => change.path),
  );

  const tracked = files.filter((file) => !untracked.has(file));
  const detail: string[] = [];
  let ok = true;

  if (tracked.length > 0) {
    const result = await run(['restore', '--worktree', '--', ...tracked], root);
    ok = ok && result.ok;
    detail.push(result.stdout, result.stderr);
  }

  for (const file of files.filter((entry) => untracked.has(entry))) {
    try {
      // Se borra con Node y no con `git clean`: un `clean` mal acotado es de las pocas formas de
      // perder trabajo con git, y aquí sólo hay que borrar exactamente lo que se ha pedido.
      await rm(join(root, file), { recursive: true, force: true });
    } catch (error) {
      ok = false;
      detail.push(error instanceof Error ? error.message : String(error));
    }
  }

  return settle(
    directory,
    ok,
    ok
      ? `Cambios descartados en ${describeCount(files.length, 'archivo', 'archivos')}.`
      : 'No se han podido descartar todos los cambios.',
    detail.join('\n'),
  );
}

export async function commit(
  directory: string,
  rawMessage: unknown,
  options: { amend?: boolean } = {},
): Promise<GitCommandResult> {
  const root = await repositoryRoot(directory);
  if (root === null) return failure('Esta carpeta no es un repositorio de git.');

  const message = typeof rawMessage === 'string' ? normalizeCommitMessage(rawMessage) : null;
  if (message === null) return failure('Escribe un mensaje de commit antes de confirmar.');

  const amend = options.amend === true;

  // "No hay nada preparado" se decide mirando el índice, **no** el mensaje de error de git: sus
  // mensajes están traducidos al idioma del sistema y una regex sobre ellos falla en cuanto
  // alguien tiene Windows en español. Un enmendado sí puede ir con el índice vacío: cambia el
  // mensaje del último commit.
  const before = await readRepository(directory);
  if (!amend && (before?.staged.length ?? 0) === 0) {
    return failure(
      'No hay nada preparado que confirmar. Prepara algún archivo con el + de la sección "Cambios".',
    );
  }

  const args = ['commit', '--message', message];
  if (amend) args.push('--amend');

  const result = await run(args, root, 30_000);
  const combined = `${result.stdout}\n${result.stderr}`;

  return settle(
    directory,
    result.ok,
    result.ok ? `Commit creado: ${message.split('\n')[0] ?? ''}` : `El commit ha fallado: ${firstLine(combined)}`,
    combined,
  );
}

/**
 * Publica la rama.
 *
 * Si la rama todavía no tiene rama de seguimiento, se publica con `--set-upstream`: es lo que
 * hace falta la primera vez y lo que la gente espera del botón, en vez de un error que le dice
 * que ejecute a mano el comando que el IDE podía haber ejecutado.
 */
export async function push(directory: string): Promise<GitCommandResult> {
  const root = await repositoryRoot(directory);
  if (root === null) return failure('Esta carpeta no es un repositorio de git.');

  const status = await readRepository(directory);
  if (status?.detached === true) return failure('Estás en HEAD desprendido: crea una rama antes de publicar.');

  const args =
    status?.upstream === null && status.branch !== null
      ? ['push', '--set-upstream', 'origin', status.branch]
      : ['push'];

  const result = await run(args, root, 120_000);
  const combined = `${result.stdout}\n${result.stderr}`;

  return settle(
    directory,
    result.ok,
    result.ok ? 'Cambios publicados.' : `No se ha podido publicar: ${firstLine(combined)}`,
    combined,
  );
}

/**
 * Trae los cambios del remoto.
 *
 * `--ff-only` a propósito: una fusión o un rebase automático desde un botón que el usuario ha
 * pulsado sin leer nada es la forma más rápida de dejar el repositorio en un estado que no
 * esperaba. Si no se puede avanzar, se dice y se deja la decisión en la terminal.
 */
export async function pull(directory: string): Promise<GitCommandResult> {
  const root = await repositoryRoot(directory);
  if (root === null) return failure('Esta carpeta no es un repositorio de git.');

  const result = await run(['pull', '--ff-only'], root, 120_000);
  const combined = `${result.stdout}\n${result.stderr}`;
  const diverged = /not possible to fast-forward|divergent/i.test(combined);

  return settle(
    directory,
    result.ok,
    result.ok
      ? 'Repositorio actualizado.'
      : diverged
        ? 'Las ramas han divergido: resuélvelo con merge o rebase desde la terminal.'
        : `No se ha podido traer: ${firstLine(combined)}`,
    combined,
  );
}

/** `pull` y luego `push`. Si el primero falla no se publica: publicar sobre un remoto por delante
 * es justo lo que provoca el rechazo. */
export async function sync(directory: string): Promise<GitCommandResult> {
  const pulled = await pull(directory);
  if (!pulled.ok) return pulled;

  const pushed = await push(directory);
  return {
    ...pushed,
    message: pushed.ok ? 'Sincronizado con el remoto.' : pushed.message,
    detail: `${pulled.detail}\n${pushed.detail}`.trim(),
  };
}

export async function checkout(directory: string, branch: unknown): Promise<GitCommandResult> {
  const root = await repositoryRoot(directory);
  if (root === null) return failure('Esta carpeta no es un repositorio de git.');
  if (typeof branch !== 'string' || branch.trim() === '') return failure('Elige una rama.');

  const target = branch.trim();
  // Una rama remota (`origin/feature`) se materializa como rama local con seguimiento.
  const args = target.startsWith('origin/')
    ? ['checkout', '--track', target]
    : ['checkout', target];

  const result = await run(args, root, 60_000);
  const combined = `${result.stdout}\n${result.stderr}`;

  return settle(
    directory,
    result.ok,
    result.ok ? `Ahora estás en ${target.replace(/^origin\//, '')}.` : `No se ha podido cambiar de rama: ${firstLine(combined)}`,
    combined,
  );
}

export async function createBranch(directory: string, name: unknown): Promise<GitCommandResult> {
  const root = await repositoryRoot(directory);
  if (root === null) return failure('Esta carpeta no es un repositorio de git.');

  if (typeof name !== 'string' || !isValidBranchName(name)) {
    return failure('Ese nombre de rama no es válido: sin espacios, ni ~ ^ : ? * [ \\ ni ".." .');
  }

  const target = name.trim();
  const result = await run(['checkout', '-b', target], root, 30_000);
  const combined = `${result.stdout}\n${result.stderr}`;

  return settle(
    directory,
    result.ok,
    result.ok ? `Rama "${target}" creada y activa.` : `No se ha podido crear la rama: ${firstLine(combined)}`,
    combined,
  );
}

/** Contenido del lado izquierdo de una comparación, según de dónde salga. */
export async function diffSideContent(
  directory: string,
  request: GitDiffRequest,
  side: 'original' | 'modified',
): Promise<string> {
  const source = side === 'original' ? request.original : request.modified;
  if (source === 'empty') return '';

  if (source === 'worktree') {
    const root = await repositoryRoot(directory);
    if (root === null) return '';
    const { readFile } = await import('node:fs/promises');
    try {
      return await readFile(join(root, request.path), 'utf8');
    } catch {
      // El archivo puede haberse borrado entre el status y el clic: un lado vacío es la verdad.
      return '';
    }
  }

  const path = side === 'original' ? request.originalPath : request.path;
  const revision = revisionFor(source, path);
  return revision === null ? '' : showFile(directory, revision);
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? 'git no ha dicho nada'
  );
}
