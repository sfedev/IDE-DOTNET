/**
 * Explorador de pruebas: descubrimiento en disco y ejecución con resultados estructurados.
 *
 * Reparto de responsabilidades, el mismo de EF Core y del control de fuentes:
 *  - **el modelo es puro** y vive en `src/shared/test-explorer.ts` (qué es una prueba, cómo se
 *    construye un filtro, cómo se resume una ejecución);
 *  - **este archivo toca el disco y lanza procesos**: recorre los proyectos de pruebas leyendo sus
 *    `.cs`, lanza `dotnet test` por el canal de tareas y lee el TRX que deja.
 *
 * El descubrimiento **no compila nada**. Un `dotnet test --list-tests` tarda lo que tarde el build
 * de la solución; el árbol tiene que estar lleno nada más abrirla y la lente tiene que aparecer
 * mientras se escribe el `[Fact]`.
 *
 * La ejecución sí es real, y su salida va al canal de tareas como cualquier compilación: `dotnet
 * test` puede tardar minutos y hay que poder verlo y cancelarlo.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import type { DotnetTaskStarted } from '../../shared/contracts.js';
import type { TestCase, TestResult, TestRunSummary } from '../../shared/test-explorer.js';
import {
  collapseResults,
  EMPTY_SUMMARY,
  findTests,
  looksLikeTestFile,
  outcomeToStatus,
  parseConsoleResults,
  parseDuration,
  summarize,
  testRunArgs,
} from '../../shared/test-explorer.js';
import type { DotnetTaskCallbacks } from './dotnet-service.js';
import * as registry from './process-registry.js';

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: false,
});

/** Directorios que nunca contienen código fuente de pruebas. */
const SKIP_DIRECTORIES = new Set(['bin', 'obj', '.git', '.vs', 'node_modules', 'TestResults', 'artifacts']);

/** Tope de archivos por proyecto. Un proyecto de pruebas con más de esto no existe. */
const MAX_FILES_PER_PROJECT = 400;

const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  DOTNET_NOLOGO: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION: '0',
  // Los resultados salen del TRX, que es invariante; el inglés es sólo para que los mensajes de
  // error de MSBuild coincidan con los de la documentación y con el parser de diagnósticos.
  DOTNET_CLI_UI_LANGUAGE: 'en',
};

// ---------------------------------------------------------------------------------------------
// Descubrimiento
// ---------------------------------------------------------------------------------------------

async function collectSources(directory: string, found: string[], limit: number): Promise<void> {
  if (found.length >= limit) return;

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (found.length >= limit) return;

    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await collectSources(full, found, limit);
      continue;
    }

    if (looksLikeTestFile(entry.name)) found.push(full);
  }
}

/** Pruebas declaradas en un proyecto. La ruta es la del `.csproj`. */
export async function discoverProjectTests(projectPath: string): Promise<TestCase[]> {
  const files: string[] = [];
  await collectSources(dirname(projectPath), files, MAX_FILES_PER_PROJECT);

  const tests: TestCase[] = [];

  for (const file of files) {
    try {
      tests.push(...findTests(await readFile(file, 'utf8'), file, projectPath));
    } catch {
      // Un archivo ilegible se salta: el árbol queda incompleto, no roto.
    }
  }

  return tests;
}

/**
 * Pruebas de todos los proyectos de pruebas de la solución.
 *
 * Recibe las rutas ya filtradas por quien conoce la solución: este servicio no parsea `.sln`.
 */
export async function discoverTests(projectPaths: readonly string[]): Promise<TestCase[]> {
  const all: TestCase[] = [];

  for (const projectPath of projectPaths) {
    all.push(...(await discoverProjectTests(projectPath)));
  }

  return all;
}

// ---------------------------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------------------------

interface RunRecord {
  trxPath: string;
  resultsDirectory: string;
  output: string;
  /** Pruebas que se pidieron ejecutar, para poder decir cuáles no ha visto el runner. */
  requested: string[];
}

const runs = new Map<string, RunRecord>();

