/**
 * Panel visual de paquetes NuGet.
 *
 * Buscar, ver lo instalado, instalar una versión concreta y desinstalar, sin salir del IDE.
 * Los iconos de los paquetes se dibujan localmente (inicial sobre un cuadro) en lugar de
 * descargarse: así el panel no revela a terceros qué está buscando el usuario.
 */
import type { AuditReport, NuGetSearchResult, ProjectInfo, SolutionInfo, VulnerablePackage } from '../../shared/contracts.js';
import { countBySeverity, describeAudit, SEVERITY_LABEL } from '../../shared/nuget-audit.js';
import {
  createPlan,
  describeProgress,
  isComplete,
  markFailed,
  markRunning,
  nextPending,
  noteExit,
  summarizeInstall,
  type PackageInstallPlan,
} from '../../shared/nuget-install.js';
import { byId, clear, compactNumber, debounce, el, repaintPreservingFocus } from '../dom.js';
import { FOCUS_KEY_ATTRIBUTE } from '../focus-guard.js';
import { icon } from '../icons.js';

export interface NuGetHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  reloadSolution(): void;
  /** Abre el aviso de seguridad en el navegador del sistema. */
  openUrl(url: string): void;
  /**
   * La auditoría ha terminado: el número de paquetes con aviso ha cambiado.
   *
   * Lo escucha la barra de actividad, que pinta ese número como insignia sobre el icono de NuGet.
   * Sin este aviso la insignia sólo aparecía al repintar la barra por otro motivo.
   */
  vulnerabilitiesChanged(): void;
}

export class NuGetView {
  private solution: SolutionInfo | null = null;
  /**
   * Proyectos marcados como destino de la instalación.
   *
   * El primero marcado es además el que manda en "Instalados en…": el panel enseña los paquetes de
   * un proyecto concreto, no la unión de varios, porque la unión no se puede desinstalar.
   */
  private readonly targets = new Set<string>();
  /** Instalación en varios proyectos en curso. Null si no hay ninguna. */
  private plan: PackageInstallPlan | null = null;
  private results: NuGetSearchResult[] = [];
  private query = '';
  private includePrerelease = false;
  private loading = false;
  /** Sólo la vista activa escribe en la barra lateral. Ver la nota en ExplorerView. */
  private visible = false;
  private error: string | null = null;
  /** Número de orden de la búsqueda en vuelo: descarta las respuestas que llegan tarde. */
  private searchToken = 0;
  private readonly versionChoice = new Map<string, string>();

  /** Última auditoría de seguridad. Null si no se ha ejecutado en esta solución. */
  private auditReport: AuditReport | null = null;
  private auditing = false;
  private auditOpen = true;

  private readonly runSearch = debounce(() => void this.performSearch(), 320);

  constructor(private readonly host: NuGetHost) {}

  /**
   * Llega al abrir una solución **y en cada relectura**.
   *
   * La distinción importa mucho más de lo que parece: instalar un paquete cambia el `.csproj`, así
   * que el renderer relee la solución al terminar **cada** tarea de `dotnet`. Tratar toda relectura
   * como "otra solución" tiraba la selección de proyectos del usuario a media instalación, y con
   * ella el plan en marcha: la cadena moría después del segundo proyecto sin decir nada. Sólo se
   * reinicia el estado cuando de verdad se ha cambiado de solución.
   */
  setSolution(solution: SolutionInfo | null): void {
    const previous = this.solution;
    const sameSolution =
      solution !== null && previous !== null && solution.directory === previous.directory && solution.path === previous.path;

    this.solution = solution;

    if (sameSolution) {
      // Un proyecto puede haber desaparecido del `.sln` entre relecturas.
      const alive = new Set(solution.projects.map((project) => project.path));
      for (const path of [...this.targets]) {
        if (!alive.has(path)) this.targets.delete(path);
      }
    } else {
      this.targets.clear();
      const first = solution?.projects[0]?.path;
      if (first !== undefined) this.targets.add(first);

      // La auditoría es de la solución que se cierra: no vale para la siguiente. Y un plan a medias
      // sobre la anterior no significa nada aquí.
      this.auditReport = null;
      this.plan = null;
    }

    this.render();
  }

