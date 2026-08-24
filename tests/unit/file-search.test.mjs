/**
 * Pruebas del modelo de la búsqueda de texto en archivos.
 *
 * Lo que se comprueba aquí son las tres mitades puras: **qué casa** (texto, mayúsculas, palabra
 * completa, expresión regular), **qué archivos entran** (globs de inclusión y exclusión) y **qué se
 * enseña** (el recorte de la línea). La cuarta —recorrer el disco de verdad— se prueba aparte, con
 * carpetas reales, en `search-service.test.mjs`.
 *
 * Hay tres casos que no están por completitud sino porque son fallos que se han visto en este tipo
 * de código y que no dan la cara en una prueba manual: una expresión regular global que conserva
 * `lastIndex` entre líneas y se salta resultados de forma intermitente, una coincidencia de
 * longitud cero que cuelga el bucle, y "palabra completa" escrito con `\b`, que hace que buscar un
 * símbolo no encuentre nunca nada.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchRegExp,
  coerceSearchOptions,
  compileGlobs,
  DEFAULT_SEARCH_OPTIONS,
  describeResults,
  escapeRegExp,
  globToRegExp,
  hasBinaryExtension,
  looksBinary,
  matchesGlobs,
  matchesInLine,
  parseGlobList,
  previewOf,
  searchContent,
  SearchPatternError,
  shouldSkipDirectory,
  splitLines,
} from '../../build/main-lib.mjs';

/** Opciones completas a partir de lo poco que le importa a cada prueba. */
const options = (patch = {}) => ({ ...DEFAULT_SEARCH_OPTIONS, ...patch });

/** Todas las coincidencias de un texto de varias líneas, como pares "línea:columna". */
function positions(text, opts) {
  const regex = buildSearchRegExp(options(opts));
  const found = [];

  splitLines(text).forEach((line, index) => {
    for (const match of matchesInLine(line, regex, index + 1, 100)) {
      found.push(`${match.line}:${match.column}`);
    }
  });

  return found;
}

describe('qué casa', () => {
  it('busca texto plano sin distinguir mayúsculas por defecto', () => {
    assert.deepEqual(positions('var Product = 1;\nproduct.Id', { query: 'product' }), ['1:5', '2:1']);
  });

  it('distingue mayúsculas cuando se le pide', () => {
    assert.deepEqual(positions('var Product = 1;\nproduct.Id', { query: 'Product', matchCase: true }), ['1:5']);
  });

  it('trata el texto plano como texto, no como expresión regular', () => {
    // Sin escapar, `a.c` casaría con `abc`. Quien escribe un punto quiere un punto.
    assert.deepEqual(positions('abc\na.c', { query: 'a.c' }), ['2:1']);
  });

  it('en modo expresión regular sí interpreta los metacaracteres', () => {
    assert.deepEqual(positions('abc\na.c', { query: 'a.c', useRegex: true }), ['1:1', '2:1']);
  });

  it('encuentra varias coincidencias en la misma línea', () => {
    assert.deepEqual(positions('id, id, id', { query: 'id' }), ['1:1', '1:5', '1:9']);
  });

  it('escapa lo que en una expresión regular significaría otra cosa', () => {
    assert.equal(escapeRegExp('a+b(c)'), 'a\\+b\\(c\\)');
  });

  it('una expresión regular a medias no explota: se cuenta como consulta inválida', () => {
    assert.throws(() => buildSearchRegExp(options({ query: '(sin cerrar', useRegex: true })), SearchPatternError);
  });

  it('una consulta vacía tampoco se ejecuta', () => {
    assert.throws(() => buildSearchRegExp(options({ query: '' })), SearchPatternError);
  });
});

