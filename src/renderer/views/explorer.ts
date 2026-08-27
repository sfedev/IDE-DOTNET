/**
 * Explorador de soluciones .NET.
 *
 * Dos modos:
 *  - **Solución** (por defecto): la jerarquía que un desarrollador .NET espera — solución,
 *    carpetas de solución, proyectos con su insignia de tipo, y dentro de cada proyecto sus
 *    archivos reales, sus dependencias y sus paquetes.
 *  - **Archivos**: el árbol crudo de la carpeta, para lo que no pertenece a ningún proyecto.
 *
 * Decisiones de diseño que hacen navegable una solución DDD de siete proyectos:
 *  - Los archivos satélite se anidan bajo su principal (`Home.razor.css` bajo `Home.razor`).
 *  - Cada nivel dibuja una guía vertical sutil; la del nivel del elemento seleccionado se
 *    resalta, que es lo que evita perderse a cinco niveles de profundidad.
 *  - `bin`, `obj`, `.git`, `.vs` y compañía no se listan: los filtra el proceso principal.
 *  - Los proyectos se expanden mostrando **primero sus archivos** y luego, plegadas, sus
 *    dependencias. El código es lo que se busca el 95% de las veces.
 */
import type { FileNode, ProjectInfo, SolutionInfo } from '../../shared/contracts.js';
import { byId, clear, el } from '../dom.js';
import { iconForFile, iconForFolder, nestFiles, presentProject, type IconSpec } from '../file-icons.js';
import { icon, type IconName } from '../icons.js';

export type ExplorerMode = 'solution' | 'files';

export interface ExplorerHost {
  openFile(path: string): void;
  revealInFolder(path: string): void;
  runProjectTask(kind: 'build' | 'run' | 'watch' | 'test', projectPath: string): void;
  /** Abre el diálogo de publicación de un proyecto ejecutable. */
  publishProject(project: ProjectInfo): void;
  showPackagesFor(project: ProjectInfo): void;
  refresh(): void;
  /** Acciones del asistente sobre un archivo concreto del árbol. */
  askAi(action: 'explain' | 'tests' | 'fix', path: string): void;
}

/** Entrada de un menú contextual: una acción con icono, o un separador. */
type MenuEntry = { icon: IconName; label: string; run: () => void } | 'separator';

/** Sub-secciones plegables dentro de un proyecto. */
type ProjectSection = 'references' | 'packages';

interface RowOptions {
  depth: number;
  /** null = sin flecha (hoja). */
  expanded: boolean | null;
  iconSpec: IconSpec | { name: IconName; tone: string };
  label: string;
  /** Texto gris a la derecha (framework, versión, ruta relativa). */
  hint?: string;
  badge?: { text: string; tone: string; title?: string };
  selected?: boolean;
  emphasis?: 'solution' | 'project' | 'section' | null;
  title?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}

export class ExplorerView {
  private mode: ExplorerMode = 'solution';
  private solution: SolutionInfo | null = null;
  private selectedPath: string | null = null;
  private visible = true;
  private filter = '';

  /** Directorios desplegados, con sus hijos cacheados. */
  private readonly expanded = new Set<string>();
  private readonly childrenCache = new Map<string, FileNode[]>();

  /** Proyectos y sub-secciones desplegados. */
  private readonly expandedProjects = new Set<string>();
  private readonly expandedSections = new Set<string>();

  /** Archivos principales con satélites desplegados. */
  private readonly expandedNests = new Set<string>();

  constructor(private readonly host: ExplorerHost) {}

  // --- Estado -------------------------------------------------------------------------------

  setSolution(solution: SolutionInfo | null): void {
    this.solution = solution;
    this.expanded.clear();
    this.childrenCache.clear();
    this.expandedProjects.clear();
    this.expandedSections.clear();
    this.expandedNests.clear();

    if (solution) {
      this.expanded.add(solution.directory);

      // Se abre el primer proyecto que contenga código de aplicación: al abrir una solución,
      // encontrarse el árbol totalmente plegado obliga a tres clics antes de ver nada útil.
      const first =
        solution.projects.find((project) => project.kind === 'blazor-server' || project.kind === 'webapi') ??
        solution.projects[0];
      if (first) this.expandedProjects.add(first.path);
    }

    this.render();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.render();
  }

  setMode(mode: ExplorerMode): void {
    this.mode = mode;
    this.render();
  }

