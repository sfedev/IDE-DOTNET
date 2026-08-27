/**
 * Parte del renderer que no depende del DOM.
 *
 * Se compila como bundle aparte (`build/ui-lib.mjs`) para poder probar con Node puro la lógica
 * que decide iconos, insignias y anidamiento de archivos: son reglas con muchos casos borde y
 * merecen tests, no una inspección visual.
 */
export {
  iconForFile,
  iconForFolder,
  nestFiles,
  nestingParentsOf,
  presentProject,
} from './file-icons.js';
export type { IconSpec, ProjectPresentation, Tone, NestedNode } from './file-icons.js';
export { ICON_NAMES, ICON_SHAPES } from './icons.js';
export { containerOf } from './paths.js';
export {
  applySuggestion,
  caretAfterApply,
  endsInsideQuotes,
  ghostText,
  splitLine,
  suggest,
  SUGGESTION_SOURCES,
} from './terminal-suggest.js';
export type { Suggestion, SuggestContext, SuggestionKind } from './terminal-suggest.js';
export { debugChannelTransition, detectListeningUrl, portOf } from './run-output.js';
export type { DebugChannelTransition, DebugPhase } from './run-output.js';
export type { IconName } from './icons.js';

/**
 * Extracción de código y diferencias del asistente de IA.
 *
 * Vive aquí porque lo consume el renderer (el widget de Ctrl+I) y porque son reglas con muchos
 * casos borde —vallas anidadas, respuestas cortadas, reindentación— que merecen pruebas y no una
 * inspección visual.
 */
export {
  CODE_LANGUAGES,
  commonIndent,
  diffLines,
  extractCodeBlocks,
  formatUnifiedDiff,
  proposedCode,
  reindent,
  summarizeDiff,
} from '../shared/ai-diff.js';
export type { CodeBlock, DiffKind, DiffLine, DiffSummary } from '../shared/ai-diff.js';

/**
 * Estado del asistente en la barra de actividad.
 *
 * Es una regla de producto con consecuencias visibles —el icono se atenúa, no navega y explica
 * dónde encenderlo— y por eso vive en una función pura que se puede probar sin DOM.
 */
export { aiEntryState, aiActionBlockedReason, AI_DISABLED_MESSAGE } from './ai-availability.js';
export type { AiEntryState } from './ai-availability.js';

/**
 * Conservación del foco al repintar una vista entera.
 *
 * Las reglas viven aparte del DOM justamente para poder probarlas aquí: qué se anota, cuándo se
 * restaura y qué pasa cuando el texto ha cambiado entre la foto y la restauración.
 */
export { captureFocus, clampPosition, focusKeyOf, FOCUS_KEY_ATTRIBUTE, FOCUS_KEY_DATASET, restoreFocus } from './focus-guard.js';
export type { FocusableField, FocusSnapshot } from './focus-guard.js';

/**
 * Instalación de un paquete NuGet en varios proyectos.
 *
 * El progreso de una operación larga con varios pasos es justo donde se cuelan los errores de
 * estado —un paso que se queda en "ejecutando" para siempre, un contador que no cuadra—, así que
 * el modelo es puro y se prueba sin interfaz.
 */
export {
  createPlan,
  describeProgress,
  isComplete,
  markFailed,
  markRunning,
  nextPending,
  noteExit,
  PackageInstallError,
  runningStep,
  summarizeInstall,
} from '../shared/nuget-install.js';
export type {
  PackageInstallPlan,
  PackageInstallStep,
  PackageInstallSummary,
  PackageInstallTarget,
} from '../shared/nuget-install.js';

/**
 * Orden de la barra de actividad.
 *
 * Lo guardado lo puede haber escrito otra versión del IDE o una mano humana, así que normalizarlo
 * es una regla con casos borde de verdad: se prueba, no se supone.
 */
