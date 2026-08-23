/** API pública del módulo de scaffolding. */
export { generateSolution, ScaffoldError } from './generator.js';
export { ARCHITECTURE_IDS, BLUEPRINTS, getBlueprint, isArchitectureId, listBlueprints } from './blueprints/index.js';
export { buildTemplateContext, packageVersionsFor, resolveOptions } from './context.js';
export type { ResolvedOptions, PackageVersions } from './context.js';
export { inspectTemplate, normalizeOutput, parseTemplate, renderPath, renderTemplate, TemplateError } from './engine.js';
export {
  deterministicGuid,
  NamingError,
  pluralize,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  validateEntityName,
  validateSolutionName,
} from './naming.js';
export { renderSolutionFile } from './solution-file.js';
export { resolveTemplatesRoot } from './template-root.js';
export * from '../shared/scaffold-types.js';
