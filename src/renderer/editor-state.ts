/**
 * Cuándo se puede escribir en el editor, y por qué no cuando no se puede.
 *
 * El motivo de que esto exista como regla explícita, y no como una suposición repartida por
 * `EditorView`: el estado de sólo lectura de Monaco es **pegajoso**. `updateOptions({ readOnly })`
 * no se deshace solo, no lo revisa nadie y no deja rastro; si algo lo enciende y el camino que
 * debía apagarlo muere por una excepción, el editor se queda mudo para el resto de la sesión. El
 * usuario ve algo desconcertante —el cursor se mueve, Retroceso borra, pero las letras nuevas no
 * entran— y lo único que lo arregla es reiniciar el IDE.
 *
 * La respuesta no es cazar el camino que lo enciende: es **no dejar nunca que el valor sea una
 * suposición**. `EditorView.refreshEditability()` recalcula desde aquí en cada punto de control
 * (montar, abrir, activar, cerrar, entrar y salir de una comparación, y el `finally` de cada
 * operación asíncrona), así que cualquier bloqueo que se cuele dura, como mucho, hasta el siguiente
 * cambio de pestaña.
 *
 * Puro y sin DOM: la regla se prueba con Node pelado.
 */

export interface EditorContext {
  /** Hay una pestaña de archivo activa. */
  hasOpenFile: boolean;
  /** Lo que se está enseñando es una comparación, no un archivo. */
  showingDiff: boolean;
  /**
   * Operaciones asíncronas en curso que el editor tiene que sobrevivir.
   *
   * **No bloquean la escritura**, y eso es deliberado: formatear al guardar tarda lo que tarde el
   * servidor de lenguaje, y prohibir teclear durante ese rato sería un remedio peor que la
   * enfermedad. Están aquí porque su `finally` es uno de los puntos donde se recalcula el estado, y
   * porque tenerlas contadas es lo que permite afirmar en una prueba que un fallo asíncrono no deja
   * nada colgado.
   */
  pending: readonly string[];
}

export const NO_FILE_MESSAGE = 'No hay ningún archivo abierto.';
export const DIFF_MESSAGE = 'La comparación es de sólo lectura. Abre el archivo para editarlo.';

/**
 * Contexto de un editor recién montado: sin archivo y sin nada en vuelo.
 *
 * Existe para que las pruebas —y `EditorView.mount`— partan del mismo sitio en vez de repetir el
 * literal.
 */
export const EMPTY_CONTEXT: EditorContext = { hasOpenFile: false, showingDiff: false, pending: [] };

/**
 * Sólo dos cosas hacen el editor de sólo lectura, y las dos son estructurales: que no haya archivo
 * y que lo que se esté enseñando sea una comparación. Ni un error de red, ni un servidor de
 * lenguaje caído, ni un formateo a medias.
 */
export function isReadOnly(context: EditorContext): boolean {
  return !context.hasOpenFile || context.showingDiff;
}

/**
 * Qué decirle a quien intenta escribir.
 *
 * Monaco lo enseña en un aviso flotante al primer intento (`readOnlyMessage`). Un editor que no
 * acepta lo que se teclea y no dice nada es exactamente el fallo que se está arreglando: si alguna
 * vez vuelve a bloquearse, que al menos diga por qué.
 */
export function readOnlyMessage(context: EditorContext): string | null {
  if (context.showingDiff) return DIFF_MESSAGE;
  if (!context.hasOpenFile) return NO_FILE_MESSAGE;
  return null;
}

/**
 * Lleva la cuenta de las operaciones asíncronas en vuelo.
 *
 * `begin` devuelve la función que hay que llamar en el `finally`, y llamarla dos veces no descuenta
 * dos veces: un contador que se puede desequilibrar no sirve para razonar sobre nada.
 */
export class PendingOperations {
  private readonly counts = new Map<string, number>();

  begin(name: string): () => void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const left = (this.counts.get(name) ?? 1) - 1;
      if (left <= 0) this.counts.delete(name);
      else this.counts.set(name, left);
    };
  }

  /** Nombres en vuelo, ordenados, para que el contexto sea comparable en una prueba. */
  names(): string[] {
    return [...this.counts.keys()].sort();
  }

  get size(): number {
    return this.counts.size;
  }
}

/** Texto del aviso al cerrar una pestaña con cambios sin guardar. */
export function unsavedChangesMessage(name: string): string {
  return `"${name}" tiene cambios sin guardar. Si cierras la pestaña, se pierden.`;
}

/**
 * Cerrojo de las confirmaciones modales del gestor de pestañas.
 *
 * Existe por dos fallos distintos que compartían causa: **una confirmación que no se suelta**.
 *
 *  1. `window.confirm` es síncrono y bloquea el hilo del renderer entero mientras está abierto. Con
 *     él en pantalla, el IDE no atiende IPC, no repinta y **no puede cerrarse**: el aspa de la
 *     ventana no hacía nada hasta contestar. Un diálogo propio es asíncrono y no tiene ese problema,
 *     pero hereda el otro.
 *  2. Dos confirmaciones a la vez. Cerrar todas las pestañas al cerrar la solución, o pulsar el aspa
 *     de la ventana mientras ya hay un aviso abierto, apilaba diálogos sobre el mismo editor. El
 *     segundo se quedaba sin quien lo cerrase y el editor no volvía a recibir el teclado.
 *
 * La regla es una sola: **hay como mucho una confirmación abierta, y el cerrojo se suelta pase lo
 * que pase**. Si llega otra mientras hay una en curso, se contesta con el valor prudente (`busy`)
 * en vez de encolarse; encolar diálogos es lo que produce la pila de la que no se sale.
 *
 * Puro y sin DOM: la garantía —"pase lo que pase, se suelta"— se prueba con Node pelado.
 */
export class ConfirmationLock {
  private busy = false;

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Ejecuta la confirmación con el cerrojo tomado.
   *
   * @param ask     lo que abre el diálogo y resuelve con la respuesta.
   * @param whenBusy qué contestar si ya hay una confirmación abierta.
   *
   * El `finally` suelta el cerrojo también cuando `ask` **lanza**, que es el caso que importa: un
   * fallo pintando el diálogo dejaría, si no, todas las pestañas siguientes sin poder cerrarse y
   * sin ningún error visible.
   */
  async run<T>(ask: () => Promise<T>, whenBusy: T): Promise<T> {
    if (this.busy) return whenBusy;

    this.busy = true;
    try {
      return await ask();
    } finally {
      this.busy = false;
    }
  }
}
