/**
 * Contrato IPC entre el proceso principal y el renderer.
 *
 * Es la única superficie por la que el renderer puede pedirle algo al sistema. Todo canal nuevo
 * se declara aquí primero: si no está en este archivo, no existe.
 *
 * Convención de nombres: `dominio:acción`. Los canales `invoke` devuelven una promesa; los
 * canales `event` son notificaciones del main hacia el renderer.
 */
import type {
  AiChatRequest,
  AiProbeResult,
  AiProviderId,
  AiSettings,
  AiStatus,
  AiStreamDelta,
  AiStreamEnd,
} from './ai.js';
import { DEFAULT_AI_SETTINGS } from './ai.js';

// El asistente tiene su propio módulo de modelo, pero su superficie IPC es parte del contrato:
// se reexporta para que preload y los handlers importen de un único sitio.
export type {
  AiChatRequest,
  AiContext,
  AiMessage,
  AiProbeResult,
  AiProviderId,
  AiSettings,
  AiStatus,
  AiStreamDelta,
  AiStreamEnd,
  AiTask,
} from './ai.js';
import type { ArchitectureId, BlueprintInfo, ScaffoldOptions, ScaffoldResult } from './scaffold-types.js';
import type { RunMode, StartupConfig } from './startup.js';
import type { DotnetVerbosity } from './dotnet-verbosity.js';
import { DEFAULT_DOTNET_VERBOSITY } from './dotnet-verbosity.js';

// El orden de la barra de actividad lo personaliza el usuario y se guarda en las preferencias; su
// modelo (identificadores, orden de fábrica y normalización) es puro y vive aparte.
export type { ActivityToolId } from './activity-bar.js';
import type { ActivityToolId } from './activity-bar.js';
import { DEFAULT_ACTIVITY_ORDER } from './activity-bar.js';

// El control de código fuente tiene su propio módulo de modelo (parseo de `git status`, diffs),
// pero su superficie IPC es parte del contrato: se reexporta para que preload, los handlers y el
// renderer importen de un único sitio.
export type {
  GitBranchState,
  GitChangeArea,
  GitChangeLetter,
  GitDiffRequest,
  GitDiffSide,
  GitFileChange,
  GitRepositoryStatus,
  GitSyncSummary,
} from './git.js';
import type { GitDiffRequest, GitRepositoryStatus } from './git.js';
export type { DotnetVerbosity } from './dotnet-verbosity.js';

// La publicación tiene su propio módulo de modelo (banderas que dependen del RID, saneado de la
// ruta de salida), pero sus opciones cruzan el IPC: se reexportan para importar de un único sitio.
export type {
  PublishConfiguration,
  PublishMode,
  PublishOptions,
} from './dotnet-publish.js';
import type { PublishOptions } from './dotnet-publish.js';

// La organización visual de las pestañas también tiene su modelo puro: a qué proyecto pertenece un
// archivo y qué color le toca. Se reexporta para importar de un único sitio.
export type { TabPosition, TabProjectSettings } from './editor-tabs.js';
import type { TabProjectSettings } from './editor-tabs.js';
import { DEFAULT_TAB_SETTINGS } from './editor-tabs.js';

// El gestor de EF Core y el cliente HTTP tienen su propio módulo de modelo (parseo de la salida
// de `dotnet ef`, esquema deducido de las migraciones, formato `.http`), pero su superficie IPC
// es parte del contrato: se reexporta para importar de un único sitio.
export type {
  ConnectionStringInfo,
  EfDbContext,
  EfMigration,
  EfMigrationList,
  EfOperation,
  EfOperationOptions,
  EfTarget,
} from './efcore.js';
export type {
  DatabaseSchema,
  SchemaColumn,
  SchemaIndex,
  SchemaTable,
} from './efcore-schema.js';
export type {
  ComposeAction,
  ComposeFile,
  ComposeService,
  ContainerAction,
} from './compose.js';
export type {
  ContainerState,
  DockerContainer,
  DockerImage,
  PortBinding,
  SupportKind,
} from './docker.js';
export type {
  HttpFileDocument,
  HttpHeader,
  HttpRequestBlock,
  HttpResponseResult,
  ResolvedHttpRequest,
} from './http-file.js';

// Fase 15: explorador de pruebas, túneles, métricas, auditoría de NuGet y tokens semánticos.
// Sus modelos son puros y viven en su propio archivo; su superficie IPC es parte del contrato.
export type {
  TestCase,
  TestFramework,
  TestKind,
  TestResult,
  TestRunSummary,
  TestStatus,
} from './test-explorer.js';
export type { TunnelState, TunnelTool } from './dev-tunnel.js';
export type {
  CounterSample,
  DotnetProcess,
  MetricId,
  MetricsEvent,
  MetricsSnapshot,
  MetricsState,
  MetricsStatus,
} from './perf-counters.js';
export type {
  AuditReport,
  PackageVulnerability,
  VulnerablePackage,
  VulnerabilitySeverity,
} from './nuget-audit.js';
export type { SemanticTokensLegend } from './semantic-tokens.js';

// Fase 17: actualizaciones automáticas y extensiones de Open VSX. Sus modelos son puros y viven
// en su propio archivo; su superficie IPC es parte del contrato.
export type {
  ApplyConfirmation,
  InstallOutcome,
  InstallOutcomeKind,
  InstallPlan,
  InstallPlanKind,
  ReleaseAsset,
  ReleaseInfo,
  SemanticVersion,
  UpdateState,
  UpdateStatus,
} from './updates.js';
export type { MarketplaceExtension, SearchQuery, SearchResult } from './open-vsx.js';
export type { ContributionSummary, InstalledExtension, VsixManifest } from './vsix.js';
export type {
  CodeSnippet,
  ContributedSnippetFile,
  ContributedTheme,
  MonacoThemeData,
  MonacoTokenRule,
} from './vsix-contributions.js';
import type { CodeSnippet, ContributedTheme, MonacoThemeData } from './vsix-contributions.js';

/**
 * Temas y fragmentos de las extensiones instaladas, listos para dárselos a Monaco.
 *
 * La conversión la hace el proceso principal: implica leer varios archivos por tema —un tema puede
 * incluir a otro— y el renderer no toca el disco.
 */
export interface ExtensionContributions {
  themes: Array<{
    id: string;
    label: string;
    extensionId: string;
    uiTheme: ContributedTheme['uiTheme'];
    data: MonacoThemeData;
  }>;
  snippets: CodeSnippet[];
  /** Lo que no se ha podido cargar, con su motivo. Se enseña; no se traga. */
  problems: string[];
}

