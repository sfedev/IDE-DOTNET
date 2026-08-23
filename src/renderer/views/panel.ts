/**
 * Panel inferior: salida de las tareas y lista de problemas.
 *
 * La salida se acota a un número máximo de líneas: un `dotnet watch` de horas no puede llenar la
 * memoria del renderer. Los problemas se pintan como botones clicables que llevan al editor.
 */
import type { BuildDiagnostic, DotnetTaskExit, DotnetTaskStarted } from '../../shared/contracts.js';
import { byId, clear, el } from '../dom.js';

const MAX_OUTPUT_LINES = 5000;

export type PanelTab = 'output' | 'problems' | 'terminal' | 'debug';

export interface PanelHost {
  openDiagnostic(diagnostic: BuildDiagnostic): void;
  cancelTask(taskId: string): void;
  runCommand(line: string): void;
  /** Pinta la vista de depuración dentro del panel. */
  renderDebug(container: HTMLElement): void;
}

export class PanelView {
  private tab: PanelTab = 'output';
  private lines: Array<{ text: string; kind: 'plain' | 'error' | 'ok' | 'command' }> = [];
  private diagnostics: BuildDiagnostic[] = [];
  private runningTasks = new Map<string, DotnetTaskStarted>();
  private collapsed = false;

  /** Historial de la terminal, navegable con las flechas arriba/abajo. */
  private readonly history: string[] = [];
  private historyIndex = -1;
  private allowedCommands: string[] = [];

  constructor(private readonly host: PanelHost) {}

  setTab(tab: PanelTab): void {
    this.tab = tab;
    this.collapsed = false;
    this.render();
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    byId('app').querySelector('.main')?.classList.toggle('panel-collapsed', this.collapsed);
    this.render();
  }

