/**
 * Estado del asistente de IA en la interfaz.
 *
 * Una sola pregunta con muchas consecuencias: si el asistente está desactivado en Ajustes, ¿qué
 * hace su icono de la barra de actividad? Aquí se responde una vez, en función pura, y la usan
 * la barra de actividad, la paleta de comandos y el asistente en línea. Sin esto, cada sitio
 * decide por su cuenta y acaba habiendo tres comportamientos distintos para el mismo interruptor.
 *
 * La decisión de producto: el icono **no desaparece**. Un icono que se esfuma no enseña nada;
 * uno atenuado con un tooltip que dice dónde se enciende, sí.
 */

/** Mensaje exacto del tooltip cuando el asistente está apagado. */
export const AI_DISABLED_MESSAGE =
  'El asistente de IA está deshabilitado. Puedes activarlo desde la configuración';

export interface AiEntryState {
  /** El control se pinta atenuado y no navega a ninguna parte. */
  disabled: boolean;
  /** Texto del `title` / `aria-label`. */
  title: string;
  /** Clase extra de la entrada de la barra de actividad. */
  className: string;
  /** true si el clic debe abrir la vista del asistente. */
  navigates: boolean;
}

/**
 * Estado del icono del asistente.
 *
 * Tres situaciones distintas y sólo dos de ellas bloquean:
 *  - **apagado en Ajustes**: atenuado, sin navegación, con el mensaje de arriba.
 *  - **encendido pero sin credencial**: navega igual, porque el panel es justo donde se explica
 *    qué falta y desde donde se llega a los ajustes. Bloquearlo sería esconder la explicación.
 *  - **listo**: comportamiento normal.
 */
export function aiEntryState(enabled: boolean, ready: boolean): AiEntryState {
  if (!enabled) {
    return {
      disabled: true,
      title: AI_DISABLED_MESSAGE,
      className: 'activity-item disabled',
      navigates: false,
    };
  }

  return {
    disabled: false,
    title: ready
      ? 'DotForge AI Assistant'
      : 'DotForge AI Assistant — falta configurar la clave de API',
    className: 'activity-item',
    navigates: true,
  };
}

/**
 * ¿Puede lanzarse una acción del asistente (chat, Ctrl+I, menú contextual)?
 * Devuelve el motivo cuando no, para poder decirlo en vez de no hacer nada en silencio.
 */
export function aiActionBlockedReason(enabled: boolean, ready: boolean): string | null {
  if (!enabled) return AI_DISABLED_MESSAGE;
  if (!ready) return 'El asistente todavía no tiene credencial: configúrala en Ajustes.';
  return null;
}
