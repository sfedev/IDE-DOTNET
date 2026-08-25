/**
 * Pruebas del estado de escritura del editor.
 *
 * El síntoma del que salen: de vez en cuando el editor dejaba de admitir texto nuevo pero seguía
 * permitiendo borrar. Es la firma exacta de un `readOnly` a medias, y `readOnly` en Monaco es
 * pegajoso: se enciende con `updateOptions` y no se apaga solo. Un camino asíncrono que lo
 * encienda y muera por una excepción antes de apagarlo deja el editor mudo el resto de la sesión.
 *
 * La defensa no es buscar quién lo enciende —eso vale para el código de hoy—, sino no dejar que el
 * valor sea nunca una suposición: se **recalcula** desde estas reglas en cada punto de control, y
 * el `finally` de toda operación asíncrona es uno de ellos. Aquí se prueban las reglas y el
 * contador de operaciones en vuelo, que es lo que garantiza que un fallo no deja nada colgado.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfirmationLock,
  DIFF_MESSAGE,
  EMPTY_CONTEXT,
  isReadOnly,
  NO_FILE_MESSAGE,
  PendingOperations,
  readOnlyMessage,
  unsavedChangesMessage,
} from '../../build/ui-lib.mjs';

const context = (overrides = {}) => ({ hasOpenFile: true, showingDiff: false, pending: [], ...overrides });

describe('cuándo el editor es de sólo lectura', () => {
  it('un editor recién montado, sin archivo, no se puede escribir', () => {
    assert.equal(isReadOnly(EMPTY_CONTEXT), true);
    assert.equal(readOnlyMessage(EMPTY_CONTEXT), NO_FILE_MESSAGE);
  });

  it('con un archivo abierto se escribe', () => {
    assert.equal(isReadOnly(context()), false);
    assert.equal(readOnlyMessage(context()), null);
  });

  it('una comparación es de sólo lectura, y lo dice (ADR-021)', () => {
    const showing = context({ showingDiff: true });
    assert.equal(isReadOnly(showing), true);
    assert.equal(readOnlyMessage(showing), DIFF_MESSAGE);
  });

  it('la comparación manda sobre el archivo abierto detrás', () => {
    // Abrir una comparación no cierra la pestaña del archivo: las dos condiciones conviven, y la
    // que se está enseñando es la que decide.
    assert.equal(readOnlyMessage(context({ hasOpenFile: true, showingDiff: true })), DIFF_MESSAGE);
  });

  /**
   * La regla que arregla el fallo: **nada asíncrono bloquea la escritura**.
   *
   * Ni guardar, ni formatear, ni el servidor de lenguaje, ni el linter de arquitectura. Si algún
   * día hiciera falta bloquear durante una operación, tendría que declararse aquí y pasar por este
   * mismo recálculo, que es lo que garantiza que se desbloquea aunque la operación reviente.
   */
  it('ninguna operación en vuelo bloquea la escritura', () => {
    for (const pending of [['saving'], ['formatting'], ['saving', 'formatting']]) {
      assert.equal(isReadOnly(context({ pending })), false, pending.join('+'));
      assert.equal(readOnlyMessage(context({ pending })), null);
    }
  });

  it('sin archivo sigue sin poder escribirse aunque no haya nada en vuelo', () => {
    assert.equal(isReadOnly(context({ hasOpenFile: false })), true);
  });
});

describe('operaciones asíncronas en vuelo', () => {
  it('empieza vacío', () => {
    assert.deepEqual(new PendingOperations().names(), []);
  });

  it('cuenta lo que hay en vuelo y lo suelta al terminar', () => {
    const pending = new PendingOperations();
    const done = pending.begin('saving');

    assert.deepEqual(pending.names(), ['saving']);
    done();
    assert.deepEqual(pending.names(), []);
  });

  it('dos guardados a la vez no se pisan: el primero en terminar no borra al otro', () => {
    const pending = new PendingOperations();
    const first = pending.begin('saving');
    const second = pending.begin('saving');

    first();
    assert.deepEqual(pending.names(), ['saving'], 'todavía queda uno en vuelo');
    second();
    assert.deepEqual(pending.names(), []);
  });

  it('soltar dos veces la misma operación no descuenta de más', () => {
    // Un `finally` que se ejecuta y un camino de error que también suelta: pasa, y un contador que
    // se puede desequilibrar deja de servir para razonar sobre nada.
    const pending = new PendingOperations();
    const outer = pending.begin('saving');
    const inner = pending.begin('saving');

    inner();
    inner();
    assert.deepEqual(pending.names(), ['saving']);

    outer();
    assert.deepEqual(pending.names(), []);
  });

  it('los nombres salen ordenados, para que el contexto sea comparable', () => {
    const pending = new PendingOperations();
    pending.begin('saving');
    pending.begin('formatting');

    assert.deepEqual(pending.names(), ['formatting', 'saving']);
    assert.equal(pending.size, 2);
  });

  /**
   * La propiedad que de verdad importa: pase lo que pase dentro, el `finally` suelta. Se ejercita
   * con la misma forma que tiene `EditorView.save`.
   */
  it('una operación que falla suelta igual, y el editor vuelve a ser escribible', async () => {
    const pending = new PendingOperations();

    const attempt = async () => {
      const done = pending.begin('saving');
      try {
        throw new Error('EBUSY: el archivo lo tiene abierto MSBuild');
      } finally {
        done();
      }
    };

    await assert.rejects(attempt, /EBUSY/);
    assert.deepEqual(pending.names(), []);
    assert.equal(isReadOnly(context({ pending: pending.names() })), false);
  });
});

