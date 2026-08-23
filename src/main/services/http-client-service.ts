/**
 * Cliente HTTP del editor: ejecuta la petición de un archivo `.http`.
 *
 * Se usa `node:http`/`node:https` en vez de `fetch` por tres motivos concretos, todos visibles
 * para quien desarrolla una API en local:
 *
 * 1. **El certificado de desarrollo de ASP.NET Core es autofirmado.** `fetch` lo rechaza sin
 *    apelación y el usuario no puede hacer nada desde el IDE. Aquí se acepta **sólo** cuando el
 *    destino es la máquina local: `localhost`, `127.0.0.1` o `::1`. Contra un host remoto, un
 *    certificado inválido sigue siendo un error, como debe ser.
 * 2. **Los tiempos.** Interesa el tiempo hasta la respuesta completa, y medirlo por fuera de
 *    `fetch` incluye la resolución del cuerpo pero no distingue el fallo de conexión.
 * 3. **Los redireccionamientos se siguen a mano**, con tope, y se informa de la URL final: un
 *    301 silencioso que cambia de host es justo lo que hay que ver.
 *
 * La petición llega ya resuelta desde el renderer (las variables se sustituyen en el modelo puro);
 * aquí sólo se valida, se envía y se devuelve lo que ha llegado.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

import type { HttpHeader, HttpResponseResult, ResolvedHttpRequest } from '../../shared/http-file.js';
import { languageForContentType, prettyBody } from '../../shared/http-file.js';

/** Tope del cuerpo que se guarda en memoria. Más allá, se corta y se dice. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MAX_REDIRECTS = 5;

const DEFAULT_TIMEOUT_MS = 60_000;

/** Hosts cuyo certificado autofirmado se acepta: el de `dotnet dev-certs`, y sólo ese. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

export class HttpRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

/** Valida lo que llega del renderer antes de abrir ningún socket. */
export function coerceRequest(raw: unknown): ResolvedHttpRequest {
  if (typeof raw !== 'object' || raw === null) throw new HttpRequestError('la petición debe ser un objeto');

  const value = raw as Partial<ResolvedHttpRequest>;
  const method = typeof value.method === 'string' && value.method.trim() !== '' ? value.method.trim().toUpperCase() : 'GET';

  if (!/^[A-Z]+$/.test(method)) throw new HttpRequestError(`método HTTP no válido: ${method}`);
  if (typeof value.url !== 'string' || value.url.trim() === '') throw new HttpRequestError('falta la URL');

  let url: URL;
  try {
    url = new URL(value.url.trim());
  } catch {
    throw new HttpRequestError(
      `la URL no es válida: ${value.url.trim()}. ` +
        'Si usas una variable, comprueba que está declarada con @nombre = valor en el archivo.',
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpRequestError(`protocolo no permitido: ${url.protocol}`);
  }

  const headers = Array.isArray(value.headers)
    ? value.headers
        .filter((header): header is HttpHeader => typeof header?.name === 'string' && typeof header?.value === 'string')
        .filter((header) => header.name.trim() !== '')
        // Un salto de línea en una cabecera es división de respuesta: se corta aquí.
        .map((header) => ({ name: header.name.trim(), value: header.value.replace(/[\r\n]/g, ' ').trim() }))
    : [];

  return {
    method,
    url: url.toString(),
    headers,
    body: typeof value.body === 'string' && value.body !== '' ? value.body : null,
  };
}

interface Attempt {
  status: number;
  statusText: string;
  headers: HttpHeader[];
  body: Buffer;
  location: string | null;
  truncated: boolean;
}

function send(request: ResolvedHttpRequest, timeoutMs: number): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const secure = url.protocol === 'https:';
    const dispatch = secure ? httpsRequest : httpRequest;

    const headers: Record<string, string> = {};
    for (const header of request.headers) headers[header.name] = header.value;

    const bodyBuffer = request.body === null ? null : Buffer.from(request.body, 'utf8');
    if (bodyBuffer && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(bodyBuffer.byteLength);
    }
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = 'DotForge-IDE';
    }

    const client = dispatch(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port !== '' ? url.port : undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        // Sólo para la máquina local: el certificado de desarrollo de .NET es autofirmado.
        ...(secure && isLocalHost(url.hostname) ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size <= MAX_BODY_BYTES) chunks.push(chunk);
          else truncated = true;
        });

        response.on('end', () => {
          const responseHeaders: HttpHeader[] = Object.entries(response.headers).flatMap(([name, value]) =>
            value === undefined
              ? []
              : Array.isArray(value)
                ? value.map((entry) => ({ name, value: entry }))
                : [{ name, value: String(value) }],
          );

          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            headers: responseHeaders,
            body: Buffer.concat(chunks),
            location: typeof response.headers.location === 'string' ? response.headers.location : null,
            truncated,
          });
        });

        response.on('error', reject);
      },
    );

    client.setTimeout(timeoutMs, () => {
      client.destroy(new HttpRequestError(`la petición ha superado el tiempo máximo (${Math.round(timeoutMs / 1000)} s)`));
    });

    client.on('error', reject);

    if (bodyBuffer) client.write(bodyBuffer);
    client.end();
  });
}

