/**
 * Editor con pestañas.
 *
 * Un único `IStandaloneCodeEditor` que va cambiando de modelo, en lugar de un editor por pestaña:
 * abrir veinte archivos así cuesta veinte modelos, no veinte editores con sus widgets y workers.
 * El estado de scroll y cursor se guarda por pestaña para que volver a una sea instantáneo.
 */
import type * as MonacoApi from 'monaco-editor';

import type { AppSettings, EditorDocument, GitFileDiff } from '../../shared/contracts.js';
import { diffKey } from '../../shared/git.js';
import { baseName, byId, clear, el } from '../dom.js';
import { isReadOnly, PendingOperations, readOnlyMessage, type EditorContext } from '../editor-state.js';
import { didChange, didClose, didOpen, didSave } from '../lsp-bridge.js';
import { iconForFile } from '../file-icons.js';
import { icon } from '../icons.js';
import { installTagAutoClose } from '../languages/razor.js';
import { DARK_THEME, getMonaco, LIGHT_THEME } from '../monaco-setup.js';

export interface OpenTab {
  path: string;
  name: string;
  languageId: string;
  model: MonacoApi.editor.ITextModel;
  viewState: MonacoApi.editor.ICodeEditorViewState | null;
  dirty: boolean;
  savedVersionId: number;
  mtimeMs: number;
}

/**
 * Pestaña de comparación abierta desde el control de código fuente.
 *
 * Se guarda aparte de las pestañas de archivo porque no es un archivo: no se guarda, no ensucia,
 * no habla con el servidor de lenguaje y sus dos modelos son de sólo lectura.
 */
export interface DiffTab {
  key: string;
  title: string;
  name: string;
  /** Ruta absoluta del archivo real, para poder abrirlo desde la comparación. */
  path: string;
  original: MonacoApi.editor.ITextModel;
  modified: MonacoApi.editor.ITextModel;
}

export interface EditorHost {
  /** Clic en el margen izquierdo: poner o quitar un breakpoint. */
  onGutterClick(path: string, line: number): void;
  onDirtyChanged(): void;
  onActiveChanged(tab: OpenTab | null): void;
  onCursorChanged(line: number, column: number): void;
  onSaved(tab: OpenTab): void;
  /**
   * Algo ha fallado en un camino asíncrono del editor.
   *
   * Existe porque `void this.saveActive()` no tenía a quién contárselo: un `writeFile` que falla
   * —en Windows basta con que MSBuild tenga el archivo abierto compilando— acababa en un rechazo
   * sin gestionar, la pestaña seguía sucia y nadie se enteraba hasta cerrar el IDE.
   */
  onEditorError(message: string): void;
}

export class EditorView {
  private editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
  private readonly tabs = new Map<string, OpenTab>();
  private activePath: string | null = null;

  /** Editor de diferencias, creado la primera vez que se abre una comparación. */
  private diffEditor: MonacoApi.editor.IStandaloneDiffEditor | null = null;
  private readonly diffTabs = new Map<string, DiffTab>();
  private activeDiff: string | null = null;
  private autoSaveTimer: number | undefined;
  private settings: AppSettings | null = null;
  private readonly disposables: MonacoApi.IDisposable[] = [];

  /**
   * Operaciones asíncronas en vuelo (guardado, formateo).
   *
   * No bloquean la escritura: están contadas para que su `finally` sea uno de los puntos donde se
   * recalcula el estado del editor, y para poder afirmar que ninguna se queda colgada.
   */
  private readonly pending = new PendingOperations();

  /** Ids de decoración por archivo, necesarios para reemplazarlas sin duplicar. */
  private readonly breakpointDecorations = new Map<string, string[]>();
  private readonly executionDecorations = new Map<string, string[]>();

  constructor(private readonly host: EditorHost) {}

