/**
 * Panel de contenedores y Docker Compose.
 *
 * Responde a lo que se pregunta un desarrollador .NET antes de pulsar F5: *¿está levantada la base
 * de datos?* Y da el botón para levantarla sin cambiar de ventana.
 *
 * La vista tiene una idea central: **el compose manda, el motor confirma**. La lista de servicios
 * sale del `docker-compose.yml` del repositorio —existe aunque no haya nada levantado, y es lo que
 * describe la intención del proyecto— y a cada servicio se le pega el estado del contenedor real
 * si lo hay. Al revés (listar lo que corre y adivinar de dónde sale) dejaría el panel vacío justo
 * cuando más falta hace: con todo apagado.
 *
 * Los contenedores que no pertenecen al compose del proyecto se listan aparte, sin mezclarlos: son
 * de otro trabajo y confundirlos lleva a parar lo que no era.
 */
import type {
  ComposeAction,
  ComposeFile,
  ContainerAction,
  DockerContainer,
  DockerEngineState,
  SolutionInfo,
} from '../../shared/contracts.js';
import type { ServiceStatus } from '../../shared/compose.js';
import { matchComposeState } from '../../shared/compose.js';
import { supportLabel } from '../../shared/docker.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { confirmDialog } from './confirm-dialog.js';

export interface ContainersHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  /** Enseña el canal de salida donde va la tarea de Docker. */
  showOutput(): void;
  /** Abre una URL en el navegador del sistema (la interfaz de Seq, de RabbitMQ…). */
  openUrl(url: string): void;
  /** Abre el `docker-compose.yml` en el editor. */
  openFile(path: string): void;
}

/** Icono por tipo de servicio de apoyo. Con lo que ya hay: sin inventar iconos nuevos. */
const KIND_ICON: Record<string, IconName> = {
  sqlserver: 'database',
  postgres: 'database',
  mysql: 'database',
  mongo: 'database',
  redis: 'zap',
  rabbitmq: 'exchange',
  kafka: 'exchange',
  elasticsearch: 'search',
  seq: 'list',
  azurite: 'globe',
  mailhog: 'send',
  other: 'package',
};

export class ContainersView {
  private visible = false;

  private state: DockerEngineState | null = null;
  private composeFiles: string[] = [];
  private selectedCompose: string | null = null;
  private compose: ComposeFile | null = null;

  private loading = false;
  private runningTaskId: string | null = null;

  constructor(private readonly host: ContainersHost) {}

