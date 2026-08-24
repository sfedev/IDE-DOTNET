/**
 * Depuración .NET con NetCoreDbg (Samsung, MIT) hablando Debug Adapter Protocol.
 *
 * NetCoreDbg es la única alternativa open source real a `vsdbg`, cuya licencia sólo permite
 * usarlo desde productos de Microsoft. Se lanza con `--interpreter=vscode`, que expone DAP por
 * stdio con el mismo framing `Content-Length` que LSP.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, realpath as realpathCallback } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { githubToken, rateLimitHint, requestHeaders } from '../../shared/github-api.js';
import { describeProblems } from '../../shared/toolchain-manifest.js';
import { installArchive, verifyInstall } from '../services/toolchain-install.js';

const RELEASES = 'https://api.github.com/repos/Samsung/netcoredbg/releases/latest';
const HEADER_SEPARATOR = '\r\n\r\n';

/**
 * `realpath` **nativo**: es el único que expande los alias 8.3 de Windows.
 *
 * El de JavaScript resuelve enlaces simbólicos y devuelve `C:\...\DOTFOR~1` tal cual; el nativo
 * llama al sistema y devuelve el nombre largo. Medido, no supuesto.
 */
const realpathNative = promisify(realpathCallback.native);

/**
 * Ruta del archivo en la misma forma en la que la guarda el PDB.
 *
 * NetCoreDbg liga un breakpoint comparando la ruta que se le pide con la que trae el PDB, **como
 * texto**. El compilador guarda siempre la forma canónica, así que basta con que la ruta llegue con
 * otro nombre equivalente para que el breakpoint se quede "pendiente" para siempre: el programa
 * corre entero, nadie para en ningún sitio y no hay ningún error por ninguna parte.
 *
 * Pasa con más facilidad de la que parece:
 *   - Windows entrega alias 8.3 en cuanto un componente no cabe en ese formato. En los runners de
 *     GitHub, `%TEMP%` es `C:\Users\RUNNER~1\AppData\Local\Temp`, y de ahí salió el fallo que se
 *     tomó por lentitud de CI. Le pasa igual a cualquiera que abra el proyecto desde una ruta con
 *     `~1` (`C:\PROGRA~1\…`, un acceso directo antiguo, `%TEMP%`).
 *   - macOS resuelve `/var` a `/private/var`, y el PDB guarda la segunda.
 *
 * Si la ruta no se puede resolver —el archivo se acaba de borrar, o es un búfer sin guardar— se
 * manda tal cual: un breakpoint imposible no debe tumbar la sesión de depuración.
 */
export async function debuggerSourcePath(file: string): Promise<string> {
  try {
    return await realpathNative(file);
  } catch {
    return file;
  }
}

export interface DebuggerBinary {
  version: string;
  executable: string;
  directory: string;
}

/** Nombre del asset de la release para la plataforma actual, o null si no hay publicado. */
export function assetNameForPlatform(): string | null {
  if (process.platform === 'win32') {
    // Sólo se publica un zip de 64 bits para Windows; sirve para x64 y para arm64 vía emulación.
    return 'netcoredbg-win64.zip';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'netcoredbg-osx-arm64.zip' : 'netcoredbg-osx-amd64.zip';
  }
  return null; // Linux se publica como .tar.gz; fuera del alcance de esta distribución.
}

/**
 * Descarga el ZIP comprobando que llega entero.
 *
 * `arrayBuffer()` devuelve tan contento lo que haya llegado si la conexión se corta a medias, y un
 * ZIP cortado puede conservar directorio central válido para parte de sus entradas: se extrae "bien"
 * y el fallo aparece mucho después, dentro del proceso que carga el archivo que falta. Si el
 * servidor anuncia `content-length`, se exige que cuadre.
 */
async function download(url: string, onProgress: (detail: string, ratio: number | null) => void): Promise<Buffer> {
  onProgress('descargando NetCoreDbg', null);

  // La descarga vive en `objects.githubusercontent.com`, no en la API: `requestHeaders` no le
  // adjunta ninguna credencial, y es justo lo que se quiere.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10 * 60 * 1000),
    headers: requestHeaders(url, { accept: 'application/octet-stream' }),
  });

  if (!response.ok) {
    throw new Error(`descarga de NetCoreDbg fallida (${response.status})`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress(`descargando NetCoreDbg ${(received / 1048576).toFixed(1)} MB`, total > 0 ? received / total : null);
    }
  }

  if (total > 0 && received !== total) {
    throw new Error(`descarga incompleta de NetCoreDbg: ${received} de ${total} bytes`);
  }

  return Buffer.concat(chunks);
}

