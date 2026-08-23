/**
 * Linter de reglas de arquitectura.
 *
 * Las reglas que el asistente de IA sabe explicar en prosa (`ARCHITECTURE_RULES` en
 * `ai-context.ts`) aquí se vuelven comprobables: qué capa puede depender de cuál, y qué paquetes
 * no pueden entrar en el núcleo. La diferencia entre las dos formas es la que hay entre un
 * documento y una prueba.
 *
 * Se comprueban tres cosas, y ninguna necesita compilar:
 *
 *  1. **Referencias entre proyectos** — se leen del `.csproj` que ya parsea el IDE. Es la
 *     comprobación más valiosa: una referencia prohibida en el `.csproj` condena a todo el
 *     proyecto, no a un archivo.
 *  2. **`using` en un archivo** — un archivo del dominio que importa el espacio de nombres de
 *     infraestructura está mal aunque el `.csproj` todavía no lo declare (pasa a mitad de un
 *     refactor, y es justo cuando avisar sirve de algo).
 *  3. **Paquetes NuGet del núcleo** — EF Core o ASP.NET Core dentro de `.Domain` es la forma más
 *     común de romper una arquitectura por capas sin darse cuenta.
 *
 * **Por qué no se usa el LSP.** Los mismos motivos que en las lentes de código (ADR-027): esto
 * tiene que funcionar mientras se escribe, con el servidor arrancando o apagado. Y sobre todo, la
 * regla que se comprueba no es de C#: Roslyn no sabe que `Acme.Shop.Domain` no puede ver
 * `Acme.Shop.Infrastructure`, porque compilar, compila.
 *
 * Todo es función pura sobre el modelo de la solución y el texto de los archivos.
 */
import type { ProjectInfo, SolutionInfo } from './contracts.js';
import type { AiArchitecture } from './ai.js';
import { detectArchitecture } from './ai-context.js';

// ---------------------------------------------------------------------------------------------
// Capas
// ---------------------------------------------------------------------------------------------

export type Layer =
  | 'shared-kernel'
  | 'domain'
  | 'ports'
  | 'application'
  | 'infrastructure'
  | 'adapters'
  | 'presentation'
  | 'tests'
  | 'unknown';

export const LAYER_LABEL: Record<Layer, string> = {
  'shared-kernel': 'Shared Kernel',
  domain: 'Dominio',
  ports: 'Puertos',
  application: 'Aplicación',
  infrastructure: 'Infraestructura',
  adapters: 'Adaptadores',
  presentation: 'Presentación',
  tests: 'Pruebas',
  unknown: 'Sin clasificar',
};

/**
 * Capa de un proyecto, deducida de su nombre.
 *
 * El orden importa: `Acme.Shop.Adapters.Persistence` contiene `.Adapters.` y también acaba en algo
 * que suena a infraestructura, así que los adaptadores se comprueban antes. Y las pruebas van las
 * primeras porque `Acme.Shop.Domain.UnitTests` es un proyecto de pruebas, no de dominio.
 */
const LAYER_PATTERNS: ReadonlyArray<{ match: RegExp; layer: Layer }> = [
  { match: /(?:tests|test|specs)$/i, layer: 'tests' },
  { match: /\.sharedkernel$|\.shared-kernel$|\.kernel$/i, layer: 'shared-kernel' },
  { match: /\.adapters?(?:\.|$)/i, layer: 'adapters' },
  { match: /\.ports?$/i, layer: 'ports' },
  { match: /\.domain$|\.core$/i, layer: 'domain' },
  { match: /\.application$|\.app$|\.usecases$/i, layer: 'application' },
  { match: /\.infrastructure$|\.infra$|\.persistence$/i, layer: 'infrastructure' },
  { match: /\.webapi$|\.api$|\.web$|\.blazor$|\.wasm$|\.mvc$|\.ui$|\.console$|\.host$/i, layer: 'presentation' },
];

