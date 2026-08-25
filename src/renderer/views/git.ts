/**
 * Panel de control de código fuente.
 *
 * Es la vista que un desarrollador que viene de Visual Studio, Rider o VS Code busca sin pensar:
 * dos secciones (lo preparado y lo que no), una letra por archivo, acciones al pasar el ratón,
 * una caja de mensaje y los cuatro botones de siempre.
 *
 * Tres decisiones que gobiernan el archivo:
 *
 * 1. **La vista no ejecuta git.** Llama a `window.dotforge.git.*`, que devuelve el estado ya
 *    refrescado por el proceso principal. Así el panel nunca pinta un estado que se ha inventado
 *    a partir de lo que "debería" haber pasado.
 * 2. **Nada destructivo sin confirmación.** Descartar cambios es la única acción del panel que
 *    pierde trabajo, y la confirmación dice explícitamente si el archivo se va a restaurar o a
 *    borrar, porque para un archivo sin rastrear no hay versión anterior a la que volver.
 * 3. **El borrador del mensaje sobrevive a los repintados.** El estado se refresca solo cada pocos
 *    segundos; perder media línea de mensaje de commit por un repintado sería inaceptable.
 */
import type { GitCommandResult, GitFileChange, GitFileDiff, GitRepositoryStatus } from '../../shared/contracts.js';
import { buildDiffRequest, describeLetter, isValidBranchName, syncSummary } from '../../shared/git.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { confirmDialog } from './confirm-dialog.js';

export interface GitViewHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  /** Abre la comparación en el editor de diferencias. */
  openDiff(diff: GitFileDiff): void;
  /** Abre el archivo real en el editor (doble clic en una fila). Llega en absoluto. */
  openFile(path: string): void;
  /** Cambiar de rama puede cambiar los proyectos: hay que releer la solución. */
  reloadSolution(): void;
  /** Se ha ejecutado algo que cambia el estado: refresca la barra inferior. */
  statusChanged(): void;
}

type Section = 'staged' | 'unstaged';

const SECTION_TITLE: Record<Section, string> = {
  staged: 'Cambios preparados',
  unstaged: 'Cambios',
};

export class GitView {
  private visible = false;
  private status: GitRepositoryStatus | null = null;
  private branches: string[] = [];
  private repositoryDetected = true;

  /** Borrador del mensaje de commit. Vive aquí para sobrevivir a los repintados. */
  private message = '';

  /** Con una operación en marcha se deshabilitan los botones: un push doble no ayuda a nadie. */
  private busy = false;

  private readonly collapsed: Record<Section, boolean> = { staged: false, unstaged: false };
  private branchMenuOpen = false;
  private amend = false;

  constructor(private readonly host: GitViewHost) {}

  // --- Estado ---------------------------------------------------------------------------------

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.render();
      void this.refresh();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  getStatus(): GitRepositoryStatus | null {
    return this.status;
  }

  /** Relee el estado del repositorio. La llama el sondeo del shell y cada acción del panel. */
  async refresh(): Promise<void> {
    try {
      const [status, branches] = await Promise.all([
        window.dotforge.git.repository(),
        window.dotforge.git.branches(),
      ]);

      this.status = status;
      this.branches = branches;
      this.repositoryDetected = status !== null;
    } catch {
      this.status = null;
      this.repositoryDetected = false;
    }

    this.render();
  }

  /** Aplica el estado que devuelve una operación, sin pedirlo otra vez. */
  private applyResult(result: GitCommandResult, level: 'ok' | 'info' = 'ok'): void {
    if (result.status) this.status = result.status;
    this.host.notify(result.message, result.ok ? level : 'warn');

    // Un fallo casi siempre trae la explicación de git: se manda a la salida, que es donde se lee.
    if (!result.ok && result.detail !== '') this.host.notify(result.detail, 'warn');

    this.host.statusChanged();
    this.render();
  }

