/**
 * Sesiones de pseudoterminal (`node-pty`).
 *
 * Lo que hace posible que una pestaña de terminal del IDE sea una terminal de verdad: un
 * intérprete real detrás de un PTY, con colores, `Ctrl+C`, autocompletado nativo y su propio `cd`.
 * La terminal asistida (`command-runner.ts`) no desaparece —sigue siendo la única que sugiere
 * subcomandos y ramas, y la única que funciona sin binario nativo—, pero deja de ser la única.
 *
 * **Sobre la dependencia nativa**, que es la decisión que hay que justificar (ADR-059): el proyecto
 * se había comprometido a no tener ninguna, para que el empaquetado fuese reproducible y no hiciera
 * falta compilar nada en la máquina del usuario. Ese compromiso sigue en pie y `node-pty` **no lo
 * rompe**: desde la 1.1 publica los binarios ya compilados dentro del propio paquete
 * (`prebuilds/<plataforma>-<arquitectura>/`) y son Node-API, que es ABI estable, así que valen para
 * Electron sin `electron-rebuild`. No hay `node-gyp`, no hay Visual Studio Build Tools, no hay paso
 * de rebuild por plataforma.
 *
 * Lo que sí cambia es el reparto: es una `optionalDependency` y se carga **tarde y dentro de un
 * try/catch**. Si falta el binario de esta plataforma —o npm ha bloqueado los scripts de
 * instalación, que es lo normal con npm 11— el IDE no se cae: los perfiles de PTY se ofrecen
 * apagados con el motivo escrito, y la terminal asistida sigue funcionando. Misma regla que con
 * Docker apagado (ADR-033): que falte una fuente no puede vaciar el panel.
 *
 * No importa `electron`: el emisor de eventos se le inyecta, así que las pruebas pueden abrir una
 * sesión de verdad en un directorio temporal.
 */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { delimiter, extname, isAbsolute, join } from 'node:path';

import {
  findProfile,
  resolveLaunch,
  substitutionNotice,
  unavailableReason,
  type TerminalProfile,
} from '../../shared/terminal-profiles.js';

/**
 * La parte de `node-pty` que se usa, declarada aquí.
 *
 * Se escribe a mano en vez de importar sus tipos porque el módulo es opcional: con un `import type`
 * de un paquete que puede no estar, la compilación del proyecto pasa a depender de él.
 */
interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePty {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      useConpty?: boolean;
    },
  ): PtyProcess;
}

export interface PtySessionInfo {
  terminalId: string;
  profileId: string;
  /** Programa realmente lanzado. Se enseña en el título de la pestaña. */
  file: string;
  pid: number;
  cwd: string;
  /**
   * Aviso a enseñar en la pestaña antes de la primera línea del intérprete.
   *
   * Sólo viene cuando se ha lanzado con una alternativa del catálogo en vez de con el programa
   * principal del perfil. Ausente en el caso normal.
   */
  notice?: string;
}

export interface PtyCallbacks {
  onData(payload: { terminalId: string; data: string }): void;
  onExit(payload: { terminalId: string; exitCode: number }): void;
}

export class PtyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtyUnavailableError';
  }
}

/** Tamaño de arranque. El renderer manda el real en cuanto mide su hueco. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/** Tope de sesiones a la vez. Cada una es un proceso con sus hijos: no puede ser ilimitado. */
export const MAX_PTY_SESSIONS = 12;

/** Tope por escritura. Un pegado grande cabe; una avalancha desde el renderer, no. */
export const MAX_WRITE_CHARS = 512 * 1024;

interface Session {
  info: PtySessionInfo;
  process: PtyProcess;
}

const sessions = new Map<string, Session>();

let cached: NodePty | null = null;
let loadError: string | null = null;
let attempted = false;

/**
 * Carga `node-pty` la primera vez que hace falta.
 *
 * `require` y no `import`: es opcional y su ausencia tiene que ser un valor, no una excepción al
 * cargar el módulo. El bundle del proceso principal lo deja externo, así que esto resuelve contra
 * el `node_modules` que se empaqueta fuera del asar.
 */
