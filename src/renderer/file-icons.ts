/**
 * Asignación de icono y color a archivos, carpetas y proyectos, y motor de anidamiento.
 *
 * Dos ideas guían este módulo:
 *
 *  1. **Reconocer, no decorar.** Un `.razor` lleva una arroba, un `.cs` una almohadilla, una
 *     carpeta `Controllers` lleva un icono de rutas. El icono tiene que decir algo que el nombre
 *     no dice ya de un vistazo.
 *  2. **Menos filas.** El anidamiento mete los archivos satélite (`Home.razor.css`,
 *     `appsettings.Development.json`) bajo su archivo principal. En una solución DDD eso quita
 *     decenas de filas del árbol sin esconder nada.
 */
import type { FileNode, ProjectKind } from '../shared/contracts.js';
import type { IconName } from './icons.js';

/** Tono de color; se traduce a una clase CSS `tone-*` definida en el tema. */
export type Tone =
  | 'csharp'
  | 'razor'
  | 'project'
  | 'config'
  | 'markup'
  | 'style'
  | 'docs'
  | 'asset'
  | 'test'
  | 'muted';

export interface IconSpec {
  name: IconName;
  tone: Tone;
}

// ---------------------------------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------------------------------

const BY_EXACT_NAME: Record<string, IconSpec> = {
  'appsettings.json': { name: 'sliders', tone: 'config' },
  'launchsettings.json': { name: 'play', tone: 'config' },
  'directory.build.props': { name: 'sliders', tone: 'project' },
  'directory.packages.props': { name: 'package', tone: 'project' },
  'global.json': { name: 'sliders', tone: 'project' },
  'nuget.config': { name: 'package', tone: 'project' },
  'dotforge.json': { name: 'wand', tone: 'project' },
  'package.json': { name: 'package', tone: 'config' },
  'package-lock.json': { name: 'package', tone: 'muted' },
  '.gitignore': { name: 'git-branch', tone: 'muted' },
  '.gitattributes': { name: 'git-branch', tone: 'muted' },
  '.editorconfig': { name: 'sliders', tone: 'muted' },
  dockerfile: { name: 'package', tone: 'asset' },
  'readme.md': { name: 'markdown', tone: 'docs' },
};

