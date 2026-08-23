/**
 * Lectura del modelo de solución .NET: `.sln` clásico, `.slnx` moderno y `.csproj` SDK-style.
 *
 * Se parsea a mano en vez de invocar MSBuild porque el explorador tiene que pintarse en
 * milisegundos al abrir una carpeta, y arrancar MSBuild cuesta segundos.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

import type {
  DotForgeManifest,
  PackageReferenceInfo,
  ProjectInfo,
  ProjectReferenceInfo,
  SolutionInfo,
} from '../../shared/contracts.js';

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: true,
});

/** Directorios que nunca interesan al explorar un workspace .NET. */
export const IGNORED_DIRECTORIES = new Set([
  'bin', 'obj', '.git', '.vs', '.vscode', '.idea', 'node_modules', 'TestResults', 'artifacts',
]);

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Normaliza las rutas de proyecto del .sln (siempre con backslash) a rutas del sistema. */
function normalizeProjectPath(solutionDir: string, raw: string): string {
  return resolve(solutionDir, raw.replace(/\\/g, '/'));
}

interface SolutionEntry {
  name: string;
  path: string;
  folder: string | null;
}

/** Parsea un `.sln` clásico: líneas `Project("{tipo}") = "nombre", "ruta", "{guid}"`. */
function parseClassicSolution(content: string, solutionDir: string): SolutionEntry[] {
  const SOLUTION_FOLDER_TYPE = '2150E333-8FDC-42A3-9474-1A3956D46DE8';

  const projects = new Map<string, { name: string; path: string; isFolder: boolean }>();
  const projectLine = /^Project\("\{([0-9A-Fa-f-]+)\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"\{([0-9A-Fa-f-]+)\}"/gm;

  let match: RegExpExecArray | null;
  while ((match = projectLine.exec(content)) !== null) {
    const [, typeGuid, name, path, guid] = match;
    projects.set(guid!.toUpperCase(), {
      name: name!,
      path: path!,
      isFolder: typeGuid!.toUpperCase() === SOLUTION_FOLDER_TYPE,
    });
  }

  // Sección NestedProjects: {proyecto} = {carpeta}
  const nested = new Map<string, string>();
  const nestedSection = /GlobalSection\(NestedProjects\)[^]*?EndGlobalSection/.exec(content);
  if (nestedSection) {
    const pair = /\{([0-9A-Fa-f-]+)\}\s*=\s*\{([0-9A-Fa-f-]+)\}/g;
    let nestedMatch: RegExpExecArray | null;
    while ((nestedMatch = pair.exec(nestedSection[0])) !== null) {
      nested.set(nestedMatch[1]!.toUpperCase(), nestedMatch[2]!.toUpperCase());
    }
  }

  const entries: SolutionEntry[] = [];
  for (const [guid, project] of projects) {
    if (project.isFolder) continue;

    const parentGuid = nested.get(guid);
    const parent = parentGuid ? projects.get(parentGuid) : undefined;

    entries.push({
      name: project.name,
      path: normalizeProjectPath(solutionDir, project.path),
      folder: parent?.isFolder ? parent.name : null,
    });
  }

  return entries;
}

/** Parsea un `.slnx` (formato XML introducido con .NET 9). */
function parseXmlSolution(content: string, solutionDir: string): SolutionEntry[] {
  const parsed = xml.parse(content) as Record<string, unknown>;
  const solution = parsed['Solution'] as Record<string, unknown> | undefined;
  if (!solution) return [];

  const entries: SolutionEntry[] = [];

  const collect = (node: Record<string, unknown>, folder: string | null): void => {
    for (const project of asArray(node['Project'] as Record<string, string> | Record<string, string>[])) {
      const raw = project['@Path'];
      if (!raw) continue;
      const path = normalizeProjectPath(solutionDir, raw);
      entries.push({ name: basename(path, extname(path)), path, folder });
    }

    for (const child of asArray(node['Folder'] as Record<string, unknown> | Record<string, unknown>[])) {
      const name = String(child['@Name'] ?? '').replace(/^\/|\/$/g, '');
      collect(child, name || folder);
    }
  };

  collect(solution, null);
  return entries;
}

/**
 * Propiedades heredadas de `Directory.Build.props`.
 *
 * Las soluciones modernas (las que genera DotForge incluidas) declaran `TargetFramework`,
 * `Nullable` e `ImplicitUsings` una sola vez en la raíz. Sin leer ese archivo, el explorador
 * mostraría todos los proyectos sin framework, que es justo el dato que el usuario busca.
 */
export interface InheritedProperties {
  targetFrameworks: string[];
}

const EMPTY_INHERITED: InheritedProperties = { targetFrameworks: [] };

/** Busca el `Directory.Build.props` más cercano subiendo desde `startDir` hasta `stopDir`. */
export async function readInheritedProperties(startDir: string, stopDir: string): Promise<InheritedProperties> {
  let current = resolve(startDir);
  const stop = resolve(stopDir);

  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(current, 'Directory.Build.props');

    if (existsSync(candidate)) {
      try {
        const parsed = xml.parse(await readFile(candidate, 'utf8')) as Record<string, unknown>;
        const project = (parsed['Project'] ?? {}) as Record<string, unknown>;
        const groups = asArray(project['PropertyGroup'] as Record<string, unknown> | Record<string, unknown>[]);

        for (const group of groups) {
          const single = group['TargetFramework'];
          const multiple = group['TargetFrameworks'];

          if (multiple !== undefined && multiple !== null && multiple !== '') {
            return {
              targetFrameworks: String(multiple).split(';').map((value) => value.trim()).filter(Boolean),
            };
          }
          if (single !== undefined && single !== null && single !== '') {
            return { targetFrameworks: [String(single)] };
          }
        }
      } catch {
        // Un Directory.Build.props ilegible no debe impedir cargar la solución.
        return EMPTY_INHERITED;
      }
    }

    const parent = dirname(current);
    if (parent === current || !isWithin(stop, parent)) break;
    current = parent;
  }

  return EMPTY_INHERITED;
}