  /** Crea el editor. Debe llamarse después de que Monaco esté cargado. */
  mount(settings: AppSettings): void {
    const monaco = getMonaco();
    this.settings = settings;

    this.editor = monaco.editor.create(byId('editor-host'), {
      value: '',
      language: 'plaintext',
      theme: settings.theme === 'dotforge-light' ? LIGHT_THEME : DARK_THEME,
      automaticLayout: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      fontLigatures: true,
      tabSize: settings.tabSize,
      wordWrap: settings.wordWrap ? 'on' : 'off',
      minimap: { enabled: settings.minimap },
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: false,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      suggestSelection: 'first',
      suggest: { showStatusBar: true, preview: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      formatOnType: true,
      linkedEditing: true,
      padding: { top: 8 },
      // Margen de glifos: es donde se pintan y se pulsan los breakpoints.
      glyphMargin: true,
      stickyScroll: { enabled: true },
      inlayHints: { enabled: 'on' },
      occurrencesHighlight: 'singleFile',
      renderLineHighlight: 'all',
      /**
       * Resaltado semántico encendido explícitamente.
       *
       * El valor por defecto es `configuredByTheme`, y un tema definido con `defineTheme` no lo
       * activa: el proveedor de tokens se registra, el servidor responde y no se ve absolutamente
       * nada. Es el tipo de ajuste que parece redundante hasta que se pasa media tarde buscando
       * por qué Roslyn "no manda colores".
       */
      'semanticHighlighting.enabled': true,
      // La lente de código la usan las pruebas ([Fact]/[Theory]), los endpoints y los `.http`.
      codeLens: true,
    });

    this.disposables.push(installTagAutoClose(monaco, this.editor));

    this.disposables.push(
      this.editor.onMouseDown((event) => {
        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;

        const line = event.target.position?.lineNumber;
        const tab = this.activeTab();
        if (line !== undefined && tab) this.host.onGutterClick(tab.path, line);
      }),
    );

    this.disposables.push(
      this.editor.onDidChangeCursorPosition((event) => {
        this.host.onCursorChanged(event.position.lineNumber, event.position.column);
      }),
    );

    // Ctrl/Cmd+S dentro del editor: Monaco se come el atajo antes que el menú.
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void this.saveActive();
    });

