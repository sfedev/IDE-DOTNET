/**
 * Explorador de pruebas.
 *
 * Responde a tres preguntas, y a ninguna otra: *¿qué pruebas hay?*, *¿cuáles están en rojo?* y
 * *¿cómo ejecuto sólo esta?* El árbol es proyecto → clase → prueba, que es la jerarquía que ya
 * tiene el código, y cada nivel se puede ejecutar por separado.
 *
 * Dos decisiones que se ven en la pantalla:
 *
 *  - **El árbol se llena sin compilar.** Las pruebas se descubren leyendo el código fuente, así que
 *    aparecen al abrir la solución y también las que se acaban de escribir y todavía no compilan.
 *    A cambio, una prueba generada por un `[TestCaseSource]` exótico puede no salir hasta que se
 *    ejecute; es el precio, y es barato.
 *  - **El estado se recuerda entre ejecuciones.** Ejecutar una sola prueba no pone las demás en
 *    gris: siguen con el resultado que tenían, porque es la información que había hace un minuto y
 *    borrarla no la hace más cierta.
 *
 * Los fallos no se quedan aquí: van al panel de problemas con su archivo, su línea, el mensaje del
 * assert y la traza completa.
 */
import type { BuildDiagnostic, SolutionInfo, TestCase, TestRunSummary, TestStatus } from '../../shared/contracts.js';
import {
  aggregateStatus,
  buildTestTree,
  describeSummary,
  filterForClass,
  filterForTests,
  type TestClassNode,
  type TestProjectNode,
} from '../../shared/test-explorer.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export interface TestExplorerHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  /** Abre un archivo en una línea concreta. */
  openFile(path: string, line?: number): void;
  /** Enseña el canal de salida donde va `dotnet test`. */
  showOutput(): void;
  /** Publica los fallos en el panel de problemas, con su traza. */
  publishFailures(diagnostics: BuildDiagnostic[]): void;
  /** `.sln` de la solución abierta, o el único `.csproj` si no hay solución. */
  defaultTarget(): string | null;
}

/** Icono y tono de cada estado. Es lo único que hay que mirar para saber cómo está una prueba. */
const STATUS_ICON: Record<TestStatus, IconName> = {
  unknown: 'circle-dot',
  running: 'refresh',
  passed: 'check',
  failed: 'alert-circle',
  skipped: 'circle-slash',
};

const STATUS_LABEL: Record<TestStatus, string> = {
  unknown: 'Sin ejecutar',
  running: 'En ejecución',
  passed: 'Correcta',
  failed: 'Con error',
  skipped: 'Omitida',
};

export class TestExplorerView {
  private visible = false;
  private solution: SolutionInfo | null = null;

  private tests: TestCase[] = [];
  private readonly status = new Map<string, TestStatus>();
  private readonly detail = new Map<string, { message: string | null; stackTrace: string | null }>();

  private readonly collapsed = new Set<string>();
  private query = '';
  private onlyFailed = false;

  private loading = false;
  private runningTaskId: string | null = null;
  /** Identificadores que está ejecutando la tarea viva, para pintarlos en curso. */
  private runningIds: string[] = [];
  private lastSummary: TestRunSummary | null = null;

  constructor(private readonly host: TestExplorerHost) {}

