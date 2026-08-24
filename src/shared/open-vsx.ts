/**
 * Modelo del registro de extensiones Open VSX.
 *
 * Open VSX es el registro abierto (Eclipse Foundation) que sirve las mismas extensiones VSIX que
 * el marketplace de Microsoft, con una licencia que **sí** permite que las consuma un IDE que no
 * sea VS Code. Es la razón por la que DotForge nunca ha apuntado al marketplace propietario.
 *
 * Aquí sólo vive el modelo puro: cómo se construye cada URL, cómo se lee lo que contesta la API y
 * qué se considera una identidad de extensión válida. La red la pone el proceso principal.
 *
 * La pieza que parece burocracia y es seguridad: `isTrustedDownload`. La URL del `.vsix` **llega
 * dentro del JSON del registro**, es decir, es texto de la red que acaba siendo el destino de una
 * descarga que después se extrae en el disco del usuario. Si no se comprueba el host, cualquiera
 * que pueda alterar esa respuesta elige de dónde se baja el archivo.
 */

export const OPEN_VSX_API = 'https://open-vsx.org/api';

/** Hosts desde los que se acepta descargar un `.vsix`. Nada más. */
const TRUSTED_HOSTS: readonly string[] = ['open-vsx.org', 'www.open-vsx.org', 'openvsxorg.blob.core.windows.net'];

/** Cuántos resultados se piden por búsqueda. Una lista lateral no da para más. */
export const SEARCH_PAGE_SIZE = 30;

/**
 * Categorías de Open VSX, con su etiqueta en español.
 *
 * Los identificadores son los que entiende la API y no se traducen; lo que se traduce es lo que
 * lee el usuario.
 */
export const EXTENSION_CATEGORIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Todas las categorías' },
  { id: 'Programming Languages', label: 'Lenguajes' },
  { id: 'Snippets', label: 'Fragmentos' },
  { id: 'Themes', label: 'Temas' },
  { id: 'Debuggers', label: 'Depuradores' },
  { id: 'Formatters', label: 'Formateadores' },
  { id: 'Linters', label: 'Linters' },
  { id: 'Testing', label: 'Pruebas' },
  { id: 'SCM Providers', label: 'Control de fuentes' },
  { id: 'Data Science', label: 'Ciencia de datos' },
  { id: 'Machine Learning', label: 'Aprendizaje automático' },
  { id: 'Visualization', label: 'Visualización' },
  { id: 'Education', label: 'Educación' },
  { id: 'Other', label: 'Otras' },
];

// ---------------------------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------------------------

/**
 * Forma de un segmento del identificador (`publisher` o `name`).
 *
 * Se valida porque los dos acaban dentro de una URL y dentro de un nombre de carpeta en el disco.
 * Sin puntos, sin barras y sin `..`: lo que no encaje no es una extensión, es un intento.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidSegment(value: string): boolean {
  return SEGMENT.test(value) && !value.includes('..');
}

export interface ExtensionIdentity {
  namespace: string;
  name: string;
}

/** `redhat.java` -> `{ namespace: 'redhat', name: 'java' }`. Devuelve `null` si no encaja. */
export function parseExtensionId(id: string): ExtensionIdentity | null {
  const separator = id.indexOf('.');
  if (separator <= 0 || separator === id.length - 1) return null;

  const namespace = id.slice(0, separator);
  const name = id.slice(separator + 1);

  if (!isValidSegment(namespace) || !isValidSegment(name)) return null;
  if (name.includes('.')) return null;

  return { namespace, name };
}

