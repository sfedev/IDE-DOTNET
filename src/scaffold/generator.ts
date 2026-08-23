/**
 * Generador de soluciones. Es el corazón del módulo estrella de DotForge IDE.
 *
 * Flujo: validar opciones -> construir contexto -> recorrer plantillas -> renderizar rutas y
 * contenidos -> escribir -> emitir el .sln -> escribir el manifiesto -> (opcional) git init.
 *
 * No importa `electron`: se ejecuta igual desde la CLI, desde los tests y desde el proceso main.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { ScaffoldOptions, ScaffoldResult } from '../shared/scaffold-types.js';
import { getBlueprint } from './blueprints/index.js';
import type { Blueprint } from './blueprints/types.js';
import type { ResolvedOptions } from './context.js';
import { buildTemplateContext, resolveOptions } from './context.js';
import { renderPath, renderTemplate, TemplateError } from './engine.js';
import { deterministicGuid } from './naming.js';
import type { SolutionProjectEntry } from './solution-file.js';
import { renderSolutionFile } from './solution-file.js';
import { resolveTemplatesRoot } from './template-root.js';

const execFileAsync = promisify(execFile);

const TEMPLATE_EXTENSION = '.tmpl';

/** Extensiones que se escriben con CRLF, por convención del ecosistema .NET en Windows. */
const CRLF_EXTENSIONS = new Set(['.cs', '.csproj', '.props', '.targets', '.razor', '.sln']);

export class ScaffoldError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

interface TemplateFile {
  /** Ruta absoluta del archivo .tmpl. */
  absolute: string;
  /** Ruta relativa a la raíz del set de plantillas, sin la extensión .tmpl. */
  relative: string;
}

async function collectTemplates(root: string): Promise<TemplateFile[]> {
  const results: TemplateFile[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(TEMPLATE_EXTENSION)) {
        const rel = relative(root, absolute).split(sep).join('/');
        results.push({ absolute, relative: rel.slice(0, -TEMPLATE_EXTENSION.length) });
      }
    }
  }

  await walk(root);
  results.sort((a, b) => a.relative.localeCompare(b.relative));
  return results;
}

async function ensureOutputDirectory(rootDir: string, force: boolean): Promise<void> {
  if (!existsSync(rootDir)) {
    await mkdir(rootDir, { recursive: true });
    return;
  }

  const info = await stat(rootDir);
  if (!info.isDirectory()) {
    throw new ScaffoldError(`la ruta de destino existe y no es un directorio: ${rootDir}`);
  }

  const entries = await readdir(rootDir);
  if (entries.length === 0) return;

  if (!force) {
    throw new ScaffoldError(
      `el directorio de destino no está vacío: ${rootDir}\n` +
        'Usa --force para sobrescribirlo o elige otro nombre de solución.',
    );
  }

  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
}

function projectEntries(blueprint: Blueprint, resolved: ResolvedOptions): SolutionProjectEntry[] {
  const tokens = { Solution: resolved.solutionName, Entity: resolved.entity, EntityPlural: resolved.entityPlural };

  return blueprint.projects
    .filter((project) => (project.when ? project.when(resolved) : true))
    .map((project) => {
      const name = renderPath(project.name, tokens);
      const dir = renderPath(project.dir, tokens);
      return {
        name,
        path: `${dir}/${name}.csproj`,
        layer: project.layer,
        solutionFolder: project.solutionFolder,
        guid: deterministicGuid(`${resolved.solutionName}::${name}`),
      };
    });
}

function normalizeEol(content: string, targetPath: string): string {
  const dot = targetPath.lastIndexOf('.');
  const extension = dot >= 0 ? targetPath.slice(dot) : '';
  return CRLF_EXTENSIONS.has(extension) ? content.replace(/\n/g, '\r\n') : content;
}