/** True si `candidate` es `root` o está por debajo. */
function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

/** Lee un `.csproj` SDK-style y extrae lo que la UI necesita. */
export async function readProject(
  projectPath: string,
  solutionFolder: string | null,
  inherited: InheritedProperties = EMPTY_INHERITED,
): Promise<ProjectInfo> {
  const content = await readFile(projectPath, 'utf8');
  const parsed = xml.parse(content) as Record<string, unknown>;
  const project = (parsed['Project'] ?? {}) as Record<string, unknown>;
  const directory = dirname(projectPath);

  const propertyGroups = asArray(project['PropertyGroup'] as Record<string, unknown> | Record<string, unknown>[]);
  const itemGroups = asArray(project['ItemGroup'] as Record<string, unknown> | Record<string, unknown>[]);

  const property = (name: string): string | null => {
    for (const group of propertyGroups) {
      const value = group[name];
      if (value !== undefined && value !== null && value !== '') return String(value);
    }
    return null;
  };

  const targetFramework = property('TargetFramework');
  const targetFrameworks = property('TargetFrameworks');
  const frameworks = targetFrameworks
    ? targetFrameworks.split(';').map((value) => value.trim()).filter(Boolean)
    : targetFramework
      ? [targetFramework]
      // Sin declaración propia, se hereda de Directory.Build.props.
      : inherited.targetFrameworks;

  const projectReferences: ProjectReferenceInfo[] = [];
  const packageReferences: PackageReferenceInfo[] = [];

  for (const group of itemGroups) {
    for (const reference of asArray(group['ProjectReference'] as Record<string, string> | Record<string, string>[])) {
      const include = reference['@Include'];
      if (!include) continue;
      const referencePath = resolve(directory, include.replace(/\\/g, '/'));
      projectReferences.push({ name: basename(referencePath, extname(referencePath)), path: referencePath });
    }

    for (const reference of asArray(group['PackageReference'] as Record<string, string> | Record<string, string>[])) {
      const include = reference['@Include'];
      if (!include) continue;
      const version = reference['@Version'] ?? (reference['Version'] as string | undefined) ?? null;
      packageReferences.push({ id: include, version, centrallyManaged: version === null });
    }
  }

  const sdk = String(project['@Sdk'] ?? 'Microsoft.NET.Sdk');

  return {
    name: basename(projectPath, extname(projectPath)),
    path: projectPath,
    directory,
    targetFrameworks: frameworks,
    sdk,
    outputType: property('OutputType'),
    isTestProject: property('IsTestProject') === 'true' || /\.(Tests|UnitTests|IntegrationTests)$/i.test(basename(projectPath, extname(projectPath))),
    isWebProject: sdk.includes('Web') || sdk.includes('Razor') || sdk.includes('BlazorWebAssembly'),
    projectReferences,
    packageReferences: packageReferences.sort((a, b) => a.id.localeCompare(b.id)),
    solutionFolder,
  };
}

