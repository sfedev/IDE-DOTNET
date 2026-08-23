/**
 * Sistema de iconos de DotForge.
 *
 * Iconos vectoriales propios, dibujados sobre una rejilla de 24×24 con trazo de 1.75 y extremos
 * redondeados — el mismo lenguaje visual de Lucide o Phosphor, pero sin añadir una dependencia
 * ni miles de iconos que no se usan.
 *
 * Se construyen con `createElementNS` en vez de `innerHTML`: el renderer nunca inyecta marcado,
 * ni siquiera el suyo propio.
 *
 * Reglas de diseño:
 *  - Todo hereda `currentColor`, así que el color lo decide el CSS del contexto.
 *  - Un icono nunca lleva texto: a 16 px no se lee y rompe la coherencia del conjunto.
 *  - Los iconos de tipo de archivo son marcas reconocibles (almohadilla de C#, arroba de Razor),
 *    no una hoja genérica repetida en trece colores.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Primitivas con las que se compone cada icono. */
type Shape =
  | { p: string }
  | { c: [cx: number, cy: number, r: number] }
  | { r: [x: number, y: number, w: number, h: number, rx?: number] }
  | { l: [x1: number, y1: number, x2: number, y2: number] }
  /** Relleno sólido (para puntos, insignias y marcas macizas). */
  | { fp: string }
  | { fc: [cx: number, cy: number, r: number] };

export type IconName = keyof typeof ICONS;

