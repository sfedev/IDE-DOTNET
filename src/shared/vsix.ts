/**
 * Formato `.vsix`: qué hay dentro, qué se instala y qué aporta realmente.
 *
 * Un `.vsix` es un ZIP con esta forma:
 *
 *   extension.vsixmanifest     ← manifiesto XML de OPC, para el marketplace
 *   [Content_Types].xml        ← ídem
 *   extension/package.json     ← el manifiesto que importa: el de la extensión
 *   extension/…                ← todo lo demás (temas, gramáticas, iconos, código)
 *
 * Sólo se instala el subárbol `extension/`, sin el primer nivel. Los dos archivos de OPC son
 * envoltorio del canal de distribución y no le sirven de nada a nadie una vez descargado.
 *
 * La otra decisión importante es de honestidad: DotForge **no es VS Code** y no ejecuta el código
 * de activación de una extensión. Lo que aporta de verdad es lo estático —temas, fragmentos,
 * gramáticas, definiciones de lenguaje—, y eso es exactamente lo que la interfaz enseña de cada
 * extensión instalada, en vez de dejar creer que un depurador de Python va a funcionar aquí.
 */
import { compareVersions, parseVersion } from './updates.js';
import { parseJsonText } from './json-text.js';

/** Prefijo del subárbol que se instala. */
export const VSIX_ROOT = 'extension/';

/** Manifiesto de la extensión dentro del paquete. */
export const VSIX_MANIFEST = 'extension/package.json';

/** Nombre del manifiesto ya instalado (el primer nivel se descarta al extraer). */
export const EXTENSION_MANIFEST = 'package.json';

export interface VsixManifest {
  publisher: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  /** Versión mínima de la API de VS Code que declara. Informativa. */
  engine: string | null;
  categories: string[];
  license: string | null;
  repository: string | null;
  homepage: string | null;
  icon: string | null;
  /** Claves de `contributes` tal cual las declara el manifiesto. */
  contributes: string[];
  /** true si declara punto de entrada de código (`main` o `browser`). */
  hasCode: boolean;
}

export class VsixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VsixError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Nombre de repositorio: en `package.json` puede ser una cadena o un objeto `{ type, url }`.
 * Los dos son legales y los dos se ven en el registro.
 */
function repositoryOf(source: Record<string, unknown>): string | null {
  const direct = stringOf(source, 'repository');
  if (direct !== null) return direct;

  const record = asRecord(source['repository']);
  return record === null ? null : stringOf(record, 'url');
}