export {
  ACTIVITY_TOOLS,
  DEFAULT_ACTIVITY_ORDER,
  isActivityTool,
  isDefaultActivityOrder,
  moveActivityTool,
  normalizeActivityOrder,
  PINNED_ACTIVITY_TOOL,
} from '../shared/activity-bar.js';
export type { ActivityToolId } from '../shared/activity-bar.js';

/**
 * Cuándo se puede escribir en el editor.
 *
 * Es una regla con consecuencias muy visibles —un `readOnly` colado deja el editor mudo hasta
 * reiniciar— y por eso vive fuera de Monaco, en funciones puras que se prueban sin ventana.
 */
export {
  ConfirmationLock,
  DIFF_MESSAGE,
  EMPTY_CONTEXT,
  isReadOnly,
  NO_FILE_MESSAGE,
  PendingOperations,
  readOnlyMessage,
  unsavedChangesMessage,
} from './editor-state.js';
export type { EditorContext } from './editor-state.js';

/** Modelo del control de código fuente: lo consumen el panel lateral y el editor de diferencias. */
export {
  buildDiffRequest,
  describeLetter,
  diffKey,
  isValidBranchName,
  normalizeCommitMessage,
  parseGitStatus,
  syncSummary,
} from '../shared/git.js';
export type { GitDiffRequest, GitFileChange, GitRepositoryStatus } from '../shared/git.js';

/**
 * Gestor de Entity Framework Core.
 *
 * Parseo de la salida de `dotnet ef`, construcción de argumentos, cadenas de conexión y esquema
 * deducido de las migraciones: todo son funciones puras con muchos casos borde reales, así que se
 * prueban con Node pelado en vez de a ojo sobre un proyecto de verdad.
 */
export {
  describeConnection,
  detectProvider,
  efArgs,
  EF_OPERATIONS,
  EF_TOOL_MISSING_HINT,
  extractJsonBlock,
  isValidMigrationName,
  maskConnectionString,
  migrationName,
  migrationTimestamp,
  parseConnectionStrings,
  parseDbContexts,
  parseMigrations,
  stripJsonComments,
} from '../shared/efcore.js';
export type { ConnectionStringInfo, EfMigration, EfMigrationList, EfOperation } from '../shared/efcore.js';

export {
  buildSchema,
  describeColumn,
  EMPTY_SCHEMA,
  namedArguments,
  parseMigrationOperations,
  readBalanced,
  splitArguments,
  stringList,
  stringLiteral,
  upMethodBody,
} from '../shared/efcore-schema.js';
export type { DatabaseSchema, SchemaColumn, SchemaTable } from '../shared/efcore-schema.js';

/** Cliente HTTP: formato `.http`, resolución de variables y presentación de la respuesta. */
export {
  formatBytes as formatHttpBytes,
  formatDuration,
  HTTP_METHODS,
  isHttpFile,
  languageForContentType,
  parseHttpFile,
  prettyBody,
  requestAtLine,
  resolveRequest,
  resolveVariables,
  statusTone,
} from '../shared/http-file.js';
export type { HttpFileDocument, HttpRequestBlock, ResolvedHttpRequest } from '../shared/http-file.js';

/** Detección de endpoints en C# y generación de pruebas `.http`. */
export {
  buildHttpFile,
  collectGroups,
  controllerName,
  expandRouteTokens,
  fillRouteParameters,
  findControllerEndpoints,
  findEndpoints,
  findMinimalApiEndpoints,
  httpFileNameFor,
  joinRoutes,
  requestFor,
  sampleForParameter,
} from '../shared/api-endpoints.js';
export type { ApiEndpoint } from '../shared/api-endpoints.js';

/**
 * Visor de registro estructurado.
 *
 * El parseo de la salida de Serilog, NLog, la consola de .NET y CLEF, y el reconocimiento de los
 * marcos de pila. Son reglas sobre texto con formatos que conviven en la misma salida: se prueban
 * con capturas reales en vez de a ojo.
 */
