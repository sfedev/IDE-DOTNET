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
  HttpFileDocument,
  HttpHeader,
  HttpRequestBlock,
  HttpResponseResult,
  ResolvedHttpRequest,
} from './http-file.js';
import type { EfMigrationList, EfDbContext, EfOperation, EfOperationOptions } from './efcore.js';
import type { DatabaseSchema } from './efcore-schema.js';
import type { HttpResponseResult, ResolvedHttpRequest } from './http-file.js';
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

export type DotnetTaskKind = 'build' | 'rebuild' | 'clean' | 'restore' | 'test' | 'run' | 'watch' | 'format';

export interface DotnetTaskRequest {
  kind: DotnetTaskKind;
  /** Ruta del .sln o .csproj objetivo. */
  target: string;
  /** Argumentos adicionales, ya troceados (nunca una línea de shell). */
  extraArgs?: string[];
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
  theme: 'dotforge-dark' | 'dotforge-light';
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
  /** Preferencias del asistente de IA. Las claves de API NO viven aquí: ver `secret-store.ts`. */
  ai: AiSettings;
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

  scaffoldList: 'scaffold:list',
  scaffoldGenerate: 'scaffold:generate',
  scaffoldPickOutputDir: 'scaffold:pick-output-dir',

  dotnetRunTask: 'dotnet:run-task',
  dotnetCancelTask: 'dotnet:cancel-task',
  dotnetListTasks: 'dotnet:list-tasks',

  terminalRun: 'terminal:run',
  terminalAllowed: 'terminal:allowed',

  nugetSearch: 'nuget:search',
  nugetVersions: 'nuget:versions',
  nugetInstall: 'nuget:install',
  nugetUninstall: 'nuget:uninstall',

  lspState: 'lsp:state',
  lspStart: 'lsp:start',
  lspStop: 'lsp:stop',
  lspRequest: 'lsp:request',
  lspNotify: 'lsp:notify',

  debugState: 'debug:state',
  debugStart: 'debug:start',
  debugStop: 'debug:stop',
  debugControl: 'debug:control',
  debugStackTrace: 'debug:stack-trace',
  debugScopes: 'debug:scopes',
  debugVariables: 'debug:variables',
  debugSetBreakpoints: 'debug:set-breakpoints',
  debugEvaluate: 'debug:evaluate',

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
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

/** Comandos que el menú nativo envía al renderer. */
export type MenuCommand =
  | 'file.new'
  | 'file.open-folder'
  | 'file.save'
  | 'file.save-all'
  | 'file.close-tab'
  | 'edit.find'
  | 'edit.format'
  | 'view.command-palette'
  | 'view.explorer'
  | 'view.source-control'
  | 'view.nuget'
  | 'view.efcore'
  | 'view.problems'
  | 'view.terminal'
  | 'view.toggle-theme'
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
  | 'help.about';

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

  scaffold: {
    list(): Promise<BlueprintInfo[]>;
    generate(options: ScaffoldOptions): Promise<ScaffoldResult>;
    pickOutputDir(): Promise<string | null>;
  };
  dotnet: {
    runTask(request: DotnetTaskRequest): Promise<DotnetTaskStarted>;
    cancelTask(taskId: string): Promise<void>;
    listTasks(): Promise<DotnetTaskStarted[]>;
  };
  terminal: {
    /** Ejecuta una línea de comandos en el workspace. Devuelve la tarea para poder cancelarla. */
    run(line: string): Promise<DotnetTaskStarted>;
    /** Programas que la terminal admite. La UI los muestra como ayuda. */
    allowed(): Promise<string[]>;
  };
  nuget: {
    search(query: string, includePrerelease: boolean): Promise<NuGetSearchResult[]>;
    versions(packageId: string, includePrerelease: boolean): Promise<string[]>;
    install(projectPath: string, packageId: string, version?: string): Promise<DotnetTaskStarted>;
    uninstall(projectPath: string, packageId: string): Promise<DotnetTaskStarted>;
  };
  lsp: {
    state(): Promise<LspState>;
    start(): Promise<LspState>;
    stop(): Promise<void>;
    request(method: string, params: unknown): Promise<unknown>;
    notify(method: string, params: unknown): Promise<void>;
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
  };
}

declare global {
  interface Window {
    dotforge: DotForgeApi;
  }
}