/** Busca el primer archivo de solución en un directorio. */
export async function findSolutionFile(directory: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /\.slnx?$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    // `.slnx` gana al `.sln` clásico si coexisten: es el formato más reciente.
    .sort((a, b) => (extname(a).toLowerCase() === '.slnx' ? -1 : 1) - (extname(b).toLowerCase() === '.slnx' ? -1 : 1));

  return candidates[0] ?? null;
}

/** Busca `.csproj` recursivamente cuando el workspace no tiene solución. */
async function findProjectFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];

  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...(await findProjectFiles(join(directory, entry.name), depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith('.csproj')) {
      found.push(join(directory, entry.name));
    }
  }

  return found;
}

async function readManifest(directory: string): Promise<DotForgeManifest | null> {
  const manifestPath = join(directory, 'dotforge.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as DotForgeManifest;
  } catch {
    return null;
  }
}

/**
 * Carga el modelo de solución de un directorio de workspace.
 *
 * Nunca lanza por un proyecto ilegible: lo acumula en `warnings` y sigue, para que un `.csproj`
 * corrupto no deje al usuario con un explorador vacío y sin explicación.
 */
export async function loadSolution(workspaceDirectory: string): Promise<SolutionInfo> {
  const directory = resolve(workspaceDirectory);
  const warnings: string[] = [];

  const info = await stat(directory);
  if (!info.isDirectory()) {
    throw new Error(`el workspace debe ser un directorio: ${directory}`);
  }

  const solutionFile = await findSolutionFile(directory);
  let entries: SolutionEntry[] = [];
  let format: SolutionInfo['format'] = 'none';

  if (solutionFile) {
    const content = await readFile(solutionFile, 'utf8');
    if (extname(solutionFile).toLowerCase() === '.slnx') {
      format = 'slnx';
      entries = parseXmlSolution(content, dirname(solutionFile));
    } else {
      format = 'sln';
      entries = parseClassicSolution(content, dirname(solutionFile));
    }
  } else {
    const projectFiles = await findProjectFiles(directory);
    entries = projectFiles.map((path) => ({
      name: basename(path, extname(path)),
      path,
      folder: null,
    }));
  }

  const projects: ProjectInfo[] = [];
  for (const entry of entries) {
    if (!existsSync(entry.path)) {
      warnings.push(`el proyecto "${entry.name}" está declarado en la solución pero falta en disco: ${entry.path}`);
      continue;
    }
    try {
      const inherited = await readInheritedProperties(dirname(entry.path), directory);
      projects.push(await readProject(entry.path, entry.folder, inherited));
    } catch (error) {
      warnings.push(`no se ha podido leer "${entry.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  projects.sort((a, b) => {
    const folderCompare = (a.solutionFolder ?? '').localeCompare(b.solutionFolder ?? '');
    return folderCompare !== 0 ? folderCompare : a.name.localeCompare(b.name);
  });

  return {
    name: solutionFile ? basename(solutionFile, extname(solutionFile)) : basename(directory),
    path: solutionFile,
    directory,
    format,
    projects,
    generatedBy: await readManifest(directory),
    warnings,
  };
}
