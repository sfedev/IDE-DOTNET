/**
 * Cliente LSP sobre stdio con framing `Content-Length`.
 *
 * Vive en el proceso principal y hace de puente hacia el renderer, que es quien adapta las
 * respuestas a las APIs de Monaco. El renderer nunca habla directamente con el servidor.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { LspState } from '../../shared/contracts.js';
import { createServerLogScanner, type ServerFault, type ServerLogScanner } from '../../shared/lsp-health.js';
import { serverRequestResponse } from '../../shared/lsp-protocol.js';
import { CLIENT_TOKEN_MODIFIERS, CLIENT_TOKEN_TYPES } from '../../shared/semantic-tokens.js';
import { APP_VERSION } from '../../shared/version.js';
import type { AcquiredServer } from './acquire.js';

const HEADER_SEPARATOR = '\r\n\r\n';
const REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface LspClientEvents {
  notification: [{ method: string; params: unknown }];
  state: [LspState];
  log: [string];
  /** El servidor se ha roto por dentro aunque siga contestando. Ver `src/shared/lsp-health.ts`. */
  fault: [{ fault: ServerFault; server: AcquiredServer }];
}

/** Capacidades que DotForge anuncia. Sólo se declara lo que el renderer sabe consumir. */
function clientCapabilities(): Record<string, unknown> {
  return {
    workspace: {
      workspaceFolders: true,
      configuration: true,
      didChangeWatchedFiles: { dynamicRegistration: true },
      symbol: { dynamicRegistration: false },
      applyEdit: false,
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
      completion: {
        dynamicRegistration: false,
        completionItem: {
          snippetSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
          insertReplaceSupport: true,
        },
        contextSupport: true,
      },
      hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
      signatureHelp: {
        dynamicRegistration: false,
        signatureInformation: { documentationFormat: ['markdown', 'plaintext'] },
      },
      definition: { dynamicRegistration: false, linkSupport: false },
      typeDefinition: { dynamicRegistration: false },
      implementation: { dynamicRegistration: false },
      references: { dynamicRegistration: false },
      documentHighlight: { dynamicRegistration: false },
      documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
      formatting: { dynamicRegistration: false },
      rangeFormatting: { dynamicRegistration: false },
      rename: { dynamicRegistration: false, prepareSupport: false },
      codeAction: {
        dynamicRegistration: false,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'source', 'source.organizeImports'],
          },
        },
      },
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
      inlayHint: { dynamicRegistration: false },
      /**
       * Tokens semánticos.
       *
       * Las dos listas **no pueden ir vacías**: para LSP, "no declaro ningún tipo de token" es
       * exactamente lo que parece, y un servidor que lo lea correctamente no manda nada. Estuvieron
       * vacías desde la Fase 2, que es por lo que el resaltado de C# se quedaba en lo que sabía la
       * gramática Monarch. Roslyn publica su propia leyenda al inicializarse y el renderer traduce
       * de la suya a la nuestra (`src/shared/semantic-tokens.ts`).
       */
      semanticTokens: {
        dynamicRegistration: false,
        requests: { range: false, full: { delta: false } },
        tokenTypes: [...CLIENT_TOKEN_TYPES],
        tokenModifiers: [...CLIENT_TOKEN_MODIFIERS],
        formats: ['relative'],
        overlappingTokenSupport: false,
        multilineTokenSupport: false,
        serverCancelSupport: true,
        augmentsSyntaxTokens: true,
      },
    },
    general: { positionEncodings: ['utf-16'] },
  };
}

