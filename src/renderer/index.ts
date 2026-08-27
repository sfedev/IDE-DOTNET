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
import { debugChannelTransition, portOf } from './run-output.js';
import type { ArchitectureViolation } from '../shared/architecture-rules.js';
import { checkSolution, checkUsings } from '../shared/architecture-rules.js';
import { architectureLabel, buildContext, detectArchitecture } from '../shared/ai-context.js';
import type { RunMode, StartupConfig } from '../shared/startup.js';
import { launchPlan, runnableProjects, shortProjectName } from '../shared/startup.js';
import { aiEntryState, AI_DISABLED_MESSAGE } from './ai-availability.js';
import type { TunnelTool } from '../shared/dev-tunnel.js';
import { TUNNEL_TOOLS, TunnelOutputScanner, TUNNEL_WARNING, tunnelInfo } from '../shared/dev-tunnel.js';
import { findTests } from '../shared/test-explorer.js';
import type { ActivityToolId } from '../shared/activity-bar.js';
import { moveActivityTool, normalizeActivityOrder, PINNED_ACTIVITY_TOOL } from '../shared/activity-bar.js';
import { defaultProfileId } from '../shared/terminal-profiles.js';
import { byId, clear, el } from './dom.js';
import { installIconGallery } from './icon-gallery.js';
import { icon, type IconName } from './icons.js';
import { applyPublishDiagnostics, reopenAll } from './lsp-bridge.js';
import { defineThemes, getMonaco, loadMonaco } from './monaco-setup.js';
import { HTTP_LANGUAGE_ID, registerHttpLanguage } from './languages/http.js';
import { AiChatView } from './views/ai-chat.js';
import { InlineAssistant } from './views/ai-inline.js';
import { EditorView, type OpenTab } from './views/editor.js';
import { ContainersView } from './views/containers.js';
import { EfCoreView } from './views/efcore.js';
import { ExplorerView } from './views/explorer.js';
import { SearchView } from './views/search.js';
import { HttpClientView } from './views/http.js';
import { GitView } from './views/git.js';
import { NuGetView } from './views/nuget.js';
import { MetricsView } from './views/metrics.js';
import { PanelView, type ServiceInfo } from './views/panel.js';
import { TestExplorerView } from './views/tests.js';
import { DebugView } from './views/debug.js';
import { CommandPalette, type Command } from './views/palette.js';
import { SettingsView } from './views/settings.js';
import { StartupBar } from './views/startup-bar.js';
import { StatusBar } from './views/statusbar.js';
import { WelcomeView } from './views/welcome.js';
import { WizardView } from './views/wizard.js';
import { ExtensionsView } from './views/extensions.js';
import { UpdateCard } from './views/update-card.js';
import { askDialog, type DialogChoice } from './views/confirm-dialog.js';
import { ConfirmationLock } from './editor-state.js';

type SidebarView =
  | 'explorer'
  | 'search'
  | 'git'
  | 'nuget'
  | 'efcore'
  | 'containers'
  | 'tests'
  | 'extensions'
  | 'settings'
  | 'ai';

class DotForgeApp {
  private info: AppInfo | null = null;
  private settings: AppSettings | null = null;
  /** Herramienta que se está arrastrando en la barra de actividad. */
  private draggedTool: string | null = null;
  private solution: SolutionInfo | null = null;
  private lsp: LspState = { status: 'idle', server: null, version: null, message: null, progress: null };
  private cursor: { line: number; column: number } | null = null;
  private sidebarView: SidebarView = 'explorer';
  private lspProviders: MonacoApi.IDisposable | null = null;
  private git: GitStatus | null = null;

  /** Avisos del linter de arquitectura. Viven aquí porque no los produce ninguna tarea. */
  private architectureIssues: BuildDiagnostic[] = [];

  /** true entre que el depurador arranca de verdad y termina. Ver `onDebugState`. */
  private debugSessionActive = false;

  /**
   * El usuario ya ha contestado al aviso de cierre y la ventana se está yendo.
   *
   * Sin este pestillo, el `window.close()` que sigue a la respuesta vuelve a disparar
   * `beforeunload`, encuentra las mismas pestañas sucias y pregunta otra vez: un bucle del que
   * sólo se sale matando el proceso.
   */
  private closing = false;

  /** Como mucho un aviso de cierre en pantalla, y se suelta pase lo que pase. */
  private readonly closeLock = new ConfirmationLock();
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

