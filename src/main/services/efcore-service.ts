/**
 * Gestor de Entity Framework Core: ejecuta `dotnet ef` y lee las migraciones del disco.
 *
 * Reparto de responsabilidades, igual que en el control de código fuente:
 *  - **este archivo ejecuta y lee**; el modelo (parseo de la salida, construcción de argumentos,
 *    esquema deducido de las migraciones) vive en `src/shared/efcore*.ts` y es puro;
 *  - **las lecturas capturan la salida** (`execFile`) porque el panel necesita el resultado;
 *  - **las escrituras se transmiten** por el canal de tareas (`spawn` + callbacks) porque
 *    `dotnet ef database update` puede tardar minutos y hay que ver qué está pasando.
 *
 * Un `dotnet ef` que falla **no es una excepción del IDE**: que falten las herramientas o que la
 * cadena de conexión apunte a un servidor apagado son respuestas normales del sistema. Se
 * devuelven con su salida cruda para poder enseñarla.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { DotnetTaskStarted } from '../../shared/contracts.js';
import type { ConnectionStringInfo, EfDbContext, EfMigrationList, EfOperation, EfOperationOptions } from '../../shared/efcore.js';
import {
  efArgs,
  EF_TOOL_MISSING_HINT,
  extractJsonBlock,
  parseConnectionStrings,
  parseDbContexts,
  parseMigrations,
} from '../../shared/efcore.js';
import type { DatabaseSchema, MigrationSource } from '../../shared/efcore-schema.js';
import { buildSchema, EMPTY_SCHEMA } from '../../shared/efcore-schema.js';
import type { DotnetTaskCallbacks } from './dotnet-service.js';
import * as registry from './process-registry.js';

const execFileAsync = promisify(execFile);

/**
 * `dotnet ef` compila el proyecto antes de hacer nada: dos minutos es poco para una solución
 * grande con los paquetes fríos, y quedarse corto se manifiesta como "no pasa nada".
 */
const EF_TIMEOUT_MS = 240_000;

const EF_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  DOTNET_NOLOGO: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  // La salida se lee del bloque JSON, pero los mensajes de error se enseñan tal cual: en inglés
  // son los que aparecen en la documentación y en las búsquedas.
  DOTNET_CLI_UI_LANGUAGE: 'en',
};

export interface EfCommandOutcome<T> {
  ok: boolean;
  value: T;
  /** Salida completa (stdout + stderr) para el canal de salida. */
  detail: string;
  /** Mensaje corto y accionable cuando algo ha ido mal. */
  error: string | null;
}

/** Directorio desde el que se invoca: el del proyecto de arranque, si lo hay. */
function workingDirectory(options: EfOperationOptions): string {
  return dirname(options.startupProject && options.startupProject !== '' ? options.startupProject : options.project);
}

async function runCapture(operation: EfOperation, options: EfOperationOptions): Promise<EfCommandOutcome<string>> {
  const args = efArgs(operation, options);

  try {
    const { stdout, stderr } = await execFileAsync('dotnet', args, {
      cwd: workingDirectory(options),
      timeout: EF_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: EF_ENV,
    });
    return { ok: true, value: stdout, detail: `${stdout}${stderr}`, error: null };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string; code?: string };
    const detail = `${failure.stdout ?? ''}${failure.stderr ?? ''}` || (failure.message ?? '');

    return {
      ok: false,
      value: failure.stdout ?? '',
      detail,
      // ENOENT es "no hay dotnet"; el resto de fallos traen su propia explicación en la salida.
      error: failure.code === 'ENOENT' ? EF_TOOL_MISSING_HINT : shortError(detail),
    };
  }
}

/**
 * Primera línea útil de una salida de error.
 *
 * No se traduce ni se interpreta: se busca la primera línea que no sea del build, porque la
 * explicación de EF viene siempre después de las líneas de MSBuild.
 */
function shortError(detail: string): string {
  const lines = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'));

  const meaningful = lines.find((line) => /error|exception|unable|no se|failed/i.test(line));
  return meaningful ?? lines[lines.length - 1] ?? 'dotnet ef ha fallado';
}

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

/**
 * Añade la pista de instalación cuando la CLI ni siquiera ha llegado a emitir su bloque JSON.
 *
 * Es una decisión **de estado, no de texto**: no se busca ninguna frase en la salida —está
 * localizada y cambia entre versiones—, sino la ausencia del bloque que las herramientas de EF
 * escriben siempre que existen y arrancan. Ese caso es, en la práctica, "dotnet-ef no está".
 */
function withInstallHint<T>(outcome: EfCommandOutcome<T>, stdout: string): EfCommandOutcome<T> {
  if (outcome.ok || extractJsonBlock(stdout) !== null) return outcome;
  return { ...outcome, error: `${outcome.error ?? ''} ${EF_TOOL_MISSING_HINT}`.trim() };
}

