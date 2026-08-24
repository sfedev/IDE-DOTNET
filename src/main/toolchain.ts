/**
 * Punto de entrada del toolchain externo, aislado del resto del proceso principal.
 *
 * Ni la adquisición del servidor de lenguaje ni la del depurador importan `electron`, así que
 * este módulo se puede compilar como bundle independiente y usarse desde scripts de Node
 * (`npm run fetch:toolchain`) y desde los tests, sin arrancar la aplicación.
 */
export {
  acquireLanguageServer,
  acquireOmniSharpServer,
  auditInstall,
  currentRid,
  discardInstall,
  pardonRoslynVersion,
  quarantineRoslynVersion,
  readQuarantine,
  roslynFeedVersions,
} from './lsp/acquire.js';
export type { AcquiredServer, AcquireOptions, ServerKind } from './lsp/acquire.js';

/**
 * Política de versiones del servidor de Roslyn y salud del proceso hijo: puras las dos, y las dos
 * con muchos casos borde —763 versiones reales en el feed, trozos de stderr partidos por la mitad—
 * que se prueban con Node pelado.
 */
export {
  compareRoslynVersions,
  describeSelection,
  isUnstableVersion,
  parseRoslynVersion,
  pickLatestVersion,
  ROSLYN_PINNED_VERSION,
  ROSLYN_VERIFIED_VERSIONS,
  selectRoslynVersion,
  UNSTABLE_MARKERS,
} from '../shared/lsp-versions.js';
export type { RoslynSelection, RoslynSelectionReason, RoslynVersion } from '../shared/lsp-versions.js';

export {
  addQuarantineEntry,
  createServerLogScanner,
  describeFault,
  FATAL_SIGNATURES,
  isFatalLevel,
  logLevelOf,
  MAX_QUARANTINE_ENTRIES,
  parseQuarantine,
  quarantinedVersions,
  removeQuarantineEntry,
  serializeQuarantine,
} from '../shared/lsp-health.js';
export type { QuarantineEntry, QuarantineRecord, ServerFault, ServerFaultCategory } from '../shared/lsp-health.js';

/**
 * Lo que el cliente contesta a las peticiones del servidor. Pequeño y purísimo, y aun así es donde
 * estaba el fallo que apagaba Roslyn justo después de decir que estaba listo.
 */
export { configurationResponse, serverRequestResponse } from '../shared/lsp-protocol.js';

/**
 * Cabeceras del toolchain y dónde puede viajar el token de GitHub. Es puro y es la pieza que hay
 * que poder probar sin red: decide si una credencial sale del proceso y hacia qué host.
 */
export {
  githubToken,
  GITHUB_ACCEPT,
  GITHUB_API_HOST,
  isGitHubApi,
  rateLimitHint,
  requestHeaders,
  USER_AGENT,
} from '../shared/github-api.js';

export {
  buildManifest,
  describeProblems,
  diffInstall,
  MANIFEST_FILE,
  parseManifest,
  serializeManifest,
} from '../shared/toolchain-manifest.js';
export type { InstallManifest, InstallProblem, ManifestFile } from '../shared/toolchain-manifest.js';

/** Instalación verificable: se ejercita contra un ZIP de mentira en un directorio temporal. */
export { installArchive, readInstallManifest, removeInstall, verifyInstall } from './services/toolchain-install.js';
export { acquireDebugger, assetNameForPlatform, debuggerSourcePath } from './debug/netcoredbg.js';
export type { DebuggerBinary } from './debug/netcoredbg.js';
export { extractTo, listEntries, readEntry, sha256, ZipError } from './services/zip.js';
export { DebugController, resolveDebugTarget } from './debug/debug-controller.js';
export { DebugSession } from './debug/netcoredbg.js';
