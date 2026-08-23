/**
 * Asistente visual de generación de arquitecturas.
 *
 * Tres pasos: elegir arquitectura, configurar y revisar. Llama al mismo generador que la CLI, así
 * que lo que aquí se ve es exactamente lo que producen los tests.
 *
 * Rediseño: cada arquitectura es una tarjeta con icono, una frase que la resume y el **diagrama
 * de sus capas** con flechas. Ese diagrama comunica la forma de la arquitectura mejor que
 * cualquier párrafo, y es lo que permite elegir sin haber leído la documentación.
 */
import type {
  ArchitectureId,
  BlueprintInfo,
  DbProvider,
  FrameworkMoniker,
  ScaffoldOptions,
  ScaffoldResult,
  UiTarget,
} from '../../shared/scaffold-types.js';
import { byId, clear, el, formatBytes } from '../dom.js';
import { presentProject } from '../file-icons.js';
import { icon, type IconName } from '../icons.js';

export interface WizardHost {
  openWorkspace(path: string): void;
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
}

type Step = 'architecture' | 'configure' | 'result';

interface FormState {
  architecture: ArchitectureId | null;
  solutionName: string;
  outputDir: string;
  ui: UiTarget;
  framework: FrameworkMoniker;
  db: DbProvider;
  entity: string;
  includeTests: boolean;
  gitInit: boolean;
  force: boolean;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const ENTITY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/** Icono que representa cada arquitectura en su tarjeta. */
const ARCHITECTURE_ICON: Record<ArchitectureId, IconName> = {
  clean: 'solution',
  hexagonal: 'hexagon',
  ddd: 'puzzle',
};

const STEP_LABELS: Record<Step, string> = {
  architecture: 'Arquitectura',
  configure: 'Configuración',
  result: 'Resultado',
};

export class WizardView {
  private blueprints: BlueprintInfo[] = [];
  private step: Step = 'architecture';
  private busy = false;
  private result: ScaffoldResult | null = null;
  private error: string | null = null;

  private form: FormState = {
    architecture: null,
    solutionName: 'Acme.Shop',
    outputDir: '',
    ui: 'both',
    framework: 'net9.0',
    db: 'sqlite',
    entity: 'Product',
    includeTests: true,
    gitInit: false,
    force: false,
  };

  constructor(private readonly host: WizardHost) {}

  async open(): Promise<void> {
    if (this.blueprints.length === 0) {
      this.blueprints = await window.dotforge.scaffold.list();
    }

    this.step = 'architecture';
    this.result = null;
    this.error = null;
    this.busy = false;
    this.render();
  }

  close(): void {
    const overlay = byId('overlay');
    overlay.hidden = true;
    overlay.className = 'overlay';
    clear(overlay);
  }

  private validationErrors(): string[] {
    const problems: string[] = [];

    if (!NAME_PATTERN.test(this.form.solutionName.trim())) {
      problems.push('El nombre debe ser un identificador válido, opcionalmente con puntos (Acme.Shop).');
    }
    if (!ENTITY_PATTERN.test(this.form.entity.trim())) {
      problems.push('La entidad debe empezar por letra y contener sólo letras y dígitos.');
    }
    if (this.form.outputDir.trim() === '') {
      problems.push('Elige el directorio de destino.');
    }

    return problems;
  }

  // --- Render -----------------------------------------------------------------------------------

  private render(): void {
    const overlay = byId('overlay');
    overlay.hidden = false;
    overlay.className = 'overlay center';
    clear(overlay);

    const dialog = el('div', { className: 'dialog', role: 'dialog' });
    dialog.append(this.renderHeader(), this.renderBody(), this.renderFooter());
    overlay.appendChild(dialog);

    overlay.onkeydown = (event) => {
      if (event.key === 'Escape' && !this.busy) this.close();
    };

    dialog.querySelector<HTMLElement>('input, button.arch-card')?.focus();
  }

