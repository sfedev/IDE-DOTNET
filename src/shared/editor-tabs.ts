/**
 * Organización visual de la tira de pestañas: de qué proyecto es cada archivo y dónde va la tira.
 *
 * El problema que resuelve la primera mitad es concreto y aparece en cuanto una solución pasa de
 * tres proyectos: se abren cinco `Program.cs`, cinco `appsettings.json` y tres `Repository.cs`, y
 * la tira de pestañas deja de decir nada porque todas se llaman igual. El nombre del archivo es
 * ambiguo; el proyecto al que pertenece, no.
 *
 * Tres decisiones, y las tres se prueban aquí porque son reglas con casos borde de verdad:
 *
 *  - **El proyecto de un archivo se decide por el prefijo de directorio más largo.** Una solución
 *    puede tener `Acme.Api` y `Acme.Api.Tests` como carpetas hermanas, y también anidadas
 *    (`src/Acme.Api` con `src/Acme.Api/Extras/Extras.csproj` dentro). Quedarse con la primera
 *    carpeta que encaje mete los archivos del proyecto interior en el exterior.
 *  - **El color se asigna por identificador, y se guarda.** No se deriva de la posición en la
 *    solución: añadir un proyecto recolorearía todos los demás y el código de colores que uno tenía
 *    memorizado cambiaría de golpe. Se guarda por nombre, y a un proyecto nuevo se le da el hueco
 *    libre más bajo.
 *  - **La posición de la tira es un ajuste con tres valores cerrados.** Lo guardado lo puede haber
 *    escrito otra versión del IDE.
 *
 * Es puro y no toca el DOM: lo consumen el editor (para pintar) y los ajustes (para elegir).
 */

/** Posiciones de la tira de pestañas. `top` es la de siempre. */
export const TAB_POSITIONS = ['top', 'left', 'right'] as const;

export type TabPosition = (typeof TAB_POSITIONS)[number];

export const DEFAULT_TAB_POSITION: TabPosition = 'top';

export interface TabPositionInfo {
  id: TabPosition;
  label: string;
}

export const TAB_POSITION_INFO: readonly TabPositionInfo[] = [
  { id: 'top', label: 'Arriba' },
  { id: 'left', label: 'Izquierda' },
  { id: 'right', label: 'Derecha' },
];

export function coerceTabPosition(raw: unknown): TabPosition {
  return typeof raw === 'string' && (TAB_POSITIONS as readonly string[]).includes(raw)
    ? (raw as TabPosition)
    : DEFAULT_TAB_POSITION;
}

/**
 * Cuántos colores hay.
 *
 * Ocho, y no más: son tonos que tienen que distinguirse entre sí **de reojo**, en una franja de
 * 2 px, y con más de ocho dejan de hacerlo. Una solución con más de ocho proyectos reutiliza
 * colores, que es mejor que tener catorce tonos indistinguibles. Cada uno es un token de
 * `theme.css` (`--tab-project-1` … `--tab-project-8`): aquí no se escribe ningún color.
 */
export const TAB_COLOR_COUNT = 8;

export interface TabProjectSettings {
  position: TabPosition;
  /** Pintar la marca de color de cada proyecto en su pestaña. */
  colorize: boolean;
  /** Escribir además el nombre del proyecto en la pestaña, no sólo en el tooltip. */
  showProjectName: boolean;
  /**
   * Color asignado a cada proyecto, por nombre.
   *
   * Se guarda para que no cambie: derivarlo de la posición en la solución haría que añadir un
   * proyecto recoloreara todos los demás.
   */
  colors: Record<string, number>;
}

export const DEFAULT_TAB_SETTINGS: TabProjectSettings = {
  position: DEFAULT_TAB_POSITION,
  colorize: true,
  showProjectName: false,
  colors: {},
};

/** Tope de proyectos con color recordado: por encima, el archivo crece sin que nadie lo mire. */
export const MAX_REMEMBERED_COLORS = 200;

