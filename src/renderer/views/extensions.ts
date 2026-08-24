/**
 * Panel de extensiones (Open VSX).
 *
 * Buscar en el registro abierto, instalar, ver lo instalado y desinstalar, sin salir del IDE. Es
 * el registro que DotForge usa desde el primer día por licencia (ADR-001): el marketplace de
 * Microsoft no permite que lo consuma un producto que no sea VS Code.
 *
 * Tres decisiones de la vista:
 *
 *  - **Dos secciones, no dos pestañas.** Arriba lo instalado (que es lo que se viene a gestionar) y
 *    debajo el resultado de la búsqueda. Sin buscar nada, el panel ya es útil.
 *  - **Los iconos se dibujan aquí.** La CSP no admite imágenes remotas y, como en NuGet, bajarlas
 *    le contaría al registro qué está mirando el usuario. Se pinta una pastilla con las iniciales
 *    y un color derivado del identificador, así que la misma extensión se ve siempre igual.
 *  - **Se dice qué aporta de verdad.** DotForge no ejecuta el código de activación de una
 *    extensión: aprovecha lo declarativo (temas, fragmentos, gramáticas, lenguajes). Cada ficha
 *    instalada lo enseña en vez de dejar que se descubra a base de esperar a que pase algo.
 */
import type { InstalledExtension, MarketplaceExtension } from '../../shared/contracts.js';
import {
  EXTENSION_CATEGORIES,
  extensionHue,
  extensionInitials,
  formatDownloads,
  formatRating,
} from '../../shared/open-vsx.js';
import { hasNewerVersion } from '../../shared/vsix.js';
import { byId, clear, debounce, el } from '../dom.js';
import { icon } from '../icons.js';

export interface ExtensionsHost {
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
  openUrl(url: string): void;
}

export class ExtensionsView {
  private visible = false;
  private query = '';
  private category = '';

  private results: MarketplaceExtension[] = [];
  private total = 0;
  private installed: InstalledExtension[] = [];

  private searching = false;
  private loaded = false;
  private error: string | null = null;
  /** Identificador de la extensión con una instalación o desinstalación en marcha. */
  private working: string | null = null;

  private readonly runSearch = debounce(() => void this.search(), 320);

