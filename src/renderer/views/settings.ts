/**
 * Ajustes.
 *
 * Vive en la barra lateral, como una herramienta más, en lugar de escondido en un diálogo modal:
 * cambiar el tamaño de fuente o el tema mientras se mira el código es exactamente el momento en
 * el que uno quiere ver el efecto.
 *
 * Sólo se exponen los ajustes que un desarrollador cambia de verdad. El resto vive en
 * `settings.json`, y el enlace del pie lleva a él.
 */
import type { AiProbeResult, AiProviderId, AiSettings, AiStatus } from '../../shared/ai.js';
import { AI_PROVIDERS, providerInfo } from '../../shared/ai.js';
import type { AppSettings } from '../../shared/contracts.js';
import type { DotnetVerbosity } from '../../shared/dotnet-verbosity.js';
import { DOTNET_VERBOSITY_INFO, verbosityInfo } from '../../shared/dotnet-verbosity.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export interface SettingsHost {
  apply(patch: Partial<AppSettings>): void;
  /** Estado del asistente: proveedor activo, modelo y si hay credencial guardada. */
  aiStatus(): AiStatus | null;
  /** Guarda o borra (con null) la clave del proveedor. La clave nunca vuelve al renderer. */
  setAiKey(provider: AiProviderId, apiKey: string | null): Promise<void>;
  probeAi(provider: AiProviderId): Promise<AiProbeResult>;
  openExternal(url: string): void;
}

export class SettingsView {
  private settings: AppSettings | null = null;
  private visible = false;

  /** Resultado de la última comprobación de conexión, con el proveedor al que corresponde. */
  private probeResult: { provider: AiProviderId; result: AiProbeResult } | null = null;

  /** Clave a medio escribir. Se descarta en cuanto se guarda: no se conserva más de lo justo. */
  private keyDraft = '';

  constructor(private readonly host: SettingsHost) {}

  setSettings(settings: AppSettings): void {
    this.settings = settings;
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
    byId('sidebar-title').textContent = 'Ajustes';
    clear(byId('sidebar-actions'));

    if (!this.settings) return;
    const settings = this.settings;

    const body = el('div', { className: 'settings' });

    body.append(
      this.group('Apariencia', [
        this.segmentedRow<AppSettings['theme']>(
          'Tema',
          [
            ['dotforge-dark', 'Oscuro', 'moon'],
            ['dotforge-light', 'Claro', 'sun'],
          ],
          settings.theme,
          (value) => this.host.apply({ theme: value }),
        ),
        this.stepperRow('Tamaño de fuente', settings.fontSize, 9, 28, (value) =>
          this.host.apply({ fontSize: value }),
        ),
        this.stepperRow('Tabulación', settings.tabSize, 1, 8, (value) => this.host.apply({ tabSize: value })),
        this.toggleRow('Minimapa', settings.minimap, (value) => this.host.apply({ minimap: value })),
        this.toggleRow('Ajuste de línea', settings.wordWrap, (value) => this.host.apply({ wordWrap: value })),
      ]),

      this.group('Editor', [
        this.toggleRow('Formatear al guardar', settings.formatOnSave, (value) =>
          this.host.apply({ formatOnSave: value }),
        ),
        this.segmentedRow<AppSettings['autoSave']>(
          'Guardado automático',
          [
            ['off', 'Desactivado'],
            ['afterDelay', 'Tras una pausa'],
          ],
          settings.autoSave,
          (value) => this.host.apply({ autoSave: value }),
        ),
      ]),

      this.dotnetGroup(settings.dotnetVerbosity),

      this.group('Lenguaje', [
        this.toggleRow('IntelliSense de C#', settings.lspEnabled, (value) =>
          this.host.apply({ lspEnabled: value }),
        ),
        el('p', {
          className: 'settings-note',
          text:
            'Al desactivarlo, el editor conserva el resaltado y los snippets pero deja de descargar y ' +
            'arrancar el servidor de lenguaje.',
        }),
      ]),

      this.aiGroup(settings.ai),
    );

    container.appendChild(body);
  }