/**
 * Cerrojo de las confirmaciones de cierre (ADR-058).
 *
 * El síntoma: al cerrar una pestaña con cambios sin guardar y contestar al aviso —diera igual
 * Aceptar o Cancelar—, el editor se quedaba sin recibir el teclado hasta reiniciar la aplicación.
 * Dos causas sumadas: `window.confirm` es síncrono y bloquea el renderer entero (con él abierto ni
 * siquiera se podía cerrar la ventana), y el foco no vuelve solo al editor al cerrarse un modal.
 *
 * Lo que se puede probar sin ventana es la garantía estructural, que es la que se rompía en
 * silencio: el cerrojo se suelta **pase lo que pase**, así que ninguna respuesta —ni un fallo—
 * puede dejar el gestor de pestañas sin poder volver a preguntar.
 */
describe('cerrojo de las confirmaciones de cierre', () => {
  it('empieza libre', () => {
    assert.equal(new ConfirmationLock().isBusy(), false);
  });

  it('deja pasar la confirmación y devuelve su respuesta', async () => {
    const lock = new ConfirmationLock();
    assert.equal(await lock.run(async () => true, false), true);
    assert.equal(lock.isBusy(), false, 'el cerrojo queda libre para la siguiente pestaña');
  });

  it('está tomado mientras el diálogo está abierto', async () => {
    const lock = new ConfirmationLock();
    let dentro = null;

    await lock.run(async () => {
      dentro = lock.isBusy();
      return true;
    }, false);

    assert.equal(dentro, true);
  });

  it('una segunda confirmación no apila otro modal: contesta lo prudente', async () => {
    // Es el caso del aspa de la ventana pulsada mientras ya hay un aviso de pestaña abierto. El
    // segundo diálogo se quedaba sin quien lo cerrase, y con él el teclado del editor.
    const lock = new ConfirmationLock();
    let abiertos = 0;

    const primera = lock.run(async () => {
      abiertos++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    }, false);

    const segunda = await lock.run(async () => {
      abiertos++;
      return true;
    }, false);

    assert.equal(segunda, false, 'la respuesta prudente es no cerrar');
    assert.equal(await primera, true);
    assert.equal(abiertos, 1, 'sólo se abrió un diálogo');
  });

  /**
   * La propiedad que de verdad importa. Un fallo pintando el diálogo dejaría, si no, todas las
   * pestañas siguientes sin poder cerrarse y sin ningún error visible.
   */
  it('un diálogo que revienta suelta el cerrojo igual', async () => {
    const lock = new ConfirmationLock();

    await assert.rejects(
      () => lock.run(async () => { throw new Error('falta #overlay en index.html'); }, false),
      /overlay/,
    );

    assert.equal(lock.isBusy(), false);
    assert.equal(await lock.run(async () => true, false), true, 'la siguiente pestaña sí puede preguntar');
  });

  it('el cerrojo sirve para cualquier tipo de respuesta, no sólo para un booleano', async () => {
    // El aviso de cierre de la ventana tiene tres botones: guardar y cerrar, cerrar sin guardar y
    // seguir editando. El valor prudente ahí es "cancel", no `false`.
    const lock = new ConfirmationLock();
    const enCurso = lock.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'confirm';
    }, 'cancel');

    assert.equal(await lock.run(async () => 'confirm', 'cancel'), 'cancel');
    assert.equal(await enCurso, 'confirm');
  });
});

describe('texto del aviso de cambios sin guardar', () => {
  it('nombra el archivo y dice qué se pierde', () => {
    const message = unsavedChangesMessage('Product.cs');
    assert.match(message, /Product\.cs/);
    assert.match(message, /se pierden/);
  });
});
