/**
 * Búsqueda de texto dentro de los archivos del workspace: la parte que se puede razonar.
 *
 * Aquí no hay disco ni IPC. Sólo tres decisiones, que son justo las que se rompen en silencio:
 *
 *  - **Qué se busca.** Texto plano, distinción de mayúsculas, palabra completa y expresión
 *    regular. Una expresión regular escrita a medias (`(`) es el estado *normal* de quien está
 *    tecleando: no es un error del que haya que quejarse a gritos, es "todavía no". Se devuelve
 *    como error con su mensaje y la vista lo enseña en pequeño, sin vaciar nada.
 *  - **Dónde se busca.** Patrones glob de inclusión y exclusión (`*.cs`, `src/**` con `*.razor`,
 *    `!*.designer.cs`). Se traducen a expresión regular una sola vez por búsqueda, no por archivo.
 *  - **Qué se enseña.** Un resultado es una línea, y una línea puede ser un `.razor` minificado de
 *    40 000 caracteres. Se recorta alrededor de la coincidencia, y se dice por dónde se ha cortado.
 *
 * Dos trampas que ya han costado caras en este repositorio y que aquí vuelven a aparecer:
 *
 *  - **Una expresión regular global tiene memoria** (`lastIndex`). Reutilizar la misma instancia
 *    línea a línea sin ponerla a cero se salta coincidencias de forma intermitente, que es la
 *    peor forma de fallar. Se pone a cero al empezar cada línea.
 *  - **Una coincidencia puede medir cero** (`a*`, `^`, `\b`). Sin avanzar el índice a mano, el
 *    bucle no termina nunca y la ventana se queda colgada.
 */

/** Opciones de una búsqueda. Es lo que viaja del renderer al proceso principal. */
export interface SearchOptions {
  /** El texto tal cual lo ha escrito quien busca. */
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  /** Globs separados por coma. Vacío significa "todos los archivos". */
  include: string;
  /** Globs separados por coma que se descartan, además de los directorios de siempre. */
  exclude: string;
  /** Tope de coincidencias de toda la búsqueda. */
  maxResults: number;
  /** Tope de coincidencias por archivo: un archivo con 4 000 no aporta más que uno con 200. */
  maxMatchesPerFile: number;
}

/** Una coincidencia, ya lista para pintar y para colocar el cursor. */
export interface SearchMatch {
  /** Línea, empezando en 1: es lo que espera Monaco. */
  line: number;
  /** Columna, empezando en 1. */
  column: number;
  /** Longitud en caracteres, para poder seleccionar lo encontrado y no sólo posarse encima. */
  length: number;
  /** La línea recortada a un tamaño que se pueda pintar. */
  preview: string;
  /** Columna de la coincidencia **dentro del recorte**, empezando en 1. */
  previewColumn: number;
}

/** Las coincidencias de un archivo. Los resultados van agrupados así de punta a punta. */
export interface SearchFileResult {
  /** Ruta absoluta: es la que abre el editor. */
  path: string;
  /** Ruta relativa al workspace, con separadores POSIX: es la que se enseña y la que filtran los globs. */
  relativePath: string;
  matches: SearchMatch[];
  /** True si el archivo tenía más coincidencias de las que caben en `maxMatchesPerFile`. */
  truncated: boolean;
}

/** El resultado completo de una búsqueda. */
export interface SearchSummary {
  /** Número de orden de la búsqueda: empareja los avances con su petición. */
  searchId: number;
  files: SearchFileResult[];
  totalMatches: number;
  filesScanned: number;
  filesMatched: number;
  /** True si se ha alcanzado el tope global y hay más coincidencias sin contar. */
  truncated: boolean;
  /** True si la búsqueda se canceló porque llegó otra. */
  cancelled: boolean;
  elapsedMs: number;
  /** Mensaje de por qué no se ha buscado nada (expresión regular a medias, consulta vacía). */
  error: string | null;
}