export async function acquireDebugger(
  toolchainDir: string,
  onProgress: (detail: string, ratio: number | null) => void,
): Promise<DebuggerBinary> {
  const assetName = assetNameForPlatform();
  if (!assetName) {
    throw new Error(
      `no hay binario de NetCoreDbg publicado en formato ZIP para ${process.platform}/${process.arch}`,
    );
  }

  onProgress('resolviendo la última release de NetCoreDbg', null);

  const response = await fetch(RELEASES, {
    signal: AbortSignal.timeout(60_000),
    headers: requestHeaders(RELEASES),
  });

  if (!response.ok) {
    // Un 403 aquí casi nunca es un permiso: es el límite por IP de la API sin autenticar, que en
    // un runner de CI compartido está agotado a todas horas. Se dice, en vez de dejar un número.
    const hint = rateLimitHint(response.status, githubToken() !== null);
    throw new Error(
      `no se ha podido consultar las releases de NetCoreDbg (${response.status})${hint === null ? '' : `: ${hint}`}`,
    );
  }

  const release = (await response.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  const asset = release.assets.find((item) => item.name === assetName);
  if (!asset) {
    const available = release.assets.map((item) => item.name).join(', ');
    throw new Error(`la release ${release.tag_name} no publica ${assetName}. Disponibles: ${available}`);
  }

  const version = release.tag_name;
  const directory = join(toolchainDir, 'netcoredbg', version);
  const executableName = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';
  const executable = join(directory, executableName);

  /**
   * Comprobación de la instalación en cada arranque.
   *
   * Antes bastaba con que existiera un marcador `.dotforge-ok` que guardaba el SHA-256 del ZIP
   * descargado. Eso verifica un archivo que ya no está en el disco y no dice nada de los que sí
   * están, que es exactamente el agujero por el que un DLL truncado dejó el servidor de lenguaje
   * inservible durante nueve versiones (ADR-041). El depurador se instalaba igual, y aquí falla
   * peor: un `netcoredbg.exe` cortado no da un error claro, da una sesión que no arranca.
   *
   * Una instalación sin manifiesto —las de la v1.9 y anteriores— cuenta como no verificada y se
   * reinstala sola: el usuario no tiene que borrar nada.
   */
  const check = await verifyInstall(directory);
  const usable = check.verified && check.problems.length === 0 && existsSync(executable);

  if (!usable) {
    if (check.verified && check.problems.length > 0) {
      onProgress(`la copia de NetCoreDbg ${version} está dañada (${describeProblems(check.problems)}); se reinstala`, null);
    }

    const archive = await download(asset.browser_download_url, onProgress);

    onProgress('extrayendo NetCoreDbg', null);
    // El zip trae todo bajo una carpeta `netcoredbg/`: se descarta ese primer nivel.
    await installArchive(archive, directory, {
      kind: 'netcoredbg',
      packageVersion: version,
      rid: `${process.platform}-${process.arch}`,
      strip: 1,
    });
  }

  if (!existsSync(executable)) {
    throw new Error(`no se encuentra ${executableName} en ${directory}`);
  }

  if (process.platform !== 'win32') {
    // El bit de ejecución no sobrevive al ZIP.
    const { chmod } = await import('node:fs/promises');
    await chmod(executable, 0o755);
  }

  onProgress(`NetCoreDbg ${version} listo`, 1);
  return { version, executable, directory };
}

export interface DebugLaunchOptions {
  /** Ruta del ensamblado a depurar (`bin/Debug/<tfm>/App.dll`). */
  program: string;
  cwd: string;
  args?: string[];
  env?: Record<string, string>;
  stopAtEntry?: boolean;
}

/**
 * Sesión de depuración: cliente DAP mínimo pero completo para el ciclo habitual
 * (breakpoints, continuar, pasos, pila, variables, evaluar).
 */
export class DebugSession extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private sequence = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  get running(): boolean {
    return this.child !== null;
  }

  async start(binary: DebuggerBinary, options: DebugLaunchOptions): Promise<void> {
    await this.stop();

    const child = spawn(binary.executable, ['--interpreter=vscode'], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.emit('log', chunk.toString('utf8')));
    child.on('close', (code) => {
      this.child = null;
      this.emit('terminated', code);
    });

    await this.request('initialize', {
      clientID: 'dotforge',
      clientName: 'DotForge IDE',
      adapterID: 'coreclr',
      locale: 'es',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
    });

    await this.request('launch', {
      name: 'DotForge',
      type: 'coreclr',
      request: 'launch',
      program: options.program,
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env ?? {},
      stopAtEntry: options.stopAtEntry ?? false,
      justMyCode: true,
      console: 'internalConsole',
    });
  }

  /** Reemplaza el conjunto de breakpoints de un archivo (semántica de DAP). */
  async setBreakpoints(file: string, lines: number[]): Promise<unknown> {
    // La ruta se canonicaliza aquí, en la frontera con el adaptador, y no en quien llama: el
    // renderer sigue nombrando sus archivos como los abrió, y ningún camino nuevo puede olvidarse.
    const path = await debuggerSourcePath(file);

    return this.request('setBreakpoints', {
      source: { path },
      breakpoints: lines.map((line) => ({ line })),
      lines,
    });
  }

  configurationDone(): Promise<unknown> {
    return this.request('configurationDone', {});
  }

  continue(threadId: number): Promise<unknown> {
    return this.request('continue', { threadId });
  }

  next(threadId: number): Promise<unknown> {
    return this.request('next', { threadId });
  }

  stepIn(threadId: number): Promise<unknown> {
    return this.request('stepIn', { threadId });
  }

  stepOut(threadId: number): Promise<unknown> {
    return this.request('stepOut', { threadId });
  }

  pause(threadId: number): Promise<unknown> {
    return this.request('pause', { threadId });
  }

  stackTrace(threadId: number): Promise<unknown> {
    return this.request('stackTrace', { threadId, startFrame: 0, levels: 50 });
  }

  scopes(frameId: number): Promise<unknown> {
    return this.request('scopes', { frameId });
  }

  variables(variablesReference: number): Promise<unknown> {
    return this.request('variables', { variablesReference });
  }

  evaluate(expression: string, frameId: number | undefined): Promise<unknown> {
    return this.request('evaluate', { expression, frameId, context: 'watch' });
  }

  async stop(): Promise<void> {
    if (!this.child) return;

    const child = this.child;
    this.child = null;

    try {
      await Promise.race([
        this.requestOn(child, 'disconnect', { terminateDebuggee: true }),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Un adaptador colgado no debe impedir cerrar la sesión.
    }

    if (child.exitCode === null) child.kill('SIGKILL');

    for (const [seq, pending] of this.pending) {
      pending.reject(new Error('sesión de depuración terminada'));
      this.pending.delete(seq);
    }
  }

  request(command: string, args: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('no hay sesión de depuración activa'));
    return this.requestOn(this.child, command, args);
  }

  private requestOn(child: ChildProcess, command: string, args: unknown): Promise<unknown> {
    const seq = this.sequence++;

    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      const payload = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }), 'utf8');
      child.stdin?.write(`Content-Length: ${payload.length}${HEADER_SEPARATOR}`);
      child.stdin?.write(payload);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) return;

      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(this.buffer.toString('ascii', 0, headerEnd));
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const contentLength = Number.parseInt(lengthMatch[1]!, 10);
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + contentLength) return;

      const body = this.buffer.toString('utf8', bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        this.dispatch(JSON.parse(body) as Record<string, unknown>);
      } catch {
        this.emit('log', 'mensaje DAP ilegible');
      }
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (message['type'] === 'response') {
      const seq = message['request_seq'] as number;
      const pending = this.pending.get(seq);
      if (!pending) return;
      this.pending.delete(seq);

      if (message['success'] === false) {
        pending.reject(new Error(String(message['message'] ?? 'la petición DAP ha fallado')));
      } else {
        pending.resolve(message['body']);
      }
      return;
    }

    if (message['type'] === 'event') {
      this.emit('dap-event', { event: message['event'], body: message['body'] });
    }
  }
}

export const debugSession = new DebugSession();
