/**
 * Vista de depuración: controles, pila de llamadas y variables.
 *
 * Los breakpoints se guardan por archivo en el renderer y se envían al adaptador al arrancar la
 * sesión y cada vez que cambian. Persistirlos aquí (y no en el adaptador) permite ponerlos y
 * quitarlos con la sesión parada, que es como se trabaja realmente.
 */
import type { DebugScope, DebugStackFrame, DebugState, DebugVariable } from '../../shared/contracts.js';
import { baseName, clear, el } from '../dom.js';

export interface DebugHost {
  openLocation(file: string, line: number): void;
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
}

interface VariableNode {
  variable: DebugVariable;
  depth: number;
  children: DebugVariable[] | null;
}

export class DebugView {
  /** Breakpoints por archivo, en números de línea 1-indexados. */
  private readonly breakpoints = new Map<string, Set<number>>();

  private state: DebugState = {
    status: 'idle',
    message: null,
    progress: null,
    threadId: null,
    version: null,
  };

  private frames: DebugStackFrame[] = [];
  private activeFrameId: number | null = null;
  private scopes: DebugScope[] = [];
  private readonly expanded = new Set<number>();
  private readonly variableCache = new Map<number, DebugVariable[]>();

  constructor(private readonly host: DebugHost) {}

  getState(): DebugState {
    return this.state;
  }

  // --- Breakpoints ---------------------------------------------------------------------------

  linesFor(file: string): number[] {
    return [...(this.breakpoints.get(file) ?? [])].sort((a, b) => a - b);
  }

  allBreakpoints(): Array<{ file: string; lines: number[] }> {
    return [...this.breakpoints.entries()]
      .filter(([, lines]) => lines.size > 0)
      .map(([file, lines]) => ({ file, lines: [...lines].sort((a, b) => a - b) }));
  }

  /** Alterna un breakpoint. Devuelve las líneas resultantes del archivo. */
  toggleBreakpoint(file: string, line: number): number[] {
    const lines = this.breakpoints.get(file) ?? new Set<number>();
    if (lines.has(line)) lines.delete(line);
    else lines.add(line);

    this.breakpoints.set(file, lines);
    return this.linesFor(file);
  }

  hasBreakpoint(file: string, line: number): boolean {
    return this.breakpoints.get(file)?.has(line) === true;
  }

  countBreakpoints(): number {
    let total = 0;
    for (const lines of this.breakpoints.values()) total += lines.size;
    return total;
  }

  // --- Estado --------------------------------------------------------------------------------

  setState(state: DebugState): void {
    this.state = state;

    if (state.status !== 'paused') {
      this.frames = [];
      this.scopes = [];
      this.activeFrameId = null;
      this.variableCache.clear();
      this.expanded.clear();
    }
  }

  /** Tras un `stopped`, recarga pila y variables del marco superior. */
  async refreshAfterStop(): Promise<DebugStackFrame | null> {
    this.frames = await window.dotforge.debug.stackTrace();
    this.variableCache.clear();
    this.expanded.clear();

    const top = this.frames[0] ?? null;
    if (top) await this.selectFrame(top.id);

    return top;
  }

  async selectFrame(frameId: number): Promise<void> {
    this.activeFrameId = frameId;
    this.scopes = await window.dotforge.debug.scopes(frameId);
    this.variableCache.clear();

    for (const scope of this.scopes) {
      if (!scope.expensive) {
        this.variableCache.set(scope.variablesReference, await window.dotforge.debug.variables(scope.variablesReference));
        this.expanded.add(scope.variablesReference);
      }
    }
  }

  activeFrame(): DebugStackFrame | null {
    return this.frames.find((frame) => frame.id === this.activeFrameId) ?? null;
  }

  async toggleVariable(reference: number): Promise<void> {
    if (this.expanded.has(reference)) {
      this.expanded.delete(reference);
      return;
    }

    this.expanded.add(reference);
    if (!this.variableCache.has(reference)) {
      this.variableCache.set(reference, await window.dotforge.debug.variables(reference));
    }
  }