/** Avance parcial: los archivos que ya se han resuelto mientras la búsqueda sigue. */
export interface SearchProgress {
  searchId: number;
  files: SearchFileResult[];
  totalMatches: number;
  filesScanned: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  query: '',
  matchCase: false,
  wholeWord: false,
  useRegex: false,
  include: '',
  exclude: '',
  maxResults: 2000,
  maxMatchesPerFile: 200,
};

/**
 * Directorios que nunca se buscan.
 *
 * Es la misma lista que usan el explorador y el descubridor de pruebas, más `dist` y `TestResults`:
 * `obj` de una solución .NET contiene copias generadas de los `.cs` del proyecto, así que sin esto
 * cada coincidencia aparecería dos o tres veces y ninguna de las copias es la que hay que editar.
 */
export const SEARCH_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'bin',
  'obj',
  '.git',
  '.vs',
  '.vscode',
  '.idea',
  'node_modules',
  'TestResults',
  'artifacts',
  'dist',
  'build',
  '.next',
  'packages',
]);

/** Por encima de esto no se lee: no es código, y leerlo entero para nada cuesta memoria. */
export const MAX_SEARCHABLE_BYTES = 2 * 1024 * 1024;

/** Recorte de la línea que se enseña. Un `.razor` minificado es una sola línea de 40 000 caracteres. */
export const PREVIEW_MAX_LENGTH = 240;

/** Cuánto contexto se deja a la izquierda de la coincidencia al recortar. */
const PREVIEW_LEADING = 40;

/**
 * Consulta que no se puede ejecutar.
 *
 * Se distingue de un `Error` cualquiera porque no es un fallo del programa: es una consulta a
 * medias, y la vista la trata como tal.
 */
export class SearchPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchPatternError';
  }
}

// ---------------------------------------------------------------------------------------------
// Qué se busca
// ---------------------------------------------------------------------------------------------

/** Escapa lo que en una expresión regular significaría otra cosa. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Qué cuenta como carácter de palabra.
 *
 * `\w` de JavaScript es ASCII: con él, "año" partido por la mitad seguiría siendo "palabra
 * completa" y `Configuración` no casaría consigo mismo. Se añaden los bloques latinos, que es lo
 * que aparece en el código y en los comentarios de quien usa esto.
 */
const WORD_CHARACTER = '[A-Za-z0-9_\\u00C0-\\u024F]';

/**
 * Construye la expresión regular de la búsqueda.
 *
 * "Palabra completa" se implementa con miradas alrededor y **no** con `\b`, que es lo que se
 * escribiría por costumbre. El motivo: `\b` es una frontera entre carácter de palabra y todo lo
 * demás, así que `\b\+\b` no casa nunca — buscar `+` como palabra completa devolvería siempre cero
 * resultados en vez de las sumas del archivo. Con miradas negativas, un patrón que empieza o acaba
 * en símbolo se comporta como uno esperaría.
 *
 * @throws SearchPatternError si la consulta está vacía o la expresión regular no compila.
 */
export function buildSearchRegExp(options: SearchOptions): RegExp {
  if (options.query === '') throw new SearchPatternError('la búsqueda está vacía');

  let source = options.useRegex ? options.query : escapeRegExp(options.query);

  if (options.wholeWord) {
    source = `(?<!${WORD_CHARACTER})(?:${source})(?!${WORD_CHARACTER})`;
  }

  const flags = options.matchCase ? 'g' : 'gi';

  try {
    return new RegExp(source, flags);
  } catch (error) {
    // El mensaje del motor viene en inglés y no se puede traducir, pero es lo único que dice
    // *dónde* está el paréntesis sin cerrar: se antepone la explicación en el idioma de la
    // interfaz y se conserva entero detrás.
    const detail = error instanceof Error ? error.message : String(error);
    throw new SearchPatternError(`La expresión regular no es válida — ${detail}`);
  }
}

