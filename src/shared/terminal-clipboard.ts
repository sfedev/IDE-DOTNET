/**
 * Portapapeles de las pestañas de pseudoterminal (Fase 28).
 *
 * Qué gesto del usuario es "copiar", cuál es "pegar" y cuál no es ninguno de los dos y tiene que
 * llegar al intérprete tal cual. Es una regla de producto con casos borde que muerden, y por eso
 * vive fuera del DOM y de xterm:
 *
 *  - `Ctrl+C` es dos cosas. Con texto seleccionado, copia; sin él, interrumpe el proceso, que es
 *    lo que lleva siendo desde 1969. Confundir las dos deja o bien un `dotnet watch` que no se
 *    puede parar o bien una terminal que no sabe copiar.
 *  - `Ctrl+V` en un intérprete es U+0016. PowerShell lo intercepta (PSReadLine lee el portapapeles
 *    del sistema por su cuenta) y por eso pegar "funcionaba" allí; `cmd.exe` no, y pintaba `^V`.
 *    La regla no puede depender de qué intérprete haya detrás: la decide el IDE.
 *  - En macOS no se toca nada. `Cmd+C` / `Cmd+V` no los consume xterm, llegan a los `role` del
 *    menú y xterm ya atiende los eventos `copy` y `paste` del DOM. Y `Ctrl+C` en un Mac es
 *    **siempre** interrumpir.
 *
 * `Ctrl+Insert` / `Shift+Insert` son la pareja clásica de Windows y se admiten por lo mismo que
 * `Ctrl+Shift+C` / `Ctrl+Shift+V`: son lo que teclea quien viene de la consola de Windows o de
 * Linux, y no chocan con ningún intérprete.
 */

export type ClipboardGesture = 'copy' | 'paste' | 'none';

/** Lo que se lee de un `KeyboardEvent`. Declarado a mano para poder probarlo sin DOM. */
export interface KeyGesture {
  /** `keydown`, `keyup` o `keypress`: xterm pasa los tres por el mismo manejador. */
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface GestureContext {
  /** `process.platform` del proceso principal, que es quien sabe dónde corre el IDE. */
  platform: string;
  /** Hay texto seleccionado en el emulador. Es lo que decide qué significa `Ctrl+C`. */
  hasSelection: boolean;
}

/** Botón secundario de un `MouseEvent`. */
export const RIGHT_BUTTON = 2;

/**
 * ¿Gestiona el IDE el portapapeles de la terminal en esta plataforma?
 *
 * En macOS no: lo hacen los `role` del menú con `Cmd`, y `Ctrl` tiene que llegar entero al
 * intérprete.
 */
export function managesClipboard(platform: string): boolean {
  return platform !== 'darwin';
}

/** Qué gesto es una pulsación de teclado. `none` significa "que lo procese xterm". */
export function keyboardGesture(event: KeyGesture, context: GestureContext): ClipboardGesture {
  if (!managesClipboard(context.platform)) return 'none';
  // xterm invoca el manejador con `keydown`, `keypress` y `keyup`. Sólo cuenta el primero: si se
  // decidiera también en `keyup`, cada pegado saldría dos veces.
  if (event.type !== 'keydown') return 'none';
  if (event.altKey || event.metaKey) return 'none';

  const key = event.key.toLowerCase();

  if (key === 'insert') {
    if (event.ctrlKey && !event.shiftKey) return context.hasSelection ? 'copy' : 'none';
    if (event.shiftKey && !event.ctrlKey) return 'paste';
    return 'none';
  }

  if (!event.ctrlKey) return 'none';

  // Con o sin Shift: `Ctrl+Shift+C` es la convención de Linux y no significa otra cosa aquí.
  if (key === 'c') return context.hasSelection ? 'copy' : 'none';
  if (key === 'v') return 'paste';

  return 'none';
}

/**
 * Qué gesto es un clic con el botón secundario.
 *
 * La convención de la consola de Windows y de Windows Terminal: con selección, copia (y la
 * selección se suelta); sin ella, pega. En el resto de plataformas el botón secundario no
 * significa nada y se deja a xterm.
 */
export function mouseGesture(button: number, context: GestureContext): ClipboardGesture {
  if (context.platform !== 'win32') return 'none';
  if (button !== RIGHT_BUTTON) return 'none';
  return context.hasSelection ? 'copy' : 'paste';
}