// Fase 20: búsqueda de texto en el contenido de los archivos. El modelo es puro; su superficie
// IPC es parte del contrato. Los nombres llevan `Search…` de prefijo y no chocan con los de Open
// VSX (`SearchQuery`, `SearchResult`), que son de otra búsqueda: la del registro de extensiones.
export type {
  SearchFileResult,
  SearchMatch,
  SearchOptions,
  SearchProgress,
  SearchSummary,
} from './file-search.js';
import type { SearchOptions, SearchProgress, SearchSummary } from './file-search.js';
import type { EfMigrationList, EfDbContext, EfOperation, EfOperationOptions } from './efcore.js';
import type { DatabaseSchema } from './efcore-schema.js';
import type { HttpResponseResult, ResolvedHttpRequest } from './http-file.js';
import type { ComposeAction, ComposeFile, ContainerAction } from './compose.js';
import type { DockerContainer, DockerImage } from './docker.js';
import type { TestCase, TestRunSummary } from './test-explorer.js';
import type { TunnelTool } from './dev-tunnel.js';
import type { DotnetProcess, MetricsEvent, MetricsState } from './perf-counters.js';
import type { AuditReport } from './nuget-audit.js';
import type { SemanticTokensLegend } from './semantic-tokens.js';
import type { UpdateState } from './updates.js';
import type { MarketplaceExtension, SearchQuery, SearchResult } from './open-vsx.js';
import type { InstalledExtension } from './vsix.js';
import type { ConnectionStringInfo } from './efcore.js';

// ---------------------------------------------------------------------------------------------
// Modelos compartidos
// ---------------------------------------------------------------------------------------------

export interface FileNode {
  name: string;
  /** Ruta absoluta normalizada. */
  path: string;
  kind: 'file' | 'directory';
  /** Sólo en directorios: si ya se han cargado sus hijos. */
  loaded?: boolean;
  children?: FileNode[];
  /** Extensión en minúsculas, con punto. Vacía si no tiene. */
  extension: string;
  sizeBytes?: number;
}

export interface ProjectReferenceInfo {
  name: string;
  path: string;
}

export interface PackageReferenceInfo {
  id: string;
  version: string | null;
  /** true si la versión la fija Directory.Packages.props (gestión centralizada). */
  centrallyManaged: boolean;
}

/**
 * Naturaleza del proyecto, deducida del SDK, el tipo de salida y su contenido.
 * La UI la usa para la insignia y el icono: un desarrollador .NET distingue de un vistazo una
 * Web API de una librería de clases, y el explorador debería hacerlo también.
 */
export type ProjectKind =
  | 'blazor-server'
  | 'blazor-wasm'
  | 'razor-library'
  | 'webapi'
  | 'worker'
  | 'console'
  | 'library'
  | 'tests';

export interface ProjectInfo {
  kind: ProjectKind;
  name: string;
  /** Ruta absoluta del .csproj. */
  path: string;
  directory: string;
  targetFrameworks: string[];
  sdk: string;
  outputType: string | null;
  isTestProject: boolean;
  isWebProject: boolean;
  projectReferences: ProjectReferenceInfo[];
  packageReferences: PackageReferenceInfo[];
  /** Carpeta de solución declarada en el .sln, si la hay. */
  solutionFolder: string | null;
}

export interface SolutionInfo {
  name: string;
  /** Ruta absoluta del .sln o .slnx. Null si el workspace no tiene solución. */
  path: string | null;
  directory: string;
  format: 'sln' | 'slnx' | 'none';
  projects: ProjectInfo[];
  /** Manifiesto dotforge.json, si la solución la generó DotForge. */
  generatedBy: DotForgeManifest | null;
  warnings: string[];
}

/**
 * Entrada del historial de workspaces, con su disponibilidad ya resuelta por el proceso principal.
 * El renderer no puede mirar el disco, así que necesita que se lo digan.
 */
export interface RecentWorkspace {
  path: string;
  /** false si la carpeta ya no existe o no es un directorio: se enseña apagada, no se borra. */
  available: boolean;
}

