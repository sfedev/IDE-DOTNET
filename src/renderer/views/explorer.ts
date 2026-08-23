/**
 * Explorador: vista de solución (proyectos agrupados por carpeta de solución) y vista de archivos.
 *
 * La vista de solución es la que un desarrollador .NET espera encontrar: proyectos, sus
 * referencias y sus paquetes. La de archivos existe porque a veces hay que tocar un `.yml` de CI
 * que no pertenece a ningún proyecto.
 */
import type { FileNode, ProjectInfo, SolutionInfo } from '../../shared/contracts.js';
import { byId, clear, el, extensionOf } from '../dom.js';

export type ExplorerMode = 'solution' | 'files';

export interface ExplorerHost {
  openFile(path: string): void;
  revealInFolder(path: string): void;
  runProjectTask(kind: 'build' | 'run' | 'watch' | 'test', projectPath: string): void;
  showPackagesFor(project: ProjectInfo): void;
  refresh(): void;
}

/** Glifo y clase de color por extensión. */
function glyphFor(name: string, isDirectory: boolean): { glyph: string; className: string } {
  if (isDirectory) return { glyph: '▸', className: 'dir' };

  switch (extensionOf(name)) {
    case '.cs':
      return { glyph: 'C#', className: 'cs' };
    case '.razor':
    case '.cshtml':
      return { glyph: '@', className: 'razor' };
    case '.csproj':
    case '.sln':
    case '.slnx':
      return { glyph: '⬡', className: 'csproj' };
    case '.json':
      return { glyph: '{}', className: 'json' };
    case '.md':
      return { glyph: 'M↓', className: 'md' };
    case '.css':
      return { glyph: '#', className: 'md' };
    case '.props':
    case '.targets':
    case '.xml':
      return { glyph: '</>', className: 'json' };
    default:
      return { glyph: '·', className: '' };
  }
}

export class ExplorerView {
  private mode: ExplorerMode = 'solution';
  private solution: SolutionInfo | null = null;
  private selectedPath: string | null = null;

  /**
   * Sólo la vista activa escribe en la barra lateral.
   *
   * Sin esto, cargar una solución hacía que el explorador y el panel NuGet se pintaran los dos
   * sobre el mismo contenedor y ganara el último: la barra mostraba NuGet mientras el icono
   * activo seguía siendo el del explorador.
   */
  private visible = true;

  /** Directorios desplegados en la vista de archivos, con sus hijos ya cargados. */
  private readonly expanded = new Set<string>();
  private readonly childrenCache = new Map<string, FileNode[]>();

  /** Proyectos desplegados en la vista de solución. */
  private readonly expandedProjects = new Set<string>();

  constructor(private readonly host: ExplorerHost) {}

  setSolution(solution: SolutionInfo | null): void {
    this.solution = solution;
    this.expanded.clear();
    this.childrenCache.clear();
    this.expandedProjects.clear();

    if (solution) this.expanded.add(solution.directory);
    this.render();
  }

  setMode(mode: ExplorerMode): void {
    this.mode = mode;
    this.render();
  }

  getMode(): ExplorerMode {
    return this.mode;
  }

  select(path: string): void {
    this.selectedPath = path;
    this.render();
  }

  async refresh(): Promise<void> {
    this.childrenCache.clear();
    await this.preloadExpanded();
    this.render();
  }

  private async preloadExpanded(): Promise<void> {
    for (const directory of this.expanded) {
      try {
        this.childrenCache.set(directory, await window.dotforge.fs.listDirectory(directory));
      } catch {
        this.childrenCache.set(directory, []);
      }
    }
  }

