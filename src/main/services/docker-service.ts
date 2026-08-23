/**
 * Integración con Docker: lectura del estado del motor.
 *
 * Igual que con git y con EF Core, **se invoca la CLI del sistema** en vez de hablar con el socket
 * del motor: así funcionan igual Docker Desktop, Colima, Rancher y un contexto remoto configurado
 * en la máquina del usuario, sin que el IDE tenga que saber nada de eso.
 *
 * Que Docker **no esté instalado o no esté arrancado es normal**, no un error: la mitad de las
 * soluciones .NET no lo usan. Todas las lecturas devuelven un estado con `available: false` y el
 * motivo, y la interfaz lo cuenta en una línea en vez de enseñar un diálogo de error.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { DockerContainer, DockerImage } from '../../shared/docker.js';
import { parseContainers, parseImages } from '../../shared/docker.js';

const execFileAsync = promisify(execFile);

/**
 * Con el motor parado, `docker ps` tarda en rendirse. Diez segundos son de sobra para responder
 * y poco para que se note: el panel enseña "Docker no responde" y sigue.
 */
const DOCKER_TIMEOUT_MS = 10_000;

/** El estado se consulta al abrir el panel y para autocompletar en la terminal: se cachea corto. */
const CACHE_TTL_MS = 4000;

export interface DockerState {
  available: boolean;
  /** Motivo por el que no está disponible, listo para enseñar. Null si lo está. */
  reason: string | null;
  containers: DockerContainer[];
  images: DockerImage[];
}

const UNAVAILABLE: DockerState = { available: false, reason: null, containers: [], images: [] };

let cache: { at: number; state: DockerState } | null = null;

export function invalidate(): void {
  cache = null;
}

async function run(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      ...(cwd === undefined ? {} : { cwd }),
      timeout: DOCKER_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string; code?: string };
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr:
        failure.code === 'ENOENT'
          ? 'Docker no está instalado o no está en el PATH.'
          : (failure.stderr ?? failure.message ?? 'docker ha fallado'),
    };
  }
}

/**
 * Estado del motor: contenedores (parados incluidos) e imágenes locales.
 *
 * Los contenedores parados también se listan porque el panel tiene que poder arrancarlos: enseñar
 * sólo lo que ya está arriba deja fuera justo el caso en el que sirve de algo.
 */
export async function readState(): Promise<DockerState> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.state;

  const containers = await run(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);

  if (!containers.ok) {
    const state: DockerState = { ...UNAVAILABLE, reason: firstLine(containers.stderr) };
    cache = { at: Date.now(), state };
    return state;
  }

  const images = await run(['images', '--format', '{{json .}}']);

  const state: DockerState = {
    available: true,
    reason: null,
    containers: parseContainers(containers.stdout),
    images: images.ok ? parseImages(images.stdout) : [],
  };

  cache = { at: Date.now(), state };
  return state;
}

/** Primera línea del error, que es la que dice algo. El resto suele ser la traza del cliente. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? 'Docker no responde.';
}

/** Nombres de contenedor e imágenes, que es lo que necesita el autocompletado de la terminal. */
export async function readNames(): Promise<{ containers: string[]; images: string[] }> {
  const state = await readState();

  return {
    containers: state.containers.map((container) => container.name),
    images: state.images.map((image) => (image.tag === '<none>' ? image.repository : `${image.repository}:${image.tag}`)),
  };
}
