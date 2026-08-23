/**
 * Asistente en línea (Ctrl+I / Cmd+I).
 *
 * Se pide un cambio en lenguaje natural sobre el código seleccionado y se enseña **qué va a
 * pasar** antes de que pase. La vista previa no es un texto aparte: el cambio se aplica de verdad
 * al modelo de Monaco, se resalta lo nuevo y se enseña lo que desaparece. Aceptar sólo quita los
 * resaltes; descartar restaura el texto original con otra edición, así que el historial de
 * deshacer sigue siendo coherente en los dos caminos.
 *
 * El widget es un `IContentWidget` de Monaco y no un div flotante: así sigue a la línea cuando se
 * hace scroll, en vez de quedarse clavado en unas coordenadas que dejan de significar nada.
 */
import type * as MonacoApi from 'monaco-editor';

import type { AiContext } from '../../shared/ai.js';
import { diffLines, proposedCode, reindent, summarizeDiff, type DiffLine } from '../../shared/ai-diff.js';
import { clear, el } from '../dom.js';
import { icon } from '../icons.js';
import { getMonaco } from '../monaco-setup.js';

export interface InlineAssistantHost {
  getEditor(): MonacoApi.editor.IStandaloneCodeEditor | null;
  /** Contexto RAG del estado actual del editor y de la solución. */
  buildContext(): AiContext;
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  openSettings(): void;
  /** false si falta configurar el proveedor: mejor decirlo antes de abrir el widget. */
  isReady(): boolean;
}

type Phase = 'prompt' | 'running' | 'preview';

const WIDGET_ID = 'dotforge.ai.inline';

/** Sugerencias del desplegable. Son las peticiones que de verdad se repiten en .NET. */
const PRESETS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: 'Extraer a un objeto de valor (DDD)', prompt: 'Mueve esta lógica a un Value Object siguiendo DDD.' },
  { label: 'Convertir a LINQ', prompt: 'Reescribe este bucle usando LINQ, sin cambiar el comportamiento.' },
  { label: 'Añadir guardas de argumentos', prompt: 'Añade validación de argumentos idiomática de .NET al principio del método.' },
  { label: 'Hacerlo asíncrono', prompt: 'Convierte este código a asíncrono con async/await y CancellationToken.' },
  { label: 'Documentar con XML doc', prompt: 'Añade comentarios de documentación XML en español a los miembros públicos.' },
];

export class InlineAssistant {
  private phase: Phase = 'prompt';
  private widget: MonacoApi.editor.IContentWidget | null = null;
  private container: HTMLElement | null = null;

  private requestId: string | null = null;
  private response = '';

  /** Estado de la vista previa: qué había, qué se propone y dónde. */
  private original = '';
  private originalRange: MonacoApi.Range | null = null;
  private previewRange: MonacoApi.Range | null = null;
  private decorations: string[] = [];
  private diff: DiffLine[] = [];
  private draft = '';

  constructor(private readonly host: InlineAssistantHost) {}

  ownsRequest(requestId: string): boolean {
    return this.requestId === requestId;
  }

  isOpen(): boolean {
    return this.widget !== null;
  }

  /** Abre el widget sobre la selección actual (o sobre la línea del cursor si no hay). */
  open(): void {
    const editor = this.host.getEditor();
    const model = editor?.getModel();
    if (!editor || !model) {
      this.host.notify('Abre un archivo antes de usar el asistente en línea.', 'warn');
      return;
    }

    if (!this.host.isReady()) {
      this.host.notify('Configura el asistente de IA antes de usarlo.', 'warn');
      this.host.openSettings();
      return;
    }

    this.close();

    const monaco = getMonaco();
    const selection = editor.getSelection();
    if (!selection) return;

    // Sin selección se trabaja sobre la línea del cursor: pedir "convierte esto a LINQ" con el
    // cursor dentro del bucle es lo que uno espera que funcione.
    const range = selection.isEmpty()
      ? new monaco.Range(
          selection.startLineNumber,
          1,
          selection.startLineNumber,
          model.getLineMaxColumn(selection.startLineNumber),
        )
      : new monaco.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn,
        );

