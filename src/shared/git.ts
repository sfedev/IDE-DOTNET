/**
 * Modelo compartido del control de código fuente.
 *
 * Todo lo de este archivo es **función pura**: entra la salida cruda de `git status --porcelain`
 * y sale el modelo que pinta el panel lateral. Eso permite probar con Node puro los casos que de
 * otro modo sólo se descubren con un repositorio real delante: renombrados, conflictos, rutas con
 * espacios, un repositorio sin commits todavía o una rama sin upstream.
 *
 * No importa `electron`, ni `node:*`, ni el DOM: lo consumen el proceso principal (que ejecuta
 * git), el renderer (que pinta) y las pruebas.
 */

// ---------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------

/**
 * Letra que se pinta a la derecha de cada archivo.
 *
 * `M` modificado, `A` añadido, `D` eliminado, `U` sin rastrear (untracked), `R` renombrado,
 * `C` copiado y `!` en conflicto. Las cuatro primeras son las que ve un usuario el 99% del tiempo.
 */
export type GitChangeLetter = 'M' | 'A' | 'D' | 'U' | 'R' | 'C' | '!';

/** Los cambios viven en una de las dos secciones del panel. */
export type GitChangeArea = 'staged' | 'unstaged';

export interface GitFileChange {
  /** Ruta relativa a la raíz del repositorio, siempre con `/`. */
  path: string;
  /** Nombre del archivo, para la fila. */
  name: string;
  /** Carpeta contenedora relativa; cadena vacía si el archivo está en la raíz. */
  directory: string;
  area: GitChangeArea;
  letter: GitChangeLetter;
  /** Código `XY` crudo de `git status --porcelain`, por si hace falta depurar. */
  code: string;
  untracked: boolean;
  conflicted: boolean;
  /** Ruta anterior de un renombrado o copia; null en el resto. */
  from: string | null;
  /** Descripción legible del estado, para el `title` de la fila. */
  description: string;
}

export interface GitBranchState {
  /** Rama activa, el hash corto en HEAD desprendido, o null si no se pudo determinar. */
  branch: string | null;
  /** Rama de seguimiento (`origin/main`), o null si no la hay. */
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  /** false mientras el repositorio no tenga ningún commit: no se puede hacer diff contra HEAD. */
  hasCommits: boolean;
}

export interface GitRepositoryStatus extends GitBranchState {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  /** Archivos distintos con cambios. Es lo que enseña la barra de estado. */
  dirtyFiles: number;
  /**
   * Raíz del repositorio, en absoluto. El parser no la conoce —`git status` no la escribe—, la
   * rellena el servicio del proceso principal. El panel la necesita para convertir la ruta
   * relativa de un cambio en la ruta que abre el editor.
   */
  root: string | null;
}

export const EMPTY_GIT_STATUS: GitRepositoryStatus = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
  hasCommits: true,
  staged: [],
  unstaged: [],
  dirtyFiles: 0,
  root: null,
};

const LETTER_DESCRIPTION: Record<GitChangeLetter, string> = {
  M: 'Modificado',
  A: 'Añadido',
  D: 'Eliminado',
  U: 'Sin rastrear',
  R: 'Renombrado',
  C: 'Copiado',
  '!': 'En conflicto',
};

/** Texto legible de una letra de estado. Lo usan el panel y sus pruebas. */
export function describeLetter(letter: GitChangeLetter): string {
  return LETTER_DESCRIPTION[letter];
}

/** Códigos `XY` que git usa para un archivo en conflicto de fusión. */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU',
]);

// ---------------------------------------------------------------------------------------------
// Parseo
// ---------------------------------------------------------------------------------------------

