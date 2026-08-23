/**
 * Panel inferior: salida, terminal, problemas y depuración.
 *
 * Dos ideas gobiernan este archivo:
 *
 * 1. **Un canal por proceso.** Arrancar una API y una UI a la vez y mezclar sus dos logs en un
 *    único buffer hace ilegibles los dos. Cada proceso lanzado desde el selector de inicio tiene
 *    su canal, con su nombre, su estado y el puerto en el que escucha.
 * 2. **La salida se añade, no se repinta.** El panel se redibujaba entero por cada trozo de
 *    salida; con un `dotnet watch` escupiendo líneas eso repintaba miles de nodos por segundo y,
 *    peor, destruía el input de la terminal mientras se escribía en él. Ahora se añade sólo la
 *    línea nueva al log visible.
 */
import type { BuildDiagnostic, DotnetTaskExit, DotnetTaskStarted } from '../../shared/contracts.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { detectListeningUrl, portOf } from '../run-output.js';
import {
  applySuggestion,
  caretAfterApply,
  ghostText,
  suggest,
  splitLine,
  type SuggestContext,
  type Suggestion,
} from '../terminal-suggest.js';

const MAX_OUTPUT_LINES = 5000;

/** Cuántas sugerencias se listan en el menú. Más que esto ya no se lee: se ojea. */
const MAX_SUGGESTIONS = 8;

export type PanelTab = 'output' | 'terminal' | 'problems' | 'debug';

export interface PanelHost {
  openDiagnostic(diagnostic: BuildDiagnostic): void;
  cancelTask(taskId: string): void;
  runCommand(line: string): void;
  renderDebug(container: HTMLElement): void;
  /** Contexto para el autocompletado: ramas de git y proyectos de la solución. */
  suggestContext(): SuggestContext;
  /** Abre una URL en el navegador del sistema. */
  openUrl(url: string): void;
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

interface Line {
  text: string;
  kind: LineKind;
}

type ChannelStatus = 'idle' | 'running' | 'ok' | 'failed';

interface Channel {
  id: string;
  label: string;
  /** `build` es el canal por defecto; `process` es un proyecto arrancado. */
  kind: 'build' | 'process';
  lines: Line[];
  taskId: string | null;
  url: string | null;
  status: ChannelStatus;
}

const BUILD_CHANNEL = 'build';
const TERMINAL_CHANNEL = 'terminal';

export class PanelView {
  private tab: PanelTab = 'output';
  private diagnostics: BuildDiagnostic[] = [];
  private runningTasks = new Map<string, DotnetTaskStarted>();
  private collapsed = false;

  /** Canales de salida. El de build siempre existe; los de proceso se crean al arrancar. */
  private readonly channels = new Map<string, Channel>([
    [BUILD_CHANNEL, { id: BUILD_CHANNEL, label: 'Compilación', kind: 'build', lines: [], taskId: null, url: null, status: 'idle' }],
    [TERMINAL_CHANNEL, { id: TERMINAL_CHANNEL, label: 'Terminal', kind: 'build', lines: [], taskId: null, url: null, status: 'idle' }],
  ]);

  private activeChannel = BUILD_CHANNEL;

  /** Ruta de cada tarea a su canal. Se rellena al arrancar la tarea. */
  private readonly taskChannel = new Map<string, string>();

  /** Elemento del log visible, para poder añadir líneas sin repintar el panel entero. */
  private logElement: HTMLElement | null = null;
  private logChannelId: string | null = null;

  /** Historial de la terminal, navegable con las flechas. */
  private readonly history: string[] = [];
  private historyIndex = -1;
  private allowedCommands: string[] = [];

  /** Estado del autocompletado de la terminal. */
  private suggestions: Suggestion[] = [];
  private suggestionIndex = 0;
  private suggestMenuOpen = false;
  private terminalInput: HTMLInputElement | null = null;

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

  /** Canal visible en la pestaña de salida. */
  showChannel(channelId: string): void {
    if (!this.channels.has(channelId)) return;
    this.activeChannel = channelId;
    this.show('output');
  }

  // --- Canales -------------------------------------------------------------------------------

