/**
 * Panel visual de Entity Framework Core.
 *
 * Responde a la pregunta que se hace cualquiera al abrir un proyecto con EF: *¿en qué estado está
 * la base de datos?* Tres bloques y ninguna sorpresa:
 *
 *  - **Migraciones**: cuáles hay, cuáles están aplicadas y cuáles pendientes, con los dos botones
 *    que se usan de verdad (crear migración, actualizar base de datos).
 *  - **Esquema**: tablas y columnas **deducidas de las migraciones del repositorio**. El IDE no
 *    se conecta a ninguna base de datos, y el panel lo dice: lo que se ve es lo que el proyecto
 *    va a crear, no lo que hay hoy en el servidor.
 *  - **Conexiones**: las cadenas de los `appsettings*.json` del proyecto, con la contraseña
 *    tapada, para saber contra qué se va a trabajar.
 *
 * La vista no ejecuta nada: llama a `window.dotforge.efcore.*`. Las operaciones de escritura
 * devuelven una tarea cuya salida va al panel inferior, como cualquier `dotnet build`, y el
 * panel se refresca solo cuando esa tarea termina.
 */
import type {
  ConnectionStringFileInfo,
  DatabaseSchema,
  EfDbContext,
  EfMigrationList,
  EfOperation,
  EfOperationOptions,
  ProjectInfo,
  SchemaTable,
  SolutionInfo,
} from '../../shared/contracts.js';
import { describeColumn } from '../../shared/efcore-schema.js';
import { isValidMigrationName } from '../../shared/efcore.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export interface EfCoreHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  /** Abre un archivo en el editor (una migración, un appsettings). Ruta absoluta. */
  openFile(path: string): void;
  /** Enseña el canal de salida donde va la tarea de EF. */
  showOutput(): void;
}

/** Paquetes que delatan al proyecto que contiene el DbContext y las migraciones. */
const EF_PACKAGES = ['microsoft.entityframeworkcore', 'npgsql.entityframeworkcore', 'pomelo.entityframeworkcore'];

/** True si el proyecto referencia EF Core: es el candidato natural para `--project`. */
export function usesEntityFramework(project: ProjectInfo): boolean {
  return project.packageReferences.some((reference) =>
    EF_PACKAGES.some((prefix) => reference.id.toLowerCase().startsWith(prefix)),
  );
}

type SectionId = 'migrations' | 'schema' | 'connections';

export class EfCoreView {
  private visible = false;
  private solution: SolutionInfo | null = null;

  private projectPath: string | null = null;
  private startupPath: string | null = null;
  private contextName: string | null = null;

  private migrations: EfMigrationList | null = null;
  private contexts: EfDbContext[] = [];
  private schema: DatabaseSchema | null = null;
  private connections: ConnectionStringFileInfo[] = [];

  private loading = false;
  private error: string | null = null;

  /** Tarea de escritura en curso: mientras exista, los botones están deshabilitados. */
  private runningTaskId: string | null = null;

  private readonly collapsed: Record<SectionId, boolean> = {
    migrations: false,
    schema: false,
    connections: true,
  };

  private readonly expandedTables = new Set<string>();

  /** Pendiente de llevar el foco al campo del nombre tras el próximo repintado. */
  private focusName = false;

  constructor(private readonly host: EfCoreHost) {}

