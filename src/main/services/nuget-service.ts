/**
 * Cliente de la API v3 de nuget.org para el panel visual de paquetes.
 *
 * Se resuelve el índice del servicio (`/v3/index.json`) en vez de cablear la URL de búsqueda:
 * así el panel sigue funcionando si NuGet mueve sus endpoints, y el mismo código serviría para
 * un feed privado con sólo cambiar la raíz.
 */
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import type { NuGetSearchResult } from '../../shared/contracts.js';
import type { AuditReport } from '../../shared/nuget-audit.js';
import {
  auditArgs,
  AUDIT_RESTORE_HINT,
  EMPTY_REPORT,
  parseVulnerableJson,
  parseVulnerableText,
} from '../../shared/nuget-audit.js';

const execFileAsync = promisify(execFile);

const SERVICE_INDEX = 'https://api.nuget.org/v3/index.json';
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * La auditoría restaura si hace falta y consulta la base de avisos: con los paquetes fríos y una
 * solución de seis proyectos, dos minutos es un tiempo normal, no una anomalía.
 */
const AUDIT_TIMEOUT_MS = 180_000;

const AUDIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  DOTNET_NOLOGO: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  // El camino bueno es el JSON, que es invariante. El inglés sólo importa para el degradado y
  // para que los mensajes de error coincidan con los de la documentación.
  DOTNET_CLI_UI_LANGUAGE: 'en',
};

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

// ---------------------------------------------------------------------------------------------
// Auditoría de seguridad
// ---------------------------------------------------------------------------------------------

/**
 * Vulnerabilidades conocidas de los paquetes restaurados.
 *
 * Se invoca `dotnet list package --vulnerable --include-transitive`, que cruza el grafo de
 * dependencias con los avisos de GitHub Security Advisories. Dos caminos, en este orden:
 *
 *  1. `--format json`, que existe desde el SDK 9 y devuelve estructura;
 *  2. la tabla de texto, para un SDK anterior, marcada como degradada.
 *
 * Un fallo del comando **no lanza**: que el proyecto no esté restaurado o que no haya red son
 * respuestas normales, y el panel las cuenta en una línea como hace el resto del IDE.
 */
export async function audit(target: string): Promise<AuditReport> {
  const attempt = async (json: boolean): Promise<{ ok: boolean; stdout: string; detail: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync('dotnet', auditArgs(target, json), {
        cwd: dirname(target),
        timeout: AUDIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: AUDIT_ENV,
      });
      return { ok: true, stdout, detail: `${stdout}${stderr}` };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const stdout = failure.stdout ?? '';
      return { ok: false, stdout, detail: `${stdout}${failure.stderr ?? ''}` || (failure.message ?? '') };
    }
  };

  const json = await attempt(true);
  const parsed = parseVulnerableJson(json.stdout);
  if (parsed !== null) return { ...parsed, at: Date.now() };

  // Sin bloque JSON el SDK es antiguo o el comando ha fallado antes de emitir nada. Se reintenta
  // con la tabla, que es lo que ese SDK sí sabe escribir.
  const table = await attempt(false);
  if (table.ok || /vulnerab/i.test(table.stdout)) {
    return { ...parseVulnerableText(table.stdout), at: Date.now() };
  }

  return {
    ...EMPTY_REPORT,
    degraded: true,
    error: auditError(table.detail),
    at: Date.now(),
  };
}

/**
 * Primera línea útil de un fallo de la auditoría.
 *
 * No se busca ninguna frase traducida: se coge la primera línea que no sea del build y, si el
 * texto menciona el archivo de activos —que es el nombre de un archivo, no un mensaje—, se
 * antepone la pista de restaurar, que es el fallo que le pasa a todo el mundo la primera vez.
 */
function auditError(detail: string): string {
  const lines = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const needsRestore = /project\.assets\.json|assets file/i.test(detail);
  const first = lines.find((line) => /error|no se|failed|unable/i.test(line)) ?? lines[0] ?? 'dotnet list package ha fallado';

  return needsRestore ? `${AUDIT_RESTORE_HINT} (${first})` : first;
}
