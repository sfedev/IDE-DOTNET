/**
 * Modelo de los perfiles de inicio: qué proyecto (o proyectos) arranca el botón de Play.
 *
 * Es lógica pura y sin dependencias: la consumen el proceso principal (para persistirla), el
 * renderer (para pintar el selector de la barra superior) y las pruebas (con Node puro). Nada de
 * `electron`, nada de `node:*`.
 *
 * Vocabulario:
 *  - **proyecto ejecutable**: el que tiene sentido arrancar (`OutputType=Exe`, Web o Blazor), que
 *    no es de pruebas.
 *  - **perfil**: una lista ordenada de proyectos ejecutables con un nombre ("Backend + Web").
 *  - **modo**: cómo se arrancan, con depurador o sin él.
 */
import type { ProjectInfo, SolutionInfo } from './contracts.js';

/** Con depurador (F5) o sin él (Ctrl+F5). */
export type RunMode = 'debug' | 'run';

export interface StartupProfile {
  /** Estable: `project:<ruta>` para los implícitos, `custom:<n>` para los que crea el usuario. */
  id: string;
  name: string;
  /** Rutas absolutas de `.csproj`, **en orden de arranque**. */
  projects: string[];
  /** Los perfiles de un solo proyecto se derivan de la solución y no se persisten. */
  implicit: boolean;
}

export interface StartupConfig {
  /** Sólo los perfiles multiproyecto creados por el usuario. */
  profiles: StartupProfile[];
  activeProfileId: string | null;
  mode: RunMode;
}

export const DEFAULT_STARTUP_CONFIG: StartupConfig = {
  profiles: [],
  activeProfileId: null,
  mode: 'debug',
};

/** Qué hace el orquestador con un proyecto concreto de un perfil. */
export type LaunchAction = 'debug' | 'watch' | 'run';

export interface LaunchStep {
  projectPath: string;
  projectName: string;
  action: LaunchAction;
}

/**
 * ¿Tiene sentido pulsar Play sobre este proyecto?
 *
 * Un proyecto de pruebas se ejecuta con `dotnet test`, no arrancándolo, así que queda fuera
 * aunque su SDK sea ejecutable. Una biblioteca de clases no arranca en absoluto.
 */
export function isRunnableProject(project: ProjectInfo): boolean {
  if (project.isTestProject) return false;
  if (project.isWebProject) return true;
  return project.outputType?.toLowerCase() === 'exe';
}

/** Proyectos ejecutables de la solución, en el orden en que los declara el `.sln`. */
export function runnableProjects(solution: SolutionInfo | null): ProjectInfo[] {
  if (!solution) return [];
  return solution.projects.filter(isRunnableProject);
}

/**
 * Nombre corto para la barra superior: `Acme.Shop.Adapters.Web` -> `Adapters.Web`.
 * El prefijo de la solución se repite en todos los proyectos y no distingue nada.
 */
export function shortProjectName(projectName: string, solutionName: string | null): string {
  if (!solutionName) return projectName;
  const prefix = `${solutionName}.`;
  return projectName.startsWith(prefix) && projectName.length > prefix.length
    ? projectName.slice(prefix.length)
    : projectName;
}

/** Perfil implícito de un único proyecto. No se persiste: se deriva de la solución. */
export function implicitProfile(project: ProjectInfo): StartupProfile {
  return { id: `project:${project.path}`, name: project.name, projects: [project.path], implicit: true };
}

/**
 * Todos los perfiles elegibles: uno implícito por proyecto ejecutable, más los que haya guardado
 * el usuario. Los guardados van primero: si alguien se ha molestado en definir "Backend + Web",
 * es lo que va a querer arrancar.
 */
export function availableProfiles(config: StartupConfig, solution: SolutionInfo | null): StartupProfile[] {
  return [...config.profiles, ...runnableProjects(solution).map(implicitProfile)];
}

/**
 * Perfil activo. Si el guardado ya no existe —se renombró un proyecto, se cambió de solución—
 * se cae al primer proyecto ejecutable en vez de dejar el botón de Play sin destino.
 */
