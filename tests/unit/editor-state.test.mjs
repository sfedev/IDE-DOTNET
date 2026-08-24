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
  DIFF_MESSAGE,
  EMPTY_CONTEXT,
  isReadOnly,
  NO_FILE_MESSAGE,
  PendingOperations,
  readOnlyMessage,
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