export {
  countByLevel,
  filterEvents,
  firstNavigableFrame,
  isAtLeast,
  isExceptionLine,
  LEVEL_LABEL,
  LOG_LEVELS,
  parseLogEvents,
  parseStackFrame,
  toLevel,
} from '../shared/log-events.js';
export type { LogEvent, LogLevel, StackFrame } from '../shared/log-events.js';

/** Linter de reglas de arquitectura: capas, dependencias permitidas y paquetes del núcleo. */
export {
  checkPackages,
  checkProjectReferences,
  checkSolution,
  checkUsings,
  isDependencyAllowed,
  isInfrastructurePackage,
  LAYER_LABEL,
  layerOfProject,
  projectOfFile,
  readUsings,
} from '../shared/architecture-rules.js';
export type { ArchitectureViolation, Layer } from '../shared/architecture-rules.js';

/** Modelo de Docker: parseo de la salida de la CLI y servicios de apoyo reconocidos. */
export {
  defaultPortOf,
  imageName,
  localUrlOf,
  parseContainers,
  parseImages,
  parseLabels,
  parsePorts,
  supportKindOf,
  supportLabel,
} from '../shared/docker.js';
export type { ContainerState, DockerContainer, DockerImage, SupportKind } from '../shared/docker.js';

/** Docker Compose: YAML mínimo, servicios declarados y construcción de comandos. */
export {
  COMPOSE_FILE_NAMES,
  composeArgs,
  containerArgs,
  isComposeFile,
  parseCompose,
  matchComposeState,
  parseComposePorts,
  parseYaml,
  scalar,
} from '../shared/compose.js';
export type {
  ComposeAction,
  ComposeFile,
  ComposeService,
  ComposeState,
  ContainerAction,
  ServiceStatus,
} from '../shared/compose.js';

/**
 * Tokens semánticos: descodificación del formato relativo de LSP y traducción de la clasificación
 * de Roslyn a los ámbitos del tema. Es aritmética con desplazamientos donde un error no falla,
 * sólo tiñe mal: se prueba con datos.
 */
export {
  CLIENT_TOKEN_MODIFIERS,
  CLIENT_TOKEN_TYPES,
  decodeTokens,
  encodeTokens,
  legendFromCapabilities,
  normalizeTokenType,
  remapTokens,
  scopeForTokenType,
  SEMANTIC_SCOPES,
} from '../shared/semantic-tokens.js';
export type { SemanticScope, SemanticToken, SemanticTokensLegend } from '../shared/semantic-tokens.js';

/**
 * Explorador de pruebas: descubrimiento por texto, árbol, filtros de VSTest y lectura de
 * resultados. Todo son reglas sobre texto con casos borde reales.
 */
export {
  aggregateStatus,
  attributeNames,
  baseTestId,
  buildTestTree,
  collapseResults,
  describeSummary,
  escapeFilterValue,
  filterForClass,
  filterForTests,
  findTests,
  looksLikeTestFile,
  namedArgument,
  outcomeToStatus,
  parseConsoleResults,
  parseDuration,
  qualify,
  summarize,
  testRunArgs,
} from '../shared/test-explorer.js';
export type { TestCase, TestResult, TestRunSummary, TestStatus } from '../shared/test-explorer.js';

/** Túneles públicos: argumentos, reconocimiento de la URL y el escáner con búfer de líneas. */
export {
  detectTunnelUrl,
  isValidPort,
  missingToolMessage,
  TUNNEL_TOOLS,
  TUNNEL_WARNING,
  TunnelOutputScanner,
  tunnelArgs,
  tunnelInfo,
} from '../shared/dev-tunnel.js';
export type { TunnelState, TunnelTool } from '../shared/dev-tunnel.js';