/**
 * Deshace el entrecomillado de git.
 *
 * Con `core.quotePath=false` sólo quedan entrecomilladas las rutas con caracteres especiales
 * (comillas, barras invertidas, saltos de línea). Sin esto, `"src/mi archivo\".cs"` llegaría al
 * panel con las comillas puestas y el `git add` posterior fallaría.
 */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;

  const body = raw.slice(1, -1);
  let result = '';

  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== '\\') {
      result += char;
      continue;
    }

    const next = body[++index];
    switch (next) {
      case 'n': result += '\n'; break;
      case 't': result += '\t'; break;
      case 'r': result += '\r'; break;
      case '"': result += '"'; break;
      case '\\': result += '\\'; break;
      default: result += next ?? '';
    }
  }

  return result;
}

/** Separa una ruta relativa en carpeta y nombre, siempre con `/`. */
function splitPath(path: string): { name: string; directory: string } {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1
    ? { name: normalized, directory: '' }
    : { name: normalized.slice(slash + 1), directory: normalized.slice(0, slash) };
}

/**
 * Letra que corresponde a un código de estado en una de las dos áreas.
 * `X` es el índice (lo preparado) e `Y` el árbol de trabajo (lo que aún no lo está).
 */
function letterFor(code: string, area: GitChangeArea): GitChangeLetter {
  if (code === '??') return 'U';
  if (CONFLICT_CODES.has(code)) return '!';

  const symbol = area === 'staged' ? code[0] : code[1];
  switch (symbol) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case 'C': return 'C';
    case 'T': return 'M'; // Cambio de tipo (archivo <-> enlace): para el usuario es una modificación.
    default: return 'M';
  }
}

function makeChange(
  code: string,
  path: string,
  from: string | null,
  area: GitChangeArea,
): GitFileChange {
  const letter = letterFor(code, area);
  const { name, directory } = splitPath(path);

  return {
    path,
    name,
    directory,
    area,
    letter,
    code,
    untracked: code === '??',
    conflicted: CONFLICT_CODES.has(code),
    from,
    description:
      from === null ? describeLetter(letter) : `${describeLetter(letter)} desde ${from}`,
  };
}

/**
 * Cabecera `## rama...upstream [ahead N, behind M]` de `git status --branch`.
 *
 * Casos que hay que respetar y que se descubren tarde si no se prueban: `## HEAD (no branch)` en
 * HEAD desprendido, `## No commits yet on main` en un repositorio recién creado y `[gone]` cuando
 * la rama de seguimiento se ha borrado en el remoto.
 */
export function parseBranchLine(line: string): GitBranchState {
  const state: GitBranchState = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    hasCommits: true,
  };

  const body = line.startsWith('## ') ? line.slice(3) : line;

  if (body.startsWith('HEAD (no branch)')) {
    state.detached = true;
    return state;
  }

  let rest = body;

  const noCommits = /^No commits yet on (.+)$/.exec(rest);
  if (noCommits) {
    state.hasCommits = false;
    rest = noCommits[1] ?? '';
  }

  const tracking = new RegExp(String.raw`\s\[(.+)\]$`).exec(rest);
  if (tracking) {
    const detail = tracking[1] ?? '';
    const ahead = new RegExp(String.raw`ahead (\d+)`).exec(detail);
    const behind = new RegExp(String.raw`behind (\d+)`).exec(detail);
    if (ahead) state.ahead = Number(ahead[1]);
    if (behind) state.behind = Number(behind[1]);
    rest = rest.slice(0, tracking.index);
  }

  const separator = rest.indexOf('...');
  if (separator === -1) {
    state.branch = rest.trim() || null;
  } else {
    state.branch = rest.slice(0, separator).trim() || null;
    state.upstream = rest.slice(separator + 3).trim() || null;
  }

  return state;
}

/**
 * Parsea la salida de `git status --porcelain --branch`.
 *
 * Un archivo puede aparecer en las dos secciones a la vez (`MM`: modificado, preparado y vuelto a
 * modificar), y eso no es un error del parser sino la realidad del índice de git: se devuelve en
 * las dos, que es justo lo que enseña cualquier cliente decente.
 */