  private channel(id: string): Channel {
    const found = this.channels.get(id);
    if (found) return found;

    const created: Channel = { id, label: id, kind: 'process', lines: [], taskId: null, url: null, status: 'idle' };
    this.channels.set(id, created);
    return created;
  }

  /** Canales que la barra de la pestaña de salida debe ofrecer. */
  private visibleChannels(): Channel[] {
    return [...this.channels.values()].filter(
      (channel) => channel.id !== TERMINAL_CHANNEL && (channel.id === BUILD_CHANNEL || channel.lines.length > 0),
    );
  }

  /** Cierra los canales de procesos que ya han terminado. */
  clearFinishedChannels(): void {
    for (const channel of [...this.channels.values()]) {
      if (channel.kind === 'process' && channel.status !== 'running') this.channels.delete(channel.id);
    }
    if (!this.channels.has(this.activeChannel)) this.activeChannel = BUILD_CHANNEL;
    this.render();
  }

  // --- Salida --------------------------------------------------------------------------------

  clearOutput(): void {
    const channel = this.channels.get(this.tab === 'terminal' ? TERMINAL_CHANNEL : this.activeChannel);
    if (channel) channel.lines = [];
    this.render();
  }

  appendCommand(text: string): void {
    this.push(BUILD_CHANNEL, text, 'command');
  }

  /**
   * Salida de una tarea. `taskId` decide el canal: sin él —mensajes del propio IDE— va al canal
   * de compilación, que es el que se ve por defecto.
   */
  append(text: string, stream: 'stdout' | 'stderr', taskId?: string): void {
    const channelId = (taskId ? this.taskChannel.get(taskId) : null) ?? BUILD_CHANNEL;

    for (const line of text.split(/\r?\n/)) {
      if (line === '') continue;

      // Se conserva la **primera** URL anunciada: Kestrel escribe primero la del perfil (https) y
      // después la de respaldo (http), y quedarse con la última enseñaría un puerto que no es el
      // que abre `dotnet run`. Al rearrancar la tarea, el canal vuelve a empezar con url = null.
      const url = detectListeningUrl(line);
      if (url) {
        const channel = this.channel(channelId);
        if (channel.url === null) {
          channel.url = url;
          this.renderChannelBar();
        }
      }

      this.push(channelId, line, stream === 'stderr' ? 'error' : this.classify(line));
    }
  }

  private classify(line: string): LineKind {
    if (/\b(error|Error)\b/.test(line)) return 'error';
    if (/(Build succeeded|Compilación correcta|Passed!|Correctas!)/.test(line)) return 'ok';
    return 'plain';
  }

  private push(channelId: string, text: string, kind: LineKind): void {
    const channel = this.channel(channelId);
    const line: Line = { text, kind };

    channel.lines.push(line);
    if (channel.lines.length > MAX_OUTPUT_LINES) {
      channel.lines.splice(0, channel.lines.length - MAX_OUTPUT_LINES);
      // Se ha recortado por arriba: el DOM ya no coincide con el buffer y hay que repintarlo.
      if (this.isVisibleChannel(channelId)) this.render();
      return;
    }

    // Camino rápido: añadir sólo el nodo nuevo al log que ya está en pantalla.
    if (this.isVisibleChannel(channelId) && this.logElement) {
      this.logElement.appendChild(el('div', { className: LINE_CLASS[kind], text }));
      this.logElement.scrollTop = this.logElement.scrollHeight;
    }
  }

  private isVisibleChannel(channelId: string): boolean {
    if (this.collapsed) return false;
    if (this.tab === 'terminal') return channelId === TERMINAL_CHANNEL && this.logChannelId === TERMINAL_CHANNEL;
    if (this.tab === 'output') return channelId === this.activeChannel && this.logChannelId === channelId;
    return false;
  }

  // --- Tareas --------------------------------------------------------------------------------

  /** Marca una tarea como propia de la terminal, para que su salida vaya a ese canal. */
  attachTerminalTask(taskId: string): void {
    this.taskChannel.set(taskId, TERMINAL_CHANNEL);
  }