const ICONS = {
  // ---------------------------------------------------------------------------------------
  // Navegación y árbol
  // ---------------------------------------------------------------------------------------
  'chevron-right': [{ p: 'm9.5 6 6 6-6 6' }],
  'chevron-down': [{ p: 'm6 9.5 6 6 6-6' }],
  'chevron-up': [{ p: 'm6 14.5 6-6 6 6' }],
  'chevron-left': [{ p: 'm14.5 6-6 6 6 6' }],

  folder: [{ p: 'M3 8.5A2 2 0 0 1 5 6.5h3.9a2 2 0 0 1 1.4.6l1.2 1.2h8.5a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }],
  'folder-open': [
    { p: 'M3 9V7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.4.6l1.2 1.2h8.5a2 2 0 0 1 2 2v1' },
    { p: 'M2.6 11.5h19.1l-2.2 7.9A2 2 0 0 1 17.6 21H5.5a2 2 0 0 1-1.9-1.6Z' },
  ],

  file: [{ p: 'M14 3H7.5A2 2 0 0 0 5.5 5v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7.5Z' }, { p: 'M14 3v4.5h4.5' }],

  // ---------------------------------------------------------------------------------------
  // Tipos de archivo del ecosistema .NET
  // ---------------------------------------------------------------------------------------

  /** C#: la "C" y la almohadilla, sin la hoja de papel que sobra a 16 px. */
  csharp: [
    { p: 'M11 8.6a4.2 4.2 0 1 0 0 6.8' },
    { p: 'm15.5 8.4-.9 7.2' },
    { p: 'm19.3 8.4-.9 7.2' },
    { p: 'M14.2 10.6h6' },
    { p: 'M13.8 13.4h6' },
  ],

  /** Razor / Blazor: la arroba. */
  razor: [
    { c: [12, 12, 3.4] },
    { p: 'M15.4 8.6v4.6a2.6 2.6 0 0 0 5.2 0V12A8.6 8.6 0 1 0 16.8 19.4' },
  ],

  /** Solución (.sln): capas apiladas. */
  solution: [
    { p: 'M12 2.8 3 7.4l9 4.6 9-4.6Z' },
    { p: 'm3 12 9 4.6 9-4.6' },
    { p: 'm3 16.6 9 4.6 9-4.6' },
  ],

  /** Proyecto (.csproj): caja 3D. */
  project: [
    { p: 'M20.5 8.2v7.6a2 2 0 0 1-1 1.74l-6.5 3.7a2 2 0 0 1-2 0l-6.5-3.7a2 2 0 0 1-1-1.74V8.2a2 2 0 0 1 1-1.74l6.5-3.7a2 2 0 0 1 2 0l6.5 3.7a2 2 0 0 1 1 1.74Z' },
    { p: 'm3.8 7.3 8.2 4.7 8.2-4.7' },
    { p: 'M12 21.2V12' },
  ],

  /** JSON / configuración: llaves. */
  braces: [
    { p: 'M8.5 3.5h-.8A2.2 2.2 0 0 0 5.5 5.7v3.1A3.2 3.2 0 0 1 2.3 12a3.2 3.2 0 0 1 3.2 3.2v3.1a2.2 2.2 0 0 0 2.2 2.2h.8' },
    { p: 'M15.5 3.5h.8a2.2 2.2 0 0 1 2.2 2.2v3.1a3.2 3.2 0 0 0 3.2 3.2 3.2 3.2 0 0 0-3.2 3.2v3.1a2.2 2.2 0 0 1-2.2 2.2h-.8' },
  ],

  /** XML / .csproj crudo / .props: corchetes de código. */
  code: [{ p: 'm9 16.5-4.5-4.5L9 7.5' }, { p: 'm15 7.5 4.5 4.5L15 16.5' }],

  markdown: [
    { r: [2.5, 5.5, 19, 13, 2.5] },
    { p: 'M6.5 16V9.5l2.8 3 2.8-3V16' },
    { p: 'M16.2 9.5V16' },
    { p: 'm14 13.6 2.2 2.4 2.2-2.4' },
  ],

  /** CSS: almohadilla. */
  hash: [{ p: 'M9.5 3.5 8 20.5' }, { p: 'M17 3.5 15.5 20.5' }, { p: 'M4.5 9h16' }, { p: 'M3.5 15h16' }],

  /** YAML / listas de configuración. */
  list: [
    { p: 'M9 6.5h11.5' },
    { p: 'M9 12h11.5' },
    { p: 'M9 17.5h11.5' },
    { fc: [4.6, 6.5, 1.3] },
    { fc: [4.6, 12, 1.3] },
    { fc: [4.6, 17.5, 1.3] },
  ],

  image: [
    { r: [3, 5, 18, 14, 2.5] },
    { c: [8.6, 10, 1.6] },
    { p: 'm3.6 17.4 4.6-4.3a1.8 1.8 0 0 1 2.4 0l3 2.8 2-1.8a1.8 1.8 0 0 1 2.4 0l2.4 2.2' },
  ],

  terminal: [{ r: [2.8, 4.5, 18.4, 15, 2.5] }, { p: 'm7 10 2.6 2.4L7 14.8' }, { p: 'M12.6 15h4.4' }],

  // ---------------------------------------------------------------------------------------
  // Carpetas con significado en .NET
  // ---------------------------------------------------------------------------------------

  /** Controllers / Endpoints: rutas que se bifurcan. */
  route: [
    { c: [5.5, 5.5, 2.4] },
    { c: [18.5, 18.5, 2.4] },
    { p: 'M7.9 5.5h5.6a3.6 3.6 0 0 1 0 7.2h-3a3.6 3.6 0 0 0 0 7.2h5.6' },
  ],

  /** Models / Data: cilindro de base de datos. */
  database: [
    { p: 'M4.5 6.2c0-1.5 3.4-2.7 7.5-2.7s7.5 1.2 7.5 2.7-3.4 2.7-7.5 2.7-7.5-1.2-7.5-2.7Z' },
    { p: 'M4.5 6.2v11.6c0 1.5 3.4 2.7 7.5 2.7s7.5-1.2 7.5-2.7V6.2' },
    { p: 'M19.5 12c0 1.5-3.4 2.7-7.5 2.7S4.5 13.5 4.5 12' },
  ],

  /** Services: llave inglesa, en una sola silueta cerrada. */
  tool: [
    { p: 'M20.4 4.6a5.4 5.4 0 0 1-7 7L6.2 18.8a2.2 2.2 0 1 1-3-3l7.2-7.2a5.4 5.4 0 0 1 7-7l-3.2 3.2 2.2 2.2 3.2-3.2Z' },
  ],

  /** Pages: documentos apilados. */
  pages: [
    { p: 'M7.5 3.5h6L18 8v9.5a2 2 0 0 1-2 2H7.5a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2Z' },
    { p: 'M13.5 3.5V8H18' },
    { p: 'M18.5 7.2 20.5 9v9.8a2.2 2.2 0 0 1-2.2 2.2H9.6' },
  ],

  /** Components: pieza de puzle. */
  puzzle: [
    { p: 'M10.2 4.2a1.9 1.9 0 0 1 3.6 0 1.6 1.6 0 0 0 .5 1.1h3.2a1.5 1.5 0 0 1 1.5 1.5v3.1a1.6 1.6 0 0 0 1.1.5 1.9 1.9 0 0 1 0 3.6 1.6 1.6 0 0 0-1.1.5v3.1a1.5 1.5 0 0 1-1.5 1.5h-3.4a1.4 1.4 0 0 1-.4-1 1.9 1.9 0 0 0-3.6 0 1.4 1.4 0 0 1-.4 1H6.3a1.5 1.5 0 0 1-1.5-1.5v-3.4a1.4 1.4 0 0 1 1-.4 1.9 1.9 0 0 0 0-3.6 1.4 1.4 0 0 1-1-.4V6.8a1.5 1.5 0 0 1 1.5-1.5h3.4a1.6 1.6 0 0 0 .5-1.1Z' },
  ],

  /** wwwroot / recursos públicos. */
  globe: [{ c: [12, 12, 8.6] }, { p: 'M3.4 12h17.2' }, { p: 'M12 3.4a13 13 0 0 1 0 17.2 13 13 0 0 1 0-17.2Z' }],

  /** Properties / launchSettings. */
  sliders: [
    { p: 'M5 20V14' },
    { p: 'M5 10V4' },
    { p: 'M12 20v-9' },
    { p: 'M12 7V4' },
    { p: 'M19 20v-4' },
    { p: 'M19 12V4' },
    { p: 'M2.6 14h4.8' },
    { p: 'M9.6 11h4.8' },
    { p: 'M16.6 16h4.8' },
  ],

  /** Tests: matraz. */
  flask: [
    { p: 'M9.5 3h5' },
    { p: 'M10.5 3v6.2L5.2 18a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3l-5.3-8.8V3' },
    { p: 'M7.4 14.5h9.2' },
  ],

  /** Domain / núcleo: hexágono. */
  hexagon: [{ p: 'm12 2.6 8.2 4.7v9.4L12 21.4 3.8 16.7V7.3Z' }],

  /** Migraciones / historial. */
  history: [
    { p: 'M3.6 12a8.4 8.4 0 1 0 2.6-6.1L3.2 8.7' },
    { p: 'M3 4.4v4.6h4.6' },
    { p: 'M12 7.8V12l2.8 1.8' },
  ],

  /** Eventos de dominio. */
  zap: [{ p: 'M13.4 2.5 4.8 13.2h6l-1.2 8.3 8.6-10.7h-6Z' }],

  /** Puertos y adaptadores. */
  plug: [
    { p: 'M9 2.8v5.4' },
    { p: 'M15 2.8v5.4' },
    { p: 'M6.6 8.2h10.8v3a5.4 5.4 0 0 1-10.8 0Z' },
    { p: 'M12 16.6v4.6' },
  ],

  /** Comandos y consultas: ida y vuelta. */
  exchange: [{ p: 'M4 8.5h13l-3.2-3.2' }, { p: 'M20 15.5H7l3.2 3.2' }],

  // ---------------------------------------------------------------------------------------
  // Barra de actividad
  // ---------------------------------------------------------------------------------------

/**
   * Generador de arquitecturas.
   *
   * Se probó una varita con destellos y a 20 px se leía como una raya diagonal con motas. Tres
   * destellos de cuatro puntas se reconocen al instante y son el gesto que ya significa
   * "generar" en cualquier herramienta moderna.
   */
  wand: [
    { p: 'M11.4 3.4 13 8.1l4.7 1.6-4.7 1.6-1.6 4.7-1.6-4.7L5.1 9.7l4.7-1.6Z' },
    { p: 'M18.4 14.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z' },
    { p: 'M5.2 15.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6L3 18l1.6-.6Z' },
  ],

  /** NuGet: paquete. */
  package: [
    { p: 'M20.5 8.2v7.6a2 2 0 0 1-1 1.74l-6.5 3.7a2 2 0 0 1-2 0l-6.5-3.7a2 2 0 0 1-1-1.74V8.2a2 2 0 0 1 1-1.74l6.5-3.7a2 2 0 0 1 2 0l6.5 3.7a2 2 0 0 1 1 1.74Z' },
    { p: 'm3.8 7.3 8.2 4.7 8.2-4.7' },
    { p: 'M12 21.2V12' },
    { p: 'm7.9 5 8.2 4.7' },
  ],

  /** Depuración. */
  bug: [
    { p: 'M8.5 7.5V6a3.5 3.5 0 1 1 7 0v1.5' },
    { r: [7, 7.5, 10, 12, 5] },
    { p: 'M7 12H3.5' },
    { p: 'M20.5 12H17' },
    { p: 'm7.4 8-2.6-2' },
    { p: 'm19.2 6-2.6 2' },
    { p: 'm7.4 16-2.6 2' },
    { p: 'm19.2 18-2.6-2' },
    { p: 'M12 11.5v5' },
  ],

  settings: [
    { c: [12, 12, 3.1] },
    { p: 'M19.6 14.4a1.5 1.5 0 0 0 .3 1.65l.05.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.06a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37v.17a1.8 1.8 0 1 1-3.6 0v-.09a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.06.06a1.8 1.8 0 1 1-2.55-2.55l.06-.06a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9h-.17a1.8 1.8 0 0 1 0-3.6h.09a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.06-.06a1.8 1.8 0 1 1 2.55-2.55l.06.06a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37v-.17a1.8 1.8 0 1 1 3.6 0v.09a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.06-.06a1.8 1.8 0 1 1 2.55 2.55l-.06.06a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.17a1.8 1.8 0 0 1 0 3.6h-.09a1.5 1.5 0 0 0-1.37.9Z' },
  ],

  // ---------------------------------------------------------------------------------------
  // Acciones y estado
  // ---------------------------------------------------------------------------------------
  play: [{ fp: 'M7.8 4.9a1 1 0 0 1 1.52-.85l9.1 5.6a1 1 0 0 1 0 1.7l-9.1 5.6a1 1 0 0 1-1.52-.85Z' }],
  stop: [{ r: [6, 6, 12, 12, 2.4] }],
/**
   * Compilar.
   *
   * Un martillo de frente: cabeza rectangular y mango vertical. La versión "en perspectiva" que
   * usan otros sets necesita seis trazos y a 15 px se convierte en una mancha.
   */
  hammer: [
    { p: 'M13.6 2.8 21 10.2l-2.8 2.8-7.4-7.4Z' },
    { p: 'm11.6 8.4-8 8a2.4 2.4 0 0 0 3.4 3.4l8-8' },
  ],
  refresh: [{ p: 'M20.4 11a8.4 8.4 0 0 0-14.3-4.5L2.8 9.6' }, { p: 'M2.6 4.6v5h5' }, { p: 'M3.6 13a8.4 8.4 0 0 0 14.3 4.5l3.3-3.1' }, { p: 'M21.4 19.4v-5h-5' }],
  'collapse-all': [{ p: 'm7 9.5 5-4 5 4' }, { p: 'M4.5 14h15' }, { p: 'M7 18.5h10' }],
  search: [{ c: [10.8, 10.8, 6.8] }, { p: 'm15.8 15.8 4.6 4.6' }],
  plus: [{ p: 'M12 5.5v13' }, { p: 'M5.5 12h13' }],
  minus: [{ p: 'M5.5 12h13' }],
  x: [{ p: 'm6.5 6.5 11 11' }, { p: 'm17.5 6.5-11 11' }],
  check: [{ p: 'm5 12.8 4.6 4.6L19 7.4' }],
  ellipsis: [{ fc: [5.4, 12, 1.5] }, { fc: [12, 12, 1.5] }, { fc: [18.6, 12, 1.5] }],
  trash: [{ p: 'M4.5 6.5h15' }, { p: 'M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5' }, { p: 'M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5' }],
  download: [{ p: 'M12 3.5v11' }, { p: 'm7.4 10.2 4.6 4.6 4.6-4.6' }, { p: 'M4.5 19.5h15' }],
  'external-link': [{ p: 'M14 4.5h5.5V10' }, { p: 'm19.5 4.5-8 8' }, { p: 'M18 14v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5' }],

  'git-branch': [{ c: [6.5, 5.5, 2.4] }, { c: [6.5, 18.5, 2.4] }, { c: [17.5, 8.5, 2.4] }, { p: 'M6.5 7.9v8.2' }, { p: 'M17.5 10.9a5.6 5.6 0 0 1-5.6 5.6H8.9' }],

  'alert-circle': [{ c: [12, 12, 8.6] }, { p: 'M12 7.8v4.6' }, { fc: [12, 16, 1.1] }],
  'alert-triangle': [{ p: 'M10.3 3.9 2.6 17.2a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' }, { p: 'M12 9v4' }, { fc: [12, 16.6, 1.1] }],
  info: [{ c: [12, 12, 8.6] }, { p: 'M12 16.2v-4.6' }, { fc: [12, 8, 1.1] }],
  'circle-dot': [{ c: [12, 12, 8.4] }, { fc: [12, 12, 3.1] }],
  'circle-slash': [{ c: [12, 12, 8.4] }, { p: 'm7.6 16.4 8.8-8.8' }],

  /** Punto de interrupción. */
  breakpoint: [{ fc: [12, 12, 5.4] }],

  /** Marca de "hay cambios sin guardar". */
  dot: [{ fc: [12, 12, 4.2] }],

  'panel-bottom': [{ r: [2.8, 4.5, 18.4, 15, 2.5] }, { p: 'M2.8 14.5h18.4' }],
  sidebar: [{ r: [2.8, 4.5, 18.4, 15, 2.5] }, { p: 'M9.4 4.5v15' }],
  command: [{ p: 'M15 6a3 3 0 1 1 3 3h-3Zm0 0v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12' }],
  sun: [{ c: [12, 12, 4.2] }, { p: 'M12 2.6v2.2' }, { p: 'M12 19.2v2.2' }, { p: 'm5.3 5.3 1.6 1.6' }, { p: 'm17.1 17.1 1.6 1.6' }, { p: 'M2.6 12h2.2' }, { p: 'M19.2 12h2.2' }, { p: 'm5.3 18.7 1.6-1.6' }, { p: 'm17.1 6.9 1.6-1.6' }],
  moon: [{ p: 'M20.5 14.4A8.8 8.8 0 0 1 9.6 3.5a8.8 8.8 0 1 0 10.9 10.9Z' }],
} satisfies Record<string, Shape[]>;

export interface IconOptions {
  /** Tamaño en píxeles. Por defecto 16, que es el del árbol y los menús. */
  size?: number;
  className?: string;
  /** Grosor del trazo. Se afina en tamaños grandes para no engordar el dibujo. */
  strokeWidth?: number;
  title?: string;
}

/** Crea un icono como elemento SVG. */
export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const size = options.size ?? 16;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(options.strokeWidth ?? (size >= 22 ? 1.6 : 1.75)));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (options.className) svg.setAttribute('class', options.className);

  if (options.title) {
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = options.title;
    svg.appendChild(title);
    svg.removeAttribute('aria-hidden');
  }

  for (const shape of ICONS[name] as Shape[]) {
    svg.appendChild(createShape(shape));
  }

  return svg;
}

function createShape(shape: Shape): SVGElement {
  if ('p' in shape) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', shape.p);
    return path;
  }

  if ('fp' in shape) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', shape.fp);
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('stroke', 'none');
    return path;
  }

  if ('c' in shape) {
    const [cx, cy, r] = shape.c;
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    return circle;
  }

  if ('fc' in shape) {
    const [cx, cy, r] = shape.fc;
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', 'currentColor');
    circle.setAttribute('stroke', 'none');
    return circle;
  }

  if ('l' in shape) {
    const [x1, y1, x2, y2] = shape.l;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    return line;
  }

  const [x, y, w, h, rx] = shape.r;
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', String(y));
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  if (rx !== undefined) rect.setAttribute('rx', String(rx));
  return rect;
}

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/**
 * Datos crudos de cada icono.
 *
 * Se exportan para poder validarlos en los tests: una ruta con un carácter perdido compila,
 * renderiza un SVG vacío y sólo se nota mirándolo. Comprobarlo automáticamente sale gratis.
 */
export const ICON_SHAPES: Record<IconName, readonly Shape[]> = ICONS;
