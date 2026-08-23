/**
 * Barra de estado.
 *
 * Rediseño: sólo lo esencial a la izquierda —SDK de .NET, servidor de lenguaje, rama de Git y
 * contador de problemas— y el contexto del archivo a la derecha. Lo demás (versiones, codificación,
 * indicadores decorativos) se ha movido a "Acerca de" y a la paleta de comandos.
 *
 * El color se reserva para lo que reclama atención: un error en rojo, una tarea en curso en ámbar.
 * En reposo, toda la barra es neutra.
 */
import type { BuildDiagnostic, GitStatus, LspState } from '../../shared/contracts.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export interface StatusBarModel {
  lsp: LspState;
  diagnostics: BuildDiagnostic[];
  runningTask: string | null;
  cursor: { line: number; column: number } | null;
  languageId: string | null;
  git: GitStatus | null;
  sdkVersion: string | null;
}

export interface StatusBarHost {
  showProblems(): void;
  showOutput(): void;
  restartLsp(): void;
  openCommandPalette(): void;
}

const LANGUAGE_LABELS: Record<string, string> = {
  csharp: 'C#',
  razor: 'Razor',
  xml: 'XML',
  json: 'JSON',
  markdown: 'Markdown',
  yaml: 'YAML',
  css: 'CSS',
  html: 'HTML',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  ini: 'INI',
  plaintext: 'Texto',
};

/** Presentación del estado del servidor de lenguaje. */
const LSP_PRESENTATION: Record<LspState['status'], { icon: IconName; className: string }> = {
  idle: { icon: 'circle-slash', className: '' },
  acquiring: { icon: 'download', className: 'is-busy' },
  starting: { icon: 'circle-dot', className: 'is-busy' },
  ready: { icon: 'circle-dot', className: 'is-ready' },
  degraded: { icon: 'alert-triangle', className: 'is-degraded' },
  error: { icon: 'alert-circle', className: 'is-error' },
};

export class StatusBar {
  constructor(private readonly host: StatusBarHost) {}

  render(model: StatusBarModel): void {
    const bar = byId('statusbar');
    clear(bar);

    // --- Izquierda: entorno -----------------------------------------------------------------
    if (model.sdkVersion) {
      bar.appendChild(
        this.item({
          icon: 'project',
          text: `.NET ${model.sdkVersion}`,
          title: `SDK de .NET ${model.sdkVersion}`,
          readonly: true,
        }),
      );
    }

    bar.appendChild(this.lspItem(model.lsp));

    if (model.git?.branch) {
      bar.appendChild(
        this.item({
          icon: 'git-branch',
          text: model.git.dirtyFiles > 0 ? `${model.git.branch} ∙ ${model.git.dirtyFiles}` : model.git.branch,
          title:
            model.git.dirtyFiles > 0
              ? `Rama ${model.git.branch} — ${model.git.dirtyFiles} archivo(s) con cambios sin confirmar`
              : `Rama ${model.git.branch} — sin cambios pendientes`,
          readonly: true,
        }),
      );
    }

    bar.appendChild(this.problemsItem(model.diagnostics));

    if (model.runningTask) {
      bar.appendChild(
        this.item({
          icon: 'refresh',
          text: 'Ejecutando',
          title: model.runningTask,
          className: 'is-busy',
          onClick: () => this.host.showOutput(),
        }),
      );
    }

    bar.appendChild(el('span', { className: 'spacer' }));

    // --- Derecha: contexto del archivo -------------------------------------------------------
    if (model.cursor) {
      bar.appendChild(
        this.item({
          text: `Ln ${model.cursor.line}, Col ${model.cursor.column}`,
          title: 'Posición del cursor',
          readonly: true,
        }),
      );
    }

    if (model.languageId) {
      bar.appendChild(
        this.item({
          text: LANGUAGE_LABELS[model.languageId] ?? model.languageId,
          title: 'Lenguaje del archivo',
          readonly: true,
        }),
      );
    }

    bar.appendChild(el('span', { className: 'status-separator' }));

    bar.appendChild(
      this.item({
        icon: 'command',
        title: 'Paleta de comandos',
        onClick: () => this.host.openCommandPalette(),
      }),
    );
  }

  private item(options: {
    icon?: IconName;
    text?: string;
    title: string;
    className?: string;
    readonly?: boolean;
    onClick?: () => void;
  }): HTMLElement {
    const classes = ['status-item'];
    if (options.readonly) classes.push('readonly');
    if (options.className) classes.push(options.className);

    const children = [
      options.icon ? icon(options.icon, { size: 13 }) : null,
      options.text ? el('span', { className: 'count', text: options.text }) : null,
    ];

    if (options.readonly) {
      return el('span', { className: classes.join(' '), title: options.title }, ...children);
    }

    return el(
      'button',
      {
        className: classes.join(' '),
        title: options.title,
        on: { click: () => options.onClick?.() },
      },
      ...children,
    );
  }

  private problemsItem(diagnostics: BuildDiagnostic[]): HTMLElement {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
    const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
    const className = errors > 0 ? 'has-errors' : warnings > 0 ? 'has-warnings' : '';

    return el(
      'button',
      {
        className: `status-item ${className}`.trim(),
        title:
          errors + warnings === 0
            ? 'Sin problemas'
            : `${errors} error(es) y ${warnings} advertencia(s) — clic para ver el detalle`,
        on: { click: () => this.host.showProblems() },
      },
      icon('alert-circle', { size: 13 }),
      el('span', { className: 'count', text: String(errors) }),
      icon('alert-triangle', { size: 13 }),
      el('span', { className: 'count', text: String(warnings) }),
    );
  }

  private lspItem(state: LspState): HTMLElement {
    const presentation = LSP_PRESENTATION[state.status];
    const progress =
      state.status === 'acquiring' && state.progress !== null ? ` ${Math.round(state.progress * 100)}%` : '';

    const detail =
      state.message ??
      (state.status === 'ready' ? `${state.server ?? 'Servidor de lenguaje'} listo` : 'Servidor de lenguaje de C#');

    return el(
      'button',
      {
        className: `status-item ${presentation.className}`.trim(),
        title: `${detail}\nClic para reiniciar el servidor`,
        on: { click: () => this.host.restartLsp() },
      },
      icon(presentation.icon, { size: 13 }),
      el('span', { className: 'count', text: `C#${progress}` }),
    );
  }
}