  taskStarted(task: DotnetTaskStarted): void {
    this.runningTasks.set(task.taskId, task);

    // Una tarea etiquetada es un proyecto arrancado desde el selector de inicio: canal propio.
    if (task.label) {
      const channel = this.channel(`task:${task.label}`);
      channel.label = task.label;
      channel.kind = 'process';
      channel.taskId = task.taskId;
      channel.status = 'running';
      channel.url = null;
      channel.lines = [];
      this.taskChannel.set(task.taskId, channel.id);
      this.activeChannel = channel.id;
      this.push(channel.id, `❯ ${task.command}`, 'command');
    } else if (!this.taskChannel.has(task.taskId)) {
      this.taskChannel.set(task.taskId, BUILD_CHANNEL);
      this.appendCommand(`❯ ${task.command}`);
    } else {
      this.push(this.taskChannel.get(task.taskId) ?? BUILD_CHANNEL, `❯ ${task.command}`, 'command');
    }

    this.render();
  }

  taskFinished(exit: DotnetTaskExit): void {
    this.runningTasks.delete(exit.taskId);

    const channelId = this.taskChannel.get(exit.taskId) ?? BUILD_CHANNEL;
    const channel = this.channel(channelId);
    if (channel.kind === 'process') channel.status = exit.code === 0 ? 'ok' : 'failed';

    // Los diagnósticos sólo tienen sentido si la tarea los produjo; una tarea de terminal no.
    if (exit.diagnostics.length > 0 || channelId === BUILD_CHANNEL) this.diagnostics = exit.diagnostics;

    const seconds = (exit.durationMs / 1000).toFixed(1);
    this.push(
      channelId,
      exit.code === 0 ? `✓ Terminado en ${seconds} s` : `✗ Terminado con código ${exit.code} en ${seconds} s`,
      exit.code === 0 ? 'ok' : 'error',
    );

    this.taskChannel.delete(exit.taskId);
    this.render();
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
    this.logElement = null;
    this.logChannelId = null;

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
        return;

      case 'problems':
        content.appendChild(this.renderProblems());
        return;
    }
  }

  /** Repinta sólo la barra de canales: se llama al detectar una URL, sin tocar el log. */
  private renderChannelBar(): void {
    const existing = document.getElementById('channel-bar');
    if (!existing || this.tab !== 'output') return;

    const fresh = this.buildChannelBar();
    existing.replaceWith(fresh);
  }

  private buildChannelBar(): HTMLElement {
    const bar = el('div', { className: 'channel-bar', id: 'channel-bar' });
    const channels = this.visibleChannels();

    for (const channel of channels) {
      const chip = el(
        'button',
        {
          className: `channel-chip${channel.id === this.activeChannel ? ' active' : ''}`,
          title: channel.url ? `${channel.label} · ${channel.url}` : channel.label,
          on: {
            click: () => {
              this.activeChannel = channel.id;
              this.render();
            },
          },
        },
        channel.kind === 'process'
          ? el('span', {
              className: `channel-dot${channel.status === 'running' ? ' running' : channel.status === 'failed' ? ' failed' : ''}`,
            })
          : icon('hammer', { size: 12 }),
        el('span', { text: channel.label }),
      );

      if (channel.url) {
        const port = portOf(channel.url);
        chip.appendChild(
          el('span', {
            className: 'channel-url',
            text: port ? `:${port}` : 'abrir',
            title: `Abrir ${channel.url}`,
            on: {
              click: (event) => {
                event.stopPropagation();
                if (channel.url) this.host.openUrl(channel.url);
              },
            },
          }),
        );
      }

      bar.appendChild(chip);
    }

    return bar;
  }