export function parseGitStatus(output: string): GitRepositoryStatus {
  const status: GitRepositoryStatus = { ...EMPTY_GIT_STATUS, staged: [], unstaged: [] };
  const touched = new Set<string>();

  for (const raw of output.split(new RegExp(String.raw`\r?\n`))) {
    if (raw === '') continue;

    if (raw.startsWith('## ')) {
      const branch = parseBranchLine(raw);
      status.branch = branch.branch;
      status.upstream = branch.upstream;
      status.ahead = branch.ahead;
      status.behind = branch.behind;
      status.detached = branch.detached;
      status.hasCommits = branch.hasCommits;
      continue;
    }

    // Una entrada es `XY<espacio>ruta`. Menos de cuatro caracteres no puede serlo.
    if (raw.length < 4) continue;

    const code = raw.slice(0, 2);
    if (code === '!!') continue; // Ignorado por .gitignore: no es un cambio.

    const payload = raw.slice(3);
    const arrow = payload.indexOf(' -> ');

    const from = arrow === -1 ? null : unquotePath(payload.slice(0, arrow));
    const path = unquotePath(arrow === -1 ? payload : payload.slice(arrow + 4));
    if (path === '') continue;

    touched.add(path);

    if (code === '??') {
      status.unstaged.push(makeChange(code, path, null, 'unstaged'));
      continue;
    }

    if (CONFLICT_CODES.has(code)) {
      status.unstaged.push(makeChange(code, path, from, 'unstaged'));
      continue;
    }

    const index = code[0] ?? ' ';
    const worktree = code[1] ?? ' ';

    if (index !== ' ') status.staged.push(makeChange(code, path, from, 'staged'));
    if (worktree !== ' ') status.unstaged.push(makeChange(code, path, from, 'unstaged'));
  }

  const byPath = (a: GitFileChange, b: GitFileChange): number => a.path.localeCompare(b.path);
  status.staged.sort(byPath);
  status.unstaged.sort(byPath);
  status.dirtyFiles = touched.size;

  return status;
}

// ---------------------------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------------------------

export interface GitSyncSummary {
  /** Texto compacto del botón: `↑2 ↓1`, `↑2`, `↓1` o cadena vacía. */
  label: string;
  /** Explicación larga para el `title`. */
  title: string;
  canPush: boolean;
  canPull: boolean;
  /** true si hay algo que publicar o que traer. */
  diverged: boolean;
}

/**
 * Resumen de sincronización para el botón `Sync`.
 *
 * Sin upstream, `push` sigue teniendo sentido (crea la rama en el remoto con `-u`) pero `pull`
 * no: no hay de dónde traer. Decirlo aquí evita que el botón prometa algo que va a fallar.
 */
