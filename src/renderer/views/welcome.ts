/**
 * Pantalla de bienvenida.
 *
 * Es lo primero que ve el usuario, así que lleva a las tres cosas que va a querer hacer: crear
 * una solución con el asistente, abrir una carpeta o volver a un workspace reciente. Además
 * informa del entorno .NET detectado, que es la causa número uno de "no me compila".
 */
import type { AppInfo, AppSettings } from '../../shared/contracts.js';
import { baseName, byId, clear, el } from '../dom.js';

export interface WelcomeHost {
  openWizard(): void;
  openFolderDialog(): void;
  openWorkspace(path: string): void;
  runCommand(commandId: string): void;
}

export class WelcomeView {
  constructor(private readonly host: WelcomeHost) {}

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
        el('div', { className: 'welcome-logo', text: '</>' }),
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
      el(
        'div',
        { className: 'welcome-section' },
        el('h2', { text: 'Empezar' }),
        el(
          'div',
          { className: 'link-list' },
          this.link('Nueva solución con el asistente…', `${modifier}+Shift+N`, () => this.host.openWizard()),
          this.link('Abrir carpeta…', `${modifier}+O`, () => this.host.openFolderDialog()),
          this.link('Paleta de comandos', `${modifier}+Shift+P`, () => this.host.runCommand('view.command-palette')),
        ),
      ),
    );

    // --- Recientes -----------------------------------------------------------------------------
    const recents = settings?.recentWorkspaces ?? [];
    sections.appendChild(
      el(
        'div',
        { className: 'welcome-section' },
        el('h2', { text: 'Recientes' }),
        recents.length === 0
          ? el('div', { className: 'empty-state', text: 'Todavía no has abierto ningún workspace.' })
          : el(
              'div',
              { className: 'link-list' },
              ...recents.slice(0, 8).map((path) =>
                el(
                  'button',
                  {
                    className: 'link-item',
                    title: path,
                    on: { click: () => this.host.openWorkspace(path) },
                  },
                  el('span', { text: baseName(path) }),
                  el('span', { className: 'sub', text: path }),
                ),
              ),
            ),
      ),
    );

    // --- Arquitecturas ---------------------------------------------------------------------------
    sections.appendChild(
      el(
        'div',
        { className: 'welcome-section' },
        el('h2', { text: 'Arquitecturas disponibles' }),
        el(
          'div',
          { className: 'link-list' },
          this.link('Clean Architecture', 'Domain · Application · Infrastructure · UI', () => this.host.openWizard()),
          this.link('Arquitectura Hexagonal', 'Domain · Ports · Adapters', () => this.host.openWizard()),
          this.link('DDD + CQRS', 'Agregados · Eventos · Comandos y consultas', () => this.host.openWizard()),
        ),
      ),
    );

    // --- Entorno ------------------------------------------------------------------------------------
    if (info) {
      const sdks = info.dotnetSdks.length;
      const runtimes = info.dotnetRuntimes.length;

      sections.appendChild(
        el(
          'div',
          { className: 'welcome-section' },
          el('h2', { text: 'Entorno detectado' }),
          sdks === 0
            ? el('div', {
                className: 'notice warn',
                text: 'No se ha encontrado el SDK de .NET en el PATH. Podrás editar, pero no compilar ni ejecutar.',
              })
            : el(
                'div',
                { className: 'link-list' },
                this.readOnlyRow('SDK de .NET', `${sdks} instalado${sdks === 1 ? '' : 's'}`),
                this.readOnlyRow('Runtimes', `${runtimes}`),
                this.readOnlyRow('Plataforma', `${info.platform}-${info.arch}`),
                this.readOnlyRow('Electron', info.electron),
              ),
        ),
      );
    }

    inner.appendChild(sections);

    // --- Atajos ----------------------------------------------------------------------------------------
    inner.appendChild(
      el(
        'div',
        { className: 'welcome-section', style: { marginTop: '28px' } },
        el('h2', { text: 'Atajos esenciales' }),
        el(
          'div',
          { className: 'link-list' },
          this.readOnlyRow('Compilar solución', `${modifier}+Shift+B`),
          this.readOnlyRow('Ejecutar', 'F5'),
          this.readOnlyRow('Ejecutar con Hot Reload', `${modifier}+F5`),
          this.readOnlyRow('Detener', 'Shift+F5'),
          this.readOnlyRow('Guardar', `${modifier}+S`),
          this.readOnlyRow('Buscar en el archivo', `${modifier}+F`),
          this.readOnlyRow('Formatear documento', 'Alt+Shift+F'),
          this.readOnlyRow('Paquetes NuGet', `${modifier}+Shift+U`),
        ),
      ),
    );

    container.appendChild(inner);
  }

  private link(title: string, sub: string, onClick: () => void): HTMLElement {
    return el(
      'button',
      { className: 'link-item', on: { click: onClick } },
      el('span', { text: title }),
      el('span', { className: 'sub', text: sub }),
    );
  }

  private readOnlyRow(title: string, sub: string): HTMLElement {
    return el(
      'div',
      { className: 'link-item', style: { color: 'var(--text-muted)', cursor: 'default' } },
      el('span', { text: title }),
      el('span', { className: 'sub', text: sub }),
    );
  }
}
