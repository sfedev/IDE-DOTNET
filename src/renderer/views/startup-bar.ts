/**
 * Selector de inicio de la barra superior.
 *
 * Es el control que un desarrollador de Visual Studio o Rider busca sin pensar: qué se arranca,
 * cómo se arranca y el botón de Play. Tres piezas:
 *
 *   [ ▷ Adapters.Web ▾ ]  [ 🐞 Depurar | ⚡ Sin depurar ]  [ ▶ ]  [ ■ ]
 *
 * El desplegable lista los proyectos ejecutables de la solución y los perfiles multiproyecto
 * guardados, y ofrece abrir el modal de configuración. El conmutador elige entre enganchar el
 * depurador o arrancar con Hot Reload. El botón de Play ejecuta el perfil activo entero.
 *
 * Esta vista no lanza nada: traduce clics a llamadas al host (`src/renderer/index.ts`), que es
 * quien orquesta. Así la lógica de arranque se prueba y se lee en un solo sitio.
 */
import type { ProjectInfo, SolutionInfo } from '../../shared/contracts.js';
import type { RunMode, StartupConfig, StartupProfile } from '../../shared/startup.js';
import {
  availableProfiles,
  nextProfileId,
  resolveActiveProfile,
  runnableProjects,
  shortProjectName,
  suggestProfileName,
} from '../../shared/startup.js';
import { clear, el } from '../dom.js';
import { presentProject } from '../file-icons.js';
import { icon } from '../icons.js';

export interface StartupBarHost {
  /** Arranca el perfil activo con el modo activo. */
  start(): void;
  /** Detiene todo lo que esté corriendo. */
  stop(): void;
  /** Persiste la configuración (perfiles, perfil activo, modo). */
  save(config: StartupConfig): void;
  /** Hay algo ejecutándose ahora mismo. */
  isRunning(): boolean;
  notify(message: string, level: 'info' | 'warn' | 'error'): void;
}

const MODE_LABEL: Record<RunMode, string> = {
  debug: 'Depurar',
  run: 'Sin depurar',
};

const MODE_HINT: Record<RunMode, string> = {
  debug: 'Engancha NetCoreDbg, aplica launchSettings.json y respeta los breakpoints (F5)',
  run: 'Arranca con Hot Reload (dotnet watch) e ignora los breakpoints (Ctrl+F5)',
};

export class StartupBar {
  private solution: SolutionInfo | null = null;
  private config: StartupConfig = { profiles: [], activeProfileId: null, mode: 'debug' };
  private container: HTMLElement | null = null;
  private menuOpen = false;

  constructor(private readonly host: StartupBarHost) {}

  // --- Estado ---------------------------------------------------------------------------------

  setSolution(solution: SolutionInfo | null): void {
    this.solution = solution;
    this.render();
  }

  setConfig(config: StartupConfig): void {
    this.config = config;
    this.render();
  }

  getConfig(): StartupConfig {
    return this.config;
  }

  mode(): RunMode {
    return this.config.mode;
  }

  activeProfile(): StartupProfile | null {
    return resolveActiveProfile(this.config, this.solution);
  }

  /** Proyectos del perfil activo, resueltos contra la solución y en orden de arranque. */
  activeProjects(): ProjectInfo[] {
    const profile = this.activeProfile();
    if (!profile || !this.solution) return [];

    const byPath = new Map(this.solution.projects.map((project) => [project.path, project]));
    return profile.projects
      .map((path) => byPath.get(path))
      .filter((project): project is ProjectInfo => project !== undefined);
  }

  setMode(mode: RunMode): void {
    if (this.config.mode === mode) return;
    this.config = { ...this.config, mode };
    this.host.save(this.config);
    this.render();
  }

  // --- Render ---------------------------------------------------------------------------------

  mount(container: HTMLElement): void {
    this.container = container;
    this.render();
  }

