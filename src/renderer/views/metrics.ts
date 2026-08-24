/**
 * Pestaña "Métricas" del panel inferior.
 *
 * Contesta a la pregunta que aparece cuando la aplicación ya arranca pero va rara: *¿esto está
 * gastando memoria, CPU o está recolectando basura sin parar?* Se apoya en `dotnet-counters`, que
 * lee los EventCounters que el propio runtime publica: no hay que instrumentar la aplicación ni
 * añadirle un paquete.
 *
 * Tres reglas de presentación:
 *
 *  - **Una barra por métrica, no un panel de aviación.** Doce gráficos a la vez no se miran; se
 *    enseñan valor, barra y una línea de tendencia de los últimos sesenta segundos.
 *  - **La escala de la barra es una escala, no una alarma.** 512 MB de montón no significa que algo
 *    vaya mal: significa dónde está el extremo de la barra. Los contadores sin techo razonable
 *    —las cuentas de GC, las peticiones totales— salen sólo con su número.
 *  - **Sin la herramienta instalada el panel no desaparece**: dice qué falta y da la orden de
 *    instalación, como el panel de contenedores con Docker apagado.
 */
import type { CounterSample, DotnetProcess, MetricId, MetricsState } from '../../shared/contracts.js';
import {
  applySamples,
  COUNTERS_MISSING_HINT,
  EMPTY_SNAPSHOT,
  fillRatio,
  formatMetric,
  IDLE_METRICS,
  METRICS,
  metricInfo,
  pushPoint,
  sparklinePath,
  type MetricsSnapshot,
} from '../../shared/perf-counters.js';
import { clear, el } from '../dom.js';
import { icon } from '../icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Un minuto de historia a un refresco cada dos segundos. Más allá ya no se lee la tendencia. */
const SERIES_LENGTH = 30;

const GROUP_LABEL: Record<string, string> = {
  cpu: 'Proceso',
  memory: 'Memoria',
  gc: 'Recolección de basura',
  http: 'HTTP',
};

export interface MetricsHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  /** Repinta el panel: las muestras llegan por evento, fuera de cualquier ciclo de pintado. */
  refresh(): void;
  /** Procesos arrancados desde el IDE, para preseleccionar el que interesa. */
  runningServiceNames(): string[];
}

export class MetricsView {
  private state: MetricsState = IDLE_METRICS;
  private processes: DotnetProcess[] = [];
  private selected: number | null = null;

  private snapshot: MetricsSnapshot = EMPTY_SNAPSHOT;
  private readonly series = new Map<MetricId, number[]>();

  private loading = false;

  /**
   * true en cuanto se ha preguntado por la herramienta y los procesos.
   *
   * El panel se pinta la primera vez al pulsar su pestaña, y ahí todavía no se ha preguntado nada:
   * sin esto la primera visita enseña "sin procesos .NET" aunque haya tres corriendo, y sólo se
   * arregla pulsando refrescar — que es justo lo que nadie hace.
   */
  private loaded = false;

  constructor(private readonly host: MetricsHost) {}

  // --- Estado ---------------------------------------------------------------------------------

