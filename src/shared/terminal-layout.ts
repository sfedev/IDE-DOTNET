/**
 * Qué pestañas de terminal tenía abiertas cada solución.
 *
 * La Fase 21 dejó esto sin hacer con un argumento que sigue siendo cierto y conviene tener delante
 * antes de leer el resto: **restaurar una terminal es, como mucho, volver a abrirla vacía en el
 * mismo directorio**. No se recupera el histórico, ni el proceso que estuviera corriendo, ni la
 * línea a medio escribir. Lo que se restaura es la *disposición*: cuántas pestañas había, de qué
 * intérprete cada una y cuál estaba delante.
 *
 * Con eso claro, lo que se guarda es deliberadamente poco:
 *
 *  - **Sólo identificadores de perfil.** Nada de rutas de ejecutables ni de argumentos: el catálogo
 *    lo pone `terminal-profiles.ts` y puede cambiar entre versiones. Un identificador desconocido
 *    —de otra versión, o de otra plataforma— cae al perfil por defecto por `coerceProfileId`, que
 *    ya trata ese caso como una migración y no como un error.
 *  - **El directorio no viaja aquí desde el renderer.** El renderer manda perfiles y cuál estaba
 *    activa; el `cwd` lo pone el proceso principal desde la sesión de la terminal, igual que al
 *    abrir una pestaña (ADR-059). Si el renderer pudiera mandar una ruta que después se convierte
 *    en el directorio de un intérprete, la garantía del ADR-059 se habría perdido por la puerta de
 *    atrás.
 *  - **No se guarda si el intérprete seguía vivo.** Un `exit` no cambia la disposición: la pestaña
 *    estaba ahí y se vuelve a abrir. Guardar "estaba muerta" sólo serviría para restaurar una
 *    pestaña muerta, que no es de ninguna utilidad.
 *
 * Módulo puro: ni `node:*`, ni `electron`, ni DOM.
 */
import { coerceProfileId, findProfile } from './terminal-profiles.js';

/**
 * Tope de pestañas que se restauran.
 *
 * Por debajo del tope de sesiones vivas (`MAX_PTY_SESSIONS`, 12) y a propósito: abrir doce
 * intérpretes de golpe al abrir una solución es una tormenta de procesos en el peor momento, justo
 * cuando el IDE está cargando Monaco y parseando el `.sln`. Lo que pase de aquí se descarta al
 * guardar, no al restaurar, para que el archivo diga la verdad sobre lo que se va a hacer con él.
 */
export const MAX_RESTORED_TABS = 8;

/** Cuántas soluciones recuerdan su disposición. Más allá, no vuelve nadie. */
export const MAX_REMEMBERED_WORKSPACES = 20;

/** Disposición de las pestañas de terminal de una solución. */
export interface TerminalLayout {
  /** Identificadores de perfil, en el orden de las pestañas. */
  tabs: string[];
  /** Índice de la que estaba delante, siempre dentro de `tabs`. */
  activeIndex: number;
  /** Directorio de la sesión al guardar. Lo pone el proceso principal, nunca el renderer. */
  cwd: string | null;
}

export function emptyLayout(): TerminalLayout {
  return { tabs: [], activeIndex: 0, cwd: null };
}

/** ¿Esta disposición merece restaurarse? Una sola pestaña asistida es justo lo que ya hay. */
export function isRestorable(layout: TerminalLayout): boolean {
  if (layout.tabs.length === 0) return false;
  if (layout.tabs.length === 1 && layout.tabs[0] === 'lite') return false;
  return true;
}

/**
 * Sanea lo que llega del renderer: una lista de perfiles y cuál estaba activa.
 *
 * Todo identificador pasa por `coerceProfileId`, así que el resultado sólo puede contener perfiles
 * del catálogo y de esta plataforma. El índice se pinza dentro del rango en vez de rechazarse: una
 * pestaña activa fuera de sitio no es motivo para tirar la disposición entera.
 */
export function coerceIncomingLayout(raw: unknown, platform: string): { tabs: string[]; activeIndex: number } {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const rawTabs = Array.isArray(source['tabs']) ? source['tabs'] : [];
  const tabs = rawTabs.slice(0, MAX_RESTORED_TABS).map((entry) => coerceProfileId(entry, platform));

  const rawIndex = source['activeIndex'];
  const index = typeof rawIndex === 'number' && Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : 0;

  return { tabs, activeIndex: clampIndex(index, tabs.length) };
}

/**
 * Sanea una disposición leída del disco.
 *
 * El archivo lo escribe una versión del IDE y lo lee otra, así que se aplican las mismas reglas que
 * a lo que llega del renderer más una: el `cwd` tiene que ser una cadena no vacía o desaparece. Que
 * el directorio siga existiendo lo comprueba quien lo va a usar, que es el único que puede.
 */
export function coerceStoredLayout(raw: unknown, platform: string): TerminalLayout {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const { tabs, activeIndex } = coerceIncomingLayout(source, platform);

  const cwd = source['cwd'];

  return {
    tabs,
    activeIndex,
    cwd: typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null,
  };
}

/**
 * Qué pestañas se abren de verdad al restaurar.
 *
 * Un perfil de pseudoterminal cuando `node-pty` no está disponible no se abre: dejaría una pestaña
 * muerta con un mensaje dentro, que es exactamente lo que `openTerminal` evita al crearlas a mano.
 * Se cae a la asistida sólo si con eso no queda ninguna, porque un panel de terminal sin ninguna
 * pestaña no es un estado que el IDE sepa enseñar.
 */
export function restorablePlan(
  layout: TerminalLayout,
  options: { ptyAvailable: boolean },
): { tabs: string[]; activeIndex: number; skipped: number } {
  const kept: string[] = [];
  let active = 0;
  let skipped = 0;

  for (const [index, profileId] of layout.tabs.entries()) {
    const profile = findProfile(profileId);
    if (profile === null) continue;

    if (profile.kind === 'pty' && !options.ptyAvailable) {
      skipped++;
      continue;
    }

    if (index === layout.activeIndex) active = kept.length;
    kept.push(profileId);
  }

  if (kept.length === 0) return { tabs: [], activeIndex: 0, skipped };

  return { tabs: kept, activeIndex: clampIndex(active, kept.length), skipped };
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}
