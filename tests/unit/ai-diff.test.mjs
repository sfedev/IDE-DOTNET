/**
 * Pruebas del formateador de diferencias del asistente en línea.
 *
 * Son tres reglas con muchos casos borde y una consecuencia visible: si el bloque de código se
 * extrae mal, o se reindenta mal, o el diff marca líneas que no han cambiado, el usuario rechaza
 * una sugerencia buena por motivos que no tienen nada que ver con su calidad.
 *
 * Las respuestas de ejemplo son las que devuelve un modelo de verdad: prosa antes, prosa después,
 * vallas dentro de listas y respuestas cortadas a mitad por el tope de tokens.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  commonIndent,
  diffLines,
  extractCodeBlocks,
  formatUnifiedDiff,
  proposedCode,
  reindent,
  summarizeDiff,
} from '../../build/ui-lib.mjs';

const FENCE = '```';

// ---------------------------------------------------------------------------------------------

describe('extracción de bloques de código', () => {
  it('saca el bloque de una respuesta con prosa alrededor', () => {
    const answer = [
      'Esto se puede simplificar con LINQ:',
      `${FENCE}csharp`,
      'var total = items.Sum(item => item.Price);',
      FENCE,
      'Ten en cuenta que `Sum` recorre la colección una sola vez.',
    ].join('\n');

    const blocks = extractCodeBlocks(answer);

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, 'csharp');
    assert.equal(blocks[0].code, 'var total = items.Sum(item => item.Price);');
  });

  it('conserva varios bloques en orden', () => {
    const answer = [`${FENCE}bash`, 'dotnet build', FENCE, 'y luego:', `${FENCE}csharp`, 'var x = 1;', FENCE].join('\n');
    const blocks = extractCodeBlocks(answer);

    assert.deepEqual(
      blocks.map((block) => block.language),
      ['bash', 'csharp'],
    );
  });

  it('respeta la sangría de una valla dentro de una lista', () => {
    const answer = ['1. Cambia el método:', '', `   ${FENCE}csharp`, '   var x = 1;', `   ${FENCE}`].join('\n');
    assert.equal(extractCodeBlocks(answer)[0].code, 'var x = 1;');
  });

  it('no confunde una valla de tres con una de cuatro', () => {
    const answer = ['````markdown', `${FENCE}csharp`, 'var x = 1;', FENCE, '````'].join('\n');
    const blocks = extractCodeBlocks(answer);

    assert.equal(blocks.length, 1);
    assert.match(blocks[0].code, /var x = 1;/);
  });

  /** Una respuesta cortada por `max_tokens` deja la valla abierta: media sugerencia vale más que un error. */
  it('recupera un bloque sin cerrar', () => {
    const answer = [`${FENCE}csharp`, 'public sealed record Sku', '{'].join('\n');
    assert.equal(extractCodeBlocks(answer)[0].code, 'public sealed record Sku\n{');
  });

  it('un texto sin bloques no produce ninguno', () => {
    assert.deepEqual(extractCodeBlocks('No hace falta cambiar nada.'), []);
  });

  it('prefiere el bloque de un lenguaje de código sobre uno de salida de consola', () => {
    const answer = [
      'El compilador dice:',
      `${FENCE}text`,
      'CS0246: no se encuentra el tipo',
      FENCE,
      'Arréglalo así:',
      `${FENCE}csharp`,
      'using Acme.Shop.Domain;',
      FENCE,
    ].join('\n');

    assert.equal(proposedCode(answer), 'using Acme.Shop.Domain;');
  });

  it('sin bloque de código devuelve null en vez de tratar la prosa como código', () => {
    assert.equal(proposedCode('No veo ningún problema en este método.'), null);
    assert.equal(proposedCode(`${FENCE}csharp\n\n${FENCE}`), null);
  });
});

// ---------------------------------------------------------------------------------------------