  /** Número de paquetes con aviso. Lo usa la insignia de la barra de actividad. */
  vulnerableCount(): number {
    return this.auditReport?.packages.length ?? 0;
  }

  /**
   * Ejecuta `dotnet list package --vulnerable` sobre la solución.
   *
   * No se lanza sola al abrir la solución: consulta la red y puede restaurar, así que arrancar el
   * IDE no debería costar eso. Se pide desde el botón, la paleta o el menú.
   */
  async audit(): Promise<void> {
    if (this.auditing) return;
    if (this.solution === null) {
      this.host.notify('Abre una solución para auditar sus paquetes.', 'warn');
      return;
    }

    this.auditing = true;
    this.auditOpen = true;
    this.render();

    try {
      this.auditReport = await window.dotforge.nuget.audit(null);

      const report = this.auditReport;
      this.host.notify(
        describeAudit(report),
        report.error !== null ? 'warn' : report.packages.length > 0 ? 'error' : 'ok',
      );
    } catch (error) {
      this.host.notify(`No se ha podido auditar: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.auditing = false;
      this.render();
      this.host.vulnerabilitiesChanged();
    }
  }

  /** Llega del menú del explorador: "ver los paquetes de este proyecto". */
  focusProject(project: ProjectInfo): void {
    this.targets.clear();
    this.targets.add(project.path);
    this.render();
  }

  /**
   * Proyectos marcados, en el orden de la solución.
   *
   * El orden importa: es el de la instalación y el que se enseña en el progreso, y el de un `Set`
   * es el de inserción, que sería el orden en el que se pulsaron las casillas.
   */
  private selectedProjects(): ProjectInfo[] {
    return (this.solution?.projects ?? []).filter((project) => this.targets.has(project.path));
  }

  /** Proyecto cuyos paquetes instalados se enseñan: el primero de los marcados. */
  private selectedProject(): ProjectInfo | null {
    return this.selectedProjects()[0] ?? null;
  }

  private toggleTarget(path: string): void {
    if (this.targets.has(path)) this.targets.delete(path);
    else this.targets.add(path);
    this.render();
  }

  /**
   * Consulta nuget.org.
   *
   * Cada búsqueda lleva su número de orden y sólo la última manda: dos consultas en vuelo pueden
   * volver al revés —la de "Seri" tarda más que la de "Serilog"— y sin esto el panel acabaría
   * enseñando los resultados de lo que el usuario ya había terminado de escribir.
   */
  private async performSearch(): Promise<void> {
    const request = ++this.searchToken;

    if (this.query.trim() === '') {
      this.results = [];
      this.loading = false;
      this.render();
      return;
    }

    this.loading = true;
    this.error = null;
    this.render();

    try {
      const results = await window.dotforge.nuget.search(this.query, this.includePrerelease);
      if (request !== this.searchToken) return;
      this.results = results;
    } catch (error) {
      if (request !== this.searchToken) return;
      this.results = [];
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.searchToken) {
        this.loading = false;
        this.render();
      }
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.render();
  }

  /**
   * Repinta el panel.
   *
   * Va envuelto en `repaintPreservingFocus` porque este panel se repinta **mientras se escribe**:
   * el rebote de la búsqueda dispara `performSearch`, que pinta el estado "Buscando…" y después los
   * resultados. Sin esa envoltura, cada pausa breve al teclear destruía el `<input>` enfocado y el
   * cursor se perdía a mitad de palabra.
   */
  render(): void {
    if (!this.visible) return;
    repaintPreservingFocus(byId('sidebar-content'), () => this.paint());
  }

  private paint(): void {
    const container = byId('sidebar-content');
    clear(container);
    byId('sidebar-title').textContent = 'Paquetes NuGet';
    clear(byId('sidebar-actions'));

    if (!this.solution || this.solution.projects.length === 0) {
      container.appendChild(
        el('div', { className: 'empty-state', text: 'Abre una solución con al menos un proyecto para gestionar paquetes.' }),
      );
      return;
    }

    container.appendChild(this.renderProjectPicker());
    container.appendChild(this.renderSearchBar());

    // El progreso va aquí y no dentro de los resultados: la instalación dura minutos y el usuario
    // puede haber borrado la búsqueda mientras tanto. Una operación en marcha que desaparece de la
    // vista al cambiar de sitio no está en marcha para quien la lanzó.
    const progress = this.renderInstallProgress();
    if (progress !== null) container.appendChild(progress);

    if (this.error) {
      container.appendChild(el('div', { className: 'notice error', text: this.error }));
    }

    if (this.loading) {
      container.appendChild(
        el('div', { className: 'empty-state' }, el('span', { className: 'spinner' }), ' Buscando en nuget.org…'),
      );
      return;
    }

    container.appendChild(this.renderAudit());
    container.appendChild(this.query.trim() === '' ? this.renderInstalled() : this.renderResults());
  }

  /**
   * Selector de proyectos, con casilla por proyecto.
   *
   * Era un desplegable de selección única, y por eso añadir Serilog a una solución Clean costaba
   * cuatro viajes por el mismo sitio. Ahora la selección es explícita y visible: se ve en qué
   * proyectos va a entrar el paquete **antes** de pulsar Instalar, que es cuando sirve de algo.
   *
   * "Todos" y "Ninguno" están porque el caso frecuente de verdad es "en todos menos en el de
   * pruebas": marcar cuatro casillas a mano para desmarcar una es peor que pulsar dos botones.
   */
  private renderProjectPicker(): HTMLElement {
    const projects = this.solution!.projects;
    const chosen = this.targets.size;

    const head = el(
      'div',
      { className: 'nuget-projects-head' },
      icon('project', { size: 13, className: 'tone-muted' }),
      el('span', {
        className: 'nuget-projects-title',
        text: chosen === 1 ? '1 proyecto seleccionado' : `${chosen} proyectos seleccionados`,
      }),
      el('button', {
        className: 'link-btn',
        text: 'Todos',
        disabled: chosen === projects.length,
        on: {
          click: () => {
            for (const project of projects) this.targets.add(project.path);
            this.render();
          },
        },
      }),
      el('button', {
        className: 'link-btn',
        text: 'Ninguno',
        disabled: chosen === 0,
        on: {
          click: () => {
            this.targets.clear();
            this.render();
          },
        },
      }),
    );

    const list = el('div', { className: 'nuget-projects' });

    for (const project of projects) {
      const box = el('input', {
        type: 'checkbox',
        on: { change: () => this.toggleTarget(project.path) },
      }) as HTMLInputElement;
      box.checked = this.targets.has(project.path);

      list.appendChild(
        el(
          'label',
          { className: `nuget-project${box.checked ? ' checked' : ''}`, title: project.path },
          box,
          el('span', { className: 'nuget-project-name', text: project.name }),
          el('span', { className: 'nuget-project-count', text: String(project.packageReferences.length) }),
        ),
      );
    }

    return el('div', { className: 'nuget-projects-box' }, head, list);
  }

  private renderSearchBar(): HTMLElement {
    const input = el('input', {
      className: 'input',
      placeholder: 'Buscar paquetes en nuget.org…',
      value: this.query,
      attrs: { [FOCUS_KEY_ATTRIBUTE]: 'nuget-search' },
      on: {
        input: (event) => {
          this.query = (event.target as HTMLInputElement).value;
          this.runSearch();
        },
      },
    });

    // La casilla se pinta desde el estado, no "en blanco": el panel se repinta en cada búsqueda y
    // sin esto la marca desaparecía a la vista mientras la preferencia seguía activa por dentro.
    const prereleaseBox = el('input', {
      type: 'checkbox',
      on: {
        change: (event) => {
          this.includePrerelease = (event.target as HTMLInputElement).checked;
          void this.performSearch();
        },
      },
    }) as HTMLInputElement;
    prereleaseBox.checked = this.includePrerelease;

    const prerelease = el(
      'label',
      { className: 'checkbox', title: 'Incluir versiones preliminares' },
      prereleaseBox,
      'pre',
    );

    return el('div', { className: 'nuget-search' }, input, prerelease);
  }

  /**
   * Sección de seguridad.
   *
   * Está siempre visible aunque no se haya auditado: es la forma de que alguien descubra que el
   * IDE puede hacerlo. Sin auditar dice qué va a ejecutar; auditada, enseña lo que hay.
   */
  private renderAudit(): HTMLElement {
    const report = this.auditReport;
    const section = el('div', { className: 'nuget-audit' });

    const counts = report === null ? null : countBySeverity(report.packages);

    const head = el(
      'div',
      { className: 'nuget-audit-head' },
      el(
        'button',
        {
          className: 'nuget-audit-toggle',
          on: {
            click: () => {
              this.auditOpen = !this.auditOpen;
              this.render();
            },
          },
        },
        icon(this.auditOpen ? 'chevron-down' : 'chevron-right', { size: 13 }),
        icon('shield', { size: 14 }),
        el('span', { text: 'Seguridad' }),
        report === null || report.packages.length === 0
          ? null
          : el('span', { className: 'nuget-audit-count', text: String(report.packages.length) }),
      ),
      el(
        'button',
        {
          className: 'btn small',
          disabled: this.auditing || this.solution === null,
          title: 'dotnet list package --vulnerable --include-transitive',
          on: { click: () => void this.audit() },
        },
        this.auditing ? el('span', { className: 'spinner' }) : icon('refresh', { size: 13 }),
        el('span', { text: this.auditing ? 'Analizando…' : 'Analizar' }),
      ),
    );

    section.appendChild(head);
    if (!this.auditOpen) return section;

    if (this.auditing) {
      section.appendChild(el('div', { className: 'empty-state', text: 'Consultando los avisos de seguridad…' }));
      return section;
    }

    if (report === null) {
      section.appendChild(
        el('div', {
          className: 'package-meta',
          text: 'Sin analizar. Cruza los paquetes restaurados con los avisos de GitHub Security Advisories.',
        }),
      );
      return section;
    }

    if (report.error !== null) {
      section.appendChild(el('div', { className: 'notice warn', text: report.error }));
      return section;
    }

    if (report.packages.length === 0) {
      section.appendChild(
        el(
          'div',
          { className: 'notice ok' },
          icon('check', { size: 14 }),
          el('span', { text: 'Sin vulnerabilidades conocidas en los paquetes restaurados.' }),
        ),
      );
      return section;
    }

    if (counts !== null) {
      const pills = el('div', { className: 'nuget-audit-pills' });
      for (const severity of ['critical', 'high', 'moderate', 'low', 'unknown'] as const) {
        if (counts[severity] === 0) continue;
        pills.appendChild(
          el('span', {
            className: `severity-pill ${severity}`,
            text: `${SEVERITY_LABEL[severity]}: ${counts[severity]}`,
          }),
        );
      }
      section.appendChild(pills);
    }

    if (report.degraded) {
      section.appendChild(
        el('div', {
          className: 'package-meta',
          text: 'Leído de la tabla de texto: tu SDK no admite --format json, así que puede faltar detalle.',
        }),
      );
    }

    for (const entry of report.packages) section.appendChild(this.renderVulnerable(entry));

    return section;
  }

  private renderVulnerable(entry: VulnerablePackage): HTMLElement {
    const advisories = el('div', { className: 'vuln-advisories' });

    for (const vulnerability of entry.vulnerabilities) {
      advisories.appendChild(
        el(
          'button',
          {
            className: 'vuln-link',
            title: vulnerability.advisoryUrl,
            on: { click: () => this.host.openUrl(vulnerability.advisoryUrl) },
          },
          icon('external-link', { size: 12 }),
          el('span', { text: vulnerability.identifier ?? 'Aviso' }),
        ),
      );
    }

    return el(
      'div',
      { className: `vuln-row ${entry.worst}` },
      el(
        'div',
        { className: 'vuln-title' },
        el('span', { className: `severity-pill ${entry.worst}`, text: SEVERITY_LABEL[entry.worst] }),
        el('span', { className: 'package-id', text: entry.id }),
        el('span', { className: 'package-version', text: entry.resolvedVersion }),
        entry.transitive ? el('span', { className: 'vuln-transitive', text: 'transitivo' }) : null,
      ),
      el('div', {
        className: 'package-meta',
        text: `${entry.projectName}${entry.framework === null ? '' : ` · ${entry.framework}`}`,
      }),
      advisories,
    );
  }

  private renderInstalled(): HTMLElement {
    const project = this.selectedProject();
    const container = el('div');

    if (!project) {
      return el('div', { className: 'empty-state', text: 'Selecciona un proyecto.' });
    }

    if (project.packageReferences.length === 0) {
      return el('div', { className: 'empty-state', text: 'Este proyecto no referencia ningún paquete.' });
    }

    container.appendChild(
      el('div', { className: 'tree-group', text: `Instalados en ${project.name}` }),
    );

    for (const reference of project.packageReferences) {
      container.appendChild(
        el(
          'div',
          { className: 'package' },
          this.avatar(reference.id),
          el(
            'div',
            {},
            el(
              'div',
              { className: 'package-title' },
              el('span', { className: 'package-id', text: reference.id }),
              el('span', {
                className: 'package-version',
                text: reference.version ?? 'versión central',
              }),
            ),
            reference.centrallyManaged
              ? el('div', {
                  className: 'package-meta',
                  text: 'La versión la fija Directory.Packages.props',
                })
              : null,
            el(
              'div',
              { className: 'package-actions' },
              el('button', {
                className: 'btn danger',
                text: 'Desinstalar',
                on: { click: () => void this.uninstall(project, reference.id) },
              }),
            ),
          ),
        ),
      );
    }

    return container;
  }

  /**
   * Barra de progreso de la instalación en curso.
   *
   * Con un solo proyecto la notificación bastaba; con cuatro y una restauración por proyecto, no:
   * la operación dura minutos y hay que poder mirar en qué va sin leer el panel inferior.
   */
  private renderInstallProgress(): HTMLElement | null {
    const plan = this.plan;
    if (plan === null) return null;

    const progress = describeProgress(plan);
    const bar = el('div', { className: 'nuget-progress-fill' });
    bar.style.width = `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%`;

    return el(
      'div',
      { className: 'nuget-progress' },
      el(
        'div',
        { className: 'nuget-progress-head' },
        el('span', { className: 'spinner' }),
        el('span', { text: progress.text }),
      ),
      el('div', { className: 'nuget-progress-track' }, bar),
    );
  }

  private renderResults(): HTMLElement {
    const project = this.selectedProject();
    const targets = this.selectedProjects();
    const container = el('div');

    if (this.results.length === 0) {
      return el('div', { className: 'empty-state', text: 'Sin resultados.' });
    }

    const installed = new Map((project?.packageReferences ?? []).map((reference) => [reference.id.toLowerCase(), reference]));

    for (const result of this.results) {
      const current = installed.get(result.id.toLowerCase());
      const chosen = this.versionChoice.get(result.id) ?? result.version;

      const versionSelect = el('select', {
        className: 'input',
        style: { flex: '0 0 auto', maxWidth: '160px' },
        on: {
          change: (event) => {
            this.versionChoice.set(result.id, (event.target as HTMLSelectElement).value);
          },
        },
      }) as HTMLSelectElement;

      const versions = result.versions.length > 0 ? result.versions : [result.version];
      for (const version of versions.slice(0, 60)) {
        const option = el('option', { value: version, text: version }) as HTMLOptionElement;
        if (version === chosen) option.selected = true;
        versionSelect.appendChild(option);
      }

      container.appendChild(
        el(
          'div',
          { className: 'package' },
          this.avatar(result.id),
          el(
            'div',
            {},
            el(
              'div',
              { className: 'package-title' },
              el('span', { className: 'package-id', text: result.id }),
              result.verified ? el('span', { className: 'chip accent', text: '✓ verificado' }) : null,
              current ? el('span', { className: 'installed-badge', text: `instalado ${current.version ?? ''}`.trim() }) : null,
            ),
            el('div', {
              className: 'package-meta',
              text: `${result.authors || 'sin autor'} · ${compactNumber(result.totalDownloads)} descargas`,
            }),
            el('div', { className: 'package-description', text: result.description }),
            el(
              'div',
              { className: 'package-actions' },
              versionSelect,
              el(
                'button',
                {
                  className: 'btn primary',
                  // El botón dice en cuántos proyectos va a entrar: "Instalar" a secas, con cuatro
                  // marcados, no avisa de lo que va a pasar hasta que ya ha pasado.
                  title:
                    targets.length === 0
                      ? 'Marca al menos un proyecto'
                      : `${current ? 'Actualiza' : 'Instala'} en ${targets.map((entry) => entry.name).join(', ')}`,
                  disabled: targets.length === 0 || this.plan !== null,
                  on: { click: () => this.startInstall(result.id, versionSelect.value) },
                },
                el('span', {
                  text:
                    targets.length > 1
                      ? `${current ? 'Actualizar' : 'Instalar'} en ${targets.length}`
                      : current
                        ? 'Actualizar'
                        : 'Instalar',
                }),
              ),
              result.projectUrl
                ? el('button', {
                    className: 'btn ghost',
                    text: 'Web',
                    on: { click: () => void window.dotforge.app.openExternal(result.projectUrl!) },
                  })
                : null,
            ),
          ),
        ),
      );
    }

    return container;
  }

  /** Avatar generado a partir de la inicial: evita descargar iconos remotos. */
  private avatar(packageId: string): HTMLElement {
    const initial = packageId.replace(/^[^A-Za-z]*/, '').charAt(0).toUpperCase() || '#';
    return el('div', { className: 'package-avatar', text: initial });
  }

  // -------------------------------------------------------------------------------------------
  // Instalación en varios proyectos
  // -------------------------------------------------------------------------------------------

  /**
   * Arranca la instalación del paquete en todos los proyectos marcados.
   *
   * En serie, no en paralelo: `dotnet add package` restaura, y varias restauraciones a la vez se
   * pelean por la caché de NuGet. El encadenado lo hace `noteTaskExit`, que es quien se entera de
   * que una tarea ha terminado.
   */
  private startInstall(packageId: string, version: string): void {
    if (this.plan !== null) {
      this.host.notify('Ya hay una instalación de paquetes en marcha.', 'warn');
      return;
    }

    const projects = this.selectedProjects();
    if (projects.length === 0) {
      this.host.notify('Marca al menos un proyecto antes de instalar.', 'warn');
      return;
    }

    this.plan = createPlan(
      packageId,
      version,
      projects.map((project) => ({ path: project.path, name: project.name })),
    );

    this.host.notify(describeProgress(this.plan).text, 'info');
    void this.advanceInstall();
  }

  /** Lanza el siguiente proyecto pendiente, o cierra el plan si ya no queda ninguno. */
  private async advanceInstall(): Promise<void> {
    const plan = this.plan;
    if (plan === null) return;

    const step = nextPending(plan);
    if (step === null) {
      this.finishInstall(plan);
      return;
    }

    try {
      const started = await window.dotforge.nuget.install(step.project.path, plan.packageId, plan.version);
      // Puede haber terminado la instalación entera mientras se esperaba (un "cerrar solución").
      if (this.plan === null) return;
      this.plan = markRunning(this.plan, step.project.path, started.taskId);
      this.render();
    } catch (error) {
      // La tarea ni siquiera se ha podido lanzar: se marca el paso y se sigue con el siguiente. Un
      // proyecto que no admite el paquete no dice nada de los demás.
      this.host.notify(
        `No se ha podido lanzar la instalación en ${step.project.name}: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      if (this.plan === null) return;
      this.plan = markFailed(this.plan, step.project.path);
      void this.advanceInstall();
    }
  }

  /**
   * Una tarea de `dotnet` ha terminado.
   *
   * Lo llama el reparto de eventos del renderer con **todas** las tareas del IDE; el plan se queda
   * sólo con la suya, emparejando por `taskId`.
   */
  noteTaskExit(taskId: string, code: number | null): void {
    const plan = this.plan;
    if (plan === null) return;

    const updated = noteExit(plan, taskId, code);
    if (updated === plan) return;

    this.plan = updated;

    if (isComplete(updated)) this.finishInstall(updated);
    else {
      this.host.notify(describeProgress(updated).text, 'info');
      this.render();
      void this.advanceInstall();
    }
  }

  private finishInstall(plan: PackageInstallPlan): void {
    const summary = summarizeInstall(plan);
    this.plan = null;
    this.host.notify(summary.message, summary.level);
    this.host.reloadSolution();
    this.render();
  }

  private async uninstall(project: ProjectInfo, packageId: string): Promise<void> {
    this.host.notify(`Desinstalando ${packageId} de ${project.name}…`, 'info');
    try {
      await window.dotforge.nuget.uninstall(project.path, packageId);
    } catch (error) {
      this.host.notify(`No se ha podido desinstalar ${packageId}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}
