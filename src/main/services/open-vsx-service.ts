/**
 * Cliente del registro Open VSX.
 *
 * Sólo red: construir la URL, pedirla y devolver lo que el modelo puro (`src/shared/open-vsx.ts`)
 * entienda de la respuesta. Igual que con NuGet, **la petición la hace el proceso principal**: la
 * CSP del renderer no permite ningún origen remoto, y así el registro nunca ve nada del equipo más
 * allá de la propia consulta.
 *
 * Hay caché de búsquedas con una vida corta. Teclear en el buscador dispara una consulta por
 * pausa, y volver atrás en la lista no debería costar otra vuelta a la red.
 */
import {
  extensionUrl,
  parseExtension,
  parseSearch,
  searchUrl,
  type MarketplaceExtension,
  type SearchQuery,
  type SearchResult,
} from '../../shared/open-vsx.js';

const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; result: SearchResult }>();

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'DotForge-IDE/2.1' },
  });

  if (!response.ok) {
    throw new Error(`Open VSX respondió ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

/** Busca extensiones. Sin término, devuelve las más descargadas: una lista vacía no enseña nada. */
export async function search(request: SearchQuery): Promise<SearchResult> {
  const url = searchUrl(request);

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const result = parseSearch(await fetchJson<unknown>(url));
  cache.set(url, { at: Date.now(), result });
  return result;
}

/** Ficha de una extensión concreta, con su versión más reciente y su URL de descarga. */
export async function detail(namespace: string, name: string): Promise<MarketplaceExtension | null> {
  return parseExtension(await fetchJson<unknown>(extensionUrl(namespace, name)));
}

/** Vacía la caché. Lo usa el botón de refrescar del panel. */
export function clearCache(): void {
  cache.clear();
}