describe('reindentación', () => {
  it('calcula la sangría común ignorando las líneas en blanco', () => {
    assert.equal(commonIndent('    var x = 1;\n\n    var y = 2;'), '    ');
    assert.equal(commonIndent('    if (a)\n    {\n        b();\n    }'), '    ');
    assert.equal(commonIndent('sin sangría'), '');
  });

  /**
   * El caso real: el modelo devuelve el método pegado al margen y hay que meterlo dentro de una
   * clase que está a dos niveles. Sin esto, el usuario ve un diff lleno de líneas mal colocadas.
   */
  it('lleva el código propuesto a la sangría del fragmento sustituido', () => {
    const original = ['        foreach (var item in items)', '        {', '            total += item.Price;', '        }'].join('\n');
    const proposal = ['var total = items.Sum(item => item.Price);', 'return total;'].join('\n');

    const result = reindent(original, proposal).split('\n');

    // La primera línea la coloca el editor: la selección ya empieza después de la sangría.
    assert.equal(result[0], 'var total = items.Sum(item => item.Price);');
    assert.equal(result[1], '        return total;');
  });

  it('quita la sangría sobrante del modelo antes de aplicar la del destino', () => {
    const original = '    var a = 1;';
    const proposal = ['        var a = 1;', '        var b = 2;'].join('\n');

    assert.equal(reindent(original, proposal), 'var a = 1;\n    var b = 2;');
  });

  /**
   * El mismo código seleccionado de dos formas distintas: desde la columna 1 (líneas completas) o
   * desde el primer carácter. Sin distinguirlas, `Ctrl+I` sobre líneas completas devolvía la
   * primera línea pegada al margen.
   */
  it('repone la sangría de la primera línea cuando la selección empezaba en la columna 1', () => {
    const original = '        var total = 0;';
    const proposal = 'var total = items.Sum(item => item.Price);';

    assert.equal(reindent(original, proposal, true), '        var total = items.Sum(item => item.Price);');
    assert.equal(reindent(original, proposal, false), 'var total = items.Sum(item => item.Price);');
  });

  it('las líneas en blanco no se rellenan con espacios', () => {
    const result = reindent('    x', 'a\n\nb').split('\n');
    assert.equal(result[1], '');
  });
});

// ---------------------------------------------------------------------------------------------

describe('diferencias línea a línea', () => {
  it('dos textos idénticos no producen ningún cambio', () => {
    const summary = summarizeDiff(diffLines('a\nb\nc', 'a\nb\nc'));
    assert.deepEqual(summary, { added: 0, removed: 0, identical: true });
  });

  it('marca sólo la línea que cambia y conserva el contexto', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc');

    assert.deepEqual(
      diff.map((line) => line.kind),
      ['context', 'remove', 'add', 'context'],
    );
    assert.deepEqual(summarizeDiff(diff), { added: 1, removed: 1, identical: false });
  });

  it('numera las líneas de cada lado', () => {
    const diff = diffLines('a\nb', 'a\nx\nb');
    const added = diff.find((line) => line.kind === 'add');

    assert.equal(added.text, 'x');
    assert.equal(added.beforeLine, null);
    assert.equal(added.afterLine, 2);

    const last = diff.at(-1);
    assert.equal(last.beforeLine, 2);
    assert.equal(last.afterLine, 3);
  });

  it('una inserción pura no marca nada como eliminado', () => {
    const summary = summarizeDiff(diffLines('a\nb', 'a\nnueva\nb'));
    assert.deepEqual(summary, { added: 1, removed: 0, identical: false });
  });

  it('un borrado puro no marca nada como añadido', () => {
    const summary = summarizeDiff(diffLines('a\nb\nc', 'a\nc'));
    assert.deepEqual(summary, { added: 0, removed: 1, identical: false });
  });

  it('reconoce el bloque común aunque se muevan líneas alrededor', () => {
    const before = ['using System;', '', 'public class A', '{', '}'].join('\n');
    const after = ['using System;', 'using System.Linq;', '', 'public class A', '{', '}'].join('\n');

    const diff = diffLines(before, after);
    assert.deepEqual(summarizeDiff(diff), { added: 1, removed: 0, identical: false });
    assert.equal(diff.find((line) => line.kind === 'add').text, 'using System.Linq;');
  });

  it('un fragmento enorme se degrada a reemplazo completo sin colgarse', () => {
    const before = Array.from({ length: 2000 }, (_, index) => `linea ${index}`).join('\n');
    const after = `${before}\nuna más`;

    const started = Date.now();
    const summary = summarizeDiff(diffLines(before, after));

    assert.equal(summary.removed, 2000);
    assert.equal(summary.added, 2001);
    assert.ok(Date.now() - started < 2000, 'el diff degradado ha tardado demasiado');
  });
});

describe('formato unificado', () => {
  const diff = diffLines(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n'),
    ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'].join('\n'),
  );

  it('marca cada línea con su signo', () => {
    const text = formatUnifiedDiff(diff);
    assert.match(text, /^ b/m);
    assert.match(text, /^-d/m);
    assert.match(text, /^\+D/m);
  });

  it('sólo enseña el contexto pedido alrededor del cambio', () => {
    const text = formatUnifiedDiff(diff, 1);
    assert.equal(text.includes('a'), false, `sobra contexto:\n${text}`);
    assert.match(text, /^ c/m);
  });

  it('separa los tramos distantes con un marcador', () => {
    const wide = diffLines(['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'), ['A', 'b', 'c', 'd', 'e', 'f', 'G'].join('\n'));
    assert.match(formatUnifiedDiff(wide, 1), /^@@$/m);
  });

  it('sin cambios no imprime nada', () => {
    assert.equal(formatUnifiedDiff(diffLines('a\nb', 'a\nb')), '');
  });
});