  getState(): MetricsState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state.status === 'running' || this.state.status === 'starting';
  }

  /** Llega del evento `onMetricsSample`: estado y, si las hay, muestras nuevas. */
  applyEvent(state: MetricsState, samples: CounterSample[], at: number): void {
    this.state = state;

    if (samples.length > 0) {
      this.snapshot = applySamples(this.snapshot, samples, at);

      for (const metric of METRICS) {
        const value = this.snapshot[metric.id];
        if (value === undefined) continue;
        this.series.set(metric.id, pushPoint(this.series.get(metric.id) ?? [], value, SERIES_LENGTH));
      }
    }

    this.host.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.loaded = true;

    try {
      this.state = await window.dotforge.metrics.state();
      this.processes = this.state.available ? await window.dotforge.metrics.processes() : [];

      if (this.selected === null || !this.processes.some((entry) => entry.pid === this.selected)) {
        this.selected = this.preferredProcess()?.pid ?? this.processes[0]?.pid ?? null;
      }
    } catch {
      // Un fallo al listar procesos no vacía el panel: se enseña lo último que se supo.
    } finally {
      this.loading = false;
      this.host.refresh();
    }
  }

  /**
   * Proceso que probablemente interesa: uno de los que ha arrancado el IDE.
   *
   * En una máquina de desarrollo hay siempre varios procesos .NET vivos —el servidor de lenguaje
   * del propio IDE, entre ellos— y monitorizar el equivocado da números que no significan nada.
   */
  private preferredProcess(): DotnetProcess | null {
    const names = this.host.runningServiceNames().map((name) => name.toLowerCase());
    if (names.length === 0) return null;

    return (
      this.processes.find((entry) => names.some((name) => entry.name.toLowerCase().includes(name))) ?? null
    );
  }

  async start(): Promise<void> {
    if (this.selected === null) {
      this.host.notify('Elige un proceso .NET para monitorizar.', 'warn');
      return;
    }

    const process = this.processes.find((entry) => entry.pid === this.selected) ?? null;

    this.snapshot = { ...EMPTY_SNAPSHOT };
    this.series.clear();

    try {
      this.state = await window.dotforge.metrics.start(this.selected, process?.name ?? null);
    } catch (error) {
      this.host.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.host.refresh();
    }
  }

  async stop(): Promise<void> {
    try {
      await window.dotforge.metrics.stop();
    } finally {
      this.state = { ...this.state, status: 'idle', pid: null, processName: null };
      this.host.refresh();
    }
  }

  // --- Pintado --------------------------------------------------------------------------------

  render(container: HTMLElement): void {
    if (!this.loaded && !this.loading) {
      this.loaded = true;
      void this.refresh();
    }

    clear(container);
    container.appendChild(this.renderHeader());

    if (!this.state.available) {
      container.appendChild(
        el(
          'div',
          { className: 'notice warn' },
          icon('alert-triangle', { size: 15 }),
          el('span', { text: COUNTERS_MISSING_HINT }),
        ),
      );
      return;
    }

    if (this.state.message !== null && this.state.status === 'error') {
      container.appendChild(
        el('div', { className: 'notice warn' }, icon('alert-circle', { size: 15 }), el('span', { text: this.state.message })),
      );
    }

    if (this.state.status === 'idle' && this.snapshot.at === 0) {
      container.appendChild(
        el('div', {
          className: 'empty-hint',
          text:
            this.processes.length === 0
              ? 'No hay ningún proceso .NET en marcha. Arranca la aplicación y vuelve a refrescar.'
              : 'Elige el proceso y pulsa Monitorizar para ver sus contadores en directo.',
        }),
      );
      return;
    }

    const grid = el('div', { className: 'metrics-grid' });

    for (const group of ['cpu', 'memory', 'gc', 'http'] as const) {
      const metrics = METRICS.filter((metric) => metric.group === group);
      // Un grupo del que todavía no ha llegado ni un valor no se pinta: una tabla de guiones no
      // informa de nada, y HTTP no existe si la aplicación no es una web.
      if (metrics.every((metric) => this.snapshot[metric.id] === undefined)) continue;

      grid.appendChild(
        el(
          'div',
          { className: 'metrics-group' },
          el('h4', { className: 'metrics-group-title', text: GROUP_LABEL[group] ?? group }),
          ...metrics.map((metric) => this.renderMetric(metric.id)),
        ),
      );
    }

    container.appendChild(grid);
  }

  private renderHeader(): HTMLElement {
    const running = this.isRunning();

    const head = el(
      'div',
      { className: 'metrics-head' },
      el('span', { className: `metrics-dot ${this.state.status}` }),
      el('span', {
        className: 'metrics-status',
        text:
          this.state.status === 'running'
            ? `Monitorizando ${this.state.processName ?? this.state.pid ?? ''}`
            : this.state.status === 'starting'
              ? 'Conectando con el proceso…'
              : 'Detenido',
      }),
    );

    const select = el(
      'select',
      {
        className: 'settings-select metrics-select',
        disabled: running || this.processes.length === 0,
        on: {
          change: (event) => {
            this.selected = Number((event.currentTarget as HTMLSelectElement).value);
          },
        },
      },
      ...this.processes.map((entry) =>
        el('option', {
          text: `${entry.name} (${entry.pid})`,
          value: String(entry.pid),
          attrs: { ...(entry.pid === this.selected ? { selected: 'selected' } : {}) },
        }),
      ),
    );

    if (this.processes.length === 0) {
      select.appendChild(el('option', { text: 'Sin procesos .NET', value: '' }));
    }

    head.append(
      select,
      el(
        'button',
        {
          className: running ? 'btn' : 'btn primary',
          disabled: !this.state.available || (this.processes.length === 0 && !running),
          title: running ? 'Detener la monitorización' : 'Empezar a leer los contadores del proceso',
          on: { click: () => void (running ? this.stop() : this.start()) },
        },
        icon(running ? 'stop' : 'gauge', { size: 15 }),
        el('span', { text: running ? 'Detener' : 'Monitorizar' }),
      ),
      el(
        'button',
        {
          className: 'icon-btn',
          disabled: this.loading,
          title: 'Volver a listar los procesos .NET',
          on: { click: () => void this.refresh() },
        },
        icon('refresh', { size: 15 }),
      ),
    );

    return head;
  }

  private renderMetric(id: MetricId): HTMLElement {
    const info = metricInfo(id);
    const value = this.snapshot[id];
    const series = this.series.get(id) ?? [];

    const row = el(
      'div',
      { className: 'metric-row' },
      el('span', { className: 'metric-label', text: info.label }),
      el('span', { className: 'metric-value', text: formatMetric(id, value) }),
    );

    if (info.full !== null) {
      row.appendChild(
        el(
          'span',
          { className: 'metric-bar' },
          el('span', {
            className: `metric-fill ${id}`,
            style: { width: `${(fillRatio(id, value) * 100).toFixed(1)}%` },
          }),
        ),
      );
    }

    if (series.length > 1) row.appendChild(this.renderSparkline(series, info.full));

    return row;
  }

  /** Gráfico de línea. Se construye con `createElementNS`: el renderer nunca inyecta marcado. */
  private renderSparkline(values: number[], ceiling: number | null): SVGElement {
    const width = 72;
    const height = 18;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'metric-spark');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', sparklinePath(values, width, height, ceiling ?? undefined));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');

    svg.appendChild(path);
    return svg;
  }
}