  /**
   * Abre el filtro del árbol y le da el foco.
   *
   * Lo llaman el botón de la vista y el menú Editar. Es un filtro **por nombre de archivo**, no una
   * búsqueda dentro del contenido, y el menú lo dice con esas palabras: prometer "buscar en los
   * archivos" y filtrar por nombre es peor que no ofrecerlo.
   */
  focusFilter(): void {
    this.filter = this.filter === '' ? ' ' : '';
    this.render();
    byId('sidebar-content').querySelector<HTMLInputElement>('.tree-filter input')?.focus();
  }

  getMode(): ExplorerMode {
    return this.mode;
  }

  select(path: string): void {
    this.selectedPath = path;
    this.render();
  }

  collapseAll(): void {
    this.expandedProjects.clear();
    this.expandedSections.clear();
    this.expandedNests.clear();
    this.expanded.clear();
    if (this.solution) this.expanded.add(this.solution.directory);
    this.render();
  }

  async refresh(): Promise<void> {
    this.childrenCache.clear();
    for (const directory of this.expanded) {
      this.childrenCache.set(directory, await this.readDirectory(directory));
    }
    this.render();
  }

  private async readDirectory(path: string): Promise<FileNode[]> {
    try {
      return await window.dotforge.fs.listDirectory(path);
    } catch {
      return [];
    }
  }