export async function listMigrations(options: EfOperationOptions): Promise<EfCommandOutcome<EfMigrationList>> {
  const outcome = await runCapture('migrations-list', options);
  return withInstallHint({ ...outcome, value: parseMigrations(outcome.value) }, outcome.value);
}

export async function listContexts(options: EfOperationOptions): Promise<EfCommandOutcome<EfDbContext[]>> {
  const outcome = await runCapture('dbcontext-list', options);
  return withInstallHint({ ...outcome, value: parseDbContexts(outcome.value) }, outcome.value);
}

/**
 * Archivos de migración de un proyecto, ya ordenados.
 *
 * Se descartan el `*ModelSnapshot.cs` (es el modelo completo, no una operación) y los
 * `*.Designer.cs` (metadatos). El orden es el del identificador, que empieza por la marca de
 * tiempo: es el mismo que aplica EF.
 */
export async function readMigrationSources(projectPath: string): Promise<MigrationSource[]> {
  const directory = join(dirname(projectPath), 'Migrations');

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const files = entries
    .filter((file) => file.endsWith('.cs'))
    .filter((file) => !file.endsWith('.Designer.cs') && !/ModelSnapshot\.cs$/.test(file))
    .sort((a, b) => a.localeCompare(b));

  const sources: MigrationSource[] = [];
  for (const file of files) {
    try {
      sources.push({ id: basename(file, '.cs'), source: await readFile(join(directory, file), 'utf8') });
    } catch {
      // Un archivo ilegible se salta: el esquema queda incompleto, no roto.
    }
  }

  return sources;
}

/** Esquema deducido de las migraciones del proyecto. Vacío si el proyecto no tiene ninguna. */
export async function readSchema(projectPath: string): Promise<DatabaseSchema> {
  const sources = await readMigrationSources(projectPath);
  return sources.length === 0 ? EMPTY_SCHEMA : buildSchema(sources);
}

export interface ConnectionStringFile {
  /** Ruta absoluta del `appsettings*.json`. */
  path: string;
  /** Nombre del archivo, para la fila del panel. */
  name: string;
  connections: ConnectionStringInfo[];
}

/**
 * Cadenas de conexión de los `appsettings*.json` de un proyecto.
 *
 * Se leen todos los del directorio del proyecto, no sólo `appsettings.json`: el de desarrollo es
 * justo el que suele llevar la cadena de verdad, y quien mira el panel quiere saber contra qué
 * base de datos va a trabajar hoy.
 */
export async function readConnectionStrings(projectPath: string): Promise<ConnectionStringFile[]> {
  const directory = dirname(projectPath);

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const files = entries.filter((file) => /^appsettings(\..+)?\.json$/i.test(file)).sort();
  const result: ConnectionStringFile[] = [];

  for (const file of files) {
    try {
      const connections = parseConnectionStrings(await readFile(join(directory, file), 'utf8'));
      if (connections.length > 0) result.push({ path: join(directory, file), name: file, connections });
    } catch {
      // Archivo ilegible o roto: se omite. El panel no es un validador de JSON.
    }
  }

  return result;
}

// ---------------------------------------------------------------------------------------------
// Escritura (transmitida al canal de salida)
// ---------------------------------------------------------------------------------------------

/**
 * Lanza una operación de escritura y transmite su salida por el canal de tareas.
 *
 * Se reutiliza el canal de `dotnet` a propósito: así el panel de salida, el botón de cancelar y
 * el registro de procesos funcionan igual que con un `build`, sin inventar un segundo mecanismo.
 */
export function runEfTask(
  operation: EfOperation,
  options: EfOperationOptions,
  callbacks: DotnetTaskCallbacks,
  label = 'EF Core',
): DotnetTaskStarted {
  const args = efArgs(operation, options);
  const taskId = randomUUID();

  const started: DotnetTaskStarted = {
    taskId,
    kind: 'build',
    command: `dotnet ${args.join(' ')}`,
    target: options.project,
    label,
  };

  const child = spawn('dotnet', args, {
    cwd: workingDirectory(options),
    env: EF_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  registry.track(taskId, started.command, child);
  callbacks.onStarted(started);

  const startedAt = Date.now();

  const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) =>
    callbacks.onOutput({ taskId, stream, chunk: chunk.toString('utf8') });

  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));

  const finish = (code: number | null): void =>
    callbacks.onExit({ taskId, code, durationMs: Date.now() - startedAt, diagnostics: [], applicationUrl: null });

  child.on('error', (error) => {
    callbacks.onOutput({ taskId, stream: 'stderr', chunk: `${EF_TOOL_MISSING_HINT}\n${error.message}\n` });
    finish(-1);
  });

  child.on('close', (code) => finish(code));

  return started;
}
