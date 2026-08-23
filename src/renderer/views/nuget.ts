/**
 * Panel visual de paquetes NuGet.
 *
 * Buscar, ver lo instalado, instalar una versión concreta y desinstalar, sin salir del IDE.
 * Los iconos de los paquetes se dibujan localmente (inicial sobre un cuadro) en lugar de
 * descargarse: así el panel no revela a terceros qué está buscando el usuario.
 */
import type { NuGetSearchResult, ProjectInfo, SolutionInfo } from '../../shared/contracts.js';
import { byId, clear, compactNumber, debounce, el } from '../dom.js';

export interface NuGetHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  reloadSolution(): void;
}

export class NuGetView {
  private solution: SolutionInfo | null = null;
  private selectedProjectPath: string | null = null;
  private results: NuGetSearchResult[] = [];
  private query = '';
  private includePrerelease = false;
  private loading = false;
  /** Sólo la vista activa escribe en la barra lateral. Ver la nota en ExplorerView. */
  private visible = false;
  private error: string | null = null;
  private readonly versionChoice = new Map<string, string>();

  private readonly runSearch = debounce(() => void this.performSearch(), 320);

  constructor(private readonly host: NuGetHost) {}

  setSolution(solution: SolutionInfo | null): void {
    this.solution = solution;
    this.selectedProjectPath = solution?.projects[0]?.path ?? null;
    this.render();
  }

  focusProject(project: ProjectInfo): void {
    this.selectedProjectPath = project.path;
    this.render();
  }

  private selectedProject(): ProjectInfo | null {
    if (!this.solution) return null;
    return this.solution.projects.find((project) => project.path === this.selectedProjectPath) ?? null;
  }

  private async performSearch(): Promise<void> {
    if (this.query.trim() === '') {
      this.results = [];
      this.render();
      return;
    }

    this.loading = true;
    this.error = null;
    this.render();

    try {
      this.results = await window.dotforge.nuget.search(this.query, this.includePrerelease);
    } catch (error) {
      this.results = [];
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.render();
  }

  render(): void {
    if (!this.visible) return;

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

    if (this.error) {
      container.appendChild(el('div', { className: 'notice error', text: this.error }));
    }

    if (this.loading) {
      container.appendChild(
        el('div', { className: 'empty-state' }, el('span', { className: 'spinner' }), ' Buscando en nuget.org…'),
      );
      return;
    }

    container.appendChild(this.query.trim() === '' ? this.renderInstalled() : this.renderResults());
  }

  private renderProjectPicker(): HTMLElement {
    const select = el('select', {
      className: 'input',
      on: {
        change: (event) => {
          this.selectedProjectPath = (event.target as HTMLSelectElement).value;
          this.render();
        },
      },
    }) as HTMLSelectElement;

    for (const project of this.solution!.projects) {
      const option = el('option', { value: project.path, text: project.name }) as HTMLOptionElement;
      if (project.path === this.selectedProjectPath) option.selected = true;
      select.appendChild(option);
    }

    return el('div', { className: 'nuget-search' }, select);
  }

  private renderSearchBar(): HTMLElement {
    const input = el('input', {
      className: 'input',
      placeholder: 'Buscar paquetes en nuget.org…',
      value: this.query,
      on: {
        input: (event) => {
          this.query = (event.target as HTMLInputElement).value;
          this.runSearch();
        },
      },
    });

    const prerelease = el(
      'label',
      { className: 'checkbox', title: 'Incluir versiones preliminares' },
      el('input', {
        type: 'checkbox',
        on: {
          change: (event) => {
            this.includePrerelease = (event.target as HTMLInputElement).checked;
            void this.performSearch();
          },
        },
      }),
      'pre',
    );

    return el('div', { className: 'nuget-search' }, input, prerelease);
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

  private renderResults(): HTMLElement {
    const project = this.selectedProject();
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
              el('button', {
                className: 'btn primary',
                text: current ? 'Actualizar' : 'Instalar',
                disabled: !project,
                on: {
                  click: () => {
                    if (!project) return;
                    void this.install(project, result.id, versionSelect.value);
                  },
                },
              }),
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

  private async install(project: ProjectInfo, packageId: string, version: string): Promise<void> {
    this.host.notify(`Instalando ${packageId} ${version} en ${project.name}…`, 'info');
    try {
      await window.dotforge.nuget.install(project.path, packageId, version);
    } catch (error) {
      this.host.notify(`No se ha podido instalar ${packageId}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
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
