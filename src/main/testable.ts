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
export { findSolutionFile, loadSolution, readProject, IGNORED_DIRECTORIES } from './services/solution-service.js';
export { languageIdFor } from './services/file-service.js';
export { ALLOWED_COMMANDS, CommandError, tokenize } from './services/command-runner.js';