  constructor(private readonly host: ExtensionsHost) {}

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) return;

    this.render();
    if (!this.loaded) void this.refresh();
  }

  isVisible(): boolean {
    return this.visible;
  }

  installedCount(): number {
    return this.installed.length;
  }

  /** Relee lo instalado y repite la búsqueda actual. Lo llaman el botón y la primera apertura. */
  async refresh(): Promise<void> {
    this.loaded = true;
    await Promise.all([this.loadInstalled(), this.search()]);
  }

  private async loadInstalled(): Promise<void> {
    try {
      this.installed = await window.dotforge.extensions.installed();
    } catch (error) {
      this.host.notify(`No se han podido leer las extensiones instaladas: ${this.messageOf(error)}`, 'warn');
      this.installed = [];
    }
    this.render();
  }

  private async search(): Promise<void> {
    this.searching = true;
    this.error = null;
    this.render();

    try {
      const result = await window.dotforge.extensions.search({ query: this.query, category: this.category });
      this.results = result.extensions;
      this.total = result.total;
    } catch (error) {
      // Que Open VSX no conteste no vacía el panel: lo instalado sigue estando y sigue siendo
      // gestionable sin red, que es justo cuando más molesta un panel en blanco.
      this.results = [];
      this.total = 0;
      this.error = this.messageOf(error);
    } finally {
      this.searching = false;
      this.render();
    }
  }

  private messageOf(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/^Error invoking remote method '[^']+':\s*/, '');
  }

  // --- Acciones ---------------------------------------------------------------------------------

  private async install(extension: MarketplaceExtension): Promise<void> {
    if (this.working !== null) return;

    this.working = extension.id;
    this.render();

    try {
      const installed = await window.dotforge.extensions.install(extension);
      this.host.notify(`Extensión ${installed.displayName} ${installed.version} instalada.`, 'ok');
      await this.loadInstalled();
    } catch (error) {
      this.host.notify(`No se ha podido instalar ${extension.id}: ${this.messageOf(error)}`, 'error');
    } finally {
      this.working = null;
      this.render();
    }
  }

  private async uninstall(extension: InstalledExtension): Promise<void> {
    if (this.working !== null) return;
    if (!window.confirm(`¿Desinstalar "${extension.displayName}"?`)) return;

    this.working = extension.id;
    this.render();

    try {
      await window.dotforge.extensions.uninstall(extension.id);
      this.host.notify(`Extensión ${extension.displayName} desinstalada.`, 'ok');
      await this.loadInstalled();
    } catch (error) {
      this.host.notify(`No se ha podido desinstalar ${extension.id}: ${this.messageOf(error)}`, 'error');
    } finally {
      this.working = null;
      this.render();
    }
  }

  // --- Pintado ----------------------------------------------------------------------------------

  render(): void {
    if (!this.visible) return;

    const container = byId('sidebar-content');
    clear(container);
    byId('sidebar-title').textContent = 'Extensiones';

    const actions = byId('sidebar-actions');
    clear(actions);
    actions.append(
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Volver a consultar Open VSX',
          disabled: this.searching,
          on: { click: () => void this.refresh() },
        },
        icon('refresh', { size: 15 }),
      ),
      el(
        'button',
        {
          className: 'icon-btn',
          title: 'Abrir la carpeta de extensiones',
          on: { click: () => void window.dotforge.extensions.openFolder() },
        },
        icon('folder-open', { size: 15 }),
      ),
    );

    const panel = el('div', { className: 'ext-panel' });
    panel.append(this.searchBar(), this.categoryPicker());

    if (this.installed.length > 0) panel.appendChild(this.installedSection());

    if (this.error !== null) {
      panel.appendChild(
        el(
          'div',
          { className: 'notice warn' },
          icon('alert-triangle', { size: 15 }),
          el('span', {}, el('strong', { text: 'Open VSX no responde. ' }), this.error),
        ),
      );
    }

    panel.appendChild(this.resultsSection());
    container.appendChild(panel);
  }

  private searchBar(): HTMLElement {
    const input = el('input', {
      className: 'input',
      placeholder: 'Buscar en open-vsx.org…',
      value: this.query,
      on: {
        input: (event) => {
          this.query = (event.target as HTMLInputElement).value;
          this.runSearch();
        },
      },
    });

    return el('div', { className: 'ext-search' }, input);
  }

  private categoryPicker(): HTMLElement {
    const select = el('select', {
      className: 'input',
      on: {
        change: (event) => {
          this.category = (event.target as HTMLSelectElement).value;
          void this.search();
        },
      },
    }) as HTMLSelectElement;

    for (const category of EXTENSION_CATEGORIES) {
      const option = el('option', { value: category.id, text: category.label }) as HTMLOptionElement;
      if (category.id === this.category) option.selected = true;
      select.appendChild(option);
    }

    return el('div', { className: 'ext-search' }, select);
  }

  private sectionHead(title: string, count: number): HTMLElement {
    return el(
      'div',
      { className: 'ext-section-head' },
      el('span', { text: title }),
      el('span', { className: 'ext-count', text: String(count) }),
    );
  }

  private installedSection(): HTMLElement {
    const section = el('div', { className: 'ext-section' }, this.sectionHead('Instaladas', this.installed.length));

    for (const extension of this.installed) {
      section.appendChild(this.installedCard(extension));
    }

    return section;
  }

  private resultsSection(): HTMLElement {
    const section = el('div', { className: 'ext-section' });

    if (this.searching) {
      section.appendChild(
        el('div', { className: 'empty-state' }, el('span', { className: 'spinner' }), ' Consultando Open VSX…'),
      );
      return section;
    }

    if (this.results.length === 0) {
      section.appendChild(
        el('div', {
          className: 'empty-state',
          text: this.error === null ? 'Sin resultados en el registro.' : 'Sin resultados que mostrar.',
        }),
      );
      return section;
    }

    section.appendChild(
      this.sectionHead(this.query.trim() === '' ? 'Más descargadas' : 'Resultados', this.total),
    );

    const installedIds = new Map(this.installed.map((entry) => [entry.id.toLowerCase(), entry]));

    for (const extension of this.results) {
      section.appendChild(this.resultCard(extension, installedIds.get(extension.id.toLowerCase()) ?? null));
    }

    return section;
  }

  /**
   * Pastilla del icono.
   *
   * Iniciales sobre un color derivado del identificador. No se descarga el icono real: la CSP no
   * lo permitiría y, aunque lo permitiera, sería contarle al registro qué mira el usuario.
   */
  private avatar(id: string, displayName: string, name: string): HTMLElement {
    const hue = extensionHue(id);
    return el('div', {
      className: 'ext-avatar',
      text: extensionInitials(displayName, name),
      style: {
        backgroundColor: `hsl(${hue}, 42%, 26%)`,
        color: `hsl(${hue}, 68%, 82%)`,
      },
    });
  }

  private resultCard(extension: MarketplaceExtension, installed: InstalledExtension | null): HTMLElement {
    const busy = this.working === extension.id;
    const upgradable = installed !== null && hasNewerVersion(installed.version, extension.version);

    const meta = [
      extension.namespace,
      `${formatDownloads(extension.downloadCount)} descargas`,
      formatRating(extension.averageRating, extension.reviewCount),
    ].filter((part) => part !== '');

    const actions = el('div', { className: 'ext-actions' });

    if (installed === null || upgradable) {
      actions.appendChild(
        el(
          'button',
          {
            className: 'btn primary small',
            disabled: busy || extension.download === null,
            title:
              extension.download === null
                ? 'Esta extensión no publica un paquete descargable'
                : `Descarga el .vsix de Open VSX e instala la versión ${extension.version}`,
            on: { click: () => void this.install(extension) },
          },
          busy ? el('span', { className: 'spinner' }) : icon('download', { size: 13 }),
          el('span', { text: upgradable ? `Actualizar a ${extension.version}` : 'Instalar' }),
        ),
      );
    } else {
      actions.appendChild(el('span', { className: 'installed-badge', text: `instalada ${installed.version}` }));
    }

    if (extension.homepage !== null || extension.repository !== null) {
      const url = extension.homepage ?? extension.repository!;
      actions.appendChild(
        el(
          'button',
          { className: 'link-btn', title: url, on: { click: () => this.host.openUrl(url) } },
          icon('external-link', { size: 12 }),
          el('span', { text: 'Página' }),
        ),
      );
    }

    return el(
      'div',
      { className: 'ext-card' },
      this.avatar(extension.id, extension.displayName, extension.name),
      el(
        'div',
        { className: 'ext-body' },
        el(
          'div',
          { className: 'ext-title' },
          el('span', { className: 'ext-name', text: extension.displayName }),
          el('span', { className: 'ext-version', text: extension.version }),
          extension.verified ? el('span', { className: 'chip accent', text: '✓ verificada' }) : null,
        ),
        el('div', { className: 'ext-meta', text: meta.join(' · ') }),
        extension.description === '' ? null : el('div', { className: 'ext-description', text: extension.description }),
        actions,
      ),
    );
  }

  private installedCard(extension: InstalledExtension): HTMLElement {
    const busy = this.working === extension.id;
    const { supported, unsupported, hasCode } = extension.contributions;

    const body = el(
      'div',
      { className: 'ext-body' },
      el(
        'div',
        { className: 'ext-title' },
        el('span', { className: 'ext-name', text: extension.displayName }),
        el('span', { className: 'ext-version', text: extension.version }),
      ),
      el('div', { className: 'ext-meta', text: extension.id }),
    );

    if (extension.description !== '') {
      body.appendChild(el('div', { className: 'ext-description', text: extension.description }));
    }

    if (supported.length > 0) {
      body.appendChild(
        el(
          'div',
          { className: 'ext-contrib ok' },
          icon('check', { size: 12 }),
          el('span', { text: `Aporta ${supported.join(', ')}.` }),
        ),
      );
    }

    // Lo honesto: DotForge no ejecuta extensiones, aprovecha lo que declaran. Decirlo aquí evita
    // que alguien concluya que la instalación ha fallado.
    if (unsupported.length > 0 || hasCode) {
      const parts = [...unsupported];
      if (hasCode) parts.push('código de activación');

      body.appendChild(
        el(
          'div',
          { className: 'ext-contrib warn' },
          icon('info', { size: 12 }),
          el('span', { text: `Sin efecto en DotForge: ${parts.join(', ')}.` }),
        ),
      );
    }

    body.appendChild(
      el(
        'div',
        { className: 'ext-actions' },
        el(
          'button',
          {
            className: 'btn danger small',
            disabled: busy,
            on: { click: () => void this.uninstall(extension) },
          },
          busy ? el('span', { className: 'spinner' }) : icon('trash', { size: 13 }),
          el('span', { text: 'Desinstalar' }),
        ),
      ),
    );

    return el(
      'div',
      { className: 'ext-card installed' },
      this.avatar(extension.id, extension.displayName, extension.name),
      body,
    );
  }
}