export class LspClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private state: LspState = { status: 'idle', server: null, version: null, message: null, progress: null };
  private serverCapabilities: Record<string, unknown> | null = null;

  /** Qué servidor está en marcha. Roslyn necesita que se le abra la solución; OmniSharp no. */
  private serverKind: AcquiredServer['kind'] | null = null;

  /** El servidor tal y como se adquirió: hace falta su versión y su directorio para poder conmutar. */
  private server: AcquiredServer | null = null;

  /**
   * Escáner del stderr del servidor.
   *
   * No es un detalle de registro: es la **única** señal de que el servidor se ha roto. Cuando el
   * gráfico MEF de Roslyn no compone, el proceso no muere, contesta al handshake y anuncia
   * "Language server initialized" por stdout; lo que falla después es cada petición, en silencio.
   */
  private scanner: ServerLogScanner = createServerLogScanner();

  /**
   * Hemos pedido nosotros que se pare.
   *
   * Sin esto no se puede distinguir un cierre ordenado de una espantada: los dos terminan con
   * código 0. Y la espantada existe —Roslyn se apaga solo cuando su cola de mensajes se rompe—,
   * así que un cierre que nadie ha pedido es un fallo del servidor y tiene que disparar el respaldo.
   */
  private intentionalStop = false;

  getState(): LspState {
    return this.state;
  }

  getServerCapabilities(): Record<string, unknown> | null {
    return this.serverCapabilities;
  }

  /** El servidor en marcha, o `null`. */
  getServer(): AcquiredServer | null {
    return this.server;
  }

  /** El fallo detectado en el arranque actual, si lo hubo. */
  getFault(): ServerFault | null {
    return this.scanner.fault();
  }

  private setState(patch: Partial<LspState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** Arranca el servidor y completa el handshake `initialize` / `initialized`. */
  async start(server: AcquiredServer, workspaceRoot: string): Promise<LspState> {
    await this.stop();

    this.setState({ status: 'starting', server: server.displayName, version: server.version, message: null, progress: null });

    // El servidor de Roslyn exige un directorio de logs y hablar LSP por stdio.
    const args = [...server.args];
    if (server.kind === 'roslyn') {
      const logDirectory = await mkdtemp(join(tmpdir(), 'dotforge-lsp-'));
      args.push('--logLevel', 'Information', '--extensionLogDirectory', logDirectory, '--stdio');
    }

    const child = spawn(server.command, args, {
      cwd: workspaceRoot,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child = child;
    this.serverKind = server.kind;
    this.server = server;
    this.scanner = createServerLogScanner();
    this.intentionalStop = false;

    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.emit('log', text);

      const fault = this.scanner.push(text);
      if (fault !== null) this.emit('fault', { fault, server });
    });

    child.on('error', (error) => {
      this.setState({ status: 'error', message: `no se ha podido lanzar el servidor: ${error.message}` });
    });

    child.on('close', (code) => {
      this.rejectAllPending(new Error(`el servidor de lenguaje ha terminado con código ${code}`));
      this.child = null;

      // Lo que quedara en el búfer sin salto de línea final: un volcado de excepción que mata al
      // proceso suele terminar justo así, sin el último `\n`.
      const logged = this.scanner.flush();
      const wasUp = this.state.status === 'ready' || this.state.status === 'starting';

      /**
       * Un cierre que no hemos pedido es un fallo aunque el código sea 0.
       *
       * Es el caso de Roslyn rompiendo su cola de mensajes: se despide con un `logMessage` por
       * stdout y sale con 0, sin tocar stderr. Sin esta rama el IDE se queda con un servidor
       * muerto, la barra en "error" y ningún respaldo.
       */
      const fault =
        logged ??
        (!this.intentionalStop && wasUp
          ? {
              category: 'crash' as const,
              signature: 'exit',
              detail: `el servidor se ha cerrado solo con código ${code}`,
            }
          : null);

      if (fault !== null) this.emit('fault', { fault, server });

      if (this.state.status !== 'idle') {
        this.setState({ status: 'error', message: `el servidor ha terminado con código ${code}` });
      }
    });

    try {
      const result = (await this.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'DotForge IDE', version: APP_VERSION },
        locale: 'es',
        rootUri: pathToFileURL(workspaceRoot).toString(),
        workspaceFolders: [{ uri: pathToFileURL(workspaceRoot).toString(), name: workspaceRoot }],
        capabilities: clientCapabilities(),
        initializationOptions: {},
      })) as { capabilities?: Record<string, unknown> };

      this.serverCapabilities = result?.capabilities ?? null;
      this.notify('initialized', {});
      this.setState({ status: 'ready', message: null, progress: 1 });
    } catch (error) {
      this.setState({
        status: 'error',
        message: `el handshake ha fallado: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return this.state;
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.setState({ status: 'idle', server: null, version: null, message: null, progress: null });
      return;
    }

    const child = this.child;
    this.child = null;
    this.intentionalStop = true;

    try {
      // Cortesía primero: shutdown + exit dan al servidor ocasión de cerrar sus archivos.
      await Promise.race([
        this.requestOn(child, 'shutdown', null),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      this.writeTo(child, { jsonrpc: '2.0', method: 'exit' });
    } catch {
      // Un servidor que no responde a shutdown se mata sin más.
    }

    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000).unref();

    this.rejectAllPending(new Error('el servidor de lenguaje se ha detenido'));
    this.serverCapabilities = null;
    this.serverKind = null;
    this.server = null;
    this.setState({ status: 'idle', server: null, version: null, message: null, progress: null });
  }

  isRunning(): boolean {
    return this.child !== null && this.state.status === 'ready';
  }

  /**
   * Abre la solución en el servidor.
   *
   * **Sin esto, `Microsoft.CodeAnalysis.LanguageServer` no responde a nada.** El handshake termina
   * bien, el servidor dice "listo" y luego devuelve `null` a cualquier `hover`, `completion` o
   * `semanticTokens`, porque su espacio de trabajo está vacío: `initialize` le dice dónde está la
   * carpeta, pero no qué proyectos cargar. Eso se pide con dos notificaciones propias suyas,
   * `solution/open` y `project/open`, que no son parte de LSP y por eso es fácil no enterarse.
   *
   * Se prefiere la solución al listado de proyectos: con el `.sln` el servidor resuelve él mismo
   * las referencias entre proyectos, y con la lista suelta puede acabar cargando cada uno aislado.
   *
   * OmniSharp descubre la solución solo a partir de la raíz, así que aquí no hace nada.
   */
  openWorkspace(solutionPath: string | null, projectPaths: readonly string[]): void {
    if (this.serverKind !== 'roslyn' || this.child === null) return;

    if (solutionPath !== null && solutionPath !== '') {
      this.notify('solution/open', { solution: pathToFileURL(solutionPath).toString() });
      return;
    }

    if (projectPaths.length === 0) return;
    this.notify('project/open', { projects: projectPaths.map((path) => pathToFileURL(path).toString()) });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('el servidor de lenguaje no está en marcha'));
    return this.requestOn(this.child, method, params);
  }

  notify(method: string, params: unknown): void {
    if (!this.child) return;
    this.writeTo(this.child, { jsonrpc: '2.0', method, params });
  }

  /** Cancela una petición en vuelo (el usuario siguió escribiendo y el resultado ya no sirve). */
  cancel(id: number): void {
    this.notify('$/cancelRequest', { id });
  }

  private requestOn(child: ChildProcess, method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.cancel(id);
        reject(new Error(`la petición LSP "${method}" ha superado ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer, method });
      this.writeTo(child, { jsonrpc: '2.0', id, method, params });
    });
  }

  private writeTo(child: ChildProcess, message: unknown): void {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    child.stdin?.write(`Content-Length: ${payload.length}${HEADER_SEPARATOR}`);
    child.stdin?.write(payload);
  }

  /** Reensambla el stream: un mensaje puede llegar partido o varios juntos en un mismo chunk. */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) return;

      const header = this.buffer.toString('ascii', 0, headerEnd);
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        // Cabecera irrecuperable: se descarta hasta el separador y se sigue.
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const contentLength = Number.parseInt(lengthMatch[1]!, 10);
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + contentLength) return; // Aún falta cuerpo.

      const body = this.buffer.toString('utf8', bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        this.dispatch(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        this.emit('log', `mensaje LSP ilegible: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message['id'];

    if (typeof id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;

      this.pending.delete(id);
      clearTimeout(pending.timer);

      if ('error' in message && message['error']) {
        const error = message['error'] as { code?: number; message?: string };
        pending.reject(new Error(`${pending.method}: ${error.message ?? 'error desconocido'} (${error.code ?? '?'})`));
      } else {
        pending.resolve(message['result']);
      }
      return;
    }

    if (typeof message['method'] === 'string') {
      /**
       * Peticiones del **servidor** al cliente. Hay que contestarlas o se queda bloqueado, pero
       * contestar `null` a todas no es "no contestar nada malo": a `workspace/configuration`,
       * Roslyn responde apagándose con código 0 y sin un solo error por stderr. Lo que se devuelve
       * lo decide `src/shared/lsp-protocol.ts`, que es puro y está probado.
       */
      if (typeof id === 'number' && this.child) {
        const result = serverRequestResponse(message['method'], message['params']);
        this.writeTo(this.child, { jsonrpc: '2.0', id, result });
      }
      this.emit('notification', { method: message['method'], params: message['params'] });
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export const lspClient = new LspClient();