/**
 * Forma admisible del nombre de un proyecto como clave de color.
 *
 * Acaba siendo parte de una clase CSS sólo a través de su **índice**, nunca por su nombre, así que
 * aquí sólo se acota lo razonable: algo no vacío y de largo humano. Lo que no encaje se descarta al
 * leer, que es lo conservador — como mucho, ese proyecto vuelve a elegir color.
 */
function isValidProjectKey(key: string): boolean {
  return key.trim() !== '' && key.length <= 200;
}

export function coerceTabSettings(raw: unknown): TabProjectSettings {
  const settings: TabProjectSettings = { ...DEFAULT_TAB_SETTINGS, colors: {} };
  if (typeof raw !== 'object' || raw === null) return settings;

  const source = raw as Record<string, unknown>;

  settings.position = coerceTabPosition(source['position']);
  if (typeof source['colorize'] === 'boolean') settings.colorize = source['colorize'];
  if (typeof source['showProjectName'] === 'boolean') settings.showProjectName = source['showProjectName'];

  const colors = source['colors'];
  if (typeof colors === 'object' && colors !== null) {
    for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
      if (!isValidProjectKey(key)) continue;
      if (typeof value !== 'number' || !Number.isInteger(value)) continue;
      if (value < 0 || value >= TAB_COLOR_COUNT) continue;

      settings.colors[key] = value;
      if (Object.keys(settings.colors).length >= MAX_REMEMBERED_COLORS) break;
    }
  }

  return settings;
}

/**
 * Normaliza una ruta para poder comparar prefijos.
 *
 * Barras unificadas, sin cola y en minúsculas. Lo de las minúsculas no es pereza: en Windows la
 * misma carpeta llega escrita `C:\\Sln\\Acme.Api` desde el explorador y `c:/sln/acme.api` desde un
 * `.sln`, y comparando tal cual el archivo se quedaría sin proyecto sin que nada falle.
 */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export interface TabProject {
  /** Nombre del proyecto. Es la clave del color. */
  name: string;
  /** Carpeta que lo contiene. */
  directory: string;
}

/**
 * ¿A qué proyecto pertenece un archivo?
 *
 * Gana el directorio más largo que lo contenga, no el primero que encaje: en una solución con
 * `src/Acme.Api` y `src/Acme.Api/Extras` (un proyecto dentro de la carpeta de otro, que pasa más de
 * lo que parece con los proyectos de pruebas), quedarse con el primero mete los archivos del
 * interior en el exterior.
 *
 * Y se compara **por segmentos**, no por prefijo de texto: `src/Acme.Api` es prefijo textual de
 * `src/Acme.ApiTests/Program.cs`, que es otro proyecto.
 */
export function projectForFile(filePath: string, projects: readonly TabProject[]): TabProject | null {
  const file = normalize(filePath);

  let best: TabProject | null = null;
  let bestLength = -1;

  for (const project of projects) {
    const directory = normalize(project.directory);
    if (directory === '') continue;
    if (file !== directory && !file.startsWith(`${directory}/`)) continue;

    if (directory.length > bestLength) {
      best = project;
      bestLength = directory.length;
    }
  }

  return best;
}

/**
 * Índice de color de un proyecto, asignándole uno si no lo tenía.
 *
 * El hueco libre **más bajo**, no el siguiente del contador: cerrar una solución de ocho proyectos
 * y abrir otra de tres tiene que dar los colores 1, 2 y 3, no los que quedaran libres al azar. Con
 * los ocho ocupados se reparte por el número de proyectos ya asignados, que reparte mejor que
 * hacerlo por el nombre.
 *
 * **No muta** lo que recibe: devuelve el índice y, si ha habido que asignar, el mapa nuevo. Así
 * quien llama decide cuándo guardar, en vez de escribir en el disco desde el pintado de una
 * pestaña.
 */
