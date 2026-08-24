/**
 * Panel de búsqueda en los archivos.
 *
 * Lo que un IDE llama "buscar en archivos" y lo que DotForge tenía hasta ahora —filtrar el árbol
 * del explorador por nombre— son dos cosas distintas, y la segunda no sustituye a la primera.
 *
 * Cuatro decisiones de la vista:
 *
 *  - **Se busca mientras se escribe, y el foco no se pierde.** La caja repinta el panel entero en
 *    cada respuesta, así que va marcada con `data-focus-key` y todo el pintado pasa por
 *    `repaintPreservingFocus` (ADR-052). Sin eso, el cursor desaparece a mitad de palabra y se
 *    siente como si el IDE se comiera las letras — que es exactamente el fallo de la Fase 18.
 *  - **Los resultados aparecen antes de terminar.** El proceso principal emite lotes; aquí se
 *    van pegando. Un panel que no enseña nada durante un segundo se percibe como roto aunque
 *    tarde lo mismo.
 *  - **Sólo manda la última búsqueda.** Cada consulta lleva número de orden, como las de NuGet y
 *    las de Open VSX: dos en vuelo pueden volver al revés.
 *  - **Una expresión regular a medias no es un error.** `(` es el estado normal de quien está
 *    escribiéndola. Se dice en pequeño, debajo de la caja, sin vaciar lo que ya había.
 */
import type { SearchFileResult, SearchProgress, SearchSummary } from '../../shared/contracts.js';
import { DEFAULT_SEARCH_OPTIONS, describeResults } from '../../shared/file-search.js';
import { byId, clear, debounce, el, repaintPreservingFocus } from '../dom.js';
import { FOCUS_KEY_ATTRIBUTE } from '../focus-guard.js';
import { icon } from '../icons.js';

export interface SearchHost {
  /** Abre el archivo y deja seleccionada la coincidencia. */
  openMatch(path: string, line: number, column: number, length: number): void;
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
}

/** Estado de una búsqueda, tal y como lo va viendo el panel. */
interface SearchState {
  files: SearchFileResult[];
  totalMatches: number;
  filesMatched: number;
  truncated: boolean;
  running: boolean;
  error: string | null;
  elapsedMs: number;
}

const EMPTY_STATE: SearchState = {
  files: [],
  totalMatches: 0,
  filesMatched: 0,
  truncated: false,
  running: false,
  error: null,
  elapsedMs: 0,
};

export class SearchView {
  private visible = false;

  private query = '';
  private matchCase = false;
  private wholeWord = false;
  private useRegex = false;
  private include = '';
  private exclude = '';

  /** Los campos de inclusión y exclusión sólo estorban hasta que hacen falta. */
  private filtersOpen = false;

  private state: SearchState = { ...EMPTY_STATE };

  /** Archivos plegados, por ruta. Se pliega lo que molesta, no se despliega lo que interesa. */
  private readonly collapsed = new Set<string>();

  /**
   * Número de orden de la búsqueda en vuelo.
   *
   * Es el mismo que asigna el proceso principal, y sirve para lo mismo aquí que allí: descartar lo
   * que llega tarde. Empieza en cero, que no es el de ninguna búsqueda real.
   */
  private searchId = 0;

  private readonly runSearch = debounce(() => void this.search(), 300);

  constructor(private readonly host: SearchHost) {}

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.render();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Deja el panel listo para escribir.
   *
   * Lo llaman el atajo, el menú y la paleta. Si hay algo escrito se selecciona entero: quien vuelve
   * a la búsqueda casi siempre viene a buscar otra cosa, y así la primera tecla sustituye.
   */
  focusInput(): void {
    const input = document.querySelector<HTMLInputElement>('.search-query input');
    if (input === null) return;

    input.focus();
    input.select();
  }

  /** Busca lo que haya seleccionado en el editor. Es lo que hace el atajo con una selección viva. */
  searchFor(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.includes('\n')) return;

