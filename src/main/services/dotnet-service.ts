/**
 * Ejecución de tareas del SDK de .NET (`build`, `run`, `test`, `watch`, ...).
 *
 * Todo se lanza con `spawn` y un array de argumentos: nunca se construye una línea de shell, así
 * que un nombre de proyecto con espacios o comillas no puede convertirse en inyección de comandos.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, extname } from 'node:path';

import type {
  DotnetTaskExit,
  DotnetTaskKind,
  DotnetTaskOutput,
  DotnetTaskRequest,
  DotnetTaskStarted,
} from '../../shared/contracts.js';
import type { DotnetVerbosity } from '../../shared/dotnet-verbosity.js';
import {
  DEFAULT_DOTNET_VERBOSITY,
  verbosityEnvironment,
  verbosityPlan,
} from '../../shared/dotnet-verbosity.js';
import { detectApplicationUrl, parseMsBuildDiagnostics } from './msbuild-diagnostics.js';
import * as registry from './process-registry.js';

export interface DotnetTaskCallbacks {
  onStarted(payload: DotnetTaskStarted): void;
  onOutput(payload: DotnetTaskOutput): void;
  onExit(payload: DotnetTaskExit): void;
}

/** Argumentos base por tipo de tarea. El objetivo se añade después. */
const TASK_ARGS: Record<DotnetTaskKind, string[]> = {
  build: ['build', '--nologo'],
  rebuild: ['build', '--nologo', '--no-incremental'],
  clean: ['clean', '--nologo'],
  restore: ['restore'],
  test: ['test', '--nologo'],
  run: ['run', '--project'],
  watch: ['watch', '--project'],
  format: ['format'],
};

/** Tareas que no terminan solas: la UI debe ofrecer un botón de parada. */
export const LONG_RUNNING: ReadonlySet<DotnetTaskKind> = new Set<DotnetTaskKind>(['run', 'watch']);

/**
 * Verbos que aceptan `--launch-profile`.
 *
 * Sólo `run` y `watch` arrancan la aplicación; a `build` o a `test` la bandera les sobra y además
 * la rechazan, así que la lista es cerrada y no "todo lo que no sea build".
 */
const ACCEPTS_LAUNCH_PROFILE: ReadonlySet<DotnetTaskKind> = new Set<DotnetTaskKind>(['run', 'watch']);

/**
 * Argumentos del perfil de `launchSettings.json`.
 *
 * Sin esto, `dotnet run --project X` aplica **el primer perfil declarado**, que en las plantillas
 * del SDK es el de HTTP: el proyecto arrancaba en claro aunque el IDE hubiera resuelto —y estuviera
 * enseñando— el perfil HTTPS. Nombrarlo explícitamente hace que lo que se lanza sea lo que se dijo
 * que se iba a lanzar.
 *
 * El nombre viaja como un argumento suelto del array, nunca interpolado en una línea: un perfil
 * puede llamarse "IIS Express", con espacio.
 */
export function launchProfileArgs(kind: DotnetTaskKind, launchProfile: string | undefined): string[] {
  if (!ACCEPTS_LAUNCH_PROFILE.has(kind)) return [];

  const name = (launchProfile ?? '').trim();
  return name === '' ? [] : ['--launch-profile', name];
}

/**
 * Línea de argumentos de una tarea, con la verbosidad ya inyectada.
 *
 * La posición no es un detalle: `dotnet watch` quiere su bandera **antes** del subcomando (todo
 * lo que va después se lo pasa a la aplicación hija), mientras que `--verbosity` de MSBuild va
 * detrás del objetivo. Los argumentos extra se dejan siempre los últimos: si alguno abre la
 * sección de argumentos de la aplicación (`--`), lo nuestro ya ha quedado del lado de la CLI.
 */
export function buildArgs(request: DotnetTaskRequest, verbosity: DotnetVerbosity): string[] {
  const [verb, ...rest] = TASK_ARGS[request.kind];
  const plan = verbosityPlan(request.kind, verbosity);

  // `dotnet run` y `dotnet watch` reciben el proyecto tras `--project`; el resto lo reciben suelto.
  // El perfil va pegado al proyecto —los dos son "qué se arranca"— y antes de la verbosidad, que
  // es "cuánto se cuenta".
  return [
    verb ?? request.kind,
    ...plan.leading,
    ...rest,
    request.target,
    ...launchProfileArgs(request.kind, request.launchProfile),
    ...plan.trailing,
    ...(request.extraArgs ?? []),
  ];
}

