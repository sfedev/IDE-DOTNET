/**
 * Contrato IPC entre el proceso principal y el renderer.
 *
 * Es la única superficie por la que el renderer puede pedirle algo al sistema. Todo canal nuevo
 * se declara aquí primero: si no está en este archivo, no existe.
 *
 * Convención de nombres: `dominio:acción`. Los canales `invoke` devuelven una promesa; los
 * canales `event` son notificaciones del main hacia el renderer.
 */
import type { ArchitectureId, BlueprintInfo, ScaffoldOptions, ScaffoldResult } from './scaffold-types.js';

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

export interface ProjectInfo {
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
}

export interface DotnetTaskStarted {
  taskId: string;
  kind: DotnetTaskKind;
  command: string;
  target: string;
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

  fsListDirectory: 'fs:list-directory',
  fsReadFile: 'fs:read-file',
  fsWriteFile: 'fs:write-file',
  fsCreateFile: 'fs:create-file',
  fsCreateDirectory: 'fs:create-directory',
  fsRename: 'fs:rename',
  fsDelete: 'fs:delete',

  solutionLoad: 'solution:load',

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
  | 'view.nuget'
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
  | 'scaffold.wizard'
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
  };
}

declare global {
  interface Window {
    dotforge: DotForgeApi;
  }
}