  private async toggleDirectory(path: string): Promise<void> {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
    } else {
      this.expanded.add(path);
      if (!this.childrenCache.has(path)) {
        this.childrenCache.set(path, await this.readDirectory(path));
      }
    }
    this.render();
  }

  // --- Render -------------------------------------------------------------------------------

  render(): void {
    if (!this.visible) return;

    const container = byId('sidebar-content');
    clear(container);

    byId('sidebar-title').textContent = this.mode === 'solution' ? 'Solución' : 'Archivos';
    this.renderHeaderActions();

    if (!this.solution) {
      container.appendChild(this.renderEmptyState());
      return;
    }

    /**
     * Sin `trim()` a propósito, y aquí está la diferencia entre "el filtro está abierto" y "el
     * filtro filtra algo".
     *
     * `focusFilter()` abre la caja poniendo un espacio, que es el centinela de "abierta y vacía".
     * Con `trim()` ese espacio contaba como vacío y la barra no se pintaba nunca: el botón
     * "Filtrar por nombre" de la barra de la vista llevaba desde la Fase 7 sin hacer nada visible.
     * Filtrar de verdad sí mira el texto recortado (más abajo): un espacio no puede descartar
     * archivos.
     */
    if (this.filter !== '') {
      container.appendChild(this.renderFilterBar());
    }

    const tree = el('div', { className: 'tree', role: 'tree' });
    if (this.mode === 'solution') this.renderSolutionTree(tree);
    else this.renderFileTree(tree);

    container.appendChild(tree);
  }

  private renderEmptyState(): HTMLElement {
    return el(
      'div',
      { className: 'empty-state' },
      icon('folder-open', { size: 32, className: 'empty-state-icon' }),
      el('p', { text: 'Ninguna carpeta abierta' }),
      el('p', { className: 'empty-state-hint', text: 'Abre una solución para ver sus proyectos aquí.' }),
      el(
        'button',
        { className: 'btn primary', on: { click: () => this.host.refresh() } },
        icon('folder-open'),
        'Abrir carpeta',
      ),
    );
  }

  private renderHeaderActions(): void {
    const actions = byId('sidebar-actions');
    clear(actions);

    const action = (name: IconName, title: string, onClick: () => void, active = false): HTMLElement =>
      el(
        'button',
        {
          className: `icon-btn${active ? ' active' : ''}`,
          title,
          attrs: { 'aria-label': title },
          on: { click: onClick },
        },
        icon(name, { size: 15 }),
      );

    if (!this.solution) return;

    actions.append(
      action('search', 'Filtrar por nombre', () => this.focusFilter(), this.filter !== ''),
      action(
        this.mode === 'solution' ? 'folder' : 'solution',
        this.mode === 'solution' ? 'Ver archivos de la carpeta' : 'Ver la solución',
        () => this.setMode(this.mode === 'solution' ? 'files' : 'solution'),
      ),
      action('collapse-all', 'Contraer todo', () => this.collapseAll()),
      action('refresh', 'Actualizar', () => void this.refresh()),
    );
  }

  private renderFilterBar(): HTMLElement {
    const input = el('input', {
      className: 'input',
      placeholder: 'Filtrar archivos…',
      value: this.filter.trim(),
      on: {
        input: (event) => {
          this.filter = (event.target as HTMLInputElement).value;
          this.render();
          const field = byId('sidebar-content').querySelector<HTMLInputElement>('.tree-filter input');
          field?.focus();
          field?.setSelectionRange(field.value.length, field.value.length);
        },
        keydown: (event) => {
          if ((event as KeyboardEvent).key === 'Escape') {
            this.filter = '';
            this.render();
          }
        },
      },
    });

    return el(
      'div',
      { className: 'tree-filter' },
      icon('search', { size: 14, className: 'tone-muted' }),
      input,
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Quitar filtro',
          on: {
            click: () => {
              this.filter = '';
              this.render();
            },
          },
        },
        icon('x', { size: 13 }),
      ),
    );
  }

  private matchesFilter(name: string): boolean {
    const term = this.filter.trim().toLowerCase();
    return term === '' || name.toLowerCase().includes(term);
  }

  // --- Vista de solución -----------------------------------------------------------------------

  private renderSolutionTree(tree: HTMLElement): void {
    const solution = this.solution!;

    tree.appendChild(
      this.row({
        depth: 0,
        expanded: null,
        iconSpec: { name: 'solution', tone: 'tone-project' },
        label: solution.name,
        hint: `${solution.projects.length} ${solution.projects.length === 1 ? 'proyecto' : 'proyectos'}`,
        emphasis: 'solution',
        title: solution.path ?? solution.directory,
        onClick: () => {
          if (solution.path) this.host.openFile(solution.path);
        },
      }),
    );

    for (const warning of solution.warnings) {
      tree.appendChild(
        el(
          'div',
          { className: 'tree-notice' },
          icon('alert-triangle', { size: 13 }),
          el('span', { text: warning }),
        ),
      );
    }

    if (solution.projects.length === 0) {
      tree.appendChild(
        el('div', { className: 'empty-state compact', text: 'La carpeta no contiene proyectos .NET.' }),
      );
      return;
    }

    // Agrupación por carpeta de solución, respetando el orden del .sln.
    const groups = new Map<string, ProjectInfo[]>();
    for (const project of solution.projects) {
      const key = project.solutionFolder ?? '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(project);
      else groups.set(key, [project]);
    }

    for (const [folder, projects] of groups) {
      // La carpeta de solución no es un nivel navegable: es una etiqueta. Añadir una fila
      // plegable más sólo aportaría un clic extra para llegar al código.
      if (folder !== '') {
        tree.appendChild(el('div', { className: 'tree-section', text: this.prettyFolderName(folder) }));
      }

      for (const project of projects) {
        this.renderProjectNode(tree, project, 1);
      }
    }
  }

  /** `1-Domain` → `Domain`: el prefijo numérico ordena el .sln, pero es ruido en pantalla. */
  private prettyFolderName(folder: string): string {
    return folder.replace(/^\d+[-_.\s]*/, '');
  }

  /**
   * ¿Merece la pena mostrar el target framework en cada fila?
   *
   * Sólo si la solución mezcla varios. Repetir "net9.0" siete veces no informa de nada y roba
   * el espacio que necesita el nombre del proyecto, que es lo que el usuario está leyendo.
   */
  private showsFrameworkHint(): boolean {
    const frameworks = new Set((this.solution?.projects ?? []).flatMap((project) => project.targetFrameworks));
    return frameworks.size > 1;
  }

  private renderProjectNode(tree: HTMLElement, project: ProjectInfo, depth: number): void {
    const expanded = this.expandedProjects.has(project.path);
    const presentation = presentProject(project.kind);

    tree.appendChild(
      this.row({
        depth,
        expanded,
        iconSpec: { name: presentation.icon, tone: `tone-${presentation.tone}` },
        label: project.name,
        ...(this.showsFrameworkHint() ? { hint: project.targetFrameworks.join(', ') } : {}),
        badge: { text: presentation.badge, tone: presentation.tone, title: presentation.description },
        emphasis: 'project',
        selected: this.selectedPath === project.path,
        title: `${project.name}\n${presentation.description}\n${project.path}`,
        onClick: () => {
          if (expanded) this.expandedProjects.delete(project.path);
          else this.expandedProjects.add(project.path);
          this.render();
        },
        onDoubleClick: () => this.host.openFile(project.path),
        onContextMenu: (event) => this.showProjectMenu(event, project),
      }),
    );

    if (!expanded) return;

    // Los archivos del proyecto primero: es lo que se busca casi siempre.
    // El propio .csproj se omite porque ya está representado por la fila del proyecto (doble
    // clic sobre ella lo abre); repetirlo sólo añade una fila que nadie busca.
    this.appendDirectory(tree, project.directory, depth + 1, project.path);

    if (project.projectReferences.length > 0) {
      this.renderSection(
        tree,
        project,
        'references',
        depth + 1,
        'plug',
        'Dependencias',
        project.projectReferences.length,
        () =>
          project.projectReferences.map((reference) =>
            this.row({
              depth: depth + 2,
              expanded: null,
              iconSpec: { name: 'project', tone: 'tone-project' },
              label: reference.name,
              title: reference.path,
              onClick: () => this.host.openFile(reference.path),
            }),
          ),
      );
    }

    if (project.packageReferences.length > 0) {
      this.renderSection(
        tree,
        project,
        'packages',
        depth + 1,
        'package',
        'Paquetes',
        project.packageReferences.length,
        () =>
          project.packageReferences.map((reference) =>
            this.row({
              depth: depth + 2,
              expanded: null,
              iconSpec: { name: 'package', tone: 'tone-config' },
              label: reference.id,
              hint: reference.version ?? 'central',
              title: reference.centrallyManaged
                ? `${reference.id}\nVersión fijada en Directory.Packages.props`
                : `${reference.id} ${reference.version ?? ''}`,
              onClick: () => this.host.showPackagesFor(project),
            }),
          ),
      );
    }
  }

  private renderSection(
    tree: HTMLElement,
    project: ProjectInfo,
    section: ProjectSection,
    depth: number,
    iconName: IconName,
    label: string,
    count: number,
    build: () => HTMLElement[],
  ): void {
    const key = `${project.path}::${section}`;
    const expanded = this.expandedSections.has(key);

    tree.appendChild(
      this.row({
        depth,
        expanded,
        iconSpec: { name: iconName, tone: 'tone-muted' },
        label,
        hint: String(count),
        emphasis: 'section',
        onClick: () => {
          if (expanded) this.expandedSections.delete(key);
          else this.expandedSections.add(key);
          this.render();
        },
      }),
    );

    if (expanded) {
      for (const row of build()) tree.appendChild(row);
    }
  }

  // --- Vista de archivos -------------------------------------------------------------------------

  private renderFileTree(tree: HTMLElement): void {
    const root = this.solution!.directory;
    const expanded = this.expanded.has(root);

    tree.appendChild(
      this.row({
        depth: 0,
        expanded,
        iconSpec: { name: expanded ? 'folder-open' : 'folder', tone: 'tone-project' },
        label: this.solution!.name,
        emphasis: 'solution',
        onClick: () => void this.toggleDirectory(root),
      }),
    );

    if (expanded) this.appendDirectory(tree, root, 1);
  }

  /**
   * Vuelca el contenido de un directorio, con anidamiento de archivos satélite.
   * Los directorios se piden bajo demanda y quedan cacheados.
   */
  private appendDirectory(tree: HTMLElement, directory: string, depth: number, omitPath?: string): void {
    const children = this.childrenCache.get(directory);

    if (!children) {
      tree.appendChild(
        el(
          'div',
          { className: 'tree-loading', style: { paddingLeft: `${this.indentFor(depth)}px` } },
          el('span', { className: 'spinner' }),
          el('span', { text: 'Cargando…' }),
        ),
      );

      void this.readDirectory(directory).then((nodes) => {
        this.childrenCache.set(directory, nodes);
        this.render();
      });
      return;
    }

    const nested = nestFiles(omitPath ? children.filter((child) => child.path !== omitPath) : children);
    const filtering = this.filter.trim() !== '';

    for (const entry of nested) {
      const node = entry.node;

      if (node.kind === 'directory') {
        const open = this.expanded.has(node.path);
        const spec = iconForFolder(node.name, open);

        tree.appendChild(
          this.row({
            depth,
            expanded: open,
            iconSpec: { name: spec.name, tone: `tone-${spec.tone}` },
            label: node.name,
            title: node.path,
            onClick: () => void this.toggleDirectory(node.path),
            onContextMenu: (event) => {
              event.preventDefault();
              this.host.revealInFolder(node.path);
            },
          }),
        );

        if (open) this.appendDirectory(tree, node.path, depth + 1);
        continue;
      }

      // Al filtrar, un archivo se muestra si él o alguno de sus satélites coincide.
      if (filtering && !this.matchesFilter(node.name) && !entry.children.some((child) => this.matchesFilter(child.name))) {
        continue;
      }

      const spec = iconForFile(node.name);
      const hasNest = entry.children.length > 0;
      const nestOpen = this.expandedNests.has(node.path);

      tree.appendChild(
        this.row({
          depth,
          expanded: hasNest ? nestOpen : null,
          iconSpec: { name: spec.name, tone: `tone-${spec.tone}` },
          label: node.name,
          hint: hasNest && !nestOpen ? `+${entry.children.length}` : undefined,
          selected: this.selectedPath === node.path,
          title: node.path,
          onClick: () => {
            this.selectedPath = node.path;
            this.host.openFile(node.path);
          },
          onDoubleClick: hasNest
            ? () => {
                if (nestOpen) this.expandedNests.delete(node.path);
                else this.expandedNests.add(node.path);
                this.render();
              }
            : undefined,
          onContextMenu: (event) => this.showFileMenu(event, node.path),
        }),
      );

      // La flecha de un archivo con satélites despliega el grupo sin abrir el archivo.
      if (hasNest && nestOpen) {
        for (const child of entry.children) {
          const childSpec = iconForFile(child.name);
          tree.appendChild(
            this.row({
              depth: depth + 1,
              expanded: null,
              iconSpec: { name: childSpec.name, tone: `tone-${childSpec.tone}` },
              label: child.name,
              selected: this.selectedPath === child.path,
              title: child.path,
              onClick: () => {
                this.selectedPath = child.path;
                this.host.openFile(child.path);
              },
            }),
          );
        }
      }
    }
  }

  // --- Fila -----------------------------------------------------------------------------------

  private indentFor(depth: number): number {
    return 8 + depth * 15;
  }

  /**
   * Construye una fila del árbol.
   *
   * Las guías de sangría son elementos reales, no un `background-image` repetido: así se puede
   * resaltar la del nivel activo, que es lo que de verdad ayuda a orientarse.
   */
  private row(options: RowOptions): HTMLElement {
    const guides = el('span', { className: 'tree-guides', attrs: { 'aria-hidden': 'true' } });
    for (let level = 0; level < options.depth; level++) {
      guides.appendChild(el('span', { className: 'tree-guide' }));
    }

    const twisty = el('span', { className: 'tree-twisty' });
    if (options.expanded !== null) {
      twisty.appendChild(icon(options.expanded ? 'chevron-down' : 'chevron-right', { size: 13 }));
    }

    const classes = ['tree-row'];
    if (options.selected) classes.push('selected');
    if (options.emphasis) classes.push(`is-${options.emphasis}`);

    const handlers: Record<string, (event: Event) => void> = {};
    if (options.onClick) handlers['click'] = () => options.onClick!();
    if (options.onDoubleClick) handlers['dblclick'] = () => options.onDoubleClick!();
    if (options.onContextMenu) handlers['contextmenu'] = (event) => options.onContextMenu!(event as MouseEvent);

    return el(
      'button',
      {
        className: classes.join(' '),
        title: options.title ?? options.label,
        role: 'treeitem',
        attrs: options.expanded === null ? {} : { 'aria-expanded': String(options.expanded) },
        on: handlers,
      },
      guides,
      twisty,
      icon(options.iconSpec.name, { size: 15, className: `tree-icon ${options.iconSpec.tone}` }),
      el('span', { className: 'tree-label', text: options.label }),
      options.badge
        ? el('span', {
            className: `tree-badge tone-${options.badge.tone}`,
            text: options.badge.text,
            title: options.badge.title ?? options.badge.text,
          })
        : null,
      options.hint ? el('span', { className: 'tree-hint', text: options.hint }) : null,
    );
  }

  // --- Menú contextual ---------------------------------------------------------------------------

  private showProjectMenu(event: MouseEvent, project: ProjectInfo): void {
    event.preventDefault();

    const runnable = project.kind !== 'library' && project.kind !== 'razor-library';

    const entries: MenuEntry[] = [
      { icon: 'hammer', label: 'Compilar proyecto', run: () => this.host.runProjectTask('build', project.path) },
      ...(runnable && project.kind !== 'tests'
        ? ([
            { icon: 'play', label: 'Ejecutar', run: () => this.host.runProjectTask('run', project.path) },
            { icon: 'refresh', label: 'Ejecutar con Hot Reload', run: () => this.host.runProjectTask('watch', project.path) },
          ] as const)
        : []),
      ...(project.kind === 'tests'
        ? ([{ icon: 'flask', label: 'Ejecutar pruebas', run: () => this.host.runProjectTask('test', project.path) }] as const)
        : []),
      // Publicar sólo se ofrece donde produce algo ejecutable. Una biblioteca de clases se puede
      // publicar —el SDK lo admite— pero lo que sale no se arranca, y ofrecerlo ahí convierte la
      // entrada en ruido en las cinco de siete proyectos de una solución Clean Architecture.
      ...(runnable && project.kind !== 'tests'
        ? ([{ icon: 'package', label: 'Publicar…', run: () => this.host.publishProject(project) }] as const)
        : []),
      'separator',
      { icon: 'package', label: 'Gestionar paquetes NuGet', run: () => this.host.showPackagesFor(project) },
      { icon: 'code', label: 'Abrir .csproj', run: () => this.host.openFile(project.path) },
      { icon: 'external-link', label: 'Mostrar en el explorador', run: () => this.host.revealInFolder(project.path) },
    ];

    this.showMenu(event, entries);
  }

  /**
   * Menú contextual de un archivo.
   *
   * Antes, el botón derecho sobre un archivo hacía una única cosa (mostrarlo en el explorador del
   * sistema) sin decirlo. Ahora es un menú de verdad, que es donde tienen sentido las acciones del
   * asistente: se piden sobre el archivo que se está señalando, no sobre el que esté abierto.
   */
  private showFileMenu(event: MouseEvent, path: string): void {
    event.preventDefault();
    this.selectedPath = path;

    const entries: MenuEntry[] = [
      { icon: 'code', label: 'Abrir', run: () => this.host.openFile(path) },
      'separator',
      { icon: 'sparkles', label: 'Explicar el código con IA', run: () => this.host.askAi('explain', path) },
      { icon: 'flask', label: 'Generar pruebas xUnit', run: () => this.host.askAi('tests', path) },
      { icon: 'tool', label: 'Corregir violación de arquitectura', run: () => this.host.askAi('fix', path) },
      'separator',
      { icon: 'external-link', label: 'Mostrar en el explorador', run: () => this.host.revealInFolder(path) },
    ];

    this.showMenu(event, entries);
  }

  /** Pinta un menú contextual y lo reposiciona si se sale de la ventana. */
  private showMenu(event: MouseEvent, entries: MenuEntry[]): void {
    const menu = el('div', {
      className: 'context-menu',
      style: { left: `${event.clientX}px`, top: `${event.clientY}px` },
    });

    const close = (): void => {
      menu.remove();
      document.removeEventListener('mousedown', onDocumentDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };

    for (const entry of entries) {
      if (entry === 'separator') {
        menu.appendChild(el('div', { className: 'context-separator' }));
        continue;
      }

      menu.appendChild(
        el(
          'button',
          {
            className: 'context-item',
            on: {
              click: () => {
                close();
                entry.run();
              },
            },
          },
          icon(entry.icon, { size: 15, className: 'tone-muted' }),
          el('span', { text: entry.label }),
        ),
      );
    }

    const onDocumentDown = (documentEvent: MouseEvent): void => {
      if (!menu.contains(documentEvent.target as Node)) close();
    };
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') close();
    };

    document.body.appendChild(menu);

    // Si el menú se sale por abajo o por la derecha, se reposiciona dentro de la ventana.
    const bounds = menu.getBoundingClientRect();
    if (bounds.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, window.innerHeight - bounds.height - 8)}px`;
    }
    if (bounds.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - bounds.width - 8)}px`;
    }

    setTimeout(() => {
      document.addEventListener('mousedown', onDocumentDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    }, 0);
  }
}