/**
 * Directorio de trabajo del proceso: el de la solución si el objetivo es un `.sln`, el del
 * proyecto si es un `.csproj`. Importa porque `dotnet watch` resuelve rutas relativas desde ahí.
 */
function workingDirectory(target: string): string {
  return extname(target) === '' ? target : dirname(target);
}

export function runTask(
  request: DotnetTaskRequest,
  callbacks: DotnetTaskCallbacks,
  verbosity: DotnetVerbosity = DEFAULT_DOTNET_VERBOSITY,
): DotnetTaskStarted {
  const taskId = randomUUID();
  const args = buildArgs(request, verbosity);
  const cwd = workingDirectory(request.target);

  const started: DotnetTaskStarted = {
    taskId,
    kind: request.kind,
    command: `dotnet ${args.join(' ')}`,
    target: request.target,
    // La etiqueta la pone quien lanza la tarea: aquí no se sabe si esto es "la API" o "la UI".
    ...(request.label ? { label: request.label } : {}),
  };

  const child = spawn('dotnet', args, {
    cwd,
    env: {
      ...process.env,
      DOTNET_NOLOGO: '1',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      // Fuerza salida sin colores ANSI: los códigos de escape ensucian el parseo de diagnósticos.
      DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION: '0',
      // El parser de diagnósticos entiende inglés y español, pero en inglés es más fiable.
      DOTNET_CLI_UI_LANGUAGE: 'en',
      // Verbosidad alta: registro de la aplicación, errores detallados de ASP.NET Core y, en
      // `diagnostic`, la traza de resolución de ensamblados del host.
      ...verbosityEnvironment(verbosity),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  registry.track(taskId, started.command, child);
  callbacks.onStarted(started);

  const startedAt = Date.now();
  let buffered = '';

  const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    // El buffer se acota: una tarea `watch` de horas no puede crecer sin límite en memoria.
    buffered = (buffered + text).slice(-512 * 1024);
    callbacks.onOutput({ taskId, stream, chunk: text });
  };

  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));

  const finish = (code: number | null): void => {
    callbacks.onExit({
      taskId,
      code,
      durationMs: Date.now() - startedAt,
      diagnostics: parseMsBuildDiagnostics(buffered),
      applicationUrl: detectApplicationUrl(buffered),
    });
  };

  child.on('error', (error) => {
    callbacks.onOutput({
      taskId,
      stream: 'stderr',
      chunk:
        `No se ha podido ejecutar "dotnet". Comprueba que el SDK de .NET está instalado y en el PATH.\n${error.message}\n`,
    });
    finish(-1);
  });

  child.on('close', (code) => finish(code));

  return started;
}

export function cancelTask(taskId: string): boolean {
  return registry.kill(taskId);
}

export function listTasks(): DotnetTaskStarted[] {
  return registry.list().map((tracked) => ({
    taskId: tracked.id,
    kind: 'build',
    command: tracked.label,
    target: '',
  }));
}

/** Añade o quita un paquete NuGet de un proyecto, reutilizando el mismo canal de tareas. */
export function runPackageCommand(
  action: 'add' | 'remove',
  projectPath: string,
  packageId: string,
  version: string | undefined,
  callbacks: DotnetTaskCallbacks,
): DotnetTaskStarted {
  const taskId = randomUUID();
  const args =
    action === 'add'
      ? ['add', projectPath, 'package', packageId, ...(version ? ['--version', version] : [])]
      : ['remove', projectPath, 'package', packageId];

  const started: DotnetTaskStarted = {
    taskId,
    kind: 'restore',
    command: `dotnet ${args.join(' ')}`,
    target: projectPath,
  };

  const child = spawn('dotnet', args, {
    cwd: dirname(projectPath),
    env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_CLI_UI_LANGUAGE: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  registry.track(taskId, started.command, child);
  callbacks.onStarted(started);

  const startedAt = Date.now();
  let buffered = '';

  const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    buffered = (buffered + text).slice(-256 * 1024);
    callbacks.onOutput({ taskId, stream, chunk: text });
  };

  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));

  child.on('close', (code) => {
    callbacks.onExit({
      taskId,
      code,
      durationMs: Date.now() - startedAt,
      diagnostics: parseMsBuildDiagnostics(buffered),
      applicationUrl: null,
    });
  });

  return started;
}
