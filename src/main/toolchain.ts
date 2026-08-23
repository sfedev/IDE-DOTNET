/**
 * Punto de entrada del toolchain externo, aislado del resto del proceso principal.
 *
 * Ni la adquisición del servidor de lenguaje ni la del depurador importan `electron`, así que
 * este módulo se puede compilar como bundle independiente y usarse desde scripts de Node
 * (`npm run fetch:toolchain`) y desde los tests, sin arrancar la aplicación.
 */
export { acquireLanguageServer, currentRid, pickLatestVersion } from './lsp/acquire.js';
export type { AcquiredServer, ServerKind } from './lsp/acquire.js';
export { acquireDebugger, assetNameForPlatform } from './debug/netcoredbg.js';
export type { DebuggerBinary } from './debug/netcoredbg.js';
export { extractTo, listEntries, readEntry, sha256, ZipError } from './services/zip.js';
export { DebugController, resolveDebugTarget } from './debug/debug-controller.js';
export { DebugSession } from './debug/netcoredbg.js';