export interface TestRunOptions {
  /** `.sln` o `.csproj`. */
  target: string;
  /** Filtro ya construido por el modelo. Null ejecuta todo. */
  filter: string | null;
  /** Identificadores pedidos, sólo informativo. */
  requested?: string[];
  verbosity?: string | null;
  label?: string;
  /** Directorio donde dejar el TRX. Normalmente `userData/test-results`. */
  resultsRoot: string;
}

/**
 * Lanza `dotnet test` y transmite su salida por el canal de tareas.
 *
 * El TRX se escribe en un directorio propio por ejecución: dos ejecuciones simultáneas —cosa que
 * pasa en cuanto se pulsa dos lentes seguidas— compartirían el archivo y la segunda leería los
 * resultados de la primera.
 */
export function runTests(options: TestRunOptions, callbacks: DotnetTaskCallbacks): DotnetTaskStarted {
  const taskId = randomUUID();
  const resultsDirectory = join(options.resultsRoot, taskId);
  const trxFileName = 'dotforge.trx';

  const args = testRunArgs({
    target: options.target,
    filter: options.filter,
    trxFileName,
    resultsDirectory,
    verbosity: options.verbosity ?? null,
  });

  const started: DotnetTaskStarted = {
    taskId,
    kind: 'test',
    command: `dotnet ${args.join(' ')}`,
    target: options.target,
    label: options.label ?? 'Pruebas',
  };

  runs.set(taskId, {
    trxPath: join(resultsDirectory, trxFileName),
    resultsDirectory,
    output: '',
    requested: options.requested ?? [],
  });

  const child = spawn('dotnet', args, {
    cwd: dirname(options.target),
    env: TEST_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  registry.track(taskId, started.command, child);
  callbacks.onStarted(started);

  const startedAt = Date.now();

  const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const text = chunk.toString('utf8');

    const record = runs.get(taskId);
    // Se acota igual que el resto de canales: la salida completa de una suite grande no cabe en
    // memoria y sólo hace falta el final, que es donde están los resultados.
    if (record) record.output = (record.output + text).slice(-512 * 1024);

    callbacks.onOutput({ taskId, stream, chunk: text });
  };

  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));

  const finish = (code: number | null): void => {
    callbacks.onExit({
      taskId,
      code,
      durationMs: Date.now() - startedAt,
      diagnostics: [],
      applicationUrl: null,
    });
  };

  child.on('error', (error) => {
    callbacks.onOutput({
      taskId,
      stream: 'stderr',
      chunk: `No se ha podido ejecutar "dotnet test": ${error.message}\n`,
    });
    finish(-1);
  });

  child.on('close', (code) => finish(code));

  return started;
}

// ---------------------------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------------------------

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Referencias numéricas de XML que el parser deja sin tocar.
 *
 * El TRX escribe los saltos de línea del mensaje de un assert como `&#xD;&#xA;`, y el parser sólo
 * traduce las entidades con nombre. Sin esto, la traza de un fallo aparece en el panel con
 * `&#xD;` incrustado en cada línea — que es exactamente lo que se vio al probarlo contra una
 * solución real.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : decodeEntities(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null) {
    const inner = (value as Record<string, unknown>)['#text'];
    return typeof inner === 'string' ? decodeEntities(inner) : null;
  }
  return null;
}

/**
 * Lee un TRX y devuelve los resultados.
 *
 * El nombre que se usa como identidad **no** es `testName`: en una `[Theory]` ese campo trae los
 * argumentos del caso (`Crea(precio: 3)`) y no casaría con ninguna fila del árbol. El nombre bueno
 * está en `TestDefinitions`, donde cada prueba declara su clase y su método por separado; se cruza
 * por el identificador y se cae a `testName` sólo si el TRX no trae definiciones.
 */
