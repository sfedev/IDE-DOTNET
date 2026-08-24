/**
 * Conservar el foco y el cursor cuando una vista se repinta entera.
 *
 * DotForge no tiene DOM virtual: cada vista de la barra lateral vacía su contenedor y lo vuelve a
 * construir (`clear(container)` + `el(...)`). Es simple, es rápido y no hay dos verdades que puedan
 * divergir… salvo por una cosa: **el `<input>` que el usuario está usando también se destruye**.
 * Basta con que la búsqueda de NuGet o la de extensiones termine su rebote mientras se escribe para
 * que el nodo enfocado desaparezca a mitad de una palabra, y lo que se siente es que "el IDE se
 * come las letras".
 *
 * La respuesta no es dejar de repintar: es que el repintado sepa devolver el foco donde estaba, con
 * el cursor donde estaba. Cada campo que quiera sobrevivir a un repintado se marca con
 * `data-focus-key`, y `repaintPreservingFocus` (en `dom.ts`) hace el resto.
 *
 * Aquí vive **lo que se decide**, sin tocar el DOM, para poder probarlo con Node pelado: qué se
 * anota, cuándo se restaura y —el caso que de verdad muerde— qué hacer cuando el texto ha cambiado
 * entre la foto y la restauración.
 */

/**
 * Lo mínimo que necesita un campo para participar. Lo cumple cualquier `<input>` o `<textarea>`
 * real, y lo cumple también un objeto de tres líneas en una prueba.
 */
export interface FocusableField {
  readonly dataset: Record<string, string | undefined>;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

export interface FocusSnapshot {
  /** Valor de `data-focus-key`: es lo que empareja el campo viejo con el nuevo. */
  key: string;
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Nombre del atributo, en las dos formas en que hace falta escribirlo. */
export const FOCUS_KEY_ATTRIBUTE = 'data-focus-key';
export const FOCUS_KEY_DATASET = 'focusKey';

/** Clave de un campo, o `null` si no está marcado para conservar el foco. */
export function focusKeyOf(field: FocusableField | null | undefined): string | null {
  const key = field?.dataset[FOCUS_KEY_DATASET];
  return typeof key === 'string' && key !== '' ? key : null;
}

/**
 * Foto del campo enfocado.
 *
 * Sin clave no hay foto: que el foco esté en un botón del panel —o en la terminal, que es otro
 * inquilino de la ventana— no debe provocar ninguna restauración después.
 */
export function captureFocus(field: FocusableField | null | undefined): FocusSnapshot | null {
  const key = focusKeyOf(field);
  if (key === null || !field) return null;

  const value = field.value;
  // `selectionStart` es `null` en los tipos de input que no admiten selección (`number`, `email`).
  // Ahí lo honesto es dejar el cursor al final, que es donde lo deja el navegador al enfocar.
  const start = field.selectionStart ?? value.length;
  const end = field.selectionEnd ?? start;

  return { key, value, selectionStart: Math.min(start, end), selectionEnd: Math.max(start, end) };
}

/**
 * Acota una posición al texto que hay ahora.
 *
 * Hace falta porque entre la foto y la restauración el valor puede haber encogido: el repintado
 * construye el campo desde el estado de la vista, y ese estado puede venir de otro sitio (un
 * "limpiar", una búsqueda que se resetea). Poner el cursor en la posición 12 de un texto de 3
 * caracteres no es un error de bulto en el navegador —lo acota solo—, pero sí lo es razonar sobre
 * ello, así que se acota aquí y se prueba.
 */
export function clampPosition(position: number, length: number): number {
  if (Number.isNaN(position) || position < 0) return 0;
  return Math.min(Math.trunc(position), length);
}

/**
 * Devuelve el foco y el cursor al campo recién pintado.
 *
 * Devuelve `true` si ha restaurado algo, para que quien llama pueda distinguir "no había nada que
 * restaurar" de "el campo ya no está".
 *
 * **El valor no se toca.** El campo nuevo lo pinta la vista desde su propio estado, y ese estado es
 * la verdad; sobrescribirlo con el de la foto reviviría un texto que el usuario ya había cambiado.
 * La foto sólo manda sobre la selección, y sólo mientras el texto siga siendo el mismo: si el
 * repintado trae otro texto, el cursor se va al final, que es lo que espera cualquiera que acabe de
 * ver cambiar el contenido de la caja.
 */
export function restoreFocus(snapshot: FocusSnapshot | null, field: FocusableField | null | undefined): boolean {
  if (snapshot === null || !field) return false;
  if (focusKeyOf(field) !== snapshot.key) return false;

  field.focus();

  const length = field.value.length;
  if (field.value === snapshot.value) {
    field.setSelectionRange(
      clampPosition(snapshot.selectionStart, length),
      clampPosition(snapshot.selectionEnd, length),
    );
  } else {
    field.setSelectionRange(length, length);
  }

  return true;
}