  render(): void {
    const container = this.container;
    if (!container) return;

    clear(container);

    const runnable = runnableProjects(this.solution);
    if (runnable.length === 0) {
      container.appendChild(
        el('span', {
          className: 'startup-empty',
          text: this.solution ? 'Sin proyectos ejecutables' : '',
        }),
      );
      return;
    }

    container.append(this.renderProfilePicker(), this.renderModeToggle(), this.renderActions());
  }

  private renderProfilePicker(): HTMLElement {
    const profile = this.activeProfile();
    const projects = this.activeProjects();
    const label = profile
      ? projects.length > 1
        ? profile.name
        : shortProjectName(profile.name, this.solution?.name ?? null)
      : 'Elegir proyecto';

    const iconName = projects.length > 1 ? 'puzzle' : presentProject(projects[0]?.kind ?? 'console').icon;

    const button = el(
      'button',
      {
        className: `startup-picker${this.menuOpen ? ' open' : ''}`,
        title: profile ? this.describeProfile(profile) : 'Elegir qué se arranca',
        attrs: { 'aria-haspopup': 'listbox', 'aria-expanded': String(this.menuOpen) },
        on: {
          click: (event) => {
            event.stopPropagation();
            this.toggleMenu();
          },
        },
      },
      icon(iconName, { size: 14, className: 'startup-picker-icon' }),
      el('span', { className: 'startup-picker-label', text: label }),
      projects.length > 1 ? el('span', { className: 'startup-count', text: String(projects.length) }) : null,
      icon('chevron-down', { size: 13, className: 'startup-picker-caret' }),
    );

    const wrapper = el('div', { className: 'startup-picker-wrap' }, button);
    if (this.menuOpen) wrapper.appendChild(this.renderMenu());

    return wrapper;
  }

  private describeProfile(profile: StartupProfile): string {
    const projects = this.activeProjects();
    if (projects.length <= 1) return projects[0]?.path ?? profile.name;
    return `${projects.length} proyectos en este orden:\n${projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}`;
  }

  private toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
    this.render();

