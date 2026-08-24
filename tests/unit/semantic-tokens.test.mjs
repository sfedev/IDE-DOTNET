/**
 * Pruebas de la traducción de tokens semánticos.
 *
 * Es el único sitio del proyecto donde un error no falla: descodificar mal el array de LSP no
 * lanza ninguna excepción, sólo pinta el archivo con los colores cambiados a partir de un punto.
 * Por eso se prueba con datos reales —la leyenda que publica Roslyn, con sus nombres de
 * clasificación separados por espacios y guiones— y no con un caso de juguete.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_TOKEN_MODIFIERS,
  CLIENT_TOKEN_TYPES,
  decodeTokens,
  encodeTokens,
  legendFromCapabilities,
  normalizeTokenType,
  remapTokens,
  scopeForTokenType,
  SEMANTIC_SCOPES,
} from '../../build/ui-lib.mjs';

/** Leyenda con la forma de la de Roslyn: los estándar primero y los suyos después. */
const ROSLYN_LEGEND = {
  tokenTypes: [
    'namespace',
    'type',
    'class',
    'enum',
    'interface',
    'struct',
    'typeParameter',
    'parameter',
    'variable',
    'property',
    'enumMember',
    'event',
    'function',
    'method',
    'macro',
    'keyword',
    'modifier',
    'comment',
    'string',
    'number',
    'regexp',
    'operator',
    'class name',
    'keyword - control',
    'local name',
    'method name',
    'extension method name',
    'field name',
    'string - verbatim',
    'string - escape character',
    'xml doc comment - text',
    'record class name',
    'excluded code',
  ],
  tokenModifiers: ['declaration', 'static', 'documentation'],
};

describe('capacidades declaradas', () => {
  it('las dos listas van llenas: una lista vacía significa "no entiendo ningún token"', () => {
    assert.ok(CLIENT_TOKEN_TYPES.length > 15);
    assert.ok(CLIENT_TOKEN_MODIFIERS.length > 5);
  });

  it('los tipos estándar de LSP están todos declarados', () => {
    for (const expected of ['namespace', 'class', 'interface', 'method', 'property', 'keyword', 'string']) {
      assert.ok(CLIENT_TOKEN_TYPES.includes(expected), expected);
    }
  });
});

describe('normalizeTokenType', () => {
  it('quita separadores y el sufijo name', () => {
    assert.equal(normalizeTokenType('class name'), 'class');
    assert.equal(normalizeTokenType('extension method name'), 'extensionmethod');
    assert.equal(normalizeTokenType('keyword - control'), 'keywordcontrol');
    assert.equal(normalizeTokenType('record class name'), 'recordclass');
  });

  it('no rompe un nombre que ya está en forma canónica', () => {
    assert.equal(normalizeTokenType('interface'), 'interface');
    assert.equal(normalizeTokenType('enumMember'), 'enummember');
  });

  it('no se come el sufijo de un nombre que sólo es "name"', () => {
    assert.equal(normalizeTokenType('name'), 'name');
  });
});

describe('scopeForTokenType', () => {
  it('las clases, estructuras, enumeraciones y registros comparten el color de tipo', () => {
    for (const raw of ['class', 'class name', 'struct name', 'enum', 'record class name', 'delegate name']) {
      assert.equal(scopeForTokenType(raw), 'type', raw);
    }
  });

  it('la interfaz tiene su propio color', () => {
    assert.equal(scopeForTokenType('interface'), 'interface');
    assert.equal(scopeForTokenType('interface name'), 'interface');
  });

  it('los métodos y los de extensión son lo mismo para el color', () => {
    assert.equal(scopeForTokenType('method name'), 'method');
    assert.equal(scopeForTokenType('extension method name'), 'method');
  });

  it('separa la palabra clave de control del resto', () => {
    assert.equal(scopeForTokenType('keyword'), 'keyword');
    assert.equal(scopeForTokenType('keyword - control'), 'keyword.control');
    assert.equal(scopeForTokenType('controlKeyword'), 'keyword.control');
  });

  it('las locales y los parámetros no comparten ámbito, pero sí familia', () => {
    assert.equal(scopeForTokenType('local name'), 'variable');
    assert.equal(scopeForTokenType('parameter'), 'parameter');
  });

  it('la documentación XML y los literales de regex se reconocen por prefijo', () => {
    assert.equal(scopeForTokenType('xml doc comment - text'), 'comment.doc');
    assert.equal(scopeForTokenType('xml doc comment - attribute name'), 'comment.doc');
    assert.equal(scopeForTokenType('regex - anchor'), 'regexp');
  });

  it('lo que no se reconoce devuelve null y conserva el color de la gramática', () => {
    assert.equal(scopeForTokenType('excluded code'), null);
    assert.equal(scopeForTokenType('whitespace'), null);
    assert.equal(scopeForTokenType('punctuation'), null);
  });

  it('todo ámbito devuelto existe en la leyenda que se le da a Monaco', () => {
    for (const raw of ROSLYN_LEGEND.tokenTypes) {
      const scope = scopeForTokenType(raw);
      if (scope === null) continue;
      assert.ok(SEMANTIC_SCOPES.includes(scope), `${raw} -> ${scope} no está en la leyenda`);
    }
  });
});

