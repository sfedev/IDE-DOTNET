/**
 * Navegación por el disco desde la terminal integrada.
 *
 * La terminal de DotForge no tiene pseudoterminal (ADR-004): lanza programas concretos y enseña su
 * salida. Eso tiene una consecuencia que se notaba mucho al usarla — **`cd` no hacía nada**. No es
 * que estuviera prohibido: es que cada comando se lanzaba con el directorio de la solución como
 * `cwd` y nadie llevaba la cuenta de dónde estaba el usuario, así que `cd src` se ejecutaba como un
 * programa (y fallaba, porque `cd` no es un programa: es una orden del intérprete).
 *
 * Aquí vive lo que se puede decidir mirando sólo el texto: **si una línea es un cambio de
 * directorio y a dónde quiere ir**. Lo que necesita el disco —resolver la ruta y comprobar que
 * existe— lo hace el servicio del proceso principal, igual que en el control de código fuente: el
 * parseo es puro y probado, y el servicio sólo ejecuta y delega.
 *
 * Se reconocen las tres familias que un desarrollador .NET escribe sin pensar:
 *
 *  - `cd` y `chdir` (cmd y POSIX), incluido el `cd /d D:\algo` de cmd;
 *  - `Set-Location` y su alias `sl` (PowerShell);
 *  - `pwd` (POSIX) y `Get-Location`/`gl` (PowerShell), que no cambian nada pero contestan.
 *
 * Y la que sólo tiene sentido en Windows: `D:` a secas, que en cmd cambia de unidad.
 */

/** Qué es una línea de terminal, antes de tocar el disco. */
export type TerminalIntent =
  /** Cambia de directorio. `target` es null en `cd` a secas. */
  | { kind: 'change-directory'; target: string | null }
  /** Pregunta dónde está. */
  | { kind: 'print-directory' }
  /** Cualquier otra cosa: se lanza como programa. */
  | { kind: 'command' };

const CHANGE_KEYWORDS = new Set(['cd', 'chdir', 'set-location', 'sl']);
const PRINT_KEYWORDS = new Set(['pwd', 'get-location', 'gl', 'cwd']);

/**
 * Modificadores del `cd` de cmd que no son el destino.
 *
 * `cd /d D:\proyectos` es la forma de cambiar de unidad **y** de directorio en una sola orden. El
 * `/d` no es la ruta, así que se descarta antes de mirar el destino; si no, se intentaría entrar en
 * una carpeta llamada `/d` y el mensaje de error no diría nada útil.
 */
const CHANGE_FLAGS = new Set(['/d', '-d', '/D', '-path', '-literalpath']);

/** `D:` (con o sin barra) es una unidad de Windows, no una carpeta relativa. */
const BARE_DRIVE = /^[A-Za-z]:[\\/]?$/;

export function isBareDrive(token: string): boolean {
  return BARE_DRIVE.test(token);
}

/**
 * Qué pretende una línea ya troceada en argv.
 *
 * Recibe el argv y no la línea cruda porque el troceo respeta comillas —una ruta con espacios entre
 * comillas es un solo argumento— y ese trabajo ya lo hace `tokenize` en el ejecutor. Repetirlo aquí
 * sería tener dos verdades sobre lo que es un argumento.
 */
export function classifyLine(argv: readonly string[]): TerminalIntent {
  const first = argv[0];
  if (first === undefined || first === '') return { kind: 'command' };

  const keyword = first.toLowerCase();

  if (PRINT_KEYWORDS.has(keyword) && argv.length === 1) return { kind: 'print-directory' };

  // `D:` a secas: cambia de unidad. Con algo detrás (`D: algo`) no es eso, y se deja pasar como
  // comando para que el error diga que el programa no existe.
  if (isBareDrive(first) && argv.length === 1) return { kind: 'change-directory', target: first };

  if (!CHANGE_KEYWORDS.has(keyword)) return { kind: 'command' };

  const rest = argv.slice(1).filter((token) => !CHANGE_FLAGS.has(token.toLowerCase()));
  const target = rest.length === 0 ? null : rest.join(' ');

  return { kind: 'change-directory', target };
}

/**
 * Destino a resolver, ya interpretado el atajo que lleve.
 *
 * `~` es el hogar, `-` es "el de antes" y una unidad suelta es su raíz. Devolver el atajo ya
 * resuelto —y no el literal— es lo que permite que el servicio se limite a un `resolve` y un `stat`
 * sin volver a razonar sobre casos especiales.
 */
export interface DirectoryTarget {
  /** Ruta que hay que resolver contra el directorio actual. */
  path: string;
  /** true si es absoluta y no debe combinarse con el directorio actual. */
  absolute: boolean;
}

export interface ResolveContext {
  /** Directorio de trabajo actual de la sesión. */
  current: string;
  /** Carpeta personal del usuario. */
  home: string;
  /** Directorio anterior, para `cd -`. Null si todavía no se ha cambiado ninguna vez. */
  previous: string | null;
  /** Raíz del workspace abierto, que es a donde lleva `cd` a secas en Windows. */
  workspace: string | null;
}