  /** Contexto del autocompletado que sólo conoce el proceso principal. */
  private containers: string[] = [];
  private images: string[] = [];
  private npmScripts: string[] = [];

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
      // Guardar un .cs puede haber añadido (o quitado) un `using` prohibido.
      if (/\.cs$/i.test(tab.path)) this.lintArchitecture();
    },
    onEditorError: (message) => this.notify(message, 'error'),
  });

  private readonly explorer = new ExplorerView({
    openFile: (path) => void this.openFile(path),
    revealInFolder: (path) => void window.dotforge.app.showItemInFolder(path),
    runProjectTask: (kind, projectPath) => void this.runTask(kind, projectPath),
    showPackagesFor: (project) => this.showNuGet(project),
    refresh: () => void this.openFolderDialog(),
    askAi: (action, path) => void this.askAiAboutFile(action, path),
  });

  /** Búsqueda de texto en los archivos. Comparte contenedor con el resto de la barra lateral. */
  private readonly searchView = new SearchView({
    openMatch: (path, line, column, length) => void this.openFile(path, line, column, length),
    notify: (message, level) => this.notify(message, level),
  });

  private readonly nuget = new NuGetView({
    notify: (message, level) => this.notify(message, level),
    reloadSolution: () => void this.reloadSolution(),
    openUrl: (url) => void window.dotforge.app.openExternal(url),
    vulnerabilitiesChanged: () => this.renderActivityBar(),
  });

  /** Explorador de pruebas: árbol proyecto → clase → prueba y ejecución con resultados. */
  private readonly testsView = new TestExplorerView({
    notify: (message, level) => this.notify(message, level),
    openFile: (path, line) => void this.openFile(path, line),
    showOutput: () => this.panel.show('output'),
    publishFailures: (diagnostics) => {
      this.panel.setTestDiagnostics(diagnostics);
      this.renderActivityBar();
      this.renderStatus();
    },
    defaultTarget: () => this.solution?.path ?? this.solution?.projects[0]?.path ?? null,
  });

  /** Monitor de rendimiento: vive dentro del panel inferior, como la depuración. */
  private readonly metricsView = new MetricsView({
    notify: (message, level) => this.notify(message, level),
    refresh: () => {
      if (this.panel.currentTab() === 'metrics') this.panel.render();
    },
    runningServiceNames: () => this.panel.services().map((service) => service.label),
  });

  /** Túnel público activo: tarea, herramienta y URL en cuanto la anuncia. */
  private tunnel: { taskId: string; tool: TunnelTool; port: number; url: string | null } | null = null;
  private readonly tunnelScanner = new TunnelOutputScanner();

  private readonly panel = new PanelView({
    openDiagnostic: (diagnostic) => void this.openDiagnostic(diagnostic),
    cancelTask: (taskId) => void window.dotforge.dotnet.cancelTask(taskId),
    runCommand: (line) => void this.runTerminalCommand(line),
    renderDebug: (container) => this.debug.render(container, () => this.panel.render()),
    renderHttp: (container) => this.httpClient.render(container),
    renderMetrics: (container) => this.metricsView.render(container),
    openLogLocation: (file, line) => void this.openFile(file, line),
    suggestContext: () => ({
      branches: this.branches,
      projects: (this.solution?.projects ?? []).map((project) => project.path),
      programs: this.allowedCommands,
      containers: this.containers,
      images: this.images,
      npmScripts: this.npmScripts,
    }),
    openUrl: (url) => void window.dotforge.app.openExternal(url),
    restartService: (service) => void this.restartService(service),
    stopDebug: () => void window.dotforge.debug.stop(),
    servicesChanged: () => this.startupBar.render(),
    notify: (message, level) => this.notify(message, level),
  });

  /** Gestor de EF Core: migraciones, esquema y cadenas de conexión. */
  private readonly efcoreView = new EfCoreView({
    notify: (message, level) => this.notify(message, level),
    openFile: (path) => void this.openFile(path),
    showOutput: () => this.panel.show('output'),
  });

  /** Panel de contenedores y Docker Compose. */
  private readonly containersView = new ContainersView({
    notify: (message, level) => this.notify(message, level),
    showOutput: () => this.panel.show('output'),
    openUrl: (url) => void window.dotforge.app.openExternal(url),
    openFile: (path) => void this.openFile(path),
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

  /** Explorador de extensiones de Open VSX. Comparte contenedor con el resto de la barra lateral. */
  private readonly extensionsView = new ExtensionsView({
    notify: (message, level) => this.notify(message, level),
    openUrl: (url) => void window.dotforge.app.openExternal(url),
  });

  /** Tarjeta flotante de actualización. No ocupa sitio en la interfaz hasta que hay algo que decir. */
  private readonly updateCard = new UpdateCard({
    notify: (message, level) => this.notify(message, level),
    openUrl: (url) => void window.dotforge.app.openExternal(url),
  });

  private readonly settingsView = new SettingsView({
    apply: (patch) => void this.applySettings(patch),
    checkUpdates: () => void this.checkForUpdates(),
    updateState: () => this.updateCard.getState(),
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
    this.registerTestFeatures();

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

    // Estado de la actualización. Se **pregunta** en vez de esperar el evento: la comprobación
    // automática ocurre cinco segundos después del arranque del proceso principal, y para entonces
    // el renderer puede llevar rato montado o no haber llegado todavía.
    void window.dotforge.updates
      .state()
      .then((state) => this.updateCard.setState(state))
      .catch(() => undefined);

    // Contexto del autocompletado de la terminal: programas permitidos, contenedores de Docker,
    // imágenes locales y scripts del package.json. Se pide una vez al arrancar.
    void this.refreshTerminalContext();

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

  /**
   * "Abrir solución…": diálogo filtrado a `.sln` / `.slnx`.
   *
   * El proceso principal devuelve la **carpeta** del archivo elegido, que es lo que el IDE abre.
   * Elegir el archivo es lo natural para quien viene de Visual Studio; quedarse con su carpeta es
   * lo que necesitan el explorador, git, la terminal y el servidor de lenguaje.
   */
  private async openSolutionDialog(): Promise<void> {
    const path = await window.dotforge.workspace.openSolutionDialog();
    if (path) await this.openWorkspace(path);
  }

  /**
   * Pregunta qué hacer con lo que está sin guardar y cierra la ventana si procede.
   *
   * Tres respuestas, porque "no guardar" y "cancelar" no son lo mismo y con dos botones hay que
   * negarle una de las tres al usuario. Si guardar falla —en Windows basta con que MSBuild tenga
   * el archivo abierto— **no se cierra**: perder el trabajo por un error que nadie ha llegado a
   * leer es exactamente lo que este aviso existe para evitar.
   */
  private async confirmClose(): Promise<void> {
    const dirty = this.editor.listTabs().filter((tab) => tab.dirty);
    if (dirty.length === 0) return;

    const answer = await this.closeLock.run(
      () =>
        askDialog({
          title: 'Cambios sin guardar',
          message:
            dirty.length === 1
              ? `"${dirty[0]?.name}" tiene cambios sin guardar.`
              : `${dirty.length} archivos tienen cambios sin guardar.`,
          detail: dirty.map((tab) => tab.name).join(', '),
          confirmLabel: 'Guardar y cerrar',
          alternateLabel: 'Cerrar sin guardar',
          cancelLabel: 'Seguir editando',
        }),
      'cancel' as DialogChoice,
    );

    if (answer === 'cancel') return;

    if (answer === 'confirm') {
      try {
        await this.editor.saveAll();
      } catch (error) {
        this.notify(`No se ha podido guardar: ${this.messageOf(error)}. La ventana sigue abierta.`, 'error');
        return;
      }
    }

    this.closing = true;
    window.close();
  }

  /**
   * Cierra la solución y deja el IDE como recién arrancado.
   *
   * Se cierran también las pestañas: dejarlas abiertas señalando archivos de una solución que ya no
   * está deja el editor lleno de rutas que el explorador ya no reconoce.
   */
  private async closeWorkspace(): Promise<void> {
    await this.editor.closeAll();
    await window.dotforge.workspace.close();
    this.applySolution(null);
    await this.refreshRecents();
  }

  /**
   * Abre la documentación didáctica de la solución.
   *
   * Las soluciones que genera el asistente salen con un `README.md` que explica sus capas y por qué
   * (ADR-010): es lo que convierte el generador en algo que se puede aprender y no sólo ejecutar.
   * Si la solución no lo trae —porque no la generó DotForge— se dice, en vez de abrir una pestaña
   * vacía.
   */
  private async openSolutionDocs(): Promise<void> {
    if (!this.solution) {
      this.notify('Abre una solución para ver su documentación.', 'warn');
      return;
    }

    const separator = this.info?.platform === 'win32' ? '\\' : '/';
    const readme = `${this.solution.directory}${separator}README.md`;

    try {
      await this.openFile(readme);
    } catch {
      this.notify(
        `Esta solución no trae README.md. Las que genera el asistente de arquitecturas sí lo incluyen.`,
        'warn',
      );
    }
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
    // Los resultados son de la solución anterior: sus rutas ya no existen. Se tiran al cambiar de
    // solución de verdad, nunca en una relectura (ADR-053 es la misma idea en NuGet).
    this.searchView.reset();
    this.efcoreView.setSolution(solution);
    this.containersView.setSolution(solution);
    this.testsView.setSolution(solution);
    this.startupBar.setSolution(solution);
    this.aiChat.setArchitecture(architectureLabel(detectArchitecture(solution)));
    this.updateTitle();
    this.lintArchitecture();
    void this.loadStartupConfig();
    void this.refreshTerminalContext();
    // Las pestañas de terminal que tenía esta solución. Sólo entra si el panel está intacto; lo
    // decide el propio panel, que es quien sabe qué hay abierto.
    if (solution) void this.panel.restoreTerminals();

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
      this.lintArchitecture();
    } catch (error) {
      this.notify(`No se ha podido recargar la solución: ${this.messageOf(error)}`, 'warn');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Archivos
  // -------------------------------------------------------------------------------------------

  /**
   * Abre un archivo y, si se le dice dónde, coloca el cursor ahí.
   *
   * `length` es lo que separa "ir a la línea" de "ir a la coincidencia": con él, lo encontrado
   * queda **seleccionado**, que es lo que uno espera al pulsar un resultado de la búsqueda — se ve
   * qué se ha encontrado y se puede sustituir escribiendo encima.
   */
  private async openFile(path: string, line?: number, column?: number, length?: number): Promise<void> {
    try {
      const document = await window.dotforge.fs.readFile(path);
      await this.editor.open(document, {
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
        ...(length === undefined ? {} : { length }),
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
      //
      // Se registra **también** el proyecto que se va a depurar. No lanza una tarea, pero es un
      // proceso como los demás: tiene que tener su canal, su pastilla y su botón de parada, en vez
      // de escupir su salida —y su puerto— dentro del canal de compilación.
      if (project) {
        this.panel.registerService(label, { projectPath: project.path, projectKind: project.kind });
      }

      try {
        if (step.action === 'debug') {
          this.panel.startDebugChannel(label, `dotnet run --project ${step.projectPath} (con depurador)`);
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

  /**
   * Ejecuta una línea escrita en la terminal integrada.
   *
   * Ya no se exige tener una carpeta abierta: la terminal arranca en la carpeta personal y desde
   * ahí se navega con `cd`. Pedir un workspace para poder escribir `git status` en otro sitio era
   * una restricción sin nada detrás.
   *
   * Una línea puede no lanzar ningún proceso —`cd`, `pwd`—: entonces vuelve con `task: null` y lo
   * que hay que enseñar viene en `output`.
   */
  private async runTerminalCommand(line: string): Promise<void> {
    try {
      const result = await window.dotforge.terminal.run(line);

      this.panel.setTerminalCwd(result.cwd);
      for (const text of result.output) this.panel.appendTerminalLine(text);

      // `claude` escrito en la asistida no lanza nada: pide su pestaña, que es una de verdad.
      if (result.intent === 'open-claude') {
        void this.panel.openOrFocusTerminal('claude');
        return;
      }

      // La salida de la terminal va a su propio canal, no al de compilación.
      if (result.task !== null) this.panel.attachTerminalTask(result.task.taskId);
    } catch (error) {
      this.panel.appendTerminalLine(this.messageOf(error), 'stderr');
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
    // La leyenda de tokens semánticos es del servidor que se está parando: se olvida.
    void import('./lsp-bridge.js').then(({ resetSemanticLegend }) => resetSemanticLegend());
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
   * Diez herramientas y ajustes, y el usuario decide en qué orden. El orden vive en las
   * preferencias (`activityBar.order`) y se cambia arrastrando los iconos: quien vive en el control
   * de código fuente no tiene por qué bajar la vista hasta el sexto icono.
   *
   * Cada botón lleva su `data-tool-id`, y eso no es decoración: es lo que hace que los modos de
   * diagnóstico `--ui=` sigan encontrando lo que buscan. Antes pulsaban por índice posicional y eso
   * se rompió en silencio dos veces al añadir una herramienta; con un orden que además cambia el
   * usuario, la posición ya no significa nada.
   */
  private renderActivityBar(): void {
    const bar = byId('activitybar');
    clear(bar);

    for (const id of this.activityOrder()) {
      bar.appendChild(this.activityButton(id));
    }

    bar.append(
      el('div', { className: 'spacer' }),
      // Ajustes no se arrastra: vive bajo el separador, al fondo, que es donde se busca.
      this.activityEntry(PINNED_ACTIVITY_TOOL, 'Ajustes', 'settings', this.sidebarView === 'settings', () =>
        this.showSettings(),
      ),
    );
  }

  private activityOrder(): ActivityToolId[] {
    return normalizeActivityOrder(this.settings?.activityBar.order);
  }

  /**
   * Un botón de la barra, ya arrastrable.
   *
   * `dragover` tiene que llamar a `preventDefault()` o el navegador no considera el elemento un
   * destino válido y el `drop` no llega nunca — es el error clásico de HTML5 Drag and Drop, y falla
   * en silencio: se ve el icono moverse con el ratón y al soltar no pasa nada.
   */
  private activityEntry(
    id: string,
    label: string,
    iconName: IconName,
    active: boolean,
    onClick: () => void,
    extra: HTMLElement | null = null,
  ): HTMLElement {
    const draggable = id !== PINNED_ACTIVITY_TOOL;

    const node = el(
      'button',
      {
        className: `activity-item${active ? ' active' : ''}`,
        title: draggable ? `${label} — arrástralo para cambiarlo de sitio` : label,
        attrs: { 'aria-label': label, 'data-tool-id': id },
        on: { click: onClick },
      },
      icon(iconName, { size: 20 }),
      extra,
    );

    if (!draggable) return node;

    node.draggable = true;

    node.addEventListener('dragstart', (event) => {
      this.draggedTool = id;
      node.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });

    node.addEventListener('dragend', () => {
      this.draggedTool = null;
      node.classList.remove('dragging');
      for (const item of byId('activitybar').querySelectorAll('.drop-target')) {
        item.classList.remove('drop-target');
      }
    });

    node.addEventListener('dragover', (event) => {
      if (this.draggedTool === null || this.draggedTool === id) return;
      // Sin esto el `drop` no llega: el destino se considera no válido.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      node.classList.add('drop-target');
    });

    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));

    node.addEventListener('drop', (event) => {
      event.preventDefault();
      node.classList.remove('drop-target');

      const dragged = this.draggedTool ?? event.dataTransfer?.getData('text/plain') ?? null;
      this.draggedTool = null;
      if (dragged === null) return;

      // El array actual se guarda en una variable: `moveActivityTool` devuelve **el mismo** cuando
      // no hay nada que mover, y compararlo contra otra llamada a `activityOrder()` no serviría de
      // nada porque cada llamada normaliza y devuelve uno nuevo. Así un arrastre que acaba donde
      // empezó no escribe las preferencias por nada.
      const current = this.activityOrder();
      const order = moveActivityTool(current, dragged, id);
      if (order === current) return;

      void this.applySettings({ activityBar: { order } });
    });

    return node;
  }

  /** Traduce un identificador de herramienta a su botón, con su estado y su insignia. */
  private activityButton(id: ActivityToolId): HTMLElement {
    const errors = this.panel.getDiagnostics().filter((diagnostic) => diagnostic.severity === 'error').length;
    const changes = this.git?.dirtyFiles ?? 0;

    switch (id) {
      case 'explorer':
        return this.activityEntry('explorer', 'Explorador de soluciones', 'solution', this.sidebarView === 'explorer', () =>
          this.showExplorer(),
        );
      case 'search':
        return this.activityEntry('search', 'Buscar en los archivos', 'search', this.sidebarView === 'search', () =>
          this.showSearch(),
        );
      case 'git':
        return this.sourceControlButton(changes);
      case 'wizard':
        return this.activityEntry('wizard', 'Generador de arquitecturas', 'wand', false, () => void this.wizard.open());
      case 'nuget':
        return this.nugetButton();
      case 'efcore':
        return this.activityEntry('efcore', 'Base de datos y EF Core', 'database', this.sidebarView === 'efcore', () =>
          this.showEfCore(),
        );
      case 'containers':
        return this.activityEntry(
          'containers',
          'Contenedores y Docker Compose',
          'package',
          this.sidebarView === 'containers',
          () => this.showContainers(),
        );
      case 'tests':
        return this.testsButton();
      case 'debug':
        return this.activityEntry(
          'debug',
          'Depuración',
          'bug',
          false,
          () => this.panel.show('debug'),
          errors > 0 ? el('span', { className: 'badge-dot' }) : null,
        );
      case 'ai':
        return this.aiButton();
      case 'extensions':
        return this.activityEntry('extensions', 'Extensiones', 'puzzle', this.sidebarView === 'extensions', () =>
          this.showExtensions(),
        );
    }
  }

  /**
   * Explorador de pruebas, con el número de pruebas en rojo como insignia.
   *
   * La insignia sólo aparece cuando hay fallos: un contador permanente de "cuántas pruebas hay"
   * no cambia ninguna decisión, y uno de "cuántas fallan" las cambia todas.
   */
  private testsButton(): HTMLElement {
    const failed = this.testsView.failedCount();

    return this.activityEntry(
      'tests',
      failed > 0 ? `Explorador de pruebas — ${failed} en rojo` : 'Explorador de pruebas',
      'flask',
      this.sidebarView === 'tests',
      () => this.showTests(),
      failed > 0 ? el('span', { className: 'activity-count danger', text: failed > 99 ? '99+' : String(failed) }) : null,
    );
  }

  /** NuGet, con el número de paquetes con aviso de seguridad como insignia. */
  private nugetButton(): HTMLElement {
    const vulnerable = this.nuget.vulnerableCount();

    return this.activityEntry(
      'nuget',
      vulnerable > 0 ? `Paquetes NuGet — ${vulnerable} con aviso de seguridad` : 'Paquetes NuGet',
      'package',
      this.sidebarView === 'nuget',
      () => this.showNuGet(),
      vulnerable > 0
        ? el('span', { className: 'activity-count danger', text: vulnerable > 99 ? '99+' : String(vulnerable) })
        : null,
    );
  }

  /** Control de código fuente, con el número de archivos con cambios como insignia. */
  private sourceControlButton(changes: number): HTMLElement {
    return this.activityEntry(
      'git',
      changes > 0 ? `Control de código fuente — ${changes} cambio(s)` : 'Control de código fuente',
      'source-control',
      this.sidebarView === 'git',
      () => this.showGit(),
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

    const node = this.activityEntry('ai', state.title, 'sparkles', this.sidebarView === 'ai' && state.navigates, () => {
      // Deshabilitado: se bloquea la navegación y no se hace absolutamente nada.
      if (!state.navigates) return;
      this.showAi();
    });

    // El estado atenuado lo decide `aiEntryState` (ADR-023) y trae su propia clase: se aplica
    // encima, conservando la marca de activa que haya puesto `activityEntry`.
    node.className = `${state.className}${node.classList.contains('active') ? ' active' : ''}`;
    node.setAttribute('aria-disabled', String(state.disabled));

    return node;
  }

  /** Deja visible una sola vista de la barra lateral: comparten contenedor. */
  private showSidebar(view: SidebarView): void {
    this.sidebarView = view;
    this.explorer.setVisible(view === 'explorer');
    this.searchView.setVisible(view === 'search');
    this.gitView.setVisible(view === 'git');
    this.nuget.setVisible(view === 'nuget');
    this.efcoreView.setVisible(view === 'efcore');
    this.containersView.setVisible(view === 'containers');
    this.testsView.setVisible(view === 'tests');
    this.extensionsView.setVisible(view === 'extensions');
    this.settingsView.setVisible(view === 'settings');
    this.aiChat.setVisible(view === 'ai');
    this.renderActivityBar();
  }

  private showGit(): void {
    this.showSidebar('git');
  }

  /**
   * Abre la búsqueda y deja el cursor en la caja.
   *
   * Con una selección viva en el editor, se busca eso: es lo que hace cualquier IDE con
   * `Ctrl+Shift+F`, y teclear otra vez lo que ya está seleccionado no lo hace nadie.
   */
  private showSearch(): void {
    this.showSidebar('search');

    const selection = this.editor.currentSelection();
    if (selection !== null) this.searchView.searchFor(selection.text);

    this.searchView.focusInput();
  }

  private showEfCore(): void {
    this.showSidebar('efcore');
  }

  private showContainers(): void {
    this.showSidebar('containers');
  }

  private showTests(): void {
    this.showSidebar('tests');
  }

  private showExtensions(): void {
    this.showSidebar('extensions');
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
      action('flask', `Ejecutar pruebas (${modifier}+Shift+T)`, () => this.testsView.runAll()),
      this.tunnelButton(),
    );
  }

  /**
   * Botón del túnel público.
   *
   * Con el túnel abierto, el botón cambia de significado: pasa a decir la URL y a cerrarlo. Es la
   * misma pieza porque es el mismo estado, y tener dos botones —uno para abrir y otro para cerrar—
   * obliga a mirar cuál está activo.
   */
  private tunnelButton(): HTMLElement {
    const open = this.tunnel !== null;
    const url = this.tunnel?.url ?? null;

    const label = open
      ? url === null
        ? 'Abriendo el túnel…'
        : `Túnel público en ${url} — clic para cerrarlo`
      : 'Crear túnel público hacia el puerto de la aplicación';

    return el(
      'button',
      {
        className: `icon-btn${open ? ' active' : ''}`,
        title: label,
        attrs: { 'aria-label': label },
        on: { click: () => void (open ? this.stopTunnel() : this.startTunnel()) },
      },
      icon('tunnel', { size: 15 }),
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
    // El emulador de terminal usa la misma tipografía que el editor: el código que se pega en una
    // y se lee en el otro tiene que verse igual.
    this.panel.applyTerminalSettings(this.settings.fontFamily, this.settings.fontSize);
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

    // Reordenar la barra: se repinta desde lo que ha confirmado el proceso principal, no desde lo
    // que se le mandó. Sin esto, soltar un icono no movía nada a la vista hasta el siguiente
    // repintado por otro motivo, y parecía que el arrastre no había funcionado.
    if (patch.activityBar !== undefined) this.renderActivityBar();

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

  /**
   * Relee el contexto del autocompletado de la terminal.
   *
   * Se pide entero al proceso principal (programas, contenedores, imágenes y scripts de npm) y se
   * guarda aquí: el motor de sugerencias es puro y no puede consultar nada, así que lo que no esté
   * en este objeto no se puede sugerir. Se refresca al abrir una solución y al mostrar la
   * terminal, nunca por pulsación de tecla: cada llamada lanza un `docker ps`.
   */
  private async refreshTerminalContext(): Promise<void> {
    try {
      const context = await window.dotforge.terminal.context();

      this.allowedCommands = context.programs;
      this.containers = context.containers;
      this.images = context.images;
      this.npmScripts = context.npmScripts;
      this.panel.setAllowedCommands(context.programs);
    } catch {
      // Sin contexto se sigue autocompletando lo que no depende de él (git, dotnet).
    }

    // El directorio va aparte: es barato, no depende de Docker y tiene que llegar aunque la
    // consulta de arriba se caiga. Si el contexto y el prompt compartieran `try`, quedarse sin
    // Docker dejaría el prompt en blanco, que es peor que quedarse sin autocompletado.
    try {
      this.panel.setTerminalCwd(await window.dotforge.terminal.cwd());
    } catch {
      // Sin ruta, el prompt se queda con la que tuviera: es sólo presentación.
    }
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

    // Reiniciar lo que se estaba depurando vuelve a depurarlo. Relanzarlo como una tarea normal
    // dejaría los breakpoints sin enganchar y el usuario no habría pedido eso.
    if (service.isDebug) {
      await window.dotforge.debug.stop().catch(() => undefined);
      this.panel.registerService(label, { projectPath: project.path, projectKind: project.kind });
      this.panel.startDebugChannel(label, `dotnet run --project ${project.path} (con depurador)`);

      try {
        await window.dotforge.debug.start({
          projectPath: project.path,
          stopAtEntry: false,
          breakpoints: this.debug.allBreakpoints(),
        });
      } catch (error) {
        this.notify(`No se ha podido reiniciar la depuración de ${label}: ${this.messageOf(error)}`, 'error');
      }
      return;
    }
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

  /**
   * Comprobación manual de actualizaciones.
   *
   * A diferencia de la automática, ésta **siempre** contesta algo: quien pulsa "Buscar ahora"
   * espera una respuesta, y "ya estás en la última versión" es una respuesta.
   */
  private async checkForUpdates(): Promise<void> {
    try {
      const state = await window.dotforge.updates.check(true);
      this.updateCard.setState(state);
      if (this.sidebarView === 'settings') this.settingsView.render();

      if (state.status === 'error') this.notify(state.message ?? 'No se ha podido comprobar.', 'warn');
      else if (state.status === 'up-to-date') this.notify(state.message ?? 'Estás en la última versión.', 'ok');
      else if (state.version !== null) this.notify(`Hay una versión nueva: v${state.version}.`, 'ok');
    } catch (error) {
      this.notify(`No se ha podido comprobar si hay actualizaciones: ${this.messageOf(error)}`, 'warn');
    }
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
        id: 'file.open-solution',
        icon: 'solution',
        title: 'Abrir solución…',
        group: 'Archivo',
        keybinding: `${modifier}+Shift+O`,
        run: () => void this.openSolutionDialog(),
      },
      {
        id: 'file.close-workspace',
        icon: 'x',
        title: 'Cerrar la solución',
        group: 'Archivo',
        run: () => void this.closeWorkspace(),
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
        /**
         * Ejecutar pruebas pasa por el explorador y no por el runner de tareas.
         *
         * Es el mismo `dotnet test`, pero con el logger TRX puesto: así la ejecución deja
         * resultados —qué prueba ha fallado, con qué mensaje y en qué línea— en vez de sólo un
         * volcado de texto en la salida.
         */
        id: 'build.test',
        icon: 'flask',
        title: 'Ejecutar pruebas',
        group: 'Compilar',
        keybinding: `${modifier}+Shift+T`,
        run: () => this.testsView.runAll(),
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
        id: 'view.extensions',
        icon: 'puzzle',
        title: 'Extensiones de Open VSX',
        group: 'Ver',
        run: () => this.showExtensions(),
      },
      {
        id: 'update.check',
        icon: 'download',
        title: 'Buscar actualizaciones de DotForge',
        group: 'Ayuda',
        run: () => void this.checkForUpdates(),
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
        id: 'view.containers',
        icon: 'package',
        title: 'Contenedores y Docker Compose',
        group: 'Ver',
        keybinding: `${modifier}+Shift+K`,
        run: () => this.showContainers(),
      },
      {
        id: 'docker.compose-up',
        icon: 'play',
        title: 'Docker: levantar los servicios del compose',
        group: 'Docker',
        run: () => {
          this.showContainers();
          void this.containersView.composeUp();
        },
      },
      {
        id: 'docker.compose-down',
        icon: 'stop',
        title: 'Docker: bajar los servicios del compose',
        group: 'Docker',
        run: () => {
          this.showContainers();
          void this.containersView.composeDown();
        },
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
        run: () => {
          this.panel.show('terminal');
          // El autocompletado sugiere contenedores e imágenes: se refrescan al abrir la terminal,
          // que es cuando el usuario puede haber levantado algo desde fuera del IDE.
          void this.refreshTerminalContext();
        },
      },
      {
        id: 'terminal.new',
        icon: 'plus',
        title: 'Nueva terminal',
        group: 'Ver',
        run: () => {
          this.panel.show('terminal');
          void this.panel.openTerminal(defaultProfileId(this.info?.platform ?? 'win32'));
        },
      },
      {
        id: 'view.logs',
        icon: 'history',
        title: 'Registro de la aplicación',
        group: 'Ver',
        keybinding: `${modifier}+Shift+L`,
        run: () => this.panel.show('logs'),
      },
      {
        id: 'view.tests',
        icon: 'flask',
        title: 'Explorador de pruebas',
        group: 'Ver',
        keybinding: `${modifier}+Shift+Y`,
        run: () => this.showTests(),
      },
      {
        id: 'tests.run-all',
        icon: 'play',
        title: 'Pruebas: ejecutar todas',
        group: 'Pruebas',
        run: () => this.testsView.runAll(),
      },
      {
        id: 'tests.run-file',
        icon: 'flask',
        title: 'Pruebas: ejecutar las del archivo actual',
        group: 'Pruebas',
        run: () => {
          const tab = this.editor.activeTab();
          if (!tab) {
            this.notify('Abre el archivo de pruebas que quieras ejecutar.', 'warn');
            return;
          }
          this.testsView.runFile(tab.path);
        },
      },
      {
        id: 'view.metrics',
        icon: 'gauge',
        title: 'Métricas de rendimiento',
        group: 'Ver',
        run: () => {
          this.panel.show('metrics');
          void this.metricsView.refresh();
        },
      },
      {
        id: 'tunnel.create',
        icon: 'tunnel',
        title: 'Crear túnel público hacia el puerto local',
        group: 'Ejecutar',
        run: () => void this.startTunnel(),
      },
      {
        id: 'tunnel.stop',
        icon: 'stop',
        title: 'Cerrar el túnel público',
        group: 'Ejecutar',
        run: () => void this.stopTunnel(),
      },
      {
        id: 'nuget.audit',
        icon: 'shield',
        title: 'NuGet: buscar vulnerabilidades conocidas',
        group: 'Seguridad',
        run: () => {
          this.showNuGet();
          void this.nuget.audit();
        },
      },
      {
        id: 'architecture.check',
        icon: 'hexagon',
        title: 'Revisar las reglas de arquitectura',
        group: 'Compilar',
        run: () => {
          this.lintArchitecture();
          this.panel.show('problems');
          this.notify(
            this.architectureIssues.length === 0
              ? 'Arquitectura correcta: ninguna dependencia prohibida.'
              : `${this.architectureIssues.length} aviso(s) de arquitectura.`,
            this.architectureIssues.length === 0 ? 'ok' : 'warn',
          );
        },
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
      // Los dos temas por separado, además del conmutador: en un menú desplegable "cambiar tema" no
      // dice a cuál se va, y hay que abrirlo dos veces para averiguarlo.
      {
        id: 'view.theme-dark',
        title: 'Tema oscuro',
        group: 'Ver',
        icon: 'moon',
        run: () => void this.applySettings({ theme: 'dotforge-dark' }),
      },
      {
        id: 'view.theme-light',
        title: 'Tema claro',
        group: 'Ver',
        icon: 'sun',
        run: () => void this.applySettings({ theme: 'dotforge-light' }),
      },
      {
        id: 'view.http',
        icon: 'exchange',
        title: 'Cliente HTTP (.http / .rest)',
        group: 'Ver',
        run: () => this.panel.show('http'),
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
        id: 'search.findInFiles',
        icon: 'search',
        title: 'Buscar en los archivos',
        group: 'Editar',
        keybinding: `${modifier}+Shift+F`,
        run: () => this.showSearch(),
      },
      {
        id: 'edit.find-in-files',
        icon: 'search',
        // El nombre dice lo que hace: filtra el árbol por **nombre de archivo**. Es otra cosa que
        // buscar dentro del contenido, y por eso conserva su comando y su sitio; lo que cambió en
        // la Fase 20 es que `Ctrl+Shift+F` pasa a la búsqueda de contenido, que es donde lo busca
        // quien viene de cualquier otro editor.
        title: 'Buscar archivos por nombre en el explorador',
        group: 'Editar',
        keybinding: `${modifier}+P`,
        run: () => {
          this.showExplorer();
          this.explorer.focusFilter();
        },
      },
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
        id: 'ai.openClaudeTerminal',
        icon: 'terminal',
        title: 'Abrir Claude Code en Terminal',
        group: 'IA',
        keybinding: `${modifier}+Shift+C`,
        // No hay host de extensiones ni webview detrás: es un perfil más del catálogo de la
        // terminal, corriendo en el PTY sobre la solución abierta (ADR-062). Si `claude` no está
        // instalado, el aviso que sale de `terminal:create` trae la orden de instalación dentro.
        run: () => void this.panel.openOrFocusTerminal('claude'),
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
        id: 'help.docs',
        icon: 'info',
        title: 'Documentación de la solución abierta',
        group: 'Ayuda',
        run: () => void this.openSolutionDocs(),
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
  // Linter de arquitectura
  // -------------------------------------------------------------------------------------------

  /**
   * Comprueba las reglas de la arquitectura detectada y publica los avisos.
   *
   * Se ejecuta al abrir o recargar la solución, y al guardar un archivo de C#. No hace falta más:
   * las referencias de proyecto sólo cambian al tocar un `.csproj`, y los `using` de un archivo,
   * al guardarlo.
   *
   * Los avisos van al panel de problemas y al margen del editor, pero **nunca** como errores: una
   * violación de arquitectura no impide compilar, y marcarla en rojo junto a los errores reales
   * del compilador acabaría enseñando a ignorar los dos.
   */
  private lintArchitecture(): void {
    if (!this.solution) {
      this.architectureIssues = [];
      this.panel.setArchitectureDiagnostics([]);
      return;
    }

    const solutionIssues = checkSolution(this.solution).map((violation) => toDiagnostic(violation));

    // Los `using` se comprueban sobre lo que hay abierto: es lo único que se puede leer sin ir
    // al disco archivo por archivo, y es donde el aviso llega a tiempo.
    const fileIssues = this.editor
      .listTabs()
      .filter((tab) => tab.languageId === 'csharp')
      .flatMap((tab) => checkUsings(this.solution, tab.path, tab.model.getValue()))
      .map((violation) => toDiagnostic(violation));

    this.architectureIssues = [...solutionIssues, ...fileIssues];
    this.panel.setArchitectureDiagnostics(this.architectureIssues);
    this.applyArchitectureMarkers();
    this.renderActivityBar();
  }

  /** Pinta los avisos de arquitectura en el margen del editor, sin pisar los del compilador. */
  private applyArchitectureMarkers(): void {
    const monaco = getMonaco();
    const byPath = new Map<string, MonacoApi.editor.IMarkerData[]>();

    for (const issue of this.architectureIssues) {
      if (!issue.file) continue;

      const markers = byPath.get(issue.file) ?? [];
      markers.push({
        severity: monaco.MarkerSeverity.Warning,
        message: `${issue.code}: ${issue.message}`,
        startLineNumber: Math.max(issue.line, 1),
        startColumn: 1,
        endLineNumber: Math.max(issue.line, 1),
        endColumn: 200,
        source: 'DotForge',
      });
      byPath.set(issue.file, markers);
    }

    this.editor.setArchitectureMarkers(byPath);
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
  // -------------------------------------------------------------------------------------------
  // Túnel público
  // -------------------------------------------------------------------------------------------

  /**
   * Puerto que se va a publicar.
   *
   * Se toma del proceso que esté corriendo y ya haya anunciado su URL: publicar el puerto
   * equivocado da un túnel que responde 502 y diez minutos de desconcierto. Si no hay ninguno, se
   * pregunta, porque el usuario puede tener la aplicación arrancada desde fuera del IDE.
   */
  private tunnelPort(): number | null {
    const service = this.panel.services().find((entry) => entry.url !== null);
    const detected = service?.url === undefined || service.url === null ? null : portOf(service.url);

    const answer = window.prompt(
      'Puerto local que quieres publicar en internet:',
      detected ?? '5000',
    );
    if (answer === null) return null;

    const port = Number.parseInt(answer.trim(), 10);
    if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
      this.notify(`Puerto no válido: ${answer}`, 'warn');
      return null;
    }

    return port;
  }

  private async startTunnel(): Promise<void> {
    if (this.tunnel !== null) return;

    let tools: TunnelTool[];
    try {
      tools = await window.dotforge.tunnel.tools();
    } catch (error) {
      this.notify(`No se ha podido comprobar las herramientas de túnel: ${this.messageOf(error)}`, 'error');
      return;
    }

    const tool = tools[0];
    if (tool === undefined) {
      // Ninguna instalada: se explica y se da la orden, como con `dotnet-ef` o con Docker.
      this.notify(
        `No hay ninguna herramienta de túnel instalada. Instala una: ${TUNNEL_TOOLS.map(
          (entry) => entry.install,
        ).join('  ·  ')}`,
        'warn',
      );
      return;
    }

    const port = this.tunnelPort();
    if (port === null) return;

    try {
      const task = await window.dotforge.tunnel.start(tool, port);

      this.tunnelScanner.reset();
      this.tunnel = { taskId: task.taskId, tool, port, url: null };
      this.panel.show('output');
      this.notify(`Abriendo un túnel con ${tunnelInfo(tool).label} hacia el puerto ${port}. ${TUNNEL_WARNING}`, 'info');
    } catch (error) {
      this.notify(`No se ha podido abrir el túnel: ${this.messageOf(error)}`, 'error');
    } finally {
      this.renderTitlebarActions();
    }
  }

  private async stopTunnel(): Promise<void> {
    const tunnel = this.tunnel;
    if (tunnel === null) return;

    await window.dotforge.dotnet.cancelTask(tunnel.taskId);
    this.notify('Túnel cerrado.', 'ok');
  }

  /** Reconoce la URL pública en la salida del túnel. Llega una sola vez y a mitad del chorro. */
  private noteTunnelOutput(taskId: string, chunk: string): void {
    if (this.tunnel === null || this.tunnel.taskId !== taskId) return;

    const url = this.tunnelScanner.push(chunk);
    if (url === null) return;

    this.tunnel = { ...this.tunnel, url };
    this.renderTitlebarActions();
    this.notify(`Túnel público: ${url}`, 'ok');
  }

  private registerTestFeatures(): void {
    const monaco = getMonaco();
    const editor = this.editor.getEditor();
    if (!editor) return;

    const runCommand = editor.addCommand(0, (_context, id: unknown) => {
      const test = this.testsView.all().find((candidate) => candidate.id === String(id));
      if (test) this.testsView.runTest(test);
    });

    const debugCommand = editor.addCommand(0, (_context, line: unknown) => {
      void this.debugTestAtLine(Number(line));
    });

    /**
     * Lentes sobre `[Fact]` y `[Theory]`.
     *
     * Se calculan sobre el texto del modelo y **no** sobre la lista descubierta: la lente tiene que
     * aparecer en la prueba que se acaba de escribir, antes de guardar y sin volver a recorrer el
     * disco. Es el mismo motivo por el que las lentes de endpoints se calculan por texto (ADR-027).
     */
    monaco.languages.registerCodeLensProvider('csharp', {
      provideCodeLenses: (model) => {
        const path = model.uri.fsPath === '' ? model.uri.path : model.uri.fsPath;
        const tests = findTests(model.getValue(), path);

        return {
          lenses: tests.flatMap((test) => {
            const range = {
              startLineNumber: test.line,
              startColumn: 1,
              endLineNumber: test.line,
              endColumn: 1,
            };

            return [
              {
                id: `test-run-${test.id}`,
                range,
                ...(runCommand === null
                  ? {}
                  : { command: { id: runCommand, title: '▶ Ejecutar prueba', arguments: [test.id] } }),
              },
              {
                id: `test-debug-${test.id}`,
                range,
                ...(debugCommand === null
                  ? {}
                  : { command: { id: debugCommand, title: 'Depurar', arguments: [test.methodLine] } }),
              },
            ];
          }),
          dispose: () => undefined,
        };
      },
    });
  }

  /**
   * Depura la prueba de una línea.
   *
   * NetCoreDbg lanza el ejecutable de un proyecto, y un proyecto de pruebas no tiene uno propio:
   * lo que se depura de verdad es el runner. Mientras eso no esté resuelto, la acción hace lo
   * honesto —poner un punto de interrupción en la prueba y ejecutarla— en vez de fingir una
   * sesión de depuración que no va a parar en ninguna parte.
   */
  private async debugTestAtLine(line: number): Promise<void> {
    const tab = this.editor.activeTab();
    if (!tab) return;

    const test = findTests(tab.model.getValue(), tab.path).find((candidate) => candidate.methodLine === line);
    if (!test) return;

    await this.toggleBreakpoint(tab.path, test.methodLine);
    this.notify(
      `Punto de interrupción en ${test.method}. Se ejecuta la prueba con el depurador escuchando.`,
      'info',
    );

    const discovered = this.testsView.all().find((candidate) => candidate.id === test.id);
    this.testsView.runTest(discovered ?? test);
  }

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

    // La descarga de una actualización avanza sola: su progreso llega como evento, no como
    // respuesta a nada que el renderer haya pedido.
    window.dotforge.events.onUpdateState((state) => {
      this.updateCard.setState(state);
      if (this.sidebarView === 'settings') this.settingsView.render();
    });

    window.dotforge.events.onWorkspaceChanged((solution) => this.applySolution(solution));

    // Los resultados de la búsqueda llegan por lotes mientras el recorrido sigue: nadie está
    // esperando esta respuesta, y por eso es un evento y no el valor de `search.inFiles`.
    window.dotforge.events.onSearchProgress((progress) => this.searchView.onProgress(progress));

    // Salida y final de las pseudoterminales. Llegan por evento porque un intérprete escupe
    // cuando quiere: el prompt aparece antes de que nadie haya escrito nada.
    window.dotforge.events.onTerminalData(({ terminalId, data }) => this.panel.writeTerminal(terminalId, data));
    window.dotforge.events.onTerminalExit(({ terminalId, exitCode }) =>
      this.panel.noteTerminalExit(terminalId, exitCode),
    );

    window.dotforge.events.onTaskStarted((task) => {
      this.panel.taskStarted(task);
      this.renderStatus();
      this.startupBar.render();
    });

    window.dotforge.events.onTaskOutput((output) => {
      this.panel.append(output.chunk, output.stream, output.taskId);
      // La URL pública del túnel llega en una línea cualquiera de su salida.
      this.noteTunnelOutput(output.taskId, output.chunk);
    });

    window.dotforge.events.onTaskExit((exit) => {
      this.panel.taskFinished(exit);
      // Si la tarea era una operación de EF Core o de Docker, su panel se relee solo.
      // La instalación de un paquete en varios proyectos encadena una tarea por proyecto: es este
      // aviso el que la hace avanzar al siguiente.
      this.nuget.noteTaskExit(exit.taskId, exit.code);
      this.efcoreView.noteTaskExit(exit.taskId, exit.code);
      this.containersView.noteTaskExit(exit.taskId, exit.code);
      void this.testsView.noteTaskExit(exit.taskId);
      this.noteTunnelExit(exit.taskId);
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

        // El servidor ya puede clasificar: se le vuelven a pedir los tokens de lo que hay abierto.
        void import('./lsp-bridge.js').then(({ refreshSemanticTokens }) => refreshSemanticTokens());
      }
    });

    window.dotforge.events.onLspNotification(({ method, params }) => {
      if (method === 'textDocument/publishDiagnostics') {
        applyPublishDiagnostics(getMonaco(), params, (path, markers) => this.editor.setMarkers(path, markers));
        return;
      }

      /**
       * Roslyn avisa cuando ha terminado de cargar los proyectos.
       *
       * Hasta ese momento contesta vacío a todo, así que los archivos abiertos se quedan con los
       * colores de la gramática. Al llegar este aviso se les vuelve a pedir la clasificación.
       */
      if (method === 'workspace/projectInitializationComplete') {
        void import('./lsp-bridge.js').then(({ refreshSemanticTokens }) => refreshSemanticTokens());
      }
    });

    window.dotforge.events.onDebugState((state) => {
      this.debug.setState(state);
      if (state.status !== 'paused') this.editor.setExecutionLine(null, null);

      // El canal del proceso depurado sólo se cierra si la sesión llegó a existir: la regla es
      // pura y está probada en `debugChannelTransition`.
      const transition = debugChannelTransition(this.debugSessionActive, state.status);
      this.debugSessionActive = transition.active;
      if (transition.close !== 'none') this.panel.finishDebugChannel(transition.close === 'ok');
      if (this.panel.currentTab() === 'debug') this.panel.render();
      this.renderStatus();
      this.startupBar.render();
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
      this.panel.appendDebugOutput(text, category === 'stderr' ? 'stderr' : 'stdout');
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

    // Muestras del monitor de rendimiento. Llegan cada pocos segundos mientras dure la sesión.
    window.dotforge.events.onMetricsSample(({ state, samples, at }) => {
      this.metricsView.applyEvent(state, samples, at);
    });

    /**
     * Cerrar la ventana con cambios sin guardar.
     *
     * Antes esto sólo llamaba a `preventDefault()`, y en Electron eso **no** enseña ningún diálogo:
     * Chromium tiene el suyo desactivado, así que el aspa de la ventana dejaba de funcionar y no
     * aparecía nada que explicase por qué. El IDE se quedaba, a ojos del usuario, colgado.
     *
     * Ahora se para el cierre, se pregunta con el diálogo propio —que es asíncrono y no bloquea el
     * renderer— y se vuelve a cerrar con el pestillo `closing` puesto para no volver a preguntar.
     */
    // Cerrar la ventana cierra las terminales. En macOS se puede cerrar la ventana sin salir de la
    // aplicación, y ahí el `before-quit` del proceso principal no llega a ejecutarse.
    window.addEventListener('pagehide', () => this.panel.disposeTerminals());

    window.addEventListener('beforeunload', (event) => {
      if (this.closing || !this.editor.hasDirtyTabs()) return;

      event.preventDefault();
      event.returnValue = '';
      void this.confirmClose();
    });
  }

  /** El proceso del túnel ha muerto: se cierra el estado y se repinta el botón. */
  private noteTunnelExit(taskId: string): void {
    if (this.tunnel === null || this.tunnel.taskId !== taskId) return;

    this.tunnel = null;
    this.tunnelScanner.reset();
    this.renderTitlebarActions();
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
        // El intérprete tiene que enterarse del tamaño nuevo: si no, sigue partiendo las líneas
        // donde las partía antes, que es el defecto que delata a una terminal mal integrada.
        this.panel.fitTerminal();
      },
      'y',
    );

    // Y también al cambiar el tamaño de la ventana.
    window.addEventListener('resize', () => this.panel.fitTerminal());
  }
}

/**
 * Violación de arquitectura como diagnóstico del panel de problemas.
 *
 * Se reutiliza `BuildDiagnostic` a propósito: para quien lo lee, un aviso de arquitectura es un
 * problema más de la solución, y compartir el modelo hace que se pinte, se ordene y se abra igual
 * que los del compilador sin escribir una segunda vista.
 */
function toDiagnostic(violation: ArchitectureViolation): BuildDiagnostic {
  return {
    file: violation.file,
    line: violation.line,
    column: violation.column,
    severity: violation.severity,
    code: violation.code,
    message: violation.message,
    project: violation.project,
  };
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