export function extensionId(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

export interface SearchQuery {
  query?: string;
  category?: string;
  size?: number;
  offset?: number;
  includeAllVersions?: boolean;
}

/** URL de búsqueda. Todo lo que viene del usuario se codifica; nada se concatena a pelo. */
export function searchUrl(request: SearchQuery = {}): string {
  const parameters = new URLSearchParams();

  const query = (request.query ?? '').trim();
  if (query !== '') parameters.set('query', query);

  const category = (request.category ?? '').trim();
  if (category !== '') parameters.set('category', category);

  parameters.set('size', String(Math.min(Math.max(request.size ?? SEARCH_PAGE_SIZE, 1), 100)));
  parameters.set('offset', String(Math.max(request.offset ?? 0, 0)));
  parameters.set('includeAllVersions', request.includeAllVersions === true ? 'true' : 'false');
  // Sin término de búsqueda, lo relevante es lo más descargado: una lista vacía no enseña nada.
  parameters.set('sortBy', query === '' ? 'downloadCount' : 'relevance');
  parameters.set('sortOrder', 'desc');

  return `${OPEN_VSX_API}/-/search?${parameters.toString()}`;
}

/** URL de la ficha de una extensión. Lanza si el identificador no es válido. */
export function extensionUrl(namespace: string, name: string): string {
  if (!isValidSegment(namespace) || !isValidSegment(name)) {
    throw new Error(`identificador de extensión no válido: ${namespace}.${name}`);
  }
  return `${OPEN_VSX_API}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

/** URL del `.vsix` de una versión concreta, para cuando la ficha no trae `files.download`. */
export function downloadUrl(namespace: string, name: string, version: string): string {
  if (!isValidSegment(namespace) || !isValidSegment(name) || !isValidSegment(version)) {
    throw new Error(`no se puede construir la descarga de ${namespace}.${name}@${version}`);
  }

  const file = `${namespace}.${name}-${version}.vsix`;
  return `${extensionUrl(namespace, name)}/${encodeURIComponent(version)}/file/${encodeURIComponent(file)}`;
}

/**
 * ¿Se puede descargar de aquí?
 *
 * HTTPS y un host de la lista. Nada de "empieza por" ni de `includes`: `open-vsx.org.malo.dev`
 * contiene el host bueno y no es el host bueno.
 */
export function isTrustedDownload(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && TRUSTED_HOSTS.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Lectura de las respuestas
// ---------------------------------------------------------------------------------------------

export interface MarketplaceExtension {
  /** `namespace.name`, que es como se identifica en todas partes. */
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  /** URL del `.vsix`. Ya validada contra los hosts de confianza. */
  download: string | null;
  downloadCount: number;
  averageRating: number | null;
  reviewCount: number;
  timestamp: string | null;
  categories: string[];
  license: string | null;
  homepage: string | null;
  repository: string | null;
  verified: boolean;
}

export interface SearchResult {
  total: number;
  offset: number;
  extensions: MarketplaceExtension[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOf(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function numberOf(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function downloadOf(source: Record<string, unknown>, namespace: string, name: string, version: string): string | null {
  const files = asRecord(source['files']);
  const declared = files === null ? null : stringOf(files, 'download');

  if (declared !== null && isTrustedDownload(declared)) return declared;

  // Sin URL utilizable en la respuesta, se construye la canónica. Si tampoco se puede, la
  // extensión se enseña pero no se puede instalar, que es mejor que instalar de cualquier sitio.
  try {
    return downloadUrl(namespace, name, version);
  } catch {
    return null;
  }
}

/** Lee una entrada de extensión, venga de la búsqueda o de la ficha. `null` si no es utilizable. */
export function parseExtension(raw: unknown): MarketplaceExtension | null {
  const source = asRecord(raw);
  if (source === null) return null;

  const namespace = stringOf(source, 'namespace');
  const name = stringOf(source, 'name');
  const version = stringOf(source, 'version');
  if (namespace === null || name === null || version === null) return null;
  if (!isValidSegment(namespace) || !isValidSegment(name)) return null;

  const rating = numberOf(source, 'averageRating');

  return {
    id: extensionId(namespace, name),
    namespace,
    name,
    displayName: stringOf(source, 'displayName') ?? name,
    description: stringOf(source, 'description') ?? '',
    version,
    download: downloadOf(source, namespace, name, version),
    downloadCount: Math.max(0, Math.round(numberOf(source, 'downloadCount') ?? 0)),
    averageRating: rating === null ? null : Math.min(Math.max(rating, 0), 5),
    reviewCount: Math.max(0, Math.round(numberOf(source, 'reviewCount') ?? 0)),
    timestamp: stringOf(source, 'timestamp'),
    categories: Array.isArray(source['categories'])
      ? source['categories'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    license: stringOf(source, 'license'),
    homepage: stringOf(source, 'homepage'),
    repository: stringOf(source, 'repository'),
    verified: source['verified'] === true,
  };
}

export function parseSearch(raw: unknown): SearchResult {
  const source = asRecord(raw);
  if (source === null) return { total: 0, offset: 0, extensions: [] };

  const extensions: MarketplaceExtension[] = [];
  if (Array.isArray(source['extensions'])) {
    for (const entry of source['extensions']) {
      const parsed = parseExtension(entry);
      if (parsed !== null) extensions.push(parsed);
    }
  }

  return {
    total: Math.max(0, Math.round(numberOf(source, 'totalSize') ?? extensions.length)),
    offset: Math.max(0, Math.round(numberOf(source, 'offset') ?? 0)),
    extensions,
  };
}

// ---------------------------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------------------------

/** 12345678 -> "12,3 M". Mismo criterio que el panel de NuGet, para que se lean igual. */
export function formatDownloads(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace('.', ',')} K`;
  return String(value);
}

/**
 * Valoración en estrellas, en texto.
 *
 * Sin valoraciones devuelve cadena vacía y la interfaz no pinta nada: media estrella inventada es
 * peor que ninguna estrella.
 */
export function formatRating(average: number | null, reviews: number): string {
  if (average === null || reviews === 0) return '';
  const rounded = Math.round(average * 2) / 2;
  const full = Math.floor(rounded);
  const half = rounded - full >= 0.5 ? 1 : 0;
  return `${'★'.repeat(full)}${half === 1 ? '½' : ''} ${average.toFixed(1).replace('.', ',')}`;
}

/**
 * Color de la pastilla del icono, derivado del identificador.
 *
 * Los iconos remotos no se descargan: la CSP del renderer no admite imágenes de otros orígenes y,
 * como con NuGet, bajarlas contaría al registro qué está mirando el usuario. En su lugar se pinta
 * una pastilla con las iniciales, y el color sale del propio identificador para que la misma
 * extensión se vea siempre igual.
 */
export function extensionHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  return hash;
}

/** Iniciales de la pastilla: una o dos letras, siempre algo. */
export function extensionInitials(displayName: string, name: string): string {
  const source = displayName.trim() === '' ? name : displayName;
  const words = source.split(/[\s._-]+/).filter((word) => word !== '');

  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
}
