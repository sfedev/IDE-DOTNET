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
 *  - **El ciclo se cierra al arrancar.** Lo que se lanzó al salir no lo puede contar nadie desde
 *    dentro —el proceso desaparece a continuación—, así que se anota el intento antes de irse y en
 *    el arranque siguiente se compara con la versión que corre: instalada, o no. `judgePending`
 *    dicta cuál de los dos, y el resultado viaja al renderer en `state.outcome`.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonText } from '../../shared/json-text.js';
import { githubToken, rateLimitHint, requestHeaders } from '../../shared/github-api.js';

import {
  assetFor,
  emptyUpdateState,
  installPlan,
  judgePending,
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

/**
 * Instalación descargada y esperando a que el IDE se cierre.
 *
 * `attempts` es lo que convierte este archivo en la memoria del ciclo: se incrementa **al lanzar**
 * el instalador, no al terminarlo, porque para cuando termina ya no hay proceso que lo escriba.
 * Que en el arranque siguiente siga habiendo un registro con `attempts > 0` y una versión que
 * todavía es más nueva significa exactamente una cosa: se lanzó y no llegó a aplicarse.
 *
 * `notes` y `releaseUrl` viajan con él para poder contar qué trae la versión **después** de
 * instalarla. En ese momento el feed diría que ya no hay ninguna actualización, así que las notas
 * de la release que se acaba de aplicar no habría de dónde sacarlas.
 */
interface PendingInstall {
  version: string;
  file: string;
  savedAtUtc: string;
  attempts: number;
  notes: string[];
  releaseUrl: string | null;
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

/** Agente que declaran las peticiones del actualizador: dice desde qué versión se pregunta. */
function userAgent(version: string): string {
  return `DotForge-IDE/${version}`;
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
 * Además de fijar el entorno, **cierra el ciclo de la sesión anterior**. Cuatro casos, y los cuatro
 * los dicta `judgePending` a partir de datos:
 *
 *  - `applied` — la versión que corre ya es la prometida: se borra la descarga (entre 90 y 150 MB
 *    que no sirven para nada) y se publica el "✅ ¡Actualizado!" con las notas guardadas.
 *  - `failed` — se lanzó el instalador y el IDE ha vuelto a abrirse en la versión de antes: se
 *    avisa **a la vista**, con la descarga intacta para poder reintentarlo sin volver a bajarla, y
 *    sin rearmar la instalación al cerrar. Reintentar en silencio lo que ya falló una vez y el
 *    usuario pudo cancelar a propósito es insistir, no ayudar.
 *  - `pending` — descargada y nunca lanzada: se rearma la promesa, como siempre.
 *  - `stale` — el archivo ya no está: se borra el rastro.
 */
export async function initialize(options: UpdaterEnvironment): Promise<UpdateState> {
  environment = options;
  state = emptyUpdateState(options.currentVersion);
  pending = null;
  candidateAsset = null;

  const record = await readPending();
  if (record === null) return state;

  const plan = installPlan(options.platform, record.file);
  const verdict = judgePending(record, {
    currentVersion: options.currentVersion,
    fileExists: existsSync(record.file),
    planKind: plan.kind,
  });

  if (verdict.kind === 'stale') {
    await discardPending();
    return state;
  }

  if (verdict.kind === 'applied') {
    await discardPending();
    return publish({
      status: 'up-to-date',
      outcome: verdict.outcome,
      notes: verdict.outcome.notes,
      releaseUrl: verdict.outcome.releaseUrl,
      message: null,
    });
  }

  pending = record;

  if (verdict.kind === 'failed') {
    return publish({
      status: 'ready',
      version: record.version,
      notes: verdict.outcome.notes,
      releaseUrl: verdict.outcome.releaseUrl,
      downloadedPath: record.file,
      // Ni programada ni escondida: el aviso tiene que verse, y el siguiente cierre no puede
      // volver a lanzar solo lo que acaba de no funcionar.
      applyOnQuit: false,
      dismissed: false,
      plan: plan.note,
      planKind: plan.kind,
      outcome: verdict.outcome,
      message: null,
    });
  }

  return publish({
    status: 'ready',
    version: record.version,
    notes: record.notes,
    releaseUrl: record.releaseUrl,
    downloadedPath: record.file,
    applyOnQuit: true,
    dismissed: true,
    plan: plan.note,
    planKind: plan.kind,
    message: `La versión ${record.version} está descargada y se instalará al cerrar el IDE.`,
  });
}

/**
 * Lee el registro pendiente.
 *
 * Lo escribe una versión del IDE y lo lee otra, así que todo lo que no sea `version` y `file` se
 * completa con un valor por defecto en vez de exigirse: un `pending.json` de la v2.7.0 no tiene
 * `attempts` ni `notes`, y descartarlo entero por eso perdería una descarga de 130 MB.
 */
async function readPending(): Promise<PendingInstall | null> {
  const path = join(updatesDir(), PENDING_FILE);
  if (!existsSync(path)) return null;

  try {
    const raw = parseJsonText<Partial<PendingInstall>>(await readFile(path, 'utf8'));
    if (typeof raw.version !== 'string' || typeof raw.file !== 'string') return null;

    return {
      version: raw.version,
      file: raw.file,
      savedAtUtc: raw.savedAtUtc ?? '',
      attempts: typeof raw.attempts === 'number' && Number.isFinite(raw.attempts)
        ? Math.max(Math.trunc(raw.attempts), 0)
        : 0,
      notes: Array.isArray(raw.notes) ? raw.notes.filter((line): line is string => typeof line === 'string') : [],
      releaseUrl: typeof raw.releaseUrl === 'string' ? raw.releaseUrl : null,
    };
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
      const feedUrl = current.feedUrl ?? UPDATE_FEED;

      // Las cabeceras se piden al módulo que decide adónde puede viajar el token, como los
      // adquisidores del depurador y del servidor de lenguaje. Aquí importa por partida doble: el
      // feed **es** `api.github.com` —así que la credencial, si la hay, sube el límite de 60
      // peticiones por hora y por IP a 5 000— y la descarga del artefacto vive en otro host, donde
      // adjuntarla sería filtrarla. Escribiendo las dos a mano, esa diferencia dependía de que
      // nadie se despistara.
      const response = await fetch(feedUrl, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: requestHeaders(feedUrl, { userAgent: userAgent(current.currentVersion) }),
      });

      if (!response.ok) {
        // Un 404 en `/releases` no es un fallo de red: es que el repositorio todavía no publica
        // versiones (o no es público). Decir "404 Not Found" convierte un estado normal en un
        // error incomprensible, así que se traduce a lo que de verdad significa.
        if (response.status === 404) {
          throw new Error('el repositorio de versiones todavía no publica ninguna release');
        }

        // Un 403 de esta API casi nunca es un permiso: es el límite por IP, y el mensaje que trae
        // no lo menciona. Sin esta traducción, quien lo ve busca el problema en su red.
        const hint = rateLimitHint(response.status, githubToken() !== null);
        if (hint !== null) throw new Error(hint);

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
        const plan = installPlan(current.platform, pending.file);
        return publish({
          status: 'ready',
          version: candidate.release.version,
          notes: releaseNotesLines(candidate.release.notes),
          releaseUrl: candidate.release.htmlUrl,
          checkedAtUtc,
          plan: plan.note,
          planKind: plan.kind,
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
        planKind: null,
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
    // `asset.url` apunta a `objects.githubusercontent.com`, no a la API: `requestHeaders` no le
    // adjunta ninguna credencial, y eso es exactamente lo que tiene que pasar.
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: requestHeaders(asset.url, {
        accept: 'application/octet-stream',
        userAgent: userAgent(current.currentVersion),
      }),
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

    // Las notas y el enlace se guardan **ahora**, con la release todavía a la vista. Después de
    // instalarla el feed dirá que no hay ninguna actualización, y contar qué trae la versión que se
    // acaba de aplicar no tendría de dónde salir.
    pending = {
      version,
      file,
      savedAtUtc: new Date().toISOString(),
      attempts: 0,
      notes: state.notes,
      releaseUrl: state.releaseUrl,
    };
    await writePending(pending);

    const plan = installPlan(current.platform, file);

    return publish({
      status: 'ready',
      progress: 1,
      downloadedPath: file,
      plan: plan.note,
      planKind: plan.kind,
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
  // `applyOnQuit` sólo se arma si hay algo que aplicar. Sin esta condición, cerrar el aviso de
  // "✅ ¡Actualizado!" —que es una tarjeta más y se descarta igual— dejaba programada al cierre una
  // instalación que ya no existe.
  const next = publish({ dismissed: true, applyOnQuit: pending !== null, message: null });

  if (state.status === 'available' && candidateAsset !== null) {
    void download();
  }

  return next;
}

/**
 * "Enterado": el aviso de cierre de bucle se va.
 *
 * Tiene acción propia porque no es lo mismo que `dismiss`. `dismiss` habla de una actualización que
 * está por venir —esconde la tarjeta y deja la instalación programada—; esto habla de una que ya
 * pasó, y lo único que hace es borrar la noticia. Mezclarlos dejaría un "instalar al cerrar" armado
 * cada vez que alguien cierra un mensaje de éxito.
 */
export function acknowledgeOutcome(): UpdateState {
  return publish({ outcome: null });
}

/**
 * Programa la instalación al cerrar y, con `now`, cierra.
 *
 * El botón "Cerrar e instalar" llega por aquí con `now`. Cerrar la aplicación es lo que dispara
 * `before-quit`, que es donde se lanza el instalador: un único camino de instalación, se llegue
 * pulsando el botón o cerrando la ventana tres horas después.
 *
 * El aviso previo —lo que se va a cerrar, cuánto tarda y si la aplicación vuelve sola— lo plantea
 * el renderer antes de llamar aquí. Este camino no pregunta: cuando llega con `now`, el usuario ya
 * ha dicho que sí a un texto que le explicaba exactamente esto.
 */
export async function applyOnQuit(now: boolean): Promise<UpdateState> {
  if (state.status !== 'ready' || pending === null) {
    if (state.status === 'available') await download();
  }

  // El aviso de un intento fallido deja de tener sentido en cuanto se reintenta: si vuelve a
  // fallar, el arranque siguiente lo escribe otra vez y con el número de intentos actualizado.
  const next = publish({ applyOnQuit: pending !== null, dismissed: true, outcome: null });

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

  // El intento se anota **antes** de lanzar nada, y por eso cuenta intentos y no fracasos: lo que
  // pase a partir de aquí ya no lo puede escribir nadie. El instalador va desprendido y el proceso
  // desaparece en el mismo suspiro, así que su código de salida no lo lee ni lo leerá jamás este
  // IDE. Lo que el arranque siguiente encuentra —un registro lanzado y una versión que sigue
  // siendo más nueva— es toda la evidencia que hay, y es suficiente.
  recordAttemptSync();

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

/**
 * Suma un intento al registro pendiente, en síncrono.
 *
 * Es el único `writeFileSync` del servicio y está justificado por dónde ocurre: `before-quit`, con
 * el bucle de eventos ya de salida. La regla del ADR-051 —nada síncrono en el hilo principal—
 * protege el repintado y el IPC de una ventana viva; aquí no queda ventana a la que hacerle esperar
 * un milisegundo, y un `await` no llegaría a resolverse nunca.
 *
 * Si falla, se traga: perder la anotación del intento significa no poder avisar del fallo en el
 * arranque siguiente, y eso es infinitamente mejor que impedir el cierre del IDE.
 */
function recordAttemptSync(): void {
  if (pending === null) return;

  pending = { ...pending, attempts: pending.attempts + 1 };

  try {
    writeFileSync(join(updatesDir(), PENDING_FILE), `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`[updater] no se ha podido anotar el intento: ${(error as Error).message}`);
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