export function layerOfProject(projectName: string): Layer {
  for (const pattern of LAYER_PATTERNS) {
    if (pattern.match.test(projectName)) return pattern.layer;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Reglas de dependencia
// ---------------------------------------------------------------------------------------------

/**
 * Qué puede ver cada capa, por arquitectura.
 *
 * Se declara lo **permitido**, no lo prohibido: una capa nueva que nadie ha clasificado no debe
 * heredar por accidente los permisos de otra. Lo que no está en la lista, y no es `unknown`, se
 * denuncia.
 *
 * `presentation` ve infraestructura a propósito en las tres arquitecturas: es la raíz de
 * composición, el único sitio donde se conocen todas las implementaciones para registrarlas en el
 * contenedor de dependencias. Prohibírselo obligaría a inventar un proyecto de arranque extra.
 */
const ALLOWED: Record<Exclude<AiArchitecture, 'unknown'>, Partial<Record<Layer, readonly Layer[]>>> = {
  clean: {
    'shared-kernel': [],
    domain: ['shared-kernel'],
    application: ['domain', 'shared-kernel'],
    infrastructure: ['domain', 'application', 'shared-kernel'],
    presentation: ['domain', 'application', 'infrastructure', 'shared-kernel'],
  },
  hexagonal: {
    'shared-kernel': [],
    domain: ['shared-kernel'],
    ports: ['domain', 'shared-kernel'],
    application: ['domain', 'ports', 'shared-kernel'],
    adapters: ['domain', 'ports', 'application', 'shared-kernel'],
    infrastructure: ['domain', 'ports', 'application', 'shared-kernel'],
    presentation: ['domain', 'ports', 'application', 'adapters', 'shared-kernel'],
  },
  ddd: {
    'shared-kernel': [],
    domain: ['shared-kernel'],
    application: ['domain', 'shared-kernel'],
    infrastructure: ['domain', 'application', 'shared-kernel'],
    presentation: ['domain', 'application', 'infrastructure', 'shared-kernel'],
  },
};

/**
 * ¿Puede `from` depender de `to`?
 *
 * Se responde `true` ante la duda —capa sin clasificar, arquitectura desconocida, proyecto de
 * pruebas— porque un linter que denuncia lo que no entiende se desactiva el primer día.
 */
export function isDependencyAllowed(architecture: AiArchitecture, from: Layer, to: Layer): boolean {
  if (architecture === 'unknown') return true;
  if (from === 'unknown' || to === 'unknown' || from === 'tests') return true;
  if (from === to) return true;

  const allowed = ALLOWED[architecture][from];
  return allowed === undefined ? true : allowed.includes(to);
}

// ---------------------------------------------------------------------------------------------
// Paquetes prohibidos en el núcleo
// ---------------------------------------------------------------------------------------------

/**
 * Paquetes que no pueden entrar en el dominio ni en los puertos.
 *
 * Se comparan por prefijo y en minúsculas. La lista es corta y concreta a propósito: son las
 * dependencias que arrastran un modelo de persistencia o de transporte al núcleo. Un paquete de
 * utilidad (`FluentValidation`, `Ardalis.GuardClauses`) no está aquí, porque no lo hace.
 */
const INFRASTRUCTURE_PACKAGES: readonly string[] = [
  'microsoft.entityframeworkcore',
  'microsoft.aspnetcore',
  'microsoft.extensions.hosting',
  'swashbuckle',
  'scalar.aspnetcore',
  'serilog.aspnetcore',
  'npgsql',
  'pomelo.entityframeworkcore',
  'mongodb.driver',
  'stackexchange.redis',
  'rabbitmq.client',
  'dapper',
  'automapper.extensions.microsoft.dependencyinjection',
];

/** Capas cuyo contenido debe poder compilarse sin conocer ninguna tecnología concreta. */
const PURE_LAYERS: ReadonlySet<Layer> = new Set<Layer>(['domain', 'ports', 'shared-kernel']);

export function isInfrastructurePackage(packageId: string): boolean {
  const id = packageId.toLowerCase();
  return INFRASTRUCTURE_PACKAGES.some((prefix) => id === prefix || id.startsWith(`${prefix}.`));
}

// ---------------------------------------------------------------------------------------------
// Violaciones
// ---------------------------------------------------------------------------------------------

export type ViolationCode = 'DF1001' | 'DF1002' | 'DF1003';

export interface ArchitectureViolation {
  code: ViolationCode;
  /** Mensaje listo para el panel de problemas. */
  message: string;
  /** Proyecto que incumple la regla. */
  project: string;
  /** Archivo donde se ve el incumplimiento: el `.csproj` o el `.cs`. */
  file: string;
  line: number;
  column: number;
  severity: 'warning' | 'error';
  from: Layer;
  to: Layer;
}

function describe(from: Layer, to: Layer): string {
  return `${LAYER_LABEL[from]} no puede depender de ${LAYER_LABEL[to]}`;
}

/**
 * Referencias de proyecto que rompen la regla de dependencia.
 *
 * La línea es siempre 1: el `.csproj` no viene con posiciones y abrirlo por arriba es suficiente
 * para encontrar el `<ProjectReference>` que sobra.
 */
export function checkProjectReferences(solution: SolutionInfo | null): ArchitectureViolation[] {
  if (!solution) return [];

  const architecture = detectArchitecture(solution);
  if (architecture === 'unknown') return [];

  const layers = new Map(solution.projects.map((project) => [project.name, layerOfProject(project.name)]));
  const violations: ArchitectureViolation[] = [];

  for (const project of solution.projects) {
    const from = layers.get(project.name) ?? 'unknown';

    for (const reference of project.projectReferences) {
      const to = layers.get(reference.name) ?? layerOfProject(reference.name);
      if (isDependencyAllowed(architecture, from, to)) continue;

      violations.push({
        code: 'DF1001',
        message:
          `${project.name} referencia a ${reference.name}: ${describe(from, to)} ` +
          `en una arquitectura ${architectureLabelOf(architecture)}.`,
        project: project.name,
        file: project.path,
        line: 1,
        column: 1,
        severity: 'warning',
        from,
        to,
      });
    }
  }

  return violations;
}

/** Paquetes de infraestructura declarados en una capa que debe permanecer pura. */
export function checkPackages(solution: SolutionInfo | null): ArchitectureViolation[] {
  if (!solution) return [];

  const architecture = detectArchitecture(solution);
  if (architecture === 'unknown') return [];

  const violations: ArchitectureViolation[] = [];

  for (const project of solution.projects) {
    const layer = layerOfProject(project.name);
    if (!PURE_LAYERS.has(layer)) continue;

    for (const reference of project.packageReferences) {
      if (!isInfrastructurePackage(reference.id)) continue;

      violations.push({
        code: 'DF1003',
        message:
          `${project.name} referencia el paquete ${reference.id}: la capa ${LAYER_LABEL[layer]} ` +
          'no puede conocer una tecnología de infraestructura.',
        project: project.name,
        file: project.path,
        line: 1,
        column: 1,
        severity: 'warning',
        from: layer,
        to: 'infrastructure',
      });
    }
  }

  return violations;
}

/** Espacios de nombres importados por un archivo de C#, con su línea (base 1). */
export function readUsings(source: string): Array<{ namespace: string; line: number }> {
  const usings: Array<{ namespace: string; line: number }> = [];

  source.split(/\r?\n/).forEach((text, index) => {
    // `global using`, `using static` y los alias entran igual: todos crean la dependencia.
    const match = /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/.exec(text);
    if (match) usings.push({ namespace: match[1]!, line: index + 1 });
  });

  return usings;
}

/** Proyecto al que pertenece un archivo: el de directorio más largo que lo contiene. */
export function projectOfFile(solution: SolutionInfo | null, filePath: string): ProjectInfo | null {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();

  let best: ProjectInfo | null = null;
  for (const project of solution?.projects ?? []) {
    const directory = `${project.directory.replace(/\\/g, '/').toLowerCase()}/`;
    if (!normalized.startsWith(directory)) continue;
    if (best === null || project.directory.length > best.directory.length) best = project;
  }

  return best;
}

/**
 * `using` que importan una capa prohibida.
 *
 * El espacio de nombres se atribuye a un proyecto por prefijo: `Acme.Shop.Infrastructure.Persistence`
 * pertenece a `Acme.Shop.Infrastructure`. Es exactamente la convención que sigue el SDK de .NET
 * (`RootNamespace` = nombre del proyecto) y la que generan las tres plantillas del IDE. Un archivo
 * cuyo proyecto no se puede determinar no produce ningún aviso.
 */
export function checkUsings(
  solution: SolutionInfo | null,
  filePath: string,
  source: string,
): ArchitectureViolation[] {
  if (!solution) return [];

  const architecture = detectArchitecture(solution);
  if (architecture === 'unknown') return [];

  const owner = projectOfFile(solution, filePath);
  if (!owner) return [];

  const from = layerOfProject(owner.name);
  const violations: ArchitectureViolation[] = [];

  for (const using of readUsings(source)) {
    // El proyecto cuyo nombre es el prefijo más largo del espacio de nombres importado.
    const target = solution.projects
      .filter((project) => project.name !== owner.name)
      .filter((project) => using.namespace === project.name || using.namespace.startsWith(`${project.name}.`))
      .sort((a, b) => b.name.length - a.name.length)[0];

    if (!target) continue;

    const to = layerOfProject(target.name);
    if (isDependencyAllowed(architecture, from, to)) continue;

    violations.push({
      code: 'DF1002',
      message: `using ${using.namespace}: ${describe(from, to)}.`,
      project: owner.name,
      file: filePath,
      line: using.line,
      column: 1,
      severity: 'warning',
      from,
      to,
    });
  }

  return violations;
}

/** Todas las violaciones de la solución (referencias y paquetes), ordenadas por proyecto. */
export function checkSolution(solution: SolutionInfo | null): ArchitectureViolation[] {
  return [...checkProjectReferences(solution), ...checkPackages(solution)].sort((a, b) =>
    a.project.localeCompare(b.project),
  );
}

function architectureLabelOf(architecture: AiArchitecture): string {
  const labels: Record<AiArchitecture, string> = {
    clean: 'Clean',
    hexagonal: 'Hexagonal',
    ddd: 'DDD + CQRS',
    unknown: 'sin clasificar',
  };
  return labels[architecture];
}
