/**
 * Registro de todos los handlers IPC.
 *
 * Un único punto de entrada para que la superficie expuesta al renderer se pueda auditar de un
 * vistazo. Cada handler valida sus argumentos: `ipcRenderer.invoke` puede llamarse con cualquier
 * cosa desde una página comprometida.
 */
import { execFile } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import type {
  AiProbeResult,
  AiProviderId,
  AiStatus,
  AppInfo,
  AppSettings,
  DebugAction,
  DebugLaunchRequest,
  DebugState,
  DotnetTaskKind,
  DotnetTaskRequest,
  GitCommandResult,
  GitFileDiff,
  LspState,
  RecentWorkspace,
  SolutionInfo,
  TerminalContext,
  TerminalCwd,
  TerminalRunResult,
} from '../../shared/contracts.js';
import type { GitDiffRequest } from '../../shared/git.js';
import type { EfOperation, EfOperationOptions } from '../../shared/efcore.js';
import type { ComposeAction, ContainerAction } from '../../shared/compose.js';
import { composeArgs, containerArgs, isComposeFile } from '../../shared/compose.js';
import { EF_OPERATIONS } from '../../shared/efcore.js';
import { TUNNEL_TOOLS, isValidPort, missingToolMessage } from '../../shared/dev-tunnel.js';
import type { TunnelTool } from '../../shared/dev-tunnel.js';
import type { MetricsState } from '../../shared/perf-counters.js';
import type { UpdateState } from '../../shared/updates.js';
import type { MarketplaceExtension, SearchQuery, SearchResult } from '../../shared/open-vsx.js';
import { isTrustedDownload, isValidSegment, SEARCH_PAGE_SIZE } from '../../shared/open-vsx.js';
import type { InstalledExtension } from '../../shared/vsix.js';
import { describeFault, type ServerFault } from '../../shared/lsp-health.js';
import { legendFromCapabilities } from '../../shared/semantic-tokens.js';
import { filterForClass, filterForTests } from '../../shared/test-explorer.js';
import { buildDiffRequest } from '../../shared/git.js';
import { IPC, IPC_EVENTS } from '../../shared/contracts.js';
import { AI_PROVIDER_IDS } from '../../shared/ai.js';
import { detectArchitecture, projectContexts } from '../../shared/ai-context.js';
import type { ScaffoldOptions } from '../../shared/scaffold-types.js';
import { DEFAULT_STARTUP_CONFIG } from '../../shared/startup.js';
import { listBlueprints } from '../../scaffold/blueprints/index.js';
import { generateSolution } from '../../scaffold/generator.js';
import { debugController, resolveDebugTarget } from '../debug/debug-controller.js';
import {
  acquireLanguageServer,
  auditInstall,
  discardInstall,
  pardonRoslynVersion,
  quarantineRoslynVersion,
  type AcquiredServer,
  type AcquireProgress,
} from '../lsp/acquire.js';
import { lspClient } from '../lsp/lsp-client.js';
import * as aiService from '../services/ai/ai-service.js';
import * as aiSecrets from '../services/ai/secret-store.js';
import { AiRequestError, coerceChatRequest } from '../services/ai/validate.js';
import * as commandRunner from '../services/command-runner.js';
import * as terminalSession from '../services/terminal-session.js';
import * as dockerService from '../services/docker-service.js';
import * as dotnetService from '../services/dotnet-service.js';
import * as efcoreService from '../services/efcore-service.js';
import * as fileService from '../services/file-service.js';
import * as httpClient from '../services/http-client-service.js';
import * as gitService from '../services/git-service.js';
import { readNpmScripts } from '../services/node-scripts.js';
import * as metricsService from '../services/metrics-service.js';
import * as nugetService from '../services/nuget-service.js';
import * as testService from '../services/test-service.js';
import * as tunnelService from '../services/tunnel-service.js';
import * as updaterService from '../services/updater-service.js';
import * as openVsxService from '../services/open-vsx-service.js';
import * as extensionInstaller from '../services/extension-installer.js';
import * as settingsService from '../services/settings-service.js';
import * as startupService from '../services/startup-service.js';
import { loadSolution } from '../services/solution-service.js';
import { allowRoot, assertInsideWorkspace, isInside, setWorkspaceRoot } from '../services/workspace-guard.js';
import { describeRecents, firstAvailable, isOpenableWorkspace } from '../services/workspace-recents.js';

const execFileAsync = promisify(execFile);

let currentSolution: SolutionInfo | null = null;

/** Archivo que hay que abrir en cuanto el renderer esté listo (argumento de línea de comandos). */
let pendingFile: string | null = null;

export function setPendingFile(path: string | null): void {
  pendingFile = path;
}

/** Emite un evento a todas las ventanas abiertas. */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`el parámetro "${name}" debe ser una cadena no vacía`);
  }
  return value;
}

const TASK_KINDS: ReadonlySet<string> = new Set<DotnetTaskKind>([
  'build', 'rebuild', 'clean', 'restore', 'test', 'run', 'watch', 'format',
]);

/**
 * Forma de un nombre completamente cualificado de prueba.
 *
 * Se valida antes de construir el filtro porque acaba dentro de un `argv`: identificadores de C#
 * separados por puntos y nada más. Un nombre que no encaje se descarta en vez de escaparse, que
 * es la decisión conservadora — como mucho no se ejecuta una prueba.
 */
const TEST_ID = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/;

const taskCallbacks: dotnetService.DotnetTaskCallbacks = {
  onStarted: (payload) => broadcast(IPC_EVENTS.taskStarted, payload),
  onOutput: (payload) => broadcast(IPC_EVENTS.taskOutput, payload),
  onExit: (payload) => broadcast(IPC_EVENTS.taskExit, payload),
};

// ---------------------------------------------------------------------------------------------
// Información del entorno .NET
// ---------------------------------------------------------------------------------------------

