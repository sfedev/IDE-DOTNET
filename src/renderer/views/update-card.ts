/**
 * Tarjeta flotante de actualización.
 *
 * Aparece abajo a la derecha cuando hay una versión posterior publicada, y desaparece en cuanto se
 * decide algo. Es deliberadamente una tarjeta y no un modal: enterarse de que hay una versión
 * nueva no debe interrumpir lo que se estaba escribiendo, y un diálogo que roba el foco a mitad de
 * un método convierte una buena noticia en una molestia.
 *
 * Los dos botones significan cosas distintas y las dos son "sí":
 *
 *  - **Actualizar** descarga ahora, con la barra a la vista, y deja el botón "Reiniciar y aplicar".
 *  - **Descartar** esconde la tarjeta y programa la instalación para cuando se cierre el IDE. No es
 *    "no quiero", es "ahora no me interrumpas": la descarga sigue en segundo plano.
 *
 * No hay "no volver a preguntar" porque ya existe: el interruptor de Ajustes.
 */
import type { UpdateState } from '../../shared/contracts.js';
import { updateHeadline } from '../../shared/updates.js';
import { byId, clear, el, formatBytes } from '../dom.js';
import { icon } from '../icons.js';

export interface UpdateCardHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  openUrl(url: string): void;
}

export class UpdateCard {
  private state: UpdateState | null = null;
  private busy = false;

  constructor(private readonly host: UpdateCardHost) {
    installPreviewHook(this);
  }

  setState(state: UpdateState): void {
    this.state = state;
    this.render();
  }

  getState(): UpdateState | null {
    return this.state;
  }

  /** true si hay una versión ofrecida, la haya descartado el usuario o no. */
  hasUpdate(): boolean {
    const status = this.state?.status;
    return status === 'available' || status === 'downloading' || status === 'ready';
  }

  // --- Acciones ---------------------------------------------------------------------------------