  async toggleDirectory(path: string): Promise<void> {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
    } else {
      this.expanded.add(path);
      if (!this.childrenCache.has(path)) {
        try {
          this.childrenCache.set(path, await window.dotforge.fs.listDirectory(path));
        } catch (error) {
          this.childrenCache.set(path, []);
          console.error('no se ha podido leer el directorio', path, error);
        }
      }
    }
    this.render();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.render();
  }

  render(): void {
    if (!this.visible) return;

    const container = byId('sidebar-content');
    clear(container);

    byId('sidebar-title').textContent = this.mode === 'solution' ? 'Explorador de soluciones' : 'Archivos';

    this.renderSidebarActions();

    if (!this.solution) {
      container.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          el('p', { text: 'No hay ningún workspace abierto.' }),
          el('button', {
            className: 'btn primary',
            text: 'Abrir carpeta…',
            on: { click: () => this.host.refresh() },
          }),
        ),
      );
      return;
    }

    container.appendChild(this.mode === 'solution' ? this.renderSolutionTree() : this.renderFileTree());
  }

  private renderSidebarActions(): void {
    const actions = byId('sidebar-actions');
    clear(actions);

    const modeButton = el('button', {
      className: 'icon-btn',
      text: this.mode === 'solution' ? '⬡' : '🗀',
      title: this.mode === 'solution' ? 'Cambiar a vista de archivos' : 'Cambiar a vista de solución',
      on: { click: () => this.setMode(this.mode === 'solution' ? 'files' : 'solution') },
    });

    const refreshButton = el('button', {
      className: 'icon-btn',
      text: '⟳',
      title: 'Actualizar',
      on: { click: () => void this.refresh() },
    });

    actions.append(modeButton, refreshButton);
  }

  // --- Vista de solución -----------------------------------------------------------------------

  private renderSolutionTree(): HTMLElement {
    const solution = this.solution!;
    const tree = el('div', { className: 'tree' });

    tree.appendChild(
      this.row({
        depth: 0,
        glyph: '⬡',
        glyphClass: 'csproj',
        label: solution.name,
        hint: solution.format === 'none' ? 'sin .sln' : solution.format,
        selected: false,
        onClick: () => {
          if (solution.path) this.host.openFile(solution.path);
        },
      }),
    );

    if (solution.warnings.length > 0) {
      for (const warning of solution.warnings) {
        tree.appendChild(el('div', { className: 'notice warn', text: warning }));
      }
    }

    if (solution.projects.length === 0) {
      tree.appendChild(el('div', { className: 'empty-state', text: 'La carpeta no contiene proyectos .NET.' }));
      return tree;
    }

    // Agrupación por carpeta de solución, respetando el orden declarado en el .sln.
    const groups = new Map<string, ProjectInfo[]>();
    for (const project of solution.projects) {
      const key = project.solutionFolder ?? '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(project);
      else groups.set(key, [project]);
    }

    for (const [folder, projects] of groups) {
      if (folder !== '') tree.appendChild(el('div', { className: 'tree-group', text: folder }));

      for (const project of projects) {
        tree.appendChild(this.renderProjectNode(project, folder === '' ? 1 : 1));
      }
    }

    return tree;
  }

  private renderProjectNode(project: ProjectInfo, depth: number): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const expanded = this.expandedProjects.has(project.path);

    fragment.appendChild(
      this.row({
        depth,
        twisty: expanded ? '▾' : '▸',
        glyph: '⬡',
        glyphClass: 'csproj',
        label: project.name,
        hint: project.targetFrameworks.join(', '),
        selected: this.selectedPath === project.path,
        onClick: () => {
          if (expanded) this.expandedProjects.delete(project.path);
          else this.expandedProjects.add(project.path);
          this.render();
        },
        onDoubleClick: () => this.host.openFile(project.path),
        onContextMenu: (event) => this.showProjectMenu(event, project),
      }),
    );

    if (!expanded) return fragment;

    if (project.projectReferences.length > 0) {
      fragment.appendChild(el('div', { className: 'tree-group', text: 'Referencias de proyecto' }));
      for (const reference of project.projectReferences) {
        fragment.appendChild(
          this.row({
            depth: depth + 1,
            glyph: '↗',
            glyphClass: 'dir',
            label: reference.name,
            selected: false,
            onClick: () => this.host.openFile(reference.path),
          }),
        );
      }
    }

    if (project.packageReferences.length > 0) {
      fragment.appendChild(
        el(
          'div',
          { className: 'tree-group' },
          `Paquetes (${project.packageReferences.length})`,
        ),
      );
      for (const reference of project.packageReferences) {
        fragment.appendChild(
          this.row({
            depth: depth + 1,
            glyph: '◆',
            glyphClass: 'json',
            label: reference.id,
            hint: reference.version ?? 'central',
            selected: false,
            onClick: () => this.host.showPackagesFor(project),
          }),
        );
      }
    }

    fragment.appendChild(
      this.row({
        depth: depth + 1,
        glyph: '🗀',
        glyphClass: 'dir',
        label: 'Archivos del proyecto',
        selected: false,
        onClick: () => {
          this.mode = 'files';
          this.expanded.add(project.directory);
          void this.toggleDirectory(project.directory).then(() => {
            this.expanded.add(project.directory);
            this.render();
          });
        },
      }),
    );

    return fragment;
  }

  private showProjectMenu(event: MouseEvent, project: ProjectInfo): void {
    event.preventDefault();

    const menu = el('div', {
      className: 'palette',
      style: {
        position: 'fixed',
        left: `${event.clientX}px`,
        top: `${event.clientY}px`,
        width: '240px',
        maxHeight: 'none',
        zIndex: '80',
      },
    });

    const close = (): void => menu.remove();

    const entries: Array<[string, () => void]> = [
      ['Compilar proyecto', () => this.host.runProjectTask('build', project.path)],
      ...(project.isWebProject || project.outputType === 'Exe'
        ? ([
            ['Ejecutar', () => this.host.runProjectTask('run', project.path)],
            ['Ejecutar con Hot Reload', () => this.host.runProjectTask('watch', project.path)],
          ] as Array<[string, () => void]>)
        : []),
      ...(project.isTestProject
        ? ([['Ejecutar pruebas', () => this.host.runProjectTask('test', project.path)]] as Array<[string, () => void]>)
        : []),
      ['Gestionar paquetes NuGet', () => this.host.showPackagesFor(project)],
      ['Abrir .csproj', () => this.host.openFile(project.path)],
      ['Mostrar en el explorador', () => this.host.revealInFolder(project.path)],
    ];

    const list = el('div', { className: 'palette-list' });
    for (const [label, action] of entries) {
      list.appendChild(
        el('button', {
          className: 'palette-item',
          text: label,
          on: {
            click: () => {
              close();
              action();
            },
          },
        }),
      );
    }

    menu.appendChild(list);
    document.body.appendChild(menu);

    // Se cierra al primer clic fuera. `capture` evita que el propio clic del menú lo cierre.
    const onDocumentClick = (documentEvent: MouseEvent): void => {
      if (!menu.contains(documentEvent.target as Node)) {
        close();
        document.removeEventListener('mousedown', onDocumentClick, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onDocumentClick, true), 0);
  }

  // --- Vista de archivos ------------------------------------------------------------------------

  private renderFileTree(): HTMLElement {
    const tree = el('div', { className: 'tree' });
    const root = this.solution!.directory;

    tree.appendChild(
      this.row({
        depth: 0,
        twisty: this.expanded.has(root) ? '▾' : '▸',
        glyph: '🗀',
        glyphClass: 'dir',
        label: this.solution!.name,
        selected: false,
        onClick: () => void this.toggleDirectory(root),
      }),
    );

    if (this.expanded.has(root)) {
      this.appendChildren(tree, root, 1);
    }

    return tree;
  }

  private appendChildren(parent: HTMLElement, directory: string, depth: number): void {
    const children = this.childrenCache.get(directory);

    if (!children) {
      parent.appendChild(el('div', { className: 'empty-state', text: 'Cargando…' }));
      void window.dotforge.fs
        .listDirectory(directory)
        .then((nodes) => {
          this.childrenCache.set(directory, nodes);
          this.render();
        })
        .catch(() => {
          this.childrenCache.set(directory, []);
          this.render();
        });
      return;
    }

    for (const node of children) {
      const isDirectory = node.kind === 'directory';
      const expanded = this.expanded.has(node.path);
      const { glyph, className } = glyphFor(node.name, isDirectory);

      parent.appendChild(
        this.row({
          depth,
          twisty: isDirectory ? (expanded ? '▾' : '▸') : '',
          glyph: isDirectory ? '🗀' : glyph,
          glyphClass: className,
          label: node.name,
          selected: this.selectedPath === node.path,
          onClick: () => {
            if (isDirectory) void this.toggleDirectory(node.path);
            else {
              this.selectedPath = node.path;
              this.host.openFile(node.path);
            }
          },
          onContextMenu: (event) => {
            event.preventDefault();
            this.host.revealInFolder(node.path);
          },
        }),
      );

      if (isDirectory && expanded) {
        this.appendChildren(parent, node.path, depth + 1);
      }
    }
  }

  // --- Fila genérica --------------------------------------------------------------------------------

  private row(options: {
    depth: number;
    twisty?: string;
    glyph: string;
    glyphClass: string;
    label: string;
    hint?: string;
    selected: boolean;
    onClick?: () => void;
    onDoubleClick?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
  }): HTMLElement {
    const handlers: Parameters<typeof el>[1] = {
      className: `tree-row${options.selected ? ' selected' : ''}`,
      title: options.label,
      style: { paddingLeft: `${8 + options.depth * 14}px` },
      on: {
        ...(options.onClick ? { click: options.onClick } : {}),
        ...(options.onDoubleClick ? { dblclick: options.onDoubleClick } : {}),
        ...(options.onContextMenu ? { contextmenu: options.onContextMenu } : {}),
      },
    };

    return el(
      'button',
      handlers,
      el('span', { className: 'twisty', text: options.twisty ?? '' }),
      el('span', { className: `glyph ${options.glyphClass}`, text: options.glyph }),
      el('span', { className: 'label', text: options.label }),
      options.hint ? el('span', { className: 'hint', text: options.hint }) : null,
    );
  }
}
