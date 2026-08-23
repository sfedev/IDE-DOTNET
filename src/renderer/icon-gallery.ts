/**
 * Galería de iconos para revisión visual.
 *
 * Se expone como `window.__dotforgeIconGallery()` y la invoca el modo `--icons` del proceso
 * principal. No forma parte de la interfaz: es una herramienta de QA para el conjunto de iconos,
 * que al estar dibujado a mano necesita mirarse — una ruta mal cerrada compila y renderiza igual.
 */
import { clear, el } from './dom.js';
import { icon, ICON_NAMES } from './icons.js';

export function installIconGallery(): void {
  (window as unknown as { __dotforgeIconGallery: () => void }).__dotforgeIconGallery = () => {
    const app = document.getElementById('app');
    if (!app) return;

    clear(app);
    app.setAttribute('style', 'display:block;overflow:auto;height:100vh;background:var(--bg);');

    const page = el('div', { style: { padding: '32px 40px', maxWidth: '1200px', margin: '0 auto' } });

    page.appendChild(
      el('h1', {
        text: `Iconos de DotForge · ${ICON_NAMES.length} piezas`,
        style: { color: 'var(--text-strong)', fontSize: '18px', margin: '0 0 4px' },
      }),
    );
    page.appendChild(
      el('p', {
        text: 'Cada icono a 16 y 24 px. Se revisan trazos abiertos, esquinas y legibilidad al tamaño real.',
        style: { color: 'var(--text-muted)', margin: '0 0 18px', fontSize: '12px' },
      }),
    );

    const grid = el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
        gap: '7px',
      },
    });

    for (const name of ICON_NAMES) {
      grid.appendChild(
        el(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '7px',
              padding: '11px 5px',
              borderRadius: '10px',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
            },
          },
          el(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--text)' } },
            icon(name, { size: 16 }),
            icon(name, { size: 24 }),
          ),
          el('code', {
            text: name,
            style: { color: 'var(--text-faint)', fontSize: '11px', fontFamily: 'var(--font-mono)' },
          }),
        ),
      );
    }

    page.appendChild(grid);
    app.appendChild(page);
  };
}