  currentTab(): PanelTab {
    return this.tab;
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  show(tab: PanelTab): void {
    this.collapsed = false;
    byId('app').querySelector('.main')?.classList.remove('panel-collapsed');
    this.setTab(tab);
  }

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

  private classify(line: string): 'plain' | 'error' | 'ok' {
    if (/\b(error|Error)\b/.test(line)) return 'error';
    if (/(Build succeeded|Compilación correcta|Passed!|Correctas!)/.test(line)) return 'ok';
    return 'plain';
  }

  private push(text: string, kind: 'plain' | 'error' | 'ok' | 'command'): void {
    this.lines.push({ text, kind });
    if (this.lines.length > MAX_OUTPUT_LINES) {
      this.lines.splice(0, this.lines.length - MAX_OUTPUT_LINES);
    }
    if ((this.tab === 'output' || this.tab === 'terminal') && !this.collapsed) this.render();
  }

  taskStarted(task: DotnetTaskStarted): void {
    this.runningTasks.set(task.taskId, task);
    this.appendCommand(`$ ${task.command}`);
    this.renderTabs();
  }

  taskFinished(exit: DotnetTaskExit): void {
    this.runningTasks.delete(exit.taskId);
    this.setDiagnostics(exit.diagnostics);

    const seconds = (exit.durationMs / 1000).toFixed(1);
    this.push(
      exit.code === 0
        ? `✓ Terminado en ${seconds} s`
        : `✗ Terminado con código ${exit.code} en ${seconds} s`,
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

  render(): void {
    this.renderTabs();

    const content = byId('panel-content');
    clear(content);

    if (this.collapsed) return;

    if (this.tab === 'debug') {
      const host = el('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } });
      this.host.renderDebug(host);
      content.appendChild(host);
      return;
    }

    if (this.tab === 'terminal') {
      content.appendChild(this.renderTerminal());
      return;
    }

    if (this.tab === 'output') {
      const pre = el('pre', { className: 'output' });
      for (const line of this.lines) {
        const className =
          line.kind === 'error' ? 'line-err' : line.kind === 'ok' ? 'line-ok' : line.kind === 'command' ? 'line-cmd' : '';
        pre.appendChild(el('div', { className, text: line.text }));
      }
      if (this.lines.length === 0) {
        pre.appendChild(el('div', { text: 'Sin salida todavía. Compila o ejecuta un proyecto (Ctrl/Cmd+Shift+B).' }));
      }
      content.appendChild(pre);
      // Auto-scroll: al compilar interesa el final, no el principio.
      content.scrollTop = content.scrollHeight;
      return;
    }

    if (this.diagnostics.length === 0) {
      content.appendChild(el('div', { className: 'empty-state', text: 'Ningún problema detectado.' }));
      return;
    }

    for (const diagnostic of this.diagnostics) {
      const symbol = diagnostic.severity === 'error' ? '✖' : diagnostic.severity === 'warning' ? '▲' : 'ℹ';
      const where = diagnostic.file
        ? `${diagnostic.file.split(/[\\/]/).pop()}:${diagnostic.line}:${diagnostic.column}`
        : 'solución';

      content.appendChild(
        el(
          'button',
          {
            className: 'problem',
            title: diagnostic.file ?? '',
            on: { click: () => this.host.openDiagnostic(diagnostic) },
          },
          el('span', { className: `sev ${diagnostic.severity}`, text: symbol }),
          el(
            'span',
            {},
            el('span', { className: 'code', text: `${diagnostic.code} ` }),
            diagnostic.message,
          ),
          el('span', { className: 'where', text: where }),
        ),
      );
    }
  }

  setAllowedCommands(commands: string[]): void {
    this.allowedCommands = commands;
  }

  /**
   * Terminal integrada.
   *
   * Sin pseudoterminal: se ejecutan comandos concretos y se muestra su salida. Se dice
   * explícitamente en la ayuda para que nadie espere un shell interactivo.
   */
  private renderTerminal(): HTMLElement {
    const container = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });

    const log = el('pre', { className: 'output', style: { flex: '1', margin: '0', overflow: 'auto' } });
    for (const line of this.lines) {
      const className =
        line.kind === 'error' ? 'line-err' : line.kind === 'ok' ? 'line-ok' : line.kind === 'command' ? 'line-cmd' : '';
      log.appendChild(el('div', { className, text: line.text }));
    }
    if (this.lines.length === 0) {
      log.appendChild(
        el('div', {
          text:
            'Terminal de comandos. Ejecuta ' +
            (this.allowedCommands.length > 0 ? this.allowedCommands.join(', ') : 'dotnet, git, npm') +
            '.',
        }),
      );
      log.appendChild(
        el('div', {
          text: 'No hay pseudoterminal: los programas interactivos (REPL, editores de consola) no funcionarán.',
        }),
      );
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

    const prompt = el(
      'div',
      { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--border-subtle)' } },
      el('span', { className: 'mono', style: { color: 'var(--accent)' }, text: '❯' }),
      input,
    );

    container.append(log, prompt);

    // El foco va al prompt en cuanto se abre la pestaña.
    setTimeout(() => input.focus(), 0);
    log.scrollTop = log.scrollHeight;

    return container;
  }

  private renderTabs(): void {
    const tabs = byId('panel-tabs');
    clear(tabs);

    const errors = this.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
    const warnings = this.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;

    const makeTab = (id: PanelTab, label: string, badge?: HTMLElement | null): HTMLElement =>
      el(
        'button',
        {
          className: `panel-tab${this.tab === id && !this.collapsed ? ' active' : ''}`,
          role: 'tab',
          on: { click: () => this.show(id) },
        },
        label,
        badge ?? null,
      );

    tabs.appendChild(makeTab('output', 'Salida'));
    tabs.appendChild(makeTab('terminal', 'Terminal'));
    tabs.appendChild(makeTab('debug', 'Depuración'));
    tabs.appendChild(
      makeTab(
        'problems',
        'Problemas',
        errors + warnings > 0
          ? el('span', {
              className: `count ${errors > 0 ? 'danger' : 'warning'}`,
              text: String(errors + warnings),
            })
          : null,
      ),
    );

    tabs.appendChild(el('span', { className: 'spacer', style: { flex: '1' } }));

    for (const task of this.runningTasks.values()) {
      tabs.appendChild(
        el(
          'button',
          {
            className: 'btn ghost',
            title: task.command,
            on: { click: () => this.host.cancelTask(task.taskId) },
          },
          el('span', { className: 'spinner' }),
          ' Detener',
        ),
      );
    }

    tabs.appendChild(
      el('button', {
        className: 'icon-btn',
        text: '⌫',
        title: 'Limpiar salida',
        on: { click: () => this.clearOutput() },
      }),
    );

    tabs.appendChild(
      el('button', {
        className: 'icon-btn',
        text: this.collapsed ? '▴' : '▾',
        title: this.collapsed ? 'Mostrar panel' : 'Ocultar panel',
        on: { click: () => this.toggleCollapsed() },
      }),
    );
  }
}
