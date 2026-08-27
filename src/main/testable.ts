/**
 * Parte del proceso principal que no depende de Electron.
 *
 * Se compila como bundle aparte (`build/main-lib.mjs`) para que los tests puedan ejercitar la
 * validación de rutas, el parseo de .sln/.csproj y el de diagnósticos de MSBuild con Node puro,
 * sin arrancar la aplicación ni necesitar un display.
 */
export {
  allowRoot,
  assertInsideWorkspace,
  clearExtraRoots,
  getWorkspaceRoot,
  isInside,
  PathAccessError,
  setWorkspaceRoot,
  toWorkspaceRelative,
} from './services/workspace-guard.js';

export { detectApplicationUrl, parseMsBuildDiagnostics, summarize } from './services/msbuild-diagnostics.js';
/**
 * El servicio de git entero: no importa `electron`, sólo `node:child_process`, así que las
 * pruebas pueden ejercitarlo contra un repositorio de verdad creado en un directorio temporal.
 * Es la única forma honesta de comprobar que preparar, confirmar y descartar hacen lo que dicen.
 */
export * as gitService from './services/git-service.js';
export { toRepositoryPaths } from './services/git-service.js';
export { findSolutionFile, loadSolution, readProject, IGNORED_DIRECTORIES } from './services/solution-service.js';
export { languageIdFor } from './services/file-service.js';

/**
 * Gestor de EF Core y cliente HTTP: ninguno importa `electron`, así que las pruebas pueden
 * ejercitarlos de verdad —leyendo migraciones de un directorio temporal y hablando con un
 * servidor HTTP de mentira— en vez de comprobar sólo el parser.
 */
export {
  readConnectionStrings,
  readMigrationSources,
  readSchema,
} from './services/efcore-service.js';
export { coerceRequest, HttpRequestError, isLocalHost, sendRequest } from './services/http-client-service.js';

/** Docker y los scripts de npm: tampoco importan `electron`. */
export {
  findComposeFiles,
  readComposeFile,
  readNames,
  readState,
  invalidate as invalidateDocker,
} from './services/docker-service.js';
export { readNpmScripts } from './services/node-scripts.js';
export { describeRecents, firstAvailable, isOpenableWorkspace } from './services/workspace-recents.js';
export { ALLOWED_COMMANDS, CommandError, tokenize } from './services/command-runner.js';

/**
 * Sesión de la terminal: el directorio de trabajo y las órdenes que no lanzan proceso.
 *
 * Se exporta el módulo entero porque su estado es de sesión (dónde está el usuario) y las pruebas
 * necesitan poder fijarlo, moverlo y devolverlo a cero.
 */
/**
 * Navegación de la terminal: qué línea es un `cd` y cómo se enseña la ruta en el prompt.
 *
 * Lo consume el proceso principal —es él quien resuelve contra el disco y quien compone el prompt
 * que manda al renderer—, así que se prueba desde este bundle y no desde el de la interfaz.
 */
export {
  classifyLine,
  elide,
  isBareDrive,
  isInsideDirectory,
  resolveTarget,
  shortenPath,
  TerminalCwdError,
} from '../shared/terminal-cwd.js';
export type { DirectoryTarget, ResolveContext, ShortenOptions, TerminalIntent } from '../shared/terminal-cwd.js';

export * as terminalSession from './services/terminal-session.js';

/**
 * Fase 21 - perfiles de terminal y sesiones de pseudoterminal.
 *
 * El catalogo es dato puro; el servicio no importa `electron`, asi que las pruebas pueden abrir un
 * interprete de verdad en un directorio temporal y comprobar que escribe, que responde y que al
 * cerrarlo no queda nada vivo. Es la unica forma honesta de probar una terminal.
 */
export {
  coerceProfileId,
  defaultProfileId,
  findProfile,
  launchCandidates,
  profilesFor,
  resolveLaunch,
  TERMINAL_PROFILES,
  terminalTabName,
  unavailableReason,
} from '../shared/terminal-profiles.js';
export type { TerminalKind, TerminalLaunch, TerminalProfile } from '../shared/terminal-profiles.js';

export * as ptyService from './services/terminal-pty-service.js';
export { MAX_PTY_SESSIONS, MAX_WRITE_CHARS, PtyUnavailableError } from './services/terminal-pty-service.js';