async function tryGitInit(rootDir: string, warnings: string[]): Promise<void> {
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: rootDir });
    await execFileAsync('git', ['add', '.'], { cwd: rootDir });
    await execFileAsync(
      'git',
      ['-c', 'user.name=DotForge IDE', '-c', 'user.email=dev@dotforge.local',
       'commit', '--quiet', '-m', 'chore: solución inicial generada con DotForge IDE'],
      { cwd: rootDir },
    );
  } catch (error) {
    warnings.push(
      `no se pudo inicializar el repositorio git: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Comandos sugeridos al usuario. Los proyectos de presentación se deducen de la lista real de
 * proyectos generados, no de convenciones de nombre por arquitectura: así añadir un blueprint
 * nuevo no obliga a tocar esta función.
 */
function buildNextSteps(
  resolved: ResolvedOptions,
  rootDir: string,
  projects: SolutionProjectEntry[],
): string[] {
  const steps = [`cd "${rootDir}"`, 'dotnet restore', 'dotnet build'];

  if (resolved.includeTests) steps.push('dotnet test');

  const presentation = projects.filter((project) => project.layer !== 'Tests');
  const webProject = presentation.find((project) => /(WebApi|Adapters\.Web)$/.test(project.name));
  const blazorProject = presentation.find((project) => /Blazor$/.test(project.name));

  if (webProject) {
    steps.push(`dotnet run --project ${dirname(webProject.path)}`);
  }
  if (blazorProject) {
    steps.push(`dotnet watch --project ${dirname(blazorProject.path)}`);
  }

  return steps;
}

/**
 * Genera la solución completa en disco.
 *
 * @param options   opciones de usuario (se validan aquí; no hace falta pre-validar)
 * @param baseDir   directorio desde el que resolver las plantillas (normalmente `__dirname`)
 */
export async function generateSolution(options: ScaffoldOptions, baseDir: string): Promise<ScaffoldResult> {
  const startedAt = Date.now();
  const resolved = resolveOptions(options);
  const blueprint = getBlueprint(resolved.architecture);

  const templatesRoot = resolveTemplatesRoot(baseDir);
  const rootDir = resolve(options.outputDir, resolved.solutionName);
  const warnings: string[] = [];

  await ensureOutputDirectory(rootDir, resolved.force);

  const context = buildTemplateContext(resolved, new Date().getFullYear());
  const pathTokens = {
    Solution: resolved.solutionName,
    Entity: resolved.entity,
    EntityPlural: resolved.entityPlural,
    entity: String(context.tokens['entity']),
    entityPlural: String(context.tokens['entityPlural']),
  };

  const commonTemplates = await collectTemplates(join(templatesRoot, '_common'));
  const architectureRoot = join(templatesRoot, blueprint.templateDir);
  if (!existsSync(architectureRoot)) {
    throw new ScaffoldError(
      `la arquitectura "${resolved.architecture}" no tiene plantillas en ${architectureRoot}`,
    );
  }
  const architectureTemplates = await collectTemplates(architectureRoot);

  const written: string[] = [];
  let totalBytes = 0;

  const emit = async (template: TemplateFile, applyFilter: boolean): Promise<void> => {
    if (applyFilter && !blueprint.includeFile(template.relative, resolved)) return;

    let rendered: string;
    let targetRelative: string;
    try {
      targetRelative = renderPath(template.relative, pathTokens);
      const source = await readFile(template.absolute, 'utf8');
      rendered = renderTemplate(source, context);
    } catch (error) {
      const detail = error instanceof TemplateError || error instanceof Error ? error.message : String(error);
      throw new ScaffoldError(`error al procesar la plantilla "${template.relative}": ${detail}`, error);
    }

    const targetPath = join(rootDir, ...targetRelative.split('/'));
    await mkdir(dirname(targetPath), { recursive: true });

    const content = normalizeEol(rendered, targetPath);
    await writeFile(targetPath, content, 'utf8');

    written.push(targetRelative);
    totalBytes += Buffer.byteLength(content, 'utf8');
  };

  for (const template of commonTemplates) await emit(template, false);
  for (const template of architectureTemplates) await emit(template, true);

  // --- Archivo de solución ---------------------------------------------------------------
  const projects = projectEntries(blueprint, resolved);
  const solutionRelative = `${resolved.solutionName}.sln`;
  const solutionFile = join(rootDir, solutionRelative);
  const solutionContent = renderSolutionFile(resolved.solutionName, projects);
  await writeFile(solutionFile, solutionContent, 'utf8');
  written.push(solutionRelative);
  totalBytes += Buffer.byteLength(solutionContent, 'utf8');

  // --- Manifiesto: permite al IDE reabrir el wizard con las mismas opciones ---------------
  const manifest = {
    generator: 'DotForge IDE',
    generatorVersion: '1.0.0',
    generatedAtUtc: new Date().toISOString(),
    architecture: resolved.architecture,
    solutionName: resolved.solutionName,
    framework: resolved.framework,
    ui: resolved.ui,
    database: resolved.db,
    entity: resolved.entity,
    includeTests: resolved.includeTests,
    projects: projects.map((project) => ({ name: project.name, path: project.path, layer: project.layer })),
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(rootDir, 'dotforge.json'), manifestContent, 'utf8');
  written.push('dotforge.json');
  totalBytes += Buffer.byteLength(manifestContent, 'utf8');

  if (resolved.gitInit) await tryGitInit(rootDir, warnings);

  const missingProjectFiles = projects.filter((project) => !existsSync(join(rootDir, ...project.path.split('/'))));
  if (missingProjectFiles.length > 0) {
    throw new ScaffoldError(
      'la solución declara proyectos sin archivo .csproj generado: ' +
        missingProjectFiles.map((project) => project.path).join(', ') +
        '. Revisa el blueprint y sus plantillas.',
    );
  }

  return {
    ok: true,
    architecture: resolved.architecture,
    solutionName: resolved.solutionName,
    rootDir,
    solutionFile,
    projects: projects.map(({ name, path, layer, guid }) => ({ name, path, layer, guid })),
    files: written.sort(),
    totalBytes,
    durationMs: Date.now() - startedAt,
    warnings,
    nextSteps: buildNextSteps(resolved, rootDir, projects),
  };
}
