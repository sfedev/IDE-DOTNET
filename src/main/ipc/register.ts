/**
 * Registro de todos los handlers IPC.
 *
 * Un único punto de entrada para que la superficie expuesta al renderer se pueda auditar de un
 * vistazo. Cada handler valida sus argumentos: `ipcRenderer.invoke` puede llamarse con cualquier
 * cosa desde una página comprometida.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import type {
  AppInfo,
  AppSettings,
  DebugAction,
  DebugLaunchRequest,
  DebugState,
  DotnetTaskKind,
  DotnetTaskRequest,
  LspState,
  RecentWorkspace,
  SolutionInfo,
} from '../../shared/contracts.js';
import { IPC, IPC_EVENTS } from '../../shared/contracts.js';
import type { ScaffoldOptions } from '../../shared/scaffold-types.js';
import { DEFAULT_STARTUP_CONFIG } from '../../shared/startup.js';
import { listBlueprints } from '../../scaffold/blueprints/index.js';
import { generateSolution } from '../../scaffold/generator.js';
import { debugController, resolveDebugTarget } from '../debug/debug-controller.js';
import { acquireLanguageServer } from '../lsp/acquire.js';
import { lspClient } from '../lsp/lsp-client.js';
import * as commandRunner from '../services/command-runner.js';
import * as dotnetService from '../services/dotnet-service.js';
import * as fileService from '../services/file-service.js';
import * as gitService from '../services/git-service.js';
import * as nugetService from '../services/nuget-service.js';
import * as settingsService from '../services/settings-service.js';
import * as startupService from '../services/startup-service.js';
import { loadSolution } from '../services/solution-service.js';
import { allowRoot, assertInsideWorkspace, setWorkspaceRoot } from '../services/workspace-guard.js';
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

  try {
    const server = await acquireLanguageServer(toolchainDirectory(), (phase, ratio, detail) => {
      broadcast(IPC_EVENTS.lspStateChanged, {
        status: phase === 'done' ? 'starting' : 'acquiring',
        server: null,
        version: null,
        message: detail,
        progress: ratio,
      } satisfies LspState);
    });

    return await lspClient.start(server, currentSolution.directory);
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
  }
}

// ---------------------------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------------------------

export function registerIpcHandlers(): void {
  debugController.on('state', (state: DebugState) => broadcast(IPC_EVENTS.debugStateChanged, state));
  debugController.on('stopped', (payload) => broadcast(IPC_EVENTS.debugStopped, payload));
  debugController.on('output', (payload) => broadcast(IPC_EVENTS.debugOutput, payload));

  lspClient.on('state', (state: LspState) => broadcast(IPC_EVENTS.lspStateChanged, state));
  lspClient.on('notification', (payload) => broadcast(IPC_EVENTS.lspNotification, payload));

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

    return dotnetService.runTask({ kind: task.kind, target, extraArgs, label }, taskCallbacks);
  });

  ipcMain.handle(IPC.dotnetCancelTask, (_event, taskId: unknown) => {
    dotnetService.cancelTask(requireString(taskId, 'taskId'));
  });

  ipcMain.handle(IPC.dotnetListTasks, () => dotnetService.listTasks());

  // --- Terminal integrada -----------------------------------------------------------------------
  ipcMain.handle(IPC.terminalAllowed, (): string[] => [...commandRunner.ALLOWED_COMMANDS].sort());

  ipcMain.handle(IPC.terminalRun, (_event, line: unknown) => {
    if (!currentSolution) throw new Error('abre una carpeta antes de usar la terminal');

    return commandRunner.runCommand(requireString(line, 'line'), currentSolution.directory, {
      onStarted: (payload) => broadcast(IPC_EVENTS.taskStarted, payload),
      onOutput: (payload) => broadcast(IPC_EVENTS.taskOutput, payload),
      onExit: (payload) =>
        broadcast(IPC_EVENTS.taskExit, { ...payload, diagnostics: [], applicationUrl: null }),
    });
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

    return debugController.start(target, breakpoints, toolchainDirectory(), launch.stopAtEntry === true);
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
    } catch {
      // Una petición LSP fallida no debe propagarse como excepción a la UI: Monaco espera
      // simplemente "sin resultados".
      return null;
    }
  });

  ipcMain.handle(IPC.lspNotify, (_event, method: unknown, params: unknown) => {
    if (!lspClient.isRunning()) return;
    lspClient.notify(requireString(method, 'method'), params);
  });
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
