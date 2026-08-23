/**
 * Pruebas del motor de plantillas.
 *
 * Cada aserción tiene un modo de fallo real: si el motor deja de ser estricto, si los
 * condicionales dejan de anidar o si la normalización de saltos cambia, esto se pone en rojo.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectTemplate,
  normalizeOutput,
  parseTemplate,
  renderPath,
  renderTemplate,
  TemplateError,
} from '../../build/scaffold.mjs';

const ctx = (tokens = {}, flags = {}) => ({ tokens, flags });

describe('renderTemplate — sustitución de tokens', () => {
  it('sustituye un token simple', () => {
    assert.equal(renderTemplate('Hola {{Name}}', ctx({ Name: 'Mundo' })), 'Hola Mundo\n');
  });

  it('admite espacios dentro de las llaves', () => {
    assert.equal(renderTemplate('{{  Name  }}', ctx({ Name: 'X' })), 'X\n');
  });

  it('sustituye el mismo token varias veces', () => {
    assert.equal(renderTemplate('{{A}}-{{A}}-{{A}}', ctx({ A: 'z' })), 'z-z-z\n');
  });

  it('convierte los números a texto', () => {
    assert.equal(renderTemplate('puerto {{Port}}', ctx({ Port: 5080 })), 'puerto 5080\n');
  });

  it('acepta la cadena vacía como valor válido', () => {
    assert.equal(renderTemplate('[{{A}}]', ctx({ A: '' })), '[]\n');
  });

  it('falla con un token desconocido e indica la línea', () => {
    assert.throws(
      () => renderTemplate('linea1\nlinea2 {{Falta}}', ctx({ Otro: 1 })),
      (error) => {
        assert.ok(error instanceof TemplateError);
        assert.match(error.message, /token desconocido "Falta"/);
        assert.match(error.message, /línea 2/);
        return true;
      },
    );
  });

  it('enumera los tokens disponibles al fallar, para poder corregir el typo', () => {
    assert.throws(
      () => renderTemplate('{{Solucion}}', ctx({ Solution: 'X', Entity: 'Y' })),
      /Tokens disponibles: Entity, Solution/,
    );
  });
});

describe('renderTemplate — condicionales', () => {
  it('incluye la rama verdadera', () => {
    assert.equal(renderTemplate('{{#if on}}si{{/if}}', ctx({}, { on: true })), 'si\n');
  });

  it('omite la rama falsa', () => {
    assert.equal(renderTemplate('a{{#if on}}si{{/if}}b', ctx({}, { on: false })), 'ab\n');
  });

  it('resuelve el else', () => {
    const source = '{{#if on}}A{{else}}B{{/if}}';
    assert.equal(renderTemplate(source, ctx({}, { on: false })), 'B\n');
    assert.equal(renderTemplate(source, ctx({}, { on: true })), 'A\n');
  });

  it('invierte la condición con unless', () => {
    assert.equal(renderTemplate('{{#unless on}}no{{/unless}}', ctx({}, { on: false })), 'no\n');
    assert.equal(renderTemplate('x{{#unless on}}no{{/unless}}', ctx({}, { on: true })), 'x\n');
  });

  it('anida condicionales', () => {
    const source = '{{#if a}}A{{#if b}}B{{/if}}{{/if}}';
    assert.equal(renderTemplate(source, ctx({}, { a: true, b: true })), 'AB\n');
    assert.equal(renderTemplate(source, ctx({}, { a: true, b: false })), 'A\n');
    assert.equal(renderTemplate(source, ctx({}, { a: false, b: true })), '\n');
  });

  it('resuelve tokens dentro de una rama condicional', () => {
    assert.equal(
      renderTemplate('{{#if on}}v={{V}}{{/if}}', ctx({ V: 7 }, { on: true })),
      'v=7\n',
    );
  });

  it('no evalúa los tokens de la rama descartada', () => {
    // La rama falsa referencia un token inexistente: si se evaluara, esto lanzaría.
    assert.equal(
      renderTemplate('{{#if on}}ok{{else}}{{NoExiste}}{{/if}}', ctx({}, { on: true })),
      'ok\n',
    );
  });

  it('falla con un flag desconocido', () => {
    assert.throws(
      () => renderTemplate('{{#if noSeQue}}x{{/if}}', ctx({}, { otro: true })),
      /flag desconocido "noSeQue"/,
    );
  });

  it('falla si un condicional queda sin cerrar', () => {
    assert.throws(() => parseTemplate('{{#if a}}x'), /condicional sin cerrar/);
  });

  it('falla si el cierre no corresponde a la apertura', () => {
    assert.throws(() => parseTemplate('{{#if a}}x{{/unless}}'), /cierre incorrecto/);
  });

  it('falla con un cierre huérfano', () => {
    assert.throws(() => parseTemplate('x{{/if}}'), /sin apertura/);
  });

  it('falla con un else fuera de contexto', () => {
    assert.throws(() => parseTemplate('{{else}}'), /fuera de un condicional/);
  });

  it('falla con un else duplicado', () => {
    assert.throws(() => parseTemplate('{{#if a}}1{{else}}2{{else}}3{{/if}}'), /else\}\} duplicado/);
  });
});

describe('normalizeOutput', () => {
  it('colapsa tres o más saltos de línea en dos', () => {
    assert.equal(normalizeOutput('a\n\n\n\n\nb'), 'a\n\nb\n');
  });

  it('conserva un único salto doble', () => {
    assert.equal(normalizeOutput('a\n\nb'), 'a\n\nb\n');
  });

  it('elimina el espacio en blanco al final de línea', () => {
    assert.equal(normalizeOutput('a   \nb\t\n'), 'a\nb\n');
  });

  it('garantiza salto de línea final', () => {
    assert.equal(normalizeOutput('sin salto'), 'sin salto\n');
  });

  it('normaliza CRLF a LF', () => {
    assert.equal(normalizeOutput('a\r\nb'), 'a\nb\n');
  });
});

describe('renderPath', () => {
  it('sustituye tokens de ruta con el estilo __Token__', () => {
    assert.equal(
      renderPath('src/__Solution__.Domain/Entities/__Entity__.cs', {
        Solution: 'Acme.Shop',
        Entity: 'Product',
      }),
      'src/Acme.Shop.Domain/Entities/Product.cs',
    );
  });

  it('deja intacta una ruta sin tokens', () => {
    assert.equal(renderPath('src/Program.cs', {}), 'src/Program.cs');
  });

  it('falla con un token de ruta desconocido', () => {
    assert.throws(() => renderPath('__Falta__/x.cs', { Solution: 'A' }), /token de ruta desconocido/);
  });
});

describe('inspectTemplate', () => {
  it('lista tokens y flags, incluidos los de ramas anidadas', () => {
    const found = inspectTemplate('{{A}}{{#if f}}{{B}}{{#unless g}}{{C}}{{/unless}}{{/if}}');
    assert.deepEqual(found.tokens, ['A', 'B', 'C']);
    assert.deepEqual(found.flags, ['f', 'g']);
  });

  it('no duplica repeticiones', () => {
    assert.deepEqual(inspectTemplate('{{A}}{{A}}').tokens, ['A']);
  });
});
