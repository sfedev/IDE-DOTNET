/**
 * Cliente HTTP: envío de peticiones y vista de la respuesta.
 *
 * La respuesta se enseña en el panel inferior, junto a la salida y la terminal, y no en una
 * pestaña del editor. Es deliberado: al probar un endpoint se quiere ver el código, la petición y
 * la respuesta a la vez, y para eso el panel de abajo es el único sitio que no tapa el editor.
 *
 * La vista no sabe parsear archivos `.http` —eso es `src/shared/http-file.ts`, que es puro— ni
 * abre sockets —eso es el proceso principal—. Aquí sólo se decide qué se enseña.
 */
import type { HttpRequestBlock, HttpResponseResult, ResolvedHttpRequest } from '../../shared/contracts.js';
import { formatBytes, formatDuration, resolveRequest, statusTone } from '../../shared/http-file.js';
import { clear, el } from '../dom.js';
import { icon } from '../icons.js';

export interface HttpClientHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  /** Trae al frente la pestaña de HTTP del panel inferior. */
  showPanel(): void;
  /** Repinta el panel: la vista vive dentro de él y no se pinta sola. */
  refresh(): void;
}

interface Entry {
  request: ResolvedHttpRequest;
  /** Nombre de la petición en el archivo, para la cabecera. */
  label: string;
  response: HttpResponseResult | null;
  /** Marca de tiempo local del envío, para el historial. */
  at: number;
}

/** Valores dinámicos (`{{$guid}}`, `{{$timestamp}}`) resueltos en el momento del envío. */
function dynamicValues(): { nowMs: number; uuid: string; randomInt: number } {
  return {
    nowMs: Date.now(),
    uuid: crypto.randomUUID(),
    randomInt: Math.floor(Math.random() * 1_000_000),
  };
}

export class HttpClientView {
  private entries: Entry[] = [];
  private selected = 0;
  private sending = false;
  private tab: 'body' | 'headers' | 'request' = 'body';

  constructor(private readonly host: HttpClientHost) {}

  hasContent(): boolean {
    return this.entries.length > 0 || this.sending;
  }

  /**
   * Envía una petición de un archivo `.http`.
   *
   * Las variables se resuelven aquí, en el renderer, con el modelo puro: lo que sale hacia el
   * proceso principal es ya una petición concreta, sin plantillas. Así el handler no necesita
   * conocer el formato del archivo.
   */
  async send(request: HttpRequestBlock, variables: Readonly<Record<string, string>>): Promise<void> {
    const resolved = resolveRequest(request, variables, dynamicValues());

    const entry: Entry = { request: resolved, label: request.name, response: null, at: Date.now() };
    this.entries = [entry, ...this.entries].slice(0, 20);
    this.selected = 0;
    this.sending = true;
    this.tab = 'body';

    this.host.showPanel();
    this.host.refresh();

    try {
      entry.response = await window.dotforge.http.send(resolved);

      if (entry.response.error !== null) {
        this.host.notify(`${resolved.method} ${resolved.url}: ${entry.response.error}`, 'warn');
      }
    } catch (error) {
      entry.response = null;
      this.host.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.sending = false;
      this.host.refresh();
    }
  }

  clear(): void {
    this.entries = [];
    this.selected = 0;
    this.host.refresh();
  }

  // --- Pintado --------------------------------------------------------------------------------

