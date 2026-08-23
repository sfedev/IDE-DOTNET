/**
 * Cliente de la API v3 de nuget.org para el panel visual de paquetes.
 *
 * Se resuelve el índice del servicio (`/v3/index.json`) en vez de cablear la URL de búsqueda:
 * así el panel sigue funcionando si NuGet mueve sus endpoints, y el mismo código serviría para
 * un feed privado con sólo cambiar la raíz.
 */
import type { NuGetSearchResult } from '../../shared/contracts.js';

const SERVICE_INDEX = 'https://api.nuget.org/v3/index.json';
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface ServiceResource {
  '@id': string;
  '@type': string;
}

interface SearchResponse {
  data: Array<{
    id: string;
    version: string;
    description?: string;
    authors?: string[] | string;
    totalDownloads?: number;
    verified?: boolean;
    projectUrl?: string;
    licenseUrl?: string;
    iconUrl?: string;
    versions?: Array<{ version: string }>;
  }>;
}

let searchEndpoint: string | null = null;
const searchCache = new Map<string, { at: number; results: NuGetSearchResult[] }>();

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'DotForge-IDE/1.0' },
  });

  if (!response.ok) {
    throw new Error(`NuGet respondió ${response.status} ${response.statusText} para ${url}`);
  }

  return (await response.json()) as T;
}

async function resolveSearchEndpoint(): Promise<string> {
  if (searchEndpoint) return searchEndpoint;

  const index = await fetchJson<{ resources: ServiceResource[] }>(SERVICE_INDEX);
  const resource =
    index.resources.find((item) => item['@type'] === 'SearchQueryService/3.5.0') ??
    index.resources.find((item) => item['@type'].startsWith('SearchQueryService'));

  if (!resource) {
    throw new Error('el índice de NuGet no expone ningún SearchQueryService');
  }

  searchEndpoint = resource['@id'];
  return searchEndpoint;
}

function normalizeAuthors(authors: string[] | string | undefined): string {
  if (Array.isArray(authors)) return authors.join(', ');
  return authors ?? '';
}

export async function search(query: string, includePrerelease: boolean): Promise<NuGetSearchResult[]> {
  const term = query.trim();
  if (term.length === 0) return [];

  const cacheKey = `${term}|${includePrerelease}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.results;

  const endpoint = await resolveSearchEndpoint();
  const url = new URL(endpoint);
  url.searchParams.set('q', term);
  url.searchParams.set('take', '30');
  url.searchParams.set('prerelease', String(includePrerelease));
  url.searchParams.set('semVerLevel', '2.0.0');

  const response = await fetchJson<SearchResponse>(url.toString());

  const results: NuGetSearchResult[] = response.data.map((item) => ({
    id: item.id,
    version: item.version,
    description: item.description ?? '',
    authors: normalizeAuthors(item.authors),
    totalDownloads: item.totalDownloads ?? 0,
    verified: item.verified ?? false,
    projectUrl: item.projectUrl ?? null,
    licenseUrl: item.licenseUrl ?? null,
    iconUrl: item.iconUrl ?? null,
    // El orden de `versions` viene de más antigua a más reciente; la UI las quiere al revés.
    versions: (item.versions ?? []).map((entry) => entry.version).reverse(),
  }));

  searchCache.set(cacheKey, { at: Date.now(), results });
  return results;
}

/** Todas las versiones publicadas de un paquete, de la más reciente a la más antigua. */
export async function listVersions(packageId: string, includePrerelease: boolean): Promise<string[]> {
  const id = packageId.trim().toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(id)) {
    throw new Error(`identificador de paquete no válido: "${packageId}"`);
  }

  const response = await fetchJson<{ versions: string[] }>(
    `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/index.json`,
  );

  const versions = includePrerelease
    ? response.versions
    : response.versions.filter((version) => !version.includes('-'));

  return versions.reverse();
}

/** Vacía la caché de búsqueda. Lo usa el botón de recarga del panel. */
export function clearCache(): void {
  searchCache.clear();
}