/**
 * Coincidencias de una línea.
 *
 * La expresión regular se pone a cero al entrar: es global, o sea que tiene memoria, y reutilizarla
 * entre líneas sin reiniciarla se salta resultados de forma intermitente.
 */
export function matchesInLine(
  line: string,
  regex: RegExp,
  lineNumber: number,
  limit: number,
): SearchMatch[] {
  const found: SearchMatch[] = [];
  if (limit <= 0) return found;

  regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const column = match.index + 1;
    const length = match[0].length;
    const { preview, previewColumn } = previewOf(line, column, length);

    found.push({ line: lineNumber, column, length, preview, previewColumn });
    if (found.length >= limit) break;

    // Una coincidencia de longitud cero (`a*`, `^`, `\b`) deja `lastIndex` donde estaba: sin
    // empujarlo a mano, este bucle no termina nunca y la ventana se queda colgada.
    if (length === 0) regex.lastIndex += 1;
  }

  return found;
}

/**
 * Recorta la línea alrededor de la coincidencia.
 *
 * Se quita la sangría de la izquierda —en C# son ocho o doce espacios que no dicen nada— y, si aun
 * así no cabe, se abre una ventana alrededor de lo encontrado con elipsis en los lados cortados.
 * La columna que se devuelve es la de **dentro del recorte**: la de verdad viaja aparte, porque es
 * la que usa el editor para colocar el cursor.
 */
export function previewOf(
  line: string,
  column: number,
  length: number,
  maxLength: number = PREVIEW_MAX_LENGTH,
): { preview: string; previewColumn: number } {
  // Un `\r` de un archivo con finales de línea de Windows se pinta como un cuadrado en la lista.
  const clean = line.replace(/\r$/, '');

  const indent = clean.length - clean.trimStart().length;
  // La sangría sólo se quita si la coincidencia está a su derecha: buscar espacios es legítimo.
  const start = column - 1 >= indent ? indent : 0;

  let from = start;
  if (column - 1 - from > maxLength - PREVIEW_LEADING) {
    from = Math.max(start, column - 1 - PREVIEW_LEADING);
  }

  const head = from > start ? '…' : '';
  let preview = clean.slice(from, from + maxLength);
  const tail = from + maxLength < clean.length ? '…' : '';

  preview = `${head}${preview}${tail}`;

  return {
    preview,
    previewColumn: column - from + head.length,
    // `length` no se toca: la coincidencia puede quedar cortada por el borde derecho y quien pinta
    // ya recorta el subrayado contra el texto que tiene.
  };
}

/**
 * Divide el contenido en líneas.
 *
 * No se usa `split(/\r?\n/)` para poder devolver la línea con su `\r`: quien busca `\r` tiene
 * derecho a encontrarlo, y el recorte de presentación ya lo limpia después.
 */
export function splitLines(content: string): string[] {
  return content.split('\n');
}

/** Busca en el contenido de un archivo ya leído. Devuelve `null` si no hay ninguna coincidencia. */
export function searchContent(
  content: string,
  path: string,
  relativePath: string,
  regex: RegExp,
  options: Pick<SearchOptions, 'maxMatchesPerFile'>,
  budget: number = Number.POSITIVE_INFINITY,
): SearchFileResult | null {
  const limit = Math.max(0, Math.min(options.maxMatchesPerFile, budget));
  if (limit === 0) return null;

  const matches: SearchMatch[] = [];
  let truncated = false;

  const lines = splitLines(content);

  for (let index = 0; index < lines.length; index++) {
    const remaining = limit - matches.length;
    if (remaining <= 0) {
      // Se mira una línea más de lo necesario a propósito: sólo así se sabe si de verdad había
      // más y se puede decir "y algunas más" en vez de mentir por omisión.
      truncated = matchesInLine(lines[index]!, regex, index + 1, 1).length > 0;
      if (truncated) break;
      continue;
    }

    matches.push(...matchesInLine(lines[index]!, regex, index + 1, remaining));
  }

  if (matches.length === 0) return null;

  return { path, relativePath, matches, truncated };
}