export function syncSummary(status: GitBranchState): GitSyncSummary {
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);

  if (status.upstream === null) {
    return {
      label: parts.join(' '),
      title: 'Esta rama todavía no tiene rama de seguimiento: al publicar se creará en el remoto.',
      canPush: !status.detached,
      canPull: false,
      diverged: false,
    };
  }

  const descriptions: string[] = [];
  if (status.ahead > 0) descriptions.push(`${status.ahead} commit(s) por publicar`);
  if (status.behind > 0) descriptions.push(`${status.behind} commit(s) por traer`);

  return {
    label: parts.join(' '),
    title:
      descriptions.length > 0
        ? `${descriptions.join(' y ')} respecto a ${status.upstream}`
        : `Al día con ${status.upstream}`,
    canPush: status.ahead > 0 || status.behind === 0,
    canPull: true,
    diverged: status.ahead > 0 || status.behind > 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Construcción del diff de Monaco
// ---------------------------------------------------------------------------------------------

/** De dónde sale cada lado del editor de diferencias. */
export type GitDiffSide = 'head' | 'index' | 'worktree' | 'empty';

export interface GitDiffRequest {
  /** Ruta relativa del archivo en el lado modificado. */
  path: string;
  /** Ruta en el lado original: distinta de `path` sólo en un renombrado. */
  originalPath: string;
  area: GitChangeArea;
  original: GitDiffSide;
  modified: GitDiffSide;
  /** Título de la pestaña del diff. */
  title: string;
  originalLabel: string;
  modifiedLabel: string;
  /** El lado derecho es el archivo del disco y podría editarse; aquí siempre es de sólo lectura. */
  readOnly: true;
}

const SIDE_LABEL: Record<GitDiffSide, string> = {
  head: 'HEAD',
  index: 'Índice',
  worktree: 'Local',
  empty: 'Vacío',
};

/**
 * Traduce un archivo del panel a la petición de diferencias que hay que pintar.
 *
 * La regla es la que espera cualquiera que venga de otro cliente de git:
 *  - un archivo **preparado** se compara `HEAD ↔ Índice`: es exactamente lo que va a entrar en el
 *    commit;
 *  - un archivo **sin preparar** se compara `Índice ↔ Local`: es lo que todavía no está dentro.
 *
 * Los extremos importan tanto como el caso normal: un archivo añadido no existe en HEAD y uno
 * eliminado no existe en el lado derecho. Pedirle a git el contenido de un archivo que no existe
 * en esa revisión devuelve un error, así que el lado que falta se marca `empty` y el panel pinta
 * un documento vacío en vez de un mensaje de error.
 */
export function buildDiffRequest(change: GitFileChange): GitDiffRequest {
  const originalPath = change.from ?? change.path;

  const [original, modified]: [GitDiffSide, GitDiffSide] =
    change.area === 'staged'
      ? [change.letter === 'A' ? 'empty' : 'head', change.letter === 'D' ? 'empty' : 'index']
      : change.untracked
        ? ['empty', 'worktree']
        : [
            change.letter === 'A' ? 'empty' : 'index',
            change.letter === 'D' ? 'empty' : 'worktree',
          ];

  return {
    path: change.path,
    originalPath,
    area: change.area,
    original,
    modified,
    title: `${change.name} (${SIDE_LABEL[original]} ↔ ${SIDE_LABEL[modified]})`,
    originalLabel: SIDE_LABEL[original],
    modifiedLabel: SIDE_LABEL[modified],
    readOnly: true,
  };
}

/**
 * Identidad de la pestaña de diferencias.
 *
 * Incluye el área: el mismo archivo puede estar abierto a la vez como "lo preparado" y como "lo
 * que falta por preparar", y son dos comparaciones distintas.
 */
export function diffKey(request: GitDiffRequest): string {
  return `git:${request.area}:${request.path}`;
}

/**
 * Revisión de git que hay que pedir para un lado, o null si ese lado no sale de git.
 * `:` a secas es el índice en la sintaxis de `git show`.
 */
export function revisionFor(side: GitDiffSide, path: string): string | null {
  switch (side) {
    case 'head': return `HEAD:${path}`;
    case 'index': return `:${path}`;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------------------------

/** Tope del mensaje de commit. Muy por encima de cualquier mensaje razonable. */
export const MAX_COMMIT_MESSAGE_CHARS = 20_000;

/** Caracteres que git no admite en el nombre de una rama, resumidos a lo que hay que rechazar. */
const INVALID_BRANCH = new RegExp(String.raw`[\s~^:?*\[\\]|\.\.|^[-/.]|[/.]$|@\{|^@$`);

/**
 * ¿Sirve este nombre de rama?
 *
 * Se valida en el renderer para dar el aviso al escribir, y otra vez en el proceso principal
 * porque el renderer no es una frontera de confianza.
 */
export function isValidBranchName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > 255) return false;
  return !INVALID_BRANCH.test(trimmed);
}

/** Mensaje de commit utilizable, o null si está vacío o pasa del tope. */
export function normalizeCommitMessage(raw: string): string | null {
  const message = raw.replace(/\r\n/g, '\n').trim();
  if (message === '' || message.length > MAX_COMMIT_MESSAGE_CHARS) return null;
  return message;
}

/**
 * Resumen de una acción para la salida del IDE: `2 archivos preparados`.
 * Es un detalle, pero un panel que no dice qué ha hecho obliga a comprobarlo en la terminal.
 */
export function describeCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