describe('palabra completa', () => {
  it('no casa dentro de otra palabra', () => {
    assert.deepEqual(positions('Id\nProductId\nId;', { query: 'Id', wholeWord: true }), ['1:1', '3:1']);
  });

  it('acepta los bordes que no son letras', () => {
    assert.deepEqual(positions('(Id)', { query: 'Id', wholeWord: true }), ['1:2']);
  });

  it('trata las letras acentuadas como parte de la palabra', () => {
    // Con `\w`, que es ASCII, "Configuración" contendría la palabra completa "Configuraci".
    assert.deepEqual(positions('Configuración', { query: 'Configuraci', wholeWord: true }), []);
  });

  it('un símbolo como palabra completa sigue encontrándose', () => {
    // Éste es el motivo de no usar `\b`: `\b\+\b` no casa jamás, así que buscar "+" como palabra
    // completa devolvería siempre cero resultados en vez de las sumas del archivo.
    assert.deepEqual(positions('a + b', { query: '+', wholeWord: true }), ['1:3']);
  });
});

describe('trampas del bucle de coincidencias', () => {
  it('una coincidencia de longitud cero no cuelga la búsqueda', () => {
    const regex = buildSearchRegExp(options({ query: 'x*', useRegex: true }));
    const found = matchesInLine('abc', regex, 1, 100);

    // Cuatro posiciones vacías (antes de cada letra y al final), no un bucle infinito.
    assert.equal(found.length, 4);
    assert.deepEqual(found.map((match) => match.column), [1, 2, 3, 4]);
  });

  it('la expresión se reinicia entre líneas', () => {
    // Es global: si `lastIndex` sobreviviera de una línea a la siguiente, la segunda empezaría a
    // mirarse por la mitad y el resultado saldría o no según la longitud de la anterior.
    const regex = buildSearchRegExp(options({ query: 'a' }));

    assert.equal(matchesInLine('aaaaaaaaaa', regex, 1, 100).length, 10);
    assert.equal(matchesInLine('a', regex, 2, 100).length, 1);
  });

  it('respeta el tope de coincidencias que se le pasa', () => {
    const regex = buildSearchRegExp(options({ query: 'a' }));
    assert.equal(matchesInLine('aaaaaaaaaa', regex, 1, 3).length, 3);
  });
});

describe('cómo se enseña la línea', () => {
  it('quita la sangría de la izquierda y recoloca la columna', () => {
    const { preview, previewColumn } = previewOf('            var x = 1;', 17, 1);

    assert.equal(preview, 'var x = 1;');
    assert.equal(previewColumn, 5);
    assert.equal(preview[previewColumn - 1], 'x');
  });

  it('no quita la sangría si lo que se busca está dentro de ella', () => {
    const { preview, previewColumn } = previewOf('    var x;', 2, 1);
    assert.equal(preview, '    var x;');
    assert.equal(previewColumn, 2);
  });

  it('abre una ventana alrededor de la coincidencia en una línea enorme', () => {
    const line = `${'x'.repeat(4000)}AGUJA${'y'.repeat(4000)}`;
    const { preview, previewColumn } = previewOf(line, 4001, 5, 100);

    assert.ok(preview.length <= 102, `el recorte mide ${preview.length}`);
    assert.ok(preview.startsWith('…'));
    assert.ok(preview.endsWith('…'));
    assert.equal(preview.slice(previewColumn - 1, previewColumn - 1 + 5), 'AGUJA');
  });

  it('se come el retorno de carro de un archivo con finales de línea de Windows', () => {
    const { preview } = previewOf('var x = 1;\r', 1, 3);
    assert.equal(preview, 'var x = 1;');
  });
});