  // --- Estado ---------------------------------------------------------------------------------

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) return;

    this.render();
    // La primera vez que se abre no hay nada leído todavía: se lee sin que haya que pulsar nada.
    if (this.migrations === null && this.projectPath !== null) void this.refresh();
  }

  isVisible(): boolean {
    return this.visible;
  }

  setSolution(solution: SolutionInfo | null): void {
    this.solution = solution;
    this.migrations = null;
    this.schema = null;
    this.connections = [];
    this.contexts = [];
    this.error = null;

    const projects = solution?.projects ?? [];
    this.projectPath = (projects.find(usesEntityFramework) ?? projects[0])?.path ?? null;
    this.startupPath = (projects.find((project) => project.isWebProject) ?? projects[0])?.path ?? null;
    this.contextName = null;

    this.render();
    if (this.visible && this.projectPath !== null) void this.refresh();
  }

  /** El shell avisa cuando termina una tarea: si era la nuestra, se relee el estado. */
  noteTaskExit(taskId: string, code: number | null): void {
    if (this.runningTaskId !== taskId) return;

    this.runningTaskId = null;
    if (code === 0) {
      this.host.notify('Operación de EF Core completada.', 'ok');
      void this.refresh();
    } else {
      this.host.notify('La operación de EF Core ha fallado. Mira la salida para el detalle.', 'warn');
      this.render();
    }
  }

  /**
   * Deja el cursor en el nombre de la migración nueva.
   *
   * Es lo que hace el comando de la paleta: no hay diálogo modal porque Electron no admite
   * `window.prompt`, y porque escribir el nombre donde se va a leer después es más claro que
   * hacerlo en una ventana que tapa el panel.
   */
  focusMigrationName(): void {
    this.focusName = true;
    this.render();
  }

  /** Aplica las migraciones pendientes. Lo llaman el botón y el comando de la paleta. */
  updateDatabase(): void {
    void this.run('database-update');
  }

  private target(extra: Partial<EfOperationOptions> = {}): EfOperationOptions | null {
    if (this.projectPath === null) return null;
    return {
      project: this.projectPath,
      startupProject: this.startupPath,
      context: this.contextName,
      ...extra,
    };
  }

  // --- Lectura --------------------------------------------------------------------------------

  /**
   * Relee migraciones, contextos, esquema y conexiones.
   *
   * El esquema y las conexiones salen del disco y son instantáneos; las migraciones exigen que EF
   * compile el proyecto y pueden tardar. Por eso el panel pinta primero lo barato: enseñar las
   * tablas mientras se espera es mejor que un spinner sobre un panel vacío.
   */
  async refresh(): Promise<void> {
    const target = this.target();
    if (!target) return;

    this.loading = true;
    this.error = null;
    this.render();

    const projectPath = target.project;

    try {
      const [schema, connections] = await Promise.all([
        window.dotforge.efcore.schema(projectPath),
        window.dotforge.efcore.connections(projectPath),
      ]);
      this.schema = schema;
      this.connections = connections;
      this.render();
    } catch (error) {
      this.schema = null;
      this.connections = [];
      this.error = error instanceof Error ? error.message : String(error);
    }

    try {
      const result = await window.dotforge.efcore.migrations(target);

      // El proyecto puede haber cambiado mientras se esperaba: lo leído ya no vale.
      if (this.projectPath !== projectPath) return;

      this.migrations = result.value;
      this.error = result.ok ? null : result.error;

      if (result.ok && this.contexts.length === 0) {
        const contexts = await window.dotforge.efcore.contexts(target);
        if (contexts.ok) this.contexts = contexts.value;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  // --- Escritura ------------------------------------------------------------------------------

  /** Lanza una operación de escritura y deja que su salida vaya al panel inferior. */
  private async run(operation: EfOperation, extra: Partial<EfOperationOptions> = {}): Promise<void> {
    const target = this.target(extra);
    if (!target || this.runningTaskId !== null) return;

    try {
      const task = await window.dotforge.efcore.run(operation, target);
      this.runningTaskId = task.taskId;
      this.host.showOutput();
      this.render();
    } catch (error) {
      this.host.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /** Crea una migración. El nombre se pide en la propia fila, sin diálogo modal. */
  private addMigration(name: string): void {
    if (!isValidMigrationName(name)) {
      this.host.notify(
        'El nombre de la migración debe empezar por letra o guion bajo y contener sólo letras, números y guiones bajos.',
        'warn',
      );
      return;
    }
    void this.run('migrations-add', { name: name.trim() });
  }

  private removeLastMigration(): void {
    const last = this.migrations?.migrations[this.migrations.migrations.length - 1];
    if (!last) return;

    const applied = last.applied;
    const message = applied
      ? `"${last.name}" ya está aplicada en la base de datos. Quitarla revertirá ese cambio. ¿Continuar?`
      : `¿Quitar la migración "${last.name}"?`;

    if (!window.confirm(message)) return;
    void this.run('migrations-remove', applied ? { force: true } : {});
  }

  // --- Pintado --------------------------------------------------------------------------------

  render(): void {
    if (!this.visible) return;

    const container = byId('sidebar-content');
    clear(container);
    byId('sidebar-title').textContent = 'Base de datos';

    const actions = byId('sidebar-actions');
    clear(actions);
    actions.appendChild(
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Releer migraciones y esquema',
          disabled: this.loading || this.projectPath === null,
          on: { click: () => void this.refresh() },
        },
        icon('refresh', { size: 15 }),
      ),
    );

    if (!this.solution || this.solution.projects.length === 0) {
      container.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          el('div', { className: 'empty-state-icon' }, icon('database', { size: 28 })),
          el('div', { text: 'Abre una solución con un proyecto de EF Core para gestionar sus migraciones.' }),
        ),
      );
      return;
    }

    const panel = el('div', { className: 'ef-panel' });
    panel.append(this.renderTargets(), this.renderToolbar());

    if (this.error !== null) {
      panel.appendChild(
        el(
          'div',
          { className: 'notice warn ef-error' },
          icon('alert-triangle', { size: 15 }),
          el('span', { text: this.error }),
        ),
      );
    }

    panel.append(this.renderMigrations(), this.renderSchema(), this.renderConnections());
    container.appendChild(panel);
  }

  /** Selectores de proyecto, proyecto de arranque y DbContext. */
  private renderTargets(): HTMLElement {
    const projects = this.solution?.projects ?? [];

    const picker = (
      label: string,
      value: string | null,
      options: ProjectInfo[],
      onChange: (path: string) => void,
    ): HTMLElement =>
      el(
        'label',
        { className: 'ef-field' },
        el('span', { className: 'ef-field-label', text: label }),
        el(
          'select',
          {
            className: 'settings-select',
            on: {
              change: (event) => onChange((event.currentTarget as HTMLSelectElement).value),
            },
          },
          ...options.map((project) =>
            el('option', {
              text: project.name,
              value: project.path,
              attrs: { ...(project.path === value ? { selected: 'selected' } : {}) },
            }),
          ),
        ),
      );

    const row = el('div', { className: 'ef-targets' });

    row.append(
      picker('Proyecto con migraciones', this.projectPath, projects, (path) => {
        this.projectPath = path;
        this.migrations = null;
        this.contexts = [];
        void this.refresh();
      }),
      picker('Proyecto de arranque', this.startupPath, projects, (path) => {
        this.startupPath = path;
        void this.refresh();
      }),
    );

    // El selector de contexto sólo aparece cuando hay más de uno: con uno solo estorba.
    if (this.contexts.length > 1) {
      row.appendChild(
        el(
          'label',
          { className: 'ef-field' },
          el('span', { className: 'ef-field-label', text: 'DbContext' }),
          el(
            'select',
            {
              className: 'settings-select',
              on: {
                change: (event) => {
                  this.contextName = (event.currentTarget as HTMLSelectElement).value;
                  void this.refresh();
                },
              },
            },
            ...this.contexts.map((context) =>
              el('option', {
                text: context.name,
                value: context.name,
                attrs: { ...(context.name === this.contextName ? { selected: 'selected' } : {}) },
              }),
            ),
          ),
        ),
      );
    }

    return row;
  }

  private renderToolbar(): HTMLElement {
    const busy = this.runningTaskId !== null || this.projectPath === null;
    const pending = this.migrations?.pending ?? 0;

    const input = el('input', {
      className: 'input ef-name',
      placeholder: 'Nombre de la migración',
      attrs: { 'aria-label': 'Nombre de la migración' },
      on: {
        keydown: (event) => {
          if (event.key === 'Enter') {
            this.addMigration((event.currentTarget as HTMLInputElement).value);
            (event.currentTarget as HTMLInputElement).value = '';
          }
        },
      },
    });

    /**
     * Un botón de la barra.
     *
     * Los rótulos son cortos a propósito: la barra lateral mide 240 px por defecto y un botón que
     * enseña "Actualizar base de d…" no informa de nada. La frase entera vive en el `title`, que
     * es donde se lee sin prisa.
     */
    const action = (
      label: string,
      hint: string,
      name: IconName,
      primary: boolean,
      onClick: () => void,
      badge = 0,
    ): HTMLElement =>
      el(
        'button',
        {
          className: `btn${primary ? ' primary' : ''} ef-action`,
          disabled: busy,
          title: hint,
          on: { click: onClick },
        },
        icon(name, { size: 15 }),
        el('span', { text: label }),
        badge > 0 ? el('span', { className: 'ef-badge', text: String(badge) }) : null,
      );

    if (this.focusName) {
      this.focusName = false;
      // Tras el repintado: el nodo todavía no está en el documento cuando se construye.
      window.setTimeout(() => input.focus(), 0);
    }

    return el(
      'div',
      { className: 'ef-toolbar' },
      el(
        'div',
        { className: 'ef-add' },
        input,
        el(
          'button',
          {
            className: 'btn ef-icon-action',
            disabled: busy,
            title: 'Crear una migración con los cambios del modelo (dotnet ef migrations add)',
            attrs: { 'aria-label': 'Añadir migración' },
            on: {
              click: () => {
                this.addMigration(input.value);
                input.value = '';
              },
            },
          },
          icon('plus', { size: 15 }),
        ),
      ),
      el(
        'div',
        { className: 'ef-actions' },
        action(
          'Actualizar la base de datos',
          'Aplica las migraciones pendientes (dotnet ef database update)',
          'play',
          pending > 0,
          () => void this.run('database-update'),
          pending,
        ),
        el(
          'button',
          {
            className: 'btn ef-icon-action',
            disabled: busy,
            title: 'Quitar la última migración (dotnet ef migrations remove)',
            attrs: { 'aria-label': 'Quitar la última migración' },
            on: { click: () => this.removeLastMigration() },
          },
          icon('undo', { size: 15 }),
        ),
      ),
      this.runningTaskId !== null
        ? el(
            'div',
            { className: 'ef-running' },
            el('span', { className: 'spinner' }),
            el('span', { text: 'Ejecutando dotnet ef… la salida va al panel inferior.' }),
          )
        : null,
    );
  }

  private section(id: SectionId, title: string, count: string, body: () => HTMLElement): HTMLElement {
    const collapsed = this.collapsed[id];

    return el(
      'section',
      { className: 'ef-section' },
      el(
        'button',
        {
          className: 'ef-section-header',
          on: {
            click: () => {
              this.collapsed[id] = !collapsed;
              this.render();
            },
          },
        },
        icon(collapsed ? 'chevron-right' : 'chevron-down', { size: 14 }),
        el('span', { className: 'ef-section-title', text: title }),
        el('span', { className: 'ef-section-count', text: count }),
      ),
      collapsed ? null : body(),
    );
  }

  private renderMigrations(): HTMLElement {
    return this.section(
      'migrations',
      'Migraciones',
      this.migrations === null ? '' : `${this.migrations.applied} aplicadas · ${this.migrations.pending} pendientes`,
      () => {
        const list = el('div', { className: 'ef-list' });

        if (this.loading && this.migrations === null) {
          list.appendChild(el('div', { className: 'ef-hint', text: 'Leyendo migraciones (EF compila el proyecto)…' }));
          return list;
        }

        const migrations = this.migrations?.migrations ?? [];
        if (migrations.length === 0) {
          list.appendChild(
            el('div', {
              className: 'ef-hint',
              text: 'No hay migraciones. Escribe un nombre arriba y pulsa "Añadir migración".',
            }),
          );
          return list;
        }

        for (const migration of migrations) {
          const date = migration.timestampUtc === null ? '' : migration.timestampUtc.slice(0, 10);

          list.appendChild(
            el(
              'div',
              {
                className: `ef-row${migration.applied ? '' : ' pending'}`,
                title: migration.id,
                on: { click: () => this.openMigration(migration.id) },
              },
              icon(migration.applied ? 'check' : 'circle-dot', { size: 14 }),
              el('span', { className: 'ef-row-name', text: migration.name }),
              el('span', { className: 'ef-row-date', text: date }),
              el('span', {
                className: `ef-state ${migration.applied ? 'applied' : 'pending'}`,
                text: migration.applied ? 'aplicada' : 'pendiente',
              }),
            ),
          );
        }

        if (this.migrations?.degraded === true) {
          list.appendChild(
            el('div', {
              className: 'ef-hint',
              text: 'Estado leído del texto de la CLI: las herramientas de EF no han devuelto JSON.',
            }),
          );
        }

        return list;
      },
    );
  }

  /** Abre el archivo de la migración en el editor, si está donde EF lo deja por defecto. */
  private openMigration(id: string): void {
    if (this.projectPath === null) return;

    const directory = this.projectPath.replace(/[\\/][^\\/]+$/, '');
    this.host.openFile(`${directory}/Migrations/${id}.cs`);
  }

  private renderSchema(): HTMLElement {
    const tables = this.schema?.tables ?? [];

    return this.section('schema', 'Esquema deducido', tables.length === 0 ? '' : `${tables.length} tablas`, () => {
      const list = el('div', { className: 'ef-list' });

      if (tables.length === 0) {
        list.appendChild(
          el('div', {
            className: 'ef-hint',
            text: 'Sin tablas: el proyecto todavía no tiene migraciones que crearlas.',
          }),
        );
        return list;
      }

      for (const table of tables) list.appendChild(this.renderTable(table));

      if ((this.schema?.opaqueMigrations.length ?? 0) > 0) {
        list.appendChild(
          el('div', {
            className: 'ef-hint',
            text:
              `${this.schema!.opaqueMigrations.length} migración(es) ejecutan SQL directo: ` +
              'su efecto no aparece en este esquema.',
          }),
        );
      }

      return list;
    });
  }

  private renderTable(table: SchemaTable): HTMLElement {
    const expanded = this.expandedTables.has(table.name);

    const node = el(
      'div',
      { className: 'ef-table' },
      el(
        'button',
        {
          className: 'ef-table-head',
          on: {
            click: () => {
              if (expanded) this.expandedTables.delete(table.name);
              else this.expandedTables.add(table.name);
              this.render();
            },
          },
        },
        icon(expanded ? 'chevron-down' : 'chevron-right', { size: 14 }),
        icon('database', { size: 14 }),
        el('span', { className: 'ef-table-name', text: table.name }),
        el('span', { className: 'ef-table-count', text: `${table.columns.length} col.` }),
      ),
    );

    if (!expanded) return node;

    for (const column of table.columns) {
      node.appendChild(
        el(
          'div',
          { className: 'ef-column' },
          el('span', { className: `ef-key${column.primaryKey ? ' on' : ''}`, text: column.primaryKey ? 'PK' : '' }),
          el('span', { className: 'ef-column-name', text: column.name }),
          el('span', { className: 'ef-column-type', text: describeColumn(column) }),
        ),
      );
    }

    for (const index of table.indexes) {
      node.appendChild(
        el(
          'div',
          { className: 'ef-column ef-index' },
          el('span', { className: 'ef-key' }),
          el('span', { className: 'ef-column-name', text: index.name }),
          el('span', {
            className: 'ef-column-type',
            text: `${index.unique ? 'único · ' : ''}${index.columns.join(', ')}`,
          }),
        ),
      );
    }

    return node;
  }

  private renderConnections(): HTMLElement {
    const total = this.connections.reduce((sum, file) => sum + file.connections.length, 0);

    return this.section('connections', 'Cadenas de conexión', total === 0 ? '' : String(total), () => {
      const list = el('div', { className: 'ef-list' });

      if (this.connections.length === 0) {
        list.appendChild(
          el('div', {
            className: 'ef-hint',
            text: 'Ningún appsettings del proyecto declara ConnectionStrings.',
          }),
        );
        return list;
      }

      for (const file of this.connections) {
        list.appendChild(
          el(
            'button',
            { className: 'ef-file', on: { click: () => this.host.openFile(file.path) } },
            icon('braces', { size: 14 }),
            el('span', { text: file.name }),
          ),
        );

        for (const connection of file.connections) {
          list.appendChild(
            el(
              'div',
              { className: 'ef-connection', title: connection.masked },
              el('span', { className: 'ef-provider', text: connection.provider }),
              el('span', { className: 'ef-connection-name', text: connection.name }),
              el('span', {
                className: 'ef-connection-target',
                text: [connection.server, connection.database].filter(Boolean).join(' · '),
              }),
            ),
          );
        }
      }

      return list;
    });
  }
}
