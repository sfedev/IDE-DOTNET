/**
 * Puente seguro entre el renderer y el proceso principal.
 *
 * Se expone una API tipada y de superficie mínima. Deliberadamente NO se expone `ipcRenderer`:
 * si el renderer pudiera invocar canales arbitrarios, el aislamiento de contexto no serviría
 * de nada.
 */
import { contextBridge, ipcRenderer } from 'electron';

import type {
  AiChatRequest,
  AiProbeResult,
  AiProviderId,
  AiStatus,
  AiStreamDelta,
  AiStreamEnd,
  AppInfo,
  AppSettings,
  DebugAction,
  DebugLaunchRequest,
  DebugScope,
  DebugStackFrame,
  DebugState,
  DebugVariable,
  DotForgeApi,
  DotnetTaskExit,
  DotnetTaskOutput,
  DotnetTaskRequest,
  PublishOptions,
  PublishRequest,
  PublishStarted,
  DotnetTaskStarted,
  ConnectionStringFileInfo,
  EfDbContext,
  EfMigrationList,
  EfOperation,
  EfOperationOptions,
  EfReadResult,
  EditorDocument,
  FileNode,
  GitCommandResult,
  GitFileDiff,
  GitStatus,
  DatabaseSchema,
  HttpResponseResult,
  ResolvedHttpRequest,
  ComposeAction,
  ComposeFile,
  ContainerAction,
  DockerEngineState,
  LspState,
  MenuCommand,
  NuGetSearchResult,
  RecentWorkspace,
  SolutionInfo,
  TerminalContext,
  TerminalCwd,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalLayoutRestore,
  TerminalProfileInfo,
  TerminalRunResult,
  TerminalSessionInfo,
  AuditReport,
  TestCase,
  TestRunRequest,
  TestRunSummary,
  TunnelTool,
  DotnetProcess,
  MetricsEvent,
  MetricsState,
  SemanticTokensLegend,
  UpdateState,
  MarketplaceExtension,
  SearchQuery,
  SearchResult,
  SearchOptions,
  SearchProgress,
  SearchSummary,
  InstalledExtension,
  ExtensionContributions,
} from '../shared/contracts.js';
import { IPC, IPC_EVENTS } from '../shared/contracts.js';
import type { GitDiffRequest, GitRepositoryStatus } from '../shared/git.js';
import type { BlueprintInfo, ScaffoldOptions, ScaffoldResult } from '../shared/scaffold-types.js';
import type { StartupConfig } from '../shared/startup.js';

