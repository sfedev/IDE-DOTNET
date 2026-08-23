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