export function resolveActiveProfile(config: StartupConfig, solution: SolutionInfo | null): StartupProfile | null {
  const profiles = availableProfiles(config, solution);
  if (profiles.length === 0) return null;

  const active = profiles.find((profile) => profile.id === config.activeProfileId);
  if (active) return active;

  // Preferir un proyecto web: en una solución con API y biblioteca de consola, lo que se arranca
  // casi siempre es la web.
  const runnable = runnableProjects(solution);
  const web = runnable.find((project) => project.isWebProject);
  if (web) return implicitProfile(web);

  return profiles[0] ?? null;
}

/**
 * Traduce un perfil a la secuencia concreta de arranques.
 *
 * Reglas (ADR-012 y ADR-013 del devlog):
 *  - En modo depuración sólo el **primer** proyecto del perfil se engancha al depurador; el resto
 *    arranca sin él. Hay una única sesión de NetCoreDbg.
 *  - Sin depurador, los proyectos web arrancan con `dotnet watch` (Hot Reload) y el resto con
 *    `dotnet run`: recargar en caliente una consola no aporta nada y complica la salida.
 */
export function launchPlan(
  profile: StartupProfile | null,
  solution: SolutionInfo | null,
  mode: RunMode,
): LaunchStep[] {
  if (!profile) return [];

  const byPath = new Map((solution?.projects ?? []).map((project) => [project.path, project]));
  const steps: LaunchStep[] = [];

  for (const projectPath of profile.projects) {
    const project = byPath.get(projectPath);
    if (!project) continue; // Proyecto desaparecido: se ignora en vez de romper el arranque entero.

    const isFirst = steps.length === 0;
    const action: LaunchAction =
      mode === 'debug' ? (isFirst ? 'debug' : 'run') : project.isWebProject ? 'watch' : 'run';

    steps.push({ projectPath, projectName: project.name, action });
  }

  return steps;
}

/** Nombre propuesto para un perfil nuevo: "Adapters.Web + Adapters.Blazor". */
export function suggestProfileName(projects: ProjectInfo[], solutionName: string | null): string {
  if (projects.length === 0) return 'Perfil sin proyectos';
  return projects.map((project) => shortProjectName(project.name, solutionName)).join(' + ');
}

/** Identificador único para un perfil nuevo, sin depender de la hora ni del azar. */
export function nextProfileId(existing: StartupProfile[]): string {
  let index = 1;
  const taken = new Set(existing.map((profile) => profile.id));
  while (taken.has(`custom:${index}`)) index++;
  return `custom:${index}`;
}

/**
 * Valida lo que venga del disco.
 *
 * Un `startup-profiles.json` editado a mano, de otra versión o de una solución que ha cambiado no
 * puede impedir que el IDE arranque: lo inválido se descarta y lo válido se conserva. Si
 * `knownProjects` se pasa, los proyectos que ya no existen se eliminan de cada perfil, y los
 * perfiles que se quedan vacíos desaparecen.
 */
export function coerceStartupConfig(raw: unknown, knownProjects?: readonly string[]): StartupConfig {
  const config: StartupConfig = { ...DEFAULT_STARTUP_CONFIG, profiles: [] };
  if (typeof raw !== 'object' || raw === null) return config;

  const source = raw as Record<string, unknown>;
  const known = knownProjects ? new Set(knownProjects) : null;

  if (source['mode'] === 'debug' || source['mode'] === 'run') config.mode = source['mode'];

  if (Array.isArray(source['profiles'])) {
    for (const entry of source['profiles']) {
      if (typeof entry !== 'object' || entry === null) continue;
      const profile = entry as Record<string, unknown>;

      const id = typeof profile['id'] === 'string' ? profile['id'] : '';
      const name = typeof profile['name'] === 'string' ? profile['name'].trim() : '';
      if (id === '' || name === '') continue;

      const projects = Array.isArray(profile['projects'])
        ? profile['projects']
            .filter((value): value is string => typeof value === 'string' && value !== '')
            .filter((value) => (known ? known.has(value) : true))
        : [];

      if (projects.length === 0) continue;
      if (config.profiles.some((existing) => existing.id === id)) continue;

      config.profiles.push({ id, name, projects, implicit: false });
    }
  }

  if (typeof source['activeProfileId'] === 'string' && source['activeProfileId'] !== '') {
    config.activeProfileId = source['activeProfileId'];
  }

  return config;
}