    this.query = trimmed;
    this.render();
    void this.search();
  }

  /** El workspace ha cambiado: lo encontrado ya no existe. */
  reset(): void {
    this.state = { ...EMPTY_STATE };
    this.collapsed.clear();
    this.searchId = 0;
    void window.dotforge.search.cancel();
    this.render();
  }

  /** Avance parcial del proceso principal. Llega mientras la búsqueda sigue. */
  onProgress(progress: SearchProgress): void {
    if (progress.searchId !== this.searchId) return;

    this.state.files = [...this.state.files, ...progress.files];
    this.state.filesMatched = this.state.files.length;
    this.state.totalMatches = progress.totalMatches;
    this.render();
  }

  // --- Búsqueda ---------------------------------------------------------------------------------

  private async search(): Promise<void> {
    if (this.query === '') {
      this.searchId = 0;
      this.state = { ...EMPTY_STATE };
      await window.dotforge.search.cancel();
      this.render();
      return;
    }

    // El identificador lo asigna el proceso principal, así que hasta que conteste no se puede
    // emparejar nada: se invalidan los avances de la anterior poniéndolo a cero.
    this.searchId = 0;
    this.state = { ...EMPTY_STATE, running: true };
    this.render();

    let summary: SearchSummary;
    try {
      summary = await window.dotforge.search.inFiles({
        ...DEFAULT_SEARCH_OPTIONS,
        query: this.query,
        matchCase: this.matchCase,
        wholeWord: this.wholeWord,
        useRegex: this.useRegex,
        include: this.include,
        exclude: this.exclude,
      });
    } catch (error) {
      this.state = { ...EMPTY_STATE, error: this.messageOf(error) };
      this.render();
      return;
    }

    // Una búsqueda abandonada deja el panel como está: lo que se ve es de la que sigue viva.
    if (summary.cancelled) return;

    this.searchId = summary.searchId;
    this.state = {
      files: summary.files,
      totalMatches: summary.totalMatches,
      filesMatched: summary.filesMatched,
      truncated: summary.truncated,
      running: false,
      error: summary.error,
      elapsedMs: summary.elapsedMs,
    };

    this.render();
  }

  private messageOf(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/^Error invoking remote method '[^']+':\s*/, '');
  }

  private toggle(field: 'matchCase' | 'wholeWord' | 'useRegex'): void {
    this[field] = !this[field];
    this.render();
    if (this.query !== '') void this.search();
  }

  // --- Pintado ----------------------------------------------------------------------------------

  render(): void {
    if (!this.visible) return;
    repaintPreservingFocus(byId('sidebar-content'), () => this.paint());
  }

  private paint(): void {
    const container = byId('sidebar-content');
    clear(container);
    byId('sidebar-title').textContent = 'Buscar';

    const actions = byId('sidebar-actions');
    clear(actions);
    actions.append(
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Volver a buscar',
          disabled: this.query === '',
          on: { click: () => void this.search() },
        },
        icon('refresh', { size: 15 }),
      ),
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Contraer todos los archivos',
          on: { click: () => this.collapseAll() },
        },
        icon('collapse-all', { size: 15 }),
      ),
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Limpiar los resultados',
          on: { click: () => this.clearQuery() },
        },
        icon('x', { size: 15 }),
      ),
    );

    const panel = el('div', { className: 'search-panel' });
    panel.append(this.queryBox(), this.filters(), this.summaryLine());

    if (this.state.error !== null) panel.appendChild(this.errorLine(this.state.error));

    panel.appendChild(this.results());
    container.appendChild(panel);
  }

  private queryBox(): HTMLElement {
    const input = el('input', {
      className: 'input',
      placeholder: 'Buscar en los archivos…',
      value: this.query,
      attrs: { [FOCUS_KEY_ATTRIBUTE]: 'search-query', spellcheck: 'false' },
      on: {
        input: (event) => {
          this.query = (event.target as HTMLInputElement).value;
          this.runSearch();
        },
        keydown: (event) => {
          // Enter no espera al rebote: quien lo pulsa ya ha terminado de escribir.
          if ((event as KeyboardEvent).key === 'Enter') void this.search();
        },
      },
    });

    return el(
      'div',
      { className: 'search-query' },
      input,
      el(
        'div',
        { className: 'search-toggles' },
        this.toggleButton('Aa', 'Distinguir mayúsculas y minúsculas', this.matchCase, () => this.toggle('matchCase')),
        this.toggleButton('ab', 'Sólo palabras completas', this.wholeWord, () => this.toggle('wholeWord')),
        this.toggleButton('.*', 'Usar expresión regular', this.useRegex, () => this.toggle('useRegex')),
      ),
    );
  }

  private toggleButton(label: string, title: string, active: boolean, onClick: () => void): HTMLElement {
    return el('button', {
      className: `search-toggle${active ? ' active' : ''}`,
      text: label,
      title,
      attrs: { 'aria-pressed': String(active), 'aria-label': title },
      on: { click: onClick },
    });
  }

  private filters(): HTMLElement {
    const head = el(
      'button',
      {
        className: 'search-filters-head',
        title: 'Archivos a incluir y a excluir',
        on: {
          click: () => {
            this.filtersOpen = !this.filtersOpen;
            this.render();
          },
        },
      },
      icon(this.filtersOpen ? 'chevron-down' : 'chevron-right', { size: 13 }),
      el('span', { text: 'Archivos a incluir y excluir' }),
      this.include === '' && this.exclude === ''
        ? null
        : el('span', { className: 'chip accent', text: 'filtrado' }),
    );

    const wrapper = el('div', { className: 'search-filters' }, head);
    if (!this.filtersOpen) return wrapper;

    wrapper.append(
      this.globField('search-include', 'Archivos a incluir', '*.cs, src/**', this.include, (value) => {
        this.include = value;
      }),
      this.globField('search-exclude', 'Archivos a excluir', '*.designer.cs, docs/', this.exclude, (value) => {
        this.exclude = value;
      }),
      el('div', {
        className: 'search-hint',
        text: 'Separados por coma. `!` delante de un patrón lo excluye. bin, obj y node_modules nunca se miran.',
      }),
    );

    return wrapper;
  }

  private globField(
    key: string,
    label: string,
    placeholder: string,
    value: string,
    assign: (value: string) => void,
  ): HTMLElement {
    return el(
      'label',
      { className: 'search-field' },
      el('span', { text: label }),
      el('input', {
        className: 'input',
        placeholder,
        value,
        attrs: { [FOCUS_KEY_ATTRIBUTE]: key, spellcheck: 'false' },
        on: {
          input: (event) => {
            assign((event.target as HTMLInputElement).value);
            this.runSearch();
          },
        },
      }),
    );
  }

  private summaryLine(): HTMLElement {
    if (this.query === '') {
      return el('div', { className: 'search-summary', text: 'Escribe para buscar en la solución abierta.' });
    }

    if (this.state.running) {
      return el(
        'div',
        { className: 'search-summary' },
        el('span', { className: 'spinner' }),
        el('span', { text: ` Buscando… ${this.state.totalMatches} hasta ahora` }),
      );
    }

    if (this.state.error !== null) return el('div', { className: 'search-summary', text: 'Consulta sin ejecutar' });

    return el(
      'div',
      { className: 'search-summary' },
      el('span', { text: describeResults(this.state) }),
      el('span', { className: 'search-elapsed', text: `${this.state.elapsedMs} ms` }),
    );
  }

  private errorLine(message: string): HTMLElement {
    return el(
      'div',
      { className: 'search-error' },
      icon('alert-triangle', { size: 13 }),
      el('span', { text: message }),
    );
  }

  private results(): HTMLElement {
    const list = el('div', { className: 'search-results' });

    if (this.query === '' || this.state.error !== null) return list;

    if (this.state.files.length === 0) {
      list.appendChild(
        el('div', {
          className: 'empty-state',
          text: this.state.running ? '' : 'Ningún archivo contiene ese texto.',
        }),
      );
      return list;
    }

    for (const file of this.state.files) {
      list.appendChild(this.fileGroup(file));
    }

    if (this.state.truncated) {
      list.appendChild(
        el('div', {
          className: 'search-hint',
          text: 'Hay más coincidencias de las que caben: afina la búsqueda o los archivos a incluir.',
        }),
      );
    }

    return list;
  }

  private fileGroup(file: SearchFileResult): HTMLElement {
    const collapsed = this.collapsed.has(file.path);
    const slash = file.relativePath.lastIndexOf('/');
    const name = slash === -1 ? file.relativePath : file.relativePath.slice(slash + 1);
    const folder = slash === -1 ? '' : file.relativePath.slice(0, slash);

    const head = el(
      'button',
      {
        className: 'search-file',
        title: file.relativePath,
        on: {
          click: () => {
            if (collapsed) this.collapsed.delete(file.path);
            else this.collapsed.add(file.path);
            this.render();
          },
        },
      },
      icon(collapsed ? 'chevron-right' : 'chevron-down', { size: 13 }),
      el('span', { className: 'search-file-name', text: name }),
      el('span', { className: 'search-file-folder', text: folder }),
      el('span', {
        className: 'search-file-count',
        text: file.truncated ? `${file.matches.length}+` : String(file.matches.length),
      }),
    );

    const group = el('div', { className: 'search-group' }, head);
    if (collapsed) return group;

    for (const match of file.matches) {
      group.appendChild(
        el(
          'button',
          {
            className: 'search-match',
            title: `${file.relativePath}:${match.line}:${match.column}`,
            on: { click: () => this.host.openMatch(file.path, match.line, match.column, match.length) },
          },
          el('span', { className: 'search-line-number', text: String(match.line) }),
          this.highlighted(match.preview, match.previewColumn, match.length),
        ),
      );
    }

    return group;
  }

  /**
   * La línea con la coincidencia resaltada.
   *
   * Se parte en tres nodos de texto en vez de inyectar marcado: el renderer no escribe `innerHTML`
   * ni para HTML ni para SVG, y aquí el contenido es **código del usuario**, que es justo el peor
   * sitio para hacer una excepción.
   */
  private highlighted(preview: string, column: number, length: number): HTMLElement {
    const start = Math.max(0, column - 1);
    // La coincidencia puede haber quedado cortada por el borde derecho del recorte.
    const end = Math.min(preview.length, start + Math.max(length, 1));

    return el(
      'span',
      { className: 'search-preview' },
      el('span', { text: preview.slice(0, start) }),
      el('mark', { text: preview.slice(start, end) }),
      el('span', { text: preview.slice(end) }),
    );
  }

  private collapseAll(): void {
    for (const file of this.state.files) this.collapsed.add(file.path);
    this.render();
  }

  private clearQuery(): void {
    this.query = '';
    this.state = { ...EMPTY_STATE };
    this.searchId = 0;
    void window.dotforge.search.cancel();
    this.render();
    this.focusInput();
  }
}
