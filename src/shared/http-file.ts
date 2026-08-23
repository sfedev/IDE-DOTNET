/**
 * Modelo del cliente HTTP integrado: archivos `.http` y `.rest`.
 *
 * El formato es el que ya usa medio mundo (Visual Studio, VS Code REST Client, JetBrains): un
 * archivo de texto con peticiones separadas por `###`, variables con `@nombre = valor` y
 * sustitución con dobles llaves. Que sea texto plano es la mitad de la gracia: entra en el
 * repositorio, se revisa en un diff y no depende de que nadie exporte una colección.
 *
 * Todo lo de este archivo es **función pura**. El parser decide dónde empieza cada petición y qué
 * línea es la suya (la lente de código necesita el número de línea exacto); quien ejecuta es el
 * proceso principal, que es el único que puede abrir un socket.
 *
 * Casos borde que gobiernan el parser, todos vistos en archivos reales:
 *  - un cuerpo JSON contiene llaves y `###` dentro de una cadena: el separador sólo cuenta al
 *    principio de línea;
 *  - la primera petición puede no llevar separador delante;
 *  - los comentarios `#` y `//` conviven con la directiva `# @name`;
 *  - un archivo puede terminar sin salto de línea, y eso no puede comerse la última cabecera.
 */

// ---------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------

export interface HttpHeader {
  name: string;
  value: string;
}

export interface HttpRequestBlock {
  /** Posición dentro del archivo, empezando por 0. */
  index: number;
  /** Nombre del separador (`### Crear producto`) o de la directiva `# @name`. */
  name: string;
  method: string;
  url: string;
  /** `HTTP/1.1` si el archivo lo declara. No se usa para nada más que mostrarlo. */
  version: string | null;
  headers: HttpHeader[];
  body: string;
  /** Línea del separador que abre el bloque, en base 1. */
  startLine: number;
  /** Línea del verbo y la URL, en base 1: es donde se ancla la lente de código. */
  requestLine: number;
  endLine: number;
}

export interface HttpFileDocument {
  /** Variables `@nombre = valor` declaradas en la cabecera del archivo. */
  variables: Record<string, string>;
  requests: HttpRequestBlock[];
}

/** Petición ya resuelta, lista para salir por el cable. */
export interface ResolvedHttpRequest {
  method: string;
  url: string;
  headers: HttpHeader[];
  body: string | null;
}

/** Respuesta tal cual la devuelve el proceso principal. */
export interface HttpResponseResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: HttpHeader[];
  body: string;
  /** Tamaño real del cuerpo recibido, en bytes. */
  sizeBytes: number;
  durationMs: number;
  /** Id de lenguaje de Monaco para pintar el cuerpo (`json`, `xml`, `html`, `plaintext`). */
  languageId: string;
  /** URL final tras los redireccionamientos. */
  finalUrl: string;
  /** Mensaje de error cuando no ha habido respuesta (DNS, conexión rechazada, TLS). */
  error: string | null;
}

const METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT',
]);

export const HTTP_METHODS: readonly string[] = [...METHODS];

/** Extensiones que el cliente reconoce. */
export function isHttpFile(path: string): boolean {
  return /\.(http|rest)$/i.test(path);
}

// ---------------------------------------------------------------------------------------------
// Parseo
// ---------------------------------------------------------------------------------------------