/** Monitor de rendimiento: parseo de `dotnet-counters` y geometría del gráfico. */
export {
  applySamples,
  counterUnit,
  countersCollectArgs,
  COUNTERS_REFRESH_SECONDS,
  COUNTER_PROVIDERS,
  mappingForCounter,
  parseCounterName,
  fillRatio,
  formatMetric,
  METRICS,
  metricForCounter,
  metricInfo,
  parseCounterSamples,
  parseCounterValue,
  parseDotnetProcesses,
  pushPoint,
  sparklinePath,
  stripAnsi,
} from '../shared/perf-counters.js';
export type { CounterSample, MetricId, MetricsSnapshot, MetricsState } from '../shared/perf-counters.js';

/** Auditoría de seguridad de NuGet: JSON del SDK, tabla degradada y orden por gravedad. */
export {
  advisoryIdentifier,
  auditArgs,
  AUDIT_RESTORE_HINT,
  coerceSeverity,
  countBySeverity,
  describeAudit,
  parseVulnerableJson,
  parseVulnerableText,
  severityRank,
  SEVERITY_LABEL,
  sortPackages,
  worstSeverity,
} from '../shared/nuget-audit.js';
export type { AuditReport, VulnerablePackage, VulnerabilitySeverity } from '../shared/nuget-audit.js';

/**
 * Fase 17 — actualizaciones automáticas y registro de extensiones.
 *
 * Los tres modelos son puros y tienen mucho caso borde: SemVer con prelanzamientos, artefactos por
 * plataforma y arquitectura, respuestas del registro y manifiestos de `.vsix`. Se prueban con
 * respuestas reales y sin red.
 */
export {
  assetFor,
  compareVersions,
  emptyUpdateState,
  installPlan,
  isNewerVersion,
  parseReleaseFeed,
  parseVersion,
  releaseNotesLines,
  selectUpdate,
  STARTUP_CHECK_DELAY_MS,
  updateHeadline,
  UPDATE_FEED,
} from '../shared/updates.js';
export type { InstallPlan, ReleaseAsset, ReleaseInfo, SemanticVersion, UpdateState } from '../shared/updates.js';

export {
  downloadUrl,
  extensionHue,
  extensionId,
  extensionInitials,
  extensionUrl,
  EXTENSION_CATEGORIES,
  formatDownloads,
  formatRating,
  isTrustedDownload,
  isValidSegment,
  OPEN_VSX_API,
  parseExtension,
  parseExtensionId,
  parseSearch,
  searchUrl,
  SEARCH_PAGE_SIZE,
} from '../shared/open-vsx.js';
export type { MarketplaceExtension, SearchQuery, SearchResult } from '../shared/open-vsx.js';

export {
  describeContributions,
  extensionFolderName,
  hasNewerVersion,
  installedFrom,
  isExtensionEntry,
  manifestId,
  parseVsixManifest,
  sortInstalled,
  STATIC_CONTRIBUTIONS,
  VsixError,
  VSIX_MANIFEST,
  VSIX_ROOT,
} from '../shared/vsix.js';
export type { ContributionSummary, InstalledExtension, VsixManifest } from '../shared/vsix.js';

/**
 * Contribuciones declarativas de las extensiones: temas y fragmentos.
 *
 * Es un modelo puro y lo consumen los dos lados —el proceso principal lee los archivos y convierte,
 * el renderer decide el aspecto del IDE y filtra los identificadores—, así que se exporta desde
 * aquí para poder probar la conversión con temas reales sin tocar el disco.
 */
export {
  chromeThemeFor,
  convertTheme,
  EXTENSION_THEME_PREFIX,
  isExtensionTheme,
  monacoBaseFor,
  monacoThemeName,
  normalizeColor,
  normalizeColorWithHash,
  parseContributedSnippets,
  parseContributedThemes,
  parseSnippetFile,
  themeId,
} from '../shared/vsix-contributions.js';
export type {
  CodeSnippet,
  ContributedSnippetFile,
  ContributedTheme,
  MonacoThemeData,
  MonacoTokenRule,
  VsCodeThemeDocument,
} from '../shared/vsix-contributions.js';
