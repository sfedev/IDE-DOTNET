/**
 * Punto de entrada del renderer: monta el shell y conecta todas las piezas.
 *
 * Aquí no hay lógica de negocio; sólo orquestación. Cada vista sabe pintarse a sí misma y avisa
 * hacia arriba mediante callbacks, y esta clase decide qué hacer con esos avisos.
 */
import type * as MonacoApi from 'monaco-editor';

import type {
  AppInfo,
  AppSettings,
  BuildDiagnostic,
  DotnetTaskKind,
  GitFileDiff,
  GitStatus,
  LspState,
  MenuCommand,
  ProjectInfo,
  SolutionInfo,
} from '../shared/contracts.js';
import type { AiContext, AiProviderId, AiStatus, AiTask } from '../shared/ai.js';
import { buildHttpFile, findEndpoints, httpFileNameFor, requestFor } from '../shared/api-endpoints.js';
import { isHttpFile, parseHttpFile } from '../shared/http-file.js';
import { architectureLabel, buildContext, detectArchitecture } from '../shared/ai-context.js';
import type { RunMode, StartupConfig } from '../shared/startup.js';
import { launchPlan, runnableProjects, shortProjectName } from '../shared/startup.js';
import { aiEntryState, AI_DISABLED_MESSAGE } from './ai-availability.js';
import { byId, clear, el } from './dom.js';
import { installIconGallery } from './icon-gallery.js';
import { icon, type IconName } from './icons.js';
import { applyPublishDiagnostics, reopenAll } from './lsp-bridge.js';
import { defineThemes, getMonaco, loadMonaco } from './monaco-setup.js';
import { HTTP_LANGUAGE_ID, registerHttpLanguage } from './languages/http.js';
import { AiChatView } from './views/ai-chat.js';
import { InlineAssistant } from './views/ai-inline.js';
import { EditorView, type OpenTab } from './views/editor.js';
import { EfCoreView } from './views/efcore.js';
import { ExplorerView } from './views/explorer.js';
import { HttpClientView } from './views/http.js';
import { GitView } from './views/git.js';
import { NuGetView } from './views/nuget.js';
import { PanelView, type ServiceInfo } from './views/panel.js';
import { DebugView } from './views/debug.js';
import { CommandPalette, type Command } from './views/palette.js';
import { SettingsView } from './views/settings.js';
import { StartupBar } from './views/startup-bar.js';
import { StatusBar } from './views/statusbar.js';
import { WelcomeView } from './views/welcome.js';
import { WizardView } from './views/wizard.js';

type SidebarView = 'explorer' | 'git' | 'nuget' | 'efcore' | 'settings' | 'ai';

class DotForgeApp {
  private info: AppInfo | null = null;
  private settings: AppSettings | null = null;
  private solution: SolutionInfo | null = null;
  private lsp: LspState = { status: 'idle', server: null, version: null, message: null, progress: null };
  private cursor: { line: number; column: number } | null = null;
  private sidebarView: SidebarView = 'explorer';
  private lspProviders: MonacoApi.IDisposable | null = null;
  private git: GitStatus | null = null;
  private gitTimer: number | undefined;

  /** Ramas del repositorio, para el autocompletado de la terminal. Se refrescan con el estado. */
  private branches: string[] = [];

  private readonly startupBar = new StartupBar({
    start: () => void this.startStartupProfile(),
    stop: () => void this.stopEverything(),
    save: (config) => void this.saveStartupConfig(config),
    isRunning: () => this.panel.hasRunningTasks() || this.debug.getState().status !== 'idle',
    notify: (message, level) => this.notify(message, level),
    services: () => this.panel.services(),
    focusService: (service) => this.panel.showChannel(service.id),
    openUrl: (url) => void window.dotforge.app.openExternal(url),
  });

  /** Lista blanca de la terminal; el autocompletado la ofrece como primer nivel. */
  private allowedCommands: string[] = [];

  private readonly debug = new DebugView({
    openLocation: (file, line) => void this.openFile(file, line),
    notify: (message, level) => this.notify(message, level),
  });

  private readonly editor = new EditorView({
    onGutterClick: (path, line) => void this.toggleBreakpoint(path, line),
    onDirtyChanged: () => {
      this.editor.renderTabs();
      this.updateTitle();
    },
    onActiveChanged: (tab) => {
      this.cursor = tab ? { line: 1, column: 1 } : null;
      this.editor.renderTabs();
      this.updateTitle();
      this.renderStatus();
    },
    onCursorChanged: (line, column) => {
      this.cursor = { line, column };
      this.renderStatus();
    },
    onSaved: (tab) => {
      // Guardar un .csproj o el .sln cambia el modelo de la solución: se recarga el explorador.
      if (/\.(csproj|sln|slnx|props|targets)$/i.test(tab.path)) void this.reloadSolution();
    },
  });

  private readonly explorer = new ExplorerView({
    openFile: (path) => void this.openFile(path),
    revealInFolder: (path) => void window.dotforge.app.showItemInFolder(path),
    runProjectTask: (kind, projectPath) => void this.runTask(kind, projectPath),
    showPackagesFor: (project) => this.showNuGet(project),
    refresh: () => void this.openFolderDialog(),
    askAi: (action, path) => void this.askAiAboutFile(action, path),
  });

  private readonly nuget = new NuGetView({
    notify: (message, level) => this.notify(message, level),
    reloadSolution: () => void this.reloadSolution(),
  });

  private readonly panel = new PanelView({
    openDiagnostic: (diagnostic) => void this.openDiagnostic(diagnostic),
    cancelTask: (taskId) => void window.dotforge.dotnet.cancelTask(taskId),
    runCommand: (line) => void this.runTerminalCommand(line),
    renderDebug: (container) => this.debug.render(container, () => this.panel.render()),
    renderHttp: (container) => this.httpClient.render(container),
    suggestContext: () => ({
      branches: this.branches,
      projects: (this.solution?.projects ?? []).map((project) => project.path),
      programs: this.allowedCommands,
    }),
    openUrl: (url) => void window.dotforge.app.openExternal(url),
    restartService: (service) => void this.restartService(service),
    servicesChanged: () => this.startupBar.render(),
  });

  /** Gestor de EF Core: migraciones, esquema y cadenas de conexión. */
  private readonly efcoreView = new EfCoreView({
    notify: (message, level) => this.notify(message, level),
    openFile: (path) => void this.openFile(path),
    showOutput: () => this.panel.show('output'),
  });

  /** Cliente HTTP: vive dentro del panel inferior, como la depuración. */
  private readonly httpClient = new HttpClientView({
    notify: (message, level) => this.notify(message, level),
    showPanel: () => this.panel.show('http'),
    refresh: () => {
      if (this.panel.currentTab() === 'http') this.panel.render();
    },
  });

  /** Panel de control de código fuente. Comparte contenedor con el resto de la barra lateral. */
  private readonly gitView = new GitView({
    notify: (message, level) => this.notify(message, level),
    openDiff: (diff) => this.openDiff(diff),
    openFile: (path) => void this.openFile(path),
    reloadSolution: () => void this.reloadSolution(),
    statusChanged: () => void this.refreshGit(),
  });

  private readonly settingsView = new SettingsView({
    apply: (patch) => void this.applySettings(patch),
    aiStatus: () => this.aiStatus,
    setAiKey: async (provider, apiKey) => {
      await this.setAiKey(provider, apiKey);
    },
    probeAi: (provider) => window.dotforge.ai.probe(provider),
    openExternal: (url) => void window.dotforge.app.openExternal(url),
  });

  /** Estado del asistente: proveedor, modelo y si hay credencial. Nunca contiene la clave. */
  private aiStatus: AiStatus | null = null;

  private readonly aiChat = new AiChatView({
    buildContext: () => this.buildAiContext(),
    notify: (message, level) => this.notify(message, level),
    openSettings: () => this.showSettings(),
    applyToEditor: (code) => {
      this.editor.replaceSelection(code);
      this.notify('Código aplicado en el editor. Ctrl+Z lo deshace.', 'ok');
    },
    hasEditor: () => this.editor.activeTab() !== null,
  });

  private readonly aiInline = new InlineAssistant({
    getEditor: () => this.editor.getEditor(),
    buildContext: () => this.buildAiContext(),
    notify: (message, level) => this.notify(message, level),
    openSettings: () => this.showSettings(),
    isReady: () => this.settings?.ai.enabled !== false && this.aiStatus?.ready === true,
  });

