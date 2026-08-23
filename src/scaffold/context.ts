/**
 * Construye el contexto de render (tokens + flags) a partir de las opciones del usuario.
 *
 * Todo lo que una plantilla necesita saber vive aquí. Las plantillas no calculan nada.
 */
import type { FrameworkMoniker, ScaffoldOptions } from '../shared/scaffold-types.js';
import type { TemplateContext } from './engine.js';
import { pluralize, toCamelCase, toKebabCase, validateEntityName, validateSolutionName } from './naming.js';

/** Versiones de paquetes NuGet verificadas contra nuget.org y comprobadas con `dotnet build`. */
export interface PackageVersions {
  efCore: string;
  extensions: string;
  aspNetOpenApi: string;
  serilogAspNet: string;
  scalar: string;
  testSdk: string;
  xunit: string;
  xunitRunner: string;
}

const PACKAGE_MATRIX: Record<FrameworkMoniker, PackageVersions> = {
  'net9.0': {
    efCore: '9.0.19',
    extensions: '9.0.19',
    aspNetOpenApi: '9.0.19',
    serilogAspNet: '9.0.0',
    scalar: '2.17.1',
    testSdk: '18.9.0',
    xunit: '2.9.3',
    xunitRunner: '3.1.5',
  },
  'net10.0': {
    efCore: '10.0.11',
    extensions: '10.0.11',
    aspNetOpenApi: '10.0.11',
    serilogAspNet: '10.0.0',
    scalar: '2.17.1',
    testSdk: '18.9.0',
    xunit: '2.9.3',
    xunitRunner: '3.1.5',
  },
};

export function packageVersionsFor(framework: FrameworkMoniker): PackageVersions {
  const versions = PACKAGE_MATRIX[framework];
  if (!versions) {
    throw new Error(
      `framework no soportado: ${framework}. Soportados: ${Object.keys(PACKAGE_MATRIX).join(', ')}`,
    );
  }
  return versions;
}

export interface ResolvedOptions extends ScaffoldOptions {
  /** Nombre validado de la entidad, PascalCase singular. */
  entity: string;
  entityPlural: string;
  versions: PackageVersions;
  hasWebApi: boolean;
  hasBlazor: boolean;
}

export function resolveOptions(options: ScaffoldOptions): ResolvedOptions {
  const solutionName = validateSolutionName(options.solutionName);
  const entity = validateEntityName(options.entity);
  return {
    ...options,
    solutionName,
    entity,
    entityPlural: pluralize(entity),
    versions: packageVersionsFor(options.framework),
    hasWebApi: options.ui === 'webapi' || options.ui === 'both',
    hasBlazor: options.ui === 'blazor' || options.ui === 'both',
  };
}

/** Puerto base determinista por solución, para que dos soluciones no colisionen en localhost. */
export function derivePort(solutionName: string, offset: number): number {
  let hash = 0;
  for (let i = 0; i < solutionName.length; i++) {
    hash = (hash * 31 + solutionName.charCodeAt(i)) >>> 0;
  }
  return 5000 + (hash % 2000) + offset;
}

export function buildTemplateContext(resolved: ResolvedOptions, year: number): TemplateContext {
  const { solutionName, entity, entityPlural, versions } = resolved;

  const tokens: Record<string, string | number> = {
    Solution: solutionName,
    RootNamespace: solutionName,
    SolutionSlug: toKebabCase(solutionName),
    Framework: resolved.framework,
    Year: year,

    Entity: entity,
    entity: toCamelCase(entity),
    EntityPlural: entityPlural,
    entityPlural: toCamelCase(entityPlural),
    entityRoute: toKebabCase(entityPlural),

    DbProvider: resolved.db,
    DbName: `${toKebabCase(solutionName)}.db`,

    EfCoreVersion: versions.efCore,
    ExtensionsVersion: versions.extensions,
    AspNetOpenApiVersion: versions.aspNetOpenApi,
    SerilogAspNetVersion: versions.serilogAspNet,
    ScalarVersion: versions.scalar,
    TestSdkVersion: versions.testSdk,
    XunitVersion: versions.xunit,
    XunitRunnerVersion: versions.xunitRunner,

    ApiHttpPort: derivePort(solutionName, 0),
    ApiHttpsPort: derivePort(solutionName, 1),
    BlazorHttpPort: derivePort(solutionName, 2),
    BlazorHttpsPort: derivePort(solutionName, 3),
  };

  const flags: Record<string, boolean> = {
    hasWebApi: resolved.hasWebApi,
    hasBlazor: resolved.hasBlazor,
    hasBoth: resolved.hasWebApi && resolved.hasBlazor,
    hasTests: resolved.includeTests,
    useSqlite: resolved.db === 'sqlite',
    useInMemory: resolved.db === 'inmemory',
    isClean: resolved.architecture === 'clean',
    isHexagonal: resolved.architecture === 'hexagonal',
    isDdd: resolved.architecture === 'ddd',
  };

  return { tokens, flags };
}
