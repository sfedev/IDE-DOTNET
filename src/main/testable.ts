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
export { readNames, readState, invalidate as invalidateDocker } from './services/docker-service.js';
export { readNpmScripts } from './services/node-scripts.js';
export { describeRecents, firstAvailable, isOpenableWorkspace } from './services/workspace-recents.js';
export { ALLOWED_COMMANDS, CommandError, tokenize } from './services/command-runner.js';
export {
  environmentFromProfile,
  parseLaunchSettings,
  readLaunchEnvironment,
  selectProfile,
} from './services/launch-settings.js';

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