/** Códigos que se siguen automáticamente, conservando o no el método según manda la norma. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Envía la petición y devuelve la respuesta ya presentable.
 *
 * Un fallo de red **no lanza**: se devuelve como resultado con `error`, igual que hace el panel de
 * git con un push rechazado. Que el servidor no esté levantado todavía es el estado normal de un
 * desarrollo, no un error del IDE.
 */
export async function sendRequest(raw: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HttpResponseResult> {
  const startedAt = Date.now();

  let current: ResolvedHttpRequest;
  try {
    current = coerceRequest(raw);
  } catch (error) {
    return failure(error, '', Date.now() - startedAt);
  }

  try {
    let attempt = await send(current, timeoutMs);
    let redirects = 0;

    while (REDIRECTS.has(attempt.status) && attempt.location !== null && redirects < MAX_REDIRECTS) {
      redirects++;
      const next = new URL(attempt.location, current.url).toString();

      current = {
        // 303 y 302 sobre POST se convierten en GET: es lo que hace cualquier navegador.
        method: attempt.status === 303 || (attempt.status === 302 && current.method === 'POST') ? 'GET' : current.method,
        url: next,
        headers: current.headers,
        body: attempt.status === 303 ? null : current.body,
      };

      attempt = await send(current, timeoutMs);
    }

    const contentType = attempt.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? null;
    const languageId = languageForContentType(contentType);
    const text = attempt.body.toString('utf8');

    return {
      ok: attempt.status >= 200 && attempt.status < 400,
      status: attempt.status,
      statusText: attempt.statusText,
      headers: attempt.headers,
      body: attempt.truncated
        ? `${text}\n\n/* respuesta cortada: supera los ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB */`
        : prettyBody(text, languageId),
      sizeBytes: attempt.body.byteLength,
      durationMs: Date.now() - startedAt,
      languageId,
      finalUrl: current.url,
      error: null,
    };
  } catch (error) {
    return failure(error, current.url, Date.now() - startedAt);
  }
}

/** Traduce los fallos de socket a algo que se pueda leer sin buscar el código en Google. */
function describeNetworkError(error: unknown): string {
  const details = error as { code?: string; message?: string };

  switch (details.code) {
    case 'ECONNREFUSED':
      return 'conexión rechazada: ¿está la aplicación levantada y en ese puerto?';
    case 'ENOTFOUND':
      return 'no se ha podido resolver el host';
    case 'ETIMEDOUT':
      return 'el servidor no ha respondido a tiempo';
    case 'ECONNRESET':
      return 'la conexión se ha cerrado antes de responder';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'certificado autofirmado en un host remoto: sólo se acepta en localhost';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'no se ha podido verificar el certificado del servidor';
    default:
      return details.message ?? 'la petición ha fallado';
  }
}

function failure(error: unknown, url: string, durationMs: number): HttpResponseResult {
  return {
    ok: false,
    status: 0,
    statusText: '',
    headers: [],
    body: '',
    sizeBytes: 0,
    durationMs,
    languageId: 'plaintext',
    finalUrl: url,
    error: error instanceof HttpRequestError ? error.message : describeNetworkError(error),
  };
}
