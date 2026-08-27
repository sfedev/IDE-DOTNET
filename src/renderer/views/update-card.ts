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
 *  - **Actualizar** descarga ahora, con la barra a la vista, y deja el botón que aplica.
 *  - **Descartar** esconde la tarjeta y programa la instalación para cuando se cierre el IDE. No es
 *    "no quiero", es "ahora no me interrumpas": la descarga sigue en segundo plano.
 *
 * No hay "no volver a preguntar" porque ya existe: el interruptor de Ajustes.
 *
 * Y hay una excepción a lo de no interrumpir, que es justo la contraria: **aplicar sí pregunta**.
 * Pulsar ese botón cierra el IDE, y hasta aquí lo hacía en el mismo gesto, sin decir cuánto tarda
 * la instalación ni si la aplicación vuelve sola. Ahí un modal no es una molestia: es lo único que
 * separa "quería actualizar" de "he perdido la ventana".
 *
 * La tarjeta pinta además el **cierre del ciclo** (`state.outcome`), que es lo que se ve en el
 * arranque siguiente: el "✅ ¡Actualizado!" con las novedades, o el aviso de que la instalación no
 * llegó a aplicarse. Ese aviso tiene prioridad sobre cualquier otro contenido — habla de algo que
 * el usuario pidió y que ya ha pasado, mientras que lo demás habla de algo que aún puede esperar.
 */