  // --- Estado ---------------------------------------------------------------------------------

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) return;

    this.render();
    if (this.tests.length === 0) void this.discover();
  }

  isVisible(): boolean {
    return this.visible;
  }

  setSolution(solution: SolutionInfo | null): void {
    this.solution = solution;
    this.tests = [];
    this.status.clear();
    this.detail.clear();
    this.lastSummary = null;

    if (this.visible) void this.discover();
  }

  /** Pruebas descubiertas, para las lentes de código del editor. */
  all(): TestCase[] {
    return this.tests;
  }

  /** Número de pruebas en rojo. Lo usa la insignia de la barra de actividad. */
  failedCount(): number {
    return [...this.status.values()].filter((status) => status === 'failed').length;
  }

  hasRun(): boolean {
    return this.lastSummary !== null;
  }

  async discover(): Promise<void> {
    this.loading = true;
    this.render();

    try {
      this.tests = await window.dotforge.tests.discover();
    } catch (error) {
      this.host.notify(`No se han podido descubrir las pruebas: ${messageOf(error)}`, 'warn');
      this.tests = [];
    } finally {
      this.loading = false;
      this.render();
    }
  }

  // --- Ejecución ------------------------------------------------------------------------------

  /** Ejecuta todas las pruebas de la solución. */
  runAll(): void {
    void this.run([], null, 'Todas las pruebas');
  }

  runClass(node: TestClassNode): void {
    void this.run(
      [],
      node.id,
      node.className,
      node.tests.map((test) => test.id),
      node.tests[0]?.project ?? null,
    );
  }

  /** Ejecuta una prueba concreta. Es lo que hace la lente de código del editor. */
  runTest(test: TestCase): void {
    void this.run([test.id], null, test.displayName, [test.id], test.project);
  }

  /** Ejecuta todas las pruebas declaradas en un archivo. */
  runFile(path: string): void {
    const inFile = this.tests.filter((test) => samePath(test.file, path));
    if (inFile.length === 0) {
      this.host.notify('No hay pruebas en este archivo.', 'warn');
      return;
    }

    void this.run(
      inFile.map((test) => test.id),
      null,
      fileNameOf(path),
      inFile.map((test) => test.id),
      inFile[0]?.project ?? null,
    );
  }

  private async run(
    ids: string[],
    classId: string | null,
    label: string,
    marked: string[] = [],
    project: string | null = null,
  ): Promise<void> {
    if (this.runningTaskId !== null) {
      this.host.notify('Ya hay una ejecución de pruebas en marcha.', 'warn');
      return;
    }

    // Un proyecto concreto es mucho más rápido que la solución entera: si todo lo que se va a
    // ejecutar sale del mismo `.csproj`, se apunta a él.
    const target = project ?? this.host.defaultTarget();
    if (target === null) {
      this.host.notify('Abre una solución con proyectos de pruebas para poder ejecutarlas.', 'warn');
      return;
    }

    // El filtro lo construye el modelo puro; el proceso principal lo vuelve a construir a partir
    // de los identificadores validados. Aquí sólo sirve para saber si hay algo que filtrar.
    const filter = ids.length > 0 ? filterForTests(ids) : classId !== null ? filterForClass(classId) : null;

    this.runningIds = marked;
    for (const id of marked) this.status.set(id, 'running');
    this.render();

    try {
      const task = await window.dotforge.tests.run({
        target,
        ids,
        classId,
        label: `Pruebas · ${label}`,
      });

      this.runningTaskId = task.taskId;
      this.host.showOutput();
      this.host.notify(
        filter === null ? 'Ejecutando todas las pruebas…' : `Ejecutando ${label}…`,
        'info',
      );
    } catch (error) {
      this.runningIds = [];
      for (const id of marked) this.status.set(id, 'unknown');
      this.host.notify(`No se han podido lanzar las pruebas: ${messageOf(error)}`, 'error');
    } finally {
      this.render();
    }
  }

  /**
   * La tarea de pruebas ha terminado: se leen los resultados.
   *
   * Se piden aparte y no se deducen del código de salida: `dotnet test` devuelve 1 tanto si una
   * prueba ha fallado como si el proyecto no compila, y son dos cosas muy distintas.
   */
  async noteTaskExit(taskId: string): Promise<boolean> {
    if (this.runningTaskId !== taskId) return false;

    this.runningTaskId = null;
    const marked = this.runningIds;
    this.runningIds = [];

    let summary: TestRunSummary;
    try {
      summary = await window.dotforge.tests.results(taskId);
    } catch (error) {
      for (const id of marked) this.status.set(id, 'unknown');
      this.host.notify(`No se han podido leer los resultados: ${messageOf(error)}`, 'warn');
      this.render();
      return true;
    }

    this.lastSummary = summary;

    for (const result of summary.results) {
      this.status.set(result.id, result.status);
      this.detail.set(result.id, { message: result.message, stackTrace: result.stackTrace });
    }

    // Lo que se pidió ejecutar y no ha aparecido en los resultados no se queda "en ejecución"
    // para siempre: vuelve a desconocido, que es la verdad.
    for (const id of marked) {
      if (this.status.get(id) === 'running') this.status.set(id, 'unknown');
    }

    this.publishFailures(summary);

    if (summary.results.length === 0) {
      this.host.notify('La ejecución no ha producido resultados. Mira la salida para el detalle.', 'warn');
    } else {
      this.host.notify(
        `${describeSummary(summary)}${summary.degraded ? ' · resultados leídos de la consola' : ''}`,
        summary.failed > 0 ? 'error' : 'ok',
      );
    }

    this.render();
    return true;
  }

  /** Traduce los fallos a problemas del panel inferior, con archivo, línea y traza. */
  private publishFailures(summary: TestRunSummary): void {
    const testById = new Map(this.tests.map((test) => [test.id, test]));

    const diagnostics: BuildDiagnostic[] = summary.results
      .filter((result) => result.status === 'failed')
      .map((result) => {
        const test = testById.get(result.id);
        const message = result.message ?? 'La prueba ha fallado sin mensaje.';
        const trace = result.stackTrace === null ? '' : `\n${result.stackTrace.trim()}`;

        return {
          file: test?.file ?? null,
          line: test?.methodLine ?? 1,
          column: 1,
          severity: 'error' as const,
          code: 'TEST',
          message: `${result.id}: ${message}${trace}`,
          project: test?.project ?? null,
        };
      });

    this.host.publishFailures(diagnostics);
  }

  // --- Filtrado -------------------------------------------------------------------------------

  private statusOf(id: string): TestStatus {
    return this.status.get(id) ?? 'unknown';
  }

  private visibleTests(): TestCase[] {
    const query = this.query.trim().toLowerCase();

    return this.tests.filter((test) => {
      if (this.onlyFailed && this.statusOf(test.id) !== 'failed') return false;
      if (query === '') return true;
      return `${test.className}.${test.method} ${test.displayName}`.toLowerCase().includes(query);
    });
  }

  private tree(): TestProjectNode[] {
    const names: Record<string, string> = {};
    for (const project of this.solution?.projects ?? []) names[project.path] = project.name;

    return buildTestTree(this.visibleTests(), names);
  }

  // --- Pintado --------------------------------------------------------------------------------

  render(): void {
    if (!this.visible) return;

    const container = byId('sidebar-content');
    clear(container);
    byId('sidebar-title').textContent = 'Pruebas';

    const actions = byId('sidebar-actions');
    clear(actions);
    actions.append(
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Volver a descubrir las pruebas del código',
          disabled: this.loading,
          on: { click: () => void this.discover() },
        },
        icon('refresh', { size: 15 }),
      ),
    );

    const panel = el('div', { className: 'tests-panel' });
    panel.append(this.renderHeader(), this.renderFilter());

    const tree = this.tree();

    if (this.loading && this.tests.length === 0) {
      panel.appendChild(el('div', { className: 'empty-hint', text: 'Buscando pruebas en la solución…' }));
    } else if (this.tests.length === 0) {
      panel.appendChild(this.renderEmpty());
    } else if (tree.length === 0) {
      panel.appendChild(el('div', { className: 'empty-hint', text: 'Ningún resultado con este filtro.' }));
    } else {
      for (const project of tree) panel.appendChild(this.renderProject(project));
    }

    container.appendChild(panel);
  }

  private renderHeader(): HTMLElement {
    const counts = this.counts();
    const running = this.runningTaskId !== null;

    return el(
      'div',
      { className: 'tests-head' },
      el(
        'button',
        {
          className: 'btn primary tests-run-all',
          disabled: running || this.tests.length === 0,
          title: 'Ejecuta todas las pruebas de la solución (dotnet test)',
          on: { click: () => this.runAll() },
        },
        icon(running ? 'refresh' : 'play', { size: 15 }),
        el('span', { text: running ? 'Ejecutando…' : 'Ejecutar todas' }),
      ),
      el(
        'div',
        { className: 'tests-counts' },
        this.countPill('passed', counts.passed),
        this.countPill('failed', counts.failed),
        this.countPill('skipped', counts.skipped),
        el('span', { className: 'tests-total', text: `${this.tests.length} pruebas` }),
      ),
    );
  }

  private counts(): { passed: number; failed: number; skipped: number } {
    const values = this.tests.map((test) => this.statusOf(test.id));
    return {
      passed: values.filter((status) => status === 'passed').length,
      failed: values.filter((status) => status === 'failed').length,
      skipped: values.filter((status) => status === 'skipped').length,
    };
  }

  private countPill(status: TestStatus, count: number): HTMLElement {
    return el(
      'span',
      { className: `tests-pill ${status}`, title: STATUS_LABEL[status] },
      icon(STATUS_ICON[status], { size: 12 }),
      el('span', { text: String(count) }),
    );
  }

  private renderFilter(): HTMLElement {
    return el(
      'div',
      { className: 'tests-filter' },
      el('input', {
        className: 'input',
        placeholder: 'Filtrar por nombre…',
        value: this.query,
        on: {
          input: (event) => {
            this.query = (event.currentTarget as HTMLInputElement).value;
            this.render();
          },
        },
      }),
      el(
        'button',
        {
          className: `icon-btn${this.onlyFailed ? ' active' : ''}`,
          title: this.onlyFailed ? 'Ver todas las pruebas' : 'Ver sólo las que fallan',
          on: {
            click: () => {
              this.onlyFailed = !this.onlyFailed;
              this.render();
            },
          },
        },
        icon('alert-circle', { size: 15 }),
      ),
    );
  }

  private renderEmpty(): HTMLElement {
    return el(
      'div',
      { className: 'empty-hint' },
      el('p', {
        text:
          this.solution === null
            ? 'Abre una solución para ver sus pruebas.'
            : 'No se han encontrado pruebas en los proyectos de pruebas de la solución.',
      }),
      el('p', {
        className: 'muted',
        text: 'Se reconocen [Fact] y [Theory] de xUnit, [Test] de NUnit y [TestMethod] de MSTest.',
      }),
    );
  }

  private renderProject(project: TestProjectNode): HTMLElement {
    const key = `project:${project.project}`;
    const open = !this.collapsed.has(key);
    const statuses = project.classes.flatMap((node) => node.tests.map((test) => this.statusOf(test.id)));

    const section = el(
      'div',
      { className: 'tests-project' },
      el(
        'button',
        {
          className: 'tests-group',
          on: { click: () => this.toggle(key) },
        },
        icon(open ? 'chevron-down' : 'chevron-right', { size: 13 }),
        icon('flask', { size: 14 }),
        el('span', { className: 'tests-name', text: project.name }),
        this.statusDot(aggregateStatus(statuses)),
        el('span', { className: 'tests-count', text: String(project.count) }),
      ),
    );

    if (open) {
      for (const node of project.classes) section.appendChild(this.renderClass(node));
    }

    return section;
  }

  private renderClass(node: TestClassNode): HTMLElement {
    const key = `class:${node.id}`;
    const open = !this.collapsed.has(key);
    const statuses = node.tests.map((test) => this.statusOf(test.id));

    const row = el(
      'div',
      { className: 'tests-class-row' },
      el(
        'button',
        { className: 'tests-group nested', on: { click: () => this.toggle(key) } },
        icon(open ? 'chevron-down' : 'chevron-right', { size: 13 }),
        icon('braces', { size: 14 }),
        el('span', { className: 'tests-name', text: node.className, title: node.id }),
        this.statusDot(aggregateStatus(statuses)),
        el('span', { className: 'tests-count', text: String(node.tests.length) }),
      ),
      el(
        'button',
        {
          className: 'icon-btn tests-run',
          title: `Ejecutar las ${node.tests.length} pruebas de ${node.className}`,
          disabled: this.runningTaskId !== null,
          on: { click: () => this.runClass(node) },
        },
        icon('play', { size: 13 }),
      ),
    );

    const section = el('div', { className: 'tests-class' }, row);

    if (open) {
      for (const test of node.tests) section.appendChild(this.renderTest(test));
    }

    return section;
  }

  private renderTest(test: TestCase): HTMLElement {
    const status = this.statusOf(test.id);
    const detail = this.detail.get(test.id);
    const expanded = status === 'failed';

    const row = el(
      'div',
      { className: `tests-row ${status}` },
      el(
        'button',
        {
          className: 'tests-case',
          title: test.skip === null ? test.id : `${test.id}\nOmitida: ${test.skip}`,
          on: { click: () => this.host.openFile(test.file, test.methodLine) },
        },
        icon(STATUS_ICON[status], { size: 13 }),
        el('span', { className: 'tests-name', text: test.displayName }),
        test.kind === 'theory' ? el('span', { className: 'tests-kind', text: 'theory' }) : null,
      ),
      el(
        'button',
        {
          className: 'icon-btn tests-run',
          title: `Ejecutar ${test.method}`,
          disabled: this.runningTaskId !== null,
          on: { click: () => this.runTest(test) },
        },
        icon('play', { size: 13 }),
      ),
    );

    const wrapper = el('div', { className: 'tests-case-wrap' }, row);

    // El error se enseña aquí mismo, además de en el panel de problemas: mirar por qué ha fallado
    // no debería costar un viaje a otra pestaña.
    if (expanded && detail?.message) {
      wrapper.appendChild(
        el(
          'div',
          { className: 'tests-error' },
          el('pre', { className: 'tests-message', text: detail.message.trim() }),
          detail.stackTrace === null
            ? null
            : el('pre', { className: 'tests-stack', text: detail.stackTrace.trim() }),
        ),
      );
    }

    return wrapper;
  }

  private statusDot(status: TestStatus): HTMLElement {
    return el('span', { className: `tests-dot ${status}`, title: STATUS_LABEL[status] });
  }

  private toggle(key: string): void {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.render();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileNameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
