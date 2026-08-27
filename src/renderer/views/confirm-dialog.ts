/**
 * Diálogo modal propio, asíncrono.
 *
 * Sustituye a `window.confirm`, que en Electron tiene un defecto que no se ve hasta que muerde:
 * **es síncrono y bloquea el hilo del renderer entero**. Mientras está abierto no se atiende IPC,
 * no se repinta, no llegan los eventos de las tareas en marcha y —lo más desconcertante— la
 * ventana no se puede cerrar: el aspa no hace nada hasta contestar. Además lo pinta Chromium, así
 * que aparece con su propio tipo de letra y sus propios botones en mitad de un IDE que no se
 * parece en nada.
 *
 * El coste de arreglarlo es tener que devolver el foco a mano, que es justo la otra mitad del
 * fallo que se corrige aquí: al cerrarse un modal, el `<textarea>` oculto sobre el que Monaco
 * escucha el teclado **no** recupera el foco solo. El editor se queda mirando, aceptando las teclas
 * que el navegador trata como comandos (Retroceso, Suprimir, las flechas) y descartando las que
 * llegan como entrada de texto: escribir no hace nada y borrar sí. Este módulo devuelve el foco a
 * donde estaba antes de abrirse, y `EditorView` lo vuelve a poner en el editor en su `finally`, de
 * modo que ninguna de las dos partes depende de que la otra se acuerde.
 *
 * Se reutiliza el `#overlay` de siempre, como la paleta y el diálogo de perfiles de inicio: sólo
 * puede haber un modal a la vez y así no hay dos capas peleándose por el mismo hueco.
 *
 * Y el `detail` es casi siempre una **ruta de archivo**, que es el peor caso posible para un
 * contenedor flexible: una ruta de Windows no tiene ni un punto por donde partirla, así que la
 * columna de texto se negaba a encoger y el párrafo se salía del cuadro, con el `overflow: hidden`
 * del diálogo cortándolo a media ruta. Se arregla en el CSS (`min-width: 0` en la columna,
 * `overflow-wrap: anywhere` y un alto máximo con desplazamiento) y aquí con el `title`, que la da
 * entera pase lo que pase.
 */
import { byId, clear, el } from '../dom.js';
import { icon, type IconName } from '../icons.js';

/**
 * Respuesta de un diálogo.
 *
 * `alternate` es el tercer botón, el que hace falta cuando "no" y "cancelar" no son lo mismo:
 * cerrar el IDE con cambios sin guardar admite guardar, no guardar y quedarse, y con dos botones
 * hay que elegir cuál de las tres se le niega al usuario.
 */
export type DialogChoice = 'confirm' | 'alternate' | 'cancel';

export interface DialogOptions {
  title: string;
  message: string;
  /** Texto del botón que confirma. Debe decir qué va a pasar, no "Aceptar". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Tercer botón. Si no se indica, el diálogo tiene dos. */
  alternateLabel?: string;
  /** `danger` para lo que destruye algo (cerrar sin guardar, descartar cambios). */
  tone?: 'danger' | 'normal';
  icon?: IconName;
  /** Segunda línea, en pequeño: la consecuencia concreta, si conviene decirla. */
  detail?: string;
}

/**
 * Abre el diálogo y resuelve con la respuesta.
 *
 * **Nunca rechaza.** Escape, el clic fuera del cuadro y el botón de cancelar son la misma
 * respuesta; una excepción aquí dejaría al llamante sin saber si tiene que restaurar nada.
 */