// ---------------------------------------------------------------------------------------------
// Dónde se busca
// ---------------------------------------------------------------------------------------------

/** Un juego de globs ya compilado: lo que entra y lo que se descarta. */
export interface GlobFilter {
  include: RegExp[];
  exclude: RegExp[];
}

/**
 * Trocea una lista escrita a mano: `*.cs, src/**\/*.razor`.
 *
 * La coma separa patrones **y** separa alternativas dentro de `{cs,razor}`. Partir por comas a
 * secas rompe `*.{cs,razor}` en dos patrones inservibles (`*.{cs` y `razor}`) y el filtro deja de
 * encontrar nada sin decir por qué, así que se lleva la cuenta de las llaves abiertas.
 */
export function parseGlobList(text: string): string[] {
  const patterns: string[] = [];
  let current = '';
  let depth = 0;

  for (const character of text) {
    if (character === '{') depth += 1;
    else if (character === '}') depth = Math.max(0, depth - 1);

    if (character === ',' && depth === 0) {
      patterns.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  patterns.push(current);

  return patterns.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * Traduce un glob a expresión regular.
 *
 * Se admite lo que se usa de verdad: `*` (dentro de un segmento), `**` (cualquier profundidad),
 * `?` y las alternativas `{a,b}`. Un patrón **sin barras** casa por nombre de archivo a cualquier
 * profundidad: quien escribe `*.cs` quiere todos los `.cs` de la solución, no los de la raíz.
 *
 * Un patrón que acaba en `/` —o que nombra un directorio— casa con todo lo que cuelga de él:
 * `tests/` excluye el árbol entero, que es lo que uno espera al escribirlo.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = pattern.trim().replace(/\\/g, '/');
  if (source.startsWith('./')) source = source.slice(2);

  const directoryOnly = source.endsWith('/');
  if (directoryOnly) source = source.slice(0, -1);
  if (!source.includes('/')) source = `**/${source}`;

  let expression = '';

  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;

    if (character === '*') {
      const doubled = source[index + 1] === '*';
      if (doubled) {
        // `**/` se come también su barra, para que `**/x` case con `x` en la raíz.
        if (source[index + 2] === '/') {
          expression += '(?:[^/]*(?:/|$))*';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }

    if (character === '?') {
      expression += '[^/]';
      continue;
    }

    if (character === '{') {
      const close = source.indexOf('}', index);
      if (close !== -1) {
        const alternatives = source
          .slice(index + 1, close)
          .split(',')
          .map((entry) => escapeRegExp(entry));
        expression += `(?:${alternatives.join('|')})`;
        index = close;
        continue;
      }
    }

    expression += escapeRegExp(character);
  }

  // Un patrón que nombra un directorio incluye lo que cuelga de él.
  expression += directoryOnly ? '/.*' : '(?:/.*)?';

  // Las rutas se comparan siempre en minúsculas: en Windows y en macOS el sistema de archivos no
  // distingue, y un `*.CS` que no encuentra nada parecería un fallo del filtro.
  return new RegExp(`^${expression}$`, 'i');
}

/**
 * Compila las dos listas.
 *
 * Un patrón de la lista de inclusión que empieza por `!` es en realidad una exclusión: es la
 * notación de `.gitignore` y la que pide cualquiera que haya escrito `*.cs, !*.designer.cs` en la
 * misma caja. Sin esto habría que rellenar dos campos para una idea sola.
 */
export function compileGlobs(include: string, exclude: string): GlobFilter {
  const filter: GlobFilter = { include: [], exclude: [] };

  for (const pattern of parseGlobList(include)) {
    if (pattern.startsWith('!')) {
      const negated = pattern.slice(1).trim();
      if (negated !== '') filter.exclude.push(globToRegExp(negated));
      continue;
    }
    filter.include.push(globToRegExp(pattern));
  }

  for (const pattern of parseGlobList(exclude)) {
    const cleaned = pattern.startsWith('!') ? pattern.slice(1).trim() : pattern;
    if (cleaned !== '') filter.exclude.push(globToRegExp(cleaned));
  }

  return filter;
}

/** ¿Este archivo entra en la búsqueda? La ruta llega relativa al workspace y con barras POSIX. */
export function matchesGlobs(relativePath: string, filter: GlobFilter): boolean {
  const path = relativePath.replace(/\\/g, '/');

  if (filter.exclude.some((pattern) => pattern.test(path))) return false;
  if (filter.include.length === 0) return true;

  return filter.include.some((pattern) => pattern.test(path));
}

/**
 * ¿Hay que bajar a este directorio?
 *
 * Se mira sólo el nombre, no la ruta: `bin` es `bin` esté donde esté, y una solución .NET tiene uno
 * por proyecto.
 */
export function shouldSkipDirectory(name: string): boolean {
  return SEARCH_SKIPPED_DIRECTORIES.has(name);
}

/**
 * Extensiones que no se abren siquiera.
 *
 * La comprobación de verdad es el byte cero, pero llega tarde: para hacerla hay que haber leído el
 * archivo, y en una solución compilada eso significa pasear por megabytes de `.dll` y `.pdb` en
 * cada tecla. Esto es el atajo barato; `looksBinary` es la red que recoge lo que se cuele.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.dll', '.exe', '.pdb', '.so', '.dylib', '.a', '.lib', '.obj', '.o',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.nupkg', '.vsix', '.jar',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns', '.webp', '.tif', '.tiff',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.db', '.sqlite', '.sqlite3', '.mdf', '.ldf', '.bin', '.dat', '.cache',
]);

export function hasBinaryExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * ¿Esto es un binario?
 *
 * Un byte cero en la cabecera. Es la heurística de `grep` y de git, y acierta con lo que aparece
 * en una solución .NET: `.dll`, `.pdb`, `.png`, `.ico`. Un UTF-16 con BOM también tiene ceros y
 * también se descarta: buscar texto plano dentro de él daría cero coincidencias igualmente.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let index = 0; index < limit; index++) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------------------------

/** Saneado de lo que llega del renderer. El proceso principal no se fía de sus argumentos. */
export function coerceSearchOptions(raw: unknown): SearchOptions {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const number = (value: unknown, fallback: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.min(Math.floor(value), max));
  };

  return {
    query: typeof source['query'] === 'string' ? source['query'].slice(0, 1000) : '',
    matchCase: source['matchCase'] === true,
    wholeWord: source['wholeWord'] === true,
    useRegex: source['useRegex'] === true,
    include: typeof source['include'] === 'string' ? source['include'].slice(0, 500) : '',
    exclude: typeof source['exclude'] === 'string' ? source['exclude'].slice(0, 500) : '',
    maxResults: number(source['maxResults'], DEFAULT_SEARCH_OPTIONS.maxResults, 20000),
    maxMatchesPerFile: number(source['maxMatchesPerFile'], DEFAULT_SEARCH_OPTIONS.maxMatchesPerFile, 2000),
  };
}

/** "128 resultados en 12 archivos". El texto de la cabecera, en un sitio que se puede probar. */
export function describeResults(summary: {
  totalMatches: number;
  filesMatched: number;
  truncated: boolean;
}): string {
  if (summary.totalMatches === 0) return 'Sin resultados';

  const matches = summary.totalMatches === 1 ? '1 resultado' : `${summary.totalMatches} resultados`;
  const files = summary.filesMatched === 1 ? '1 archivo' : `${summary.filesMatched} archivos`;

  return `${summary.truncated ? 'Más de ' : ''}${matches} en ${files}`;
}