describe('patrones glob', () => {
  const matches = (path, include, exclude = '') => matchesGlobs(path, compileGlobs(include, exclude));

  it('un patrón sin barras casa a cualquier profundidad', () => {
    assert.ok(matches('src/Acme.Api/Program.cs', '*.cs'));
    assert.ok(matches('Program.cs', '*.cs'));
    assert.ok(!matches('src/Acme.Api/Program.razor', '*.cs'));
  });

  it('`**` atraviesa directorios y también casa en la raíz', () => {
    assert.ok(matches('src/a/b/Page.razor', 'src/**/*.razor'));
    assert.ok(matches('src/Page.razor', 'src/**/*.razor'));
    assert.ok(!matches('tests/Page.razor', 'src/**/*.razor'));
  });

  it('`*` no atraviesa la barra', () => {
    assert.ok(matches('src/Program.cs', 'src/*.cs'));
    assert.ok(!matches('src/Api/Program.cs', 'src/*.cs'));
  });

  it('`?` casa exactamente un carácter', () => {
    assert.ok(matches('src/a1.cs', 'src/a?.cs'));
    assert.ok(!matches('src/a12.cs', 'src/a?.cs'));
  });

  it('las alternativas entre llaves', () => {
    assert.ok(matches('src/Page.razor', '*.{cs,razor}'));
    assert.ok(matches('src/Program.cs', '*.{cs,razor}'));
    assert.ok(!matches('src/app.css', '*.{cs,razor}'));
  });

  it('la coma que separa patrones no parte las alternativas', () => {
    // La misma coma hace dos cosas: separa patrones de la lista y separa alternativas dentro de
    // `{}`. Partir a secas deja `*.{cs` y `razor}`, que no encuentran nada y no dicen por qué.
    assert.deepEqual(parseGlobList('*.{cs,razor}, tests/**'), ['*.{cs,razor}', 'tests/**']);
    assert.deepEqual(parseGlobList('  ,  *.cs ,, '), ['*.cs']);
  });

  it('un patrón que nombra un directorio se lleva su árbol entero', () => {
    assert.ok(!matches('tests/Unit/Caso.cs', '', 'tests/'));
    assert.ok(matches('src/Caso.cs', '', 'tests/'));
  });

  it('la exclusión gana a la inclusión', () => {
    assert.ok(matches('src/Modelo.cs', '*.cs', '*.designer.cs'));
    assert.ok(!matches('src/Modelo.designer.cs', '*.cs', '*.designer.cs'));
  });

  it('una negación escrita en la caja de inclusión también excluye', () => {
    // `*.cs, !*.designer.cs` en un solo campo: es la notación de .gitignore y la que sale sola.
    assert.ok(matches('src/Modelo.cs', '*.cs, !*.designer.cs'));
    assert.ok(!matches('src/Modelo.designer.cs', '*.cs, !*.designer.cs'));
  });

  it('sin patrones de inclusión entra todo', () => {
    assert.ok(matches('cualquier/cosa.txt', ''));
  });

  it('no distingue mayúsculas: en Windows y macOS el sistema de archivos tampoco', () => {
    assert.ok(matches('src/PROGRAM.CS', '*.cs'));
  });

  it('acepta las barras invertidas de una ruta de Windows escrita a mano', () => {
    assert.ok(matches('src/Acme/Program.cs', 'src\\**\\*.cs'));
  });

  it('el glob compilado no depende de cuántas veces se use', () => {
    const pattern = globToRegExp('*.cs');
    assert.ok(pattern.test('a/b/c.cs'));
    assert.ok(pattern.test('a/b/c.cs'));
  });
});

describe('agrupación por archivo', () => {
  const regexFor = (query, patch = {}) => buildSearchRegExp(options({ query, ...patch }));

  it('devuelve las coincidencias de un archivo con su ruta', () => {
    const result = searchContent(
      'class Product {}\n\nvar p = new Product();',
      'C:/repo/src/Product.cs',
      'src/Product.cs',
      regexFor('Product'),
      options(),
    );

    assert.equal(result.relativePath, 'src/Product.cs');
    assert.equal(result.matches.length, 2);
    assert.deepEqual(result.matches.map((match) => match.line), [1, 3]);
    assert.equal(result.truncated, false);
  });

  it('un archivo sin coincidencias no aparece', () => {
    assert.equal(searchContent('nada', 'a', 'a', regexFor('Product'), options()), null);
  });

  it('marca el archivo como recortado cuando pasa del tope', () => {
    const content = Array.from({ length: 40 }, () => 'Product').join('\n');
    const result = searchContent(content, 'a', 'a', regexFor('Product'), options({ maxMatchesPerFile: 10 }));

    assert.equal(result.matches.length, 10);
    assert.equal(result.truncated, true);
  });

  it('un tope que coincide exactamente con lo que hay no se marca como recortado', () => {
    const content = Array.from({ length: 10 }, () => 'Product').join('\n');
    const result = searchContent(content, 'a', 'a', regexFor('Product'), options({ maxMatchesPerFile: 10 }));

    assert.equal(result.matches.length, 10);
    assert.equal(result.truncated, false);
  });

  it('el presupuesto global manda sobre el tope por archivo', () => {
    const content = Array.from({ length: 40 }, () => 'Product').join('\n');
    const result = searchContent(content, 'a', 'a', regexFor('Product'), options({ maxMatchesPerFile: 30 }), 4);

    assert.equal(result.matches.length, 4);
  });
});

