/**
 * Contratos del módulo de scaffolding.
 *
 * Este archivo lo consumen el generador (Node puro), la CLI, el proceso main de Electron y el
 * renderer. Por eso NO puede importar nada de `electron` ni de `node:*`.
 */

export type ArchitectureId = 'clean' | 'hexagonal' | 'ddd';

/** Qué proyectos de presentación se generan. */
export type UiTarget = 'webapi' | 'blazor' | 'both';

/** Proveedor de persistencia preconfigurado en Infrastructure/Adapters. */
export type DbProvider = 'sqlite' | 'inmemory';

/** Target framework moniker soportado por las plantillas. */
export type FrameworkMoniker = 'net9.0' | 'net10.0';

export interface ScaffoldOptions {
  architecture: ArchitectureId;
  /** Nombre de la solución, p. ej. `Acme.Shop`. Es también el prefijo de cada proyecto. */
  solutionName: string;
  /** Directorio donde se creará la carpeta de la solución. */
  outputDir: string;
  ui: UiTarget;
  framework: FrameworkMoniker;
  db: DbProvider;
  /** Entidad de ejemplo del CRUD generado, en PascalCase singular. */
  entity: string;
  includeTests: boolean;
  /** Sobrescribe el directorio destino si ya existe y no está vacío. */
  force: boolean;
  /** Ejecuta `git init` + commit inicial en la solución generada. */
  gitInit: boolean;
}

export const DEFAULT_SCAFFOLD_OPTIONS: Omit<ScaffoldOptions, 'architecture' | 'solutionName' | 'outputDir'> = {
  ui: 'both',
  framework: 'net9.0',
  db: 'sqlite',
  entity: 'Product',
  includeTests: true,
  force: false,
  gitInit: false,
};

export interface GeneratedProject {
  /** Nombre del proyecto, p. ej. `Acme.Shop.Domain`. */
  name: string;
  /** Ruta relativa del .csproj dentro de la solución. */
  path: string;
  /** Capa arquitectónica a la que pertenece. */
  layer: string;
  /** GUID determinista usado en el .sln. */
  guid: string;
}

export interface ScaffoldResult {
  ok: boolean;
  architecture: ArchitectureId;
  solutionName: string;
  /** Ruta absoluta de la carpeta raíz de la solución generada. */
  rootDir: string;
  /** Ruta absoluta del archivo .sln. */
  solutionFile: string;
  projects: GeneratedProject[];
  files: string[];
  totalBytes: number;
  durationMs: number;
  warnings: string[];
  /** Comandos sugeridos para el usuario, en orden. */
  nextSteps: string[];
}

export interface BlueprintLayer {
  name: string;
  role: string;
  /** Capas de las que depende (por `name`). Vacío = núcleo sin dependencias. */
  dependsOn: string[];
}

/** Metadatos presentables de una arquitectura, usados por la CLI y por el wizard visual. */
export interface BlueprintInfo {
  id: ArchitectureId;
  title: string;
  tagline: string;
  description: string;
  layers: BlueprintLayer[];
  highlights: string[];
  /** Patrones y técnicas incluidos en el código generado. */
  patterns: string[];
}
