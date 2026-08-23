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
export { detectListeningUrl, portOf } from './run-output.js';
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