describe('qué archivos ni se abren', () => {
  it('los directorios de construcción y dependencias se saltan', () => {
    for (const name of ['bin', 'obj', 'node_modules', '.git', 'TestResults']) {
      assert.ok(shouldSkipDirectory(name), name);
    }
    assert.ok(!shouldSkipDirectory('src'));
  });

  it('las extensiones binarias se descartan por el nombre, sin leer', () => {
    assert.ok(hasBinaryExtension('Acme.Api.dll'));
    assert.ok(hasBinaryExtension('logo.PNG'));
    assert.ok(!hasBinaryExtension('Program.cs'));
    assert.ok(!hasBinaryExtension('Dockerfile'));
  });

  it('un byte cero delata un binario que se ha colado', () => {
    assert.ok(looksBinary(Buffer.from([0x4d, 0x5a, 0x00, 0x01])));
    assert.ok(!looksBinary(Buffer.from('class Product {}', 'utf8')));
  });
});

describe('saneado de lo que llega del renderer', () => {
  it('rellena lo que falta con los valores por defecto', () => {
    assert.deepEqual(coerceSearchOptions({}), DEFAULT_SEARCH_OPTIONS);
  });

  it('descarta lo que no es del tipo esperado', () => {
    const result = coerceSearchOptions({ query: 42, matchCase: 'sí', include: null, maxResults: 'muchos' });

    assert.equal(result.query, '');
    assert.equal(result.matchCase, false);
    assert.equal(result.include, '');
    assert.equal(result.maxResults, DEFAULT_SEARCH_OPTIONS.maxResults);
  });

  it('acota los topes: un renderer comprometido no pide un millón de resultados', () => {
    assert.equal(coerceSearchOptions({ maxResults: 10 ** 9 }).maxResults, 20000);
    assert.equal(coerceSearchOptions({ maxMatchesPerFile: -5 }).maxMatchesPerFile, 1);
  });

  it('recorta las cadenas largas', () => {
    assert.equal(coerceSearchOptions({ query: 'x'.repeat(5000) }).query.length, 1000);
  });

  it('un valor que no es objeto no rompe nada', () => {
    assert.deepEqual(coerceSearchOptions(null), DEFAULT_SEARCH_OPTIONS);
    assert.deepEqual(coerceSearchOptions('hola'), DEFAULT_SEARCH_OPTIONS);
  });
});

describe('el texto de la cabecera', () => {
  it('cuenta en singular y en plural', () => {
    assert.equal(describeResults({ totalMatches: 1, filesMatched: 1, truncated: false }), '1 resultado en 1 archivo');
    assert.equal(describeResults({ totalMatches: 9, filesMatched: 3, truncated: false }), '9 resultados en 3 archivos');
  });

  it('dice cuándo se ha quedado corto', () => {
    assert.ok(describeResults({ totalMatches: 2000, filesMatched: 40, truncated: true }).startsWith('Más de '));
  });

  it('sin resultados no cuenta archivos', () => {
    assert.equal(describeResults({ totalMatches: 0, filesMatched: 0, truncated: false }), 'Sin resultados');
  });
});