function loadNodePty(): NodePty | null {
  if (attempted) return cached;
  attempted = true;

  /**
   * Desde dónde se busca el módulo, en orden.
   *
   * **No se usa el `require` global**, aunque parezca lo obvio: esbuild reescribe ese identificador
   * en el bundle ESM por un sustituto que existe, pasa un `typeof … === 'function'` y **lanza al
   * llamarlo** ("Dynamic require is not supported"). El síntoma es que las pseudoterminales
   * funcionan en la aplicación y se declaran no disponibles en las pruebas, que es la peor forma de
   * equivocarse: la suite pasa en verde diciendo que no hay nada que probar.
   *
   * Con `createRequire` la resolución es explícita: junto al bundle —que en producción está dentro
   * del asar, y Node redirige solo a `app.asar.unpacked/node_modules`— y, si no, desde el
   * directorio de trabajo, que es donde lo encuentran las pruebas.
   */
  const anchors = [
    typeof __dirname === 'string' ? join(__dirname, 'noop.js') : null,
    join(process.cwd(), 'noop.js'),
  ].filter((anchor): anchor is string => anchor !== null);

  for (const anchor of anchors) {
    try {
      cached = createRequire(anchor)('node-pty') as NodePty;
      loadError = null;
      return cached;
    } catch (error) {
      cached = null;
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  return cached;
}

export interface PtyAvailability {
  available: boolean;
  /** Por qué no, con palabras que digan qué hacer. `null` si sí. */
  reason: string | null;
}

/**
 * ¿Se pueden abrir pseudoterminales en esta instalación?
 *
 * El motivo se devuelve escrito porque el fallo típico —npm no ha ejecutado los scripts de
 * instalación del paquete— produce un "Cannot find module" que no dice absolutamente nada sobre
 * qué hacer a continuación.
 */
export function availability(): PtyAvailability {
  if (loadNodePty() !== null) return { available: true, reason: null };

  return {
    available: false,
    reason:
      'No se ha podido cargar node-pty, así que no hay pseudoterminales: las pestañas de ' +
      'PowerShell y cmd quedan deshabilitadas y la terminal asistida sigue funcionando. ' +
      `Detalle: ${loadError ?? 'módulo ausente'}.`,
  };
}

/** Sólo para las pruebas: olvida el intento de carga. */
export function resetLoader(): void {
  cached = null;
  loadError = null;
  attempted = false;
}

/**
 * Entorno del intérprete.
 *
 * Se hereda el del proceso y se le quitan las variables de Electron, que confunden a cualquier
 * script de Node lanzado desde dentro: `ELECTRON_RUN_AS_NODE` haría que un `npm` arrancado en esta
 * terminal se ejecutase con el Node de Electron y no con el del sistema.
 */
function shellEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('ELECTRON_')) continue;
    env[key] = value;
  }

  // Los programas de consola miran esto para decidir si pueden pintar en color.
  env['TERM'] = env['TERM'] ?? 'xterm-256color';
  env['COLORTERM'] = env['COLORTERM'] ?? 'truecolor';

  return env;
}

/**
 * ¿Existe ese intérprete en esta máquina?
 *
 * El catálogo de perfiles es fijo y declara más de los que suele haber: `pwsh.exe` (PowerShell 7)
 * es una instalación aparte que mucha gente no tiene, y `/bin/zsh` no está en todas las
 * distribuciones. Ofrecerlos sin comprobar deja al usuario eligiendo una opción que falla al
 * pulsarla, y el error llega **después**, en otro panel: la peor forma de enterarse.
 *
 * Se busca como lo haría el intérprete: ruta absoluta tal cual, y si no, por `PATH` probando las
 * extensiones de `PATHEXT` en Windows.
 */
export async function resolveProgram(file: string): Promise<string | null> {
  if (isAbsolute(file)) return (await exists(file)) ? file : null;

  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
      : [''];

  const hasExtension = extname(file) !== '';
  const directories = (process.env['PATH'] ?? '').split(delimiter).filter((entry) => entry !== '');

  for (const directory of directories) {
    if (hasExtension) {
      const candidate = join(directory, file);
      if (await exists(candidate)) return candidate;
      continue;
    }

    for (const extension of extensions) {
      const candidate = join(directory, `${file}${extension}`);
      if (await exists(candidate)) return candidate;
    }
  }

  return null;
}