    if (this.menuOpen) {
      // Un clic en cualquier otro sitio cierra el menú. `once` evita acumular listeners.
      setTimeout(() => {
        document.addEventListener(
          'click',
          () => {
            this.menuOpen = false;
            this.render();
          },
          { once: true },
        );
      }, 0);
    }
  }

  private renderMenu(): HTMLElement {
    const menu = el('div', { className: 'startup-menu', role: 'listbox' });
    const profiles = availableProfiles(this.config, this.solution);
    const active = this.activeProfile();

    const custom = profiles.filter((profile) => !profile.implicit);
    const single = profiles.filter((profile) => profile.implicit);

    if (custom.length > 0) {
      menu.appendChild(el('div', { className: 'startup-menu-title', text: 'Perfiles' }));
      for (const profile of custom) menu.appendChild(this.renderMenuItem(profile, active));
    }

    menu.appendChild(el('div', { className: 'startup-menu-title', text: 'Proyectos' }));
    for (const profile of single) menu.appendChild(this.renderMenuItem(profile, active));

    menu.append(
      el('div', { className: 'startup-menu-sep' }),
      el(
        'button',
        {
          className: 'startup-menu-item action',
          on: {
            click: (event) => {
              event.stopPropagation();
              this.menuOpen = false;
              this.openProfileDialog();
            },
          },
        },
        icon('sliders', { size: 14 }),
        el('span', { text: 'Configurar varios proyectos…' }),
      ),
    );

    return menu;
  }

  private renderMenuItem(profile: StartupProfile, active: StartupProfile | null): HTMLElement {
    const isActive = active?.id === profile.id;
    const byPath = new Map((this.solution?.projects ?? []).map((project) => [project.path, project]));
    const projects = profile.projects.map((path) => byPath.get(path)).filter(Boolean) as ProjectInfo[];

    const detail =
      projects.length > 1
        ? projects.map((project) => shortProjectName(project.name, this.solution?.name ?? null)).join(' → ')
        : (projects[0]?.targetFrameworks[0] ?? '');

    return el(
      'button',
      {
        className: `startup-menu-item${isActive ? ' active' : ''}`,
        role: 'option',
        on: {
          click: (event) => {
            event.stopPropagation();
            this.selectProfile(profile);
          },
        },
      },
      icon(
        profile.implicit ? presentProject(projects[0]?.kind ?? 'console').icon : 'puzzle',
        { size: 14, className: 'startup-menu-icon' },
      ),
      el(
        'span',
        { className: 'startup-menu-text' },
        el('span', { className: 'startup-menu-name', text: profile.name }),
        detail ? el('span', { className: 'startup-menu-detail', text: detail }) : null,
      ),
      isActive ? icon('check', { size: 13, className: 'startup-menu-check' }) : null,
    );
  }

  private selectProfile(profile: StartupProfile): void {
    this.config = { ...this.config, activeProfileId: profile.id };
    this.menuOpen = false;
    this.host.save(this.config);
    this.render();
  }

  private renderModeToggle(): HTMLElement {
    const toggle = el('div', { className: 'startup-mode', role: 'group', attrs: { 'aria-label': 'Modo de ejecución' } });

    const option = (mode: RunMode, iconName: 'bug' | 'zap'): HTMLElement =>
      el(
        'button',
        {
          className: `startup-mode-btn${this.config.mode === mode ? ' active' : ''}`,
          title: MODE_HINT[mode],
          attrs: { 'aria-pressed': String(this.config.mode === mode) },
          on: { click: () => this.setMode(mode) },
        },
        icon(iconName, { size: 13 }),
        el('span', { text: MODE_LABEL[mode] }),
      );

    toggle.append(option('debug', 'bug'), option('run', 'zap'));
    return toggle;
  }

  private renderActions(): HTMLElement {
    const running = this.host.isRunning();
    const projects = this.activeProjects();

    const play = el(
      'button',
      {
        className: 'startup-play',
        disabled: projects.length === 0,
        title:
          projects.length === 0
            ? 'No hay ningún proyecto que arrancar'
            : `${this.config.mode === 'debug' ? 'Iniciar depuración (F5)' : 'Iniciar sin depurar (Ctrl+F5)'}: ${projects
                .map((project) => project.name)
                .join(', ')}`,
        on: { click: () => this.host.start() },
      },
      icon('play', { size: 14 }),
    );

    const stop = el(
      'button',
      {
        className: 'startup-stop',
        disabled: !running,
        title: 'Detener todo (Shift+F5)',
        on: { click: () => this.host.stop() },
      },
      icon('stop', { size: 14 }),
    );

    return el('div', { className: 'startup-actions' }, play, stop);
  }

  // --- Modal de configuración multiproyecto ------------------------------------------------------

  openProfileDialog(): void {
    const runnable = runnableProjects(this.solution);
    if (runnable.length === 0) {
      this.host.notify('La solución no tiene proyectos ejecutables.', 'warn');
      return;
    }

    const active = this.activeProfile();
    // Estado de trabajo del modal: selección en orden, y nombre editable.
    const selection: string[] = active ? [...active.projects] : [];
    let name = active && !active.implicit ? active.name : '';
    let editingId: string | null = active && !active.implicit ? active.id : null;

    const overlay = document.getElementById('overlay');
    if (!overlay) return;

    const close = (): void => {
      overlay.hidden = true;
      clear(overlay);
      overlay.onkeydown = null;
    };

    const selectedProjects = (): ProjectInfo[] =>
      selection
        .map((path) => runnable.find((project) => project.path === path))
        .filter((project): project is ProjectInfo => project !== undefined);

    const render = (): void => {
      clear(overlay);
      overlay.hidden = false;
      overlay.className = 'overlay center';

      const dialog = el('div', { className: 'dialog startup-dialog', role: 'dialog' });

      dialog.appendChild(
        el(
          'div',
          { className: 'dialog-header' },
          el('span', { className: 'dialog-mark' }, icon('sliders', { size: 20 })),
          el(
            'div',
            {},
            el('h2', { text: 'Configuración de inicio' }),
            el('p', { text: 'Marca qué proyectos arrancan y en qué orden' }),
          ),
          el(
            'button',
            { className: 'icon-btn', title: 'Cerrar', on: { click: close } },
            icon('x', { size: 16 }),
          ),
        ),
      );

      const body = el('div', { className: 'dialog-body' });

      body.appendChild(el('h4', { className: 'section-title', text: 'Proyectos ejecutables' }));

      const list = el('div', { className: 'startup-project-list' });
      for (const project of runnable) {
        const index = selection.indexOf(project.path);
        const checked = index >= 0;
        const presentation = presentProject(project.kind);

        list.appendChild(
          el(
            'label',
            { className: `startup-project${checked ? ' checked' : ''}` },
            el('input', {
              type: 'checkbox',
              attrs: checked ? { checked: 'checked' } : {},
              on: {
                change: () => {
                  const at = selection.indexOf(project.path);
                  if (at >= 0) selection.splice(at, 1);
                  else selection.push(project.path);
                  render();
                },
              },
            }),
            el('span', { className: `startup-order${checked ? '' : ' empty'}`, text: checked ? String(index + 1) : '·' }),
            icon(presentation.icon, { size: 15, className: `tone-${presentation.tone}` }),
            el(
              'span',
              { className: 'startup-project-text' },
              el('span', { className: 'startup-project-name', text: project.name }),
              el('span', {
                className: 'startup-project-detail',
                text: `${presentation.badge} · ${project.targetFrameworks.join(', ')}`,
              }),
            ),
            checked
              ? el(
                  'span',
                  { className: 'startup-project-move' },
                  el(
                    'button',
                    {
                      className: 'icon-btn',
                      title: 'Arrancar antes',
                      disabled: index === 0,
                      on: {
                        click: (event) => {
                          event.preventDefault();
                          const at = selection.indexOf(project.path);
                          if (at > 0) {
                            selection.splice(at - 1, 0, ...selection.splice(at, 1));
                            render();
                          }
                        },
                      },
                    },
                    icon('chevron-up', { size: 13 }),
                  ),
                  el(
                    'button',
                    {
                      className: 'icon-btn',
                      title: 'Arrancar después',
                      disabled: index === selection.length - 1,
                      on: {
                        click: (event) => {
                          event.preventDefault();
                          const at = selection.indexOf(project.path);
                          if (at >= 0 && at < selection.length - 1) {
                            selection.splice(at + 1, 0, ...selection.splice(at, 1));
                            render();
                          }
                        },
                      },
                    },
                    icon('chevron-down', { size: 13 }),
                  ),
                )
              : null,
          ),
        );
      }
      body.appendChild(list);

      // Aviso honesto: una sola sesión de depuración (ADR-012).
      if (selection.length > 1 && this.config.mode === 'debug') {
        body.appendChild(
          el(
            'div',
            { className: 'notice info', style: { marginTop: '12px' } },
            icon('info', { size: 15 }),
            el('div', {
              text:
                `En modo depuración sólo se engancha el depurador al primero (${
                  selectedProjects()[0]?.name ?? ''
                }); el resto arranca sin depurar.`,
            }),
          ),
        );
      }

      body.append(
        el('h4', { className: 'section-title', style: { marginTop: '18px' }, text: 'Guardar como perfil' }),
        el('p', {
          className: 'field-hint',
          text: 'Un perfil recuerda la selección y el orden. Se guarda para esta solución.',
        }),
      );

      const nameInput = el('input', {
        className: 'input',
        value: name,
        placeholder: suggestProfileName(selectedProjects(), this.solution?.name ?? null),
        attrs: { 'aria-label': 'Nombre del perfil' },
        on: {
          input: (event) => {
            name = (event.target as HTMLInputElement).value;
          },
        },
      });
      body.appendChild(nameInput);

      const existing = this.config.profiles;
      if (existing.length > 0) {
        body.appendChild(el('h4', { className: 'section-title', style: { marginTop: '18px' }, text: 'Perfiles guardados' }));
        for (const profile of existing) {
          body.appendChild(
            el(
              'div',
              { className: `startup-saved${editingId === profile.id ? ' active' : ''}` },
              icon('puzzle', { size: 14 }),
              el(
                'button',
                {
                  className: 'startup-saved-name',
                  title: 'Editar este perfil',
                  on: {
                    click: () => {
                      selection.splice(0, selection.length, ...profile.projects);
                      name = profile.name;
                      editingId = profile.id;
                      render();
                    },
                  },
                },
                profile.name,
              ),
              el('span', { className: 'startup-saved-count', text: `${profile.projects.length} proyectos` }),
              el(
                'button',
                {
                  className: 'icon-btn',
                  title: 'Eliminar el perfil',
                  on: {
                    click: () => {
                      this.config = {
                        ...this.config,
                        profiles: this.config.profiles.filter((entry) => entry.id !== profile.id),
                        activeProfileId:
                          this.config.activeProfileId === profile.id ? null : this.config.activeProfileId,
                      };
                      if (editingId === profile.id) {
                        editingId = null;
                        name = '';
                      }
                      this.host.save(this.config);
                      this.render();
                      render();
                    },
                  },
                },
                icon('trash', { size: 13 }),
              ),
            ),
          );
        }
      }

      dialog.appendChild(body);

      const footer = el('div', { className: 'dialog-footer' });
      footer.append(
        el('span', {
          className: 'startup-summary',
          text:
            selection.length === 0
              ? 'Ningún proyecto seleccionado'
              : `${selection.length} proyecto(s) · orden: ${selectedProjects()
                  .map((project) => shortProjectName(project.name, this.solution?.name ?? null))
                  .join(' → ')}`,
        }),
        el('span', { className: 'spacer', style: { flex: '1' } }),
        el('button', { className: 'btn ghost', text: 'Cancelar', on: { click: close } }),
        el('button', {
          className: 'btn primary',
          text: selection.length > 1 ? 'Guardar perfil y usarlo' : 'Usar esta selección',
          disabled: selection.length === 0,
          on: {
            click: () => {
              this.commitSelection(selection, name, editingId);
              close();
            },
          },
        }),
      );
      dialog.appendChild(footer);

      overlay.appendChild(dialog);
      overlay.onkeydown = (event) => {
        if (event.key === 'Escape') close();
      };
    };

    render();
  }

  /**
   * Convierte la selección del modal en configuración.
   *
   * Un solo proyecto no crea perfil: se activa su perfil implícito. Crear "Perfil de WebApi" con
   * un único proyecto sería ruido en el desplegable.
   */
  private commitSelection(selection: string[], name: string, editingId: string | null): void {
    if (selection.length === 0) return;

    if (selection.length === 1) {
      this.config = { ...this.config, activeProfileId: `project:${selection[0]}` };
      this.host.save(this.config);
      this.render();
      return;
    }

    const runnable = runnableProjects(this.solution);
    const projects = selection
      .map((path) => runnable.find((project) => project.path === path))
      .filter((project): project is ProjectInfo => project !== undefined);

    const finalName = name.trim() !== '' ? name.trim() : suggestProfileName(projects, this.solution?.name ?? null);
    const id = editingId ?? nextProfileId(this.config.profiles);

    const profiles = this.config.profiles.some((profile) => profile.id === id)
      ? this.config.profiles.map((profile) =>
          profile.id === id ? { ...profile, name: finalName, projects: [...selection] } : profile,
        )
      : [...this.config.profiles, { id, name: finalName, projects: [...selection], implicit: false }];

    this.config = { ...this.config, profiles, activeProfileId: id };
    this.host.save(this.config);
    this.render();
  }
}