  private async perform(
    action: () => Promise<GitCommandResult>,
    options: { reloadSolution?: boolean } = {},
  ): Promise<void> {
    if (this.busy) return;

    this.busy = true;
    this.render();

    try {
      const result = await action();
      this.applyResult(result);
      if (options.reloadSolution === true && result.ok) this.host.reloadSolution();
    } catch (error) {
      this.host.notify(
        `La operación de git ha fallado: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    } finally {
      this.busy = false;
      this.render();
      void this.refresh();
    }
  }

  // --- Acciones -------------------------------------------------------------------------------

  private stage(paths: string[]): void {
    void this.perform(() => window.dotforge.git.stage(paths));
  }

  private unstage(paths: string[]): void {
    void this.perform(() => window.dotforge.git.unstage(paths));
  }

  /**
   * Descarta cambios.
   *
   * La confirmación no es un trámite: para un archivo sin rastrear, "descartar" significa
   * **borrarlo del disco**, y eso hay que decirlo con esas palabras antes de hacerlo.
   */
  private async discard(changes: GitFileChange[]): Promise<void> {
    if (changes.length === 0) return;

    const untracked = changes.filter((change) => change.untracked);
    const detail =
      changes.length === 1
        ? `"${changes[0]?.name}"`
        : `${changes.length} archivos`;

    const consequence =
      untracked.length === changes.length
        ? 'Se borrarán del disco: no tienen ninguna versión anterior guardada en git.'
        : untracked.length > 0
          ? `${untracked.length} de ellos se borrarán del disco (no están rastreados) y el resto volverá a su última versión.`
          : 'Volverán a su última versión guardada.';

    const confirmed = await confirmDialog({
      title: 'Descartar los cambios',
      message: `Se van a descartar los cambios de ${detail}. ${consequence}`,
      detail: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Descartar',
      tone: 'danger',
    });

    if (!confirmed) return;

    void this.perform(() => window.dotforge.git.discard(changes.map((change) => change.path)));
  }

  commit(): void {
    const message = this.message.trim();
    if (message === '') {
      this.host.notify('Escribe un mensaje de commit antes de confirmar.', 'warn');
      return;
    }

    const amend = this.amend;
    void this.perform(async () => {
      const result = await window.dotforge.git.commit(message, { amend });
      if (result.ok) {
        this.message = '';
        this.amend = false;
      }
      return result;
    });
  }

  push(): void {
    void this.perform(() => window.dotforge.git.push());
  }

  pull(): void {
    void this.perform(() => window.dotforge.git.pull(), { reloadSolution: true });
  }

  sync(): void {
    void this.perform(() => window.dotforge.git.sync(), { reloadSolution: true });
  }

  private checkout(branch: string): void {
    this.branchMenuOpen = false;
    void this.perform(() => window.dotforge.git.checkout(branch), { reloadSolution: true });
  }

  private createBranch(): void {
    this.branchMenuOpen = false;

    const name = window.prompt('Nombre de la rama nueva (git checkout -b):', 'feature/');
    if (name === null) return;

    if (!isValidBranchName(name)) {
      this.host.notify('Ese nombre de rama no es válido: sin espacios ni ~ ^ : ? * [ \\ ni "..".', 'warn');
      return;
    }

    void this.perform(() => window.dotforge.git.createBranch(name.trim()), { reloadSolution: true });
  }

  /**
   * Ruta absoluta de un cambio.
   *
   * `git status` da las rutas relativas a la raíz del repositorio, que no tiene por qué coincidir
   * con la carpeta abierta: en un monorepo, abrir `apps/api` deja la raíz dos niveles más arriba.
   * Por eso la raíz viaja dentro del estado y no se adivina aquí.
   */
  private absolutePathOf(path: string): string {
    const root = this.status?.root;
    return root ? `${root}/${path}` : path;
  }

  /** Abre la comparación del archivo en el editor de diferencias. */
  private async openDiff(change: GitFileChange): Promise<void> {
    try {
      const diff = await window.dotforge.git.fileDiff(buildDiffRequest(change));
      this.host.openDiff(diff);
    } catch (error) {
      this.host.notify(
        `No se ha podido abrir la comparación: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }

  // --- Render ----------------------------------------------------------------------------------

  render(): void {
    if (!this.visible) return;

    const container = byId('sidebar-content');
    clear(container);
    byId('sidebar-title').textContent = 'Control de código fuente';

    const actions = byId('sidebar-actions');
    clear(actions);
    actions.appendChild(
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Actualizar el estado del repositorio',
          on: { click: () => void this.refresh() },
        },
        icon('refresh', { size: 14 }),
      ),
    );

    if (!this.repositoryDetected || !this.status) {
      container.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          icon('source-control', { size: 30, className: 'empty-state-icon' }),
          el('p', { text: 'Esta carpeta no es un repositorio de git' }),
          el('p', {
            className: 'empty-state-hint',
            text: 'Ejecuta "git init" en la terminal integrada para empezar a versionar la solución.',
          }),
        ),
      );
      return;
    }

    const body = el('div', { className: 'git-panel' });
    body.append(this.renderBranchBar(), this.renderCommitBox(), this.renderActions());

    const sections = el('div', { className: 'git-sections' });
    sections.append(
      this.renderSection('staged', this.status.staged),
      this.renderSection('unstaged', this.status.unstaged),
    );

    if (this.status.staged.length === 0 && this.status.unstaged.length === 0) {
      sections.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          icon('check', { size: 26, className: 'empty-state-icon' }),
          el('p', { text: 'No hay cambios pendientes' }),
          el('p', { className: 'empty-state-hint', text: 'El árbol de trabajo está limpio.' }),
        ),
      );
    }

    body.appendChild(sections);
    container.appendChild(body);
  }

  /** Cabecera: rama activa, indicador de adelanto/retraso y menú de ramas. */
  private renderBranchBar(): HTMLElement {
    const status = this.status;
    const sync = status ? syncSummary(status) : null;

    const button = el(
      'button',
      {
        className: `git-branch-picker${this.branchMenuOpen ? ' open' : ''}`,
        title: status?.detached === true
          ? 'HEAD desprendido: crea una rama para poder confirmar con seguridad'
          : `Cambiar de rama · ${sync?.title ?? ''}`,
        attrs: { 'aria-haspopup': 'listbox', 'aria-expanded': String(this.branchMenuOpen) },
        on: {
          click: (event) => {
            event.stopPropagation();
            this.toggleBranchMenu();
          },
        },
      },
      icon('git-branch', { size: 14, className: 'git-branch-icon' }),
      el('span', { className: 'git-branch-name', text: status?.branch ?? 'sin rama' }),
      sync && sync.label !== ''
        ? el('span', { className: 'git-sync-count', text: sync.label })
        : null,
      icon('chevron-down', { size: 12, className: 'git-branch-caret' }),
    );

    const wrapper = el('div', { className: 'git-branch-bar' }, button);
    if (this.branchMenuOpen) wrapper.appendChild(this.renderBranchMenu());

    if (status && !status.hasCommits) {
      wrapper.appendChild(
        el('p', { className: 'git-note', text: 'Todavía no hay ningún commit en este repositorio.' }),
      );
    }

    return wrapper;
  }

  private toggleBranchMenu(): void {
    this.branchMenuOpen = !this.branchMenuOpen;
    this.render();

    if (this.branchMenuOpen) {
      // Un clic en cualquier otro sitio cierra el menú. `once` evita acumular listeners.
      setTimeout(() => {
        document.addEventListener(
          'click',
          () => {
            this.branchMenuOpen = false;
            this.render();
          },
          { once: true },
        );
      }, 0);
    }
  }

  private renderBranchMenu(): HTMLElement {
    const menu = el('div', { className: 'git-branch-menu', role: 'listbox' });
    const active = this.status?.branch ?? null;

    const locals = this.branches.filter((branch) => !branch.startsWith('origin/'));
    const remotes = this.branches.filter((branch) => branch.startsWith('origin/'));

    const item = (branch: string): HTMLElement =>
      el(
        'button',
        {
          className: `git-branch-item${branch === active ? ' active' : ''}`,
          role: 'option',
          on: {
            click: (event) => {
              event.stopPropagation();
              if (branch !== active) this.checkout(branch);
              else this.branchMenuOpen = false;
            },
          },
        },
        icon('git-branch', { size: 13, className: 'git-branch-item-icon' }),
        el('span', { text: branch }),
        branch === active ? icon('check', { size: 13, className: 'git-branch-check' }) : null,
      );

    menu.append(
      el(
        'button',
        {
          className: 'git-branch-item action',
          on: {
            click: (event) => {
              event.stopPropagation();
              this.createBranch();
            },
          },
        },
        icon('plus', { size: 13 }),
        el('span', { text: 'Crear una rama nueva…' }),
      ),
      el('div', { className: 'git-menu-sep' }),
    );

    if (locals.length > 0) {
      menu.appendChild(el('div', { className: 'git-menu-title', text: 'Locales' }));
      for (const branch of locals) menu.appendChild(item(branch));
    }

    if (remotes.length > 0) {
      menu.appendChild(el('div', { className: 'git-menu-title', text: 'Remotas' }));
      for (const branch of remotes) menu.appendChild(item(branch));
    }

    return menu;
  }

  /**
   * Caja del mensaje.
   *
   * `Ctrl/Cmd+Enter` confirma sin tocar el ratón, que es el gesto que espera cualquiera que haya
   * usado otro cliente. Enter a secas inserta un salto de línea: un mensaje de commit tiene un
   * cuerpo, no sólo un titular.
   */
  private renderCommitBox(): HTMLElement {
    const input = el('textarea', {
      className: 'git-commit-input',
      placeholder: 'Mensaje del commit (Ctrl+Enter para confirmar)',
      attrs: { rows: '3', spellcheck: 'false', 'aria-label': 'Mensaje del commit' },
    }) as HTMLTextAreaElement;

    input.value = this.message;

    input.addEventListener('input', () => {
      this.message = input.value;
    });

    input.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        this.message = input.value;
        this.commit();
      }
    });

    return el('div', { className: 'git-commit-box' }, input);
  }

  private renderActions(): HTMLElement {
    const status = this.status;
    const sync = status ? syncSummary(status) : null;
    const staged = status?.staged.length ?? 0;

    const button = (
      label: string,
      iconName: IconName,
      title: string,
      onClick: () => void,
      options: { primary?: boolean; disabled?: boolean; badge?: string } = {},
    ): HTMLElement =>
      el(
        'button',
        {
          className: `btn ${options.primary === true ? 'primary' : 'ghost'} small git-action`,
          title,
          disabled: this.busy || options.disabled === true,
          on: { click: onClick },
        },
        icon(iconName, { size: 13 }),
        el('span', { text: label }),
        options.badge ? el('span', { className: 'git-action-badge', text: options.badge }) : null,
      );

    const row = el('div', { className: 'git-actions' });

    row.append(
      button(
        this.amend ? 'Rehacer commit' : 'Commit',
        'git-commit',
        staged === 0
          ? 'No hay nada preparado: prepara algún archivo o usa el + de la sección "Cambios".'
          : `Confirmar ${staged} archivo(s) preparado(s) (Ctrl+Enter)`,
        () => this.commit(),
        { primary: true, disabled: staged === 0 && !this.amend },
      ),
      button('Push', 'upload', sync?.title ?? 'Publicar en el remoto', () => this.push(), {
        disabled: sync?.canPush === false,
        ...(status && status.ahead > 0 ? { badge: `↑${status.ahead}` } : {}),
      }),
      button('Pull', 'download', 'Traer los cambios del remoto (--ff-only)', () => this.pull(), {
        disabled: sync?.canPull === false,
        ...(status && status.behind > 0 ? { badge: `↓${status.behind}` } : {}),
      }),
      button('Sync', 'refresh', 'Traer y luego publicar', () => this.sync(), {
        disabled: sync?.canPull === false,
        ...(sync && sync.label !== '' ? { badge: sync.label } : {}),
      }),
    );

    const amendToggle = el(
      'label',
      { className: 'git-amend', title: 'Rehacer el último commit en vez de crear uno nuevo (git commit --amend)' },
      (() => {
        const check = el('input', { type: 'checkbox' }) as HTMLInputElement;
        check.checked = this.amend;
        check.disabled = this.busy || this.status?.hasCommits === false;
        check.addEventListener('change', () => {
          this.amend = check.checked;
          this.render();
        });
        return check;
      })(),
      el('span', { text: 'Enmendar el último commit' }),
    );

    return el('div', { className: 'git-action-block' }, row, amendToggle);
  }

  private renderSection(section: Section, changes: GitFileChange[]): HTMLElement {
    const container = el('section', { className: 'git-section' });
    const collapsed = this.collapsed[section];

    const header = el(
      'div',
      { className: 'git-section-header' },
      el(
        'button',
        {
          className: 'git-section-toggle',
          attrs: { 'aria-expanded': String(!collapsed) },
          on: {
            click: () => {
              this.collapsed[section] = !collapsed;
              this.render();
            },
          },
        },
        icon(collapsed ? 'chevron-right' : 'chevron-down', { size: 13 }),
        el('span', { className: 'git-section-title', text: SECTION_TITLE[section] }),
        el('span', { className: 'git-section-count', text: String(changes.length) }),
      ),
    );

    if (changes.length > 0) {
      const bulk = el('div', { className: 'git-section-actions' });

      if (section === 'unstaged') {
        bulk.append(
          this.iconAction('undo', 'Descartar todos los cambios', () => void this.discard(changes)),
          this.iconAction('plus', 'Preparar todos los cambios', () =>
            this.stage(changes.map((change) => change.path)),
          ),
        );
      } else {
        bulk.appendChild(
          this.iconAction('minus', 'Quitar todo de preparados', () =>
            this.unstage(changes.map((change) => change.path)),
          ),
        );
      }

      header.appendChild(bulk);
    }

    container.appendChild(header);
    if (collapsed) return container;

    for (const change of changes) container.appendChild(this.renderRow(change));

    return container;
  }

  private iconAction(name: IconName, title: string, onClick: () => void): HTMLElement {
    return el(
      'button',
      {
        className: 'icon-btn small',
        title,
        disabled: this.busy,
        on: {
          click: (event) => {
            event.stopPropagation();
            onClick();
          },
        },
      },
      icon(name, { size: 13 }),
    );
  }

  /**
   * Fila de archivo.
   *
   * Un clic abre la comparación —que es lo que uno quiere ver el 90% de las veces— y un doble
   * clic abre el archivo real para editarlo. Las acciones aparecen al pasar el ratón y no ocupan
   * sitio mientras tanto, pero **existen siempre en el DOM**: si aparecieran sólo al hacer hover
   * no serían alcanzables con el teclado.
   */
  private renderRow(change: GitFileChange): HTMLElement {
    const actions = el('div', { className: 'git-row-actions' });

    if (change.area === 'staged') {
      actions.appendChild(this.iconAction('minus', 'Quitar de preparados', () => this.unstage([change.path])));
    } else {
      actions.append(
        this.iconAction('undo', 'Descartar los cambios de este archivo', () => void this.discard([change])),
        this.iconAction('plus', 'Preparar este archivo', () => this.stage([change.path])),
      );
    }

    return el(
      'div',
      {
        className: `git-row${change.conflicted ? ' conflicted' : ''}`,
        title: `${change.description} · ${change.path}`,
        on: {
          click: () => void this.openDiff(change),
          dblclick: () => this.host.openFile(this.absolutePathOf(change.path)),
        },
      },
      el('span', { className: 'git-row-name', text: change.name }),
      el('span', { className: 'git-row-dir', text: change.directory }),
      actions,
      el('span', {
        className: `git-letter letter-${change.letter === '!' ? 'conflict' : change.letter}`,
        text: change.letter,
        title: describeLetter(change.letter),
      }),
    );
  }
}
