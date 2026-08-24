/**
 * Actualizaciones automáticas.
 *
 * El ciclo completo: preguntar al feed, ofrecer la versión nueva en una tarjeta, descargar el
 * artefacto que corresponde a esta máquina y aplicarlo **cuando el usuario cierra el IDE**, que es
 * el único momento en el que reemplazar los archivos de la aplicación no interrumpe a nadie.
 *
 * Cuatro decisiones que sostienen todo lo demás:
 *
 *  - **Sin `electron-updater`.** Ese paquete exige artefactos firmados y un canal de publicación
 *    (`latest.yml` generado por el publicador); aquí no hay certificado y `electron-builder.yml`
 *    declara `publish: null`. Se lee la API pública de releases, igual que ya se hace para
 *    OmniSharp y NetCoreDbg, y se reutiliza el mismo patrón de descarga verificada.
 *  - **Este módulo no importa `electron`.** Lo que necesita del entorno —dónde está `userData`,
 *    qué versión corre, cómo se cierra la aplicación— se le inyecta en `initialize`. Así se puede
 *    ejercitar con Node pelado, que es lo que hacen las pruebas.
 *  - **Lo pendiente se persiste.** "Descartar" promete una instalación al cerrar; si el IDE se va
 *    abajo por otra razón, la promesa sigue en `updates/pending.json` y se cumple en el siguiente
 *    arranque. Una promesa que sólo vive en memoria no es una promesa.
 *  - **El instalador se lanza desprendido del proceso.** Se está cerrando el IDE: un hijo atado al
 *    padre moriría con él a mitad de la instalación.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assetFor,
  emptyUpdateState,
  installPlan,
  isNewerVersion,
  parseReleaseFeed,
  releaseNotesLines,
  selectUpdate,
  UPDATE_FEED,
  type ReleaseAsset,
  type UpdateState,
} from '../../shared/updates.js';

const FEED_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const PENDING_FILE = 'pending.json';

export interface UpdaterEnvironment {
  userDataPath: string;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Cierra la aplicación. Se inyecta para no importar `electron` desde aquí. */
  quit: () => void;
  /** Feed alternativo, para las pruebas. */
  feedUrl?: string;
}

/** Instalación descargada y esperando a que el IDE se cierre. */
interface PendingInstall {
  version: string;
  file: string;
  savedAtUtc: string;
}

let environment: UpdaterEnvironment | null = null;
let state: UpdateState = emptyUpdateState('0.0.0');
let pending: PendingInstall | null = null;
let listener: ((state: UpdateState) => void) | null = null;
let inFlight: Promise<UpdateState> | null = null;

/** Artefacto elegido en la última comprobación. No sale al renderer: es un detalle interno. */
let candidateAsset: ReleaseAsset | null = null;

function env(): UpdaterEnvironment {
  if (environment === null) throw new Error('el servicio de actualizaciones no está inicializado');
  return environment;
}

function updatesDir(): string {
  return join(env().userDataPath, 'updates');
}

function publish(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch };
  listener?.(state);
  return state;
}

export function setListener(handler: ((state: UpdateState) => void) | null): void {
  listener = handler;
}

export function getState(): UpdateState {
  return state;
}

/**
 * Arranque del servicio.
 *
 * Además de fijar el entorno, recupera lo que quedó pendiente. Dos casos:
 *  - el archivo descargado sigue siendo de una versión posterior: se rearma la promesa;
 *  - la versión que corre ya es esa o superior (la instalación se aplicó): se borra la descarga,
 *    que ocupa entre 90 y 150 MB y no sirve para nada.
 */
export async function initialize(options: UpdaterEnvironment): Promise<UpdateState> {
  environment = options;
  state = emptyUpdateState(options.currentVersion);
  pending = null;
  candidateAsset = null;

  const record = await readPending();
  if (record === null) return state;

  if (!isNewerVersion(record.version, options.currentVersion) || !existsSync(record.file)) {
    await discardPending();
    return state;
  }

  pending = record;
  return publish({
    status: 'ready',
    version: record.version,
    downloadedPath: record.file,
    applyOnQuit: true,
    dismissed: true,
    plan: installPlan(options.platform, record.file).note,
    message: `La versión ${record.version} está descargada y se instalará al cerrar el IDE.`,
  });
}