async function dotnetVersions(command: 'sdks' | 'runtimes'): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('dotnet', [`--list-${command}`], {
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    // Sin SDK instalado el IDE sigue siendo utilizable como editor; se informa, no se rompe.
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------------------------

/**
 * Abre una carpeta como workspace.
 *
 * Se valida **antes** de tocar nada. Antes, un directorio inexistente llegaba hasta `loadSolution`
 * y reventaba con un ENOENT crudo... después de haber movido ya la raíz del guardián de rutas a
 * una carpeta que no existe. Ahora, si la ruta no sirve, el estado del proceso principal se queda
 * exactamente como estaba y el mensaje dice qué pasa y qué hacer.
 */
async function openWorkspaceDirectory(directory: string): Promise<SolutionInfo> {
  if (!isOpenableWorkspace(directory)) {
    throw new Error(
      `la carpeta ya no existe o no es un directorio: ${directory}. ` +
        'Puede que la hayas movido, renombrado o borrado; ábrela de nuevo desde Archivo > Abrir carpeta.',
    );
  }

  // Abrir workspace es lo único que puede ampliar el ámbito de rutas permitido.
  setWorkspaceRoot(directory);
  gitService.invalidate();
  currentSolution = await loadSolution(directory);

  await settingsService.rememberWorkspace(directory);
  // La terminal se muda con la solución: seguir en la carpeta de la anterior es defendible en la
  // teoría y desconcertante en la práctica.
  syncTerminalContext();
  broadcast(IPC_EVENTS.workspaceChanged, currentSolution);

  // El LSP se arranca en segundo plano: abrir una carpeta no debe bloquearse por una descarga.
  void startLanguageServer();

  return currentSolution;
}

// ---------------------------------------------------------------------------------------------
// LSP
// ---------------------------------------------------------------------------------------------

function toolchainDirectory(): string {
  return join(app.getPath('userData'), 'toolchain');
}

/**
 * Hay una conmutación a OmniSharp en marcha.
 *
 * Sin esta bandera el fallo se atiende dos veces: la traza de MEF ocupa veinte líneas y el proceso
 * sigue vivo escupiéndolas mientras ya se está bajando el respaldo.
 */
let switchingLanguageServer = false;

/** Estamos dentro del arranque: el fallo lo atiende `startLanguageServer`, no el evento. */
let startingLanguageServer = false;

function acquireReporter(): AcquireProgress {
  return (phase, ratio, detail) => {
    broadcast(IPC_EVENTS.lspStateChanged, {
      status: phase === 'done' ? 'starting' : 'acquiring',
      server: null,
      version: null,
      message: detail,
      progress: ratio,
    } satisfies LspState);
  };
}

/** Abre la solución en el servidor recién arrancado. Roslyn no carga nada por su cuenta. */
function openCurrentWorkspace(): void {
  if (!currentSolution) return;
  lspClient.openWorkspace(
    currentSolution.path,
    currentSolution.projects.map((project) => project.path),
  );
}

/**
 * Conmuta a OmniSharp con Roslyn ya instalado y arrancado.
 *
 * Antes de rendirse con esa versión hay que responder una pregunta que cuesta caro equivocar:
 * ¿está **corrupta esta copia** o está **mal la compilación**? Las dos se ven igual desde fuera
 * —el mismo `PartDiscoveryException`— y se arreglan al revés. Una copia corrupta se borra y se
 * vuelve a bajar; una compilación mala se veta, y vetar una versión buena por un archivo que se
 * truncó al escribirlo dejaría a este equipo sin Roslyn para siempre.
 *
 * Por eso se audita la instalación entera, hash a hash, antes de decidir.
 */
async function switchToOmniSharp(fault: ServerFault, broken: AcquiredServer): Promise<LspState> {
  if (switchingLanguageServer) return lspClient.getState();
  switchingLanguageServer = true;

  const reason = describeFault(fault, broken.displayName);

  try {
    broadcast(IPC_EVENTS.lspStateChanged, {
      status: 'acquiring',
      server: null,
      version: null,
      message: `${reason}; comprobando su instalación`,
      progress: null,
    } satisfies LspState);

    const audit = await auditInstall(broken.directory);
    console.error(`[lsp] ${reason}: ${fault.detail}`);
    console.error(`[lsp] auditoría de ${broken.directory}: ${audit.detail}`);

    if (audit.corrupt) {
      // La copia estaba dañada: se tira para que el próximo arranque la baje limpia, y se le
      // levanta el veto a la versión, que no tenía culpa de nada.
      await discardInstall(broken.directory);
      await pardonRoslynVersion(toolchainDirectory(), broken.version);
    } else {
      await quarantineRoslynVersion(toolchainDirectory(), broken.version, `${reason}: ${fault.detail}`);
    }

    await lspClient.stop();

    const fallback = await acquireLanguageServer(toolchainDirectory(), acquireReporter(), { prefer: 'omnisharp' });
    const state = await lspClient.start(fallback, currentSolution?.directory ?? broken.directory);
    openCurrentWorkspace();

    const explanation = audit.corrupt
      ? `${reason} porque su copia estaba dañada (${audit.detail}); se ha reinstalado para el próximo arranque`
      : `${reason}; esa versión queda descartada en este equipo`;

    const next: LspState = { ...state, message: `${explanation}. IntelliSense servido por ${fallback.displayName}.` };
    broadcast(IPC_EVENTS.lspStateChanged, next);
    return next;
  } catch (error) {
    const state: LspState = {
      status: 'degraded',
      server: null,
      version: null,
      message:
        `${reason} y tampoco ha sido posible arrancar OmniSharp ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'El editor sigue funcionando con resaltado y snippets.',
      progress: null,
    };
    broadcast(IPC_EVENTS.lspStateChanged, state);
    return state;
  } finally {
    switchingLanguageServer = false;
  }
}

async function startLanguageServer(): Promise<LspState> {
  const settings = settingsService.current();
  if (!settings.lspEnabled) {
    return { status: 'idle', server: null, version: null, message: 'LSP desactivado en preferencias', progress: null };
  }
  if (!currentSolution) {
    return { status: 'idle', server: null, version: null, message: 'no hay workspace abierto', progress: null };
  }

  broadcast(IPC_EVENTS.lspStateChanged, {
    status: 'acquiring',
    server: null,
    version: null,
    message: 'preparando el servidor de lenguaje',
    progress: 0,
  } satisfies LspState);

  startingLanguageServer = true;
  try {
    const server = await acquireLanguageServer(toolchainDirectory(), acquireReporter());
    if (server.note !== null) console.error(`[lsp] ${server.displayName} ${server.note}`);

    const state = await lspClient.start(server, currentSolution.directory);

    /**
     * El fallo de MEF llega por stderr **antes** de que el servidor conteste al handshake, así que
     * cuando `start()` vuelve ya está detectado. Se comprueba aquí en vez de reaccionar al evento
     * porque conmutar a mitad de un `initialize` en vuelo deja peticiones colgadas.
     */
    const fault = lspClient.getFault();
    if (fault !== null && server.kind === 'roslyn') {
      startingLanguageServer = false;
      return await switchToOmniSharp(fault, server);
    }

    // Roslyn no carga nada por su cuenta: hay que abrirle la solución explícitamente o devolverá
    // `null` a todas las peticiones con el servidor en estado "listo".
    openCurrentWorkspace();

    return state;
  } catch (error) {
    const state: LspState = {
      status: 'degraded',
      server: null,
      version: null,
      message:
        `sin IntelliSense de C#: ${error instanceof Error ? error.message : String(error)}. ` +
        'El editor sigue funcionando con resaltado y snippets.',
      progress: null,
    };
    broadcast(IPC_EVENTS.lspStateChanged, state);
    return state;
  } finally {
    startingLanguageServer = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------------------------

/**
 * Pone al día el contexto de la terminal con el workspace abierto.
 *
 * Vive aparte porque hay tres momentos que lo necesitan —abrir, cerrar y arrancar— y en los tres
 * hay que decirle lo mismo: dónde está el hogar, cuál es la raíz y cómo se llama.
 */
function syncTerminalContext(): void {
  terminalSession.setContext({
    home: app.getPath('home'),
    workspace: currentSolution?.directory ?? null,
    workspaceName: currentSolution?.name ?? null,
  });
}

export function registerIpcHandlers(): void {
  // Sin workspace la terminal arranca en la carpeta personal, que es donde arranca cualquier
  // terminal del sistema.
  syncTerminalContext();

  debugController.on('state', (state: DebugState) => broadcast(IPC_EVENTS.debugStateChanged, state));
  debugController.on('stopped', (payload) => broadcast(IPC_EVENTS.debugStopped, payload));
  debugController.on('output', (payload) => broadcast(IPC_EVENTS.debugOutput, payload));

  lspClient.on('state', (state: LspState) => broadcast(IPC_EVENTS.lspStateChanged, state));
  lspClient.on('notification', (payload) => broadcast(IPC_EVENTS.lspNotification, payload));

  /**
   * El servidor se ha roto por dentro estando ya en marcha.
   *
   * Durante el arranque lo atiende `startLanguageServer`, que es quien tiene el `initialize` en la
   * mano; este camino cubre lo que aflora despues, cuando Roslyn empieza a cargar la solucion y se
   * le cae una extension. En los dos casos el usuario acaba con OmniSharp sin tocar nada.
   */
  lspClient.on('fault', ({ fault, server }: { fault: ServerFault; server: AcquiredServer }) => {
    if (startingLanguageServer || server.kind !== 'roslyn') return;
    void switchToOmniSharp(fault, server);
  });

  /**
   * Lo que el servidor escriba por stderr va a la consola del proceso principal.
   *
   * Un servidor de lenguaje que arranca, contesta al handshake y luego devuelve `null` a todo es
   * el fallo más difícil de ver de este proyecto: por fuera parece que funciona. Su stderr es la
   * única pista, y tragárselo era garantizar no encontrarlo nunca.
   */
  lspClient.on('log', (text: string) => {
    const trimmed = text.trim();
    if (trimmed !== '') console.error(`[lsp] ${trimmed}`);
  });

  // --- Aplicación ---------------------------------------------------------------------------
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => {
    let builtAtUtc: string | null = null;
    try {
      const { readFile } = await import('node:fs/promises');
      const info = JSON.parse(await readFile(join(__dirname, 'build-info.json'), 'utf8')) as { builtAtUtc: string };
      builtAtUtc = info.builtAtUtc;
    } catch {
      builtAtUtc = null;
    }

    const [sdks, runtimes] = await Promise.all([dotnetVersions('sdks'), dotnetVersions('runtimes')]);

    return {
      name: 'DotForge IDE',
      version: app.getVersion(),
      electron: process.versions['electron'] ?? '',
      chrome: process.versions['chrome'] ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      primaryModifier: process.platform === 'darwin' ? 'Cmd' : 'Ctrl',
      builtAtUtc,
      dotnetSdks: sdks,
      dotnetRuntimes: runtimes,
    };
  });

  ipcMain.handle(IPC.appSettingsGet, (): AppSettings => settingsService.current());

  ipcMain.handle(IPC.appSettingsSet, async (_event, patch: unknown): Promise<AppSettings> => {
    if (typeof patch !== 'object' || patch === null) throw new Error('las preferencias deben ser un objeto');
    return settingsService.save(patch as Partial<AppSettings>);
  });

  ipcMain.handle(IPC.appOpenExternal, async (_event, url: unknown): Promise<void> => {
    const value = requireString(url, 'url');
    // Sólo http(s): sin esto, un enlace `file:` o `smb:` en un README abriría cualquier cosa.
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`protocolo no permitido: ${parsed.protocol}`);
    }
    await shell.openExternal(value);
  });

  ipcMain.handle(IPC.appShowItemInFolder, (_event, path: unknown): void => {
    shell.showItemInFolder(assertInsideWorkspace(path));
  });

  // --- Workspace ----------------------------------------------------------------------------
  ipcMain.handle(IPC.workspaceOpenDialog, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Abrir carpeta o solución',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Abrir',
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.workspaceOpen, async (_event, path: unknown): Promise<SolutionInfo> => {
    return openWorkspaceDirectory(requireString(path, 'path'));
  });

  ipcMain.handle(IPC.workspaceRecents, (): RecentWorkspace[] =>
    describeRecents(settingsService.current().recentWorkspaces),
  );

  ipcMain.handle(IPC.workspaceOpenRecent, async (): Promise<SolutionInfo | null> => {
    const directory = firstAvailable(describeRecents(settingsService.current().recentWorkspaces));
    return directory === null ? null : openWorkspaceDirectory(directory);
  });

  ipcMain.handle(IPC.workspaceCurrent, (): SolutionInfo | null => currentSolution);

  // Se consume una sola vez: recargar la ventana no debe reabrir el archivo.
  ipcMain.handle(IPC.workspacePendingFile, (): string | null => {
    const path = pendingFile;
    pendingFile = null;
    return path;
  });

  ipcMain.handle(IPC.workspaceClose, async (): Promise<void> => {
    await lspClient.stop();
    currentSolution = null;
    setWorkspaceRoot(null);
    syncTerminalContext();
    broadcast(IPC_EVENTS.workspaceChanged, null);
  });

  // --- Sistema de archivos -------------------------------------------------------------------
  ipcMain.handle(IPC.fsListDirectory, (_event, path: unknown) => fileService.listDirectory(requireString(path, 'path')));
  ipcMain.handle(IPC.fsReadFile, (_event, path: unknown) => fileService.readDocument(requireString(path, 'path')));
  ipcMain.handle(IPC.fsWriteFile, (_event, path: unknown, content: unknown) =>
    fileService.writeDocument(requireString(path, 'path'), typeof content === 'string' ? content : ''),
  );
  ipcMain.handle(IPC.fsCreateFile, (_event, path: unknown, content: unknown) =>
    fileService.createFile(requireString(path, 'path'), typeof content === 'string' ? content : ''),
  );
  ipcMain.handle(IPC.fsCreateDirectory, (_event, path: unknown) =>
    fileService.createDirectory(requireString(path, 'path')),
  );
  ipcMain.handle(IPC.fsRename, (_event, from: unknown, to: unknown) =>
    fileService.renamePath(requireString(from, 'from'), requireString(to, 'to')),
  );
  ipcMain.handle(IPC.fsDelete, (_event, path: unknown) => fileService.deletePath(requireString(path, 'path')));

  // --- Solución -----------------------------------------------------------------------------
  ipcMain.handle(IPC.solutionLoad, async (_event, path: unknown): Promise<SolutionInfo> => {
    currentSolution = await loadSolution(assertInsideWorkspace(path));
    broadcast(IPC_EVENTS.workspaceChanged, currentSolution);
    return currentSolution;
  });

  // --- Git ---------------------------------------------------------------------------------
  ipcMain.handle(IPC.gitStatus, () => (currentSolution ? gitService.readStatus(currentSolution.directory) : null));

  ipcMain.handle(IPC.gitBranches, () =>
    currentSolution ? gitService.listBranches(currentSolution.directory) : [],
  );

  ipcMain.handle(IPC.gitRepository, () =>
    currentSolution ? gitService.readRepository(currentSolution.directory) : null,
  );

  // Las operaciones de escritura comparten forma: exigen workspace, reciben rutas y devuelven el
  // estado ya refrescado. Se declaran juntas para que la superficie de git se lea de un vistazo.
  const gitPaths = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const requireWorkspace = (): string => {
    if (!currentSolution) throw new Error('abre una carpeta antes de usar el control de código fuente');
    return currentSolution.directory;
  };

  ipcMain.handle(IPC.gitStage, (_event, paths: unknown): Promise<GitCommandResult> =>
    gitService.stage(requireWorkspace(), gitPaths(paths)),
  );

  ipcMain.handle(IPC.gitUnstage, (_event, paths: unknown): Promise<GitCommandResult> =>
    gitService.unstage(requireWorkspace(), gitPaths(paths)),
  );

  ipcMain.handle(IPC.gitDiscard, (_event, paths: unknown): Promise<GitCommandResult> =>
    gitService.discard(requireWorkspace(), gitPaths(paths)),
  );

  ipcMain.handle(IPC.gitCommit, (_event, message: unknown, options: unknown): Promise<GitCommandResult> =>
    gitService.commit(requireWorkspace(), message, {
      amend: typeof options === 'object' && options !== null && (options as { amend?: unknown }).amend === true,
    }),
  );

  ipcMain.handle(IPC.gitPush, (): Promise<GitCommandResult> => gitService.push(requireWorkspace()));
  ipcMain.handle(IPC.gitPull, (): Promise<GitCommandResult> => gitService.pull(requireWorkspace()));
  ipcMain.handle(IPC.gitSync, (): Promise<GitCommandResult> => gitService.sync(requireWorkspace()));

  ipcMain.handle(IPC.gitCheckout, (_event, branch: unknown): Promise<GitCommandResult> =>
    gitService.checkout(requireWorkspace(), branch),
  );

  ipcMain.handle(IPC.gitCreateBranch, (_event, name: unknown): Promise<GitCommandResult> =>
    gitService.createBranch(requireWorkspace(), name),
  );

  /**
   * Contenido de los dos lados de una comparación.
   *
   * La petición **no se toma tal cual**: el renderer manda el archivo del que se quiere ver el
   * diff y aquí se vuelve a derivar con la misma función pura que usa el panel. Así, un renderer
   * comprometido no puede pedir `HEAD:../../.ssh/id_rsa`: la ruta se valida contra la raíz del
   * repositorio y contra la del workspace antes de tocar nada.
   */
  ipcMain.handle(IPC.gitFileDiff, async (_event, raw: unknown): Promise<GitFileDiff> => {
    const directory = requireWorkspace();
    const root = await gitService.repositoryRoot(directory);
    if (root === null) throw new Error('esta carpeta no es un repositorio de git');

    if (typeof raw !== 'object' || raw === null) throw new Error('petición de diferencias inválida');
    const incoming = raw as Partial<GitDiffRequest> & { change?: unknown };

    const status = await gitService.readRepository(directory);
    const area = incoming.area === 'staged' ? 'staged' : 'unstaged';
    const list = area === 'staged' ? (status?.staged ?? []) : (status?.unstaged ?? []);
    const change = list.find((entry) => entry.path === incoming.path);

    if (!change) throw new Error(`el archivo ya no tiene cambios en esta sección: ${String(incoming.path)}`);

    const request = buildDiffRequest(change);

    // El ámbito de una comparación es el **repositorio**, no el workspace: abrir `apps/api` de un
    // monorepo no debería impedir ver el diff de un archivo de `apps/web`, y las operaciones de
    // git ya actúan sobre todo el repositorio. La raíz no la elige el renderer: la calcula git a
    // partir de la carpeta abierta, así que sigue siendo un ámbito de confianza.
    const absolutePath = join(root, request.path);
    if (!isInside(root, absolutePath)) {
      throw new Error(`acceso denegado: "${absolutePath}" está fuera del repositorio`);
    }

    const [original, modified] = await Promise.all([
      gitService.diffSideContent(directory, request, 'original'),
      gitService.diffSideContent(directory, request, 'modified'),
    ]);

    return {
      request,
      original,
      modified,
      languageId: fileService.languageIdFor(request.path),
      absolutePath,
    };
  });

  // --- Perfiles de inicio ---------------------------------------------------------------------
  ipcMain.handle(IPC.startupGet, () => {
    if (!currentSolution) return { ...DEFAULT_STARTUP_CONFIG };
    // Se pasan los proyectos actuales: un perfil que apunta a un .csproj que ya no existe se
    // limpia solo en vez de dejar el botón de Play apuntando al vacío.
    return startupService.load(
      currentSolution.directory,
      currentSolution.projects.map((project) => project.path),
    );
  });

  ipcMain.handle(IPC.startupSave, (_event, config: unknown) => {
    if (!currentSolution) throw new Error('abre una solución antes de guardar perfiles de inicio');
    return startupService.save(currentSolution.directory, config);
  });

  // --- Entity Framework Core ------------------------------------------------------------------
  /**
   * Objetivo de una operación de EF Core, ya validado.
   *
   * Los tres caminos —proyecto, proyecto de arranque y contexto— llegan del renderer, así que las
   * rutas pasan por el guardián del workspace y el nombre del contexto se acota a un identificador
   * de C#: es lo único que puede ser, y así no hay forma de colar un argumento suelto a la CLI.
   */
  function efTarget(raw: unknown): EfOperationOptions {
    if (typeof raw !== 'object' || raw === null) throw new Error('faltan los datos del proyecto de EF Core');
    const options = raw as Partial<EfOperationOptions>;

    const project = assertInsideWorkspace(options.project);
    const startupProject =
      typeof options.startupProject === 'string' && options.startupProject.trim() !== ''
        ? assertInsideWorkspace(options.startupProject)
        : null;

    const context =
      typeof options.context === 'string' && options.context.trim() !== '' ? options.context.trim() : null;

    if (context !== null && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(context)) {
      throw new Error(`nombre de DbContext no válido: ${context}`);
    }

    const targetMigration =
      typeof options.targetMigration === 'string' && options.targetMigration.trim() !== ''
        ? options.targetMigration.trim()
        : null;

    if (targetMigration !== null && !/^[A-Za-z0-9_]+$/.test(targetMigration)) {
      throw new Error(`nombre de migración no válido: ${targetMigration}`);
    }

    return {
      project,
      startupProject,
      context,
      targetMigration,
      ...(typeof options.name === 'string' ? { name: options.name } : {}),
      ...(options.force === true ? { force: true } : {}),
    };
  }

  ipcMain.handle(IPC.efcoreMigrations, (_event, options: unknown) => efcoreService.listMigrations(efTarget(options)));

  ipcMain.handle(IPC.efcoreContexts, (_event, options: unknown) => efcoreService.listContexts(efTarget(options)));

  ipcMain.handle(IPC.efcoreSchema, (_event, projectPath: unknown) =>
    efcoreService.readSchema(assertInsideWorkspace(projectPath)),
  );

  ipcMain.handle(IPC.efcoreConnections, (_event, projectPath: unknown) =>
    efcoreService.readConnectionStrings(assertInsideWorkspace(projectPath)),
  );

  ipcMain.handle(IPC.efcoreRun, (_event, operation: unknown, options: unknown) => {
    if (typeof operation !== 'string' || !EF_OPERATIONS.includes(operation as EfOperation)) {
      throw new Error(`operación de EF Core no reconocida: ${String(operation)}`);
    }
    return efcoreService.runEfTask(operation as EfOperation, efTarget(options), taskCallbacks);
  });

  // --- Cliente HTTP ---------------------------------------------------------------------------
  // La validación entera vive en el servicio: es donde se decide qué se envía y qué no.
  ipcMain.handle(IPC.httpSend, (_event, request: unknown) => httpClient.sendRequest(request));

  // --- Docker y Compose -----------------------------------------------------------------------
  ipcMain.handle(IPC.dockerState, () => dockerService.readState());

  ipcMain.handle(IPC.dockerComposeFiles, () =>
    currentSolution ? dockerService.findComposeFiles(currentSolution.directory) : [],
  );

  /**
   * Archivo de Compose validado.
   *
   * Dos comprobaciones, no una: la ruta tiene que estar dentro del workspace **y** el archivo
   * tiene que llamarse como un compose. Sin lo segundo, este canal sería un lector de archivos
   * arbitrarios del workspace disfrazado de lector de YAML.
   */
  function composeFile(raw: unknown): string {
    const path = assertInsideWorkspace(raw);
    const name = basename(path);

    if (!isComposeFile(name)) throw new Error(`no es un archivo de Docker Compose: ${name}`);
    return path;
  }

  ipcMain.handle(IPC.dockerComposeRead, (_event, path: unknown) => dockerService.readComposeFile(composeFile(path)));

  const COMPOSE_ACTIONS: ReadonlySet<string> = new Set<ComposeAction>([
    'up', 'down', 'restart', 'pull', 'build', 'logs', 'stop', 'start',
  ]);

  const CONTAINER_ACTIONS: ReadonlySet<string> = new Set<ContainerAction>([
    'start', 'stop', 'restart', 'remove', 'logs',
  ]);

  ipcMain.handle(IPC.dockerComposeRun, (_event, action: unknown, path: unknown, service: unknown) => {
    if (typeof action !== 'string' || !COMPOSE_ACTIONS.has(action)) {
      throw new Error(`acción de Compose no reconocida: ${String(action)}`);
    }

    const file = composeFile(path);

    // El nombre del servicio llega del renderer y acaba en un argv: se acota a lo que Compose
    // admite como nombre, que además no incluye ningún carácter interesante para nadie.
    const name = typeof service === 'string' && service.trim() !== '' ? service.trim() : null;
    if (name !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      throw new Error(`nombre de servicio no válido: ${name}`);
    }

    return dockerService.runDocker(
      composeArgs(action as ComposeAction, file, name),
      dirname(file),
      taskCallbacks,
      'Docker Compose',
    );
  });

  ipcMain.handle(IPC.dockerContainerRun, (_event, action: unknown, container: unknown) => {
    if (typeof action !== 'string' || !CONTAINER_ACTIONS.has(action)) {
      throw new Error(`acción de contenedor no reconocida: ${String(action)}`);
    }

    const name = requireString(container, 'container');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`nombre de contenedor no válido: ${name}`);

    const cwd = currentSolution?.directory ?? app.getPath('userData');
    return dockerService.runDocker(containerArgs(action as ContainerAction, name), cwd, taskCallbacks, 'Docker');
  });

  // --- Scaffolding ---------------------------------------------------------------------------
  ipcMain.handle(IPC.scaffoldList, () => listBlueprints());

  ipcMain.handle(IPC.scaffoldPickOutputDir, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Elegir dónde crear la solución',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Elegir',
    });
    if (result.canceled || !result.filePaths[0]) return null;

    // El destino queda autorizado para que el explorador pueda leerlo después de generar.
    allowRoot(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.scaffoldGenerate, async (_event, options: unknown) => {
    if (typeof options !== 'object' || options === null) {
      throw new Error('las opciones de generación deben ser un objeto');
    }

    const scaffoldOptions = options as ScaffoldOptions;
    allowRoot(scaffoldOptions.outputDir);

    // En producción las plantillas viven fuera del asar; en desarrollo, junto al bundle.
    const templatesBase = app.isPackaged ? process.resourcesPath : __dirname;
    return generateSolution(scaffoldOptions, templatesBase);
  });

  // --- Tareas de .NET -------------------------------------------------------------------------
  ipcMain.handle(IPC.dotnetRunTask, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('petición de tarea inválida');

    const task = request as DotnetTaskRequest;
    if (!TASK_KINDS.has(task.kind)) throw new Error(`tipo de tarea desconocido: ${String(task.kind)}`);

    const target = assertInsideWorkspace(task.target);
    const extraArgs = Array.isArray(task.extraArgs)
      ? task.extraArgs.filter((arg): arg is string => typeof arg === 'string')
      : [];

    const label = typeof task.label === 'string' && task.label.trim() !== '' ? task.label.trim() : undefined;

    // El nivel de detalle lo decide el proceso principal a partir de las preferencias, no el
    // renderer: es la misma regla que con el prompt del asistente (ADR-016).
    return dotnetService.runTask(
      { kind: task.kind, target, extraArgs, label },
      taskCallbacks,
      settingsService.current().dotnetVerbosity,
    );
  });

  ipcMain.handle(IPC.dotnetCancelTask, (_event, taskId: unknown) => {
    dotnetService.cancelTask(requireString(taskId, 'taskId'));
  });

  ipcMain.handle(IPC.dotnetListTasks, () => dotnetService.listTasks());

  // --- Terminal integrada -----------------------------------------------------------------------
  ipcMain.handle(IPC.terminalAllowed, (): string[] => [...commandRunner.ALLOWED_COMMANDS].sort());

  /**
   * Contexto del autocompletado.
   *
   * Se resuelve entero de una vez y con tolerancia a fallos: sin Docker instalado, sin
   * `package.json` o sin workspace abierto, lo que falta llega vacío y la terminal sigue
   * autocompletando lo demás. Que falte una fuente no puede apagar el autocompletado entero.
   */
  ipcMain.handle(IPC.terminalContext, async (): Promise<TerminalContext> => {
    const [docker, npmScripts] = await Promise.all([
      dockerService.readNames().catch(() => ({ containers: [], images: [] })),
      currentSolution ? readNpmScripts(currentSolution.directory) : Promise.resolve([]),
    ]);

    const state = await dockerService.readState().catch(() => ({ available: false }));

    return {
      programs: [...commandRunner.ALLOWED_COMMANDS].sort(),
      containers: docker.containers,
      images: docker.images,
      npmScripts,
      dockerAvailable: state.available,
    };
  });

  ipcMain.handle(IPC.terminalCwd, (): TerminalCwd => terminalSession.cwd());

  /**
   * Ejecuta una línea en el directorio actual de la terminal.
   *
   * El orden importa: **primero se mira si la línea es una orden del intérprete** (`cd`, `pwd`) y
   * sólo si no lo es se lanza un programa. Al revés, `cd src` buscaría un programa llamado `cd`,
   * que es exactamente lo que pasaba antes y por lo que no se podía navegar.
   *
   * Ya no hace falta tener una solución abierta: la terminal arranca en la carpeta personal y desde
   * ahí se puede ir a donde sea. Exigir un workspace para poder escribir `git status` en otra
   * carpeta era una restricción sin nada detrás.
   */
  ipcMain.handle(IPC.terminalRun, async (_event, line: unknown): Promise<TerminalRunResult> => {
    const text = requireString(line, 'line');
    const argv = commandRunner.tokenize(text);

    const builtin = await terminalSession.handleBuiltin(argv);
    if (builtin !== null) return { task: null, cwd: builtin.cwd, output: builtin.output };

    const here = terminalSession.cwd();
    const task = commandRunner.runCommand(text, here.path, {
      onStarted: (payload) => broadcast(IPC_EVENTS.taskStarted, payload),
      onOutput: (payload) => broadcast(IPC_EVENTS.taskOutput, payload),
      onExit: (payload) =>
        broadcast(IPC_EVENTS.taskExit, { ...payload, diagnostics: [], applicationUrl: null }),
    });

    return { task, cwd: here, output: [] };
  });

  // --- NuGet ----------------------------------------------------------------------------------
  ipcMain.handle(IPC.nugetSearch, (_event, query: unknown, includePrerelease: unknown) =>
    nugetService.search(typeof query === 'string' ? query : '', includePrerelease === true),
  );

  ipcMain.handle(IPC.nugetVersions, (_event, packageId: unknown, includePrerelease: unknown) =>
    nugetService.listVersions(requireString(packageId, 'packageId'), includePrerelease === true),
  );

  ipcMain.handle(IPC.nugetInstall, (_event, projectPath: unknown, packageId: unknown, version: unknown) =>
    dotnetService.runPackageCommand(
      'add',
      assertInsideWorkspace(projectPath),
      requireString(packageId, 'packageId'),
      typeof version === 'string' && version !== '' ? version : undefined,
      taskCallbacks,
    ),
  );

  ipcMain.handle(IPC.nugetUninstall, (_event, projectPath: unknown, packageId: unknown) =>
    dotnetService.runPackageCommand(
      'remove',
      assertInsideWorkspace(projectPath),
      requireString(packageId, 'packageId'),
      undefined,
      taskCallbacks,
    ),
  );

  /**
   * Auditoría de vulnerabilidades.
   *
   * Sin objetivo se audita la solución entera, que es lo que se quiere el 95% de las veces: la
   * vulnerabilidad suele estar en un transitivo que arrastra un proyecto cualquiera.
   */
  ipcMain.handle(IPC.nugetAudit, (_event, target: unknown) => {
    const path =
      target === null || target === undefined || target === ''
        ? currentSolution?.path ?? currentSolution?.directory ?? null
        : assertInsideWorkspace(target);

    if (path === null) throw new Error('no hay ninguna solución abierta que auditar');
    return nugetService.audit(path);
  });

  // --- Explorador de pruebas ---------------------------------------------------------------------

  /**
   * Descubrimiento.
   *
   * Sólo se recorren los proyectos que la solución ya ha marcado como de pruebas: recorrer el
   * workspace entero leyendo `.cs` sería lento y encontraría cosas que no son pruebas.
   */
  ipcMain.handle(IPC.testsDiscover, () => {
    const projects = (currentSolution?.projects ?? [])
      .filter((project) => project.isTestProject)
      .map((project) => project.path);

    return testService.discoverTests(projects);
  });

  ipcMain.handle(IPC.testsRun, async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('petición de pruebas inválida');

    const payload = request as { target?: unknown; ids?: unknown; classId?: unknown; label?: unknown };
    const target = assertInsideWorkspace(payload.target);

    // El filtro se **construye aquí** a partir de identificadores validados, en vez de aceptar la
    // cadena que mande el renderer: así no hay forma de colar opciones extra dentro del `--filter`.
    const ids = Array.isArray(payload.ids)
      ? payload.ids.filter((id): id is string => typeof id === 'string' && TEST_ID.test(id))
      : [];

    const classId = typeof payload.classId === 'string' && TEST_ID.test(payload.classId) ? payload.classId : null;

    const filter = ids.length > 0 ? filterForTests(ids) : classId !== null ? filterForClass(classId) : null;

    const resultsRoot = await testService.ensureResultsRoot(join(app.getPath('userData'), 'test-results'));

    return testService.runTests(
      {
        target,
        filter,
        requested: ids,
        verbosity: settingsService.current().dotnetVerbosity,
        label: typeof payload.label === 'string' && payload.label !== '' ? payload.label : 'Pruebas',
        resultsRoot,
      },
      taskCallbacks,
    );
  });

  ipcMain.handle(IPC.testsResults, (_event, taskId: unknown) =>
    testService.readResults(requireString(taskId, 'taskId')),
  );

  // --- Túnel público ------------------------------------------------------------------------------
  ipcMain.handle(IPC.tunnelTools, () => tunnelService.detectTools());

  ipcMain.handle(IPC.tunnelStart, async (_event, tool: unknown, port: unknown) => {
    const id = TUNNEL_TOOLS.find((entry) => entry.id === tool)?.id;
    if (id === undefined) throw new Error(`herramienta de túnel no reconocida: ${String(tool)}`);
    if (!isValidPort(port)) throw new Error(`puerto no válido para el túnel: ${String(port)}`);

    const available = await tunnelService.detectTools();
    if (!available.includes(id)) throw new Error(missingToolMessage(id as TunnelTool));

    const cwd = currentSolution?.directory ?? app.getPath('userData');
    return tunnelService.startTunnel(id as TunnelTool, port, cwd, taskCallbacks);
  });

  // --- Monitor de rendimiento ----------------------------------------------------------------------
  ipcMain.handle(IPC.metricsState, async (): Promise<MetricsState> => {
    await metricsService.isAvailable();
    return metricsService.getState();
  });

  ipcMain.handle(IPC.metricsProcesses, () => metricsService.listProcesses());

  ipcMain.handle(IPC.metricsStart, (_event, pid: unknown, processName: unknown): MetricsState => {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      throw new Error(`pid no válido: ${String(pid)}`);
    }

    return metricsService.start(pid, typeof processName === 'string' ? processName : null, {
      onSamples: (samples) =>
        broadcast(IPC_EVENTS.metricsSample, {
          state: metricsService.getState(),
          samples,
          at: Date.now(),
        }),
      onStatus: () =>
        broadcast(IPC_EVENTS.metricsSample, {
          state: metricsService.getState(),
          samples: [],
          at: Date.now(),
        }),
    });
  });

  ipcMain.handle(IPC.metricsStop, () => {
    metricsService.stop();
  });

  // --- Depuración -------------------------------------------------------------------------------
  ipcMain.handle(IPC.debugState, (): DebugState => debugController.getState());

  ipcMain.handle(IPC.debugStart, async (_event, request: unknown): Promise<DebugState> => {
    if (typeof request !== 'object' || request === null) throw new Error('petición de depuración inválida');
    if (!currentSolution) throw new Error('abre una solución antes de depurar');

    const launch = request as DebugLaunchRequest;
    const projectPath = assertInsideWorkspace(launch.projectPath);

    const breakpoints = Array.isArray(launch.breakpoints)
      ? launch.breakpoints
          .filter((entry) => typeof entry?.file === 'string' && Array.isArray(entry.lines))
          .map((entry) => ({
            file: assertInsideWorkspace(entry.file),
            lines: entry.lines.filter((line): line is number => Number.isInteger(line) && line > 0),
          }))
      : [];

    const target = await resolveDebugTarget(projectPath, currentSolution.directory);

    return debugController.start(
      target,
      breakpoints,
      toolchainDirectory(),
      launch.stopAtEntry === true,
      settingsService.current().dotnetVerbosity,
    );
  });

  ipcMain.handle(IPC.debugStop, () => debugController.stop());

  ipcMain.handle(IPC.debugControl, (_event, action: unknown) => {
    const allowed: DebugAction[] = ['continue', 'stepOver', 'stepIn', 'stepOut', 'pause'];
    if (!allowed.includes(action as DebugAction)) throw new Error(`acción de depuración inválida: ${String(action)}`);
    return debugController.control(action as DebugAction);
  });

  ipcMain.handle(IPC.debugStackTrace, () => debugController.stackTrace());

  ipcMain.handle(IPC.debugScopes, (_event, frameId: unknown) => {
    if (!Number.isInteger(frameId)) throw new Error('frameId inválido');
    return debugController.scopes(frameId as number);
  });

  ipcMain.handle(IPC.debugVariables, (_event, reference: unknown) => {
    if (!Number.isInteger(reference)) throw new Error('variablesReference inválido');
    return debugController.variables(reference as number);
  });

  ipcMain.handle(IPC.debugSetBreakpoints, (_event, file: unknown, lines: unknown) => {
    const path = assertInsideWorkspace(file);
    const valid = Array.isArray(lines)
      ? lines.filter((line): line is number => Number.isInteger(line) && line > 0)
      : [];
    return debugController.setBreakpoints(path, valid);
  });

  ipcMain.handle(IPC.debugEvaluate, (_event, expression: unknown, frameId: unknown) =>
    debugController.evaluate(requireString(expression, 'expression'), Number.isInteger(frameId) ? (frameId as number) : undefined),
  );

  // --- LSP --------------------------------------------------------------------------------------
  ipcMain.handle(IPC.lspState, (): LspState => lspClient.getState());
  ipcMain.handle(IPC.lspStart, () => startLanguageServer());
  ipcMain.handle(IPC.lspStop, () => lspClient.stop());

  ipcMain.handle(IPC.lspRequest, async (_event, method: unknown, params: unknown) => {
    if (!lspClient.isRunning()) return null;
    try {
      return await lspClient.request(requireString(method, 'method'), params);
    } catch (error) {
      // Una petición LSP fallida no debe propagarse como excepción a la UI: Monaco espera
      // simplemente "sin resultados". Pero sí se deja constancia en la consola: un proveedor que
      // devuelve siempre vacío por un error del servidor es indistinguible de uno que funciona.
      console.error(`[lsp] ${String(method)}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  });

  ipcMain.handle(IPC.lspNotify, (_event, method: unknown, params: unknown) => {
    if (!lspClient.isRunning()) return;
    lspClient.notify(requireString(method, 'method'), params);
  });

  ipcMain.handle(IPC.lspLegend, () => legendFromCapabilities(lspClient.getServerCapabilities()));

  // --- Actualizaciones ---------------------------------------------------------------------------

  /**
   * El estado de la actualización cambia solo.
   *
   * La descarga avanza sin que nadie la haya pedido en ese instante —"Descartar" la lanza en
   * segundo plano—, así que el progreso viaja como evento y no como respuesta a una llamada.
   */
  updaterService.setListener((state: UpdateState) => broadcast(IPC_EVENTS.updateState, state));

  ipcMain.handle(IPC.updateState, (): UpdateState => updaterService.getState());

  ipcMain.handle(IPC.updateCheck, (_event, manual: unknown): Promise<UpdateState> =>
    updaterService.check({ manual: manual === true }),
  );

  ipcMain.handle(IPC.updateDownload, (): Promise<UpdateState> => updaterService.download());

  ipcMain.handle(IPC.updateDismiss, (): UpdateState => updaterService.dismiss());

  ipcMain.handle(IPC.updateApplyOnQuit, (_event, now: unknown): Promise<UpdateState> =>
    updaterService.applyOnQuit(now === true),
  );

  // --- Extensiones (Open VSX) ---------------------------------------------------------------------

  ipcMain.handle(IPC.extensionsSearch, (_event, request: unknown): Promise<SearchResult> => {
    if (typeof request !== 'object' || request === null) throw new Error('la consulta debe ser un objeto');

    const source = request as Record<string, unknown>;
    const query: SearchQuery = {
      query: typeof source['query'] === 'string' ? source['query'].slice(0, 200) : '',
      category: typeof source['category'] === 'string' ? source['category'].slice(0, 80) : '',
      size: typeof source['size'] === 'number' ? source['size'] : SEARCH_PAGE_SIZE,
      offset: typeof source['offset'] === 'number' ? source['offset'] : 0,
    };

    return openVsxService.search(query);
  });

  ipcMain.handle(IPC.extensionsInstalled, (): Promise<InstalledExtension[]> => extensionInstaller.listInstalled());

  /**
   * Instalación desde el registro.
   *
   * Del objeto que manda el renderer sólo se usa la URL de descarga, y sólo si viene de Open VSX:
   * lo demás es presentación. Todo lo que importa —manifiesto, identidad, carpeta— sale después
   * del propio `.vsix`, que es la única fuente que no puede falsear quien llame a este canal.
   */
  ipcMain.handle(IPC.extensionsInstall, async (_event, extension: unknown): Promise<InstalledExtension> => {
    if (typeof extension !== 'object' || extension === null) throw new Error('falta la extensión a instalar');

    const source = extension as Partial<MarketplaceExtension>;
    const url = typeof source.download === 'string' ? source.download : '';

    if (!isTrustedDownload(url)) throw new Error('la extensión no declara una descarga válida de Open VSX');

    const outcome = await extensionInstaller.installFromUrl(url);
    return outcome.extension;
  });

  ipcMain.handle(IPC.extensionsUninstall, (_event, id: unknown): Promise<boolean> => {
    const value = requireString(id, 'id');
    const [namespace, name] = value.split('.');

    // El identificador acaba en una comparación contra nombres de carpeta: se valida su forma
    // antes de que llegue a tocar el disco.
    if (namespace === undefined || name === undefined || !isValidSegment(namespace) || !isValidSegment(name)) {
      throw new Error(`identificador de extensión no válido: ${value}`);
    }

    return extensionInstaller.uninstall(value);
  });

  ipcMain.handle(IPC.extensionsOpenFolder, async (): Promise<void> => {
    const directory = extensionInstaller.extensionsDirectory();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(directory, { recursive: true });
    await shell.openPath(directory);
  });

  // --- Asistente de IA ---------------------------------------------------------------------------
  ipcMain.handle(IPC.aiStatus, (): AiStatus => aiService.status(settingsService.current().ai));

  ipcMain.handle(IPC.aiSetKey, async (_event, provider: unknown, apiKey: unknown): Promise<AiStatus> => {
    const id = requireProvider(provider);
    if (apiKey !== null && typeof apiKey !== 'string') {
      throw new Error('la clave de API debe ser una cadena o null');
    }

    const persisted = await aiSecrets.set(id, apiKey);
    const status = aiService.status(settingsService.current().ai);

    return persisted
      ? status
      : {
          ...status,
          message:
            'Este sistema no ofrece cifrado seguro, así que la clave sólo vale para esta sesión ' +
            'y no se ha guardado en disco.',
        };
  });

  ipcMain.handle(IPC.aiProbe, (_event, provider: unknown): Promise<AiProbeResult> =>
    aiService.probe(settingsService.current().ai, requireProvider(provider)),
  );

  ipcMain.handle(IPC.aiSend, (_event, request: unknown): { requestId: string } => {
    let chatRequest;
    try {
      chatRequest = coerceChatRequest(request);
    } catch (error) {
      throw error instanceof AiRequestError ? new Error(`petición al asistente inválida: ${error.message}`) : error;
    }

    // La arquitectura y el mapa de proyectos NO se toman de lo que diga el renderer: se derivan
    // aquí de la solución realmente abierta, o se dejan vacíos si el usuario ha desactivado esa
    // pieza del contexto. Las dos decisiones —qué reglas se imponen y qué se envía— son del
    // proceso principal, que es quien conoce la solución y quien guarda las preferencias.
    const settings = settingsService.current().ai;

    const context = settings.includeArchitecture
      ? {
          ...chatRequest.context,
          architecture: detectArchitecture(currentSolution),
          solutionName: currentSolution?.name ?? null,
          projects: projectContexts(currentSolution?.projects ?? []),
        }
      : { ...chatRequest.context, architecture: 'unknown' as const, solutionName: null, projects: [] };

    void aiService.chat({ ...chatRequest, context }, settings, {
      onDelta: (payload) => broadcast(IPC_EVENTS.aiDelta, payload),
      onEnd: (payload) => broadcast(IPC_EVENTS.aiEnd, payload),
    });

    return { requestId: chatRequest.requestId };
  });

  ipcMain.handle(IPC.aiCancel, (_event, requestId: unknown): void => {
    aiService.cancel(requireString(requestId, 'requestId'));
  });
}

function requireProvider(value: unknown): AiProviderId {
  if (typeof value !== 'string' || !(AI_PROVIDER_IDS as readonly string[]).includes(value)) {
    throw new Error(`proveedor de IA desconocido: ${String(value)}`);
  }
  return value as AiProviderId;
}

/**
 * Abre un workspace sin pasar por el renderer.
 *
 * Lo usa el arranque con argumento de línea de comandos (`dotforge-ide .`), que es como se espera
 * que se comporte cualquier IDE moderno. Devuelve la solución cargada o null si la ruta no vale.
 */
export async function openWorkspaceFromCli(path: string): Promise<SolutionInfo | null> {
  try {
    const { resolve } = await import('node:path');
    const directory = resolve(path);

    // Mismo criterio que el canal IPC: si la ruta no es una carpeta abrible, se dice claro en vez
    // de dejar que reviente dentro del cargador de soluciones.
    if (!isOpenableWorkspace(directory)) {
      throw new Error('la ruta no existe o no es un directorio');
    }

    setWorkspaceRoot(directory);
    currentSolution = await loadSolution(directory);
    await settingsService.rememberWorkspace(directory);
    // Este camino no pasa por `openWorkspaceDirectory` —no hay renderer al que avisar todavía—, así
    // que tiene que poner al día el contexto de la terminal por su cuenta. Sin esto, arrancar con
    // `--open=` o con `dotforge-ide .` dejaba la terminal en la carpeta personal mientras el
    // explorador enseñaba la solución: dos verdades a la vez.
    syncTerminalContext();

    return currentSolution;
  } catch (error) {
    console.error(`no se ha podido abrir "${path}": ${error instanceof Error ? error.message : String(error)}`);
    setWorkspaceRoot(null);
    currentSolution = null;
    return null;
  }
}

/** Arranca el servidor de lenguaje para el workspace ya abierto. */
export function startLanguageServerForCurrentWorkspace(): void {
  void startLanguageServer();
}

/** Ruta del proyecto de arranque preferido (web o Blazor) de la solución abierta. */
export function preferredStartupProject(): string | null {
  if (!currentSolution) return null;
  const web = currentSolution.projects.find((project) => project.isWebProject);
  const exe = currentSolution.projects.find((project) => project.outputType === 'Exe');
  const target = web ?? exe ?? null;
  return target ? target.path : null;
}

export function activeSolution(): SolutionInfo | null {
  return currentSolution;
}

export function currentSolutionTarget(): string | null {
  if (!currentSolution) return null;
  return currentSolution.path ?? currentSolution.projects[0]?.path ?? null;
}

export { broadcast, dirname };