  // --- Render --------------------------------------------------------------------------------

  render(container: HTMLElement, onChange: () => void): void {
    clear(container);

    container.appendChild(this.renderToolbar());

    if (this.state.status === 'idle' || this.state.status === 'error') {
      container.appendChild(
        el('div', {
          className: this.state.status === 'error' ? 'notice error' : 'empty-state',
          text:
            this.state.message ??
            'Pon un breakpoint en el margen del editor y pulsa F5 para depurar. Requiere compilar antes.',
          style: { margin: '10px 12px', whiteSpace: 'pre-wrap' },
        }),
      );
      container.appendChild(this.renderBreakpointList(onChange));
      return;
    }

    if (this.state.status === 'acquiring' || this.state.status === 'starting') {
      container.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          el('span', { className: 'spinner' }),
          ` ${this.state.message ?? 'preparando la sesión'}${
            this.state.progress !== null ? ` ${Math.round(this.state.progress * 100)}%` : ''
          }`,
        ),
      );
      return;
    }

    if (this.state.status === 'running') {
      container.appendChild(
        el('div', { className: 'empty-state', text: 'En ejecución. Se detendrá al llegar a un breakpoint.' }),
      );
      container.appendChild(this.renderBreakpointList(onChange));
      return;
    }

    // Pausado: pila + variables, en dos columnas.
    const columns = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) 1.4fr', gap: '0', height: '100%' },
    });

    columns.appendChild(this.renderStack(onChange));
    columns.appendChild(this.renderVariables(onChange));
    container.appendChild(columns);
  }

  private renderToolbar(): HTMLElement {
    const paused = this.state.status === 'paused';
    const active = this.state.status === 'paused' || this.state.status === 'running';

    const button = (label: string, title: string, action: () => void, enabled: boolean): HTMLElement =>
      el('button', {
        className: 'btn ghost',
        text: label,
        title,
        disabled: !enabled,
        on: { click: action },
      });

    return el(
      'div',
      {
        style: {
          display: 'flex',
          gap: '4px',
          alignItems: 'center',
          padding: '6px 10px',
          borderBottom: '1px solid var(--border-subtle)',
          flexWrap: 'wrap',
        },
      },
      button('▶ Continuar', 'F5', () => void window.dotforge.debug.control('continue'), paused),
      button('⤼ Paso a paso por procedimientos', 'F10', () => void window.dotforge.debug.control('stepOver'), paused),
      button('⤓ Entrar', 'F11', () => void window.dotforge.debug.control('stepIn'), paused),
      button('⤒ Salir', 'Shift+F11', () => void window.dotforge.debug.control('stepOut'), paused),
      button('⏸ Pausar', 'Pausar la ejecución', () => void window.dotforge.debug.control('pause'), this.state.status === 'running'),
      button('■ Detener', 'Shift+F5', () => void window.dotforge.debug.stop(), active),
      el('span', { style: { flex: '1' } }),
      el('span', {
        className: 'mono',
        style: { color: 'var(--text-faint)' },
        text: this.state.version ? `NetCoreDbg ${this.state.version}` : '',
      }),
    );
  }

  private renderStack(onChange: () => void): HTMLElement {
    const column = el('div', { style: { overflow: 'auto', borderRight: '1px solid var(--border-subtle)' } });
    column.appendChild(el('div', { className: 'tree-group', text: 'Pila de llamadas' }));

    if (this.frames.length === 0) {
      column.appendChild(el('div', { className: 'empty-state', text: 'Sin marcos.' }));
      return column;
    }

    for (const frame of this.frames) {
      const where = frame.file ? `${baseName(frame.file)}:${frame.line}` : '';

      column.appendChild(
        el(
          'button',
          {
            className: `tree-row${frame.id === this.activeFrameId ? ' selected' : ''}`,
            title: frame.file ?? frame.name,
            on: {
              click: () => {
                void this.selectFrame(frame.id).then(() => {
                  if (frame.file) this.host.openLocation(frame.file, frame.line);
                  onChange();
                });
              },
            },
          },
          el('span', { className: 'glyph', text: '›' }),
          el('span', { className: 'label', text: frame.name }),
          el('span', { className: 'hint', text: where }),
        ),
      );
    }

    return column;
  }

  private renderVariables(onChange: () => void): HTMLElement {
    const column = el('div', { style: { overflow: 'auto' } });
    column.appendChild(el('div', { className: 'tree-group', text: 'Variables' }));

    if (this.scopes.length === 0) {
      column.appendChild(el('div', { className: 'empty-state', text: 'Sin ámbitos.' }));
      return column;
    }

    for (const scope of this.scopes) {
      const open = this.expanded.has(scope.variablesReference);

      column.appendChild(
        el(
          'button',
          {
            className: 'tree-row',
            on: {
              click: () => {
                void this.toggleVariable(scope.variablesReference).then(onChange);
              },
            },
          },
          el('span', { className: 'twisty', text: open ? '▾' : '▸' }),
          el('span', { className: 'label', text: scope.name }),
        ),
      );

      if (open) {
        this.appendVariables(column, this.variableCache.get(scope.variablesReference) ?? [], 1, onChange);
      }
    }

    return column;
  }

  private appendVariables(
    parent: HTMLElement,
    variables: DebugVariable[],
    depth: number,
    onChange: () => void,
  ): void {
    for (const variable of variables) {
      const expandable = variable.variablesReference > 0;
      const open = expandable && this.expanded.has(variable.variablesReference);

      parent.appendChild(
        el(
          'button',
          {
            className: 'tree-row',
            style: { paddingLeft: `${8 + depth * 14}px` },
            title: variable.type ? `${variable.name}: ${variable.type}` : variable.name,
            on: {
              click: () => {
                if (!expandable) return;
                void this.toggleVariable(variable.variablesReference).then(onChange);
              },
            },
          },
          el('span', { className: 'twisty', text: expandable ? (open ? '▾' : '▸') : '' }),
          el('span', { className: 'label', text: variable.name }),
          el('span', {
            className: 'hint',
            style: { fontFamily: 'var(--font-mono)', color: 'var(--syntax-string)' },
            text: variable.value,
          }),
        ),
      );

      if (open) {
        this.appendVariables(parent, this.variableCache.get(variable.variablesReference) ?? [], depth + 1, onChange);
      }
    }
  }

  private renderBreakpointList(onChange: () => void): HTMLElement {
    const container = el('div');
    const entries = this.allBreakpoints();

    container.appendChild(
      el('div', { className: 'tree-group', text: `Breakpoints (${this.countBreakpoints()})` }),
    );

    if (entries.length === 0) {
      container.appendChild(
        el('div', { className: 'empty-state', text: 'Haz clic en el margen izquierdo del editor para poner uno.' }),
      );
      return container;
    }

    for (const entry of entries) {
      for (const line of entry.lines) {
        container.appendChild(
          el(
            'button',
            {
              className: 'tree-row',
              title: entry.file,
              on: { click: () => this.host.openLocation(entry.file, line) },
            },
            el('span', { className: 'glyph', style: { color: 'var(--danger)' }, text: '●' }),
            el('span', { className: 'label', text: `${baseName(entry.file)}:${line}` }),
            el('span', {
              className: 'hint',
              text: '✕',
              on: {
                click: (event) => {
                  event.stopPropagation();
                  this.toggleBreakpoint(entry.file, line);
                  void window.dotforge.debug.setBreakpoints(entry.file, this.linesFor(entry.file));
                  onChange();
                },
              },
            }),
          ),
        );
      }
    }

    return container;
  }
}

export type { VariableNode };