  private renderHeader(): HTMLElement {
    const subtitles: Record<Step, string> = {
      architecture: 'Elige la arquitectura de referencia',
      configure: 'Ajusta cómo se va a generar la solución',
      result: 'Todo listo para compilar y ejecutar',
    };

    return el(
      'div',
      { className: 'dialog-header' },
      el('span', { className: 'dialog-mark' }, icon(this.step === 'result' ? 'check' : 'wand', { size: 20 })),
      el(
        'div',
        { style: { minWidth: '0' } },
        el('h2', { text: this.step === 'result' ? 'Solución generada' : 'Nueva solución' }),
        el('p', { text: subtitles[this.step] }),
      ),
      el('span', { className: 'spacer' }),
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Cerrar',
          disabled: this.busy,
          on: { click: () => this.close() },
        },
        icon('x', { size: 16 }),
      ),
    );
  }

  private renderBody(): HTMLElement {
    const body = el('div', { className: 'dialog-body' });

    if (this.error) {
      body.appendChild(
        el(
          'div',
          { className: 'notice error' },
          icon('alert-circle', { size: 15 }),
          el('span', { text: this.error }),
        ),
      );
    }

    switch (this.step) {
      case 'architecture':
        body.appendChild(this.renderArchitectureStep());
        break;
      case 'configure':
        body.appendChild(this.renderConfigureStep());
        break;
      case 'result':
        body.appendChild(this.renderResultStep());
        break;
    }

    return body;
  }

  // --- Paso 1: arquitectura -----------------------------------------------------------------------

  private renderArchitectureStep(): HTMLElement {
    const container = el('div');
    const grid = el('div', { className: 'arch-grid' });

    for (const blueprint of this.blueprints) {
      const selected = this.form.architecture === blueprint.id;

      grid.appendChild(
        el(
          'button',
          {
            className: `arch-card${selected ? ' selected' : ''}`,
            on: {
              click: () => {
                this.form.architecture = blueprint.id;
                this.render();
              },
              // Doble clic: elegir y avanzar. Ahorra un viaje al botón "Siguiente".
              dblclick: () => {
                this.form.architecture = blueprint.id;
                this.step = 'configure';
                this.render();
              },
            },
          },
          el(
            'div',
            { className: 'arch-card-head' },
            el('span', { className: 'arch-card-mark' }, icon(ARCHITECTURE_ICON[blueprint.id], { size: 19 })),
            el('div', { style: { minWidth: '0' } }, el('h3', { text: blueprint.title })),
          ),
          el('p', { className: 'tagline', text: blueprint.tagline }),
          this.renderLayerDiagram(blueprint),
        ),
      );
    }

    container.appendChild(grid);

    const chosen = this.blueprints.find((blueprint) => blueprint.id === this.form.architecture);
    if (chosen) container.appendChild(this.renderArchitectureDetail(chosen));

    return container;
  }

  /** Diagrama de capas: `Domain → Application → Infrastructure → UI`. */
  private renderLayerDiagram(blueprint: BlueprintInfo): HTMLElement {
    const diagram = el('div', { className: 'arch-layers' });

    // La flecha va dentro del mismo grupo que la capa que precede, para que al envolverse la
    // línea no quede una flecha suelta apuntando al vacío.
    blueprint.layers.forEach((layer, index) => {
      diagram.appendChild(
        el(
          'span',
          { className: 'arch-layer-group' },
          index > 0 ? el('span', { className: 'arch-arrow' }, icon('chevron-right', { size: 11 })) : null,
          el('span', { className: 'arch-layer', text: layer.name }),
        ),
      );
    });

    return diagram;
  }

  private renderArchitectureDetail(blueprint: BlueprintInfo): HTMLElement {
    const detail = el('div', { className: 'arch-detail' });

    detail.append(
      el('h4', { text: 'Qué es' }),
      el('p', { text: blueprint.description }),
      el('h4', { text: 'Qué incluye la solución generada' }),
    );

    const list = el('ul', { className: 'feature-list' });
    for (const highlight of blueprint.highlights) {
      list.appendChild(el('li', {}, icon('check', { size: 13 }), el('span', { text: highlight })));
    }
    detail.appendChild(list);

    detail.appendChild(el('h4', { text: 'Patrones aplicados' }));

    const chips = el('div', { className: 'chip-row' });
    for (const pattern of blueprint.patterns) {
      chips.appendChild(el('span', { className: 'chip accent', text: pattern }));
    }
    detail.appendChild(chips);

    return detail;
  }

  // --- Paso 2: configuración -----------------------------------------------------------------------

  private renderConfigureStep(): HTMLElement {
    const container = el('div');
    const problems = this.validationErrors();

    const textField = (
      label: string,
      value: string,
      help: string,
      onChange: (value: string) => void,
    ): HTMLElement =>
      el(
        'div',
        { className: 'field' },
        el('label', { text: label }),
        el('input', {
          className: 'input',
          value,
          on: {
            input: (event) => {
              onChange((event.target as HTMLInputElement).value);
              this.refreshFooter();
              this.refreshDestinationHint();
            },
          },
        }),
        el('span', { className: 'help', text: help }),
      );

    const segmented = <T extends string>(
      label: string,
      options: Array<[value: T, text: string, iconName?: IconName]>,
      current: T,
      help: string,
      onChange: (value: T) => void,
    ): HTMLElement =>
      el(
        'div',
        { className: 'field' },
        el('label', { text: label }),
        el(
          'div',
          { className: 'segmented' },
          ...options.map(([value, text, iconName]) =>
            el(
              'button',
              {
                className: value === current ? 'active' : '',
                on: {
                  click: () => {
                    onChange(value);
                    this.render();
                  },
                },
              },
              iconName ? icon(iconName, { size: 13 }) : null,
              text,
            ),
          ),
        ),
        el('span', { className: 'help', text: help }),
      );

    container.appendChild(
      el(
        'div',
        { className: 'field-grid' },
        textField('Nombre de la solución', this.form.solutionName, 'Prefijo de todos los proyectos.', (value) => {
          this.form.solutionName = value;
        }),
        textField('Entidad de ejemplo', this.form.entity, 'El CRUD generado girará en torno a ella.', (value) => {
          this.form.entity = value;
        }),
        segmented<UiTarget>(
          'Presentación',
          [
            ['webapi', 'Web API', 'route'],
            ['blazor', 'Blazor', 'razor'],
            ['both', 'Ambas', 'puzzle'],
          ],
          this.form.ui,
          'Qué proyectos de interfaz se generan.',
          (value) => {
            this.form.ui = value;
          },
        ),
        segmented<FrameworkMoniker>(
          'Framework',
          [
            ['net9.0', '.NET 9'],
            ['net10.0', '.NET 10'],
          ],
          this.form.framework,
          'Determina también las versiones de los paquetes.',
          (value) => {
            this.form.framework = value;
          },
        ),
        segmented<DbProvider>(
          'Persistencia',
          [
            ['sqlite', 'SQLite', 'database'],
            ['inmemory', 'En memoria', 'zap'],
          ],
          this.form.db,
          'Proveedor de EF Core preconfigurado.',
          (value) => {
            this.form.db = value;
          },
        ),
      ),
    );

    // --- Destino ----------------------------------------------------------------------------
    container.appendChild(
      el(
        'div',
        { className: 'field', style: { marginTop: '18px' } },
        el('label', { text: 'Directorio de destino' }),
        el(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          el('input', {
            className: 'input',
            value: this.form.outputDir,
            placeholder: 'Elige una carpeta…',
            on: {
              input: (event) => {
                this.form.outputDir = (event.target as HTMLInputElement).value;
                this.refreshFooter();
                this.refreshDestinationHint();
              },
            },
          }),
          el(
            'button',
            {
              className: 'btn',
              on: {
                click: () => {
                  void window.dotforge.scaffold.pickOutputDir().then((directory) => {
                    if (directory) {
                      this.form.outputDir = directory;
                      this.render();
                    }
                  });
                },
              },
            },
            icon('folder-open', { size: 14 }),
            'Examinar',
          ),
        ),
        el('span', { className: 'help', id: 'wizard-destination', text: this.destinationHint() }),
      ),
    );

    container.appendChild(
      el(
        'div',
        { style: { display: 'flex', gap: '22px', marginTop: '18px', flexWrap: 'wrap' } },
        this.checkbox('Incluir proyecto de pruebas', this.form.includeTests, (value) => {
          this.form.includeTests = value;
        }),
        this.checkbox('Inicializar repositorio git', this.form.gitInit, (value) => {
          this.form.gitInit = value;
        }),
        this.checkbox('Sobrescribir si ya existe', this.form.force, (value) => {
          this.form.force = value;
        }),
      ),
    );

    if (problems.length > 0) {
      container.appendChild(
        el(
          'div',
          { className: 'notice warn', style: { marginTop: '18px' } },
          icon('alert-triangle', { size: 15 }),
          el('div', {}, ...problems.map((problem) => el('div', { text: problem }))),
        ),
      );
    }

    return container;
  }

  private destinationHint(): string {
    const separator = navigator.platform.toLowerCase().includes('win') ? '\\' : '/';
    return this.form.outputDir
      ? `Se creará ${this.form.outputDir}${separator}${this.form.solutionName || '…'}`
      : 'La solución se creará en una subcarpeta con su nombre.';
  }

  private refreshDestinationHint(): void {
    const hint = document.getElementById('wizard-destination');
    if (hint) hint.textContent = this.destinationHint();
  }

  private checkbox(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
    const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = checked;
    input.addEventListener('change', () => {
      onChange(input.checked);
      this.refreshFooter();
    });
    return el('label', { className: 'checkbox' }, input, label);
  }

  // --- Paso 3: resultado -----------------------------------------------------------------------------

  private renderResultStep(): HTMLElement {
    const result = this.result;
    if (!result) return el('div', { className: 'empty-state', text: 'Sin resultado.' });

    const container = el('div');

    container.appendChild(
      el(
        'div',
        { className: 'notice ok' },
        icon('check', { size: 15 }),
        el(
          'div',
          { className: 'result-summary' },
          el('strong', { text: `${result.solutionName} generada` }),
          el('span', {
            text: `${result.projects.length} proyectos · ${result.files.length} archivos · ${formatBytes(result.totalBytes)} · ${result.durationMs} ms`,
          }),
        ),
      ),
    );

    container.appendChild(el('h4', { className: 'section-title', text: 'Proyectos creados' }));

    const tree = el('div', { className: 'tree' });
    for (const project of result.projects) {
      // La insignia se deduce del nombre: el resultado del generador no lleva el tipo, pero el
      // sufijo del proyecto es suficiente para acertar en la abrumadora mayoría de los casos.
      const presentation = presentProject(
        /UnitTests$|Tests$/.test(project.name)
          ? 'tests'
          : /Blazor$/.test(project.name)
            ? 'blazor-server'
            : /WebApi$|Adapters\.Web$/.test(project.name)
              ? 'webapi'
              : 'library',
      );

      tree.appendChild(
        el(
          'div',
          { className: 'tree-row', style: { cursor: 'default' } },
          el('span', { className: 'tree-guides' }),
          el('span', { className: 'tree-twisty' }),
          icon(presentation.icon, { size: 15, className: `tree-icon tone-${presentation.tone}` }),
          el('span', { className: 'tree-label', text: project.name }),
          el('span', { className: `tree-badge tone-${presentation.tone}`, text: presentation.badge }),
          el('span', { className: 'tree-hint', text: project.layer }),
        ),
      );
    }
    container.appendChild(tree);

    if (result.warnings.length > 0) {
      container.appendChild(
        el(
          'div',
          { className: 'notice warn', style: { marginTop: '16px' } },
          icon('alert-triangle', { size: 15 }),
          el('div', {}, ...result.warnings.map((warning) => el('div', { text: warning }))),
        ),
      );
    }

    container.appendChild(
      el('h4', { className: 'section-title', style: { marginTop: '18px' }, text: 'Siguientes pasos' }),
    );

    const steps = el('pre', {
      className: 'output',
      style: { background: 'var(--bg)', borderRadius: 'var(--radius-sm)', marginTop: '8px' },
    });
    for (const step of result.nextSteps) {
      steps.appendChild(el('div', { className: 'line-cmd', text: `❯ ${step}` }));
    }
    container.appendChild(steps);

    return container;
  }

  // --- Pie ---------------------------------------------------------------------------------------------

  private renderFooter(): HTMLElement {
    const footer = el('div', { className: 'dialog-footer', id: 'wizard-footer' });
    footer.append(this.renderSteps(), this.renderActions());
    return footer;
  }

  /** Repinta sólo el pie: evita perder el foco del campo que se está escribiendo. */
  private refreshFooter(): void {
    const footer = document.getElementById('wizard-footer');
    if (!footer) return;
    clear(footer);
    footer.append(this.renderSteps(), this.renderActions());
  }

  private renderSteps(): HTMLElement {
    const order: Step[] = ['architecture', 'configure', 'result'];
    const currentIndex = order.indexOf(this.step);

    const steps = el('div', { className: 'steps' });

    order.forEach((step, index) => {
      if (index > 0) steps.appendChild(el('span', { className: 'step-line' }));

      const state = index === currentIndex ? 'active' : index < currentIndex ? 'done' : '';

      steps.appendChild(
        el(
          'span',
          { className: `step ${state}`.trim() },
          el(
            'span',
            { className: 'step-dot' },
            index < currentIndex ? icon('check', { size: 11 }) : el('span', { text: String(index + 1) }),
          ),
          el('span', { text: STEP_LABELS[step] }),
        ),
      );
    });

    return steps;
  }

  private renderActions(): HTMLElement {
    const actions = el('div', { style: { display: 'flex', gap: '8px' } });

    if (this.step === 'architecture') {
      actions.append(
        el('button', { className: 'btn', text: 'Cancelar', on: { click: () => this.close() } }),
        el(
          'button',
          {
            className: 'btn primary',
            disabled: this.form.architecture === null,
            on: {
              click: () => {
                this.step = 'configure';
                this.render();
              },
            },
          },
          'Siguiente',
          icon('chevron-right', { size: 14 }),
        ),
      );
      return actions;
    }

    if (this.step === 'configure') {
      actions.append(
        el(
          'button',
          {
            className: 'btn',
            disabled: this.busy,
            on: {
              click: () => {
                this.step = 'architecture';
                this.render();
              },
            },
          },
          icon('chevron-left', { size: 14 }),
          'Atrás',
        ),
        el(
          'button',
          {
            className: 'btn primary',
            disabled: this.busy || this.validationErrors().length > 0,
            on: { click: () => void this.generate() },
          },
          this.busy ? el('span', { className: 'spinner' }) : icon('wand', { size: 14 }),
          this.busy ? 'Generando…' : 'Generar solución',
        ),
      );
      return actions;
    }

    actions.append(
      el('button', { className: 'btn', text: 'Cerrar', on: { click: () => this.close() } }),
      el(
        'button',
        {
          className: 'btn primary',
          on: {
            click: () => {
              const path = this.result?.rootDir;
              this.close();
              if (path) this.host.openWorkspace(path);
            },
          },
        },
        icon('folder-open', { size: 14 }),
        'Abrir la solución',
      ),
    );

    return actions;
  }

  private async generate(): Promise<void> {
    this.busy = true;
    this.error = null;
    this.refreshFooter();

    const options: ScaffoldOptions = {
      architecture: this.form.architecture!,
      solutionName: this.form.solutionName.trim(),
      outputDir: this.form.outputDir.trim(),
      ui: this.form.ui,
      framework: this.form.framework,
      db: this.form.db,
      entity: this.form.entity.trim(),
      includeTests: this.form.includeTests,
      force: this.form.force,
      gitInit: this.form.gitInit,
    };

    try {
      this.result = await window.dotforge.scaffold.generate(options);
      this.step = 'result';
      this.host.notify(`Solución ${this.result.solutionName} generada.`, 'ok');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      this.error = raw.replace(/^Error invoking remote method '[^']+':\s*/, '');
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