  render(container: HTMLElement): void {
    clear(container);

    if (this.entries.length === 0) {
      container.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          el('div', { className: 'empty-state-icon' }, icon('send', { size: 28 })),
          el('div', { text: 'Abre un archivo .http y pulsa "Enviar petición" sobre cualquier bloque.' }),
          el('div', {
            className: 'empty-state-hint',
            text: 'Sobre un endpoint de C# también aparece una lente para generar la prueba.',
          }),
        ),
      );
      return;
    }

    const entry = this.entries[this.selected] ?? this.entries[0]!;

    container.appendChild(this.renderHead(entry));
    container.appendChild(this.renderTabs(entry));
    container.appendChild(this.renderBody(entry));
  }

  private renderHead(entry: Entry): HTMLElement {
    const response = entry.response;
    const tone = response === null ? 'info' : response.error !== null ? 'error' : statusTone(response.status);

    const head = el(
      'div',
      { className: 'http-head' },
      el('span', { className: 'http-method', text: entry.request.method }),
      el('span', { className: 'http-url', text: entry.request.url, title: entry.request.url }),
    );

    if (this.sending && entry === this.entries[0]) {
      head.append(el('span', { className: 'spinner' }), el('span', { className: 'http-meta', text: 'enviando…' }));
    } else if (response !== null) {
      head.append(
        el('span', {
          className: `http-status ${tone}`,
          text: response.error !== null ? 'sin respuesta' : `${response.status} ${response.statusText}`.trim(),
        }),
        el('span', { className: 'http-meta', text: formatDuration(response.durationMs) }),
        el('span', { className: 'http-meta', text: formatBytes(response.sizeBytes) }),
      );
    }

    head.appendChild(
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Vaciar el historial de respuestas',
          on: { click: () => this.clear() },
        },
        icon('trash', { size: 14 }),
      ),
    );

    return head;
  }

  private renderTabs(entry: Entry): HTMLElement {
    const headerCount = entry.response?.headers.length ?? 0;

    const tab = (id: 'body' | 'headers' | 'request', label: string): HTMLElement =>
      el(
        'button',
        {
          className: `chip${this.tab === id ? ' active' : ''}`,
          on: {
            click: () => {
              this.tab = id;
              this.host.refresh();
            },
          },
        },
        el('span', { text: label }),
      );

    const row = el(
      'div',
      { className: 'http-tabs' },
      tab('body', 'Cuerpo'),
      tab('headers', `Cabeceras${headerCount > 0 ? ` (${headerCount})` : ''}`),
      tab('request', 'Petición'),
    );

    // Historial: las últimas peticiones enviadas, para comparar sin volver a enviarlas.
    if (this.entries.length > 1) {
      const history = el('div', { className: 'http-history' });
      this.entries.forEach((candidate, index) => {
        history.appendChild(
          el('button', {
            className: `chip${index === this.selected ? ' active' : ''}`,
            title: `${candidate.request.method} ${candidate.request.url}`,
            text: candidate.label,
            on: {
              click: () => {
                this.selected = index;
                this.host.refresh();
              },
            },
          }),
        );
      });
      row.appendChild(history);
    }

    return row;
  }

  private renderBody(entry: Entry): HTMLElement {
    const response = entry.response;

    if (response === null) {
      return el('div', { className: 'http-body output', text: this.sending ? '' : 'Sin respuesta todavía.' });
    }

    if (this.tab === 'request') {
      const lines = [
        `${entry.request.method} ${entry.request.url}`,
        ...entry.request.headers.map((header) => `${header.name}: ${header.value}`),
        ...(entry.request.body === null ? [] : ['', entry.request.body]),
      ];
      return el('pre', { className: 'http-body output', text: lines.join('\n') });
    }

    if (this.tab === 'headers') {
      const list = el('div', { className: 'http-headers' });
      for (const header of response.headers) {
        list.append(
          el('span', { className: 'http-header-name', text: header.name }),
          el('span', { className: 'http-header-value', text: header.value }),
        );
      }
      return list;
    }

    if (response.error !== null) {
      return el(
        'div',
        { className: 'http-body' },
        el(
          'div',
          { className: 'notice warn' },
          icon('alert-triangle', { size: 15 }),
          el('span', { text: response.error }),
        ),
      );
    }

    return el('pre', {
      className: 'http-body output',
      text: response.body === '' ? '(respuesta sin cuerpo)' : response.body,
    });
  }
}
