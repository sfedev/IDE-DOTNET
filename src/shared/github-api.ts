/**
 * Cabeceras de las peticiones del toolchain, y dónde puede viajar un token de GitHub.
 *
 * El adquisidor del depurador y el del servidor de lenguaje consultan la API de GitHub para saber
 * cuál es la última release. Sin autenticar, esa API permite **60 peticiones por hora y por IP**, y
 * la IP de un runner de CI compartido las tiene agotadas casi siempre: el síntoma es un 403 que no
 * se parece en nada a un problema de red y que rompe la suite en máquinas ajenas.
 *
 * Autenticar la petición sube el límite a 5 000/hora, pero mete una credencial en el proceso, así
 * que la regla es explícita y está probada: **el token sólo se adjunta a `https://api.github.com`**.
 * Ni a la descarga del artefacto (que vive en `objects.githubusercontent.com`), ni al feed de
 * Azure de Roslyn, ni a ningún otro host. Un token enviado a un tercero es una credencial filtrada,
 * y da igual que el tercero sea de confianza.
 *
 * Módulo puro: no abre conexiones, sólo decide qué cabeceras lleva cada URL.
 */

/** Único host al que se le manda la credencial. Comparación exacta, nunca por sufijo. */
export const GITHUB_API_HOST = 'api.github.com';

/** Tipo de medio de la API de GitHub, que fija la versión del formato de respuesta. */
export const GITHUB_ACCEPT = 'application/vnd.github+json';

export const USER_AGENT = 'DotForge-IDE/1.0';

/**
 * Token de GitHub del entorno, o `null` si no hay.
 *
 * Se aceptan los dos nombres habituales: `GITHUB_TOKEN` es el que inyecta Actions y `GH_TOKEN` el
 * de la CLI `gh`. Fuera de CI no suele existir ninguno, y ése es el caso normal: sin token, todo
 * sigue funcionando exactamente igual que antes.
 */
export function githubToken(env?: Record<string, string | undefined>): string | null {
  const source = env ?? (typeof process === 'undefined' ? {} : process.env);
  const raw = source['GITHUB_TOKEN'] ?? source['GH_TOKEN'] ?? '';
  const token = raw.trim();
  return token === '' ? null : token;
}

/**
 * ¿Esta URL es la API de GitHub?
 *
 * Se compara el `hostname` completo y se exige HTTPS. Los dos detalles importan:
 * `api.github.com.malo.dev` **contiene** el host bueno y no lo es, y mandar una credencial por
 * HTTP es regalarla a quien esté escuchando.
 */
export function isGitHubApi(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === GITHUB_API_HOST;
  } catch {
    return false;
  }
}

export interface HeaderOptions {
  /** Tipo de medio pedido. Por defecto, el de la API de GitHub. */
  accept?: string;
  /** Credencial a usar. Por defecto, la del entorno. `null` desactiva la autenticación. */
  token?: string | null;
}

/**
 * Cabeceras para una petición del toolchain.
 *
 * Devuelve siempre `User-Agent` y `Accept` —la API de GitHub rechaza las peticiones sin agente— y
 * añade `Authorization` **sólo** si la URL es la API de GitHub y hay token. Cualquier otra URL
 * recibe exactamente las mismas cabeceras que recibía antes de que existiera este módulo.
 */
export function requestHeaders(url: string, options: HeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: options.accept ?? GITHUB_ACCEPT,
  };

  const token = options.token === undefined ? githubToken() : options.token;
  if (token !== null && token !== '' && isGitHubApi(url)) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

/**
 * Explica un 403 de la API de GitHub.
 *
 * Un 403 sin token casi nunca es un permiso: es el límite por IP. Decirlo evita que quien vea
 * fallar la adquisición en su CI busque el problema en la red o en el propio artefacto.
 */
export function rateLimitHint(status: number, authenticated: boolean): string | null {
  if (status !== 403 && status !== 429) return null;

  return authenticated
    ? 'la API de GitHub ha limitado las peticiones de este token; reinténtalo en unos minutos'
    : 'la API de GitHub limita a 60 peticiones por hora y por IP sin autenticar: define GITHUB_TOKEN';
}