export class TerminalCwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalCwdError';
  }
}

/**
 * Traduce el destino escrito a una ruta que el servicio pueda resolver.
 *
 * `cd` a secas es el caso con más historia: en POSIX lleva al hogar y en cmd sólo imprime dónde
 * estás. Aquí lleva **a la raíz del workspace**, que es lo que uno quiere el 99 % de las veces
 * dentro de un IDE —"vuélveme a la solución"— y lo que hace que la orden sea útil en vez de una
 * curiosidad de plataforma. Sin workspace abierto, al hogar.
 */
export function resolveTarget(target: string | null, context: ResolveContext): DirectoryTarget {
  if (target === null) {
    return { path: context.workspace ?? context.home, absolute: true };
  }

  const trimmed = target.trim();
  if (trimmed === '') return { path: context.workspace ?? context.home, absolute: true };

  if (trimmed === '-') {
    if (context.previous === null) {
      throw new TerminalCwdError('todavía no hay ningún directorio anterior al que volver');
    }
    return { path: context.previous, absolute: true };
  }

  if (trimmed === '~') return { path: context.home, absolute: true };

  // `~/algo` y `~\algo`: el hogar más una cola relativa.
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return { path: `${context.home}/${trimmed.slice(2)}`, absolute: true };
  }

  if (isBareDrive(trimmed)) {
    return { path: `${trimmed.slice(0, 2)}\\`, absolute: true };
  }

  return { path: trimmed, absolute: false };
}

// ---------------------------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------------------------

/** Trocea una ruta en segmentos, tolerando los dos separadores. */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part !== '');
}

/** ¿`child` está dentro de `parent`? Comparación por segmentos, no por prefijo de texto. */
export function isInsideDirectory(parent: string, child: string): boolean {
  const parentParts = segmentsOf(parent);
  const childParts = segmentsOf(child);
  if (parentParts.length === 0 || childParts.length < parentParts.length) return false;

  // Windows no distingue mayúsculas en las rutas, y la comparación se hace sobre lo que el usuario
  // ha escrito: `c:\proyectos` y `C:\Proyectos` son el mismo sitio.
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  return parentParts.every((part, index) => same(part, childParts[index] ?? ''));
}

export interface ShortenOptions {
  home: string;
  /** Raíz del workspace abierto, si lo hay. */
  workspace: string | null;
  /** Nombre visible del workspace (el de la solución), para no repetir la ruta entera. */
  workspaceName?: string | null;
  /** Ancho máximo antes de recortar por el medio. */
  maxLength?: number;
}

const ELLIPSIS = '…';

/**
 * Ruta tal y como se enseña en el prompt.
 *
 * Tres reglas, en este orden, y las tres tienen motivo:
 *
 *  1. **Dentro del workspace, se enseña relativo a él.** Es el caso normal y es donde el prefijo
 *     absoluto no aporta nada: `Acme.Shop\src\Acme.Shop.Api` dice todo lo que hay que saber.
 *  2. **Dentro del hogar, con `~`.** Es la convención de cualquier terminal y ahorra media línea.
 *  3. **Fuera de los dos, la ruta entera**, recortada por el medio si no cabe. Se recorta por el
 *     medio y no por el final porque el final —dónde estás— es justo lo que importa.
 */
export function shortenPath(path: string, options: ShortenOptions): string {
  const maxLength = options.maxLength ?? 42;

  if (options.workspace !== null && isInsideDirectory(options.workspace, path)) {
    const root = options.workspaceName ?? segmentsOf(options.workspace).at(-1) ?? options.workspace;
    const tail = segmentsOf(path).slice(segmentsOf(options.workspace).length);
    return elide([root, ...tail].join('\\'), maxLength);
  }

  if (isInsideDirectory(options.home, path)) {
    const tail = segmentsOf(path).slice(segmentsOf(options.home).length);
    return elide(['~', ...tail].join('\\'), maxLength);
  }

  return elide(path, maxLength);
}

/**
 * Recorta por el medio conservando el principio y el final.
 *
 * El principio dice en qué unidad o raíz estás y el final dónde estás; lo de en medio es lo
 * prescindible.
 */
export function elide(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;

  const parts = path.split(/([\\/])/);
  const segments = segmentsOf(path);
  if (segments.length <= 2) return path;

  const separator = parts.includes('/') && !parts.includes('\\') ? '/' : '\\';
  const first = segments[0]!;

  // Se van quitando segmentos por el medio hasta que quepa, conservando siempre el primero y el
  // último: una ruta que sólo enseñe puntos suspensivos no informa de nada.
  for (let keep = segments.length - 2; keep >= 1; keep--) {
    const tail = segments.slice(segments.length - keep);
    const candidate = [first, ELLIPSIS, ...tail].join(separator);
    if (candidate.length <= maxLength) return candidate;
  }

  return [first, ELLIPSIS, segments.at(-1)].join(separator);
}
