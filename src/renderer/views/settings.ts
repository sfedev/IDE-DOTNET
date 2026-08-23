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
import type { AppSettings } from '../../shared/contracts.js';
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export interface SettingsHost {
  apply(patch: Partial<AppSettings>): void;
}

export class SettingsView {
  private settings: AppSettings | null = null;
  private visible = false;

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
}