export interface ColorAssignment {
  index: number;
  /** Mapa actualizado, o el mismo objeto si no ha habido que asignar nada. */
  colors: Record<string, number>;
  /** true si este proyecto no tenía color y se le acaba de dar uno. */
  assigned: boolean;
}

export function colorForProject(name: string, colors: Record<string, number>): ColorAssignment {
  const existing = colors[name];
  if (typeof existing === 'number' && existing >= 0 && existing < TAB_COLOR_COUNT) {
    return { index: existing, colors, assigned: false };
  }

  const taken = new Set(Object.values(colors));

  let index = 0;
  while (index < TAB_COLOR_COUNT && taken.has(index)) index++;

  // Con los ocho ocupados, se sigue repartiendo en vez de dejar el proyecto sin marca: dos
  // proyectos del mismo color siguen diciendo más que ninguno.
  if (index >= TAB_COLOR_COUNT) index = Object.keys(colors).length % TAB_COLOR_COUNT;

  return { index, colors: { ...colors, [name]: index }, assigned: true };
}

/**
 * Asigna color a toda una solución de una vez, en el orden en el que están declarados.
 *
 * Se llama al abrir una solución, no al pintar cada pestaña: así los colores quedan repartidos por
 * el orden del `.sln` —que es el que el usuario está viendo en el explorador— en vez de por el
 * orden en el que se hayan ido abriendo archivos.
 */
export function assignColors(
  projectNames: readonly string[],
  colors: Record<string, number>,
): Record<string, number> {
  let current = colors;

  for (const name of projectNames) {
    if (name.trim() === '') continue;
    current = colorForProject(name, current).colors;
  }

  return current;
}

/**
 * Olvida los colores de los proyectos que ya no existen en ninguna solución reciente.
 *
 * Existe para que el archivo de preferencias no crezca solo. Se poda **con la lista de lo que hay
 * que conservar**, nunca al abrir una solución: cerrar una solución para abrir otra no puede
 * borrar los colores de la primera, o volver a ella los habría cambiado todos.
 */
export function pruneColors(colors: Record<string, number>, keep: readonly string[]): Record<string, number> {
  if (Object.keys(colors).length <= MAX_REMEMBERED_COLORS) return colors;

  const wanted = new Set(keep);
  const pruned: Record<string, number> = {};

  for (const [name, index] of Object.entries(colors)) {
    if (wanted.has(name)) pruned[name] = index;
  }

  return pruned;
}

/**
 * Cómo se pinta una pestaña.
 *
 * Se devuelve el **índice** del color, no un color: los colores son tokens de `theme.css` y el
 * renderer los aplica por clase (`tab-project-3`). Ningún componente escribe un color literal, ni
 * siquiera calculado.
 */
export interface TabDecoration {
  /** Clase del color, o `null` si esta pestaña no lleva marca. */
  colorClass: string | null;
  /** Texto del `title`: nombre del archivo y, si se conoce, su proyecto. */
  tooltip: string;
  /** Nombre del proyecto a escribir en la pestaña, o `null`. */
  projectLabel: string | null;
}

export function decorateTab(
  filePath: string,
  fileName: string,
  projects: readonly TabProject[],
  settings: TabProjectSettings,
): TabDecoration {
  const project = projectForFile(filePath, projects);

  if (project === null) {
    // Un archivo de la solución que no está en ningún proyecto (un `.editorconfig` de la raíz, un
    // README) no lleva marca: inventarle un color diría que pertenece a algo.
    return { colorClass: null, tooltip: filePath, projectLabel: null };
  }

  const index = colorForProject(project.name, settings.colors).index;

  return {
    colorClass: settings.colorize ? `tab-project-${index + 1}` : null,
    // La ruta entera sigue estando: es lo que se necesita cuando hay dos proyectos con el mismo
    // nombre en soluciones distintas abiertas una detrás de otra.
    tooltip: `${fileName} — ${project.name}\n${filePath}`,
    projectLabel: settings.showProjectName ? project.name : null,
  };
}