/**
 * Segmento válido para publisher y name.
 *
 * Se valida aquí y no sólo al buscar porque los dos acaban formando un **nombre de carpeta** en
 * `userData/extensions/`. Un `name` con `../` no es un caso teórico: es la forma más barata de
 * escribir fuera del directorio de extensiones.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requireSegment(value: string | null, field: string): string {
  if (value === null) throw new VsixError(`el manifiesto de la extensión no declara "${field}"`);
  if (!SEGMENT.test(value) || value.includes('..')) {
    throw new VsixError(`el campo "${field}" del manifiesto no es un identificador válido: ${value}`);
  }
  return value;
}

/** Lee `extension/package.json`. Lanza con un mensaje accionable si no sirve. */
export function parseVsixManifest(json: string): VsixManifest {
  let raw: unknown;
  try {
    raw = parseJsonText(json);
  } catch (error) {
    throw new VsixError(`el manifiesto de la extensión no es JSON válido: ${(error as Error).message}`);
  }

  const source = asRecord(raw);
  if (source === null) throw new VsixError('el manifiesto de la extensión no es un objeto');

  const publisher = requireSegment(stringOf(source, 'publisher'), 'publisher');
  const name = requireSegment(stringOf(source, 'name'), 'name');
  const version = requireSegment(stringOf(source, 'version'), 'version');

  const engines = asRecord(source['engines']);
  const contributes = asRecord(source['contributes']);

  return {
    publisher,
    name,
    version,
    displayName: stringOf(source, 'displayName') ?? name,
    description: stringOf(source, 'description') ?? '',
    engine: engines === null ? null : stringOf(engines, 'vscode'),
    categories: Array.isArray(source['categories'])
      ? source['categories'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    license: stringOf(source, 'license'),
    repository: repositoryOf(source),
    homepage: stringOf(source, 'homepage'),
    icon: stringOf(source, 'icon'),
    contributes: contributes === null ? [] : Object.keys(contributes),
    hasCode: stringOf(source, 'main') !== null || stringOf(source, 'browser') !== null,
  };
}

/** Identificador canónico de una extensión instalada. */
export function manifestId(manifest: VsixManifest): string {
  return `${manifest.publisher}.${manifest.name}`;
}

/**
 * Carpeta de instalación: `publisher.name-version`, como hace VS Code.
 *
 * Llevar la versión en el nombre permite tener dos instaladas a la vez durante una actualización
 * y borrar la vieja después, en vez de sobrescribir sobre archivos que quizá estén abiertos.
 */
export function extensionFolderName(manifest: VsixManifest): string {
  return `${manifest.publisher}.${manifest.name}-${manifest.version}`;
}

/** ¿Esta entrada del ZIP pertenece al subárbol que se instala? */
export function isExtensionEntry(entryName: string): boolean {
  return entryName.startsWith(VSIX_ROOT) && !entryName.endsWith('/');
}

// ---------------------------------------------------------------------------------------------
// Qué aporta la extensión
// ---------------------------------------------------------------------------------------------

/**
 * Contribuciones que DotForge puede aprovechar hoy: son declarativas, están en archivos JSON
 * dentro del paquete y no necesitan que se ejecute nada.
 */
export const STATIC_CONTRIBUTIONS: readonly string[] = [
  'themes',
  'iconThemes',
  'productIconThemes',
  'snippets',
  'grammars',
  'languages',
  'configurationDefaults',
];

export interface ContributionSummary {
  /** Etiquetas legibles de lo que aporta y se puede usar. */
  supported: string[];
  /** Etiquetas de lo que declara y aquí no tiene efecto. */
  unsupported: string[];
  /** true si el paquete trae código de activación, que este IDE no ejecuta. */
  hasCode: boolean;
}

const CONTRIBUTION_LABEL: Record<string, string> = {
  themes: 'temas de color',
  iconThemes: 'temas de iconos',
  productIconThemes: 'iconos de producto',
  snippets: 'fragmentos de código',
  grammars: 'gramáticas de resaltado',
  languages: 'definiciones de lenguaje',
  configurationDefaults: 'valores por defecto',
  commands: 'comandos',
  keybindings: 'atajos de teclado',
  menus: 'menús',
  debuggers: 'depuradores',
  views: 'vistas',
  viewsContainers: 'contenedores de vistas',
  configuration: 'preferencias',
  taskDefinitions: 'tareas',
  problemMatchers: 'detectores de problemas',
  jsonValidation: 'validación de JSON',
  breakpoints: 'puntos de interrupción',
  walkthroughs: 'tutoriales',
};

function label(key: string): string {
  return CONTRIBUTION_LABEL[key] ?? key;
}

/**
 * Reparte lo que declara el manifiesto entre lo que aquí sirve y lo que no.
 *
 * Existe para poder decirlo en la interfaz. Instalar una extensión y dejar que el usuario deduzca
 * solo por qué no pasa nada es exactamente lo que hace que un gestor de extensiones se perciba
 * como roto.
 */
export function describeContributions(manifest: VsixManifest): ContributionSummary {
  const supported: string[] = [];
  const unsupported: string[] = [];

  for (const key of manifest.contributes) {
    if (STATIC_CONTRIBUTIONS.includes(key)) supported.push(label(key));
    else unsupported.push(label(key));
  }

  return { supported, unsupported, hasCode: manifest.hasCode };
}

// ---------------------------------------------------------------------------------------------
// Extensiones instaladas
// ---------------------------------------------------------------------------------------------

export interface InstalledExtension {
  id: string;
  publisher: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  /** Carpeta absoluta dentro de `userData/extensions/`. */
  directory: string;
  installedAtUtc: string | null;
  categories: string[];
  contributions: ContributionSummary;
}

export function installedFrom(
  manifest: VsixManifest,
  directory: string,
  installedAtUtc: string | null,
): InstalledExtension {
  return {
    id: manifestId(manifest),
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    directory,
    installedAtUtc,
    categories: manifest.categories,
    contributions: describeContributions(manifest),
  };
}

/**
 * ¿La versión del registro es posterior a la instalada?
 *
 * Se reutiliza la comparación SemVer de las actualizaciones del IDE: es exactamente el mismo
 * problema, y tener dos implementaciones garantiza que una de las dos se quede atrás.
 */
export function hasNewerVersion(installed: string, available: string): boolean {
  const left = parseVersion(installed);
  const right = parseVersion(available);
  if (left === null || right === null) return false;
  return compareVersions(right, left) > 0;
}

/** Ordena por nombre visible, que es por lo que la gente busca en una lista. */
export function sortInstalled(extensions: InstalledExtension[]): InstalledExtension[] {
  return [...extensions].sort((a, b) => a.displayName.localeCompare(b.displayName, 'es'));
}
