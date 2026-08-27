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
import type { PublishOptions } from '../../shared/dotnet-publish.js';
import { describePublish, publishArgs } from '../../shared/dotnet-publish.js';
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
  // La publicación compone sus argumentos aparte (`publishArgs`), así que aquí sólo está el verbo.
  publish: ['publish'],
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

/**
 * Entorno común de toda invocación de `dotnet`.
 *
 * Está en un solo sitio porque cada variable arregla un síntoma concreto y olvidar una en un
 * camino nuevo se nota tarde: sin `DOTNET_CLI_UI_LANGUAGE` el parser de diagnósticos deja de
 * reconocer los errores en una máquina en español, y sin apagar los colores ANSI los códigos de
 * escape se cuelan dentro de los mensajes.
 */
function dotnetEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOTNET_NOLOGO: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    // Fuerza salida sin colores ANSI: los códigos de escape ensucian el parseo de diagnósticos.
    DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION: '0',
    // El parser de diagnósticos entiende inglés y español, pero en inglés es más fiable.
    DOTNET_CLI_UI_LANGUAGE: 'en',
    ...extra,
  };
}

interface SpawnRequest {
  kind: DotnetTaskKind;
  target: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  callbacks: DotnetTaskCallbacks;
  label?: string | undefined;
  /** Cuánta salida se conserva para parsear diagnósticos al terminar. */
  bufferBytes?: number;
  /** true para buscar en la salida la URL en la que escucha la aplicación. Sólo `run` y `watch`. */
  detectUrl?: boolean;
}

/**
 * Lanza `dotnet` y cablea su ciclo de vida al canal de tareas.
 *
 * Lo comparten `runTask`, la instalación de paquetes y la publicación. Antes eran tres bloques
 * casi iguales, y "casi" es el problema: el aviso de "no se ha podido ejecutar dotnet" sólo estaba
 * en uno de los tres, así que un SDK ausente dejaba una instalación de paquete colgada sin decir
 * nada. Todo lo que se lanza pasa por aquí.
 */
function spawnDotnet(request: SpawnRequest): DotnetTaskStarted {
  const taskId = randomUUID();

  const started: DotnetTaskStarted = {
    taskId,
    kind: request.kind,
    command: `dotnet ${request.args.join(' ')}`,
    target: request.target,
    // La etiqueta la pone quien lanza la tarea: aquí no se sabe si esto es "la API" o "la UI".
    ...(request.label ? { label: request.label } : {}),
  };

  const child = spawn('dotnet', request.args, {
    cwd: request.cwd,
    env: dotnetEnvironment(request.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  registry.track(taskId, started.command, child);
  request.callbacks.onStarted(started);

  const startedAt = Date.now();
  const limit = request.bufferBytes ?? 512 * 1024;
  let buffered = '';
  let finished = false;

  const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    // El buffer se acota: una tarea `watch` de horas no puede crecer sin límite en memoria.
    buffered = (buffered + text).slice(-limit);
    request.callbacks.onOutput({ taskId, stream, chunk: text });
  };

  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));

  // El pestillo no es defensivo por costumbre: un `error` de spawn puede llegar acompañado de un
  // `close`, y dos avisos de final para la misma tarea dejan al panel con un canal cerrado dos
  // veces y un paso de la instalación en varios proyectos avanzando de dos en dos.
  const finish = (code: number | null): void => {
    if (finished) return;
    finished = true;

    request.callbacks.onExit({
      taskId,
      code,
      durationMs: Date.now() - startedAt,
      diagnostics: parseMsBuildDiagnostics(buffered),
      applicationUrl: request.detectUrl === true ? detectApplicationUrl(buffered) : null,
    });
  };

  child.on('error', (error) => {
    request.callbacks.onOutput({
      taskId,
      stream: 'stderr',
      chunk:
        `No se ha podido ejecutar "dotnet". Comprueba que el SDK de .NET está instalado y en el PATH.
${error.message}
`,
    });
    finish(-1);
  });

  child.on('close', (code) => finish(code));

  return started;
}

export function runTask(
  request: DotnetTaskRequest,
  callbacks: DotnetTaskCallbacks,
  verbosity: DotnetVerbosity = DEFAULT_DOTNET_VERBOSITY,
): DotnetTaskStarted {
  return spawnDotnet({
    kind: request.kind,
    target: request.target,
    args: buildArgs(request, verbosity),
    cwd: workingDirectory(request.target),
    // Verbosidad alta: registro de la aplicación, errores detallados de ASP.NET Core y, en
    // `diagnostic`, la traza de resolución de ensamblados del host.
    env: verbosityEnvironment(verbosity),
    callbacks,
    label: request.label,
    detectUrl: true,
  });
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
  const args =
    action === 'add'
      ? ['add', projectPath, 'package', packageId, ...(version ? ['--version', version] : [])]
      : ['remove', projectPath, 'package', packageId];

  return spawnDotnet({
    kind: 'restore',
    target: projectPath,
    args,
    cwd: dirname(projectPath),
    env: {},
    callbacks,
    bufferBytes: 256 * 1024,
  });
}

/**
 * Publica un proyecto.
 *
 * Reutiliza el canal de tareas por el mismo motivo que `database update`: puede tardar minutos y
 * su salida pertenece al panel inferior, con su punto de progreso y su botón de cancelar. Lo que
 * **no** reutiliza es `runTask`: los argumentos de una publicación no son "el verbo más el
 * objetivo", los compone `publishArgs` a partir de opciones ya validadas, y colarlos por
 * `extraArgs` volvería a poner al renderer a escribir línea de comandos.
 *
 * La verbosidad entra por el mismo sitio que en todo lo demás: `publish` está en la lista de
 * verbos que aceptan `--verbosity`, así que el plan la coloca detrás del objetivo.
 */
export function publishProject(
  projectPath: string,
  options: PublishOptions,
  callbacks: DotnetTaskCallbacks,
  verbosity: DotnetVerbosity = DEFAULT_DOTNET_VERBOSITY,
): DotnetTaskStarted {
  const plan = verbosityPlan('publish', verbosity);
  const args = ['publish', ...plan.leading, ...publishArgs(projectPath, options), ...plan.trailing];

  const started = spawnDotnet({
    kind: 'publish',
    target: projectPath,
    args,
    cwd: dirname(projectPath),
    // El entorno de la verbosidad no pinta en una publicación —no hay aplicación arrancando— pero
    // `MSBUILDTERMINALLOGGER=off` sí: con el logger de terminal, subir el nivel no enseña nada más.
    env: verbosityEnvironment(verbosity),
    callbacks,
  });

  // Una línea que diga qué se está publicando, antes de los cien renglones de MSBuild. El comando
  // completo ya está en la cabecera del canal; esto es la versión que se lee de un vistazo.
  callbacks.onOutput({ taskId: started.taskId, stream: 'stdout', chunk: `Publicando: ${describePublish(options)}
` });

  return started;
}