    this.originalRange = range;
    this.original = model.getValueInRange(range);
    this.phase = 'prompt';
    this.response = '';
    this.mountWidget(editor, range);
  }

  /** Cierra el widget. Si había vista previa sin aceptar, se descarta. */
  close(): void {
    if (this.phase === 'preview') this.reject();
    this.dispose();
  }

  private dispose(): void {
    const editor = this.host.getEditor();

    if (this.widget && editor) editor.removeContentWidget(this.widget);
    this.widget = null;
    this.container = null;

    if (this.requestId) {
      void window.dotforge.ai.cancel(this.requestId);
      this.requestId = null;
    }

    this.clearDecorations();
    this.phase = 'prompt';
    this.diff = [];
    this.draft = '';
    editor?.focus();
  }

  // --- Streaming ---------------------------------------------------------------------------

  appendDelta(requestId: string, text: string): void {
    if (requestId !== this.requestId) return;
    this.response += text;

    const progress = this.container?.querySelector('.ai-inline-progress');
    if (progress) progress.textContent = `Generando… ${this.response.length} caracteres`;
  }

  finish(requestId: string, reason: 'done' | 'cancelled' | 'error', message: string | null): void {
    if (requestId !== this.requestId) return;
    this.requestId = null;

    if (reason === 'cancelled') {
      this.dispose();
      return;
    }

    if (reason === 'error') {
      this.phase = 'prompt';
      this.renderWidget(message ?? 'El asistente no ha podido responder.');
      return;
    }

    const code = proposedCode(this.response);
    if (code === null) {
      this.phase = 'prompt';
      this.renderWidget('La respuesta no traía ningún bloque de código. Prueba a concretar más la petición.');
      return;
    }

    // Si la selección empezaba en la columna 1, la sangría de la primera línea es parte de lo que
    // se sustituye y hay que reponerla; si empezaba más allá, ya está en el archivo.
    this.applyPreview(reindent(this.original, code, this.originalRange?.startColumn === 1));
  }

  // --- Vista previa ------------------------------------------------------------------------

  private applyPreview(proposal: string): void {
    const editor = this.host.getEditor();
    const model = editor?.getModel();
    const range = this.originalRange;
    if (!editor || !model || !range) return;

    this.diff = diffLines(this.original, proposal);
    const summary = summarizeDiff(this.diff);

    if (summary.identical) {
      this.phase = 'prompt';
      this.renderWidget('La propuesta es idéntica al código actual: no hay nada que cambiar.');
      return;
    }

    const monaco = getMonaco();

    // La edición pasa por el modelo (no por `setValue`) para que se pueda deshacer con Ctrl+Z
    // igual que cualquier otro cambio del usuario.
    editor.executeEdits('dotforge.ai', [{ range, text: proposal, forceMoveMarkers: true }]);

    const lines = proposal.split('\n');
    const lastLine = range.startLineNumber + lines.length - 1;
    const lastColumn = (lines[lines.length - 1]?.length ?? 0) + (lines.length === 1 ? range.startColumn : 1);

    this.previewRange = new monaco.Range(range.startLineNumber, range.startColumn, lastLine, lastColumn);

    this.decorations = model.deltaDecorations(this.decorations, [
      {
        range: this.previewRange,
        options: { isWholeLine: true, className: 'ai-diff-added', linesDecorationsClassName: 'ai-diff-gutter' },
      },
    ]);

    this.phase = 'preview';
    this.renderWidget(null);
    editor.revealRangeInCenterIfOutsideViewport(this.previewRange);
  }

  private clearDecorations(): void {
    const model = this.host.getEditor()?.getModel();
    if (model && this.decorations.length > 0) model.deltaDecorations(this.decorations, []);
    this.decorations = [];
  }

  accept(): void {
    if (this.phase !== 'preview') return;
    this.phase = 'prompt';
    this.clearDecorations();
    this.host.notify('Cambio aplicado. Ctrl+Z lo deshace.', 'ok');
    this.dispose();
  }

  reject(): void {
    const editor = this.host.getEditor();
    const range = this.previewRange;

    if (editor && range) {
      editor.executeEdits('dotforge.ai', [{ range, text: this.original, forceMoveMarkers: true }]);
    }

    this.phase = 'prompt';
    this.previewRange = null;
    this.clearDecorations();
  }

  private discard(): void {
    this.reject();
    this.dispose();
  }

  // --- Widget ------------------------------------------------------------------------------

  private mountWidget(editor: MonacoApi.editor.IStandaloneCodeEditor, range: MonacoApi.Range): void {
    const monaco = getMonaco();
    const container = el('div', { className: 'ai-inline' });
    this.container = container;

    const widget: MonacoApi.editor.IContentWidget = {
      getId: () => WIDGET_ID,
      getDomNode: () => container,
      getPosition: () => ({
        position: { lineNumber: range.startLineNumber, column: 1 },
        preference: [
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
          monaco.editor.ContentWidgetPositionPreference.BELOW,
        ],
      }),
    };

    this.widget = widget;
    editor.addContentWidget(widget);
    this.renderWidget(null);
  }

  private renderWidget(error: string | null): void {
    const container = this.container;
    if (!container) return;

    clear(container);
    container.append(this.header(), ...(this.phase === 'preview' ? this.previewBody() : this.promptBody(error)));

    if (this.phase === 'prompt') {
      window.setTimeout(() => container.querySelector<HTMLInputElement>('.ai-inline-input')?.focus(), 0);
    }
  }

  private header(): HTMLElement {
    const title =
      this.phase === 'preview' ? 'Vista previa del cambio' : this.phase === 'running' ? 'Pensando…' : 'Asistente en línea';

    return el(
      'header',
      { className: 'ai-inline-head' },
      icon('sparkles', { size: 13, className: 'ai-accent' }),
      el('span', { text: title }),
      el(
        'button',
        { className: 'icon-btn', title: 'Cerrar (Esc)', on: { click: () => this.discard() } },
        icon('x', { size: 12 }),
      ),
    );
  }

  private promptBody(error: string | null): HTMLElement[] {
    const input = el('input', {
      className: 'ai-inline-input',
      type: 'text',
      placeholder: 'Describe el cambio: "mueve esto a un Value Object", "crea la prueba xUnit"…',
      value: this.draft,
    }) as HTMLInputElement;

    input.addEventListener('input', () => {
      this.draft = input.value;
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.submit(input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.discard();
      }
    });

    const nodes: HTMLElement[] = [
      el(
        'div',
        { className: 'ai-inline-row' },
        input,
        el(
          'button',
          {
            className: 'btn primary small',
            title: 'Pedir el cambio (Enter)',
            disabled: this.phase === 'running',
            on: { click: () => void this.submit(input.value) },
          },
          this.phase === 'running' ? 'Generando…' : 'Generar',
        ),
      ),
    ];

    if (this.phase === 'running') {
      nodes.push(
        el(
          'div',
          { className: 'ai-inline-foot' },
          el('span', { className: 'ai-inline-progress', text: 'Generando…' }),
          el('button', { className: 'btn ghost small', text: 'Detener', on: { click: () => this.discard() } }),
        ),
      );
      return nodes;
    }

    const presets = el('div', { className: 'ai-inline-presets' });
    for (const preset of PRESETS) {
      presets.appendChild(
        el('button', {
          className: 'chip-btn',
          text: preset.label,
          on: { click: () => void this.submit(preset.prompt) },
        }),
      );
    }
    nodes.push(presets);

    if (error) nodes.push(el('p', { className: 'ai-inline-error', text: error }));

    return nodes;
  }

  private previewBody(): HTMLElement[] {
    const summary = summarizeDiff(this.diff);

    const removed = this.diff.filter((line) => line.kind === 'remove');
    const list = el('div', { className: 'ai-inline-diff' });

    for (const line of removed.slice(0, 12)) {
      list.appendChild(el('div', { className: 'ai-diff-line removed', text: `- ${line.text}` }));
    }
    if (removed.length > 12) {
      list.appendChild(el('div', { className: 'ai-diff-more', text: `… y ${removed.length - 12} líneas más` }));
    }

    return [
      el(
        'div',
        { className: 'ai-inline-summary' },
        el('span', { className: 'ai-count added', text: `+${summary.added}` }),
        el('span', { className: 'ai-count removed', text: `-${summary.removed}` }),
        el('span', { className: 'ai-inline-hint', text: 'lo nuevo ya está en el editor, resaltado' }),
      ),
      list,
      el(
        'div',
        { className: 'ai-inline-actions' },
        el(
          'button',
          { className: 'btn primary small', title: 'Aceptar (Enter)', on: { click: () => this.accept() } },
          icon('check', { size: 12 }),
          'Aceptar',
        ),
        el(
          'button',
          { className: 'btn ghost small', title: 'Descartar (Esc)', on: { click: () => this.discard() } },
          icon('x', { size: 12 }),
          'Descartar',
        ),
      ),
    ];
  }

  /** Enter y Escape mientras la vista previa está abierta, desde el atajo global. */
  handleKey(key: string): boolean {
    if (this.phase !== 'preview') {
      if (key === 'Escape' && this.isOpen()) {
        this.discard();
        return true;
      }
      return false;
    }

    if (key === 'Enter') {
      this.accept();
      return true;
    }
    if (key === 'Escape') {
      this.discard();
      return true;
    }
    return false;
  }

  private async submit(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (text === '' || this.phase === 'running') return;

    this.draft = text;
    this.response = '';
    this.phase = 'running';
    this.renderWidget(null);

    const requestId = crypto.randomUUID();
    this.requestId = requestId;

    try {
      await window.dotforge.ai.send({
        requestId,
        task: 'edit',
        context: this.host.buildContext(),
        messages: [
          {
            role: 'user',
            content:
              `${text}\n\nDevuelve únicamente el código que sustituye al fragmento seleccionado, ` +
              'en un solo bloque, sin explicaciones.',
          },
        ],
      });
    } catch (error) {
      this.finish(requestId, 'error', error instanceof Error ? error.message : String(error));
    }
  }
}