  // --- Estado ---------------------------------------------------------------------------------

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) return;

    this.render();
    void this.refresh();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Cambia de solución.
   *
   * No se guarda la solución: los archivos de Compose los busca el proceso principal en el
   * workspace abierto, así que aquí sólo hay que tirar lo leído y volver a preguntar.
   */
  setSolution(_solution: SolutionInfo | null): void {
    this.state = null;
    this.compose = null;
    this.composeFiles = [];
    this.selectedCompose = null;

    if (this.visible) void this.refresh();
  }

  /** Cuando termina una acción de Docker, el estado del motor ha cambiado: se relee. */
  noteTaskExit(taskId: string, code: number | null): void {
    if (this.runningTaskId !== taskId) return;

    this.runningTaskId = null;
    if (code !== 0) this.host.notify('La acción de Docker ha fallado. Mira la salida para el detalle.', 'warn');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.render();

    try {
      const [state, files] = await Promise.all([
        window.dotforge.docker.state(),
        window.dotforge.docker.composeFiles(),
      ]);

      this.state = state;
      this.composeFiles = files;
      if (this.selectedCompose === null || !files.includes(this.selectedCompose)) {
        this.selectedCompose = files[0] ?? null;
      }

      this.compose = this.selectedCompose === null ? null : await window.dotforge.docker.composeRead(this.selectedCompose);
    } catch (error) {
      this.host.notify(error instanceof Error ? error.message : String(error), 'warn');
    } finally {
      this.loading = false;
      this.render();
    }
  }

  // --- Acciones -------------------------------------------------------------------------------

  private async runCompose(action: ComposeAction, service?: string | null): Promise<void> {
    if (this.selectedCompose === null || this.runningTaskId !== null) return;

    try {
      const task = await window.dotforge.docker.composeRun(action, this.selectedCompose, service ?? null);
      this.runningTaskId = task.taskId;
      this.host.showOutput();
      this.render();
    } catch (error) {
      this.host.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async runContainer(action: ContainerAction, container: string): Promise<void> {
    if (this.runningTaskId !== null) return;

    // Eliminar un contenedor borra sus datos si no tiene volumen: se confirma nombrando cuál.
    if (
      action === 'remove' &&
      !(await confirmDialog({
        title: 'Eliminar el contenedor',
        message: `Se va a eliminar "${container}".`,
        detail: 'Si no tiene volumen, sus datos se pierden.',
        confirmLabel: 'Eliminar',
        tone: 'danger',
      }))
    ) {
      return;
    }

    try {
      const task = await window.dotforge.docker.containerRun(action, container);
      this.runningTaskId = task.taskId;
      if (action === 'logs') this.host.showOutput();
      this.render();
    } catch (error) {
      this.host.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /** Levanta todo el compose. Lo llaman el botón y el comando de la paleta. */
  async composeUp(): Promise<void> {
    if (this.selectedCompose === null) await this.refresh();
    await this.runCompose('up');
  }

  /** Baja todo el compose. */
  async composeDown(): Promise<void> {
    if (this.selectedCompose === null) await this.refresh();
    await this.runCompose('down');
  }

  // --- Correspondencia entre compose y motor ---------------------------------------------------

  /**
   * Estado de cada servicio declarado y contenedores ajenos.
   *
   * El cruce vive en `src/shared/compose.ts` y es una función pura: son reglas con casos borde
   * —dos proyectos con un servicio `redis`, un contenedor levantado a mano— que merecen pruebas y
   * no una comprobación a ojo con Docker delante.
   */
  private composeState(): ReturnType<typeof matchComposeState> {
    return matchComposeState(this.compose, this.state?.containers ?? []);
  }

  // --- Pintado --------------------------------------------------------------------------------

  render(): void {
    if (!this.visible) return;

    const container = byId('sidebar-content');
    clear(container);
    byId('sidebar-title').textContent = 'Contenedores';

    const actions = byId('sidebar-actions');
    clear(actions);
    actions.appendChild(
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Releer el estado de Docker',
          disabled: this.loading,
          on: { click: () => void this.refresh() },
        },
        icon('refresh', { size: 15 }),
      ),
    );

    const panel = el('div', { className: 'docker-panel' });

    /**
     * Docker apagado **no** vacía el panel.
     *
     * Los servicios se siguen enseñando —salen del `docker-compose.yml`, que está en el
     * repositorio— con sus acciones deshabilitadas y un aviso arriba que dice qué pasa. Ocultarlo
     * todo dejaría al usuario sin saber siquiera qué necesita este proyecto para arrancar, que es
     * la mitad del valor del panel.
     */
    if (this.state !== null && !this.state.available) {
      panel.appendChild(
        el(
          'div',
          { className: 'notice warn docker-offline' },
          icon('alert-triangle', { size: 15 }),
          el(
            'span',
            {},
            el('strong', { text: this.state.reason ?? 'Docker no está disponible. ' }),
            ' Arranca tu motor de contenedores y pulsa refrescar.',
          ),
        ),
      );
    }

    if (this.composeFiles.length > 0) panel.append(this.renderComposeHeader(), this.renderServices());
    else panel.appendChild(this.renderNoCompose());

    const others = this.composeState().others;
    if (others.length > 0) panel.appendChild(this.renderOthers(others));

    container.appendChild(panel);
  }

  /** Con Docker apagado o una acción en marcha, no se puede pulsar nada. */
  private get busy(): boolean {
    return this.runningTaskId !== null || this.state?.available === false;
  }

  private renderComposeHeader(): HTMLElement {
    const busy = this.busy;
    const statuses = this.composeState().services;
    const running = statuses.filter((status) => status.state === 'running');
    const total = statuses.length;

    const head = el(
      'div',
      { className: 'docker-head' },
      el(
        'button',
        {
          className: 'docker-file',
          title: this.selectedCompose ?? '',
          on: { click: () => this.selectedCompose !== null && this.host.openFile(this.selectedCompose) },
        },
        icon('list', { size: 14 }),
        el('span', { text: fileNameOf(this.selectedCompose ?? '') }),
      ),
      el('span', { className: 'docker-count', text: `${running.length}/${total} arriba` }),
    );

    // Con varios composes (raíz + override, o uno por entorno) se elige cuál gobierna el panel.
    if (this.composeFiles.length > 1) {
      head.appendChild(
        el(
          'select',
          {
            className: 'settings-select docker-select',
            on: {
              change: (event) => {
                this.selectedCompose = (event.currentTarget as HTMLSelectElement).value;
                void this.refresh();
              },
            },
          },
          ...this.composeFiles.map((file) =>
            el('option', {
              text: fileNameOf(file),
              value: file,
              attrs: { ...(file === this.selectedCompose ? { selected: 'selected' } : {}) },
            }),
          ),
        ),
      );
    }

    const actions = el(
      'div',
      { className: 'docker-actions' },
      el(
        'button',
        {
          className: 'btn primary docker-action',
          disabled: busy,
          title: 'Levanta todos los servicios en segundo plano (docker compose up -d)',
          on: { click: () => void this.runCompose('up') },
        },
        icon('play', { size: 15 }),
        el('span', { text: 'Levantar' }),
      ),
      el(
        'button',
        {
          className: 'btn docker-action',
          disabled: busy,
          title: 'Para y elimina los servicios (docker compose down)',
          on: { click: () => void this.runCompose('down') },
        },
        icon('stop', { size: 15 }),
        el('span', { text: 'Bajar' }),
      ),
      el(
        'button',
        {
          className: 'btn docker-icon-action',
          disabled: busy,
          title: 'Ver el registro de todos los servicios',
          attrs: { 'aria-label': 'Ver el registro' },
          on: { click: () => void this.runCompose('logs') },
        },
        icon('history', { size: 15 }),
      ),
    );

    return el(
      'div',
      { className: 'docker-compose' },
      head,
      actions,
      this.runningTaskId !== null
        ? el(
            'div',
            { className: 'docker-running' },
            el('span', { className: 'spinner' }),
            el('span', { text: 'Ejecutando docker… la salida va al panel inferior.' }),
          )
        : null,
    );
  }

  private renderNoCompose(): HTMLElement {
    return el(
      'div',
      { className: 'empty-state' },
      el('div', { className: 'empty-state-icon' }, icon('package', { size: 28 })),
      el('div', { text: 'Este workspace no tiene ningún docker-compose.yml.' }),
      el('div', {
        className: 'empty-state-hint',
        text: 'Se busca en la raíz y un nivel por debajo (deploy/, docker/, infra/).',
      }),
    );
  }

  private renderServices(): HTMLElement {
    const list = el('div', { className: 'docker-list' });

    for (const status of this.composeState().services) {
      list.appendChild(this.renderService(status));
    }

    if ((this.compose?.services.length ?? 0) === 0) {
      list.appendChild(el('div', { className: 'docker-hint', text: 'El compose no declara ningún servicio.' }));
    }

    return list;
  }

  private renderService(status: ServiceStatus): HTMLElement {
    const { service, state, ports, url } = status;
    const up = state === 'running';
    const busy = this.busy;

    const row = el(
      'div',
      { className: `docker-row ${up ? 'up' : 'down'}`, title: service.image ?? service.build ?? service.name },
      el('span', { className: `docker-dot ${state}` }),
      icon(KIND_ICON[service.kind] ?? 'package', { size: 15 }),
      el(
        'div',
        { className: 'docker-row-text' },
        el('span', { className: 'docker-name', text: service.name }),
        el('span', { className: 'docker-image', text: service.label }),
      ),
    );

    if (ports.length > 0) {
      const label = ports.map((port) => port.host).join(', ');
      row.appendChild(
        url === null
          ? el('span', { className: 'docker-port', text: label })
          : el(
              'button',
              {
                className: 'docker-port link',
                title: `Abrir ${url}`,
                on: { click: () => this.host.openUrl(url) },
              },
              el('span', { text: label }),
            ),
      );
    }

    const action = (name: IconName, title: string, run: () => void): HTMLElement =>
      el(
        'button',
        { className: 'docker-row-action', title, disabled: busy, attrs: { 'aria-label': title }, on: { click: run } },
        icon(name, { size: 13 }),
      );

    const actions = el('div', { className: 'docker-row-actions' });

    if (up) {
      actions.append(
        action('stop', `Parar ${service.name}`, () => void this.runCompose('stop', service.name)),
        action('refresh', `Reiniciar ${service.name}`, () => void this.runCompose('restart', service.name)),
      );
    } else {
      actions.appendChild(action('play', `Levantar ${service.name}`, () => void this.runCompose('up', service.name)));
    }

    actions.appendChild(action('history', `Registro de ${service.name}`, () => void this.runCompose('logs', service.name)));

    row.appendChild(actions);
    return row;
  }

  private renderOthers(containers: readonly DockerContainer[]): HTMLElement {
    const section = el(
      'div',
      { className: 'docker-others' },
      el('div', { className: 'docker-section-title', text: 'Otros contenedores' }),
    );

    const busy = this.busy;

    for (const container of containers) {
      const up = container.state === 'running';

      const row = el(
        'div',
        { className: `docker-row ${up ? 'up' : 'down'}`, title: `${container.image} — ${container.status}` },
        el('span', { className: `docker-dot ${container.state}` }),
        icon('package', { size: 15 }),
        el(
          'div',
          { className: 'docker-row-text' },
          el('span', { className: 'docker-name', text: container.name }),
          el('span', { className: 'docker-image', text: supportLabel(container.image) }),
        ),
        container.ports.length > 0
          ? el('span', { className: 'docker-port', text: container.ports.map((port) => port.host).join(', ') })
          : null,
        el(
          'div',
          { className: 'docker-row-actions' },
          el(
            'button',
            {
              className: 'docker-row-action',
              disabled: busy,
              title: up ? `Parar ${container.name}` : `Arrancar ${container.name}`,
              attrs: { 'aria-label': up ? 'Parar' : 'Arrancar' },
              on: { click: () => void this.runContainer(up ? 'stop' : 'start', container.name) },
            },
            icon(up ? 'stop' : 'play', { size: 13 }),
          ),
          el(
            'button',
            {
              className: 'docker-row-action',
              disabled: busy,
              title: `Registro de ${container.name}`,
              attrs: { 'aria-label': 'Registro' },
              on: { click: () => void this.runContainer('logs', container.name) },
            },
            icon('history', { size: 13 }),
          ),
          el(
            'button',
            {
              className: 'docker-row-action',
              disabled: busy,
              title: `Eliminar ${container.name}`,
              attrs: { 'aria-label': 'Eliminar' },
              on: { click: () => void this.runContainer('remove', container.name) },
            },
            icon('trash', { size: 13 }),
          ),
        ),
      );

      section.appendChild(row);
    }

    return section;
  }
}

/** Último segmento de una ruta, sin depender del separador del sistema. */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