const SEPARATOR = /^###(.*)$/;
const VARIABLE = /^@([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;
const NAME_DIRECTIVE = /^(?:#|\/\/)\s*@name\s+(.+)$/;
const COMMENT = /^(?:#|\/\/)/;

/** Línea de petición: `GET https://host/ruta HTTP/1.1`, con el verbo opcional (por defecto GET). */
function parseRequestLine(line: string): { method: string; url: string; version: string | null } | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(/\s+/);
  const head = parts[0]!.toUpperCase();

  if (METHODS.has(head)) {
    const url = parts[1] ?? '';
    if (url === '') return null;
    const version = parts[2] && /^HTTP\//i.test(parts[2]) ? parts[2] : null;
    return { method: head, url, version };
  }

  // Sin verbo: una URL suelta es un GET, que es como lo entienden el resto de clientes.
  if (/^(https?:\/\/|\{\{)/i.test(trimmed)) {
    return { method: 'GET', url: parts[0]!, version: null };
  }

  return null;
}

/**
 * Trocea un archivo `.http` en variables y peticiones.
 *
 * Nunca lanza: un archivo a medio escribir es el estado normal mientras se escribe, y la lente de
 * código tiene que seguir funcionando para las peticiones que sí están completas.
 */
export function parseHttpFile(text: string): HttpFileDocument {
  const lines = text.split(/\r?\n/);
  const variables: Record<string, string> = {};
  const requests: HttpRequestBlock[] = [];

  /** Bloque en construcción: líneas y en qué línea del archivo empezó. */
  let blockStart = 0;
  let block: string[] = [];
  let blockTitle = '';

  const flush = (endLine: number): void => {
    const parsed = parseBlock(block, blockStart, blockTitle, requests.length, variables);
    if (parsed) requests.push({ ...parsed, endLine });
    block = [];
    blockTitle = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const separator = SEPARATOR.exec(line);

    if (separator) {
      flush(i);
      blockStart = i + 1;
      blockTitle = separator[1]!.trim();
      continue;
    }

    block.push(line);
  }

  flush(lines.length);

  return { variables, requests };
}

/**
 * Convierte las líneas de un bloque en una petición.
 *
 * Las variables declaradas antes de la primera petición se acumulan en `variables`, que se pasa
 * por referencia: un `@baseUrl` en la cabecera del archivo tiene que verlo todo el archivo.
 */
function parseBlock(
  lines: readonly string[],
  startLine: number,
  title: string,
  index: number,
  variables: Record<string, string>,
): Omit<HttpRequestBlock, 'endLine'> | null {
  let directiveName = '';
  let requestIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '') continue;

    const variable = VARIABLE.exec(trimmed);
    if (variable) {
      variables[variable[1]!] = variable[2]!.trim();
      continue;
    }

    const named = NAME_DIRECTIVE.exec(trimmed);
    if (named) {
      directiveName = named[1]!.trim();
      continue;
    }

    if (COMMENT.test(trimmed)) continue;

    if (parseRequestLine(line) !== null) {
      requestIndex = i;
      break;
    }

    // Una línea que no es variable, ni comentario, ni petición: el bloque no es una petición.
    return null;
  }

  if (requestIndex === -1) return null;

  const request = parseRequestLine(lines[requestIndex]!)!;
  const headers: HttpHeader[] = [];

  let cursor = requestIndex + 1;
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor]!;
    if (line.trim() === '') {
      cursor++;
      break;
    }
    if (COMMENT.test(line.trim())) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }

  const body = lines
    .slice(cursor)
    .join('\n')
    // Se conservan las líneas en blanco de dentro y se recorta sólo la cola.
    .replace(/\s+$/, '');

  return {
    index,
    name: title !== '' ? title : directiveName !== '' ? directiveName : `${request.method} ${request.url}`,
    method: request.method,
    url: request.url,
    version: request.version,
    headers,
    body,
    startLine: startLine + 1,
    requestLine: startLine + requestIndex + 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Resolución de variables
// ---------------------------------------------------------------------------------------------

/** Valores dinámicos inyectables, para que la resolución siga siendo comprobable. */
export interface DynamicValues {
  nowMs: number;
  uuid: string;
  randomInt: number;
}

const DYNAMIC_DEFAULTS: DynamicValues = { nowMs: 0, uuid: '00000000-0000-0000-0000-000000000000', randomInt: 0 };

/**
 * Sustituye `{{variable}}` por su valor.
 *
 * Una variable que no existe se deja **tal cual**, en vez de convertirse en cadena vacía: una URL
 * con `{{baseUrl}}` a la vista dice qué falta; una URL truncada en `/api/products` no dice nada.
 *
 * Se admiten tres variables dinámicas, las mismas que el resto de clientes: `{{$guid}}`,
 * `{{$timestamp}}` y `{{$randomInt}}`.
 */
export function resolveVariables(
  text: string,
  variables: Readonly<Record<string, string>>,
  dynamic: Partial<DynamicValues> = {},
): string {
  const values = { ...DYNAMIC_DEFAULTS, ...dynamic };
  const seen = new Set<string>();

  const substitute = (input: string, depth: number): string =>
    input.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, rawName: string) => {
      const name = rawName.trim();

      if (name === '$guid') return values.uuid;
      if (name === '$timestamp') return String(Math.floor(values.nowMs / 1000));
      if (name === '$randomInt') return String(values.randomInt);

      const value = variables[name];
      if (value === undefined) return match;

      // Una variable puede referirse a otra; el tope corta cualquier ciclo.
      if (depth <= 0 || seen.has(name)) return value;
      seen.add(name);
      const resolved = substitute(value, depth - 1);
      seen.delete(name);
      return resolved;
    });

  return substitute(text, 5);
}

/** Petición lista para enviarse: URL, cabeceras y cuerpo con las variables ya sustituidas. */
export function resolveRequest(
  request: HttpRequestBlock,
  variables: Readonly<Record<string, string>>,
  dynamic: Partial<DynamicValues> = {},
): ResolvedHttpRequest {
  const resolve = (value: string): string => resolveVariables(value, variables, dynamic);

  return {
    method: request.method,
    url: resolve(request.url).trim(),
    headers: request.headers.map((header) => ({ name: header.name, value: resolve(header.value) })),
    body: request.body.trim() === '' ? null : resolve(request.body),
  };
}

/** Petición que contiene el cursor, para poder enviar "la de aquí" con un atajo. */
export function requestAtLine(document: HttpFileDocument, line: number): HttpRequestBlock | null {
  return (
    document.requests.find((request) => line >= request.startLine && line <= request.endLine) ??
    document.requests.find((request) => request.requestLine === line) ??
    null
  );
}

// ---------------------------------------------------------------------------------------------
// Presentación de la respuesta
// ---------------------------------------------------------------------------------------------

/** Id de lenguaje de Monaco a partir del `Content-Type`. */
export function languageForContentType(contentType: string | null): string {
  const value = (contentType ?? '').toLowerCase();

  if (value.includes('json')) return 'json';
  if (value.includes('html')) return 'html';
  if (value.includes('xml')) return 'xml';
  if (value.includes('javascript')) return 'javascript';
  if (value.includes('css')) return 'css';
  return 'plaintext';
}

/** Reindenta un cuerpo JSON para poder leerlo. Si no es JSON válido, se devuelve intacto. */
export function prettyBody(body: string, languageId: string): string {
  if (languageId !== 'json' || body.trim() === '') return body;

  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export type StatusTone = 'ok' | 'info' | 'warn' | 'error';

/** Color del estado: 2xx correcto, 3xx informativo, 4xx aviso, 5xx error. */
export function statusTone(status: number): StatusTone {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'info';
  if (status >= 400 && status < 500) return 'warn';
  return 'error';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