    this.updateVisibility();
    this.refreshEditability();
  }

  /**
   * Contexto que decide si se puede escribir. Ver `editor-state.ts`.
   */
  private editorContext(): EditorContext {
    return {
      hasOpenFile: this.activePath !== null,
      showingDiff: this.activeDiff !== null,
      pending: this.pending.names(),
    };
  }

  /**
   * Reconcilia el estado de sólo lectura con el contexto real.
   *
   * Es el punto que evita el fallo que se arregla aquí: en vez de suponer que el editor sigue
   * escribible, se recalcula. Se llama al montar, al abrir, al activar, al cerrar, al entrar y
   * salir de una comparación, y en el `finally` de toda operación asíncrona — es decir, también
   * cuando esa operación ha fallado, que es justo cuando antes se quedaba todo a medias.
   */
  private refreshEditability(): void {
    if (!this.editor) return;

    const context = this.editorContext();
    const message = readOnlyMessage(context);

    this.editor.updateOptions({
      readOnly: isReadOnly(context),
      ...(message === null ? {} : { readOnlyMessage: { value: message } }),
    });
  }

  getEditor(): MonacoApi.editor.IStandaloneCodeEditor | null {
    return this.editor;
  }

  applySettings(settings: AppSettings): void {
    this.settings = settings;
    this.editor?.updateOptions({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      tabSize: settings.tabSize,
      wordWrap: settings.wordWrap ? 'on' : 'off',
      minimap: { enabled: settings.minimap },
      theme: settings.theme === 'dotforge-light' ? LIGHT_THEME : DARK_THEME,
    });

    this.diffEditor?.updateOptions({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
    });
  }

  listTabs(): OpenTab[] {
    return [...this.tabs.values()];
  }

  activeTab(): OpenTab | null {
    return this.activePath ? (this.tabs.get(this.activePath) ?? null) : null;
  }

  hasDirtyTabs(): boolean {
    return this.listTabs().some((tab) => tab.dirty);
  }

  /** Abre un archivo (o activa su pestaña si ya está abierto). */
  async open(
    document: EditorDocument,
    options: { line?: number; column?: number; length?: number } = {},
  ): Promise<void> {
    const monaco = getMonaco();
    let tab = this.tabs.get(document.path);

    if (!tab) {
      const uri = monaco.Uri.file(document.path);
      const existing = monaco.editor.getModel(uri);
      const model = existing ?? monaco.editor.createModel(document.content, document.languageId, uri);

      tab = {
        path: document.path,
        name: baseName(document.path),
        languageId: document.languageId,
        model,
        viewState: null,
        dirty: false,
        savedVersionId: model.getAlternativeVersionId(),
        mtimeMs: document.mtimeMs,
      };

      this.tabs.set(document.path, tab);

      const target = tab;
      this.disposables.push(
        model.onDidChangeContent(() => {
          const dirty = model.getAlternativeVersionId() !== target.savedVersionId;
          if (dirty !== target.dirty) {
            target.dirty = dirty;
            this.host.onDirtyChanged();
          }
          didChange(target.path, model.getValue());
          this.scheduleAutoSave(target);
        }),
      );

      // Sólo C# y Razor interesan al servidor de lenguaje.
      if (document.languageId === 'csharp' || document.languageId === 'razor') {
        didOpen(document.path, document.languageId, document.content);
      }
    }

    this.activate(document.path);

    if (options.line !== undefined && this.editor) {
      const column = options.column ?? 1;

      // Con longitud, lo encontrado queda seleccionado y no sólo señalado: es la diferencia entre
      // "esta es la línea" y "esto es lo que buscabas", y permite sustituirlo escribiendo encima.
      if (options.length !== undefined && options.length > 0) {
        this.editor.setSelection({
          startLineNumber: options.line,
          startColumn: column,
          endLineNumber: options.line,
          endColumn: column + options.length,
        });
      } else {
        this.editor.setPosition({ lineNumber: options.line, column });
      }

      this.editor.revealLineInCenter(options.line);
      this.editor.focus();
    }
  }

  activate(path: string): void {
    const tab = this.tabs.get(path);
    if (!tab || !this.editor) return;

    // Se guarda el estado de la pestaña que se abandona para poder restaurarlo tal cual.
    const previous = this.activeTab();
    if (previous && previous.path !== path) {
      previous.viewState = this.editor.saveViewState();
    }

    this.activePath = path;
    this.activeDiff = null;
    this.editor.setModel(tab.model);
    if (tab.viewState) this.editor.restoreViewState(tab.viewState);

    this.updateVisibility();
    this.refreshEditability();
    this.host.onActiveChanged(tab);
    this.editor.focus();
  }

  async close(path: string): Promise<boolean> {
    const tab = this.tabs.get(path);
    if (!tab) return true;

    if (tab.dirty) {
      const confirmed = window.confirm(`"${tab.name}" tiene cambios sin guardar.\n\n¿Cerrar de todos modos?`);
      if (!confirmed) return false;
    }

    didClose(tab.path);
    tab.model.dispose();
    this.tabs.delete(path);

    if (this.activePath === path) {
      const next = this.listTabs().at(-1) ?? null;
      this.activePath = next?.path ?? null;
      if (next) this.activate(next.path);
      else {
        this.editor?.setModel(null);
        this.updateVisibility();
        this.refreshEditability();
        this.host.onActiveChanged(null);
      }
    }

    this.host.onDirtyChanged();
    return true;
  }

  async closeAll(): Promise<void> {
    for (const tab of this.listTabs()) {
      await this.close(tab.path);
    }
  }

  async saveActive(): Promise<void> {
    const tab = this.activeTab();
    if (tab) await this.save(tab);
  }

  async saveAll(): Promise<void> {
    for (const tab of this.listTabs()) {
      if (tab.dirty) await this.save(tab);
    }
  }

  /**
   * Guarda una pestaña.
   *
   * Todo el cuerpo va dentro de un `try`, y la reconciliación del estado del editor dentro de su
   * `finally`. Los dos `await` de aquí fallan en la vida real: el formateo depende del servidor de
   * lenguaje, que puede estar reiniciándose, y `writeFile` falla en Windows en cuanto MSBuild tiene
   * el archivo abierto compilando. Antes, cualquiera de los dos dejaba el guardado a medias sin
   * decir nada —la pestaña seguía sucia— y, si el camino hubiera tocado el estado del editor, lo
   * habría dejado tocado para el resto de la sesión.
   */
  private async save(tab: OpenTab): Promise<void> {
    const done = this.pending.begin('saving');

    try {
      // El formateo actúa sobre el editor, y el editor sólo tiene cargado el modelo de la pestaña
      // activa. Guardando una que no lo es —el autoguardado de una pestaña de la que ya se ha
      // salido— formatearía el archivo equivocado, así que no se formatea.
      if (this.settings?.formatOnSave && tab.path === this.activePath) {
        await this.editor?.getAction('editor.action.formatDocument')?.run();
      }

      const content = tab.model.getValue();
      const { mtimeMs } = await window.dotforge.fs.writeFile(tab.path, content);

      tab.mtimeMs = mtimeMs;
      tab.savedVersionId = tab.model.getAlternativeVersionId();
      tab.dirty = false;

      didSave(tab.path, content);
      this.host.onDirtyChanged();
      this.host.onSaved(tab);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.host.onEditorError(`No se ha podido guardar "${tab.name}": ${reason}`);
    } finally {
      done();
      this.refreshEditability();
    }
  }

  /**
   * Programa el autoguardado de **la pestaña que ha cambiado**, no de la activa.
   *
   * Parece lo mismo y no lo es: el temporizador salta un segundo después, y para entonces el
   * usuario puede haber cambiado de pestaña. Guardar la activa en ese caso es guardar una pestaña
   * limpia y dejar la editada sucia para siempre, porque el temporizador sólo se reprograma cuando
   * cambia el contenido, y en esa pestaña ya no va a cambiar nada.
   */
  private scheduleAutoSave(tab: OpenTab): void {
    if (this.settings?.autoSave !== 'afterDelay') return;
    if (this.autoSaveTimer !== undefined) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = window.setTimeout(() => {
      if (tab.dirty) void this.save(tab);
    }, this.settings.autoSaveDelayMs);
  }

  /** Aplica los marcadores de diagnóstico que llegan del servidor de lenguaje. */
  setMarkers(path: string, markers: MonacoApi.editor.IMarkerData[]): void {
    const monaco = getMonaco();
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model) monaco.editor.setModelMarkers(model, 'csharp-lsp', markers);
  }

  /** Marcadores procedentes de una compilación con MSBuild, en un propietario distinto. */
  setBuildMarkers(byPath: Map<string, MonacoApi.editor.IMarkerData[]>): void {
    const monaco = getMonaco();

    for (const model of monaco.editor.getModels()) {
      monaco.editor.setModelMarkers(model, 'msbuild', byPath.get(model.uri.fsPath) ?? []);
    }
  }

  /**
   * Avisos del linter de arquitectura.
   *
   * Van en su **propio propietario** de marcadores (`dotforge-architecture`), no en el de MSBuild:
   * si compartieran propietario, una compilación correcta borraría los avisos de arquitectura, que
   * es justo lo que no debe pasar — el código compila y sigue rompiendo la regla.
   */
  setArchitectureMarkers(byPath: Map<string, MonacoApi.editor.IMarkerData[]>): void {
    const monaco = getMonaco();

    for (const model of monaco.editor.getModels()) {
      monaco.editor.setModelMarkers(model, 'dotforge-architecture', byPath.get(model.uri.fsPath) ?? []);
    }
  }

  /** Pinta los breakpoints de un archivo en el margen. */
  setBreakpoints(path: string, lines: number[]): void {
    const monaco = getMonaco();
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (!model) return;

    const previous = this.breakpointDecorations.get(path) ?? [];
    const decorations = model.deltaDecorations(
      previous,
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: 'dotforge-breakpoint',
          glyphMarginHoverMessage: { value: 'Breakpoint' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );

    this.breakpointDecorations.set(path, decorations);
  }

  /** Resalta la línea en la que está detenida la ejecución (o la limpia con null). */
  setExecutionLine(path: string | null, line: number | null): void {
    const monaco = getMonaco();

    for (const [decoratedPath, decorations] of this.executionDecorations) {
      const model = monaco.editor.getModel(monaco.Uri.file(decoratedPath));
      if (model) model.deltaDecorations(decorations, []);
    }
    this.executionDecorations.clear();

    if (!path || line === null) return;

    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (!model) return;

    this.executionDecorations.set(
      path,
      model.deltaDecorations(
        [],
        [
          {
            range: new monaco.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              className: 'dotforge-execution-line',
              glyphMarginClassName: 'dotforge-execution-arrow',
            },
          },
        ],
      ),
    );

    this.editor?.revealLineInCenterIfOutsideViewport(line);
  }

  runAction(actionId: string): void {
    void this.editor?.getAction(actionId)?.run();
  }

  /**
   * Registra una acción en el editor y, opcionalmente, en su menú contextual.
   *
   * Es la vía de Monaco: las entradas aparecen en el menú del botón derecho con su atajo, se
   * traducen solas al idioma del editor y respetan el estado (no salen si no hay modelo).
   */
  addAction(spec: {
    id: string;
    label: string;
    keybindings?: number[];
    contextMenuGroupId?: string;
    order?: number;
    run: () => void;
  }): void {
    if (!this.editor) return;

    this.disposables.push(
      this.editor.addAction({
        id: spec.id,
        label: spec.label,
        ...(spec.keybindings ? { keybindings: spec.keybindings } : {}),
        ...(spec.contextMenuGroupId ? { contextMenuGroupId: spec.contextMenuGroupId } : {}),
        ...(spec.order === undefined ? {} : { contextMenuOrder: spec.order }),
        run: () => spec.run(),
      }),
    );
  }

  /** Selección actual, para inyectarla como contexto del asistente. Null si no hay ninguna. */
  currentSelection(): { startLine: number; endLine: number; text: string } | null {
    const selection = this.editor?.getSelection();
    const model = this.editor?.getModel();
    if (!selection || !model || selection.isEmpty()) return null;

    return {
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      text: model.getValueInRange(selection),
    };
  }

  /**
   * Sustituye la selección por un texto (o lo inserta en el cursor si no hay selección).
   *
   * Pasa por `executeEdits` y no por `setValue` para que quede en la pila de deshacer: un código
   * que llega de un modelo es justo el que uno quiere poder revertir con Ctrl+Z.
   */
  replaceSelection(text: string): void {
    const selection = this.editor?.getSelection();
    if (!this.editor || !selection) return;

    this.editor.executeEdits('dotforge.ai', [{ range: selection, text, forceMoveMarkers: true }]);
    this.editor.focus();
  }

  focus(): void {
    this.editor?.focus();
  }

  /**
   * Reparte el hueco central entre los tres inquilinos: el editor, el editor de diferencias y la
   * pantalla de bienvenida. Sólo uno se ve a la vez, y la bienvenida sólo cuando no hay nada
   * abierto de ninguno de los dos tipos.
   */
  private updateVisibility(): void {
    const showingDiff = this.activeDiff !== null;
    const hasCode = this.activePath !== null;
    const hasAnything = this.tabs.size > 0 || this.diffTabs.size > 0;

    byId('editor-host').classList.toggle('hidden', showingDiff || !hasCode);
    byId('diff-host').classList.toggle('hidden', !showingDiff);
    byId('welcome').classList.toggle('hidden', hasAnything);
  }

  // -------------------------------------------------------------------------------------------
  // Comparación de archivos (control de código fuente)
  // -------------------------------------------------------------------------------------------

  /**
   * Abre —o refresca— una comparación lado a lado.
   *
   * Los modelos usan un esquema propio (`dotforge-diff:`) y no `file:`: si el lado derecho fuera
   * el modelo real del archivo, cualquier cambio en la comparación ensuciaría la pestaña del
   * editor y el servidor de lenguaje recibiría ediciones de un documento que nadie ha abierto.
   * Los dos lados son de sólo lectura; para editar está la pestaña del archivo, a un doble clic.
   */
  openDiff(diff: GitFileDiff): void {
    const monaco = getMonaco();
    const key = diffKey(diff.request);
    const existing = this.diffTabs.get(key);

    if (existing) {
      // Preparar o descartar cambia el contenido: se actualiza en sitio para no perder el scroll.
      if (existing.original.getValue() !== diff.original) existing.original.setValue(diff.original);
      if (existing.modified.getValue() !== diff.modified) existing.modified.setValue(diff.modified);
      existing.title = diff.request.title;
    } else {
      const uriFor = (side: 'original' | 'modified'): MonacoApi.Uri =>
        monaco.Uri.parse(`dotforge-diff:///${encodeURIComponent(key)}/${side}`);

      const create = (content: string, side: 'original' | 'modified'): MonacoApi.editor.ITextModel => {
        const uri = uriFor(side);
        const previous = monaco.editor.getModel(uri);
        previous?.dispose();
        return monaco.editor.createModel(content, diff.languageId, uri);
      };

      this.diffTabs.set(key, {
        key,
        title: diff.request.title,
        name: diff.request.path.split('/').pop() ?? diff.request.path,
        path: diff.absolutePath,
        original: create(diff.original, 'original'),
        modified: create(diff.modified, 'modified'),
      });
    }

    this.activateDiff(key);
    this.renderTabs();
  }

  private ensureDiffEditor(): MonacoApi.editor.IStandaloneDiffEditor {
    if (this.diffEditor) return this.diffEditor;

    const monaco = getMonaco();
    const settings = this.settings;

    this.diffEditor = monaco.editor.createDiffEditor(byId('diff-host'), {
      automaticLayout: true,
      // Lado a lado: es la comparación que espera quien viene de cualquier otro cliente de git.
      renderSideBySide: true,
      readOnly: true,
      originalEditable: false,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: false,
      fontFamily: settings?.fontFamily,
      fontSize: settings?.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: settings?.theme === 'dotforge-light' ? LIGHT_THEME : DARK_THEME,
    });

    return this.diffEditor;
  }

  activateDiff(key: string): void {
    const tab = this.diffTabs.get(key);
    if (!tab) return;

    const editor = this.ensureDiffEditor();
    editor.setModel({ original: tab.original, modified: tab.modified });

    this.activeDiff = key;
    this.updateVisibility();
    this.refreshEditability();
    this.host.onActiveChanged(null);
  }

  closeDiff(key: string): void {
    const tab = this.diffTabs.get(key);
    if (!tab) return;

    tab.original.dispose();
    tab.modified.dispose();
    this.diffTabs.delete(key);

    if (this.activeDiff === key) {
      this.activeDiff = null;
      this.diffEditor?.setModel(null);

      // Al cerrar la comparación se vuelve a lo que hubiera abierto, no a la bienvenida.
      const next = this.listTabs().at(-1);
      if (next) this.activate(next.path);
      else {
        this.updateVisibility();
        this.refreshEditability();
      }
    }

    this.renderTabs();
  }

  /** Clave de la comparación visible, si hay alguna. Lo usan las pruebas de interfaz. */
  activeDiffKey(): string | null {
    return this.activeDiff;
  }

  /** Pinta la barra de pestañas: primero los archivos, luego las comparaciones. */
  renderTabs(): void {
    const container = byId('tabs');
    clear(container);

    for (const tab of this.tabs.values()) {
      const isActive = tab.path === this.activePath && this.activeDiff === null;

      const spec = iconForFile(tab.name);

      // El punto de "sin guardar" y la ✕ comparten sitio: el CSS decide cuál se ve según el
      // estado y el hover, para que la pestaña no cambie de ancho al pasar el ratón.
      const close = el(
        'span',
        {
          className: 'tab-close',
          title: tab.dirty ? 'Cambios sin guardar — clic para cerrar' : 'Cerrar',
          role: 'button',
          on: {
            click: (event) => {
              event.stopPropagation();
              void this.close(tab.path).then(() => this.renderTabs());
            },
          },
        },
        icon('dot', { size: 11, className: 'icon-dirty' }),
        icon('x', { size: 12, className: 'icon-close' }),
      );

      container.appendChild(
        el(
          'button',
          {
            className: `tab${isActive ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`,
            title: tab.path,
            role: 'tab',
            attrs: { 'aria-selected': String(isActive) },
            on: {
              click: () => {
                this.activate(tab.path);
                this.renderTabs();
              },
              auxclick: (event) => {
                // Botón central: cerrar, como en cualquier navegador o editor.
                if ((event as MouseEvent).button === 1) {
                  event.preventDefault();
                  void this.close(tab.path).then(() => this.renderTabs());
                }
              },
            },
          },
          icon(spec.name, { size: 14, className: `tone-${spec.tone}` }),
          el('span', { className: 'tab-name', text: tab.name }),
          close,
        ),
      );
    }

    for (const diff of this.diffTabs.values()) {
      const isActive = diff.key === this.activeDiff;

      container.appendChild(
        el(
          'button',
          {
            className: `tab tab-diff${isActive ? ' active' : ''}`,
            title: `${diff.title} — doble clic para abrir el archivo`,
            role: 'tab',
            attrs: { 'aria-selected': String(isActive) },
            on: {
              click: () => {
                this.activateDiff(diff.key);
                this.renderTabs();
              },
              auxclick: (event) => {
                if ((event as MouseEvent).button === 1) {
                  event.preventDefault();
                  this.closeDiff(diff.key);
                }
              },
            },
          },
          icon('exchange', { size: 14, className: 'tone-project' }),
          el('span', { className: 'tab-name', text: diff.title }),
          el(
            'span',
            {
              className: 'tab-close',
              title: 'Cerrar la comparación',
              role: 'button',
              on: {
                click: (event) => {
                  event.stopPropagation();
                  this.closeDiff(diff.key);
                },
              },
            },
            icon('x', { size: 12, className: 'icon-close' }),
          ),
        ),
      );
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const diff of this.diffTabs.values()) {
      diff.original.dispose();
      diff.modified.dispose();
    }
    this.diffEditor?.dispose();
    this.editor?.dispose();
  }
}
