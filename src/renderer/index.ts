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
  LspState,
  MenuCommand,
  ProjectInfo,
  SolutionInfo,
} from '../shared/contracts.js';
import { byId, clear, el } from './dom.js';
import { applyPublishDiagnostics, reopenAll } from './lsp-bridge.js';
import { defineThemes, getMonaco, loadMonaco } from './monaco-setup.js';
import { EditorView, type OpenTab } from './views/editor.js';
import { ExplorerView } from './views/explorer.js';
import { NuGetView } from './views/nuget.js';
import { PanelView } from './views/panel.js';
import { DebugView } from './views/debug.js';
import { CommandPalette, type Command } from './views/palette.js';
import { StatusBar } from './views/statusbar.js';
import { WelcomeView } from './views/welcome.js';
import { WizardView } from './views/wizard.js';

type SidebarView = 'explorer' | 'nuget';

class DotForgeApp {
  private info: AppInfo | null = null;
  private settings: AppSettings | null = null;
  private solution: SolutionInfo | null = null;
  private lsp: LspState = { status: 'idle', server: null, version: null, message: null, progress: null };
  private cursor: { line: number; column: number } | null = null;
  private sidebarView: SidebarView = 'explorer';
  private lspProviders: MonacoApi.IDisposable | null = null;

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
  });

  private readonly palette = new CommandPalette();

  private readonly statusBar = new StatusBar({
    showProblems: () => this.panel.show('problems'),
    showOutput: () => this.panel.show('output'),
    restartLsp: () => void this.restartLsp(),
    toggleTheme: () => void this.toggleTheme(),
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

    document.body.classList.add(`platform-${this.info.platform}`);
    this.applyTheme(this.settings.theme);

    await loadMonaco();
    this.editor.mount(this.settings);
    this.attachLspProviders();

    this.renderActivityBar();
    this.renderTitlebarActions();
    this.registerCommands();
    this.installEventBridges();
    this.installKeyboardShortcuts();
    this.installResizers();

    this.welcome.render(this.info, this.settings);
    this.explorer.render();
    this.panel.render();
    this.renderStatus();

    // La lista de programas permitidos se muestra como ayuda en la terminal.
    void window.dotforge.terminal
      .allowed()
      .then((commands) => this.panel.setAllowedCommands(commands))
      .catch(() => undefined);

    // Reabre el último workspace: volver al trabajo no debería costar dos clics.
    const existing = await window.dotforge.workspace.current();
    if (existing) {
      this.applySolution(existing);
    } else {
      const recent = this.settings.recentWorkspaces[0];
      if (recent) await this.openWorkspace(recent).catch(() => undefined);
    }

    // Archivo pasado por línea de comandos (`dotforge-ide Program.cs`).
    const pending = await window.dotforge.workspace.pendingFile();
    if (pending) await this.openFile(pending);
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
      this.welcome.render(this.info, this.settings);
    } catch (error) {
      this.notify(`No se ha podido abrir ${path}: ${this.messageOf(error)}`, 'error');
    }
  }

  private applySolution(solution: SolutionInfo | null): void {
    this.solution = solution;
    this.explorer.setSolution(solution);
    this.nuget.setSolution(solution);
    this.updateTitle();

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

  private startupProject(): string | null {
    if (!this.solution) return null;
    const web = this.solution.projects.find((project) => project.isWebProject);
    const exe = this.solution.projects.find((project) => project.outputType === 'Exe' && !project.isTestProject);
    return (web ?? exe)?.path ?? null;
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

  /** Arranca una sesión de depuración sobre el proyecto de inicio. */
  private async startDebugging(): Promise<void> {
    const project = this.startupProject();
    if (!project) {
      this.notify('No hay ningún proyecto ejecutable que depurar.', 'warn');
      return;
    }

    await this.editor.saveAll();
    this.panel.show('debug');

    try {
      await window.dotforge.debug.start({
        projectPath: project,
        stopAtEntry: false,
        breakpoints: this.debug.allBreakpoints(),
      });
    } catch (error) {
      this.notify(this.messageOf(error), 'error');
    }
  }

  /** Ejecuta una línea escrita en la terminal integrada. */
  private async runTerminalCommand(line: string): Promise<void> {
    if (!this.solution) {
      this.notify('Abre una carpeta antes de usar la terminal.', 'warn');
      return;
    }

    try {
      await window.dotforge.terminal.run(line);
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
    const theme = this.settings.theme === 'dotforge-dark' ? 'dotforge-light' : 'dotforge-dark';
    this.settings = await window.dotforge.app.setSettings({ theme });
    this.applyTheme(theme);

    // Los temas de Monaco se derivan de los tokens CSS: hay que redefinirlos tras el cambio.
    defineThemes(getMonaco());
    this.editor.applySettings(this.settings);
    this.welcome.render(this.info, this.settings);
  }

  private renderActivityBar(): void {
    const bar = byId('activitybar');
    clear(bar);

    const button = (label: string, glyph: string, active: boolean, onClick: () => void): HTMLElement =>
      el('button', {
        className: `activity-item${active ? ' active' : ''}`,
        text: glyph,
        title: label,
        attrs: { 'aria-label': label },
        on: { click: onClick },
      });

    bar.appendChild(
      button('Explorador de soluciones', '⬡', this.sidebarView === 'explorer', () => this.showExplorer()),
    );
    bar.appendChild(button('Paquetes NuGet', '◆', this.sidebarView === 'nuget', () => this.showNuGet()));
    bar.appendChild(
      button('Nueva solución con el asistente', '✨', false, () => void this.wizard.open()),
    );

    bar.appendChild(el('div', { className: 'spacer' }));

    bar.appendChild(button('Paleta de comandos', '⌘', false, () => this.palette.show()));
    bar.appendChild(button('Cambiar tema', '◐', false, () => void this.toggleTheme()));
  }

  private renderTitlebarActions(): void {
    const actions = byId('titlebar-actions');
    clear(actions);

    const action = (glyph: string, title: string, onClick: () => void): HTMLElement =>
      el('button', { className: 'icon-btn', text: glyph, title, on: { click: onClick } });

    actions.appendChild(action('▶', 'Ejecutar (F5)', () => void this.runTask('run')));
    actions.appendChild(action('⟳', 'Hot Reload (dotnet watch)', () => void this.runTask('watch')));
    actions.appendChild(action('■', 'Detener (Shift+F5)', () => void this.stopTasks()));
    actions.appendChild(action('⚒', 'Compilar solución', () => void this.runTask('build')));
  }

  private showExplorer(): void {
    this.sidebarView = 'explorer';
    this.nuget.setVisible(false);
    this.explorer.setVisible(true);
    this.renderActivityBar();
  }

  private showNuGet(project?: ProjectInfo): void {
    this.sidebarView = 'nuget';
    this.explorer.setVisible(false);
    this.nuget.setVisible(true);
    this.renderActivityBar();
    if (project) this.nuget.focusProject(project);
  }

  private updateTitle(): void {
    const tab = this.editor.activeTab();
    const dirtyMark = tab?.dirty ? '● ' : '';
    const parts = [dirtyMark + (tab?.name ?? ''), this.solution?.name ?? 'Sin workspace abierto'].filter(Boolean);
    byId('titlebar-title').textContent = parts.join('  —  ');
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
      encoding: 'utf8',
      branchLabel: null,
    });
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
        title: 'Nueva solución con el asistente de arquitecturas',
        group: 'Scaffolding',
        keybinding: `${modifier}+Shift+N`,
        run: () => void this.wizard.open(),
      },
      {
        id: 'file.open-folder',
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
        title: 'Ejecutar pruebas',
        group: 'Compilar',
        keybinding: `${modifier}+Shift+T`,
        run: () => void this.runTask('test'),
      },
      {
        id: 'run.start',
        title: 'Iniciar depuración',
        group: 'Depurar',
        keybinding: 'F5',
        run: () => void this.startDebugging(),
      },
      {
        id: 'run.without-debug',
        title: 'Ejecutar sin depurar',
        group: 'Depurar',
        run: () => void this.runTask('run'),
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
        title: 'Ejecutar con Hot Reload (dotnet watch)',
        group: 'Depurar',
        keybinding: `${modifier}+F5`,
        run: () => void this.runTask('watch'),
      },
      {
        id: 'run.stop',
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
        title: 'Explorador de soluciones',
        group: 'Ver',
        keybinding: `${modifier}+Shift+E`,
        run: () => this.showExplorer(),
      },
      {
        id: 'view.nuget',
        title: 'Paquetes NuGet',
        group: 'Ver',
        keybinding: `${modifier}+Shift+U`,
        run: () => this.showNuGet(),
      },
      {
        id: 'view.problems',
        title: 'Problemas',
        group: 'Ver',
        keybinding: `${modifier}+Shift+M`,
        run: () => this.panel.show('problems'),
      },
      {
        id: 'view.terminal',
        title: 'Terminal integrada',
        group: 'Ver',
        keybinding: `${modifier}+J`,
        run: () => this.panel.show('terminal'),
      },
      { id: 'view.output', title: 'Salida', group: 'Ver', run: () => this.panel.show('output') },
      { id: 'view.toggle-theme', title: 'Cambiar tema claro/oscuro', group: 'Ver', run: () => void this.toggleTheme() },
      {
        id: 'view.command-palette',
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
        id: 'help.about',
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
  // Puentes de eventos
  // -------------------------------------------------------------------------------------------

  private installEventBridges(): void {
    window.dotforge.events.onMenuCommand((command: MenuCommand) => void this.runCommandById(command));

    window.dotforge.events.onWorkspaceChanged((solution) => this.applySolution(solution));

    window.dotforge.events.onTaskStarted((task) => {
      this.panel.taskStarted(task);
      this.renderStatus();
    });

    window.dotforge.events.onTaskOutput((output) => {
      this.panel.append(output.chunk, output.stream);
    });

    window.dotforge.events.onTaskExit((exit) => {
      this.panel.taskFinished(exit);
      this.applyBuildMarkers(exit.diagnostics);
      this.renderStatus();

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