/** Suscribe un handler a un canal de evento y devuelve la función para darse de baja. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: DotForgeApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
    getSettings: () => ipcRenderer.invoke(IPC.appSettingsGet) as Promise<AppSettings>,
    setSettings: (patch) => ipcRenderer.invoke(IPC.appSettingsSet, patch) as Promise<AppSettings>,
    openExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, url) as Promise<void>,
    showItemInFolder: (path) => ipcRenderer.invoke(IPC.appShowItemInFolder, path) as Promise<void>,
  },

  workspace: {
    openDialog: () => ipcRenderer.invoke(IPC.workspaceOpenDialog) as Promise<string | null>,
    openSolutionDialog: () => ipcRenderer.invoke(IPC.workspaceOpenSolutionDialog) as Promise<string | null>,
    open: (path) => ipcRenderer.invoke(IPC.workspaceOpen, path) as Promise<SolutionInfo>,
    current: () => ipcRenderer.invoke(IPC.workspaceCurrent) as Promise<SolutionInfo | null>,
    close: () => ipcRenderer.invoke(IPC.workspaceClose) as Promise<void>,
    pendingFile: () => ipcRenderer.invoke(IPC.workspacePendingFile) as Promise<string | null>,
    recents: () => ipcRenderer.invoke(IPC.workspaceRecents) as Promise<RecentWorkspace[]>,
    openRecent: () => ipcRenderer.invoke(IPC.workspaceOpenRecent) as Promise<SolutionInfo | null>,
  },

  fs: {
    listDirectory: (path) => ipcRenderer.invoke(IPC.fsListDirectory, path) as Promise<FileNode[]>,
    readFile: (path) => ipcRenderer.invoke(IPC.fsReadFile, path) as Promise<EditorDocument>,
    writeFile: (path, content) => ipcRenderer.invoke(IPC.fsWriteFile, path, content) as Promise<{ mtimeMs: number }>,
    createFile: (path, content) => ipcRenderer.invoke(IPC.fsCreateFile, path, content ?? '') as Promise<void>,
    createDirectory: (path) => ipcRenderer.invoke(IPC.fsCreateDirectory, path) as Promise<void>,
    rename: (from, to) => ipcRenderer.invoke(IPC.fsRename, from, to) as Promise<void>,
    delete: (path) => ipcRenderer.invoke(IPC.fsDelete, path) as Promise<void>,
  },

  solution: {
    load: (path) => ipcRenderer.invoke(IPC.solutionLoad, path) as Promise<SolutionInfo>,
  },

  git: {
    status: () => ipcRenderer.invoke(IPC.gitStatus) as Promise<GitStatus | null>,
    branches: () => ipcRenderer.invoke(IPC.gitBranches) as Promise<string[]>,
    repository: () => ipcRenderer.invoke(IPC.gitRepository) as Promise<GitRepositoryStatus | null>,
    stage: (paths: string[]) => ipcRenderer.invoke(IPC.gitStage, paths) as Promise<GitCommandResult>,
    unstage: (paths: string[]) => ipcRenderer.invoke(IPC.gitUnstage, paths) as Promise<GitCommandResult>,
    discard: (paths: string[]) => ipcRenderer.invoke(IPC.gitDiscard, paths) as Promise<GitCommandResult>,
    commit: (message: string, options?: { amend?: boolean }) =>
      ipcRenderer.invoke(IPC.gitCommit, message, options ?? {}) as Promise<GitCommandResult>,
    push: () => ipcRenderer.invoke(IPC.gitPush) as Promise<GitCommandResult>,
    pull: () => ipcRenderer.invoke(IPC.gitPull) as Promise<GitCommandResult>,
    sync: () => ipcRenderer.invoke(IPC.gitSync) as Promise<GitCommandResult>,
    checkout: (branch: string) => ipcRenderer.invoke(IPC.gitCheckout, branch) as Promise<GitCommandResult>,
    createBranch: (name: string) => ipcRenderer.invoke(IPC.gitCreateBranch, name) as Promise<GitCommandResult>,
    fileDiff: (request: GitDiffRequest) => ipcRenderer.invoke(IPC.gitFileDiff, request) as Promise<GitFileDiff>,
  },

  startup: {
    get: () => ipcRenderer.invoke(IPC.startupGet) as Promise<StartupConfig>,
    save: (config: StartupConfig) => ipcRenderer.invoke(IPC.startupSave, config) as Promise<StartupConfig>,
  },

  efcore: {
    migrations: (options: EfOperationOptions) =>
      ipcRenderer.invoke(IPC.efcoreMigrations, options) as Promise<EfReadResult<EfMigrationList>>,
    contexts: (options: EfOperationOptions) =>
      ipcRenderer.invoke(IPC.efcoreContexts, options) as Promise<EfReadResult<EfDbContext[]>>,
    run: (operation: EfOperation, options: EfOperationOptions) =>
      ipcRenderer.invoke(IPC.efcoreRun, operation, options) as Promise<DotnetTaskStarted>,
    schema: (projectPath: string) => ipcRenderer.invoke(IPC.efcoreSchema, projectPath) as Promise<DatabaseSchema>,
    connections: (projectPath: string) =>
      ipcRenderer.invoke(IPC.efcoreConnections, projectPath) as Promise<ConnectionStringFileInfo[]>,
  },

  http: {
    send: (request: ResolvedHttpRequest) => ipcRenderer.invoke(IPC.httpSend, request) as Promise<HttpResponseResult>,
  },

  docker: {
    state: () => ipcRenderer.invoke(IPC.dockerState) as Promise<DockerEngineState>,
    composeFiles: () => ipcRenderer.invoke(IPC.dockerComposeFiles) as Promise<string[]>,
    composeRead: (path: string) => ipcRenderer.invoke(IPC.dockerComposeRead, path) as Promise<ComposeFile>,
    composeRun: (action: ComposeAction, path: string, service?: string | null) =>
      ipcRenderer.invoke(IPC.dockerComposeRun, action, path, service ?? null) as Promise<DotnetTaskStarted>,
    containerRun: (action: ContainerAction, container: string) =>
      ipcRenderer.invoke(IPC.dockerContainerRun, action, container) as Promise<DotnetTaskStarted>,
  },

  scaffold: {
    list: () => ipcRenderer.invoke(IPC.scaffoldList) as Promise<BlueprintInfo[]>,
    generate: (options: ScaffoldOptions) => ipcRenderer.invoke(IPC.scaffoldGenerate, options) as Promise<ScaffoldResult>,
    pickOutputDir: () => ipcRenderer.invoke(IPC.scaffoldPickOutputDir) as Promise<string | null>,
  },

  dotnet: {
    runTask: (request: DotnetTaskRequest) => ipcRenderer.invoke(IPC.dotnetRunTask, request) as Promise<DotnetTaskStarted>,
    cancelTask: (taskId) => ipcRenderer.invoke(IPC.dotnetCancelTask, taskId) as Promise<void>,
    listTasks: () => ipcRenderer.invoke(IPC.dotnetListTasks) as Promise<DotnetTaskStarted[]>,
    publish: (request: PublishRequest) => ipcRenderer.invoke(IPC.dotnetPublish, request) as Promise<PublishStarted>,
    publishOptions: (projectPath) =>
      ipcRenderer.invoke(IPC.dotnetPublishOptions, projectPath) as Promise<PublishOptions>,
  },

  terminal: {
    run: (line) => ipcRenderer.invoke(IPC.terminalRun, line) as Promise<TerminalRunResult>,
    allowed: () => ipcRenderer.invoke(IPC.terminalAllowed) as Promise<string[]>,
    context: () => ipcRenderer.invoke(IPC.terminalContext) as Promise<TerminalContext>,
    cwd: () => ipcRenderer.invoke(IPC.terminalCwd) as Promise<TerminalCwd>,
    profiles: () => ipcRenderer.invoke(IPC.terminalProfiles) as Promise<TerminalProfileInfo[]>,
    create: (profileId, size) =>
      ipcRenderer.invoke(IPC.terminalCreate, profileId, size ?? null) as Promise<TerminalSessionInfo>,
    write: (terminalId, data) => ipcRenderer.invoke(IPC.terminalWrite, terminalId, data) as Promise<boolean>,
    resize: (terminalId, columns, rows) =>
      ipcRenderer.invoke(IPC.terminalResize, terminalId, columns, rows) as Promise<boolean>,
    dispose: (terminalId) => ipcRenderer.invoke(IPC.terminalDispose, terminalId) as Promise<boolean>,
    saveLayout: (layout) => ipcRenderer.invoke(IPC.terminalLayoutSave, layout) as Promise<void>,
    restoreLayout: () => ipcRenderer.invoke(IPC.terminalLayoutRestore) as Promise<TerminalLayoutRestore>,
  },

  nuget: {
    search: (query, includePrerelease) =>
      ipcRenderer.invoke(IPC.nugetSearch, query, includePrerelease) as Promise<NuGetSearchResult[]>,
    versions: (packageId, includePrerelease) =>
      ipcRenderer.invoke(IPC.nugetVersions, packageId, includePrerelease) as Promise<string[]>,
    install: (projectPath, packageId, version) =>
      ipcRenderer.invoke(IPC.nugetInstall, projectPath, packageId, version) as Promise<DotnetTaskStarted>,
    uninstall: (projectPath, packageId) =>
      ipcRenderer.invoke(IPC.nugetUninstall, projectPath, packageId) as Promise<DotnetTaskStarted>,
    audit: (target) => ipcRenderer.invoke(IPC.nugetAudit, target ?? null) as Promise<AuditReport>,
  },

  tests: {
    discover: () => ipcRenderer.invoke(IPC.testsDiscover) as Promise<TestCase[]>,
    run: (request: TestRunRequest) => ipcRenderer.invoke(IPC.testsRun, request) as Promise<DotnetTaskStarted>,
    results: (taskId) => ipcRenderer.invoke(IPC.testsResults, taskId) as Promise<TestRunSummary>,
  },

  tunnel: {
    tools: () => ipcRenderer.invoke(IPC.tunnelTools) as Promise<TunnelTool[]>,
    start: (tool: TunnelTool, port: number) => ipcRenderer.invoke(IPC.tunnelStart, tool, port) as Promise<DotnetTaskStarted>,
  },

  metrics: {
    state: () => ipcRenderer.invoke(IPC.metricsState) as Promise<MetricsState>,
    processes: () => ipcRenderer.invoke(IPC.metricsProcesses) as Promise<DotnetProcess[]>,
    start: (pid: number, processName) =>
      ipcRenderer.invoke(IPC.metricsStart, pid, processName ?? null) as Promise<MetricsState>,
    stop: () => ipcRenderer.invoke(IPC.metricsStop) as Promise<void>,
  },

  lsp: {
    state: () => ipcRenderer.invoke(IPC.lspState) as Promise<LspState>,
    start: () => ipcRenderer.invoke(IPC.lspStart) as Promise<LspState>,
    stop: () => ipcRenderer.invoke(IPC.lspStop) as Promise<void>,
    request: (method, params) => ipcRenderer.invoke(IPC.lspRequest, method, params),
    notify: (method, params) => ipcRenderer.invoke(IPC.lspNotify, method, params) as Promise<void>,
    legend: () => ipcRenderer.invoke(IPC.lspLegend) as Promise<SemanticTokensLegend | null>,
  },

  debug: {
    state: () => ipcRenderer.invoke(IPC.debugState) as Promise<DebugState>,
    start: (request: DebugLaunchRequest) => ipcRenderer.invoke(IPC.debugStart, request) as Promise<DebugState>,
    stop: () => ipcRenderer.invoke(IPC.debugStop) as Promise<void>,
    control: (action: DebugAction) => ipcRenderer.invoke(IPC.debugControl, action) as Promise<void>,
    stackTrace: () => ipcRenderer.invoke(IPC.debugStackTrace) as Promise<DebugStackFrame[]>,
    scopes: (frameId) => ipcRenderer.invoke(IPC.debugScopes, frameId) as Promise<DebugScope[]>,
    variables: (reference) => ipcRenderer.invoke(IPC.debugVariables, reference) as Promise<DebugVariable[]>,
    setBreakpoints: (file, lines) => ipcRenderer.invoke(IPC.debugSetBreakpoints, file, lines) as Promise<void>,
    evaluate: (expression, frameId) => ipcRenderer.invoke(IPC.debugEvaluate, expression, frameId) as Promise<string>,
  },

  updates: {
    state: () => ipcRenderer.invoke(IPC.updateState) as Promise<UpdateState>,
    check: (manual) => ipcRenderer.invoke(IPC.updateCheck, manual ?? false) as Promise<UpdateState>,
    download: () => ipcRenderer.invoke(IPC.updateDownload) as Promise<UpdateState>,
    dismiss: () => ipcRenderer.invoke(IPC.updateDismiss) as Promise<UpdateState>,
    applyOnQuit: (now) => ipcRenderer.invoke(IPC.updateApplyOnQuit, now ?? false) as Promise<UpdateState>,
    acknowledge: () => ipcRenderer.invoke(IPC.updateAcknowledge) as Promise<UpdateState>,
  },

  search: {
    inFiles: (options: SearchOptions) => ipcRenderer.invoke(IPC.searchInFiles, options) as Promise<SearchSummary>,
    cancel: () => ipcRenderer.invoke(IPC.searchCancel) as Promise<void>,
  },

  extensions: {
    search: (request: SearchQuery) => ipcRenderer.invoke(IPC.extensionsSearch, request) as Promise<SearchResult>,
    installed: () => ipcRenderer.invoke(IPC.extensionsInstalled) as Promise<InstalledExtension[]>,
    install: (extension: MarketplaceExtension) =>
      ipcRenderer.invoke(IPC.extensionsInstall, extension) as Promise<InstalledExtension>,
    uninstall: (id: string) => ipcRenderer.invoke(IPC.extensionsUninstall, id) as Promise<boolean>,
    openFolder: () => ipcRenderer.invoke(IPC.extensionsOpenFolder) as Promise<void>,
    contributions: () => ipcRenderer.invoke(IPC.extensionsContributions) as Promise<ExtensionContributions>,
  },

  ai: {
    status: () => ipcRenderer.invoke(IPC.aiStatus) as Promise<AiStatus>,
    setKey: (provider: AiProviderId, apiKey: string | null) =>
      ipcRenderer.invoke(IPC.aiSetKey, provider, apiKey) as Promise<AiStatus>,
    probe: (provider: AiProviderId) => ipcRenderer.invoke(IPC.aiProbe, provider) as Promise<AiProbeResult>,
    send: (request: AiChatRequest) => ipcRenderer.invoke(IPC.aiSend, request) as Promise<{ requestId: string }>,
    cancel: (requestId) => ipcRenderer.invoke(IPC.aiCancel, requestId) as Promise<void>,
  },

  events: {
    onTaskStarted: (handler) => subscribe<DotnetTaskStarted>(IPC_EVENTS.taskStarted, handler),
    onTaskOutput: (handler) => subscribe<DotnetTaskOutput>(IPC_EVENTS.taskOutput, handler),
    onTaskExit: (handler) => subscribe<DotnetTaskExit>(IPC_EVENTS.taskExit, handler),
    onLspState: (handler) => subscribe<LspState>(IPC_EVENTS.lspStateChanged, handler),
    onLspNotification: (handler) =>
      subscribe<{ method: string; params: unknown }>(IPC_EVENTS.lspNotification, handler),
    onWorkspaceChanged: (handler) => subscribe<SolutionInfo | null>(IPC_EVENTS.workspaceChanged, handler),
    onFileChanged: (handler) =>
      subscribe<{ path: string; kind: 'created' | 'changed' | 'deleted' }>(IPC_EVENTS.fileChanged, handler),
    onMenuCommand: (handler) => subscribe<MenuCommand>(IPC_EVENTS.menuCommand, handler),
    onDebugState: (handler) => subscribe<DebugState>(IPC_EVENTS.debugStateChanged, handler),
    onDebugStopped: (handler) =>
      subscribe<{ reason: string; threadId: number | null }>(IPC_EVENTS.debugStopped, handler),
    onDebugOutput: (handler) => subscribe<{ category: string; text: string }>(IPC_EVENTS.debugOutput, handler),
    onAiDelta: (handler) => subscribe<AiStreamDelta>(IPC_EVENTS.aiDelta, handler),
    onAiEnd: (handler) => subscribe<AiStreamEnd>(IPC_EVENTS.aiEnd, handler),
    onMetricsSample: (handler) => subscribe<MetricsEvent>(IPC_EVENTS.metricsSample, handler),
    onUpdateState: (handler) => subscribe<UpdateState>(IPC_EVENTS.updateState, handler),
    onSearchProgress: (handler) => subscribe<SearchProgress>(IPC_EVENTS.searchProgress, handler),
    onTerminalData: (handler) => subscribe<TerminalDataEvent>(IPC_EVENTS.terminalData, handler),
    onTerminalExit: (handler) => subscribe<TerminalExitEvent>(IPC_EVENTS.terminalExit, handler),
  },
};

contextBridge.exposeInMainWorld('dotforge', api);
