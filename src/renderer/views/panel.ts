/**
 * Panel inferior: salida, terminal, problemas y depuración.
 *
 * La salida se acota a un número máximo de líneas: un `dotnet watch` de horas no puede llenar la
 * memoria del renderer. Los problemas se pintan como filas clicables que llevan a la línea exacta.
 */
import type { BuildDiagnostic, DotnetTaskExit, DotnetTaskStarted } from '../../shared/contracts.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';

const MAX_OUTPUT_LINES = 5000;

export type PanelTab = 'output' | 'terminal' | 'problems' | 'debug';

export interface PanelHost {
  openDiagnostic(diagnostic: BuildDiagnostic): void;
  cancelTask(taskId: string): void;
  runCommand(line: string): void;
  renderDebug(container: HTMLElement): void;
}

type LineKind = 'plain' | 'error' | 'ok' | 'command';

const LINE_CLASS: Record<LineKind, string> = {
  plain: '',
  error: 'line-err',
  ok: 'line-ok',
  command: 'line-cmd',
};

const SEVERITY_ICON: Record<BuildDiagnostic['severity'], IconName> = {
  error: 'alert-circle',
  warning: 'alert-triangle',
  info: 'info',
};

export class PanelView {
  private tab: PanelTab = 'output';
  private lines: Array<{ text: string; kind: LineKind }> = [];
  private diagnostics: BuildDiagnostic[] = [];
  private runningTasks = new Map<string, DotnetTaskStarted>();
  private collapsed = false;

  /** Historial de la terminal, navegable con las flechas arriba y abajo. */
  private readonly history: string[] = [];
  private historyIndex = -1;
  private allowedCommands: string[] = [];

  constructor(private readonly host: PanelHost) {}

  // --- Estado -------------------------------------------------------------------------------