  private renderOutput(): HTMLElement {
    const container = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });

    if (this.visibleChannels().length > 1) container.appendChild(this.buildChannelBar());

    const channel = this.channel(this.activeChannel);

    if (channel.lines.length === 0) {
      container.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          icon('panel-bottom', { size: 30, className: 'empty-state-icon' }),
          el('p', { text: 'Sin salida todavía' }),
          el('p', { className: 'empty-state-hint', text: 'Compila o ejecuta un proyecto para ver aquí su salida.' }),
        ),
      );
      return container;
    }

    const pre = el('pre', { className: 'output', style: { flex: '1', margin: '0', overflow: 'auto' } });
    for (const line of channel.lines) {
      pre.appendChild(el('div', { className: LINE_CLASS[line.kind], text: line.text }));
    }

    container.appendChild(pre);
    this.logElement = pre;
    this.logChannelId = channel.id;

    setTimeout(() => {
      pre.scrollTop = pre.scrollHeight;
    }, 0);

    return container;
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

  // --- Terminal asistida -------------------------------------------------------------------------

  /**
   * Terminal integrada con autocompletado.
   *
   * Sin pseudoterminal: se ejecutan comandos concretos y se muestra su salida. A cambio, se
   * conoce la línea entera mientras se escribe, que es justo lo que hace posible sugerir
   * subcomandos y ramas sin ambigüedad.
   */
  private renderTerminal(): HTMLElement {
    const container = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });
    const channel = this.channel(TERMINAL_CHANNEL);

    const log = el('pre', { className: 'output', style: { flex: '1', margin: '0', overflow: 'auto' } });

    if (channel.lines.length === 0) {
      log.append(
        el('div', { text: `Programas disponibles: ${this.allowedCommands.join(', ') || 'dotnet, git, npm'}` }),
        el('div', { text: 'Escribe "git " o "dotnet " y pulsa Tab o → para completar la sugerencia.' }),
        el('div', {
          text: 'Sin pseudoterminal: los programas interactivos (REPL, editores de consola) no funcionarán.',
        }),
      );
    } else {
      for (const line of channel.lines) {
        log.appendChild(el('div', { className: LINE_CLASS[line.kind], text: line.text }));
      }
    }

    this.logElement = log;
    this.logChannelId = TERMINAL_CHANNEL;

    const input = el('input', {
      className: 'input',
      placeholder: 'dotnet build   ·   git status   ·   ↑↓ historial   ·   Tab completa',
      attrs: { 'aria-label': 'Comando', autocomplete: 'off', spellcheck: 'false' },
    }) as HTMLInputElement;

    this.terminalInput = input;

    const wrap = el('div', { className: 'terminal-input-wrap' });
    const ghost = el('div', { className: 'terminal-ghost' });
    wrap.append(ghost, input);

    const suggestMenu = el('div', { className: 'suggest-menu', hidden: true });
    wrap.appendChild(suggestMenu);

    const refreshSuggestions = (): void => {
      const line = input.value;
      this.suggestions = line.trim() === '' && line === '' ? [] : suggest(line, this.host.suggestContext());
      this.suggestionIndex = 0;
      this.paintGhost(ghost, input.value);
      this.paintSuggestMenu(suggestMenu, input);
    };

    const accept = (): boolean => {
      const suggestion = this.suggestions[this.suggestionIndex];
      if (!suggestion) return false;

      const applied = applySuggestion(input.value, suggestion);
      input.value = applied;
      const caret = caretAfterApply(applied);
      input.setSelectionRange(caret, caret);

      this.suggestMenuOpen = false;
      refreshSuggestions();
      return true;
    };

    input.addEventListener('input', () => {
      this.suggestMenuOpen = true;
      refreshSuggestions();
    });

    input.addEventListener('keydown', (event) => {
      // Tab y flecha derecha (con el cursor al final) aceptan la sugerencia.
      if (event.key === 'Tab') {
        if (accept()) event.preventDefault();
        return;
      }

      if (event.key === 'ArrowRight') {
        const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        if (atEnd && this.suggestions.length > 0 && ghostText(input.value, this.suggestions)) {
          if (accept()) event.preventDefault();
        }
        return;
      }

      if (event.key === 'Escape') {
        if (this.suggestMenuOpen) {
          event.preventDefault();
          this.suggestMenuOpen = false;
          this.paintSuggestMenu(suggestMenu, input);
        }
        return;
      }

      if (event.key === 'Enter') {
        const line = input.value.trim();
        if (line === '') return;

        this.history.push(line);
        this.historyIndex = this.history.length;
        input.value = '';
        this.suggestMenuOpen = false;
        refreshSuggestions();
        this.host.runCommand(line);
        return;
      }

      // Con el menú abierto, las flechas navegan las sugerencias; con él cerrado, el historial.
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();

        if (this.suggestMenuOpen && this.suggestions.length > 0) {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const total = Math.min(this.suggestions.length, MAX_SUGGESTIONS);
          this.suggestionIndex = (this.suggestionIndex + delta + total) % total;
          this.paintGhost(ghost, input.value);
          this.paintSuggestMenu(suggestMenu, input);
          return;
        }

        if (event.key === 'ArrowUp') {
          if (this.historyIndex > 0) {
            this.historyIndex--;
            input.value = this.history[this.historyIndex] ?? '';
          }
        } else if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          input.value = this.history[this.historyIndex] ?? '';
        } else {
          this.historyIndex = this.history.length;
          input.value = '';
        }

        refreshSuggestions();
      }
    });

    container.append(log, el('div', { className: 'terminal-prompt' }, el('span', { className: 'caret', text: '❯' }), wrap));

    setTimeout(() => {
      input.focus();
      log.scrollTop = log.scrollHeight;
    }, 0);

    return container;
  }

  /** Pinta el texto fantasma alineado con lo ya escrito. */
  private paintGhost(ghost: HTMLElement, line: string): void {
    clear(ghost);

    const remainder = ghostText(line, this.suggestions.slice(this.suggestionIndex));
    if (!remainder) return;

    ghost.append(
      el('span', { className: 'typed', text: line }),
      el('span', { className: 'hint', text: remainder }),
      el('span', { className: 'kbd', text: 'Tab' }),
    );
  }

  private paintSuggestMenu(menu: HTMLElement, input: HTMLInputElement): void {
    clear(menu);

    const visible = this.suggestions.slice(0, MAX_SUGGESTIONS);
    // El menú sólo aparece cuando aporta algo: con una única sugerencia basta el fantasma.
    menu.hidden = !this.suggestMenuOpen || visible.length < 2;
    if (menu.hidden) return;

    // El panel puede estar bajo de altura: el menú se acota al hueco real que hay por encima del
    // prompt. Sin esto, las primeras sugerencias quedan cortadas por el borde del panel y el
    // usuario no ve justamente la que va a aceptar con Tab.
    const panelTop = byId('panel').getBoundingClientRect().top;
    const promptTop = input.getBoundingClientRect().top;
    menu.style.maxHeight = `${Math.max(96, promptTop - panelTop - 16)}px`;

    visible.forEach((suggestion, index) => {
      menu.appendChild(
        el(
          'button',
          {
            className: `suggest-item${index === this.suggestionIndex ? ' active' : ''}`,
            on: {
              // `mousedown` en vez de `click`: el click quitaría el foco del input antes de aplicar.
              mousedown: (event) => {
                event.preventDefault();
                const applied = applySuggestion(input.value, suggestion);
                input.value = applied;
                const caret = caretAfterApply(applied);
                input.setSelectionRange(caret, caret);
                this.suggestMenuOpen = false;
                menu.hidden = true;
                input.focus();
              },
            },
          },
          el('span', { className: 'suggest-value', text: suggestion.label }),
          el('span', { className: 'suggest-detail', text: suggestion.detail }),
          el('span', { className: 'suggest-kind', text: KIND_LABEL[suggestion.kind] ?? '' }),
        ),
      );
    });
  }

  /** La terminal recibe el foco cuando se abre desde la paleta o el menú. */
  focusTerminal(): void {
    this.terminalInput?.focus();
  }

  /** Texto actual de la terminal. Sólo lo usan las pruebas de humo de la interfaz. */
  terminalValue(): string {
    return this.terminalInput?.value ?? '';
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

    const running = [...this.channels.values()].filter((channel) => channel.status === 'running').length;

    tabs.append(
      makeTab(
        'output',
        'list',
        'Salida',
        running > 0 ? el('span', { className: 'count', text: String(running) }) : null,
      ),
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
          task.label ? `Detener ${task.label}` : 'Detener',
        ),
      );
    }

    tabs.append(
      el(
        'button',
        { className: 'icon-btn', title: 'Limpiar la salida visible', on: { click: () => this.clearOutput() } },
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

const KIND_LABEL: Record<Suggestion['kind'], string> = {
  program: 'programa',
  subcommand: 'comando',
  flag: 'opción',
  branch: 'rama',
  package: 'paquete',
  project: 'proyecto',
};

/** Reexportado para que las pruebas de la interfaz puedan comprobar el troceo sin DOM. */
export { splitLine };
