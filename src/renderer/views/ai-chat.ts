/**
 * Panel de chat del asistente, en la barra lateral.
 *
 * Comparte contenedor con el explorador, NuGet y los ajustes, así que sigue la misma regla que
 * ellos: sólo pinta si está visible. Sin ese flag, un cambio de solución hace que se pinten dos
 * vistas sobre el mismo hueco y gana la última (trampa ya documentada en CLAUDE.md).
 *
 * El texto llega token a token por un evento del proceso principal. Repintar el log entero en
 * cada delta sería insostenible —son decenas de eventos por segundo—, así que el mensaje que se
 * está escribiendo tiene su propio nodo y sólo se le añade texto; el repintado completo se hace
 * una única vez, al terminar, para convertir las vallas ```` ``` ```` en bloques de código con
 * sus acciones.
 */
import type { AiContext, AiStatus, AiTask } from '../../shared/ai.js';
import { extractCodeBlocks } from '../../shared/ai-diff.js';
import { byId, clear, el } from '../dom.js';
import { icon } from '../icons.js';

export interface AiChatHost {
  /** Contexto RAG del momento: archivo activo, selección, arquitectura y diagnósticos. */
  buildContext(): AiContext;
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  openSettings(): void;
  /** Sustituye la selección del editor (o inserta en el cursor) por el código dado. */
  applyToEditor(code: string): void;
  /** true si hay un editor abierto al que aplicar código. */
  hasEditor(): boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Mensaje que todavía se está recibiendo. */
  streaming: boolean;
  error: string | null;
}

const PLACEHOLDER = 'Pregunta algo sobre el código abierto…';

export class AiChatView {
  private visible = false;
  private status: AiStatus | null = null;
  private architecture = 'sin determinar';

  private readonly messages: ChatMessage[] = [];

  /** Petición en curso. Null cuando no hay ninguna. */
  private activeRequest: string | null = null;

  /** Nodo del mensaje que se está recibiendo, para añadirle texto sin repintar el log. */
  private streamingBody: HTMLElement | null = null;
  private logElement: HTMLElement | null = null;

  private draft = '';

  constructor(private readonly host: AiChatHost) {}

  // --- Estado ------------------------------------------------------------------------------

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.render();
      // El foco en el compositor: si se abre el panel es para escribir.
      window.setTimeout(() => this.inputElement()?.focus(), 0);
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  setStatus(status: AiStatus): void {
    this.status = status;
    if (this.visible) this.render();
  }

  setArchitecture(architecture: string): void {
    this.architecture = architecture;
    if (this.visible) this.renderStatusLine();
  }

  isBusy(): boolean {
    return this.activeRequest !== null;
  }

  ownsRequest(requestId: string): boolean {
    return this.activeRequest === requestId;
  }

  // --- Conversación ------------------------------------------------------------------------

  /** Empieza una conversación nueva. Cancela lo que hubiera en marcha. */
  reset(): void {
    if (this.activeRequest) void window.dotforge.ai.cancel(this.activeRequest);
    this.activeRequest = null;
    this.streamingBody = null;
    this.messages.length = 0;
    if (this.visible) this.render();
  }

  /**
   * Manda un mensaje.
   *
   * `task` decide las instrucciones de formato del prompt de sistema: una explicación quiere
   * prosa y una generación de pruebas quiere un único archivo listo para guardar.
   */
  async send(prompt: string, task: AiTask = 'chat'): Promise<void> {
    const text = prompt.trim();
    if (text === '') return;

    if (this.activeRequest) {
      this.host.notify('El asistente todavía está respondiendo. Detén la respuesta o espera.', 'warn');
      return;
    }

    if (this.status && !this.status.ready) {
      this.host.notify(this.status.message ?? 'El asistente no está configurado.', 'warn');
      this.host.openSettings();
      return;
    }

    this.messages.push({ role: 'user', content: text, streaming: false, error: null });
    this.messages.push({ role: 'assistant', content: '', streaming: true, error: null });
    this.draft = '';
    this.render();

    const requestId = crypto.randomUUID();
    this.activeRequest = requestId;

    try {
      await window.dotforge.ai.send({
        requestId,
        task,
        context: this.host.buildContext(),
        messages: this.messages
          .filter((message) => !message.streaming)
          .map((message) => ({ role: message.role, content: message.content })),
      });
    } catch (error) {
      this.finishWithError(requestId, error instanceof Error ? error.message : String(error));
    }
  }

