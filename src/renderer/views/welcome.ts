/**
 * Pantalla de bienvenida.
 *
 * Es lo primero que ve el usuario, así que lleva a las tres cosas que va a querer hacer: crear
 * una solución con el asistente, abrir una carpeta o volver a un workspace reciente. Además
 * informa del entorno .NET detectado, que es la causa número uno de "no me compila".
 */
import type { AppInfo, AppSettings, RecentWorkspace } from '../../shared/contracts.js';
import { baseName, byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { containerOf } from '../paths.js';

export interface WelcomeHost {
  openWizard(): void;
  openFolderDialog(): void;
  openWorkspace(path: string): void;
  runCommand(commandId: string): void;
}

export class WelcomeView {
  /**
   * Historial con la disponibilidad ya resuelta por el proceso principal. Se guarda aquí porque
   * `render` es síncrono y el renderer no puede mirar el disco por su cuenta.
   */
  private recents: RecentWorkspace[] = [];

  constructor(private readonly host: WelcomeHost) {}

  setRecents(recents: RecentWorkspace[]): void {
    this.recents = recents;
  }

  render(info: AppInfo | null, settings: AppSettings | null): void {
    const container = byId('welcome');
    clear(container);

    const modifier = info?.primaryModifier ?? 'Ctrl';

    const inner = el(
      'div',
      { className: 'welcome-inner' },
      el(
        'div',
        { className: 'welcome-hero' },
        el('div', { className: 'welcome-logo' }, icon('code', { size: 27, strokeWidth: 2 })),
        el(
          'div',
          {},
          el('h1', { text: 'DotForge IDE' }),
          el('p', {
            className: 'subtitle',
            text: 'Entorno de desarrollo para C#, .NET 9+ y Blazor, con generador de arquitecturas.',
          }),
        ),
      ),
    );

    const sections = el('div', { className: 'welcome-sections' });

    // --- Empezar ------------------------------------------------------------------------------
    sections.appendChild(
      this.section('Empezar', [
        this.action('wand', 'Nueva solución con el asistente', `${modifier}+Shift+N`, () => this.host.openWizard()),
        this.action('folder-open', 'Abrir carpeta', `${modifier}+O`, () => this.host.openFolderDialog()),
        this.action('command', 'Paleta de comandos', `${modifier}+Shift+P`, () =>
          this.host.runCommand('view.command-palette'),
        ),
      ]),
    );

    // --- Recientes -----------------------------------------------------------------------------
    // Si aún no ha llegado la disponibilidad, se asume que están: es el estado del primer pintado
    // y se corrige en cuanto responde el proceso principal.
    const recents: RecentWorkspace[] =
      this.recents.length > 0
        ? this.recents
        : (settings?.recentWorkspaces ?? []).map((path) => ({ path, available: true }));

    sections.appendChild(
      this.section(
        'Recientes',
        recents.length === 0
          ? [el('div', { className: 'empty-state compact', text: 'Todavía no has abierto ningún workspace.' })]
          : recents.slice(0, 7).map((entry) =>
              entry.available
                ? this.action(
                    'solution',
                    baseName(entry.path),
                    containerOf(entry.path),
                    () => this.host.openWorkspace(entry.path),
                    entry.path,
                  )
                : // Una carpeta borrada o en un disco desconectado no se oculta ni se borra del
                  // historial: se enseña apagada y sin acción, para que quede claro por qué no
                  // está y no se pierda el rastro de dónde estuvo.
                  this.readOnly('circle-slash', baseName(entry.path), 'no disponible'),
            ),
      ),
    );

    // --- Arquitecturas ---------------------------------------------------------------------------
    sections.appendChild(
      this.section('Arquitecturas disponibles', [
        this.action('solution', 'Clean Architecture', 'Domain · Application · Infrastructure', () =>
          this.host.openWizard(),
        ),
        this.action('hexagon', 'Arquitectura Hexagonal', 'Domain · Ports · Adapters', () => this.host.openWizard()),
        this.action('puzzle', 'DDD + CQRS', 'Agregados · Eventos · Comandos', () => this.host.openWizard()),
      ]),
    );

    // --- Entorno --------------------------------------------------------------------------------
    if (info) {
      const sdks = info.dotnetSdks.length;

      sections.appendChild(
        this.section(
          'Entorno detectado',
          sdks === 0
            ? [
                el(
                  'div',
                  { className: 'notice warn' },
                  icon('alert-triangle', { size: 15 }),
                  el('span', {
                    text: 'No se ha encontrado el SDK de .NET en el PATH. Podrás editar, pero no compilar ni ejecutar.',
                  }),
                ),
              ]
            : [
                this.readOnly('project', 'SDK de .NET', `${sdks} instalado${sdks === 1 ? '' : 's'}`),
                this.readOnly('package', 'Runtimes', String(info.dotnetRuntimes.length)),
                this.readOnly('settings', 'Plataforma', `${info.platform}-${info.arch}`),
              ],
        ),
      );
    }

    inner.appendChild(sections);

    // --- Atajos ------------------------------------------------------------------------------------
    inner.appendChild(
      this.section(
        'Atajos esenciales',
        [
          ['Compilar solución', `${modifier}+Shift+B`],
          ['Iniciar depuración', 'F5'],
          ['Alternar breakpoint', 'F9'],
          ['Hot Reload', `${modifier}+F5`],
          ['Guardar', `${modifier}+S`],
          ['Buscar en el archivo', `${modifier}+F`],
          ['Formatear documento', 'Alt+Shift+F'],
          ['Terminal', `${modifier}+J`],
        ].map(([title, keys]) => this.shortcut(title!, keys!)),
        { marginTop: '36px' },
      ),
    );

    container.appendChild(inner);
  }

  private section(
    title: string,
    children: HTMLElement[],
    style?: Partial<CSSStyleDeclaration>,
  ): HTMLElement {
    return el(
      'div',
      { className: 'welcome-section', ...(style ? { style } : {}) },
      el('h2', { text: title }),
      el('div', { className: 'link-list' }, ...children),
    );
  }

  private action(
    iconName: IconName,
    title: string,
    sub: string,
    onClick: () => void,
    tooltip = sub,
  ): HTMLElement {
    return el(
      'button',
      { className: 'link-item', title: tooltip, on: { click: onClick } },
      icon(iconName, { size: 15 }),
      el('span', { className: 'title', text: title }),
      el('span', { className: 'sub', text: sub }),
    );
  }

  private readOnly(iconName: IconName, title: string, sub: string): HTMLElement {
    return el(
      'div',
      { className: 'link-item readonly' },
      icon(iconName, { size: 15 }),
      el('span', { className: 'title', text: title }),
      el('span', { className: 'sub', text: sub }),
    );
  }

  private shortcut(title: string, keys: string): HTMLElement {
    const chips = el('span', { className: 'kbd' });
    for (const key of keys.split('+')) {
      chips.appendChild(el('span', { text: key }));
    }

    return el(
      'div',
      { className: 'link-item readonly' },
      el('span', { className: 'title', text: title }),
      chips,
    );
  }
}