export interface DotForgeManifest {
  generator: string;
  generatorVersion: string;
  generatedAtUtc: string;
  architecture: ArchitectureId;
  solutionName: string;
  framework: string;
  ui: string;
  database: string;
  entity: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface BuildDiagnostic {
  file: string | null;
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  project: string | null;
}

export type DotnetTaskKind =
  | 'build'
  | 'rebuild'
  | 'clean'
  | 'restore'
  | 'test'
  | 'run'
  | 'watch'
  | 'format'
  | 'publish';

export interface DotnetTaskRequest {
  kind: DotnetTaskKind;
  /** Ruta del .sln o .csproj objetivo. */
  target: string;
  /** Argumentos adicionales, ya troceados (nunca una línea de shell). */
  extraArgs?: string[];
  /**
   * Perfil de `launchSettings.json` con el que arrancar (`run` y `watch`).
   *
   * Si no se indica, lo resuelve el proceso principal leyendo el archivo del proyecto: el
   * renderer no conoce los perfiles y no tiene por qué. Se acepta aquí para poder forzar uno
   * concreto desde la interfaz sin cambiar el canal.
   */
  launchProfile?: string;
  /** Etiqueta del canal de salida. Se devuelve tal cual en `DotnetTaskStarted`. */
  label?: string;
}

export interface DotnetTaskStarted {
  taskId: string;
  kind: DotnetTaskKind;
  command: string;
  target: string;
  /**
   * Nombre legible del canal en el que va la salida: normalmente el del proyecto. Lo pone quien
   * lanza la tarea, porque el proceso principal no sabe si esto es "la API" o "la UI".
   */
  label?: string;
}

export interface DotnetTaskOutput {
  taskId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface DotnetTaskExit {
  taskId: string;
  code: number | null;
  durationMs: number;
  diagnostics: BuildDiagnostic[];
  /** URL detectada en la salida de `dotnet run`/`watch`, si la hay. */
  applicationUrl: string | null;
}

/**
 * Petición de publicación.
 *
 * Sólo cruzan el proyecto y las opciones: los argumentos los compone el proceso principal con
 * `publishArgs`, que es puro y está probado. El renderer no manda una línea de comandos, ni
 * siquiera troceada — es la misma regla que con el prompt del asistente (ADR-016) y con la
 * verbosidad: quien decide lo que se ejecuta es quien puede validarlo.
 */
export interface PublishRequest {
  /** Ruta absoluta del `.csproj`. */
  projectPath: string;
  options: PublishOptions;
  /** Nombre legible para el resumen del panel. Si falta, se usa el del archivo. */
  projectName?: string;
}

/**
 * Publicación en marcha.
 *
 * Trae la carpeta ya resuelta, y eso es deliberado: el mensaje de MSBuild que la anuncia está
 * traducido al idioma del sistema (ADR-028), así que se compone aquí con las mismas reglas con las
 * que el SDK la compone, en vez de rastrearla en la salida.
 */
export interface PublishStarted {
  task: DotnetTaskStarted;
  /** Carpeta que va a contener el resultado. Null si no se ha podido deducir. */
  outputPath: string | null;
  /** Opciones realmente aplicadas, ya saneadas. Es lo que se guarda como "la última vez". */
  options: PublishOptions;
}

export interface NuGetSearchResult {
  id: string;
  version: string;
  description: string;
  authors: string;
  totalDownloads: number;
  verified: boolean;
  projectUrl: string | null;
  licenseUrl: string | null;
  iconUrl: string | null;
  versions: string[];
}

export type LspStatus = 'idle' | 'acquiring' | 'starting' | 'ready' | 'degraded' | 'error';

export interface LspState {
  status: LspStatus;
  /** Nombre del servidor en uso, p. ej. "Roslyn LanguageServer" u "OmniSharp". */
  server: string | null;
  version: string | null;
  message: string | null;
  /** Progreso de descarga 0..1 mientras `status === 'acquiring'`. */
  progress: number | null;
}

export type DebugStatus = 'idle' | 'acquiring' | 'starting' | 'running' | 'paused' | 'error';

export interface DebugState {
  status: DebugStatus;
  message: string | null;
  /** Progreso de descarga 0..1 mientras `status === 'acquiring'`. */
  progress: number | null;
  /** Hilo detenido, necesario para los comandos de paso. */
  threadId: number | null;
  version: string | null;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  file: string | null;
  line: number;
  column: number;
}

export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string | null;
  /** Distinto de 0 si la variable se puede expandir. */
  variablesReference: number;
}

export interface DebugLaunchRequest {
  /** Proyecto a depurar. Debe estar compilado. */
  projectPath: string;
  stopAtEntry: boolean;
  breakpoints: Array<{ file: string; lines: number[] }>;
}

export type DebugAction = 'continue' | 'stepOver' | 'stepIn' | 'stepOut' | 'pause';

export interface EditorDocument {
  path: string;
  content: string;
  /** Id de lenguaje de Monaco. */
  languageId: string;
  encoding: 'utf8';
  readOnly: boolean;
  /** Marca de tiempo de modificación, para detectar cambios externos. */
  mtimeMs: number;
}

export interface GitStatus {
  /** Rama activa, o null si el workspace no es un repositorio. */
  branch: string | null;
  /** Número de archivos con cambios sin confirmar. */
  dirtyFiles: number;
}

/**
 * Resultado de una operación de git que puede tardar o fallar (commit, push, pull, checkout).
 *
 * No se lanza una excepción por un fallo de git: "no hay nada que confirmar" o "el remoto ha
 * rechazado el push" son respuestas normales del sistema, y el panel las enseña tal cual en vez
 * de convertirlas en un error del IDE.
 */
export interface GitCommandResult {
  ok: boolean;
  /** Resumen para la barra de avisos. */
  message: string;
  /** Salida cruda de git (stdout + stderr), para el canal de salida. */
  detail: string;
  /** Estado del repositorio ya refrescado, para no tener que pedirlo otra vez. */
  status: GitRepositoryStatus | null;
}

/** Contenido de los dos lados de una comparación, listo para el editor de diferencias. */
export interface GitFileDiff {
  request: GitDiffRequest;
  original: string;
  modified: string;
  /** Id de lenguaje de Monaco deducido de la extensión. */
  languageId: string;
  /** Ruta absoluta del archivo en el disco, para poder abrirlo desde el diff. */
  absolutePath: string;
}

/**
 * Resultado de una lectura de `dotnet ef`.
 *
 * Igual que en git, un fallo de la CLI no es una excepción del IDE: que falten las herramientas
 * o que la base de datos esté apagada son respuestas normales, y el panel las enseña tal cual.
 */
export interface EfReadResult<T> {
  ok: boolean;
  value: T;
  /** Salida cruda de la CLI, para el canal de salida. */
  detail: string;
  error: string | null;
}

/** Cadenas de conexión encontradas en un `appsettings*.json` del proyecto. */
export interface ConnectionStringFileInfo {
  path: string;
  name: string;
  connections: ConnectionStringInfo[];
}

/**
 * Contexto del autocompletado de la terminal, ya resuelto por el proceso principal.
 *
 * Se devuelve en una sola llamada porque se pide entero cada vez: al abrir la terminal y cada vez
 * que algo puede haber cambiado. Tres consultas separadas por pulsación de tecla serían tres
 * procesos por pulsación.
 */
export interface TerminalContext {
  /** Programas de la lista blanca. */
  programs: string[];
  /** Contenedores de Docker, en ejecución o parados. Vacío si Docker no está disponible. */
  containers: string[];
  /** Imágenes locales (`repositorio:etiqueta`). */
  images: string[];
  /** Scripts del `package.json` del workspace. */
  npmScripts: string[];
  dockerAvailable: boolean;
}

/** Directorio de trabajo de la terminal: la ruta real y cómo se enseña en el prompt. */
export interface TerminalCwd {
  path: string;
  display: string;
}

/**
 * Resultado de mandarle una línea a la terminal.
 *
 * `task` es null cuando la línea no lanza ningún proceso —un `cd`, un `pwd`—, y en ese caso lo que
 * hay que enseñar viene en `output`. Un único canal para las dos cosas: la alternativa era que el
 * renderer decidiera antes de enviar si la línea era un `cd`, y entonces habría dos sitios que
 * saben qué es un cambio de directorio.
 */
export interface TerminalRunResult {
  task: DotnetTaskStarted | null;
  cwd: TerminalCwd;
  output: string[];
  /**
   * Qué era la línea.
   *
   * El renderer sólo mira una: `open-claude`, que no lanza nada y le pide que abra la pestaña de
   * Claude Code. Va como dato y no como evento porque es la respuesta a algo que el renderer acaba
   * de pedir, no una notificación que llegue por su cuenta.
   */
  intent: 'change-directory' | 'print-directory' | 'open-claude' | 'command';
}

/**
 * Perfil de terminal tal y como lo ve el renderer.
 *
 * Lleva su disponibilidad ya resuelta: si `node-pty` no ha podido cargarse, el perfil se sigue
 * ofreciendo pero apagado y con el motivo escrito, igual que las acciones de Docker cuando el
 * motor no está (ADR-033). Un menú que esconde opciones no explica nada; uno que las enseña
 * atenuadas, sí.
 */
export interface TerminalProfileInfo {
  id: string;
  label: string;
  kind: 'pty' | 'lite';
  hint: string;
  available: boolean;
  /** Por qué no está disponible. `null` si lo está. */
  reason: string | null;
}

/** Sesión de pseudoterminal recién abierta. */
export interface TerminalSessionInfo {
  terminalId: string;
  profileId: string;
  /** Intérprete realmente lanzado. */
  file: string;
  pid: number;
  cwd: string;
  /**
   * Aviso a escribir en la pestaña antes de la primera línea del intérprete.
   *
   * Sólo llega cuando el perfil se ha lanzado con una alternativa del catálogo y no con su
   * programa principal, que es un caso que el usuario no tiene forma de adivinar.
   */
  notice?: string;
}

/** Trozo de salida de una sesión de pseudoterminal, con sus secuencias de escape intactas. */
export interface TerminalDataEvent {
  terminalId: string;
  data: string;
}

/** El intérprete de una sesión ha terminado (un `exit`, un cierre, un fallo). */
export interface TerminalExitEvent {
  terminalId: string;
  exitCode: number;
}

/**
 * Disposición de pestañas que el renderer manda para guardar.
 *
 * Sólo perfiles y cuál estaba delante. El directorio **no va aquí**: lo pone el proceso principal
 * desde la sesión de la terminal, igual que al abrir una pestaña (ADR-059).
 */
export interface TerminalLayoutPatch {
  tabs: string[];
  activeIndex: number;
}

/** Lo que hay que volver a abrir al entrar en una solución. */
export interface TerminalLayoutRestore {
  tabs: string[];
  activeIndex: number;
  /** Cuántas pestañas guardadas no se pueden reabrir aquí (sin `node-pty`, por ejemplo). */
  skipped: number;
}

/**
 * Estado del motor de Docker.
 *
 * Que Docker no esté instalado o no esté arrancado es un estado normal, no un error: se devuelve
 * `available: false` con el motivo y el panel lo cuenta en una línea.
 */
export interface DockerEngineState {
  available: boolean;
  reason: string | null;
  containers: DockerContainer[];
  images: DockerImage[];
}

/**
 * Petición de ejecución de pruebas.
 *
 * Un solo canal para los tres casos —una prueba, una clase, todo— porque los tres son lo mismo con
 * distinto filtro. El filtro lo construye el renderer con el modelo puro, y el proceso principal
 * lo valida antes de meterlo en un `argv`.
 */
export interface TestRunRequest {
  /** `.sln` o `.csproj` sobre el que ejecutar. */
  target: string;
  /** Nombres completamente cualificados. Vacío ejecuta todas las pruebas del objetivo. */
  ids?: string[];
  /** Clase entera, como alternativa a la lista de nombres. */
  classId?: string | null;
  /** Etiqueta del canal de salida. */
  label?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Modificador principal para atajos: 'Cmd' en macOS, 'Ctrl' en el resto. */
  primaryModifier: 'Cmd' | 'Ctrl';
  builtAtUtc: string | null;
  dotnetSdks: string[];
  dotnetRuntimes: string[];
}

export interface AppSettings {
  /**
   * Tema activo: uno de los dos propios (`dotforge-dark`, `dotforge-light`) o el de una extensión
   * instalada (`ext:<publisher>.<name>:<etiqueta>`).
   *
   * Es una cadena y no una unión cerrada porque el valor puede venir de una extensión que se
   * instaló después de compilar el IDE. Lo que no se reconoce al arrancar —porque la extensión ya
   * no está— cae al tema oscuro en vez de dejar el editor sin colores.
   */
  theme: string;
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  formatOnSave: boolean;
  autoSave: 'off' | 'afterDelay';
  autoSaveDelayMs: number;
  recentWorkspaces: string[];
  lspEnabled: boolean;
  /**
   * Nivel de detalle de la salida de la CLI de .NET. Gobierna `build`, `run`, `watch`, `test`,
   * `clean`, `restore`, `format` y el entorno del proceso depurado.
   */
  dotnetVerbosity: DotnetVerbosity;
  /**
   * Buscar actualizaciones automáticamente al arrancar.
   *
   * Apagarlo no desactiva el botón "Buscar ahora": deja de preguntar solo, que es lo que molesta
   * en una máquina sin red o detrás de un proxy corporativo.
   */
  autoUpdateCheck: boolean;
  /**
   * Volver a abrir las pestañas de terminal de la solución al abrirla.
   *
   * Existe apagado porque restaurar una terminal es, como mucho, reabrirla **vacía** en el mismo
   * directorio: no vuelve el histórico ni lo que estuviera corriendo. A quien tenía tres
   * PowerShell a medias eso le reabre tres PowerShell que no son los suyos, y prefiere el panel
   * limpio. Apagarlo no borra lo guardado: se sigue anotando, por si se vuelve a encender.
   */
  restoreTerminals: boolean;
  /**
   * Organización visual de la tira de pestañas: dónde va y de qué color es cada proyecto.
   *
   * Los colores se guardan por nombre de proyecto y no se derivan de la posición en la solución:
   * añadir un proyecto recolorearía todos los demás, y el código de colores que uno tenía
   * memorizado cambiaría de golpe. `coerceTabSettings` es quien lo valida al leerlo.
   */
  editorTabs: TabProjectSettings;
  /**
   * Barra lateral a la vista.
   *
   * Se guarda porque quien la esconde para leer código lo hace durante un rato largo, no durante
   * un minuto: reabrir el IDE y encontrársela otra vez ahí obliga a esconderla en cada arranque.
   * Lo que **no** se esconde nunca es la barra de actividad: con ella fuera, volver a enseñar la
   * lateral exigiría recordar el atajo, y una interfaz de la que no se puede salir mirando no es
   * una interfaz.
   */
  sidebarVisible: boolean;
  /**
   * Personalización de la barra de actividad.
   *
   * `order` son identificadores de herramienta (`ACTIVITY_TOOLS` en `src/shared/activity-bar.ts`),
   * no posiciones: un orden guardado por otra versión del IDE tiene que seguir dando una barra
   * completa, y `normalizeActivityOrder` se encarga de eso al leerlo.
   */
  activityBar: ActivityBarSettings;
  /** Preferencias del asistente de IA. Las claves de API NO viven aquí: ver `secret-store.ts`. */
  ai: AiSettings;
}

export interface ActivityBarSettings {
  order: ActivityToolId[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dotforge-dark',
  fontSize: 13,
  fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, monospace",
  tabSize: 4,
  wordWrap: false,
  minimap: true,
  formatOnSave: false,
  autoSave: 'off',
  autoSaveDelayMs: 1000,
  recentWorkspaces: [],
  lspEnabled: true,
  dotnetVerbosity: DEFAULT_DOTNET_VERBOSITY,
  autoUpdateCheck: true,
  restoreTerminals: true,
  sidebarVisible: true,
  editorTabs: DEFAULT_TAB_SETTINGS,
  activityBar: { order: DEFAULT_ACTIVITY_ORDER },
  ai: DEFAULT_AI_SETTINGS,
};

// ---------------------------------------------------------------------------------------------
// Canales
// ---------------------------------------------------------------------------------------------

/** Canales de petición/respuesta (renderer -> main). */
export const IPC = {
  appInfo: 'app:info',
  appSettingsGet: 'app:settings:get',
  appSettingsSet: 'app:settings:set',
  appOpenExternal: 'app:open-external',
  appShowItemInFolder: 'app:show-item-in-folder',

  workspaceOpenDialog: 'workspace:open-dialog',
  workspaceOpenSolutionDialog: 'workspace:open-solution-dialog',
  workspaceOpen: 'workspace:open',
  workspaceCurrent: 'workspace:current',
  workspaceClose: 'workspace:close',
  workspacePendingFile: 'workspace:pending-file',
  workspaceRecents: 'workspace:recents',
  workspaceOpenRecent: 'workspace:open-recent',

  fsListDirectory: 'fs:list-directory',
  fsReadFile: 'fs:read-file',
  fsWriteFile: 'fs:write-file',
  fsCreateFile: 'fs:create-file',
  fsCreateDirectory: 'fs:create-directory',
  fsRename: 'fs:rename',
  fsDelete: 'fs:delete',

  solutionLoad: 'solution:load',
  gitStatus: 'git:status',
  gitBranches: 'git:branches',
  gitRepository: 'git:repository',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitDiscard: 'git:discard',
  gitCommit: 'git:commit',
  gitPush: 'git:push',
  gitPull: 'git:pull',
  gitSync: 'git:sync',
  gitCheckout: 'git:checkout',
  gitCreateBranch: 'git:create-branch',
  gitFileDiff: 'git:file-diff',

  startupGet: 'startup:get',
  startupSave: 'startup:save',

  efcoreMigrations: 'efcore:migrations',
  efcoreContexts: 'efcore:contexts',
  efcoreRun: 'efcore:run',
  efcoreSchema: 'efcore:schema',
  efcoreConnections: 'efcore:connections',

  httpSend: 'http:send',

  dockerState: 'docker:state',
  dockerComposeFiles: 'docker:compose-files',
  dockerComposeRead: 'docker:compose-read',
  dockerComposeRun: 'docker:compose-run',
  dockerContainerRun: 'docker:container-run',

  scaffoldList: 'scaffold:list',
  scaffoldGenerate: 'scaffold:generate',
  scaffoldPickOutputDir: 'scaffold:pick-output-dir',

  dotnetRunTask: 'dotnet:run-task',
  dotnetCancelTask: 'dotnet:cancel-task',
  dotnetListTasks: 'dotnet:list-tasks',
  dotnetPublish: 'dotnet:publish',
  dotnetPublishOptions: 'dotnet:publish-options',

  terminalRun: 'terminal:run',
  terminalAllowed: 'terminal:allowed',
  terminalContext: 'terminal:context',
  terminalCwd: 'terminal:cwd',
  terminalProfiles: 'terminal:profiles',
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalDispose: 'terminal:dispose',
  terminalLayoutSave: 'terminal:layout-save',
  terminalLayoutRestore: 'terminal:layout-restore',

  nugetSearch: 'nuget:search',
  nugetVersions: 'nuget:versions',
  nugetInstall: 'nuget:install',
  nugetUninstall: 'nuget:uninstall',
  nugetAudit: 'nuget:audit',

  testsDiscover: 'tests:discover',
  testsRun: 'tests:run',
  testsResults: 'tests:results',

  tunnelTools: 'tunnel:tools',
  tunnelStart: 'tunnel:start',

  metricsState: 'metrics:state',
  metricsProcesses: 'metrics:processes',
  metricsStart: 'metrics:start',
  metricsStop: 'metrics:stop',

  lspState: 'lsp:state',
  lspStart: 'lsp:start',
  lspStop: 'lsp:stop',
  lspRequest: 'lsp:request',
  lspNotify: 'lsp:notify',
  lspLegend: 'lsp:legend',

  debugState: 'debug:state',
  debugStart: 'debug:start',
  debugStop: 'debug:stop',
  debugControl: 'debug:control',
  debugStackTrace: 'debug:stack-trace',
  debugScopes: 'debug:scopes',
  debugVariables: 'debug:variables',
  debugSetBreakpoints: 'debug:set-breakpoints',
  debugEvaluate: 'debug:evaluate',

  updateState: 'update:state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateDismiss: 'update:dismiss',
  updateApplyOnQuit: 'update:apply-on-quit',
  updateAcknowledge: 'update:acknowledge',

  searchInFiles: 'search:in-files',
  searchCancel: 'search:cancel',

  extensionsSearch: 'extensions:search',
  extensionsInstalled: 'extensions:installed',
  extensionsInstall: 'extensions:install',
  extensionsUninstall: 'extensions:uninstall',
  extensionsOpenFolder: 'extensions:open-folder',
  extensionsContributions: 'extensions:contributions',

  aiStatus: 'ai:status',
  aiSetKey: 'ai:set-key',
  aiProbe: 'ai:probe',
  aiSend: 'ai:send',
  aiCancel: 'ai:cancel',
} as const;

/** Canales de notificación (main -> renderer). */
export const IPC_EVENTS = {
  taskStarted: 'event:task-started',
  taskOutput: 'event:task-output',
  taskExit: 'event:task-exit',
  lspStateChanged: 'event:lsp-state',
  lspNotification: 'event:lsp-notification',
  workspaceChanged: 'event:workspace-changed',
  fileChanged: 'event:file-changed',
  menuCommand: 'event:menu-command',
  debugStateChanged: 'event:debug-state',
  debugStopped: 'event:debug-stopped',
  debugOutput: 'event:debug-output',
  aiDelta: 'event:ai-delta',
  aiEnd: 'event:ai-end',
  metricsSample: 'event:metrics-sample',
  updateState: 'event:update-state',
  searchProgress: 'event:search-progress',
  terminalData: 'event:terminal-data',
  terminalExit: 'event:terminal-exit',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

/** Comandos que el menú nativo envía al renderer. */
export type MenuCommand =
  | 'file.new'
  | 'file.open-folder'
  | 'file.open-solution'
  | 'file.close-workspace'
  | 'file.save'
  | 'file.save-all'
  | 'file.close-tab'
  | 'edit.find'
  | 'edit.find-in-files'
  | 'search.findInFiles'
  | 'edit.format'
  | 'edit.go-to-definition'
  | 'edit.rename'
  | 'view.command-palette'
  | 'view.toggle-sidebar'
  | 'view.explorer'
  | 'view.source-control'
  | 'view.nuget'
  | 'nuget.audit'
  | 'view.tests'
  | 'tests.run-all'
  | 'tests.run-file'
  | 'view.metrics'
  | 'view.extensions'
  | 'update.check'
  | 'tunnel.create'
  | 'tunnel.stop'
  | 'view.efcore'
  | 'view.containers'
  | 'docker.compose-up'
  | 'docker.compose-down'
  | 'view.problems'
  | 'view.logs'
  | 'architecture.check'
  | 'view.terminal'
  | 'terminal.new'
  | 'view.http'
  | 'view.settings'
  | 'view.toggle-theme'
  | 'view.theme-dark'
  | 'view.theme-light'
  | 'lsp.restart'
  | 'build.build'
  | 'build.rebuild'
  | 'build.clean'
  | 'build.restore'
  | 'build.test'
  | 'run.start'
  | 'run.without-debug'
  | 'run.watch'
  | 'run.stop'
  | 'debug.toggle-breakpoint'
  | 'debug.continue'
  | 'debug.step-over'
  | 'debug.step-in'
  | 'debug.step-out'
  | 'view.output'
  | 'git.commit'
  | 'git.push'
  | 'git.pull'
  | 'git.sync'
  | 'efcore.add-migration'
  | 'efcore.update-database'
  | 'http.send-request'
  | 'http.generate-file'
  | 'scaffold.wizard'
  | 'ai.chat'
  | 'ai.inline'
  | 'ai.explain'
  | 'ai.tests'
  | 'ai.fix'
  | 'ai.reset'
  | 'ai.openClaudeTerminal'
  | 'help.about'
  | 'help.docs';

/**
 * API expuesta al renderer por el preload. Es intencionadamente pequeña: cada método es una
 * capacidad concreta, no un puente genérico a `ipcRenderer`.
 */
export interface DotForgeApi {
  app: {
    info(): Promise<AppInfo>;
    getSettings(): Promise<AppSettings>;
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): Promise<void>;
  };
  workspace: {
    openDialog(): Promise<string | null>;
    /**
     * Diálogo filtrado a `.sln` / `.slnx`. Devuelve la **carpeta** del archivo elegido, que es lo
     * que el IDE abre: una solución sin su carpeta alrededor no sirve de nada.
     */
    openSolutionDialog(): Promise<string | null>;
    open(path: string): Promise<SolutionInfo>;
    current(): Promise<SolutionInfo | null>;
    close(): Promise<void>;
    /**
     * Archivo que el proceso principal quiere abrir (argumento de línea de comandos).
     * Se consulta en vez de recibirse por evento porque el renderer tarda en estar listo
     * (hay que cargar Monaco) y un evento emitido antes se perdería.
     */
    pendingFile(): Promise<string | null>;
    /** Historial con la disponibilidad de cada entrada resuelta contra el disco. */
    recents(): Promise<RecentWorkspace[]>;
    /**
     * Reabre el reciente más nuevo que **todavía exista**. Devuelve null si no hay ninguno.
     * Es una operación del proceso principal a propósito: es quien conoce el disco y el historial,
     * y así el arranque no intenta abrir una carpeta borrada para acabar en un error.
     */
    openRecent(): Promise<SolutionInfo | null>;
  };
  fs: {
    listDirectory(path: string): Promise<FileNode[]>;
    readFile(path: string): Promise<EditorDocument>;
    writeFile(path: string, content: string): Promise<{ mtimeMs: number }>;
    createFile(path: string, content?: string): Promise<void>;
    createDirectory(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    delete(path: string): Promise<void>;
  };
  solution: {
    load(path: string): Promise<SolutionInfo>;
  };
  git: {
    /** Rama y número de archivos sucios del workspace. Null si no hay repositorio. */
    status(): Promise<GitStatus | null>;
    /** Ramas locales y remotas, para el autocompletado de la terminal. Vacío si no hay repo. */
    branches(): Promise<string[]>;
    /**
     * Estado completo para el panel de control de código fuente: rama, upstream, adelanto y
     * retraso, y la lista de archivos preparados y sin preparar. Null si no hay repositorio.
     */
    repository(): Promise<GitRepositoryStatus | null>;
    /** Prepara archivos (`git add`). Las rutas son relativas a la raíz del repositorio. */
    stage(paths: string[]): Promise<GitCommandResult>;
    /** Saca archivos del área de preparación (`git restore --staged`). */
    unstage(paths: string[]): Promise<GitCommandResult>;
    /**
     * Descarta los cambios locales de un archivo. Un archivo sin rastrear se borra, porque no hay
     * ninguna versión anterior a la que volver: la operación pide confirmación en la interfaz.
     */
    discard(paths: string[]): Promise<GitCommandResult>;
    commit(message: string, options?: { amend?: boolean }): Promise<GitCommandResult>;
    push(): Promise<GitCommandResult>;
    pull(): Promise<GitCommandResult>;
    /** `pull` seguido de `push`: el botón que la gente pulsa sin pensar. */
    sync(): Promise<GitCommandResult>;
    checkout(branch: string): Promise<GitCommandResult>;
    createBranch(name: string): Promise<GitCommandResult>;
    /** Contenido de los dos lados de la comparación de un archivo. */
    fileDiff(request: GitDiffRequest): Promise<GitFileDiff>;
  };
  startup: {
    /** Perfiles de inicio guardados para el workspace abierto. */
    get(): Promise<StartupConfig>;
    save(config: StartupConfig): Promise<StartupConfig>;
  };
  /**
   * Gestor de Entity Framework Core.
   *
   * Las lecturas devuelven `EfReadResult`; las escrituras devuelven una tarea, porque su salida
   * va al panel como la de cualquier `dotnet build` y hay que poder cancelarla.
   */
  efcore: {
    migrations(options: EfOperationOptions): Promise<EfReadResult<EfMigrationList>>;
    contexts(options: EfOperationOptions): Promise<EfReadResult<EfDbContext[]>>;
    run(operation: EfOperation, options: EfOperationOptions): Promise<DotnetTaskStarted>;
    /** Esquema deducido de los archivos de migración del proyecto. No toca la base de datos. */
    schema(projectPath: string): Promise<DatabaseSchema>;
    /** Cadenas de conexión de los `appsettings*.json` del proyecto, con la contraseña oculta. */
    connections(projectPath: string): Promise<ConnectionStringFileInfo[]>;
  };

  /** Cliente HTTP de los archivos `.http` / `.rest`. */
  http: {
    send(request: ResolvedHttpRequest): Promise<HttpResponseResult>;
  };

  /**
   * Contenedores y Docker Compose.
   *
   * Las lecturas devuelven estado; las acciones devuelven una tarea, porque `compose up` tarda y
   * su salida va al panel inferior como la de cualquier compilación.
   */
  docker: {
    state(): Promise<DockerEngineState>;
    /** Archivos de Compose del workspace: la raíz y un nivel por debajo. */
    composeFiles(): Promise<string[]>;
    composeRead(path: string): Promise<ComposeFile>;
    /** `up`, `down`, `restart`… sobre todo el compose o sobre un servicio concreto. */
    composeRun(action: ComposeAction, path: string, service?: string | null): Promise<DotnetTaskStarted>;
    /** Acciones sobre un contenedor suelto, fuera de Compose. */
    containerRun(action: ContainerAction, container: string): Promise<DotnetTaskStarted>;
  };

  scaffold: {
    list(): Promise<BlueprintInfo[]>;
    generate(options: ScaffoldOptions): Promise<ScaffoldResult>;
    pickOutputDir(): Promise<string | null>;
  };
  dotnet: {
    runTask(request: DotnetTaskRequest): Promise<DotnetTaskStarted>;
    cancelTask(taskId: string): Promise<void>;
    listTasks(): Promise<DotnetTaskStarted[]>;
    /**
     * Publica un proyecto (`dotnet publish`).
     *
     * Va por el canal de tareas como cualquier compilación —puede tardar minutos y su salida
     * pertenece al panel inferior—, pero tiene canal propio porque sus argumentos los compone el
     * proceso principal a partir de opciones validadas, no de un `extraArgs` del renderer.
     */
    publish(request: PublishRequest): Promise<PublishStarted>;
    /**
     * Últimas opciones con las que se publicó ese proyecto, ya saneadas.
     *
     * Sin nada guardado devuelve las de fábrica con el marco de destino del proyecto ya puesto:
     * abrir el diálogo y tener que elegirlo todo cada vez es lo que hace que nadie lo use.
     */
    publishOptions(projectPath: string): Promise<PublishOptions>;
  };
  terminal: {
    /**
     * Ejecuta una línea en el directorio actual de la terminal.
     *
     * Un `cd` o un `pwd` no lanzan proceso: vuelven con `task: null` y lo que haya que imprimir en
     * `output`. El resto devuelven la tarea, para poder cancelarla.
     */
    run(line: string): Promise<TerminalRunResult>;
    /** Programas que la terminal admite. La UI los muestra como ayuda. */
    allowed(): Promise<string[]>;
    /**
     * Contexto del autocompletado: programas, contenedores, imágenes y scripts de npm.
     * Las ramas de git y los proyectos los pone el renderer, que ya los tiene.
     */
    context(): Promise<TerminalContext>;
    /** Directorio de trabajo actual. Lo pide el panel al pintar el prompt. */
    cwd(): Promise<TerminalCwd>;

    /**
     * Perfiles que puede abrir el botón `+`, con su disponibilidad resuelta.
     *
     * Se piden cada vez que se abre el menú y no una sola vez al arrancar: `node-pty` se carga la
     * primera vez que hace falta, así que "está disponible" es una respuesta que puede cambiar
     * entre la primera pregunta y la segunda.
     */
    profiles(): Promise<TerminalProfileInfo[]>;

    /** Abre una pseudoterminal con ese perfil, en el directorio actual de la terminal. */
    create(profileId: string, size?: { columns: number; rows: number }): Promise<TerminalSessionInfo>;

    /** Manda texto tecleado a la entrada del intérprete, caracteres de control incluidos. */
    write(terminalId: string, data: string): Promise<boolean>;

    /** Reenvía el tamaño del hueco: sin esto el intérprete parte las líneas donde no toca. */
    resize(terminalId: string, columns: number, rows: number): Promise<boolean>;

    /** Cierra la sesión y mata su árbol de procesos. */
    dispose(terminalId: string): Promise<boolean>;

    /**
     * Guarda qué pestañas hay abiertas en la solución actual.
     *
     * Se llama en cada cambio de pestaña, no al cerrar: abrir otra solución cambia la clave con la
     * que se guarda, y capturar el estado justo antes de ese cambio es una carrera. Sin solución
     * abierta no hace nada.
     */
    saveLayout(layout: TerminalLayoutPatch): Promise<void>;

    /**
     * Qué pestañas volver a abrir en la solución actual.
     *
     * Devuelve la lista vacía si no hay nada guardado, si el ajuste está desactivado o si lo
     * guardado era ya lo que hay por defecto. Restaurar es reabrir un intérprete **vacío** en el
     * mismo directorio: no vuelve el histórico ni lo que estuviera corriendo.
     */
    restoreLayout(): Promise<TerminalLayoutRestore>;
  };
  nuget: {
    search(query: string, includePrerelease: boolean): Promise<NuGetSearchResult[]>;
    versions(packageId: string, includePrerelease: boolean): Promise<string[]>;
    install(projectPath: string, packageId: string, version?: string): Promise<DotnetTaskStarted>;
    uninstall(projectPath: string, packageId: string): Promise<DotnetTaskStarted>;
    /**
     * Vulnerabilidades conocidas de los paquetes restaurados (`dotnet list package --vulnerable`).
     * Sin objetivo se audita la solución entera. Un fallo se devuelve en `error`, no se lanza.
     */
    audit(target?: string | null): Promise<AuditReport>;
  };

  /**
   * Explorador de pruebas.
   *
   * El descubrimiento lee el código fuente y no compila nada; la ejecución devuelve una tarea,
   * porque su salida va al panel y hay que poder cancelarla. Los resultados se piden aparte
   * cuando la tarea termina: salen del TRX, que es la única fuente que no depende del idioma.
   */
  tests: {
    discover(): Promise<TestCase[]>;
    run(request: TestRunRequest): Promise<DotnetTaskStarted>;
    results(taskId: string): Promise<TestRunSummary>;
  };

  /**
   * Túnel público hacia un puerto local.
   *
   * `tools()` dice qué hay instalado —lista vacía es un estado normal, no un error— y `start()`
   * devuelve una tarea de larga duración: se para cancelándola, como cualquier proceso.
   */
  tunnel: {
    tools(): Promise<TunnelTool[]>;
    start(tool: TunnelTool, port: number): Promise<DotnetTaskStarted>;
  };

  /**
   * Monitor de rendimiento sobre un proceso .NET vivo.
   *
   * Las muestras llegan por el evento `onMetricsSample`, no como respuesta: son un flujo continuo
   * mientras dure la sesión.
   */
  metrics: {
    state(): Promise<MetricsState>;
    processes(): Promise<DotnetProcess[]>;
    start(pid: number, processName?: string | null): Promise<MetricsState>;
    stop(): Promise<void>;
  };
  lsp: {
    state(): Promise<LspState>;
    start(): Promise<LspState>;
    stop(): Promise<void>;
    request(method: string, params: unknown): Promise<unknown>;
    notify(method: string, params: unknown): Promise<void>;
    /**
     * Leyenda de tokens semánticos que publicó el servidor al inicializarse.
     *
     * Hace falta para descodificar `textDocument/semanticTokens/full`: los datos son índices
     * dentro de **su** leyenda, no de la nuestra. Null si el servidor no los ofrece.
     */
    legend(): Promise<SemanticTokensLegend | null>;
  };
  debug: {
    state(): Promise<DebugState>;
    start(request: DebugLaunchRequest): Promise<DebugState>;
    stop(): Promise<void>;
    control(action: DebugAction): Promise<void>;
    stackTrace(): Promise<DebugStackFrame[]>;
    scopes(frameId: number): Promise<DebugScope[]>;
    variables(variablesReference: number): Promise<DebugVariable[]>;
    setBreakpoints(file: string, lines: number[]): Promise<void>;
    evaluate(expression: string, frameId?: number): Promise<string>;
  };

  /**
   * Actualizaciones automáticas.
   *
   * `check` pregunta al feed, `download` baja el artefacto de esta plataforma y `dismiss` esconde
   * la tarjeta dejando programada la instalación al cerrar. Los cambios de estado llegan también
   * por `onUpdateState`: la descarga avanza sola y nadie está esperando una respuesta.
   */
  updates: {
    state(): Promise<UpdateState>;
    check(manual?: boolean): Promise<UpdateState>;
    download(): Promise<UpdateState>;
    dismiss(): Promise<UpdateState>;
    /** Programa la instalación al cerrar; con `now`, cierra el IDE para aplicarla ya. */
    applyOnQuit(now?: boolean): Promise<UpdateState>;
    /**
     * Cierra el aviso de cierre de bucle (`state.outcome`): el "✅ ¡Actualizado!" del arranque, o
     * el de la instalación que no llegó a aplicarse. No es `dismiss`: aquél habla de una
     * actualización que viene y deja programada su instalación; éste sólo borra una noticia.
     */
    acknowledge(): Promise<UpdateState>;
  };

  /**
   * Búsqueda de texto en los archivos del workspace.
   *
   * `inFiles` devuelve el resumen completo, y por el camino va emitiendo lotes por
   * `onSearchProgress`: una solución mediana tarda un segundo largo y un panel que no enseña nada
   * hasta el final se percibe como roto aunque tarde lo mismo. Los dos llevan el mismo `searchId`,
   * que es lo que permite descartar los avances de una búsqueda ya abandonada.
   */
  search: {
    inFiles(options: SearchOptions): Promise<SearchSummary>;
    /** Abandona la búsqueda en marcha. La emite el panel al cerrarse o al vaciarse la caja. */
    cancel(): Promise<void>;
  };

  /**
   * Extensiones de Open VSX.
   *
   * La búsqueda y la descarga las hace el proceso principal: la CSP del renderer no admite
   * ningún origen remoto, y así el registro no ve nada del equipo salvo la propia consulta.
   */
  extensions: {
    search(request: SearchQuery): Promise<SearchResult>;
    installed(): Promise<InstalledExtension[]>;
    /** Instala desde el registro. Devuelve la extensión ya instalada y leída del disco. */
    install(extension: MarketplaceExtension): Promise<InstalledExtension>;
    uninstall(id: string): Promise<boolean>;
    /** Abre la carpeta de extensiones en el explorador del sistema. */
    openFolder(): Promise<void>;
    /**
     * Lo que aportan de verdad las instaladas: temas de color y fragmentos, ya leídos y
     * convertidos al formato de Monaco.
     *
     * Se pide al arrancar y después de instalar o desinstalar. Va como consulta y no como evento
     * porque el renderer tarda en estar listo —carga Monaco— y un evento emitido antes se perdería.
     */
    contributions(): Promise<ExtensionContributions>;
  };

  ai: {
    /** Proveedor activo, modelo y si hay credencial. La clave nunca se devuelve. */
    status(): Promise<AiStatus>;
    /**
     * Guarda o borra (con `null`) la clave de un proveedor. Devuelve el estado resultante.
     * Es un canal de escritura: no existe ningún canal que lea una clave hacia el renderer.
     */
    setKey(provider: AiProviderId, apiKey: string | null): Promise<AiStatus>;
    /** Comprueba que el proveedor responde con la configuración actual. */
    probe(provider: AiProviderId): Promise<AiProbeResult>;
    /**
     * Lanza una conversación en streaming. El texto llega por `onAiDelta` y el cierre por
     * `onAiEnd`, los dos etiquetados con el `requestId` de la petición.
     */
    send(request: AiChatRequest): Promise<{ requestId: string }>;
    cancel(requestId: string): Promise<void>;
  };

  events: {
    onTaskStarted(handler: (payload: DotnetTaskStarted) => void): () => void;
    onTaskOutput(handler: (payload: DotnetTaskOutput) => void): () => void;
    onTaskExit(handler: (payload: DotnetTaskExit) => void): () => void;
    onLspState(handler: (payload: LspState) => void): () => void;
    onLspNotification(handler: (payload: { method: string; params: unknown }) => void): () => void;
    onWorkspaceChanged(handler: (payload: SolutionInfo | null) => void): () => void;
    onFileChanged(handler: (payload: { path: string; kind: 'created' | 'changed' | 'deleted' }) => void): () => void;
    onMenuCommand(handler: (command: MenuCommand) => void): () => void;
    onDebugState(handler: (state: DebugState) => void): () => void;
    onDebugStopped(handler: (payload: { reason: string; threadId: number | null }) => void): () => void;
    onDebugOutput(handler: (payload: { category: string; text: string }) => void): () => void;
    onAiDelta(handler: (payload: AiStreamDelta) => void): () => void;
    onAiEnd(handler: (payload: AiStreamEnd) => void): () => void;
    onMetricsSample(handler: (payload: MetricsEvent) => void): () => void;
    onUpdateState(handler: (state: UpdateState) => void): () => void;
    onSearchProgress(handler: (progress: SearchProgress) => void): () => void;

    /**
     * Salida de una pseudoterminal, con sus secuencias de escape intactas.
     *
     * Va por evento y no como respuesta a una llamada porque un intérprete escupe cuando quiere:
     * el prompt aparece antes de que nadie haya escrito nada, y un `dotnet watch` sigue hablando
     * mucho después.
     */
    onTerminalData(handler: (payload: TerminalDataEvent) => void): () => void;
    onTerminalExit(handler: (payload: TerminalExitEvent) => void): () => void;
  };
}

declare global {
  interface Window {
    dotforge: DotForgeApi;
  }
}