const BY_EXTENSION: Record<string, IconSpec> = {
  '.cs': { name: 'csharp', tone: 'csharp' },
  '.csx': { name: 'csharp', tone: 'csharp' },
  '.razor': { name: 'razor', tone: 'razor' },
  '.cshtml': { name: 'razor', tone: 'razor' },
  '.sln': { name: 'solution', tone: 'project' },
  '.slnx': { name: 'solution', tone: 'project' },
  '.csproj': { name: 'project', tone: 'project' },
  '.fsproj': { name: 'project', tone: 'project' },
  '.props': { name: 'sliders', tone: 'project' },
  '.targets': { name: 'sliders', tone: 'project' },
  '.json': { name: 'braces', tone: 'config' },
  '.jsonc': { name: 'braces', tone: 'config' },
  '.xml': { name: 'code', tone: 'markup' },
  '.config': { name: 'code', tone: 'markup' },
  '.resx': { name: 'code', tone: 'markup' },
  '.html': { name: 'code', tone: 'markup' },
  '.htm': { name: 'code', tone: 'markup' },
  '.css': { name: 'hash', tone: 'style' },
  '.scss': { name: 'hash', tone: 'style' },
  '.md': { name: 'markdown', tone: 'docs' },
  '.markdown': { name: 'markdown', tone: 'docs' },
  '.txt': { name: 'file', tone: 'muted' },
  '.yml': { name: 'list', tone: 'config' },
  '.yaml': { name: 'list', tone: 'config' },
  '.js': { name: 'code', tone: 'config' },
  '.mjs': { name: 'code', tone: 'config' },
  '.ts': { name: 'code', tone: 'config' },
  '.sql': { name: 'database', tone: 'asset' },
  '.db': { name: 'database', tone: 'muted' },
  '.png': { name: 'image', tone: 'asset' },
  '.jpg': { name: 'image', tone: 'asset' },
  '.jpeg': { name: 'image', tone: 'asset' },
  '.svg': { name: 'image', tone: 'asset' },
  '.ico': { name: 'image', tone: 'asset' },
  '.sh': { name: 'terminal', tone: 'muted' },
  '.ps1': { name: 'terminal', tone: 'muted' },
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function iconForFile(fileName: string): IconSpec {
  const lower = fileName.toLowerCase();

  const exact = BY_EXACT_NAME[lower];
  if (exact) return exact;

  // Los `appsettings.<Entorno>.json` heredan el icono del principal.
  if (/^appsettings\..+\.json$/.test(lower)) return { name: 'sliders', tone: 'config' };

  return BY_EXTENSION[extensionOf(lower)] ?? { name: 'file', tone: 'muted' };
}

// ---------------------------------------------------------------------------------------------
// Carpetas
// ---------------------------------------------------------------------------------------------

/**
 * Carpetas con significado en el ecosistema .NET.
 *
 * La clave se compara en minúsculas y también contra el último segmento, para que
 * `Features/Products/Commands` reconozca `Commands`.
 */
const BY_FOLDER_NAME: Record<string, IconSpec> = {
  controllers: { name: 'route', tone: 'razor' },
  endpoints: { name: 'route', tone: 'razor' },
  routes: { name: 'route', tone: 'razor' },
  api: { name: 'route', tone: 'razor' },

  models: { name: 'database', tone: 'csharp' },
  entities: { name: 'database', tone: 'csharp' },
  data: { name: 'database', tone: 'csharp' },
  persistence: { name: 'database', tone: 'csharp' },
  repositories: { name: 'database', tone: 'csharp' },
  migrations: { name: 'history', tone: 'config' },

  services: { name: 'tool', tone: 'config' },
  handlers: { name: 'tool', tone: 'config' },
  behaviors: { name: 'tool', tone: 'config' },
  dispatching: { name: 'exchange', tone: 'config' },

  pages: { name: 'pages', tone: 'razor' },
  views: { name: 'pages', tone: 'razor' },
  components: { name: 'puzzle', tone: 'razor' },
  layout: { name: 'puzzle', tone: 'razor' },
  shared: { name: 'puzzle', tone: 'razor' },

  wwwroot: { name: 'globe', tone: 'asset' },
  'static': { name: 'globe', tone: 'asset' },
  assets: { name: 'image', tone: 'asset' },
  properties: { name: 'sliders', tone: 'muted' },

  domain: { name: 'hexagon', tone: 'project' },
  sharedkernel: { name: 'package', tone: 'project' },
  application: { name: 'solution', tone: 'project' },
  infrastructure: { name: 'database', tone: 'project' },

  ports: { name: 'plug', tone: 'project' },
  adapters: { name: 'plug', tone: 'project' },
  inbound: { name: 'plug', tone: 'project' },
  outbound: { name: 'plug', tone: 'project' },

  commands: { name: 'exchange', tone: 'config' },
  queries: { name: 'exchange', tone: 'config' },
  events: { name: 'zap', tone: 'config' },
  eventhandlers: { name: 'zap', tone: 'config' },
  valueobjects: { name: 'hexagon', tone: 'csharp' },
  abstractions: { name: 'plug', tone: 'csharp' },
  interfaces: { name: 'plug', tone: 'csharp' },
  common: { name: 'package', tone: 'muted' },

  tests: { name: 'flask', tone: 'test' },
  test: { name: 'flask', tone: 'test' },
  fakes: { name: 'flask', tone: 'test' },
  mocks: { name: 'flask', tone: 'test' },
  fixtures: { name: 'flask', tone: 'test' },

  src: { name: 'folder', tone: 'muted' },
  docs: { name: 'markdown', tone: 'docs' },
  scripts: { name: 'terminal', tone: 'muted' },
};

export function iconForFolder(folderName: string, open: boolean): IconSpec {
  const known = BY_FOLDER_NAME[folderName.toLowerCase()];

  // Una carpeta con significado conserva su icono abierta o cerrada: cambiarlo la haría
  // irreconocible justo cuando el usuario está dentro de ella.
  if (known && known.name !== 'folder') return known;

  return { name: open ? 'folder-open' : 'folder', tone: known?.tone ?? 'muted' };
}

// ---------------------------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------------------------

export interface ProjectPresentation {
  icon: IconName;
  tone: Tone;
  /** Texto de la insignia. Corto: compite por espacio con el nombre del proyecto. */
  badge: string;
  /** Descripción larga para el tooltip. */
  description: string;
}

const PROJECT_PRESENTATION: Record<ProjectKind, ProjectPresentation> = {
  'blazor-server': {
    icon: 'razor',
    tone: 'razor',
    badge: 'Blazor',
    description: 'Aplicación Blazor con render interactivo en servidor',
  },
  'blazor-wasm': {
    icon: 'razor',
    tone: 'razor',
    badge: 'WASM',
    description: 'Aplicación Blazor WebAssembly',
  },
  'razor-library': {
    icon: 'puzzle',
    tone: 'razor',
    badge: 'RCL',
    description: 'Biblioteca de componentes Razor',
  },
  webapi: {
    icon: 'route',
    tone: 'project',
    badge: 'Web API',
    description: 'API HTTP con ASP.NET Core',
  },
  worker: {
    icon: 'history',
    tone: 'config',
    badge: 'Job',
    description: 'Servicio en segundo plano',
  },
  console: {
    icon: 'terminal',
    tone: 'config',
    badge: 'CLI',
    description: 'Aplicación de consola',
  },
  library: {
    icon: 'project',
    tone: 'csharp',
    badge: 'Lib',
    description: 'Biblioteca de clases',
  },
  tests: {
    icon: 'flask',
    tone: 'test',
    badge: 'Tests',
    description: 'Proyecto de pruebas',
  },
};

export function presentProject(kind: ProjectKind): ProjectPresentation {
  return PROJECT_PRESENTATION[kind] ?? PROJECT_PRESENTATION.library;
}

// ---------------------------------------------------------------------------------------------
// Anidamiento de archivos
// ---------------------------------------------------------------------------------------------

/**
 * Devuelve los nombres de archivo que podrían ser el "padre" de este.
 *
 * Se devuelven candidatos en orden de preferencia; se anida bajo el primero que exista como
 * hermano. Si no existe ninguno, el archivo se queda en la raíz de su carpeta: el anidamiento
 * nunca puede hacer que un archivo desaparezca del árbol.
 */
export function nestingParentsOf(fileName: string): string[] {
  const lower = fileName.toLowerCase();

  // Blazor: Home.razor.cs y Home.razor.css cuelgan de Home.razor
  const razorSatellite = /^(.*\.razor)\.(cs|css|js)$/i.exec(fileName);
  if (razorSatellite) return [razorSatellite[1]!];

  // MVC clásico: Index.cshtml.cs cuelga de Index.cshtml
  const cshtmlSatellite = /^(.*\.cshtml)\.(cs|css)$/i.exec(fileName);
  if (cshtmlSatellite) return [cshtmlSatellite[1]!];

  // Entornos: appsettings.Development.json cuelga de appsettings.json
  if (/^appsettings\..+\.json$/i.test(lower) && lower !== 'appsettings.json') {
    return ['appsettings.json'];
  }

  // web.Release.config cuelga de web.config
  const configTransform = /^(.+)\.(debug|release|development|staging|production)\.config$/i.exec(fileName);
  if (configTransform) return [`${configTransform[1]}.config`];

  // Código generado: Form.Designer.cs, Model.g.cs, Resource.generated.cs
  const generated = /^(.*)\.(designer|g|generated)\.cs$/i.exec(fileName);
  if (generated) return [`${generated[1]}.cs`, `${generated[1]}.resx`];

  // Proyecto: App.csproj.user cuelga de App.csproj
  const projectUser = /^(.*\.(?:cs|fs|vb)proj)\.user$/i.exec(fileName);
  if (projectUser) return [projectUser[1]!];

  // Build: Directory.Build.targets y Directory.Packages.props cuelgan de Directory.Build.props
  if (lower === 'directory.build.targets' || lower === 'directory.packages.props') {
    return ['Directory.Build.props'];
  }

  // npm
  if (lower === 'package-lock.json' || lower === 'npm-shrinkwrap.json') return ['package.json'];

  // TypeScript / minificados
  const tsOutput = /^(.*)\.(js|js\.map|d\.ts)$/i.exec(fileName);
  if (tsOutput) return [`${tsOutput[1]}.ts`];

  const minified = /^(.*)\.min\.(css|js)$/i.exec(fileName);
  if (minified) return [`${minified[1]}.${minified[2]}`];

  return [];
}

export interface NestedNode {
  node: FileNode;
  /** Archivos satélite agrupados bajo este. Vacío en la inmensa mayoría de los casos. */
  children: FileNode[];
}

/**
 * Agrupa los archivos satélite bajo su archivo principal.
 *
 * Los directorios nunca se anidan. El orden de entrada (carpetas primero, luego alfabético) se
 * respeta; los hijos van ordenados por nombre.
 */
export function nestFiles(nodes: FileNode[]): NestedNode[] {
  const byName = new Map<string, FileNode>();
  for (const node of nodes) {
    if (node.kind === 'file') byName.set(node.name.toLowerCase(), node);
  }

  const childrenOf = new Map<string, FileNode[]>();
  const nested = new Set<string>();

  for (const node of nodes) {
    if (node.kind !== 'file') continue;

    for (const candidate of nestingParentsOf(node.name)) {
      const parent = byName.get(candidate.toLowerCase());

      // Un archivo no puede colgar de sí mismo ni de otro que ya está anidado: eso produciría
      // cadenas y filas huérfanas.
      if (!parent || parent.path === node.path) continue;

      const bucket = childrenOf.get(parent.path) ?? [];
      bucket.push(node);
      childrenOf.set(parent.path, bucket);
      nested.add(node.path);
      break;
    }
  }

  const result: NestedNode[] = [];
  for (const node of nodes) {
    if (nested.has(node.path)) continue;

    const children = (childrenOf.get(node.path) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name, 'es', { numeric: true }),
    );

    result.push({ node, children });
  }

  return result;
}