  /** Texto recibido. Se añade al nodo en curso sin repintar nada más. */
  appendDelta(requestId: string, text: string): void {
    if (requestId !== this.activeRequest) return;

    const message = this.messages[this.messages.length - 1];
    if (!message || !message.streaming) return;

    message.content += text;

    if (this.streamingBody) {
      this.streamingBody.textContent = message.content;
      this.scrollToEnd();
    }
  }

  /** Cierre del stream: éxito, cancelación o error. */
  finish(requestId: string, reason: 'done' | 'cancelled' | 'error', message: string | null): void {
    if (requestId !== this.activeRequest) return;

    const last = this.messages[this.messages.length - 1];
    this.activeRequest = null;
    this.streamingBody = null;

    if (!last) return;
    last.streaming = false;

    if (reason === 'error') {
      last.error = message ?? 'error desconocido';
      this.host.notify(`Asistente: ${last.error}`, 'error');
    } else if (reason === 'cancelled' && last.content === '') {
      this.messages.pop();
    }

    this.render();
  }

  stop(): void {
    if (!this.activeRequest) return;
    void window.dotforge.ai.cancel(this.activeRequest);
  }

  private finishWithError(requestId: string, message: string): void {
    this.finish(requestId, 'error', message.replace(/^Error invoking remote method '[^']+':\s*/, ''));
  }

  // --- Pintado -----------------------------------------------------------------------------

  render(): void {
    if (!this.visible) return;

    const container = byId('sidebar-content');
    clear(container);
    byId('sidebar-title').textContent = 'DotForge AI';

    const actions = byId('sidebar-actions');
    clear(actions);
    actions.appendChild(
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Conversación nueva',
          attrs: { 'aria-label': 'Conversación nueva' },
          on: { click: () => this.reset() },
        },
        icon('plus', { size: 14 }),
      ),
    );

    const panel = el('div', { className: 'ai-panel' });
    panel.append(this.statusLine(), this.logContainer(), this.quickActions(), this.composer());