  private readonly palette = new CommandPalette();

  private readonly statusBar = new StatusBar({
    showProblems: () => this.panel.show('problems'),
    showOutput: () => this.panel.show('output'),
    restartLsp: () => void this.restartLsp(),
    openCommandPalette: () => this.palette.show(),
  });

  private readonly welcome = new WelcomeView({
    openWizard: () => void this.wizard.open(),
    openFolderDialog: () => void this.openFolderDialog(),
    openWorkspace: (path) => void this.openWorkspace(path),
    runCommand: (id) => void this.runCommandById(id),
  });

  private readonly wizard = new WizardView({
    openWorkspace: (path) => void this.openWorkspace(path),
    notify: (message, level) => this.notify(message, level),
  });

  // -------------------------------------------------------------------------------------------
  // Arranque
  // -------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.info = await window.dotforge.app.info();
    this.settings = await window.dotforge.app.getSettings();

    installIconGallery();
    document.body.classList.add(`platform-${this.info.platform}`);
    this.applyTheme(this.settings.theme);

    // El logotipo es el mismo icono que el de la aplicación, no un "</>" tecleado a mano.
    byId('brand-mark').appendChild(icon('code', { size: 15, strokeWidth: 2.1 }));

    await loadMonaco();
    this.editor.mount(this.settings);
    this.attachLspProviders();
    this.registerEditorAiActions();
    this.registerHttpFeatures();

    this.renderActivityBar();
    this.renderTitlebarActions();
    this.startupBar.mount(byId('titlebar-startup'));
    this.registerCommands();
    this.installEventBridges();
    this.installKeyboardShortcuts();
    this.installResizers();

    this.settingsView.setSettings(this.settings);
    this.welcome.render(this.info, this.settings);
    this.explorer.render();
    this.panel.render();
    this.updateTitle();
    this.renderStatus();

    // Estado del asistente: proveedor, modelo y si hay credencial guardada.
    void this.refreshAiStatus();

    // La lista de programas permitidos se muestra como ayuda en la terminal.
    void window.dotforge.terminal
      .allowed()
      .then((commands) => {
        this.allowedCommands = commands;
        this.panel.setAllowedCommands(commands);
      })
      .catch(() => undefined);

    // Reabre el último workspace: volver al trabajo no debería costar dos clics.
    // Lo decide el proceso principal, que es quien puede comprobar si la carpeta sigue existiendo;
    // así, un reciente borrado no provoca un intento de apertura condenado al fracaso.
    const existing = await window.dotforge.workspace.current();
    if (existing) {
      this.applySolution(existing);
    } else {
      const reopened = await window.dotforge.workspace.openRecent().catch(() => null);
      if (reopened) this.applySolution(reopened);
    }

    await this.refreshRecents();

    // Archivo pasado por línea de comandos (`dotforge-ide Program.cs`).
    const pending = await window.dotforge.workspace.pendingFile();
    if (pending) await this.openFile(pending);