  // --- Piezas -----------------------------------------------------------------------------------

  private group(title: string, rows: HTMLElement[]): HTMLElement {
    return el('section', { className: 'settings-group' }, el('h3', { text: title }), ...rows);
  }

  private toggleRow(label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
    const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));

    return el('label', { className: 'settings-row settings-toggle' }, el('span', { text: label }), input);
  }

  private stepperRow(
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (value: number) => void,
  ): HTMLElement {
    const display = el('span', { className: 'settings-value', text: String(value) });

    const step = (delta: number): HTMLElement =>
      el(
        'button',
        {
          className: 'icon-btn',
          title: delta > 0 ? 'Aumentar' : 'Reducir',
          disabled: delta > 0 ? value >= max : value <= min,
          on: { click: () => onChange(Math.min(max, Math.max(min, value + delta))) },
        },
        icon(delta > 0 ? 'plus' : 'minus', { size: 13 }),
      );

    return el(
      'div',
      { className: 'settings-row' },
      el('span', { text: label }),
      el('div', { className: 'settings-stepper' }, step(-1), display, step(1)),
    );
  }

  private segmentedRow<T extends string>(
    label: string,
    options: Array<[value: T, text: string, iconName?: IconName]>,
    current: T,
    onChange: (value: T) => void,
  ): HTMLElement {
    return el(
      'div',
      { className: 'settings-row settings-row-stacked' },
      el('span', { text: label }),
      el(
        'div',
        { className: 'segmented' },
        ...options.map(([value, text, iconName]) =>
          el(
            'button',
            {
              className: value === current ? 'active' : '',
              on: { click: () => onChange(value) },
            },
            iconName ? icon(iconName, { size: 13 }) : null,
            text,
          ),
        ),
      ),
    );
  }

  private textRow(label: string, value: string, placeholder: string, onChange: (value: string) => void): HTMLElement {
    const input = el('input', {
      className: 'settings-input',
      type: 'text',
      value,
      placeholder,
      attrs: { spellcheck: 'false' },
    }) as HTMLInputElement;

    // Se aplica al perder el foco o con Enter: guardar en cada tecla repintaría a media palabra.
    input.addEventListener('change', () => onChange(input.value.trim()));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });

    return el('div', { className: 'settings-row settings-row-stacked' }, el('span', { text: label }), input);
  }

  private selectRow(
    label: string,
    options: Array<[value: string, text: string]>,
    current: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const select = el('select', { className: 'settings-select' }) as HTMLSelectElement;

    for (const [value, text] of options) {
      const option = el('option', { value, text });
      if (value === current) option.selected = true;
      select.appendChild(option);
    }

    select.addEventListener('change', () => onChange(select.value));

    return el('div', { className: 'settings-row settings-row-stacked' }, el('span', { text: label }), select);
  }

  // --- Herramientas de .NET ------------------------------------------------------------------------

  /**
   * Nivel de salida de la CLI de .NET.
   *
   * Un solo ajuste para `build`, `run`, `watch`, `test` y la depuración. Está aquí y no escondido
   * en un archivo porque es lo primero que hay que subir cuando algo "no arranca y no dice por
   * qué", y bajar cuando la salida estorba.
   */
  private dotnetGroup(current: DotnetVerbosity): HTMLElement {
    const rows: HTMLElement[] = [
      this.selectRow(
        'Nivel de salida de .NET CLI',
        DOTNET_VERBOSITY_INFO.map((entry) => [entry.id, entry.label] as [string, string]),
        current,
        (value) => this.host.apply({ dotnetVerbosity: value as DotnetVerbosity }),
      ),
      el('p', { className: 'settings-note', text: verbosityInfo(current).hint }),
    ];

    if (current === 'detailed' || current === 'diagnostic') {
      rows.push(
        el('p', {
          className: 'settings-note warn',
          text:
            'Con este nivel se recopilan también las excepciones de la aplicación, las variables ' +
            'de entorno de ASP.NET Core y las trazas de arranque. La salida crece mucho.',
        }),
      );
    }

    return this.group('Herramientas de .NET', rows);
  }

  // --- Asistente de IA ---------------------------------------------------------------------------

  /** Aplica un cambio parcial a las preferencias del asistente conservando el resto. */
  private applyAi(patch: Partial<AiSettings>): void {
    if (!this.settings) return;
    this.host.apply({ ai: { ...this.settings.ai, ...patch } });
  }

  private setProviderPreference(ai: AiSettings, patch: { model?: string; baseUrl?: string }): void {
    const current = ai.providers[ai.provider];
    this.applyAi({ providers: { ...ai.providers, [ai.provider]: { ...current, ...patch } } });
  }

  /**
   * Sección del asistente.
   *
   * Está deliberadamente en el mismo sitio que el resto de preferencias y no en un diálogo aparte:
   * elegir modelo y decidir qué contexto se envía es una preferencia, no una ceremonia.
   */
  private aiGroup(ai: AiSettings): HTMLElement {
    const provider = providerInfo(ai.provider);
    const preferences = ai.providers[ai.provider];
    const status = this.host.aiStatus();

    const rows: HTMLElement[] = [
      this.toggleRow('Activar el asistente', ai.enabled, (value) => this.applyAi({ enabled: value })),
      this.segmentedRow<AiProviderId>(
        'Proveedor',
        AI_PROVIDERS.map((entry) => [entry.id, entry.label] as [AiProviderId, string]),
        ai.provider,
        (value) => {
          this.probeResult = null;
          this.keyDraft = '';
          this.applyAi({ provider: value });
        },
      ),
      el('p', { className: 'settings-note', text: provider.hint }),
      provider.freeformModel
        ? this.textRow('Modelo', preferences.model, provider.models[0]?.id ?? '', (value) =>
            this.setProviderPreference(ai, { model: value }),
          )
        : this.selectRow(
            'Modelo',
            provider.models.map((model) => [model.id, `${model.label}${model.legacy ? ' · anterior' : ''}`]),
            preferences.model,
            (value) => this.setProviderPreference(ai, { model: value }),
          ),
    ];

    const selected = provider.models.find((model) => model.id === preferences.model);
    if (selected) rows.push(el('p', { className: 'settings-note', text: selected.hint }));

    rows.push(
      this.textRow('Endpoint', preferences.baseUrl, provider.baseUrl, (value) =>
        this.setProviderPreference(ai, { baseUrl: value }),
      ),
    );

    if (provider.needsApiKey) rows.push(...this.apiKeyRows(ai, status));

    rows.push(
      this.probeRow(ai),
      this.selectRow(
        'Longitud máxima de la respuesta',
        [
          ['2048', '2 048 tokens'],
          ['4096', '4 096 tokens'],
          ['8192', '8 192 tokens'],
          ['16384', '16 384 tokens'],
          ['32000', '32 000 tokens'],
        ],
        String(ai.maxTokens),
        (value) => this.applyAi({ maxTokens: Number(value) }),
      ),
      this.segmentedRow<AiSettings['effort']>(
        'Esfuerzo de razonamiento',
        [
          ['low', 'Bajo'],
          ['medium', 'Medio'],
          ['high', 'Alto'],
        ],
        ai.effort,
        (value) => this.applyAi({ effort: value }),
      ),
      el('p', {
        className: 'settings-note',
        text: 'Sólo se envía a los modelos que lo admiten; a los demás ni se les manda, porque lo rechazan.',
      }),
      el('h4', { className: 'settings-subhead', text: 'Contexto que se envía' }),
      this.toggleRow('Archivo activo', ai.includeActiveFile, (value) => this.applyAi({ includeActiveFile: value })),
      this.toggleRow('Selección del editor', ai.includeSelection, (value) => this.applyAi({ includeSelection: value })),
      this.toggleRow('Arquitectura de la solución', ai.includeArchitecture, (value) =>
        this.applyAi({ includeArchitecture: value }),
      ),
      this.toggleRow('Errores de compilación', ai.includeDiagnostics, (value) =>
        this.applyAi({ includeDiagnostics: value }),
      ),
      el('p', {
        className: 'settings-note',
        text:
          'Con el proveedor local (Ollama) nada de esto sale del equipo. Con Anthropic u OpenAI, el ' +
          'contexto marcado viaja a su API en cada mensaje.',
      }),
    );

    return this.group('Asistente de IA', rows);
  }

  private apiKeyRows(ai: AiSettings, status: AiStatus | null): HTMLElement[] {
    const provider = providerInfo(ai.provider);
    const stored = status?.configured.includes(ai.provider) ?? false;

    const input = el('input', {
      className: 'settings-input',
      type: 'password',
      placeholder: stored ? 'Clave guardada — escribe otra para reemplazarla' : 'Pega aquí tu clave de API',
      attrs: { autocomplete: 'off', spellcheck: 'false' },
    }) as HTMLInputElement;

    input.value = this.keyDraft;
    input.addEventListener('input', () => {
      this.keyDraft = input.value;
    });

    const save = async (): Promise<void> => {
      const value = input.value.trim();
      if (value === '') return;
      await this.host.setAiKey(ai.provider, value);
      this.keyDraft = '';
      this.render();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void save();
    });

    const state = el(
      'p',
      { className: `settings-note ${stored ? 'ok' : 'warn'}` },
      icon(stored ? 'key' : 'alert-circle', { size: 12 }),
      el('span', {
        text: stored
          ? 'Clave guardada y cifrada con el llavero del sistema. Sólo viaja hacia el proveedor.'
          : `Sin clave, el asistente no puede responder con ${provider.label}.`,
      }),
    );

    const rows: HTMLElement[] = [
      el(
        'div',
        { className: 'settings-row settings-row-stacked' },
        el('span', { text: 'Clave de API' }),
        input,
        el(
          'div',
          { className: 'settings-inline-actions' },
          el('button', { className: 'btn primary small', text: 'Guardar', on: { click: () => void save() } }),
          stored
            ? el('button', {
                className: 'btn ghost small',
                text: 'Borrar',
                on: { click: () => void this.host.setAiKey(ai.provider, null).then(() => this.render()) },
              })
            : null,
        ),
      ),
      state,
    ];

    if (provider.keyUrl) {
      const url = provider.keyUrl;
      rows.push(
        el('button', {
          className: 'link-btn',
          text: 'Conseguir una clave…',
          on: { click: () => this.host.openExternal(url) },
        }),
      );
    }

    return rows;
  }

  /**
   * Botón "Probar conexión".
   *
   * Existe porque el momento honesto para descubrir que la clave está mal o que Ollama no está
   * arrancado es aquí, no a mitad de la primera pregunta con el cursor parpadeando.
   */
  private probeRow(ai: AiSettings): HTMLElement {
    const result = this.probeResult?.provider === ai.provider ? this.probeResult.result : null;

    const button = el('button', { className: 'btn ghost small', text: 'Probar conexión' });
    button.addEventListener('click', () => {
      button.textContent = 'Probando…';
      button.disabled = true;

      void this.host.probeAi(ai.provider).then((probe) => {
        this.probeResult = { provider: ai.provider, result: probe };
        this.render();
      });
    });

    const row = el('div', { className: 'settings-row settings-row-stacked' }, button);

    if (result) {
      row.appendChild(el('p', { className: `settings-note ${result.ok ? 'ok' : 'warn'}`, text: result.message }));

      if (result.models.length > 0) {
        row.appendChild(el('p', { className: 'settings-note', text: `Modelos instalados: ${result.models.join(', ')}` }));
      }
    }

    return row;
  }
}