/**
 * Disposición de las pestañas de terminal por solución.
 *
 * El modelo es puro y el almacén escribe un JSON en `userData`: se exporta el módulo entero porque
 * su estado es de proceso (lo leído, cacheado) y las pruebas necesitan poder inicializarlo contra
 * un directorio temporal y volver a leer del disco.
 */
export {
  coerceIncomingLayout,
  coerceStoredLayout,
  emptyLayout,
  isRestorable,
  MAX_REMEMBERED_WORKSPACES,
  MAX_RESTORED_TABS,
  restorablePlan,
} from '../shared/terminal-layout.js';
export type { TerminalLayout } from '../shared/terminal-layout.js';

export * as terminalLayoutStore from './services/terminal-layout-store.js';

/**
 * Contenido de la barra de menú.
 *
 * Vive como dato puro para poder comprobar lo que se rompe en silencio: un menú que manda un
 * comando que el renderer no conoce, o dos entradas peleándose por el mismo acelerador.
 */
export {
  acceleratorClashes,
  acceleratorOf,
  buildMenuTemplate,
  commandsOf,
  normalizeAccelerator,
  ROLE_ACCELERATORS,
} from '../shared/menu-template.js';
export type { MenuEntry, MenuSection, MenuTemplateOptions } from '../shared/menu-template.js';
export type { SessionContext, TerminalLineOutcome } from './services/terminal-session.js';
export {
  environmentFromProfile,
  parseLaunchSettings,
  readLaunchEnvironment,
  selectProfile,
  servesHttps,
} from './services/launch-settings.js';

/**
 * Construcción de la línea de argumentos de una tarea de .NET.
 *
 * Se exporta para poder afirmar en una prueba **el orden exacto** de lo que se le pasa a `dotnet`:
 * el perfil de arranque, la verbosidad y los argumentos extra tienen cada uno su sitio, y
 * equivocarse de sitio no da error —la bandera se le pasa a la aplicación hija en vez de a la CLI
 * y no pasa nada visible—.
 */
export { buildArgs as dotnetTaskArgs, launchProfileArgs, LONG_RUNNING } from './services/dotnet-service.js';

/** Lectura de JSON escrito por otras herramientas: la marca de orden de bytes de Windows. */
export { BOM, parseJsonText, stripBom } from '../shared/json-text.js';

// --- Asistente de IA -----------------------------------------------------------------------
// Sólo las piezas puras. `secret-store.ts` y `ai-service.ts` quedan fuera a propósito: el primero
// importa `safeStorage` de Electron y el segundo abre sockets, y este bundle debe correr con Node
// pelado.
export {
  buildChatRequest,
  buildProbeRequest,
  supportsEffort,
} from './services/ai/request-builder.js';
export type { AiHttpRequest, ChatRequestInput } from './services/ai/request-builder.js';

export {
  createStreamParser,
  describeApiError,
  describeHttpStatus,
} from './services/ai/stream-parser.js';
export type { AiStreamEvent, StreamParser } from './services/ai/stream-parser.js';

// El cliente de streaming entero: sin dependencia de Electron gracias a la inyección de la
// fuente de credenciales, así que se puede ejercitar contra un servidor de mentira.
export {
  cancel as cancelAiRequest,
  cancelAll as cancelAllAiRequests,
  chat as aiChat,
  probe as aiProbe,
  setCredentialSource,
  status as aiStatus,
} from './services/ai/ai-service.js';
export type { AiCallbacks, CredentialSource } from './services/ai/ai-service.js';

export { coerceAiSettings, coerceBaseUrl, MAX_MAX_TOKENS, MIN_MAX_TOKENS } from './services/ai/preferences.js';
export { AiRequestError, coerceChatRequest, MAX_MESSAGES, MAX_MESSAGE_CHARS } from './services/ai/validate.js';

export {
  architectureLabel,
  architectureRules,
  buildContext,
  composeUserMessage,
  detectArchitecture,
  layerOf,
  projectContexts,
  relativeTo,
  renderContextBlock,
  systemPrompt,
  windowAround,
  MAX_DIAGNOSTICS,
  MAX_FILE_CHARS,
  MAX_SELECTION_CHARS,
} from '../shared/ai-context.js';