  private async run(action: () => Promise<UpdateState>, failure: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();

    try {
      this.setState(await action());
    } catch (error) {
      this.host.notify(`${failure}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private download(): void {
    void this.run(() => window.dotforge.updates.download(), 'No se ha podido descargar la actualización');
  }

  private apply(): void {
    void this.run(() => window.dotforge.updates.applyOnQuit(true), 'No se ha podido aplicar la actualización');
  }

  private dismiss(): void {
    void this.run(() => window.dotforge.updates.dismiss(), 'No se ha podido posponer la actualización');
  }

  // --- Pintado ----------------------------------------------------------------------------------

  render(): void {
    const host = byId('update-host');
    clear(host);

    const state = this.state;
    if (state === null || state.version === null || state.dismissed) {
      host.hidden = true;
      return;
    }

    if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'ready') {
      host.hidden = true;
      return;
    }

    host.hidden = false;
    host.appendChild(this.card(state));
  }

  private card(state: UpdateState): HTMLElement {
    const version = state.version ?? '';

    const head = el(
      'div',
      { className: 'update-head' },
      el('span', { className: 'update-title', text: updateHeadline(version) }),
      el(
        'button',
        {
          className: 'icon-btn update-close',
          title: 'Recordármelo al cerrar',
          attrs: { 'aria-label': 'Descartar' },
          on: { click: () => this.dismiss() },
        },
        icon('x', { size: 14 }),
      ),
    );

    const card = el(
      'section',
      { className: 'update-card', role: 'status' },
      head,
      el('p', {
        className: 'update-sub',
        text:
          state.size > 0
            ? `Tienes la v${state.currentVersion}. La descarga ocupa ${formatBytes(state.size)}.`
            : `Tienes la v${state.currentVersion}.`,
      }),
    );

    if (state.notes.length > 0) card.appendChild(this.notes(state.notes));
    if (state.message !== null) {
      card.appendChild(el('p', { className: 'update-note warn', text: state.message }));
    }

    if (state.status === 'downloading') card.appendChild(this.progress(state));
    if (state.status === 'ready' && state.plan !== null) {
      card.appendChild(el('p', { className: 'update-note ok', text: state.plan }));
    }

    card.appendChild(this.actions(state));

    if (state.releaseUrl !== null) {
      const url = state.releaseUrl;
      card.appendChild(
        el(
          'button',
          { className: 'link-btn update-link', on: { click: () => this.host.openUrl(url) } },
          icon('external-link', { size: 12 }),
          el('span', { text: 'Ver la publicación completa' }),
        ),
      );
    }

    return card;
  }

  /**
   * Notas de la versión.
   *
   * Llegan como líneas ya limpias del Markdown de la publicación: el renderer no inyecta marcado
   * ni aquí ni en ningún sitio, y el cuerpo de una release es texto de la red.
   *
   * No es una `<ul>` a propósito. Las líneas ya traen su propia marca cuando eran viñetas —y no la
   * traen cuando eran encabezados—, así que una lista de verdad pintaría dos viñetas en unas
   * líneas y una sangría sin sentido en otras.
   */
  private notes(lines: string[]): HTMLElement {
    const list = el('div', { className: 'update-notes' });
    for (const line of lines) list.appendChild(el('span', { className: 'update-note-line', text: line }));
    return list;
  }

  private progress(state: UpdateState): HTMLElement {
    const ratio = state.progress ?? 0;
    const percent = Math.round(Math.min(Math.max(ratio, 0), 1) * 100);

    return el(
      'div',
      { className: 'update-progress' },
      el(
        'div',
        { className: 'update-bar', attrs: { role: 'progressbar', 'aria-valuenow': String(percent) } },
        el('div', {
          className: 'update-bar-fill',
          // Sin `content-length` no hay porcentaje honesto: la barra se pinta indeterminada.
          style: state.progress === null ? { width: '35%' } : { width: `${percent}%` },
        }),
      ),
      el('span', {
        className: 'update-percent',
        text: state.progress === null ? 'Descargando…' : `${percent} %`,
      }),
    );
  }

  private actions(state: UpdateState): HTMLElement {
    const actions = el('div', { className: 'update-actions' });

    if (state.status === 'ready') {
      actions.append(
        el(
          'button',
          {
            className: 'btn primary small',
            disabled: this.busy,
            title: 'Cierra DotForge y aplica la actualización',
            on: { click: () => this.apply() },
          },
          icon('refresh', { size: 14 }),
          el('span', { text: 'Reiniciar y aplicar' }),
        ),
        el('button', {
          className: 'btn ghost small',
          text: 'Al cerrar',
          disabled: this.busy,
          title: 'Se instalará sola la próxima vez que cierres el IDE',
          on: { click: () => this.dismiss() },
        }),
      );

      return actions;
    }

    actions.append(
      el(
        'button',
        {
          className: 'btn primary small',
          disabled: this.busy || state.status === 'downloading',
          on: { click: () => this.download() },
        },
        icon('download', { size: 14 }),
        el('span', { text: state.status === 'downloading' ? 'Descargando…' : 'Actualizar' }),
      ),
      el('button', {
        className: 'btn ghost small',
        text: 'Descartar',
        disabled: this.busy,
        title: 'Oculta el aviso e instala la actualización al cerrar el IDE',
        on: { click: () => this.dismiss() },
      }),
    );

    return actions;
  }
}

/**
 * Gancho de revisión visual, como el de la galería de iconos.
 *
 * `--ui=update` no puede publicar una versión de verdad en GitHub para sacar una captura, y la
 * alternativa —revisar la tarjeta "cuando toque"— significa no revisarla nunca. Esto pinta la
 * tarjeta con un estado de ejemplo y no toca nada más: ni descarga, ni instala, ni cambia estado.
 */
function installPreviewHook(card: UpdateCard): void {
  (window as unknown as { __dotforgeUpdatePreview: () => void }).__dotforgeUpdatePreview = () => {
    card.setState({
      status: 'available',
      currentVersion: '2.1.0',
      version: '2.2.0',
      notes: [
        'Novedades',
        '· Explorador de extensiones de Open VSX con instalación y desinstalación.',
        '· El servidor de lenguaje conmuta solo a OmniSharp si Roslyn falla.',
        '· Corregido el visor de registro con excepciones partidas en dos lecturas.',
      ],
      size: 128 * 1024 * 1024,
      progress: null,
      downloadedPath: null,
      applyOnQuit: false,
      dismissed: false,
      plan: null,
      message: null,
      releaseUrl: 'https://github.com/sfedev/IDE-DOTNET/releases',
      checkedAtUtc: null,
    });
  };
}
