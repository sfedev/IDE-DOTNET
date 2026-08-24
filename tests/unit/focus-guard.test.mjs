/**
 * Pruebas de la conservación del foco al repintar.
 *
 * El síntoma: al hacer una pausa breve escribiendo en la búsqueda de NuGet o en la de extensiones,
 * el cursor desaparecía y las letras siguientes se perdían. La causa no era el rebote —el rebote
 * está bien y es necesario— sino lo que el rebote dispara: la vista vacía su contenedor y lo
 * reconstruye, y el `<input>` enfocado es uno de los nodos que se destruyen.
 *
 * Estas reglas están fuera del DOM a propósito. Lo que hay que probar no es que el navegador sepa
 * enfocar, sino las decisiones: qué campos participan, qué se anota y —lo que de verdad muerde—
 * qué se hace cuando el texto ha cambiado entre la foto y la restauración.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureFocus,
  clampPosition,
  focusKeyOf,
  FOCUS_KEY_ATTRIBUTE,
  FOCUS_KEY_DATASET,
  restoreFocus,
} from '../../build/ui-lib.mjs';

/** Doble de un `<input>`: lo justo que consume `focus-guard`, más un registro de lo que le pasa. */
function field({ key, value = '', start = null, end = null } = {}) {
  return {
    dataset: key === undefined ? {} : { [FOCUS_KEY_DATASET]: key },
    value,
    selectionStart: start,
    selectionEnd: end,
    focused: 0,
    range: null,
    focus() {
      this.focused++;
    },
    setSelectionRange(from, to) {
      this.range = [from, to];
      this.selectionStart = from;
      this.selectionEnd = to;
    },
  };
}

describe('qué campos participan', () => {
  it('el atributo y la propiedad del dataset son la misma cosa escrita de dos formas', () => {
    assert.equal(FOCUS_KEY_ATTRIBUTE, 'data-focus-key');
    assert.equal(FOCUS_KEY_DATASET, 'focusKey');
  });

  it('un campo sin marcar no participa', () => {
    assert.equal(focusKeyOf(field()), null);
    assert.equal(captureFocus(field({ value: 'Serilog', start: 3, end: 3 })), null);
  });

  it('una clave vacía cuenta como no marcado', () => {
    assert.equal(focusKeyOf(field({ key: '' })), null);
  });

  it('sin campo enfocado no hay nada que anotar', () => {
    assert.equal(captureFocus(null), null);
    assert.equal(captureFocus(undefined), null);
    assert.equal(focusKeyOf(null), null);
  });
});

describe('la foto del campo enfocado', () => {
  it('anota clave, texto y selección', () => {
    const snapshot = captureFocus(field({ key: 'nuget-search', value: 'Serilog', start: 3, end: 3 }));
    assert.deepEqual(snapshot, { key: 'nuget-search', value: 'Serilog', selectionStart: 3, selectionEnd: 3 });
  });

  it('normaliza una selección hecha hacia atrás', () => {
    // Seleccionar de derecha a izquierda deja `selectionStart` > `selectionEnd` en algunos motores.
    const snapshot = captureFocus(field({ key: 'k', value: 'Serilog', start: 6, end: 2 }));
    assert.equal(snapshot.selectionStart, 2);
    assert.equal(snapshot.selectionEnd, 6);
  });

  it('un campo sin selección deja el cursor al final, que es donde lo deja el navegador', () => {
    // Los `input` de tipo `number` o `email` devuelven `null` en `selectionStart`.
    const snapshot = captureFocus(field({ key: 'k', value: 'Serilog', start: null, end: null }));
    assert.equal(snapshot.selectionStart, 7);
    assert.equal(snapshot.selectionEnd, 7);
  });
});

describe('la restauración', () => {
  it('devuelve el foco y el cursor al campo equivalente del repintado', () => {
    const snapshot = captureFocus(field({ key: 'nuget-search', value: 'Serilo', start: 6, end: 6 }));
    const fresh = field({ key: 'nuget-search', value: 'Serilo' });

    assert.equal(restoreFocus(snapshot, fresh), true);
    assert.equal(fresh.focused, 1);
    assert.deepEqual(fresh.range, [6, 6]);
  });

  it('conserva una selección, no sólo la posición del cursor', () => {
    const snapshot = captureFocus(field({ key: 'k', value: 'Microsoft.Extensions', start: 0, end: 9 }));
    const fresh = field({ key: 'k', value: 'Microsoft.Extensions' });

    restoreFocus(snapshot, fresh);
    assert.deepEqual(fresh.range, [0, 9]);
  });

  it('no revive el texto de la foto: manda el que trae el repintado', () => {
    const snapshot = captureFocus(field({ key: 'k', value: 'Serilo', start: 6, end: 6 }));
    const fresh = field({ key: 'k', value: 'Serilog' });

    restoreFocus(snapshot, fresh);
    assert.equal(fresh.value, 'Serilog');
  });

  it('si el texto ha cambiado, el cursor se va al final', () => {
    // Es el caso de un repintado que trae otro contenido (un "limpiar", una búsqueda que se
    // resetea). Dejar el cursor en la posición vieja lo pondría en mitad de un texto que el
    // usuario no ha escrito.
    const snapshot = captureFocus(field({ key: 'k', value: 'Serilog.Sinks.Console', start: 4, end: 4 }));
    const fresh = field({ key: 'k', value: '' });

    restoreFocus(snapshot, fresh);
    assert.deepEqual(fresh.range, [0, 0]);
  });

  it('no restaura en un campo con otra clave', () => {
    const snapshot = captureFocus(field({ key: 'nuget-search', value: 'x', start: 1, end: 1 }));
    const other = field({ key: 'extensions-search', value: 'x' });

    assert.equal(restoreFocus(snapshot, other), false);
    assert.equal(other.focused, 0);
  });

  it('sin foto o sin campo no hace nada, y lo dice', () => {
    assert.equal(restoreFocus(null, field({ key: 'k' })), false);
    assert.equal(restoreFocus({ key: 'k', value: '', selectionStart: 0, selectionEnd: 0 }, null), false);
  });
});

describe('acotar la posición del cursor', () => {
  it('no se sale del texto que hay ahora', () => {
    assert.equal(clampPosition(12, 3), 3);
    assert.equal(clampPosition(2, 3), 2);
    assert.equal(clampPosition(3, 3), 3);
  });

  it('no admite negativos ni basura', () => {
    assert.equal(clampPosition(-4, 10), 0);
    assert.equal(clampPosition(Number.NaN, 10), 0);
    // Infinito es "más allá del final", y el final es el final.
    assert.equal(clampPosition(Number.POSITIVE_INFINITY, 10), 10);
  });
});
