/**
 * Barra de estado.
 *
 * Concentra lo que hay que saber sin apartar la vista del código: estado del servidor de
 * lenguaje, errores y advertencias, tarea en curso, posición del cursor y lenguaje del archivo.
 */
import type { BuildDiagnostic, LspState } from '../../shared/contracts.js';
import { byId, clear, el } from '../dom.js';

export interface StatusBarModel {
  lsp: LspState;
  diagnostics: BuildDiagnostic[];
  runningTask: string | null;
  cursor: { line: number; column: number } | null;
  languageId: string | null;
  encoding: string;
  branchLabel: string | null;
}

export interface StatusBarHost {
  showProblems(): void;
  showOutput(): void;
  restartLsp(): void;
  toggleTheme(): void;
  openCommandPalette(): void;
}

export class StatusBar {
  constructor(private readonly host: StatusBarHost) {}

  render(model: StatusBarModel): void {
    const bar = byId('statusbar');
    clear(bar);

    bar.appendChild(this.lspItem(model.lsp));

    const errors = model.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
    const warnings = model.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;

    bar.appendChild(
      el(
        'button',
        {
          className: 'status-item',
          title: 'Ver problemas',
          on: { click: () => this.host.showProblems() },
        },
        `✖ ${errors}`,
        '  ',
        `▲ ${warnings}`,
      ),
    );

    if (model.runningTask) {
      bar.appendChild(
        el(
          'button',
          {
            className: 'status-item',
            title: model.runningTask,
            on: { click: () => this.host.showOutput() },
          },
          el('span', { className: 'dot busy' }),
          'Ejecutando…',
        ),
      );
    }

    bar.appendChild(el('span', { className: 'spacer' }));

    if (model.cursor) {
      bar.appendChild(
        el('span', {
          className: 'status-item readonly',
          text: `Ln ${model.cursor.line}, Col ${model.cursor.column}`,
        }),
      );
    }

    if (model.languageId) {
      bar.appendChild(el('span', { className: 'status-item readonly', text: this.languageLabel(model.languageId) }));
    }

    bar.appendChild(el('span', { className: 'status-item readonly', text: model.encoding.toUpperCase() }));

    bar.appendChild(
      el('button', {
        className: 'status-item',
        text: '◐',
        title: 'Cambiar tema',
        on: { click: () => this.host.toggleTheme() },
      }),
    );

    bar.appendChild(
      el('button', {
        className: 'status-item',
        text: '⌘',
        title: 'Paleta de comandos',
        on: { click: () => this.host.openCommandPalette() },
      }),
    );
  }

  private languageLabel(languageId: string): string {
    const labels: Record<string, string> = {
      csharp: 'C#',
      razor: 'Razor',
      xml: 'XML',
      json: 'JSON',
      markdown: 'Markdown',
      yaml: 'YAML',
      plaintext: 'Texto',
      ini: 'INI',
    };
    return labels[languageId] ?? languageId;
  }

  private lspItem(state: LspState): HTMLElement {
    const presentation: Record<LspState['status'], { dot: string; text: string }> = {
      idle: { dot: '', text: 'C#: inactivo' },
      acquiring: { dot: 'busy', text: 'C#: descargando servidor' },
      starting: { dot: 'busy', text: 'C#: iniciando' },
      ready: { dot: 'ok', text: 'C#: listo' },
      degraded: { dot: 'warn', text: 'C#: sin IntelliSense' },
      error: { dot: 'err', text: 'C#: error' },
    };

    const { dot, text } = presentation[state.status];
    const detail = state.message ?? state.server ?? '';
    const progress =
      state.status === 'acquiring' && state.progress !== null ? ` ${Math.round(state.progress * 100)}%` : '';

    return el(
      'button',
      {
        className: 'status-item',
        title: detail || 'Servidor de lenguaje de C#',
        on: { click: () => this.host.restartLsp() },
      },
      dot ? el('span', { className: `dot ${dot}` }) : null,
      `${text}${progress}`,
    );
  }
}
