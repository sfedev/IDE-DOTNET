/**
 * Túneles públicos: detección de la herramienta y arranque del proceso.
 *
 * El modelo (argumentos, reconocimiento de la URL, aviso) vive en `src/shared/dev-tunnel.ts` y es
 * puro. Aquí sólo se comprueba qué hay instalado y se lanza el proceso por el canal de tareas, que
 * es lo que le da al túnel su canal de salida, su pastilla y su botón de parada sin inventar
 * ningún mecanismo nuevo.
 *
 * Que no haya ninguna herramienta instalada es un estado normal, no un error: se devuelve la lista
 * vacía y el botón lo explica con la orden de instalación, igual que con `dotnet-ef` o con Docker.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type { DotnetTaskStarted } from '../../shared/contracts.js';
import type { TunnelTool } from '../../shared/dev-tunnel.js';
import { isValidPort, TUNNEL_TOOLS, tunnelArgs, tunnelInfo } from '../../shared/dev-tunnel.js';
import type { DotnetTaskCallbacks } from './dotnet-service.js';
import * as registry from './process-registry.js';

const execFileAsync = promisify(execFile);

/** Comprobar la versión de una CLI que existe tarda milisegundos; una que no, falla en el acto. */
const PROBE_TIMEOUT_MS = 6000;

/** La lista no cambia mientras el IDE está abierto salvo que se instale algo: caché corta. */
const CACHE_TTL_MS = 30_000;

let cache: { at: number; tools: TunnelTool[] } | null = null;

export function invalidate(): void {
  cache = null;
}

async function exists(tool: TunnelTool): Promise<boolean> {
  const info = tunnelInfo(tool);

  try {
    await execFileAsync(info.command, info.versionArgs, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/** Herramientas de túnel presentes en el PATH, en el orden en que se prefieren. */
export async function detectTools(): Promise<TunnelTool[]> {
  if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) return cache.tools;

  const found: TunnelTool[] = [];
  for (const info of TUNNEL_TOOLS) {
    if (await exists(info.id)) found.push(info.id);
  }

  cache = { at: Date.now(), tools: found };
  return found;
}

/**
 * Abre el túnel y transmite su salida por el canal de tareas.
 *
 * La URL pública **no se busca aquí**: llega en una línea cualquiera de la salida y el renderer ya
 * está escuchando ese canal, así que la reconoce con el mismo escáner que se prueba sin proceso.
 * Es la misma decisión que con la URL en la que escucha una aplicación arrancada.
 */
export function startTunnel(
  tool: TunnelTool,
  port: number,
  cwd: string,
  callbacks: DotnetTaskCallbacks,
): DotnetTaskStarted {
  if (!isValidPort(port)) throw new Error(`puerto no válido para el túnel: ${String(port)}`);

  const info = tunnelInfo(tool);
  const args = tunnelArgs(tool, port);
  const taskId = randomUUID();

  const started: DotnetTaskStarted = {
    taskId,
    // `run` y no `build`: es un proceso de larga duración, y de eso depende que la barra de
    // pestañas le pinte un punto verde en vez de un spinner que giraría para siempre.
    kind: 'run',
    command: `${info.command} ${args.join(' ')}`,
    target: cwd,
    label: `Túnel :${port}`,
  };

  const child = spawn(info.command, args, {
    cwd,
    env: process.env,
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

  const finish = (code: number | null): void => {
    invalidate();
    callbacks.onExit({ taskId, code, durationMs: Date.now() - startedAt, diagnostics: [], applicationUrl: null });
  };

  child.on('error', (error) => {
    callbacks.onOutput({
      taskId,
      stream: 'stderr',
      chunk: `No se ha podido ejecutar "${info.command}": ${error.message}\n`,
    });
    finish(-1);
  });

  child.on('close', (code) => finish(code));

  return started;
}
