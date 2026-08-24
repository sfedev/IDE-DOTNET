/**
 * Orden de la barra de actividad.
 *
 * Quién usa el IDE decide qué herramienta quiere arriba. Alguien que vive en el control de código
 * fuente no quiere bajar la vista hasta el sexto icono; alguien que sólo genera arquitecturas no
 * quiere el panel de contenedores por delante de nada.
 *
 * Dos decisiones que se pagan si no se toman aquí:
 *
 *  - **Los identificadores mandan, no las posiciones.** Los modos de diagnóstico `--ui=` pulsaban
 *    los iconos por índice dentro de `.activity-item`, y eso se ha roto en silencio dos veces al
 *    añadir una herramienta (Fase 15 y Fase 17, las dos anotadas en `CLAUDE.md`). Con un orden que
 *    además el usuario puede cambiar, la posición deja de significar nada: ahora se pulsa por
 *    `data-tool-id`.
 *  - **Lo guardado es una sugerencia, no la verdad.** El archivo de preferencias lo puede editar
 *    cualquiera y lo escriben versiones distintas del IDE. Un orden con una herramienta que ya no
 *    existe, o al que le falta una que se añadió después, tiene que dar una barra completa y usable,
 *    no una barra a medias.
 *
 * Puro y sin DOM: lo consumen el renderer, que lo pinta, y el servicio de preferencias del proceso
 * principal, que lo valida al leer del disco.
 */

/**
 * Herramientas reordenables, en su orden de fábrica.
 *
 * "Ajustes" no está: vive debajo del separador, al fondo de la barra, y ahí es donde se busca en
 * cualquier editor. Dejar que suba sólo serviría para que alguien lo perdiera de vista.
 */
export const ACTIVITY_TOOLS = [
  'explorer',
  'search',
  'git',
  'wizard',
  'nuget',
  'efcore',
  'containers',
  'tests',
  'debug',
  'ai',
  'extensions',
] as const;

export type ActivityToolId = (typeof ACTIVITY_TOOLS)[number];

/** La que no se mueve. Va después del separador. */
export const PINNED_ACTIVITY_TOOL = 'settings';

export const DEFAULT_ACTIVITY_ORDER: ActivityToolId[] = [...ACTIVITY_TOOLS];

export function isActivityTool(value: unknown): value is ActivityToolId {
  return typeof value === 'string' && (ACTIVITY_TOOLS as readonly string[]).includes(value);
}

/**
 * Convierte lo que hay guardado en un orden completo y sin sorpresas.
 *
 * Se descarta lo que no se reconoce y lo repetido, y lo que falte se añade al final. Al final y no
 * en su hueco de fábrica a propósito: una herramienta que aparece en una versión nueva se ve mejor
 * al final de una barra que el usuario ya tiene colocada a su gusto que insertada en medio,
 * desplazándole todo lo que había debajo.
 */
export function normalizeActivityOrder(saved: unknown): ActivityToolId[] {
  const order: ActivityToolId[] = [];

  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (isActivityTool(entry) && !order.includes(entry)) order.push(entry);
    }
  }

  for (const tool of ACTIVITY_TOOLS) {
    if (!order.includes(tool)) order.push(tool);
  }

  return order;
}

/**
 * Mueve una herramienta al hueco que ocupa otra.
 *
 * Devuelve el mismo array (por referencia) cuando no hay nada que mover, para que quien llama pueda
 * distinguir un arrastre que ha cambiado algo de uno que ha acabado donde empezó y ahorrarse
 * guardar las preferencias por nada.
 */
export function moveActivityTool(
  order: readonly ActivityToolId[],
  dragged: string,
  target: string,
): ActivityToolId[] {
  if (dragged === target) return order as ActivityToolId[];
  if (!isActivityTool(dragged) || !isActivityTool(target)) return order as ActivityToolId[];

  const from = order.indexOf(dragged);
  const to = order.indexOf(target);
  if (from === -1 || to === -1) return order as ActivityToolId[];

  const next = [...order];
  next.splice(from, 1);
  next.splice(next.indexOf(target) + (from < to ? 1 : 0), 0, dragged);

  return next;
}

/** ¿Este orden es el de fábrica? Lo usa Ajustes para saber si tiene sentido ofrecer "Restaurar". */
export function isDefaultActivityOrder(order: readonly string[]): boolean {
  return order.length === DEFAULT_ACTIVITY_ORDER.length && order.every((id, index) => id === DEFAULT_ACTIVITY_ORDER[index]);
}