export {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  DEFAULT_AI_SETTINGS,
  modelInfo,
  providerInfo,
  resolveBaseUrl,
  resolveModel,
} from '../shared/ai.js';
export type { AiContext, AiProviderId, AiSettings, AiTask } from '../shared/ai.js';

export {
  availableProfiles,
  coerceStartupConfig,
  DEFAULT_STARTUP_CONFIG,
  implicitProfile,
  isRunnableProject,
  launchPlan,
  nextProfileId,
  resolveActiveProfile,
  runnableProjects,
  shortProjectName,
  suggestProfileName,
} from '../shared/startup.js';
export type { LaunchStep, RunMode, StartupConfig, StartupProfile } from '../shared/startup.js';

// --- Control de código fuente ------------------------------------------------------------------
// El parseo de `git status`, la construcción del diff y la validación de nombres y mensajes son
// funciones puras: se ejercitan con salidas reales de git capturadas en las pruebas, sin repo.
export {
  buildDiffRequest,
  describeCount,
  describeLetter,
  diffKey,
  EMPTY_GIT_STATUS,
  isValidBranchName,
  MAX_COMMIT_MESSAGE_CHARS,
  normalizeCommitMessage,
  parseBranchLine,
  parseGitStatus,
  revisionFor,
  syncSummary,
  unquotePath,
} from '../shared/git.js';
export type {
  GitBranchState,
  GitChangeArea,
  GitChangeLetter,
  GitDiffRequest,
  GitDiffSide,
  GitFileChange,
  GitRepositoryStatus,
  GitSyncSummary,
} from '../shared/git.js';

// --- Verbosidad de la CLI de .NET ----------------------------------------------------------------
export {
  coerceVerbosity,
  debugEnvironment,
  DEFAULT_DOTNET_VERBOSITY,
  describeVerbosity,
  DOTNET_VERBOSITY_INFO,
  DOTNET_VERBOSITY_LEVELS,
  verbosityEnvironment,
  verbosityInfo,
  verbosityPlan,
} from '../shared/dotnet-verbosity.js';
export type { DotnetVerbosity, DotnetVerbosityPlan } from '../shared/dotnet-verbosity.js';

export { DEFAULT_SETTINGS } from '../shared/contracts.js';

/**
 * Explorador de pruebas: el descubrimiento recorre el disco y la lectura de resultados parsea el
 * TRX. Ninguno importa `electron`, así que las pruebas pueden ejercitarlos contra archivos de
 * verdad en un directorio temporal.
 */
export { discoverProjectTests, discoverTests, parseTrx } from './services/test-service.js';

/**
 * Fase 17 — instalación de extensiones `.vsix`.
 *
 * El servicio no importa `electron` a propósito: la ruta de `userData` se le inyecta, así que las
 * pruebas pueden instalar un `.vsix` de mentira en un directorio temporal y comprobar lo que queda
 * en el disco, en vez de fiarse de que "debería funcionar".
 */
export {
  extensionsDirectory,
  findInstalled,
  initialize as initializeExtensions,
  installFromBuffer,
  listInstalled,
  readVsixManifest,
  uninstall as uninstallExtension,
} from './services/extension-installer.js';
export type { InstallOutcome } from './services/extension-installer.js';

/**
 * Fase 20 — búsqueda de texto en los archivos del workspace.
 *
 * El modelo es puro y el servicio no importa `electron`: la raíz se le pasa, así que las pruebas
 * pueden buscar en un árbol de verdad creado en un directorio temporal en vez de fingir `fs`.
 */
export {
  buildSearchRegExp,
  coerceSearchOptions,
  compileGlobs,
  DEFAULT_SEARCH_OPTIONS,
  describeResults,
  escapeRegExp,
  globToRegExp,
  hasBinaryExtension,
  looksBinary,
  matchesGlobs,
  matchesInLine,
  MAX_SEARCHABLE_BYTES,
  parseGlobList,
  previewOf,
  searchContent,
  SearchPatternError,
  SEARCH_SKIPPED_DIRECTORIES,
  shouldSkipDirectory,
  splitLines,
} from '../shared/file-search.js';
export type {
  GlobFilter,
  SearchFileResult,
  SearchMatch,
  SearchOptions,
  SearchProgress,
  SearchSummary,
} from '../shared/file-search.js';

export * as searchService from './services/search-service.js';
