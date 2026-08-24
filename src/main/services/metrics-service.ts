/**
 * Monitor de rendimiento: sesión de `dotnet-counters`.
 *
 * Una sola sesión viva a la vez, como con el depurador (ADR-012): dos procesos leyendo el mismo
 * canal de diagnóstico se estorban, y "qué está pasando **ahora**" es una pregunta sobre un
 * proceso, no sobre cinco.
 *
 * **La sesión escribe a un archivo y este servicio lo va leyendo.** `dotnet-counters monitor`
 * parece la opción evidente —pinta la tabla en directo— pero necesita una consola de verdad: con la
 * salida redirigida revienta con una `NullReferenceException` antes del primer valor.
 * `collect --format csv` escribe una fila por contador y por refresco, y leer lo que se ha añadido
 * al archivo desde la última vez es fiable, barato y no depende de ningún terminal.
 *
 * El parseo vive en `src/shared/perf-counters.ts` y es puro. Aquí sólo se lanza la herramienta, se
 * lee el archivo y se procesan las líneas **completas**: leerlo a medias partiría un número por la
 * mitad y pintaría un pico que no ha existido.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CounterSample, DotnetProcess, MetricsState, MetricsStatus } from '../../shared/perf-counters.js';
import {
  COUNTERS_COMMAND,
  COUNTERS_REFRESH_SECONDS,
  countersCollectArgs,
  IDLE_METRICS,
  parseCounterSamples,
  parseDotnetProcesses,
} from '../../shared/perf-counters.js';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 8000;

export interface MetricsSessionEvents {
  /** Muestras nuevas ya parseadas. Puede llegar vacío: no todos los refrescos traen valores. */
  onSamples(samples: CounterSample[]): void;
  /** Cambio de estado con su motivo, para que el panel diga qué está pasando. */
  onStatus(status: MetricsStatus, message: string | null): void;
}

let child: ChildProcess | null = null;
let timer: NodeJS.Timeout | null = null;
/** CSV de la sesión viva. Se borra al parar: es un archivo temporal, no un registro. */
let csvPath: string | null = null;
let state: MetricsState = IDLE_METRICS;
let availability: { at: number; available: boolean } | null = null;

const AVAILABILITY_TTL_MS = 60_000;

export function getState(): MetricsState {
  return state;
}

/** true si la herramienta responde. Se cachea: preguntarlo lanza un proceso. */
export async function isAvailable(): Promise<boolean> {
  if (availability !== null && Date.now() - availability.at < AVAILABILITY_TTL_MS) return availability.available;

  let available = false;
  try {
    await execFileAsync(COUNTERS_COMMAND, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    available = true;
  } catch {
    available = false;
  }

  availability = { at: Date.now(), available };
  state = { ...state, available };
  return available;
}

/**
 * Procesos .NET vivos.
 *
 * Es lo que llena el desplegable del panel: normalmente hay uno —la aplicación que se acaba de
 * arrancar con F5— pero un perfil multiproyecto arranca dos o tres y hay que poder elegir.
 */
export async function listProcesses(): Promise<DotnetProcess[]> {
  if (!(await isAvailable())) return [];

  try {
    const { stdout } = await execFileAsync(COUNTERS_COMMAND, ['ps'], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseDotnetProcesses(stdout);
  } catch {
    return [];
  }
}

/**
 * Arranca la sesión de monitorización.
 *
 * Detiene la anterior antes de empezar: es la misma regla del depurador, y evita quedarse con dos
 * procesos escribiendo en el mismo panel.
 */
export function start(pid: number, processName: string | null, events: MetricsSessionEvents): MetricsState {
  stop();

  const outputPath = join(tmpdir(), `dotforge-counters-${randomUUID()}.csv`);

  let args: string[];
  try {
    args = countersCollectArgs(pid, outputPath);
  } catch (error) {
    state = {
      status: 'error',
      pid: null,
      processName: null,
      message: error instanceof Error ? error.message : String(error),
      available: state.available,
    };
    events.onStatus('error', state.message);
    return state;
  }

  state = { status: 'starting', pid, processName, message: null, available: state.available };
  events.onStatus('starting', null);

  const spawned = spawn(COUNTERS_COMMAND, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child = spawned;
  csvPath = outputPath;

  /**
   * Lectura incremental del CSV.
   *
   * Se guarda el desplazamiento leído y sólo se procesa hasta el último salto de línea: la
   * herramienta puede estar escribiendo una fila justo cuando se lee, y media fila es un número
   * partido por la mitad.
   */
  let offset = 0;
  let pending = '';

  const drain = async (): Promise<void> => {
    let handle;
    try {
      handle = await open(outputPath, 'r');
    } catch {
      // Todavía no existe: la sesión tarda un par de segundos en crear el archivo.
      return;
    }

    try {
      const stats = await handle.stat();
      if (stats.size <= offset) return;

      const buffer = Buffer.alloc(stats.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;

      pending += buffer.subarray(0, bytesRead).toString('utf8');

      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (lines.length === 0) return;

      const samples = parseCounterSamples(lines.join('\n'));
      if (samples.length === 0) return;

      if (state.status !== 'running') {
        state = { ...state, status: 'running', message: null };
        events.onStatus('running', null);
      }

      events.onSamples(samples);
    } finally {
      await handle.close();
    }
  };

  timer = setInterval(() => void drain(), Math.max(500, COUNTERS_REFRESH_SECONDS * 500));
  timer.unref?.();

  // Por stdout sólo llega la cabecera de la sesión; lo que importa es stderr, que es donde aparece
  // el motivo de no haber podido engancharse al proceso.
  spawned.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text === '') return;

    state = { ...state, status: 'error', message: text.split(/\r?\n/)[0] ?? text };
    events.onStatus('error', state.message);
  });

  spawned.on('error', (error) => {
    child = null;
    availability = { at: Date.now(), available: false };
    state = {
      status: 'error',
      pid: null,
      processName: null,
      message: `No se ha podido ejecutar "${COUNTERS_COMMAND}": ${error.message}`,
      available: false,
    };
    events.onStatus('error', state.message);
  });

  spawned.on('close', () => {
    if (child !== spawned) return;
    child = null;

    // Una última lectura: las filas del final no se pierden porque el proceso haya terminado.
    void drain().finally(() => {
      cleanup();
      state = { ...state, status: 'idle', pid: null, processName: null };
      events.onStatus('idle', null);
    });
  });

  return state;
}

export function stop(): void {
  const running = child;
  child = null;

  cleanup();

  if (running === null) return;

  try {
    running.kill();
  } catch {
    // Un proceso que ya ha muerto no es un problema.
  }

  state = { ...state, status: 'idle', pid: null, processName: null, message: null };
}

/** Para el reloj de lectura y borra el CSV de la sesión. */
function cleanup(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }

  const path = csvPath;
  csvPath = null;
  if (path === null) return;

  void rm(path, { force: true }).catch(() => {
    // Un CSV que no se puede borrar vive en el directorio temporal: no rompe nada.
  });
}