    // El estado de Git se refresca en segundo plano; el servicio del proceso principal cachea,
    // así que sondear cada pocos segundos no cuesta un proceso por sondeo.
    void this.refreshGit();
    this.gitTimer = window.setInterval(() => void this.refreshGit(), 6000);
  }

  // -------------------------------------------------------------------------------------------
  // Workspace
  // -------------------------------------------------------------------------------------------

  private async openFolderDialog(): Promise<void> {
    const path = await window.dotforge.workspace.openDialog();
    if (path) await this.openWorkspace(path);
  }

  private async openWorkspace(path: string): Promise<void> {
    try {
      const solution = await window.dotforge.workspace.open(path);
      this.applySolution(solution);
      this.settings = await window.dotforge.app.getSettings();
      await this.refreshRecents();
    } catch (error) {
      this.notify(`No se ha podido abrir ${path}: ${this.messageOf(error)}`, 'error');
      // El fallo suele ser justo este: la carpeta ya no está. Se repinta el historial para que la
      // entrada aparezca marcada como no disponible en vez de invitar a volver a intentarlo.
      await this.refreshRecents();
    }
  }

  /** Relee el historial con su disponibilidad y repinta la bienvenida. */
  private async refreshRecents(): Promise<void> {
    try {
      this.welcome.setRecents(await window.dotforge.workspace.recents());
    } catch {
      // Sin historial disponible se sigue pintando lo que haya en preferencias.
    }
    this.welcome.render(this.info, this.settings);
  }

  private applySolution(solution: SolutionInfo | null): void {
    // Abrir un workspace llega por dos caminos —la llamada directa y el evento que difunde el
    // proceso principal—, así que se ignora la segunda vuelta sobre la misma solución para no
    // repintar el árbol ni duplicar el aviso en la salida.
    const isSameSolution =
      solution !== null && this.solution !== null && solution.directory === this.solution.directory;

    this.solution = solution;
    void this.refreshGit();

    if (isSameSolution) {
      this.explorer.setSolution(solution);
      this.nuget.setSolution(solution);
      this.startupBar.setSolution(solution);
      this.updateTitle();
      return;
    }
    this.explorer.setSolution(solution);
    this.nuget.setSolution(solution);
    this.efcoreView.setSolution(solution);
    this.startupBar.setSolution(solution);
    this.aiChat.setArchitecture(architectureLabel(detectArchitecture(solution)));
    this.updateTitle();
    void this.loadStartupConfig();

    if (solution) {
      this.notify(
        `${solution.name}: ${solution.projects.length} proyecto${solution.projects.length === 1 ? '' : 's'}`,
        'info',
      );
    }
  }

  private async reloadSolution(): Promise<void> {
    if (!this.solution) return;
    try {
      const reloaded = await window.dotforge.solution.load(this.solution.directory);
      this.solution = reloaded;
      this.explorer.setSolution(reloaded);
      this.nuget.setSolution(reloaded);
    } catch (error) {
      this.notify(`No se ha podido recargar la solución: ${this.messageOf(error)}`, 'warn');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Archivos
  // -------------------------------------------------------------------------------------------

  private async openFile(path: string, line?: number, column?: number): Promise<void> {
    try {
      const document = await window.dotforge.fs.readFile(path);
      await this.editor.open(document, {
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
      });
      this.editor.renderTabs();
      this.editor.setBreakpoints(path, this.debug.linesFor(path));
      this.explorer.select(path);
    } catch (error) {
      this.notify(`No se ha podido abrir ${path}: ${this.messageOf(error)}`, 'error');
    }
  }

  private async openDiagnostic(diagnostic: BuildDiagnostic): Promise<void> {
    if (!diagnostic.file) return;
    await this.openFile(diagnostic.file, diagnostic.line || 1, diagnostic.column || 1);
  }

  // -------------------------------------------------------------------------------------------
  // Tareas de .NET
  // -------------------------------------------------------------------------------------------

  private defaultTarget(): string | null {
    if (!this.solution) return null;
    return this.solution.path ?? this.solution.projects[0]?.path ?? null;
  }

  /**
   * Proyecto que usan las tareas sueltas (`dotnet run`, `dotnet watch`) de la paleta.
   * Es el primero del perfil activo: así la paleta y el botón de Play nunca discrepan.
   */
  private startupProject(): string | null {
    const profile = this.startupBar.activeProfile();
    return profile?.projects[0] ?? runnableProjects(this.solution)[0]?.path ?? null;
  }

  private async runTask(kind: DotnetTaskKind, explicitTarget?: string): Promise<void> {
    const target =
      explicitTarget ?? (kind === 'run' || kind === 'watch' ? this.startupProject() : this.defaultTarget());

    if (!target) {
      this.notify(
        kind === 'run' || kind === 'watch'
          ? 'No hay ningún proyecto ejecutable en la solución.'
          : 'Abre una solución o un proyecto antes de compilar.',
        'warn',
      );
      return;
    }

    // Guardar antes de compilar evita el clásico "pero si ya lo he arreglado".
    await this.editor.saveAll();

    this.panel.show('output');

    try {
      await window.dotforge.dotnet.runTask({ kind, target });
    } catch (error) {
      this.notify(`No se ha podido lanzar la tarea: ${this.messageOf(error)}`, 'error');
    }
  }

  /** Pone o quita un breakpoint y lo sincroniza con la sesión si hay una activa. */
  private async toggleBreakpoint(path: string, line: number): Promise<void> {
    const lines = this.debug.toggleBreakpoint(path, line);
    this.editor.setBreakpoints(path, lines);

    if (this.debug.getState().status !== 'idle') {
      await window.dotforge.debug.setBreakpoints(path, lines).catch(() => undefined);
    }

    if (this.panel.currentTab() === 'debug') this.panel.render();
  }

  // -------------------------------------------------------------------------------------------
  // Perfiles de inicio
  // -------------------------------------------------------------------------------------------

  private async loadStartupConfig(): Promise<void> {
    try {
      this.startupBar.setConfig(await window.dotforge.startup.get());
    } catch {
      // Sin solución abierta no hay perfiles que cargar: no es un error que contarle a nadie.
    }
  }

  private async saveStartupConfig(config: StartupConfig): Promise<void> {
    try {
      await window.dotforge.startup.save(config);
    } catch (error) {
      this.notify(`No se ha podido guardar el perfil de inicio: ${this.messageOf(error)}`, 'warn');
    }
  }

  /**
   * Arranca el perfil activo entero.
   *
   * En modo depuración sólo el primer proyecto se engancha al depurador —hay una única sesión de
   * NetCoreDbg— y el resto arranca sin él; el plan lo decide `launchPlan`, que es lógica pura y
   * está probada aparte.
   */
  private async startStartupProfile(mode?: RunMode): Promise<void> {
    const runMode = mode ?? this.startupBar.mode();
    const profile = this.startupBar.activeProfile();
    const steps = launchPlan(profile, this.solution, runMode);

    if (steps.length === 0) {
      this.notify(
        runnableProjects(this.solution).length === 0
          ? 'La solución no tiene ningún proyecto ejecutable.'
          : 'Elige qué proyecto arrancar en el selector de la barra superior.',
        'warn',
      );
      return;
    }

    await this.editor.saveAll();
    this.panel.clearFinishedChannels();

    const byPath = new Map((this.solution?.projects ?? []).map((project) => [project.path, project]));

    for (const step of steps) {
      const label = shortProjectName(step.projectName, this.solution?.name ?? null);
      const project = byPath.get(step.projectPath);

      // El canal se declara antes de lanzar: así su pestaña ya sabe si esto es una Web API, un
      // Blazor o una consola desde la primera línea de salida, y no a posteriori.
      if (project && step.action !== 'debug') {
        this.panel.registerService(label, { projectPath: project.path, projectKind: project.kind });
      }

      try {
        if (step.action === 'debug') {
          this.panel.show('debug');
          await window.dotforge.debug.start({
            projectPath: step.projectPath,
            stopAtEntry: false,
            breakpoints: this.debug.allBreakpoints(),
          });
        } else {
          await window.dotforge.dotnet.runTask({
            kind: step.action === 'watch' ? 'watch' : 'run',
            target: step.projectPath,
            label,
          });
        }
      } catch (error) {
        this.notify(`${label}: ${this.messageOf(error)}`, 'error');
      }
    }

    if (steps.some((step) => step.action !== 'debug')) this.panel.show('output');

    if (steps.length > 1) {
      const debugged = steps.filter((step) => step.action === 'debug').length;
      this.notify(
        `${steps.length} proyectos arrancados${debugged > 0 ? ` (depurando ${steps[0]?.projectName})` : ''}`,
        'info',
      );
    }

    this.startupBar.render();
  }

  /** Detiene la sesión de depuración y todas las tareas en marcha. */
  private async stopEverything(): Promise<void> {
    await window.dotforge.debug.stop().catch(() => undefined);
    await this.stopTasks();
    this.startupBar.render();
  }

  /** Ejecuta una línea escrita en la terminal integrada. */
  private async runTerminalCommand(line: string): Promise<void> {
    if (!this.solution) {
      this.notify('Abre una carpeta antes de usar la terminal.', 'warn');
      return;
    }

    try {
      const started = await window.dotforge.terminal.run(line);
      // La salida de la terminal va a su propio canal, no al de compilación.
      this.panel.attachTerminalTask(started.taskId);
    } catch (error) {
      this.panel.append(`${this.messageOf(error)}
`, 'stderr');
    }
  }

  private async stopTasks(): Promise<void> {
    const tasks = this.panel.runningTaskList();
    if (tasks.length === 0) {
      this.notify('No hay ninguna tarea en ejecución.', 'info');
      return;
    }
    for (const task of tasks) {
      await window.dotforge.dotnet.cancelTask(task.taskId);
    }
  }

  // -------------------------------------------------------------------------------------------
  // LSP
  // -------------------------------------------------------------------------------------------

  private attachLspProviders(): void {
    // Import diferido: `registerCSharpProviders` necesita Monaco ya cargado.
    void import('./lsp-bridge.js').then(({ registerCSharpProviders }) => {
      this.lspProviders?.dispose();
      this.lspProviders = registerCSharpProviders(getMonaco());
    });
  }

  private async restartLsp(): Promise<void> {
    this.notify('Reiniciando el servidor de lenguaje…', 'info');
    await window.dotforge.lsp.stop();
    const state = await window.dotforge.lsp.start();
    this.lsp = state;
    this.renderStatus();

    // Tras reiniciar hay que volver a anunciar los documentos abiertos.
    reopenAll(
      this.editor
        .listTabs()
        .filter((tab) => tab.languageId === 'csharp' || tab.languageId === 'razor')
        .map((tab) => ({ path: tab.path, languageId: tab.languageId, text: tab.model.getValue() })),
    );
  }

  // -------------------------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------------------------

  private applyTheme(theme: AppSettings['theme']): void {
    byId('app').dataset['theme'] = theme;
    document.documentElement.dataset['theme'] = theme;
  }

  private async toggleTheme(): Promise<void> {
    if (!this.settings) return;
    await this.applySettings({
      theme: this.settings.theme === 'dotforge-dark' ? 'dotforge-light' : 'dotforge-dark',
    });
  }

/**
   * Barra de actividad.
   *
   * Seis herramientas y nada más: solución, generador, NuGet, depuración, asistente y ajustes.
   * Antes había también atajos de tema y paleta que ya viven en la barra de estado y en el
   * teclado; tener la misma acción en tres sitios no la hace más accesible, sólo hace la barra
   * más ruidosa.
   */
  private renderActivityBar(): void {
    const bar = byId('activitybar');
    clear(bar);

    const button = (
      label: string,
      iconName: IconName,
      active: boolean,
      onClick: () => void,
      badge = false,
    ): HTMLElement =>
      el(
        'button',
        {
          className: `activity-item${active ? ' active' : ''}`,
          title: label,
          attrs: { 'aria-label': label },
          on: { click: onClick },
        },
        icon(iconName, { size: 20 }),
        badge ? el('span', { className: 'badge-dot' }) : null,
      );

    const errors = this.panel.getDiagnostics().filter((diagnostic) => diagnostic.severity === 'error').length;
    const changes = this.git?.dirtyFiles ?? 0;

    bar.append(
      button('Explorador de soluciones', 'solution', this.sidebarView === 'explorer', () => this.showExplorer()),
      this.sourceControlButton(changes),
      button('Generador de arquitecturas', 'wand', false, () => void this.wizard.open()),
      button('Paquetes NuGet', 'package', this.sidebarView === 'nuget', () => this.showNuGet()),
      button('Base de datos y EF Core', 'database', this.sidebarView === 'efcore', () => this.showEfCore()),
      button('Depuración y pruebas', 'bug', false, () => this.panel.show('debug'), errors > 0),
      this.aiButton(),
      el('div', { className: 'spacer' }),
      button('Ajustes', 'settings', this.sidebarView === 'settings', () => this.showSettings()),
    );
  }

  /** Control de código fuente, con el número de archivos con cambios como insignia. */
  private sourceControlButton(changes: number): HTMLElement {
    return el(
      'button',
      {
        className: `activity-item${this.sidebarView === 'git' ? ' active' : ''}`,
        title: changes > 0 ? `Control de código fuente — ${changes} cambio(s)` : 'Control de código fuente',
        attrs: { 'aria-label': 'Control de código fuente' },
        on: { click: () => this.showGit() },
      },
      icon('source-control', { size: 20 }),
      changes > 0 ? el('span', { className: 'activity-count', text: changes > 99 ? '99+' : String(changes) }) : null,
    );
  }

  /**
   * Icono del asistente.
   *
   * Con el asistente apagado en Ajustes el icono **sigue ahí**, atenuado y sin navegar a ninguna
   * parte, y el tooltip dice dónde se enciende. Un icono que desaparece no enseña nada: quien lo
   * apagó hace tres semanas no sabría que existe.
   */
  private aiButton(): HTMLElement {
    const state = aiEntryState(
      this.settings?.ai.enabled ?? this.aiStatus?.enabled ?? true,
      this.aiStatus?.ready === true,
    );

    return el(
      'button',
      {
        className: `${state.className}${this.sidebarView === 'ai' && state.navigates ? ' active' : ''}`,
        title: state.title,
        attrs: {
          'aria-label': state.title,
          'aria-disabled': String(state.disabled),
        },
        on: {
          click: () => {
            // Deshabilitado: se bloquea la navegación y no se hace absolutamente nada.
            if (!state.navigates) return;
            this.showAi();
          },
        },
      },
      icon('sparkles', { size: 20 }),
    );
  }

  /** Deja visible una sola vista de la barra lateral: comparten contenedor. */
  private showSidebar(view: SidebarView): void {
    this.sidebarView = view;
    this.explorer.setVisible(view === 'explorer');
    this.gitView.setVisible(view === 'git');
    this.nuget.setVisible(view === 'nuget');
    this.efcoreView.setVisible(view === 'efcore');
    this.settingsView.setVisible(view === 'settings');
    this.aiChat.setVisible(view === 'ai');
    this.renderActivityBar();
  }

  private showGit(): void {
    this.showSidebar('git');
  }

  private showEfCore(): void {
    this.showSidebar('efcore');
  }

  private showSettings(): void {
    this.showSidebar('settings');
  }

  private showAi(): void {
    // El interruptor de Ajustes manda también aquí: la paleta y el menú nativo llegan por este
    // mismo camino, así que basta con comprobarlo una vez.
    if (this.settings?.ai.enabled === false) {
      this.notify(AI_DISABLED_MESSAGE, 'warn');
      return;
    }

    this.aiChat.setArchitecture(architectureLabel(detectArchitecture(this.solution)));
    this.showSidebar('ai');
  }

  private renderTitlebarActions(): void {
    const actions = byId('titlebar-actions');
    clear(actions);

    const modifier = this.info?.primaryModifier ?? 'Ctrl';

    const action = (iconName: IconName, title: string, onClick: () => void): HTMLElement =>
      el(
        'button',
        { className: 'icon-btn', title, attrs: { 'aria-label': title }, on: { click: onClick } },
        icon(iconName, { size: 15 }),
      );

    actions.append(
      action('hammer', `Compilar solución (${modifier}+Shift+B)`, () => void this.runTask('build')),
      action('flask', `Ejecutar pruebas (${modifier}+Shift+T)`, () => void this.runTask('test')),
    );
  }

  private showExplorer(): void {
    this.showSidebar('explorer');
  }

  private showNuGet(project?: ProjectInfo): void {
    this.showSidebar('nuget');
    if (project) this.nuget.focusProject(project);
  }

  private updateTitle(): void {
    const container = byId('titlebar-title');
    clear(container);

    const tab = this.editor.activeTab();

    if (tab) {
      container.append(
        el('span', { className: 'file', text: `${tab.dirty ? '● ' : ''}${tab.name}` }),
        el('span', { className: 'sep', text: '—' }),
      );
    }

    container.appendChild(
      el('span', { className: 'solution', text: this.solution?.name ?? 'Ninguna carpeta abierta' }),
    );
  }

  private renderStatus(): void {
    const tab = this.editor.activeTab();
    const running = this.panel.runningTaskList()[0]?.command ?? null;

    this.statusBar.render({
      lsp: this.lsp,
      diagnostics: this.panel.getDiagnostics(),
      runningTask: running,
      cursor: tab ? this.cursor : null,
      languageId: tab?.languageId ?? null,
      git: this.git,
      sdkVersion: this.sdkVersion(),
    });
  }

  /**
   * Versión del SDK activo, resumida a major.minor.
   * La cadena completa (`10.0.400 [C:\Program Files\dotnet\sdk]`) no cabe en la barra.
   */
  private sdkVersion(): string | null {
    const first = this.info?.dotnetSdks[0];
    if (!first) return null;

    const match = /^(\d+\.\d+)/.exec(first.trim());
    return match?.[1] ?? null;
  }

  /** Aplica un cambio de preferencias y propaga el efecto a quien corresponda. */
  private async applySettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = await window.dotforge.app.setSettings(patch);

    if (patch.theme) {
      this.applyTheme(this.settings.theme);
      // Los temas de Monaco derivan de los tokens CSS: hay que redefinirlos tras el cambio.
      defineThemes(getMonaco());
    }

    this.editor.applySettings(this.settings);
    this.settingsView.setSettings(this.settings);
    this.welcome.render(this.info, this.settings);

    if (patch.lspEnabled !== undefined) {
      if (patch.lspEnabled) void this.restartLsp();
      else void window.dotforge.lsp.stop();
    }

    // Cambiar de proveedor o de modelo cambia si el asistente está listo: hay que releerlo.
    // Y encender o apagar el asistente cambia su icono de la barra de actividad.
    if (patch.ai !== undefined) {
      this.renderActivityBar();
      void this.refreshAiStatus();
    }

    // El nivel de salida cambia el comando de la próxima tarea, no la que ya está corriendo:
    // decirlo evita el "pues a mí me sigue saliendo lo mismo".
    if (patch.dotnetVerbosity !== undefined) {
      this.notify(
        `Nivel de salida de .NET: ${patch.dotnetVerbosity}. Se aplica a la próxima compilación o ejecución.`,
        'info',
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Asistente de IA
  // -------------------------------------------------------------------------------------------

  private async refreshAiStatus(): Promise<void> {
    try {
      this.aiStatus = await window.dotforge.ai.status();
      this.aiChat.setStatus(this.aiStatus);
      this.settingsView.render();
      this.renderActivityBar();
    } catch {
      // Sin estado del asistente el IDE sigue siendo un IDE: no se rompe nada.
    }
  }

  private async setAiKey(provider: AiProviderId, apiKey: string | null): Promise<void> {
    try {
      this.aiStatus = await window.dotforge.ai.setKey(provider, apiKey);
      this.aiChat.setStatus(this.aiStatus);

      if (apiKey === null) this.notify(`Clave de ${provider} borrada.`, 'ok');
      else if (this.aiStatus.message) this.notify(this.aiStatus.message, 'warn');
      else this.notify(`Clave de ${provider} guardada y cifrada.`, 'ok');
    } catch (error) {
      this.notify(`No se ha podido guardar la clave: ${this.messageOf(error)}`, 'error');
    }
  }

  /**
   * Contexto RAG del momento.
   *
   * Se compone con la misma función pura que usan las pruebas: archivo activo, selección,
   * arquitectura de la solución y diagnósticos del panel de problemas. Qué piezas se incluyen lo
   * deciden las preferencias, y el recorte por tamaño lo hace `buildContext`.
   */
  private buildAiContext(): AiContext {
    const tab = this.editor.activeTab();
    const ai = this.settings?.ai;

    return buildContext({
      solution: this.solution,
      file: tab ? { path: tab.path, languageId: tab.languageId, text: tab.model.getValue() } : null,
      selection: this.editor.currentSelection(),
      diagnostics: this.panel.getDiagnostics(),
      include: {
        activeFile: ai?.includeActiveFile ?? true,
        selection: ai?.includeSelection ?? true,
        architecture: ai?.includeArchitecture ?? true,
        diagnostics: ai?.includeDiagnostics ?? true,
      },
    });
  }

  /** Acciones del menú contextual del árbol: se abre el archivo y se pregunta sobre él. */
  private async askAiAboutFile(action: 'explain' | 'tests' | 'fix', path: string): Promise<void> {
    await this.openFile(path);
    this.askAi(action);
  }

  /**
   * Lanza una de las acciones rápidas sobre lo que hay delante.
   *
   * El prompt cambia según haya selección o no: pedir "explica el archivo" cuando el usuario tenía
   * un método marcado sería ignorar lo único que había dicho.
   */
  private askAi(action: 'explain' | 'tests' | 'fix'): void {
    if (this.settings?.ai.enabled === false) {
      this.notify(AI_DISABLED_MESSAGE, 'warn');
      return;
    }

    const tab = this.editor.activeTab();
    if (!tab) {
      this.notify('Abre un archivo antes de preguntarle al asistente.', 'warn');
      return;
    }

    const scope = this.editor.currentSelection() ? 'el código seleccionado' : `el archivo ${tab.name}`;
    const errors = this.panel
      .getDiagnostics()
      .filter((diagnostic) => diagnostic.severity === 'error' && diagnostic.file === tab.path);

    const prompts: Record<typeof action, { text: string; task: AiTask }> = {
      explain: { text: `Explica ${scope}.`, task: 'explain' },
      tests: { text: `Genera las pruebas xUnit de ${scope}.`, task: 'tests' },
      fix: {
        text:
          errors.length > 0
            ? `Corrige los errores de compilación de ${scope} respetando la arquitectura del proyecto.`
            : `Revisa ${scope}: dime si viola alguna regla de la arquitectura y corrígelo.`,
        task: 'fix',
      },
    };

    this.showAi();
    void this.aiChat.send(prompts[action].text, prompts[action].task);
  }

  /** Acciones del asistente en el menú contextual del editor. */
  private registerEditorAiActions(): void {
    const modifier = this.info?.primaryModifier ?? 'Ctrl';
    const monaco = getMonaco();

    this.editor.addAction({
      id: 'dotforge.ai.inline',
      label: `Editar con IA (${modifier}+I)`,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      contextMenuGroupId: 'dotforge-ai',
      order: 1,
      run: () => this.aiInline.open(),
    });

    this.editor.addAction({
      id: 'dotforge.ai.explain',
      label: 'Explicar el código con IA',
      contextMenuGroupId: 'dotforge-ai',
      order: 2,
      run: () => this.askAi('explain'),
    });

    this.editor.addAction({
      id: 'dotforge.ai.tests',
      label: 'Generar pruebas xUnit',
      contextMenuGroupId: 'dotforge-ai',
      order: 3,
      run: () => this.askAi('tests'),
    });

    this.editor.addAction({
      id: 'dotforge.ai.fix',
      label: 'Corregir violación de arquitectura',
      contextMenuGroupId: 'dotforge-ai',
      order: 4,
      run: () => this.askAi('fix'),
    });
  }

  /** Refresca el estado de Git y repinta lo que dependa de él si ha cambiado. */
  private async refreshGit(): Promise<void> {
    try {
      const status = await window.dotforge.git.status();
      const changed = status?.branch !== this.git?.branch || status?.dirtyFiles !== this.git?.dirtyFiles;
      this.git = status;

      if (changed) {
        this.renderStatus();
        // La insignia del icono de control de fuentes cuenta los archivos con cambios.
        this.renderActivityBar();
      }

      // Las ramas alimentan el autocompletado de la terminal. El servicio del proceso principal
      // cachea 15 s, así que este sondeo no lanza un `git branch` cada seis segundos.
      if (status) this.branches = await window.dotforge.git.branches();
      else this.branches = [];

      // El panel sólo se relee si está a la vista: es una llamada más y no la paga quien no mira.
      if (changed && this.gitView.isVisible()) void this.gitView.refresh();
    } catch {
      this.git = null;
      this.branches = [];
    }
  }

  // -------------------------------------------------------------------------------------------
  // Control de código fuente
  // -------------------------------------------------------------------------------------------

  /** Abre una comparación en el editor de diferencias y deja la pestaña activa. */
  private openDiff(diff: GitFileDiff): void {
    this.editor.openDiff(diff);
    this.updateTitle();
  }

  // -------------------------------------------------------------------------------------------
  // Procesos en marcha
  // -------------------------------------------------------------------------------------------

  /**
   * Reinicia un solo proceso del perfil.
   *
   * Es lo que falta cuando se arrancan tres proyectos y sólo uno hay que rearrancar: parar todo y
   * volver a darle a Play cuesta el tiempo de arranque de los otros dos. Se para el suyo, se
   * espera a que muera de verdad y se vuelve a lanzar con el mismo modo del selector.
   */
  private async restartService(service: ServiceInfo): Promise<void> {
    const project = this.solution?.projects.find((entry) => entry.path === service.projectPath);
    if (!project) {
      this.notify('No se sabe de qué proyecto salió ese proceso: vuelve a arrancar el perfil.', 'warn');
      return;
    }

    if (service.taskId) {
      await window.dotforge.dotnet.cancelTask(service.taskId).catch(() => undefined);
    }

    await this.editor.saveAll();

    const label = shortProjectName(project.name, this.solution?.name ?? null);
    const kind: DotnetTaskKind = this.startupBar.mode() === 'run' && project.isWebProject ? 'watch' : 'run';

    this.panel.registerService(label, { projectPath: project.path, projectKind: project.kind });

    try {
      await window.dotforge.dotnet.runTask({ kind, target: project.path, label });
      this.panel.showChannel(service.id);
    } catch (error) {
      this.notify(`No se ha podido reiniciar ${label}: ${this.messageOf(error)}`, 'error');
    }
  }

  private notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void {
    const prefix = level === 'error' ? '✖' : level === 'warn' ? '▲' : level === 'ok' ? '✓' : 'ℹ';
    this.panel.appendCommand(`${prefix} ${message}`);
    if (level === 'error' || level === 'warn') this.panel.show('output');
  }

  private messageOf(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/^Error invoking remote method '[^']+':\s*/, '');
  }

  // -------------------------------------------------------------------------------------------
  // Comandos
  // -------------------------------------------------------------------------------------------

  private registerCommands(): void {
    const modifier = this.info?.primaryModifier ?? 'Ctrl';

    const commands: Command[] = [
      {
        id: 'scaffold.wizard',
        icon: 'wand',
        title: 'Nueva solución con el asistente de arquitecturas',
        group: 'Scaffolding',
        keybinding: `${modifier}+Shift+N`,
        run: () => void this.wizard.open(),
      },
      {
        id: 'file.open-folder',
        icon: 'folder-open',
        title: 'Abrir carpeta…',
        group: 'Archivo',
        keybinding: `${modifier}+O`,
        run: () => void this.openFolderDialog(),
      },
      {
        id: 'file.save',
        title: 'Guardar',
        group: 'Archivo',
        keybinding: `${modifier}+S`,
        run: () => void this.editor.saveActive(),
      },
      {
        id: 'file.save-all',
        title: 'Guardar todo',
        group: 'Archivo',
        keybinding: `${modifier}+Alt+S`,
        run: () => void this.editor.saveAll(),
      },
      {
        id: 'file.close-tab',
        title: 'Cerrar pestaña',
        group: 'Archivo',
        keybinding: `${modifier}+W`,
        run: () => {
          const tab = this.editor.activeTab();
          if (tab) void this.editor.close(tab.path).then(() => this.editor.renderTabs());
        },
      },
      {
        id: 'file.new',
        title: 'Nuevo archivo en la solución…',
        group: 'Archivo',
        run: () => void this.createFilePrompt(),
      },
      {
        id: 'build.build',
        icon: 'hammer',
        title: 'Compilar solución',
        group: 'Compilar',
        keybinding: `${modifier}+Shift+B`,
        run: () => void this.runTask('build'),
      },
      {
        id: 'build.rebuild',
        title: 'Recompilar todo',
        group: 'Compilar',
        keybinding: `${modifier}+Alt+B`,
        run: () => void this.runTask('rebuild'),
      },
      { id: 'build.clean', title: 'Limpiar', group: 'Compilar', run: () => void this.runTask('clean') },
      { id: 'build.restore', title: 'Restaurar paquetes', group: 'Compilar', run: () => void this.runTask('restore') },
      {
        id: 'build.test',
        icon: 'flask',
        title: 'Ejecutar pruebas',
        group: 'Compilar',
        keybinding: `${modifier}+Shift+T`,
        run: () => void this.runTask('test'),
      },
      {
        id: 'run.start',
        icon: 'bug',
        title: 'Iniciar depuración',
        group: 'Depurar',
        keybinding: 'F5',
        run: () => void this.startStartupProfile('debug'),
      },
      {
        id: 'run.without-debug',
        title: 'Ejecutar sin depurar',
        group: 'Depurar',
        run: () => void this.startStartupProfile('run'),
      },
      {
        id: 'debug.continue',
        title: 'Continuar',
        group: 'Depurar',
        run: () => void window.dotforge.debug.control('continue'),
      },
      {
        id: 'debug.step-over',
        title: 'Paso a paso por procedimientos',
        group: 'Depurar',
        keybinding: 'F10',
        run: () => void window.dotforge.debug.control('stepOver'),
      },
      {
        id: 'debug.step-in',
        title: 'Paso a paso por instrucciones',
        group: 'Depurar',
        keybinding: 'F11',
        run: () => void window.dotforge.debug.control('stepIn'),
      },
      {
        id: 'debug.step-out',
        title: 'Salir del método',
        group: 'Depurar',
        keybinding: 'Shift+F11',
        run: () => void window.dotforge.debug.control('stepOut'),
      },
      {
        id: 'debug.toggle-breakpoint',
        title: 'Alternar breakpoint en la línea actual',
        group: 'Depurar',
        keybinding: 'F9',
        run: () => {
          const tab = this.editor.activeTab();
          const line = this.cursor?.line;
          if (tab && line) void this.toggleBreakpoint(tab.path, line);
        },
      },
      {
        id: 'run.watch',
        icon: 'refresh',
        title: 'Ejecutar con Hot Reload (dotnet watch)',
        group: 'Depurar',
        keybinding: `${modifier}+F5`,
        run: () => void this.runTask('watch'),
      },
      {
        id: 'run.stop',
        icon: 'stop',
        title: 'Detener',
        group: 'Depurar',
        keybinding: 'Shift+F5',
        run: () => {
          void window.dotforge.debug.stop();
          void this.stopTasks();
        },
      },
      {
        id: 'view.explorer',
        icon: 'solution',
        title: 'Explorador de soluciones',
        group: 'Ver',
        keybinding: `${modifier}+Shift+E`,
        run: () => this.showExplorer(),
      },
      {
        id: 'view.source-control',
        icon: 'source-control',
        title: 'Control de código fuente',
        group: 'Ver',
        keybinding: `${modifier}+Shift+G`,
        run: () => this.showGit(),
      },
      {
        id: 'view.nuget',
        icon: 'package',
        title: 'Paquetes NuGet',
        group: 'Ver',
        keybinding: `${modifier}+Shift+U`,
        run: () => this.showNuGet(),
      },
      {
        id: 'view.efcore',
        icon: 'database',
        title: 'Base de datos y migraciones de EF Core',
        group: 'Ver',
        keybinding: `${modifier}+Shift+D`,
        run: () => this.showEfCore(),
      },
      {
        id: 'efcore.add-migration',
        icon: 'plus',
        title: 'EF Core: añadir migración…',
        group: 'Base de datos',
        run: () => {
          this.showEfCore();
          this.efcoreView.focusMigrationName();
        },
      },
      {
        id: 'efcore.update-database',
        icon: 'database',
        title: 'EF Core: actualizar la base de datos',
        group: 'Base de datos',
        run: () => {
          this.showEfCore();
          this.efcoreView.updateDatabase();
        },
      },
      {
        id: 'http.send-request',
        icon: 'send',
        title: 'HTTP: enviar la petición del cursor',
        group: 'HTTP',
        keybinding: 'Alt+Enter',
        run: () => void this.sendHttpRequestAtCursor(),
      },
      {
        id: 'http.generate-file',
        icon: 'code',
        title: 'HTTP: generar pruebas del archivo actual',
        group: 'HTTP',
        run: () => void this.generateHttpFile(),
      },
      {
        id: 'view.problems',
        icon: 'alert-circle',
        title: 'Problemas',
        group: 'Ver',
        keybinding: `${modifier}+Shift+M`,
        run: () => this.panel.show('problems'),
      },
      {
        id: 'view.terminal',
        icon: 'terminal',
        title: 'Terminal integrada',
        group: 'Ver',
        keybinding: `${modifier}+J`,
        run: () => this.panel.show('terminal'),
      },
      { id: 'view.output', title: 'Salida', group: 'Ver', run: () => this.panel.show('output') },
      {
        id: 'view.settings',
        title: 'Ajustes',
        group: 'Ver',
        icon: 'settings',
        run: () => this.showSettings(),
      },
      {
        id: 'view.toggle-theme',
        title: 'Cambiar tema claro/oscuro',
        group: 'Ver',
        icon: 'moon',
        run: () => void this.toggleTheme(),
      },
      {
        id: 'view.command-palette',
        icon: 'command',
        title: 'Paleta de comandos',
        group: 'Ver',
        keybinding: `${modifier}+Shift+P`,
        run: () => this.palette.show(),
      },
      { id: 'edit.find', title: 'Buscar en el archivo', group: 'Editar', keybinding: `${modifier}+F`, run: () => this.editor.runAction('actions.find') },
      {
        id: 'edit.format',
        title: 'Formatear documento',
        group: 'Editar',
        keybinding: 'Alt+Shift+F',
        run: () => this.editor.runAction('editor.action.formatDocument'),
      },
      {
        id: 'edit.go-to-definition',
        title: 'Ir a la definición',
        group: 'Editar',
        keybinding: 'F12',
        run: () => this.editor.runAction('editor.action.revealDefinition'),
      },
      {
        id: 'edit.rename',
        title: 'Renombrar símbolo',
        group: 'Editar',
        keybinding: 'F2',
        run: () => this.editor.runAction('editor.action.rename'),
      },
      { id: 'lsp.restart', title: 'Reiniciar el servidor de lenguaje de C#', group: 'C#', run: () => void this.restartLsp() },
      {
        id: 'ai.chat',
        icon: 'sparkles',
        title: 'DotForge AI: abrir el asistente',
        group: 'IA',
        // Ctrl+Shift+I lo tiene cogido el inspector de Electron: aquí sería una trampa.
        keybinding: `${modifier}+Shift+A`,
        run: () => this.showAi(),
      },
      {
        id: 'ai.inline',
        icon: 'wand',
        title: 'DotForge AI: editar el código seleccionado',
        group: 'IA',
        keybinding: `${modifier}+I`,
        run: () => this.aiInline.open(),
      },
      {
        id: 'ai.explain',
        title: 'DotForge AI: explicar el código',
        group: 'IA',
        run: () => this.askAi('explain'),
      },
      {
        id: 'ai.tests',
        icon: 'flask',
        title: 'DotForge AI: generar pruebas xUnit',
        group: 'IA',
        run: () => this.askAi('tests'),
      },
      {
        id: 'ai.fix',
        icon: 'tool',
        title: 'DotForge AI: corregir violación de arquitectura',
        group: 'IA',
        run: () => this.askAi('fix'),
      },
      {
        id: 'ai.reset',
        title: 'DotForge AI: empezar una conversación nueva',
        group: 'IA',
        run: () => this.aiChat.reset(),
      },
      {
        id: 'git.commit',
        icon: 'git-commit',
        title: 'Git: confirmar los cambios preparados',
        group: 'Git',
        run: () => {
          this.showGit();
          this.gitView.commit();
        },
      },
      {
        id: 'git.push',
        icon: 'upload',
        title: 'Git: publicar (push)',
        group: 'Git',
        run: () => {
          this.showGit();
          this.gitView.push();
        },
      },
      {
        id: 'git.pull',
        icon: 'download',
        title: 'Git: traer del remoto (pull)',
        group: 'Git',
        run: () => {
          this.showGit();
          this.gitView.pull();
        },
      },
      {
        id: 'git.sync',
        icon: 'refresh',
        title: 'Git: sincronizar (pull + push)',
        group: 'Git',
        run: () => {
          this.showGit();
          this.gitView.sync();
        },
      },
      {
        id: 'help.about',
        icon: 'info',
        title: 'Acerca de DotForge IDE',
        group: 'Ayuda',
        run: () => this.showAbout(),
      },
    ];

    this.palette.register(commands);
  }

  private async runCommandById(id: string): Promise<void> {
    const command = this.palette.getCommands().find((entry) => entry.id === id);
    if (command) await command.run();
  }

  private async createFilePrompt(): Promise<void> {
    if (!this.solution) {
      this.notify('Abre primero una carpeta.', 'warn');
      return;
    }

    const relative = window.prompt('Ruta del nuevo archivo, relativa a la solución:', 'src/Nuevo.cs');
    if (!relative) return;

    const separator = this.info?.platform === 'win32' ? '\\' : '/';
    const target = `${this.solution.directory}${separator}${relative.split('/').join(separator)}`;

    try {
      await window.dotforge.fs.createFile(target, '');
      await this.explorer.refresh();
      await this.openFile(target);
    } catch (error) {
      this.notify(`No se ha podido crear el archivo: ${this.messageOf(error)}`, 'error');
    }
  }

  private showAbout(): void {
    const info = this.info;
    if (!info) return;

    const overlay = byId('overlay');
    overlay.hidden = false;
    overlay.className = 'overlay center';
    clear(overlay);

    const rows: Array<[string, string]> = [
      ['Versión', info.version],
      ['Electron', info.electron],
      ['Chromium', info.chrome],
      ['Node', info.node],
      ['Plataforma', `${info.platform}-${info.arch}`],
      ['Compilado', info.builtAtUtc ?? 'desconocido'],
      ['SDK de .NET', info.dotnetSdks[0] ?? 'no detectado'],
      ['Runtimes', String(info.dotnetRuntimes.length)],
    ];

    const dialog = el(
      'div',
      { className: 'dialog', style: { width: 'min(520px, 92vw)' } },
      el(
        'div',
        { className: 'dialog-header' },
        el('div', {}, el('h2', { text: 'DotForge IDE' }), el('p', { text: 'IDE para C#, .NET 9+ y Blazor' })),
        el('button', {
          className: 'icon-btn',
          text: '✕',
          on: {
            click: () => {
              overlay.hidden = true;
              clear(overlay);
            },
          },
        }),
      ),
      el(
        'div',
        { className: 'dialog-body' },
        ...rows.map(([label, value]) =>
          el(
            'div',
            { className: 'link-item', style: { cursor: 'default' } },
            el('span', { text: label }),
            el('span', { className: 'sub', text: value }),
          ),
        ),
        el('p', {
          className: 'help',
          style: { marginTop: '14px', color: 'var(--text-faint)' },
          text: 'Componentes open source: Electron, Monaco Editor, Roslyn LanguageServer / OmniSharp y NetCoreDbg.',
        }),
      ),
    );

    overlay.appendChild(dialog);
  }

  // -------------------------------------------------------------------------------------------
  // Cliente HTTP y lentes de código
  // -------------------------------------------------------------------------------------------

  /**
   * Registra el lenguaje `.http` y las dos lentes de código.
   *
   * Los comandos se registran en el editor (`addCommand`) en vez de en un registro global porque
   * es la única forma que ofrece el editor autónomo de Monaco: `registerCommand` no está expuesto
   * en el paquete de distribución, y un `MarkerProvider` no puede ejecutar acciones.
   */
  private registerHttpFeatures(): void {
    const monaco = getMonaco();
    registerHttpLanguage(monaco);

    const editor = this.editor.getEditor();
    if (!editor) return;

    const sendCommand = editor.addCommand(0, (_context, index: unknown) => {
      void this.sendHttpRequest(Number(index));
    });

    const generateCommand = editor.addCommand(0, (_context, line: unknown) => {
      void this.generateHttpRequest(Number(line));
    });

    monaco.languages.registerCodeLensProvider(HTTP_LANGUAGE_ID, {
      provideCodeLenses: (model) => {
        const document = parseHttpFile(model.getValue());

        return {
          lenses: document.requests.map((request) => ({
            id: `http-send-${request.index}`,
            range: {
              startLineNumber: request.requestLine,
              startColumn: 1,
              endLineNumber: request.requestLine,
              endColumn: 1,
            },
            ...(sendCommand === null
              ? {}
              : { command: { id: sendCommand, title: 'Enviar petición', arguments: [request.index] } }),
          })),
          dispose: () => undefined,
        };
      },
    });

    monaco.languages.registerCodeLensProvider('csharp', {
      provideCodeLenses: (model) => {
        const endpoints = findEndpoints(model.getValue());

        return {
          lenses: endpoints.map((endpoint, position) => ({
            id: `endpoint-${position}`,
            range: {
              startLineNumber: endpoint.line,
              startColumn: 1,
              endLineNumber: endpoint.line,
              endColumn: 1,
            },
            ...(generateCommand === null
              ? {}
              : {
                  command: {
                    id: generateCommand,
                    title: `Probar ${endpoint.method} ${endpoint.route}`,
                    arguments: [endpoint.line],
                  },
                }),
          })),
          dispose: () => undefined,
        };
      },
    });
  }

  /** Envía la petición número `index` del archivo `.http` abierto. */
  private async sendHttpRequest(index: number): Promise<void> {
    const tab = this.editor.activeTab();
    if (!tab) return;

    const document = parseHttpFile(tab.model.getValue());
    const request = document.requests.find((candidate) => candidate.index === index) ?? document.requests[0];

    if (!request) {
      this.notify('No hay ninguna petición en este archivo.', 'warn');
      return;
    }

    await this.httpClient.send(request, document.variables);
  }

  /** Envía la petición donde está el cursor. Es el camino del atajo y de la paleta. */
  private async sendHttpRequestAtCursor(): Promise<void> {
    const tab = this.editor.activeTab();
    if (!tab || !isHttpFile(tab.path)) {
      this.notify('Abre un archivo .http o .rest para enviar una petición.', 'warn');
      return;
    }

    const document = parseHttpFile(tab.model.getValue());
    const line = this.cursor?.line ?? 1;
    const request =
      document.requests.find((candidate) => line >= candidate.startLine && line <= candidate.endLine) ??
      document.requests[0];

    if (!request) {
      this.notify('No hay ninguna petición en este archivo.', 'warn');
      return;
    }

    await this.httpClient.send(request, document.variables);
  }

  /** Proyecto de la solución que contiene un archivo, por el prefijo más largo de su ruta. */
  private projectFor(path: string): ProjectInfo | null {
    const normalized = path.replace(/\\/g, '/').toLowerCase();

    let best: ProjectInfo | null = null;
    for (const project of this.solution?.projects ?? []) {
      const directory = `${project.directory.replace(/\\/g, '/').toLowerCase()}/`;
      if (!normalized.startsWith(directory)) continue;
      if (best === null || project.directory.length > best.directory.length) best = project;
    }

    return best;
  }

  /**
   * URL base de las pruebas generadas.
   *
   * Si hay un proceso arrancado que ya ha anunciado su puerto, se usa el suyo: generar una prueba
   * contra `https://localhost:7001` cuando la aplicación escucha en el 5183 es garantizar que la
   * primera ejecución falle.
   */
  private baseUrlForTests(): string {
    return this.panel.services().find((service) => service.url !== null)?.url ?? 'https://localhost:7001';
  }

  /** Añade al `.http` del proyecto la petición del endpoint que hay en esa línea. */
  private async generateHttpRequest(line: number): Promise<void> {
    const tab = this.editor.activeTab();
    if (!tab) return;

    const endpoint = findEndpoints(tab.model.getValue()).find((candidate) => candidate.line === line);
    if (!endpoint) return;

    await this.appendToHttpFile(tab.path, requestFor(endpoint));
  }

  /** Genera el archivo `.http` completo del archivo C# abierto. */
  private async generateHttpFile(): Promise<void> {
    const tab = this.editor.activeTab();
    if (!tab || !/\.cs$/i.test(tab.path)) {
      this.notify('Abre un archivo .cs con endpoints para generar sus pruebas HTTP.', 'warn');
      return;
    }

    const endpoints = findEndpoints(tab.model.getValue());
    if (endpoints.length === 0) {
      this.notify('No se han encontrado endpoints en este archivo.', 'warn');
      return;
    }

    const project = this.projectFor(tab.path);
    const body = buildHttpFile(endpoints, {
      baseUrl: this.baseUrlForTests(),
      title: `Peticiones de ${project?.name ?? 'la API'}`,
    });

    await this.writeHttpFile(tab.path, body);
    this.notify(`${endpoints.length} petición(es) generadas.`, 'ok');
  }

  /** Ruta del `.http` de un archivo: junto al `.csproj` de su proyecto. */
  private httpFilePathFor(sourcePath: string): string | null {
    const project = this.projectFor(sourcePath);
    if (!project) return null;

    return `${project.directory.replace(/\\/g, '/')}/${httpFileNameFor(project.name)}`;
  }

  private async writeHttpFile(sourcePath: string, content: string): Promise<void> {
    const target = this.httpFilePathFor(sourcePath);
    if (target === null) {
      this.notify('No se ha podido determinar el proyecto de este archivo.', 'warn');
      return;
    }

    try {
      await window.dotforge.fs.writeFile(target, content);
      await this.openFile(target);
    } catch (error) {
      this.notify(`No se ha podido escribir ${target}: ${this.messageOf(error)}`, 'error');
    }
  }

  /**
   * Añade una petición al final del `.http` del proyecto, creándolo si no existe.
   *
   * Se **añade**, nunca se sobrescribe: el archivo suele tener ya peticiones ajustadas a mano con
   * cuerpos y tokens de verdad, y perderlas por pulsar una lente sería imperdonable.
   */
  private async appendToHttpFile(sourcePath: string, request: string): Promise<void> {
    const target = this.httpFilePathFor(sourcePath);
    if (target === null) {
      this.notify('No se ha podido determinar el proyecto de este archivo.', 'warn');
      return;
    }

    let existing = '';
    try {
      existing = (await window.dotforge.fs.readFile(target)).content;
    } catch {
      // No existe todavía: se crea con su cabecera de variables.
      existing = buildHttpFile([], { baseUrl: this.baseUrlForTests() });
    }

    const separator = existing.trim() === '' ? '' : '\n\n';
    await this.writeHttpFile(sourcePath, `${existing.replace(/\s+$/, '')}${separator}${request}\n`);
  }

  // -------------------------------------------------------------------------------------------
  // Puentes de eventos
  // -------------------------------------------------------------------------------------------

  private installEventBridges(): void {
    window.dotforge.events.onMenuCommand((command: MenuCommand) => void this.runCommandById(command));

    window.dotforge.events.onWorkspaceChanged((solution) => this.applySolution(solution));

    window.dotforge.events.onTaskStarted((task) => {
      this.panel.taskStarted(task);
      this.renderStatus();
      this.startupBar.render();
    });

    window.dotforge.events.onTaskOutput((output) => {
      this.panel.append(output.chunk, output.stream, output.taskId);
    });

    window.dotforge.events.onTaskExit((exit) => {
      this.panel.taskFinished(exit);
      // Si la tarea era una operación de EF Core, el panel de base de datos se relee solo.
      this.efcoreView.noteTaskExit(exit.taskId, exit.code);
      this.applyBuildMarkers(exit.diagnostics);
      this.renderStatus();
      this.startupBar.render();

      if (exit.applicationUrl) {
        this.notify(`La aplicación escucha en ${exit.applicationUrl}`, 'ok');
      }
      // Instalar o quitar un paquete cambia el .csproj: hay que releer la solución.
      void this.reloadSolution();
    });

    window.dotforge.events.onLspState((state) => {
      this.lsp = state;
      this.renderStatus();

      if (state.status === 'ready') {
        reopenAll(
          this.editor
            .listTabs()
            .filter((tab) => tab.languageId === 'csharp' || tab.languageId === 'razor')
            .map((tab) => ({ path: tab.path, languageId: tab.languageId, text: tab.model.getValue() })),
        );
      }
    });

    window.dotforge.events.onLspNotification(({ method, params }) => {
      if (method === 'textDocument/publishDiagnostics') {
        applyPublishDiagnostics(getMonaco(), params, (path, markers) => this.editor.setMarkers(path, markers));
      }
    });

    window.dotforge.events.onDebugState((state) => {
      this.debug.setState(state);
      if (state.status !== 'paused') this.editor.setExecutionLine(null, null);
      if (this.panel.currentTab() === 'debug') this.panel.render();
      this.renderStatus();
    });

    window.dotforge.events.onDebugStopped(() => {
      void this.debug.refreshAfterStop().then((frame) => {
        if (frame?.file) {
          void this.openFile(frame.file, frame.line).then(() => {
            this.editor.setExecutionLine(frame.file, frame.line);
          });
        }
        this.panel.show('debug');
      });
    });

    window.dotforge.events.onDebugOutput(({ category, text }) => {
      this.panel.append(text, category === 'stderr' ? 'stderr' : 'stdout');
    });

    // El streaming del asistente lo consume quien lanzó la petición: el chat de la barra lateral
    // o el widget en línea. El `requestId` decide, así que los dos pueden convivir.
    window.dotforge.events.onAiDelta(({ requestId, text }) => {
      if (this.aiChat.ownsRequest(requestId)) this.aiChat.appendDelta(requestId, text);
      else if (this.aiInline.ownsRequest(requestId)) this.aiInline.appendDelta(requestId, text);
    });

    window.dotforge.events.onAiEnd(({ requestId, reason, message }) => {
      if (this.aiChat.ownsRequest(requestId)) this.aiChat.finish(requestId, reason, message);
      else if (this.aiInline.ownsRequest(requestId)) this.aiInline.finish(requestId, reason, message);
    });

    // Avisar de cambios sin guardar antes de cerrar la ventana.
    window.addEventListener('beforeunload', (event) => {
      if (this.editor.hasDirtyTabs()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  private applyBuildMarkers(diagnostics: BuildDiagnostic[]): void {
    const monaco = getMonaco();
    const byPath = new Map<string, MonacoApi.editor.IMarkerData[]>();

    for (const diagnostic of diagnostics) {
      if (!diagnostic.file) continue;

      const markers = byPath.get(diagnostic.file) ?? [];
      markers.push({
        severity:
          diagnostic.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : diagnostic.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        message: `${diagnostic.code}: ${diagnostic.message}`,
        startLineNumber: Math.max(diagnostic.line, 1),
        startColumn: Math.max(diagnostic.column, 1),
        endLineNumber: Math.max(diagnostic.line, 1),
        endColumn: Math.max(diagnostic.column, 1) + 1,
        source: 'MSBuild',
      });
      byPath.set(diagnostic.file, markers);
    }

    this.editor.setBuildMarkers(byPath);
  }

  private installKeyboardShortcuts(): void {
    window.addEventListener('keydown', (event) => {
      const modifier = event.ctrlKey || event.metaKey;

      // La paleta se abre desde cualquier sitio, incluso con el foco dentro del editor.
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        this.palette.show();
        return;
      }

      // Ctrl/Cmd+I no se atiende aquí: el acelerador del menú nativo llega antes que el renderer,
      // así que registrarlo también en `window` sólo conseguiría abrir el widget dos veces.

      // Con la vista previa abierta, Enter acepta y Escape descarta.
      if ((event.key === 'Enter' || event.key === 'Escape') && this.aiInline.isOpen()) {
        if (this.aiInline.handleKey(event.key)) {
          event.preventDefault();
          return;
        }
      }

      if (event.key === 'Escape' && this.palette.isOpen()) {
        this.palette.hide();
      }
    });
  }

  /** Redimensionado de sidebar y panel con el ratón, con límites razonables. */
  private installResizers(): void {
    const setup = (id: string, apply: (delta: number, start: number) => void, axis: 'x' | 'y'): void => {
      const handle = byId(id);

      handle.addEventListener('mousedown', (event) => {
        event.preventDefault();
        handle.classList.add('dragging');

        const origin = axis === 'x' ? event.clientX : event.clientY;
        const startValue = axis === 'x'
          ? byId('sidebar').getBoundingClientRect().width
          : byId('panel').getBoundingClientRect().height;

        const onMove = (moveEvent: MouseEvent): void => {
          const current = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
          apply(current - origin, startValue);
        };

        const onUp = (): void => {
          handle.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    };

    setup(
      'resizer-sidebar',
      (delta, start) => {
        const width = Math.min(Math.max(start + delta, 180), 620);
        byId('app').style.setProperty('--sidebar-width', `${width}px`);
      },
      'x',
    );

    setup(
      'resizer-panel',
      (delta, start) => {
        const height = Math.min(Math.max(start - delta, 80), window.innerHeight - 240);
        byId('app').style.setProperty('--panel-height', `${height}px`);
      },
      'y',
    );
  }
}

const app = new DotForgeApp();

app.start().catch((error: unknown) => {
  // Un fallo de arranque no puede dejar una ventana en blanco sin explicación.
  const container = document.getElementById('welcome') ?? document.body;
  container.textContent = '';
  container.appendChild(
    el(
      'div',
      { className: 'welcome-inner' },
      el('h1', { text: 'DotForge IDE no ha podido arrancar' }),
      el('pre', {
        className: 'output',
        text: error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error),
      }),
    ),
  );
});

export type { OpenTab };
