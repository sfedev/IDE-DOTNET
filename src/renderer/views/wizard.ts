/**
 * Asistente visual de generación de arquitecturas.
 *
 * Tres pasos: elegir arquitectura, configurar la solución y revisar el resultado. Llama al mismo
 * generador que la CLI, así que lo que aquí se ve es exactamente lo que producen los tests.
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
      problems.push('El nombre de la solución debe ser un identificador válido, opcionalmente con puntos (Acme.Shop).');
    }
    if (!ENTITY_PATTERN.test(this.form.entity.trim())) {
      problems.push('La entidad debe empezar por letra y contener sólo letras y dígitos.');
    }
    if (this.form.outputDir.trim() === '') {
      problems.push('Elige el directorio de destino.');
    }

    return problems;
  }

  private render(): void {
    const overlay = byId('overlay');
    overlay.hidden = false;
    overlay.className = 'overlay center';
    clear(overlay);

    const dialog = el('div', { className: 'dialog', role: 'dialog' });

    dialog.appendChild(this.renderHeader());
    dialog.appendChild(this.renderBody());
    dialog.appendChild(this.renderFooter());

    overlay.appendChild(dialog);

    // Cerrar con Escape mientras no haya una generación en curso.
    overlay.onkeydown = (event) => {
      if (event.key === 'Escape' && !this.busy) this.close();
    };

    const firstInput = dialog.querySelector<HTMLElement>('input, button.arch-card');
    firstInput?.focus();
  }

  private renderHeader(): HTMLElement {
    const titles: Record<Step, [string, string]> = {
      architecture: ['Nueva solución', 'Elige la arquitectura de referencia'],
      configure: ['Nueva solución', 'Configura la solución que se va a generar'],
      result: ['Solución generada', 'Todo listo para compilar y ejecutar'],
    };

    const [title, subtitle] = titles[this.step];

    return el(
      'div',
      { className: 'dialog-header' },
      el('div', {}, el('h2', { text: title }), el('p', { text: subtitle })),
      el('button', {
        className: 'icon-btn',
        text: '✕',
        title: 'Cerrar',
        disabled: this.busy,
        on: { click: () => this.close() },
      }),
    );
  }

  private renderBody(): HTMLElement {
    const body = el('div', { className: 'dialog-body' });

    if (this.error) {
      body.appendChild(el('div', { className: 'notice error', text: this.error }));
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

  private renderArchitectureStep(): HTMLElement {
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
              dblclick: () => {
                this.form.architecture = blueprint.id;
                this.step = 'configure';
                this.render();
              },
            },
          },
          el('h3', { text: blueprint.title }),
          el('div', { className: 'tagline', text: blueprint.tagline }),
          el(
            'div',
            { className: 'arch-layers' },
            ...blueprint.layers.map((layer) => el('span', { className: 'chip', text: layer.name })),
          ),
        ),
      );
    }

    const container = el('div', {}, grid);

    const chosen = this.blueprints.find((blueprint) => blueprint.id === this.form.architecture);
    if (chosen) {
      container.appendChild(
        el(
          'div',
          { style: { marginTop: '18px' } },
          el('p', { className: 'help', text: chosen.description, style: { color: 'var(--text-muted)' } }),
          el('h3', { text: 'Qué incluye', style: { fontSize: '12px', marginBottom: '6px' } }),
          el('ul', { className: 'result-list' }, ...chosen.highlights.map((item) => el('li', { text: item }))),
          el('h3', { text: 'Patrones aplicados', style: { fontSize: '12px', margin: '12px 0 6px' } }),
          el(
            'div',
            { className: 'arch-layers' },
            ...chosen.patterns.map((pattern) => el('span', { className: 'chip accent', text: pattern })),
          ),
        ),
      );
    }

    return container;
  }

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
            },
          },
        }),
        el('span', { className: 'help', text: help }),
      );

    const segmented = <T extends string>(
      label: string,
      options: Array<[T, string]>,
      current: T,
      onChange: (value: T) => void,
    ): HTMLElement =>
      el(
        'div',
        { className: 'field' },
        el('label', { text: label }),
        el(
          'div',
          { className: 'segmented' },
          ...options.map(([value, text]) =>
            el('button', {
              className: value === current ? 'active' : '',
              text,
              on: {
                click: () => {
                  onChange(value);
                  this.render();
                },
              },
            }),
          ),
        ),
      );

    const grid = el(
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
          ['webapi', 'Web API'],
          ['blazor', 'Blazor'],
          ['both', 'Ambas'],
        ],
        this.form.ui,
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
        (value) => {
          this.form.framework = value;
        },
      ),
      segmented<DbProvider>(
        'Persistencia',
        [
          ['sqlite', 'SQLite'],
          ['inmemory', 'En memoria'],
        ],
        this.form.db,
        (value) => {
          this.form.db = value;
        },
      ),
    );

    container.appendChild(grid);

    // Destino
    container.appendChild(
      el(
        'div',
        { className: 'field', style: { marginTop: '14px' } },
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
              },
            },
          }),
          el('button', {
            className: 'btn',
            text: 'Examinar…',
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
          }),
        ),
        el('span', {
          className: 'help',
          text: this.form.outputDir
            ? `Se creará ${this.form.outputDir}${this.pathSeparator()}${this.form.solutionName || '…'}`
            : 'La solución se creará en una subcarpeta con su nombre.',
        }),
      ),
    );

    container.appendChild(
      el(
        'div',
        { style: { display: 'flex', gap: '18px', marginTop: '14px', flexWrap: 'wrap' } },
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
          { className: 'notice warn', style: { marginTop: '14px' } },
          ...problems.map((problem) => el('div', { text: problem })),
        ),
      );
    }

    return container;
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

  private renderResultStep(): HTMLElement {
    const result = this.result;
    if (!result) return el('div', { className: 'empty-state', text: 'Sin resultado.' });

    const container = el(
      'div',
      {},
      el('div', {
        className: 'notice ok',
        text: `${result.solutionName} generada: ${result.files.length} archivos (${formatBytes(result.totalBytes)}) en ${result.durationMs} ms.`,
      }),
      el('h3', { text: 'Proyectos', style: { fontSize: '12px', margin: '4px 0 6px' } }),
    );

    const table = el('div', { className: 'tree' });
    for (const project of result.projects) {
      table.appendChild(
        el(
          'div',
          { className: 'tree-row', style: { cursor: 'default' } },
          el('span', { className: 'glyph csproj', text: '⬡' }),
          el('span', { className: 'label', text: project.name }),
          el('span', { className: 'hint', text: project.layer }),
        ),
      );
    }
    container.appendChild(table);

    if (result.warnings.length > 0) {
      container.appendChild(
        el('div', { className: 'notice warn' }, ...result.warnings.map((warning) => el('div', { text: warning }))),
      );
    }

    container.appendChild(el('h3', { text: 'Siguientes pasos', style: { fontSize: '12px', margin: '14px 0 6px' } }));
    const steps = el('pre', { className: 'output', style: { background: 'var(--bg)', borderRadius: 'var(--radius-sm)' } });
    for (const step of result.nextSteps) {
      steps.appendChild(el('div', { className: 'line-cmd', text: `$ ${step}` }));
    }
    container.appendChild(steps);

    return container;
  }

  private pathSeparator(): string {
    return navigator.platform.toLowerCase().includes('win') ? '\\' : '/';
  }

  private renderFooter(): HTMLElement {
    const footer = el('div', { className: 'dialog-footer', id: 'wizard-footer' });
    footer.appendChild(this.renderSteps());
    footer.appendChild(this.renderActions());
    return footer;
  }

  /** Repinta sólo el pie: evita perder el foco del campo que se está escribiendo. */
  private refreshFooter(): void {
    const footer = document.getElementById('wizard-footer');
    if (!footer) return;
    clear(footer);
    footer.appendChild(this.renderSteps());
    footer.appendChild(this.renderActions());
  }

  private renderSteps(): HTMLElement {
    const order: Step[] = ['architecture', 'configure', 'result'];
    const currentIndex = order.indexOf(this.step);

    const dots = el('div', { className: 'steps' });
    order.forEach((_, index) => {
      if (index > 0) dots.appendChild(el('span', { className: 'step-line' }));
      dots.appendChild(
        el('span', {
          className: `step-dot${index === currentIndex ? ' active' : index < currentIndex ? ' done' : ''}`,
          text: index < currentIndex ? '✓' : String(index + 1),
        }),
      );
    });

    return dots;
  }

  private renderActions(): HTMLElement {
    const actions = el('div', { style: { display: 'flex', gap: '8px' } });

    if (this.step === 'architecture') {
      actions.append(
        el('button', { className: 'btn', text: 'Cancelar', on: { click: () => this.close() } }),
        el('button', {
          className: 'btn primary',
          text: 'Siguiente',
          disabled: this.form.architecture === null,
          on: {
            click: () => {
              this.step = 'configure';
              this.render();
            },
          },
        }),
      );
      return actions;
    }

    if (this.step === 'configure') {
      actions.append(
        el('button', {
          className: 'btn',
          text: 'Atrás',
          disabled: this.busy,
          on: {
            click: () => {
              this.step = 'architecture';
              this.render();
            },
          },
        }),
        el(
          'button',
          {
            className: 'btn primary',
            disabled: this.busy || this.validationErrors().length > 0,
            on: { click: () => void this.generate() },
          },
          this.busy ? el('span', { className: 'spinner' }) : null,
          this.busy ? ' Generando…' : 'Generar solución',
        ),
      );
      return actions;
    }

    actions.append(
      el('button', { className: 'btn', text: 'Cerrar', on: { click: () => this.close() } }),
      el('button', {
        className: 'btn primary',
        text: 'Abrir la solución',
        on: {
          click: () => {
            const path = this.result?.rootDir;
            this.close();
            if (path) this.host.openWorkspace(path);
          },
        },
      }),
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
      this.error = error instanceof Error ? error.message : String(error);
      // El mensaje del proceso principal llega con el prefijo de Electron: se limpia.
      this.error = this.error.replace(/^Error invoking remote method '[^']+':\s*/, '');
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