import type { InstallOutcome, UpdateState } from '../../shared/contracts.js';
import {
  applyActionLabel,
  applyConfirmation,
  outcomeHeadline,
  outcomeMessage,
  updateHeadline,
} from '../../shared/updates.js';
import { byId, clear, el, formatBytes } from '../dom.js';
import { icon } from '../icons.js';
import { confirmDialog } from './confirm-dialog.js';

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

  /**
   * Aplicar: preguntar primero, cerrar después.
   *
   * El texto no es genérico. Un instalador silencioso y un `.dmg` prometen cosas distintas —uno
   * termina solo y reabre el IDE, el otro deja al usuario con una imagen de disco abierta— y el
   * aviso lo compone `applyConfirmation` a partir de `planKind`, que es un dato del estado y no una
   * interpretación de la frase de `plan`.
   *
   * Sin `planKind` no se pregunta con detalles inventados: se cae al plan silencioso sólo si el
   * estado lo dice, y si no dice nada se asume el que **menos** promete.
   */
  private async apply(): Promise<void> {
    const state = this.state;
    if (state === null || state.version === null || this.busy) return;

    const confirmation = applyConfirmation(state.version, state.planKind ?? 'open');

    const accepted = await confirmDialog({
      title: confirmation.title,
      message: confirmation.message,
      detail: confirmation.detail,
      confirmLabel: confirmation.confirmLabel,
      cancelLabel: confirmation.cancelLabel,
      icon: 'refresh',
    });

    if (!accepted) return;

    await this.run(() => window.dotforge.updates.applyOnQuit(true), 'No se ha podido aplicar la actualización');
  }

  private dismiss(): void {
    void this.run(() => window.dotforge.updates.dismiss(), 'No se ha podido posponer la actualización');
  }

  /** Cierra el aviso de cierre de ciclo. No toca nada más: no hay nada que programar. */
  private acknowledge(): void {
    void this.run(() => window.dotforge.updates.acknowledge(), 'No se ha podido cerrar el aviso');
  }

  // --- Pintado ----------------------------------------------------------------------------------

  render(): void {
    const host = byId('update-host');
    clear(host);

    const state = this.state;
    if (state === null) {
      host.hidden = true;
      return;
    }

    // El cierre de ciclo manda: es lo que contesta a algo que el usuario ya pidió. Y no mira
    // `dismissed`, que es la respuesta a *otra* pregunta —la de una actualización por venir— y
    // llega puesta desde la sesión anterior en la mitad de los casos.
    if (state.outcome !== null) {
      host.hidden = false;
      host.appendChild(this.outcomeCard(state, state.outcome));
      return;
    }

    if (state.version === null || state.dismissed) {
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

  /**
   * Aviso del arranque: se instaló, o no se instaló.
   *
   * El caso que falla **no** es una tarjeta de error tirada en el panel de problemas: lleva el
   * botón para reintentar justo debajo del motivo, porque quien canceló el aviso de permisos sin
   * querer lo que necesita es volver a intentarlo, no enterarse.
   */
  private outcomeCard(state: UpdateState, outcome: InstallOutcome): HTMLElement {
    const failed = outcome.kind === 'install-failed';

    const card = el(
      'section',
      { className: `update-card${failed ? ' update-failed' : ''}`, role: 'status' },
      el(
        'div',
        { className: 'update-head' },
        el('span', { className: 'update-title', text: outcomeHeadline(outcome) }),
        el(
          'button',
          {
            className: 'icon-btn update-close',
            title: 'Cerrar el aviso',
            attrs: { 'aria-label': 'Cerrar' },
            on: { click: () => this.acknowledge() },
          },
          icon('x', { size: 14 }),
        ),
      ),
      el('p', { className: 'update-sub', text: outcomeMessage(outcome, state.currentVersion) }),
    );

    if (outcome.notes.length > 0) card.appendChild(this.notes(outcome.notes));

    const actions = el('div', { className: 'update-actions' });

    if (failed) {
      actions.append(
        el(
          'button',
          {
            className: 'btn primary small',
            disabled: this.busy,
            title: 'Vuelve a cerrar el IDE y a lanzar el instalador ya descargado',
            on: { click: () => void this.apply() },
          },
          icon('refresh', { size: 14 }),
          el('span', { text: applyActionLabel(state.planKind ?? 'open') }),
        ),
        el('button', {
          className: 'btn ghost small',
          text: 'Al cerrar',
          disabled: this.busy,
          title: 'Se volverá a intentar la próxima vez que cierres el IDE',
          on: { click: () => this.dismiss() },
        }),
      );
    } else {
      actions.append(
        el('button', {
          className: 'btn primary small',
          text: 'Entendido',
          disabled: this.busy,
          on: { click: () => this.acknowledge() },
        }),
      );
    }

    card.appendChild(actions);

    if (outcome.releaseUrl !== null) {
      const url = outcome.releaseUrl;
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
      const kind = state.planKind ?? 'open';

      actions.append(
        el(
          'button',
          {
            className: 'btn primary small',
            disabled: this.busy,
            // El título dice lo mismo que el botón, no otra cosa: "Reiniciar y aplicar" prometía un
            // reinicio que el IDE no hace —se cierra y deja trabajando al instalador— y en macOS ni
            // siquiera eso. Antes de cerrar nada se pregunta, con el texto que corresponda al plan.
            title:
              kind === 'silent'
                ? 'Cierra DotForge, instala la versión nueva y vuelve a abrirlo'
                : 'Cierra DotForge y abre el instalador para que lo completes',
            on: { click: () => void this.apply() },
          },
          icon('refresh', { size: 14 }),
          el('span', { text: applyActionLabel(kind) }),
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
  const NOTES = [
    'Novedades',
    '· Explorador de extensiones de Open VSX con instalación y desinstalación.',
    '· El servidor de lenguaje conmuta solo a OmniSharp si Roslyn falla.',
    '· Corregido el visor de registro con excepciones partidas en dos lecturas.',
  ];

  const base = {
    currentVersion: '2.1.0',
    size: 128 * 1024 * 1024,
    progress: null,
    downloadedPath: null,
    applyOnQuit: false,
    dismissed: false,
    plan: null,
    planKind: null,
    outcome: null,
    message: null,
    releaseUrl: 'https://github.com/sfedev/IDE-DOTNET/releases',
    checkedAtUtc: null,
  } satisfies Omit<UpdateState, 'status' | 'version' | 'notes'>;

  const preview = (window as unknown as {
    __dotforgeUpdatePreview: (variant?: string) => void;
  });

  /**
   * Tres estados de ejemplo, no uno.
   *
   * Los dos nuevos son precisamente los que **no** se pueden provocar sin publicar una release,
   * instalarla y cancelarle el aviso de permisos a Windows. Revisarlos "cuando toque" es no
   * revisarlos nunca, que es como el proyecto se quedó con un botón prometiendo un reinicio que no
   * ocurría.
   */
  preview.__dotforgeUpdatePreview = (variant = 'available') => {
    if (variant === 'updated') {
      card.setState({
        ...base,
        currentVersion: '2.8.0',
        status: 'up-to-date',
        version: null,
        notes: NOTES,
        outcome: {
          kind: 'just-updated',
          version: '2.8.0',
          attempts: 1,
          notes: NOTES,
          releaseUrl: 'https://github.com/sfedev/IDE-DOTNET/releases',
        },
      });
      return;
    }

    if (variant === 'failed') {
      card.setState({
        ...base,
        status: 'ready',
        version: '2.8.0',
        notes: [],
        planKind: 'silent',
        plan: 'Se instalará en silencio al cerrar el IDE y DotForge se abrirá de nuevo al terminar.',
        downloadedPath: 'C:\\Users\\dev\\AppData\\Roaming\\DotForge IDE\\updates\\Setup-x64.exe',
        outcome: {
          kind: 'install-failed',
          version: '2.8.0',
          attempts: 2,
          notes: [],
          releaseUrl: 'https://github.com/sfedev/IDE-DOTNET/releases',
        },
      });
      return;
    }

    card.setState({ ...base, status: 'available', version: '2.2.0', notes: NOTES });
  };
}