async function readPending(): Promise<PendingInstall | null> {
  const path = join(updatesDir(), PENDING_FILE);
  if (!existsSync(path)) return null;

  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<PendingInstall>;
    if (typeof raw.version !== 'string' || typeof raw.file !== 'string') return null;
    return { version: raw.version, file: raw.file, savedAtUtc: raw.savedAtUtc ?? '' };
  } catch {
    return null;
  }
}

async function writePending(record: PendingInstall): Promise<void> {
  await mkdir(updatesDir(), { recursive: true });
  await writeFile(join(updatesDir(), PENDING_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** Borra la descarga y la promesa: se aplicó, o dejó de valer. */
async function discardPending(): Promise<void> {
  pending = null;
  await rm(updatesDir(), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Comprobación
// ---------------------------------------------------------------------------------------------

/**
 * Pregunta al feed si hay una versión posterior.
 *
 * Una comprobación automática que falla **no** pone la tarjeta en rojo: que el equipo esté sin red
 * o que GitHub devuelva un 403 por límite de peticiones no es un problema que el usuario tenga que
 * resolver ahora. Una manual sí lo dice, porque alguien la ha pedido y espera respuesta.
 */
export async function check(options: { manual?: boolean } = {}): Promise<UpdateState> {
  const manual = options.manual === true;
  if (inFlight !== null) return inFlight;

  const run = async (): Promise<UpdateState> => {
    const current = env();
    publish({ status: 'checking', message: manual ? 'Buscando actualizaciones…' : null });

    try {
      const response = await fetch(current.feedUrl ?? UPDATE_FEED, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `DotForge-IDE/${current.currentVersion}`,
        },
      });

      if (!response.ok) {
        // Un 404 en `/releases` no es un fallo de red: es que el repositorio todavía no publica
        // versiones (o no es público). Decir "404 Not Found" convierte un estado normal en un
        // error incomprensible, así que se traduce a lo que de verdad significa.
        if (response.status === 404) {
          throw new Error('el repositorio de versiones todavía no publica ninguna release');
        }
        throw new Error(`el servidor de versiones respondió ${response.status} ${response.statusText}`);
      }

      const releases = parseReleaseFeed(await response.json());
      const candidate = selectUpdate(releases, {
        currentVersion: current.currentVersion,
        platform: current.platform,
        arch: current.arch,
      });

      const checkedAtUtc = new Date().toISOString();

      if (candidate === null) {
        candidateAsset = null;
        return publish({
          status: 'up-to-date',
          version: null,
          notes: [],
          size: 0,
          progress: null,
          plan: null,
          releaseUrl: null,
          checkedAtUtc,
          message: `Estás en la última versión (v${current.currentVersion}).`,
        });
      }

      // Ya descargada en una sesión anterior: no se vuelve a bajar, se ofrece aplicarla.
      if (pending !== null && pending.version === candidate.release.version) {
        return publish({
          status: 'ready',
          version: candidate.release.version,
          notes: releaseNotesLines(candidate.release.notes),
          releaseUrl: candidate.release.htmlUrl,
          checkedAtUtc,
          plan: installPlan(current.platform, pending.file).note,
          message: null,
        });
      }

      candidateAsset = candidate.asset;

      return publish({
        status: 'available',
        version: candidate.release.version,
        notes: releaseNotesLines(candidate.release.notes),
        size: candidate.asset?.size ?? 0,
        progress: null,
        downloadedPath: null,
        applyOnQuit: false,
        dismissed: false,
        releaseUrl: candidate.release.htmlUrl,
        checkedAtUtc,
        plan: null,
        message:
          candidate.asset === null
            ? 'Esta versión no publica un instalador para tu sistema: descárgala desde la página de la release.'
            : null,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return publish(
        manual
          ? { status: 'error', message: `No se ha podido comprobar si hay actualizaciones: ${detail}` }
          : { status: state.version === null ? 'idle' : state.status, message: null },
      );
    } finally {
      inFlight = null;
    }
  };

  inFlight = run();
  return inFlight;
}

// ---------------------------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------------------------

/**
 * Descarga el artefacto con verificación de longitud.
 *
 * Misma regla que el toolchain: si el servidor anuncia `content-length` y llega menos, el archivo
 * está cortado. Un instalador truncado se ejecuta igual y falla a mitad, dejando la instalación
 * en un estado peor que el de partida.
 */
export async function download(): Promise<UpdateState> {
  const current = env();

  if (state.status === 'ready' && pending !== null) return state;
  if (candidateAsset === null || state.version === null) {
    return publish({ status: 'error', message: 'No hay ninguna descarga disponible para tu sistema.' });
  }

  const asset = candidateAsset;
  const version = state.version;

  publish({ status: 'downloading', progress: 0, message: null });

  try {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': `DotForge-IDE/${current.currentVersion}`,
      },
    });

    if (!response.ok) {
      throw new Error(`la descarga respondió ${response.status} ${response.statusText}`);
    }

    const total = Number(response.headers.get('content-length') ?? asset.size ?? 0);
    const chunks: Uint8Array[] = [];
    let received = 0;

    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        chunks.push(value);
        received += value.length;
        publish({ progress: total > 0 ? Math.min(received / total, 1) : null });
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      chunks.push(buffer);
      received = buffer.length;
    }

    if (total > 0 && received !== total) {
      throw new Error(`descarga incompleta: ${received} de ${total} bytes`);
    }

    await mkdir(updatesDir(), { recursive: true });
    const file = join(updatesDir(), asset.name);
    await writeFile(file, Buffer.concat(chunks));

    pending = { version, file, savedAtUtc: new Date().toISOString() };
    await writePending(pending);

    return publish({
      status: 'ready',
      progress: 1,
      downloadedPath: file,
      plan: installPlan(current.platform, file).note,
      message: null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return publish({ status: 'error', progress: null, message: `La descarga ha fallado: ${detail}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Descartar y aplicar
// ---------------------------------------------------------------------------------------------

/**
 * "Descartar": la tarjeta se va y la actualización se queda.
 *
 * No es "no quiero actualizar", es "ahora no me interrumpas". Se sigue descargando en segundo
 * plano —el usuario no está esperando— y se instala al cerrar. Si la descarga falla, no se avisa:
 * la próxima comprobación volverá a ofrecerla.
 */
export function dismiss(): UpdateState {
  const next = publish({ dismissed: true, applyOnQuit: true, message: null });

  if (state.status === 'available' && candidateAsset !== null) {
    void download();
  }

  return next;
}

/**
 * Programa la instalación al cerrar y, con `now`, cierra.
 *
 * El botón "Reiniciar y aplicar" llega por aquí con `now`. Cerrar la aplicación es lo que dispara
 * `before-quit`, que es donde se lanza el instalador: un único camino de instalación, se llegue
 * pulsando el botón o cerrando la ventana tres horas después.
 */
export async function applyOnQuit(now: boolean): Promise<UpdateState> {
  if (state.status !== 'ready' || pending === null) {
    if (state.status === 'available') await download();
  }

  const next = publish({ applyOnQuit: pending !== null, dismissed: true });

  if (now && pending !== null) env().quit();
  return next;
}

/** ¿Queda algo que instalar al salir? Lo consulta `before-quit`. */
export function hasPendingInstall(): boolean {
  return pending !== null && state.applyOnQuit && existsSync(pending.file);
}

/**
 * Lanza el instalador y devuelve lo que se ha hecho.
 *
 * Se llama desde `before-quit`, así que tiene que ser síncrono y no puede esperar a nada: el
 * proceso está a punto de desaparecer. Por eso el hijo va `detached` y con la entrada y la salida
 * desconectadas —un hijo que hereda los descriptores del padre muere con él— y por eso no se usa
 * `shell.openPath`, que devuelve una promesa que nadie va a poder esperar.
 */
export function runPendingInstaller(): string | null {
  if (!hasPendingInstall() || pending === null) return null;

  const current = env();
  const plan = installPlan(current.platform, pending.file);

  try {
    if (plan.kind === 'silent') {
      spawnDetached(plan.command, plan.args);
      return `instalando ${pending.version} en silencio`;
    }

    const opener = current.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnDetached(opener, [plan.path]);
    return `abriendo el instalador de ${pending.version}`;
  } catch (error) {
    console.error(`[updater] no se ha podido lanzar el instalador: ${(error as Error).message}`);
    return null;
  }
}

/** Argumentos siempre como array y sin shell: la ruta lleva espacios y no se escapa a mano. */
function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

/** Olvida la descarga pendiente. Lo usan las pruebas y el borrado tras una instalación aplicada. */
export async function forget(): Promise<void> {
  await discardPending();
  candidateAsset = null;
  state = emptyUpdateState(environment?.currentVersion ?? '0.0.0');
  listener?.(state);
}