export function parseTrx(content: string): TestRunSummary {
  let document: Record<string, unknown>;
  try {
    document = xml.parse(content) as Record<string, unknown>;
  } catch {
    return EMPTY_SUMMARY;
  }

  const run = document['TestRun'] as Record<string, unknown> | undefined;
  if (run === undefined) return EMPTY_SUMMARY;

  const definitions = new Map<string, string>();
  const definitionRoot = run['TestDefinitions'] as Record<string, unknown> | undefined;

  for (const entry of asArray(definitionRoot?.['UnitTest'] as Record<string, unknown> | Record<string, unknown>[])) {
    const id = entry['@id'];
    const method = entry['UnitTestMethod'] ?? entry['TestMethod'];
    if (typeof id !== 'string' || typeof method !== 'object' || method === null) continue;

    const record = method as Record<string, unknown>;
    const className = record['@className'];
    const name = record['@name'];
    if (typeof className !== 'string' || typeof name !== 'string') continue;

    // El nombre de clase del TRX puede venir cualificado con el ensamblado: `Ns.Clase, Acme, …`.
    definitions.set(id, `${className.split(',')[0]!.trim()}.${name}`);
  }

  const resultsRoot = run['Results'] as Record<string, unknown> | undefined;
  const results: TestResult[] = [];

  for (const entry of asArray(resultsRoot?.['UnitTestResult'] as Record<string, unknown> | Record<string, unknown>[])) {
    const testId = entry['@testId'];
    const testName = entry['@testName'];
    const id =
      (typeof testId === 'string' ? definitions.get(testId) : undefined) ??
      (typeof testName === 'string' ? testName : null);

    if (id === null) continue;

    const output = entry['Output'] as Record<string, unknown> | undefined;
    const errorInfo = output?.['ErrorInfo'] as Record<string, unknown> | undefined;

    results.push({
      id,
      status: outcomeToStatus(typeof entry['@outcome'] === 'string' ? (entry['@outcome'] as string) : ''),
      durationMs: parseDuration(typeof entry['@duration'] === 'string' ? (entry['@duration'] as string) : null),
      message: errorInfo ? text(errorInfo['Message']) : null,
      stackTrace: errorInfo ? text(errorInfo['StackTrace']) : null,
    });
  }

  const times = run['Times'] as Record<string, unknown> | undefined;
  const duration = elapsed(times?.['@start'], times?.['@finish']);

  return summarize(collapseResults(results), duration || results.reduce((total, r) => total + r.durationMs, 0), false);
}

function elapsed(start: unknown, finish: unknown): number {
  if (typeof start !== 'string' || typeof finish !== 'string') return 0;

  const from = Date.parse(start);
  const to = Date.parse(finish);

  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : 0;
}

/**
 * Resultados de una ejecución terminada.
 *
 * Si el TRX no está —el runner ha reventado antes de escribirlo, o el proyecto no tenía pruebas—
 * se cae a parsear la consola, y el resumen sale marcado como degradado para que la interfaz lo
 * diga en vez de enseñar números que pueden estar incompletos.
 */
export async function readResults(taskId: string): Promise<TestRunSummary> {
  const record = runs.get(taskId);
  if (record === undefined) return EMPTY_SUMMARY;

  try {
    const summary = parseTrx(await readFile(record.trxPath, 'utf8'));
    if (summary.results.length > 0) return summary;
  } catch {
    // Sin TRX se sigue por el camino degradado.
  }

  return summarize(collapseResults(parseConsoleResults(record.output)), 0, true);
}

/** Salida capturada de una ejecución, para enseñar la traza cuando el TRX no la trae. */
export function runOutput(taskId: string): string {
  return runs.get(taskId)?.output ?? '';
}

/** Borra el directorio de resultados de una ejecución y su registro en memoria. */
export async function forgetRun(taskId: string): Promise<void> {
  const record = runs.get(taskId);
  runs.delete(taskId);
  if (record === undefined) return;

  try {
    await rm(record.resultsDirectory, { recursive: true, force: true });
  } catch {
    // Un TRX que no se puede borrar no es motivo para romper nada: vive en userData.
  }
}

/** Prepara el directorio raíz de resultados. Se llama antes de la primera ejecución. */
export async function ensureResultsRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return root;
}