  currentTab(): PanelTab {
    return this.tab;
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  setTab(tab: PanelTab): void {
    this.tab = tab;
    this.collapsed = false;
    this.render();
  }

  show(tab: PanelTab): void {
    this.collapsed = false;
    byId('app').querySelector('.main')?.classList.remove('panel-collapsed');
    this.setTab(tab);
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    byId('app').querySelector('.main')?.classList.toggle('panel-collapsed', this.collapsed);
    this.render();
  }

  setAllowedCommands(commands: string[]): void {
    this.allowedCommands = commands;
  }

  // --- Salida --------------------------------------------------------------------------------

  clearOutput(): void {
    this.lines = [];
    this.render();
  }

  appendCommand(text: string): void {
    this.push(text, 'command');
  }

  append(text: string, stream: 'stdout' | 'stderr'): void {
    for (const line of text.split(/\r?\n/)) {
      if (line === '') continue;
      this.push(line, stream === 'stderr' ? 'error' : this.classify(line));
    }
  }

  private classify(line: string): LineKind {
    if (/\b(error|Error)\b/.test(line)) return 'error';
    if (/(Build succeeded|Compilación correcta|Passed!|Correctas!)/.test(line)) return 'ok';
    return 'plain';
  }

  private push(text: string, kind: LineKind): void {
    this.lines.push({ text, kind });
    if (this.lines.length > MAX_OUTPUT_LINES) {
      this.lines.splice(0, this.lines.length - MAX_OUTPUT_LINES);
    }
    if ((this.tab === 'output' || this.tab === 'terminal') && !this.collapsed) this.render();
  }

  // --- Tareas --------------------------------------------------------------------------------

  taskStarted(task: DotnetTaskStarted): void {
    this.runningTasks.set(task.taskId, task);
    this.appendCommand(`❯ ${task.command}`);
    this.renderTabs();
  }

  taskFinished(exit: DotnetTaskExit): void {
    this.runningTasks.delete(exit.taskId);
    this.setDiagnostics(exit.diagnostics);

    const seconds = (exit.durationMs / 1000).toFixed(1);
    this.push(
      exit.code === 0 ? `✓ Terminado en ${seconds} s` : `✗ Terminado con código ${exit.code} en ${seconds} s`,
      exit.code === 0 ? 'ok' : 'error',
    );

    this.renderTabs();
  }

  setDiagnostics(diagnostics: BuildDiagnostic[]): void {
    this.diagnostics = diagnostics;
    this.render();
  }

  getDiagnostics(): BuildDiagnostic[] {
    return this.diagnostics;
  }

  hasRunningTasks(): boolean {
    return this.runningTasks.size > 0;
  }

  runningTaskList(): DotnetTaskStarted[] {
    return [...this.runningTasks.values()];
  }

  // --- Render ---------------------------------------------------------------------------------

  render(): void {
    this.renderTabs();

    const content = byId('panel-content');
    clear(content);

    if (this.collapsed) return;

    switch (this.tab) {
      case 'debug': {
        const host = el('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } });
        this.host.renderDebug(host);
        content.appendChild(host);
        return;
      }

      case 'terminal':
        content.appendChild(this.renderTerminal());
        return;

      case 'output':
        content.appendChild(this.renderOutput());
        content.scrollTop = content.scrollHeight;
        return;

      case 'problems':
        content.appendChild(this.renderProblems());
        return;
    }
  }

  private renderOutput(): HTMLElement {
    if (this.lines.length === 0) {
      return el(
        'div',
        { className: 'empty-state' },
        icon('panel-bottom', { size: 30, className: 'empty-state-icon' }),
        el('p', { text: 'Sin salida todavía' }),
        el('p', { className: 'empty-state-hint', text: 'Compila o ejecuta un proyecto para ver aquí su salida.' }),
      );
    }

    const pre = el('pre', { className: 'output' });
    for (const line of this.lines) {
      pre.appendChild(el('div', { className: LINE_CLASS[line.kind], text: line.text }));
    }
    return pre;
  }

  private renderProblems(): HTMLElement {
    if (this.diagnostics.length === 0) {
      return el(
        'div',
        { className: 'empty-state' },
        icon('check', { size: 30, className: 'empty-state-icon' }),
        el('p', { text: 'Ningún problema detectado' }),
        el('p', {
          className: 'empty-state-hint',
          text: 'Los errores y advertencias de la compilación aparecerán aquí.',
        }),
      );
    }

    const container = el('div');

    for (const diagnostic of this.diagnostics) {
      const where = diagnostic.file
        ? `${diagnostic.file.split(/[\\/]/).pop()}:${diagnostic.line}:${diagnostic.column}`
        : 'solución';

      container.appendChild(
        el(
          'button',
          {
            className: 'problem',
            title: diagnostic.file ?? '',
            on: { click: () => this.host.openDiagnostic(diagnostic) },
          },
          icon(SEVERITY_ICON[diagnostic.severity], { size: 14, className: `sev ${diagnostic.severity}` }),
          el('span', {}, el('span', { className: 'code', text: `${diagnostic.code} ` }), diagnostic.message),
          el('span', { className: 'where', text: where }),
        ),
      );
    }

    return container;
  }

  /**
   * Terminal integrada.
   *
   * Sin pseudoterminal: se ejecutan comandos concretos y se muestra su salida. Se dice en la
   * propia pantalla vacía para que nadie espere un shell interactivo.
   */
  private renderTerminal(): HTMLElement {
    const container = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });

    const log = el('pre', { className: 'output', style: { flex: '1', margin: '0', overflow: 'auto' } });

    if (this.lines.length === 0) {
      log.appendChild(
        el('div', { text: `Programas disponibles: ${this.allowedCommands.join(', ') || 'dotnet, git, npm'}` }),
      );
      log.appendChild(
        el('div', {
          text: 'Sin pseudoterminal: los programas interactivos (REPL, editores de consola) no funcionarán.',
        }),
      );
    } else {
      for (const line of this.lines) {
        log.appendChild(el('div', { className: LINE_CLASS[line.kind], text: line.text }));
      }
    }

    const input = el('input', {
      className: 'input',
      placeholder: 'dotnet build   ·   git status   ·   ↑↓ historial',
      attrs: { 'aria-label': 'Comando' },
    }) as HTMLInputElement;

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const line = input.value.trim();
        if (line === '') return;

        this.history.push(line);
        this.historyIndex = this.history.length;
        input.value = '';
        this.host.runCommand(line);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (this.historyIndex > 0) {
          this.historyIndex--;
          input.value = this.history[this.historyIndex] ?? '';
        }
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          input.value = this.history[this.historyIndex] ?? '';
        } else {
          this.historyIndex = this.history.length;
          input.value = '';
        }
      }
    });

    container.append(
      log,
      el('div', { className: 'terminal-prompt' }, el('span', { className: 'caret', text: '❯' }), input),
    );

    setTimeout(() => input.focus(), 0);
    log.scrollTop = log.scrollHeight;

    return container;
  }

  private renderTabs(): void {
    const tabs = byId('panel-tabs');
    clear(tabs);

    const errors = this.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
    const warnings = this.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;

    const makeTab = (id: PanelTab, iconName: IconName, label: string, badge?: HTMLElement | null): HTMLElement =>
      el(
        'button',
        {
          className: `panel-tab${this.tab === id && !this.collapsed ? ' active' : ''}`,
          role: 'tab',
          on: { click: () => this.show(id) },
        },
        icon(iconName, { size: 14 }),
        label,
        badge ?? null,
      );

    tabs.append(
      makeTab('output', 'list', 'Salida'),
      makeTab('terminal', 'terminal', 'Terminal'),
      makeTab(
        'problems',
        'alert-circle',
        'Problemas',
        errors + warnings > 0
          ? el('span', {
              className: `count ${errors > 0 ? 'danger' : 'warning'}`,
              text: String(errors + warnings),
            })
          : null,
      ),
      makeTab('debug', 'bug', 'Depuración'),
      el('span', { className: 'spacer', style: { flex: '1' } }),
    );

    for (const task of this.runningTasks.values()) {
      tabs.appendChild(
        el(
          'button',
          {
            className: 'btn ghost small',
            title: task.command,
            on: { click: () => this.host.cancelTask(task.taskId) },
          },
          el('span', { className: 'spinner' }),
          'Detener',
        ),
      );
    }

    tabs.append(
      el(
        'button',
        { className: 'icon-btn', title: 'Limpiar salida', on: { click: () => this.clearOutput() } },
        icon('trash', { size: 14 }),
      ),
      el(
        'button',
        {
          className: 'icon-btn',
          title: this.collapsed ? 'Mostrar el panel' : 'Ocultar el panel',
          on: { click: () => this.toggleCollapsed() },
        },
        icon(this.collapsed ? 'chevron-up' : 'chevron-down', { size: 14 }),
      ),
    );
  }
}