export function askDialog(options: DialogOptions): Promise<DialogChoice> {
  const overlay = byId('overlay');

  // Quién tenía el foco antes: es a quien hay que devolvérselo, y no siempre es el editor (puede
  // ser el aspa de una pestaña o un botón del panel).
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  return new Promise<DialogChoice>((resolve) => {
    let answered = false;

    /**
     * Cierra el modal y contesta, una sola vez.
     *
     * El pestillo `answered` no es defensivo por costumbre: cancelar con Escape mientras el ratón
     * ya ha empezado un clic fuera del cuadro dispara los dos caminos, y sin él la promesa se
     * resolvería dos veces y el `overlay` se limpiaría sobre un contenido que ya no es el suyo.
     */
    const finish = (answer: DialogChoice): void => {
      if (answered) return;
      answered = true;

      overlay.hidden = true;
      overlay.className = 'overlay';
      overlay.onkeydown = null;
      overlay.onmousedown = null;
      clear(overlay);

      // Antes de resolver: quien esté esperando la respuesta va a mover el foco, y hacerlo después
      // se lo quitaría de las manos.
      previous?.focus();
      resolve(answer);
    };

    clear(overlay);
    overlay.hidden = false;
    overlay.className = 'overlay center';

    const confirm = el('button', {
      className: `btn ${options.tone === 'danger' ? 'danger' : 'primary'}`,
      text: options.confirmLabel ?? 'Aceptar',
      on: { click: () => finish('confirm') },
    });

    const alternate =
      options.alternateLabel === undefined
        ? null
        : el('button', {
            className: 'btn',
            text: options.alternateLabel,
            on: { click: () => finish('alternate') },
          });

    const cancel = el('button', {
      className: 'btn ghost',
      text: options.cancelLabel ?? 'Cancelar',
      on: { click: () => finish('cancel') },
    });

    const dialog = el(
      'div',
      { className: 'dialog confirm-dialog', role: 'dialog', attrs: { 'aria-modal': 'true' } },
      el(
        'div',
        { className: 'dialog-header' },
        el(
          'span',
          { className: `dialog-mark${options.tone === 'danger' ? ' danger' : ''}` },
          icon(options.icon ?? 'alert-circle', { size: 20 }),
        ),
        el(
          'div',
          {},
          el('h2', { text: options.title }),
          el('p', { text: options.message }),
          // El `title` lleva el detalle entero. Con la ventana estrecha, la ruta se lee partida en
          // varias líneas y con desplazamiento; el tooltip la da de una pieza, que es lo que hace
          // falta para copiarla o para reconocerla de un vistazo.
          options.detail
            ? el('p', { className: 'confirm-detail', title: options.detail, text: options.detail })
            : null,
        ),
      ),
      el('div', { className: 'dialog-footer' }, el('span', { className: 'spacer' }), cancel, alternate, confirm),
    );

    /**
     * Escape cancela; Enter lo resuelve el botón que tenga el foco, por su cuenta.
     *
     * No hay un "Enter confirma" global a propósito: convertiría el foco prudente de un diálogo
     * destructivo en un adorno, porque un Enter a ciegas seguiría cerrando sin guardar.
     *
     * Tab se queda dentro del cuadro. Sin eso, tabular saca el foco al editor de debajo —que está
     * tapado por el modal pero sigue siendo enfocable— y el diálogo pasa a no responder al teclado
     * sin que se vea por qué.
     */
    const order = [cancel, ...(alternate ? [alternate] : []), confirm];

    overlay.onkeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('cancel');
        return;
      }

      if (event.key !== 'Tab') return;

      event.preventDefault();
      const index = order.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.shiftKey ? -1 : 1;
      order[(Math.max(index, 0) + delta + order.length) % order.length]?.focus();
    };

    // Pulsar fuera del cuadro es cancelar, nunca confirmar: lo que se pierde con un clic
    // despistado tiene que ser nada.
    overlay.onmousedown = (event: MouseEvent) => {
      if (event.target === overlay) finish('cancel');
    };

    overlay.appendChild(dialog);

    // El foco entra en el botón que **no** destruye nada: así un Enter a ciegas —el reflejo de
    // quien viene de escribir— no borra el trabajo de nadie.
    (options.tone === 'danger' ? cancel : confirm).focus();
  });
}

/** Diálogo de dos botones. Es el caso normal, y así el llamante no compara cadenas. */
export async function confirmDialog(options: Omit<DialogOptions, 'alternateLabel'>): Promise<boolean> {
  return (await askDialog(options)) === 'confirm';
}