    container.appendChild(panel);
    this.scrollToEnd();
  }

  private statusLine(): HTMLElement {
    const line = el('div', { className: 'ai-status', id: 'ai-status-line' });
    this.fillStatusLine(line);
    return line;
  }

  private renderStatusLine(): void {
    const line = document.getElementById('ai-status-line');
    if (line) {
      clear(line);
      this.fillStatusLine(line);
    }
  }

  private fillStatusLine(line: HTMLElement): void {
    const status = this.status;

    if (!status || !status.ready) {
      line.classList.add('warn');
      line.append(
        icon('alert-circle', { size: 13 }),
        el('span', { text: status?.message ?? 'Comprobando el asistente…' }),
        el('button', { className: 'link-btn', text: 'Configurar', on: { click: () => this.host.openSettings() } }),
      );
      return;
    }

    line.classList.remove('warn');
    line.append(
      icon('sparkles', { size: 13, className: 'ai-accent' }),
      el('span', { className: 'ai-model', text: `${status.providerLabel} · ${status.model}`, title: status.model }),
      el('span', { className: 'ai-arch', text: this.architecture, title: 'Arquitectura detectada de la solución' }),
    );
  }

  private logContainer(): HTMLElement {
    const log = el('div', { className: 'ai-log' });
    this.logElement = log;

    if (this.messages.length === 0) {
      log.appendChild(this.emptyState());
      return log;
    }

    for (const message of this.messages) log.appendChild(this.messageNode(message));
    return log;
  }

  private emptyState(): HTMLElement {
    return el(
      'div',
      { className: 'ai-empty' },
      icon('sparkles', { size: 26, className: 'ai-accent' }),
      el('h4', { text: 'Asistente de arquitectura' }),
      el('p', {
        text:
          'Conoce la solución abierta, su arquitectura y los errores de compilación activos. ' +
          'Responde respetando las reglas de la capa en la que estés trabajando.',
      }),
      el('p', {
        className: 'ai-hint',
        text: 'Selecciona código y pulsa Ctrl+I para pedir un cambio con vista previa.',
      }),
    );
  }

  private messageNode(message: ChatMessage): HTMLElement {
    const body = el('div', { className: 'ai-body' });

    if (message.streaming) {
      body.textContent = message.content;
      body.classList.add('streaming');
      this.streamingBody = body;
    } else {
      this.fillRichText(body, message.content);
    }

    const node = el(
      'article',
      { className: `ai-msg ${message.role}` },
      el(
        'header',
        { className: 'ai-role' },
        icon(message.role === 'user' ? 'circle-dot' : 'sparkles', { size: 12 }),
        el('span', { text: message.role === 'user' ? 'Tú' : 'DotForge AI' }),
      ),
      body,
    );

    if (message.error) {
      node.appendChild(el('p', { className: 'ai-error', text: message.error }));
    }

    return node;
  }

  /**
   * Pinta el texto de una respuesta separando prosa y bloques de código.
   *
   * No hay renderizador de Markdown completo a propósito: el 95% de lo que aporta una respuesta
   * de código son los bloques, y un renderizador de HTML es superficie de ataque a cambio de
   * poner algunas negritas. La prosa se pinta con `textContent` y salto de línea respetado.
   */
  private fillRichText(container: HTMLElement, text: string): void {
    const blocks = extractCodeBlocks(text);

    if (blocks.length === 0) {
      container.appendChild(el('p', { className: 'ai-prose', text }));
      return;
    }

    // Se recorre el texto buscando cada bloque por su contenido para conservar el orden y la
    // prosa intercalada, sin volver a parsear las vallas a mano.
    let rest = text;
    for (const block of blocks) {
      const index = rest.indexOf(block.code);
      const before = index === -1 ? '' : rest.slice(0, index).replace(/```[A-Za-z0-9_+#.-]*\s*$/, '').trim();

      if (before !== '') container.appendChild(el('p', { className: 'ai-prose', text: before }));
      container.appendChild(this.codeNode(block.language, block.code));

      rest = index === -1 ? rest : rest.slice(index + block.code.length);
    }

    const tail = rest.replace(/^\s*```/, '').trim();
    if (tail !== '') container.appendChild(el('p', { className: 'ai-prose', text: tail }));
  }

  private codeNode(language: string, code: string): HTMLElement {
    const actions = el(
      'div',
      { className: 'ai-code-actions' },
      el(
        'button',
        {
          className: 'btn ghost small',
          title: 'Copiar al portapapeles',
          on: { click: () => void navigator.clipboard.writeText(code).then(() => this.host.notify('Código copiado.', 'ok')) },
        },
        icon('download', { size: 12 }),
        'Copiar',
      ),
    );

    if (this.host.hasEditor()) {
      actions.appendChild(
        el(
          'button',
          {
            className: 'btn ghost small',
            title: 'Sustituir la selección del editor por este código',
            on: { click: () => this.host.applyToEditor(code) },
          },
          icon('check', { size: 12 }),
          'Aplicar',
        ),
      );
    }

    return el(
      'div',
      { className: 'ai-code' },
      el(
        'div',
        { className: 'ai-code-head' },
        el('span', { className: 'ai-code-lang', text: language === '' ? 'código' : language }),
        actions,
      ),
      el('pre', {}, el('code', { text: code })),
    );
  }

  private quickActions(): HTMLElement {
    const row = el('div', { className: 'ai-quick' });

    const action = (label: string, prompt: string, task: AiTask): HTMLElement =>
      el('button', {
        className: 'chip-btn',
        text: label,
        disabled: this.activeRequest !== null,
        on: { click: () => void this.send(prompt, task) },
      });

    row.append(
      action('Explicar', 'Explica el código del archivo activo (o la selección, si la hay).', 'explain'),
      action('Pruebas xUnit', 'Genera las pruebas xUnit del código seleccionado o del archivo activo.', 'tests'),
      action('Revisar arquitectura', 'Revisa este archivo y dime si viola alguna regla de la arquitectura del proyecto.', 'chat'),
    );

    return row;
  }

  private composer(): HTMLElement {
    const input = el('textarea', {
      className: 'ai-input',
      placeholder: PLACEHOLDER,
      attrs: { rows: '3', 'aria-label': 'Mensaje para el asistente' },
    }) as HTMLTextAreaElement;

    input.value = this.draft;
    input.addEventListener('input', () => {
      this.draft = input.value;
    });

    input.addEventListener('keydown', (event) => {
      // Enter envía; Shift+Enter hace salto de línea, como en cualquier chat.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.send(input.value);
      }
    });

    const busy = this.activeRequest !== null;

    const button = busy
      ? el(
          'button',
          { className: 'ai-send stop', title: 'Detener la respuesta', on: { click: () => this.stop() } },
          icon('stop', { size: 14 }),
        )
      : el(
          'button',
          { className: 'ai-send', title: 'Enviar (Enter)', on: { click: () => void this.send(input.value) } },
          icon('send', { size: 14 }),
        );

    return el('div', { className: 'ai-composer' }, input, button);
  }

  private inputElement(): HTMLTextAreaElement | null {
    return document.querySelector<HTMLTextAreaElement>('.ai-input');
  }

  private scrollToEnd(): void {
    if (this.logElement) this.logElement.scrollTop = this.logElement.scrollHeight;
  }
}