/** ¿Está instalado? Envoltorio de `resolveProgram` para quien sólo necesita el sí o el no. */
export async function programExists(file: string): Promise<boolean> {
  return (await resolveProgram(file)) !== null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CreateOptions {
  profileId: string;
  cwd: string;
  columns?: number;
  rows?: number;
}

/**
 * Abre una sesión.
 *
 * @throws PtyUnavailableError si no hay binario nativo, si el perfil no es de tipo `pty` o si ya
 *         hay demasiadas sesiones abiertas. Las tres son estados normales y el llamante las enseña
 *         como aviso, no como error de programa.
 */
export async function create(options: CreateOptions, callbacks: PtyCallbacks): Promise<PtySessionInfo> {
  const pty = loadNodePty();
  if (!pty) throw new PtyUnavailableError(availability().reason ?? 'no hay pseudoterminales');

  if (sessions.size >= MAX_PTY_SESSIONS) {
    throw new PtyUnavailableError(
      `ya hay ${MAX_PTY_SESSIONS} terminales abiertas. Cierra alguna antes de abrir otra.`,
    );
  }

  const profile: TerminalProfile | null = findProfile(options.profileId);
  if (!profile || profile.kind !== 'pty' || profile.file === null) {
    throw new PtyUnavailableError(`el perfil "${options.profileId}" no abre ningún intérprete`);
  }

  // Cuál de las alternativas del catálogo hay en esta máquina. Para un intérprete del sistema es
  // siempre la primera; para `claude`, la que corresponda a cómo se instalara. Que no haya ninguna
  // es el caso normal de una herramienta que no viene con el sistema, y se dice con la orden de
  // instalación dentro.
  const launch = await resolveLaunch(profile, resolveProgram);
  if (launch === null) throw new PtyUnavailableError(unavailableReason(profile));

  const terminalId = randomUUID();
  const args = [...launch.args];

  let child: PtyProcess;
  try {
    child = pty.spawn(launch.file, args, {
      name: 'xterm-256color',
      cols: options.columns ?? DEFAULT_COLUMNS,
      rows: options.rows ?? DEFAULT_ROWS,
      cwd: options.cwd,
      env: shellEnvironment(),
    });
  } catch (error) {
    // El caso normal: `pwsh.exe` ofrecido y no instalado. El mensaje de node-pty no nombra el
    // programa, así que se nombra aquí.
    throw new PtyUnavailableError(
      `no se ha podido arrancar ${launch.file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Si se ha arrancado con una alternativa, la pestaña lo dice. Callarlo dejaba al usuario con una
  // terminal que tardaba o fallaba sin motivo aparente.
  const notice = substitutionNotice(profile, launch);

  const info: PtySessionInfo = {
    terminalId,
    profileId: profile.id,
    file: launch.file,
    pid: child.pid,
    cwd: options.cwd,
    ...(notice === null ? {} : { notice }),
  };

  sessions.set(terminalId, { info, process: child });

  child.onData((data) => callbacks.onData({ terminalId, data }));
  child.onExit(({ exitCode }) => {
    sessions.delete(terminalId);
    callbacks.onExit({ terminalId, exitCode });
  });

  return info;
}

/**
 * Escribe en la entrada del intérprete.
 *
 * Lo que llega es **texto tecleado**, no una línea de comandos que se trocee: incluye los
 * caracteres de control (U+0003 es Ctrl+C, U+0009 es tabular) y es lo que hace que la terminal sea
 * interactiva. Por eso no se valida el contenido; lo que se valida es que el destino sea una
 * sesión abierta de este proceso.
 */
export function write(terminalId: string, data: string): boolean {
  const session = sessions.get(terminalId);
  if (!session) return false;

  // Un pegado de medio megabyte es un pegado; uno de cien no es nadie tecleando. El tope acota lo
  // que un renderer comprometido puede empujar de una vez a la entrada del intérprete.
  session.process.write(data.length > MAX_WRITE_CHARS ? data.slice(0, MAX_WRITE_CHARS) : data);
  return true;
}

/**
 * Ajusta el tamaño.
 *
 * Sin esto, el intérprete cree que la ventana mide 80x24 y parte las líneas donde no toca: es el
 * defecto que delata a una terminal que no se ha molestado en reenviar el tamaño.
 */
export function resize(terminalId: string, columns: number, rows: number): boolean {
  const session = sessions.get(terminalId);
  if (!session) return false;

  // Un tamaño de cero llega de verdad: pasa mientras el panel está plegado y su hueco mide 0 px.
  const safeColumns = Math.max(1, Math.min(Math.trunc(columns) || DEFAULT_COLUMNS, 1000));
  const safeRows = Math.max(1, Math.min(Math.trunc(rows) || DEFAULT_ROWS, 500));

  try {
    session.process.resize(safeColumns, safeRows);
  } catch {
    // El intérprete puede haber muerto entre el `get` y el `resize`. No es nada que contar.
    return false;
  }

  return true;
}

/** Cierra una sesión y mata su árbol de procesos. */
export function dispose(terminalId: string): boolean {
  const session = sessions.get(terminalId);
  if (!session) return false;

  sessions.delete(terminalId);
  killTree(session);
  return true;
}

/**
 * Cierra todas. La llama `before-quit`.
 *
 * Sin esto, cerrar el IDE deja vivos tantos intérpretes como pestañas hubiera abiertas, cada uno
 * con lo que estuviera ejecutando dentro: un `dotnet watch` lanzado a mano seguiría ocupando su
 * puerto y bloqueando los archivos del `bin` mucho después de que la ventana desapareciera.
 */
export function disposeAll(): void {
  for (const session of [...sessions.values()]) killTree(session);
  sessions.clear();
}

export function list(): PtySessionInfo[] {
  return [...sessions.values()].map((session) => session.info);
}

/**
 * Mata el intérprete y con él sus hijos.
 *
 * En Windows, `kill()` de node-pty cierra el pseudoconsola, y eso se lleva por delante el árbol
 * entero: es justo lo que hace falta, porque lo que hay dentro de una terminal casi nunca es un
 * único proceso. Se envuelve en `try` porque matar algo que ya ha muerto lanza, y eso no es un
 * fallo del que haya que enterarse al cerrar el IDE.
 */
function killTree(session: Session): void {
  try {
    session.process.kill();
  } catch {
    // Ya estaba muerto.
  }
}