describe('decodeTokens', () => {
  it('acumula la línea y reinicia la columna al cambiar de línea', () => {
    // Tres tokens: (0,4), (0,12) en la misma línea y (2,8) dos líneas más abajo.
    const data = [
      0, 4, 6, 2, 0,
      0, 8, 3, 13, 0,
      2, 8, 5, 4, 0,
    ];

    const tokens = decodeTokens(data, ROSLYN_LEGEND);

    assert.equal(tokens.length, 3);
    assert.deepEqual(
      tokens.map((token) => [token.line, token.character, token.length, token.type]),
      [
        [0, 4, 6, 'class'],
        [0, 12, 3, 'method'],
        [2, 8, 5, 'interface'],
      ],
    );
  });

  it('descodifica los modificadores como bits', () => {
    const [token] = decodeTokens([0, 0, 4, 2, 0b101], ROSLYN_LEGEND);
    assert.deepEqual(token.modifiers, ['declaration', 'documentation']);
  });

  it('ignora una cola incompleta en vez de inventarse un token', () => {
    assert.equal(decodeTokens([0, 0, 4, 2, 0, 1, 2], ROSLYN_LEGEND).length, 1);
  });

  it('descarta un índice de tipo que no existe en la leyenda', () => {
    assert.deepEqual(decodeTokens([0, 0, 4, 999, 0], ROSLYN_LEGEND), []);
  });

  it('descarta un token de longitud cero', () => {
    assert.deepEqual(decodeTokens([0, 0, 0, 2, 0], ROSLYN_LEGEND), []);
  });
});

describe('encodeTokens y remapTokens', () => {
  const scopeIndex = (name) => SEMANTIC_SCOPES.indexOf(name);

  it('vuelve a la codificación relativa con los índices de nuestra leyenda', () => {
    const data = [
      0, 4, 6, 2, 0, // class    -> type
      0, 8, 3, 13, 0, // method  -> method
      2, 8, 5, 4, 0, // interface -> interface
    ];

    assert.deepEqual(remapTokens(data, ROSLYN_LEGEND), [
      0, 4, 6, scopeIndex('type'), 0,
      0, 8, 3, scopeIndex('method'), 0,
      2, 8, 5, scopeIndex('interface'), 0,
    ]);
  });

  it('un token descartado no descoloca al siguiente', () => {
    // El de en medio es `excluded code`, que no se colorea: el tercero tiene que salir con su
    // desplazamiento recalculado desde el primero, no desde el que se ha caído.
    const excluded = ROSLYN_LEGEND.tokenTypes.indexOf('excluded code');
    const data = [
      0, 4, 6, 2, 0,
      0, 8, 3, excluded, 0,
      0, 6, 5, 13, 0,
    ];

    const result = remapTokens(data, ROSLYN_LEGEND);

    assert.equal(result.length, 10);
    // Segundo token conservado: columna absoluta 18, relativa al primero (4) = 14.
    assert.deepEqual(result.slice(5), [0, 14, 5, scopeIndex('method'), 0]);
  });

  it('ordena por posición aunque lleguen desordenados', () => {
    const tokens = [
      { line: 3, character: 0, length: 2, type: 'method', modifiers: [] },
      { line: 1, character: 5, length: 4, type: 'class', modifiers: [] },
    ];

    const data = encodeTokens(tokens, SEMANTIC_SCOPES);
    assert.equal(data[0], 1);
    assert.equal(data[5], 2);
  });

  it('una entrada vacía produce una salida vacía', () => {
    assert.deepEqual(remapTokens([], ROSLYN_LEGEND), []);
  });
});

describe('legendFromCapabilities', () => {
  it('extrae la leyenda de la respuesta de initialize', () => {
    const legend = legendFromCapabilities({
      semanticTokensProvider: {
        legend: { tokenTypes: ['class', 'method'], tokenModifiers: ['static'] },
        full: true,
      },
    });

    assert.deepEqual(legend, { tokenTypes: ['class', 'method'], tokenModifiers: ['static'] });
  });

  it('devuelve null si el servidor no ofrece tokens semánticos', () => {
    assert.equal(legendFromCapabilities({ hoverProvider: true }), null);
    assert.equal(legendFromCapabilities(null), null);
    assert.equal(legendFromCapabilities({ semanticTokensProvider: {} }), null);
    assert.equal(legendFromCapabilities({ semanticTokensProvider: { legend: { tokenTypes: [] } } }), null);
  });

  it('tolera una leyenda sin modificadores', () => {
    const legend = legendFromCapabilities({ semanticTokensProvider: { legend: { tokenTypes: ['class'] } } });
    assert.deepEqual(legend, { tokenTypes: ['class'], tokenModifiers: [] });
  });
});
