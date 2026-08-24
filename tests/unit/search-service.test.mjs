/**
 * Pruebas del servicio de búsqueda, con archivos de verdad.
 *
 * Lo que aquí se comprueba es la mitad que no se puede probar sin disco: que el recorrido no baja a
 * `bin`, `obj` ni `node_modules` —si bajara, cada coincidencia de una solución compilada aparecería
 * dos o tres veces y ninguna de las copias sería la que hay que editar—, que un binario no se lee,
 * que los resultados salen **antes** de terminar, y que una búsqueda nueva abandona a la anterior.
 *
 * Se crea un árbol temporal en vez de fingir `fs`: lo que se quiere saber es que el recorrido se
 * comporta igual que en la máquina de quien lo usa, incluidos los separadores de Windows. Un doble
 * de `fs` probaría el doble.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SEARCH_OPTIONS, MAX_SEARCHABLE_BYTES, searchService } from '../../build/main-lib.mjs';

let root;

const options = (patch = {}) => ({ ...DEFAULT_SEARCH_OPTIONS, ...patch });

/** Rutas relativas encontradas, ordenadas: el orden del recorrido depende de la concurrencia. */
const paths = (summary) => summary.files.map((file) => file.relativePath).sort();

const write = async (relativePath, content) => {
  const full = join(root, ...relativePath.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dotforge-search-'));

  await write('src/Acme.Api/Program.cs', 'using Acme;\n\nvar product = new Product();\nreturn product;\n');
  await write('src/Acme.Api/Pages/Index.razor', '@page "/"\n<h1>Product</h1>\n');
  await write('src/Acme.Api/Modelo.designer.cs', '// Product generado\n');
  await write('tests/Acme.Tests/ProductTests.cs', 'public class ProductTests { }\n');

  // Los tres que no se pueden mirar: copias del compilador y dependencias.
  await write('src/Acme.Api/bin/Debug/Program.cs', 'var product = new Product();\n');
  await write('src/Acme.Api/obj/Debug/Generado.cs', 'var product = new Product();\n');
  await write('node_modules/paquete/index.js', 'const Product = 1;\n');

  // Un binario con la palabra dentro: se descarta por la extensión, sin abrirlo.
  await write('recursos/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Buffer.from('Product')]));
  // …y uno con extensión inocente: lo caza el byte cero.
  await write('recursos/datos.txt', Buffer.from([0x00, ...Buffer.from('Product')]));

  // Un archivo por encima del tope de tamaño: no es código, y leerlo entero para nada cuesta.
  await write('enorme/Grande.cs', `${'/* relleno */\n'.repeat(Math.ceil(MAX_SEARCHABLE_BYTES / 14))}var Product = 1;\n`);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('qué encuentra', () => {
  it('agrupa por archivo y devuelve la ruta relativa con barras POSIX', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product' }));

    assert.equal(summary.error, null);
    assert.equal(summary.cancelled, false);
    assert.deepEqual(paths(summary), [
      'src/Acme.Api/Modelo.designer.cs',
      'src/Acme.Api/Pages/Index.razor',
      'src/Acme.Api/Program.cs',
      'tests/Acme.Tests/ProductTests.cs',
    ]);
  });

  it('la línea y la columna apuntan a la coincidencia', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product', matchCase: true }));
    const program = summary.files.find((file) => file.relativePath === 'src/Acme.Api/Program.cs');

    // `var product = new Product();` es la línea 3, y `Product` empieza en la columna 19.
    assert.deepEqual(
      program.matches.map((match) => [match.line, match.column, match.length]),
      [[3, 19, 7]],
    );
    assert.equal(program.matches[0].preview, 'var product = new Product();');
  });

  it('cuenta las coincidencias, no los archivos', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'product' }));

    assert.equal(summary.filesMatched, 4);
    // Program.cs tiene tres (`product`, `Product`, `product`) sin distinguir mayúsculas.
    assert.equal(summary.totalMatches, 6);
  });

  it('una búsqueda sin resultados no es un error', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'NoExisteEnNingunSitio' }));

    assert.equal(summary.error, null);
    assert.equal(summary.files.length, 0);
    assert.ok(summary.filesScanned > 0, 'se han mirado archivos aunque no haya resultados');
  });

  it('una expresión regular a medias vuelve como error, no como excepción', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: '(sin cerrar', useRegex: true }));

    assert.ok(summary.error !== null);
    assert.equal(summary.files.length, 0);
    assert.equal(summary.filesScanned, 0, 'ni siquiera se ha recorrido el disco');
  });
});

describe('dónde no entra', () => {
  it('no baja a bin, obj ni node_modules', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product' }));
    const encontrados = paths(summary).join('\n');

    assert.ok(!encontrados.includes('/bin/'), 'ha entrado en bin');
    assert.ok(!encontrados.includes('/obj/'), 'ha entrado en obj');
    assert.ok(!encontrados.includes('node_modules'), 'ha entrado en node_modules');
  });

  it('no abre un binario, ni por extensión ni por contenido', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product' }));
    const encontrados = paths(summary).join('\n');

    assert.ok(!encontrados.includes('logo.png'));
    assert.ok(!encontrados.includes('datos.txt'));
  });

  it('no lee un archivo por encima del tope de tamaño', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product' }));
    assert.ok(!paths(summary).includes('enorme/Grande.cs'));
  });

  it('respeta los patrones de inclusión', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product', include: '*.razor' }));
    assert.deepEqual(paths(summary), ['src/Acme.Api/Pages/Index.razor']);
  });

  it('respeta los de exclusión, incluida la negación escrita en la caja de inclusión', async () => {
    const summary = await searchService.searchWorkspace(
      root,
      options({ query: 'Product', include: '*.cs, !*.designer.cs', exclude: 'tests/' }),
    );

    assert.deepEqual(paths(summary), ['src/Acme.Api/Program.cs']);
  });

  it('un patrón de inclusión que no casa con nada da cero, no todo', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product', include: '*.fsproj' }));

    assert.equal(summary.files.length, 0);
    assert.equal(summary.filesScanned, 0);
  });
});

describe('topes', () => {
  it('deja de contar al llegar al tope global y lo dice', async () => {
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product', maxResults: 2 }));

    assert.ok(summary.totalMatches <= 2 + DEFAULT_SEARCH_OPTIONS.maxMatchesPerFile);
    assert.equal(summary.truncated, true);
  });

  it('el tope por archivo marca el archivo, no la búsqueda entera', async () => {
    await write('muchos/Repetido.cs', 'Product\n'.repeat(30));

    const summary = await searchService.searchWorkspace(
      root,
      options({ query: 'Product', include: 'muchos/**', maxMatchesPerFile: 5 }),
    );

    assert.equal(summary.files[0].matches.length, 5);
    assert.equal(summary.files[0].truncated, true);
  });
});

describe('avances y cancelación', () => {
  it('emite resultados antes de terminar', async () => {
    const lotes = [];
    const summary = await searchService.searchWorkspace(root, options({ query: 'Product' }), {
      onProgress: (progress) => lotes.push(progress),
    });

    assert.ok(lotes.length > 0, 'no ha llegado ningún avance');
    assert.ok(lotes.every((lote) => lote.searchId === summary.searchId), 'un avance de otra búsqueda');

    const enLotes = lotes.flatMap((lote) => lote.files.map((file) => file.relativePath)).sort();
    assert.deepEqual(enLotes, paths(summary), 'lo emitido y lo devuelto no coinciden');
  });

  it('cada búsqueda tiene su número de orden', async () => {
    const primera = await searchService.searchWorkspace(root, options({ query: 'Product' }));
    const segunda = await searchService.searchWorkspace(root, options({ query: 'Product' }));

    assert.ok(segunda.searchId > primera.searchId);
  });

  it('cancelar deja la búsqueda a medias y lo dice', async () => {
    const enMarcha = searchService.searchWorkspace(root, options({ query: 'Product' }));
    searchService.cancel();

    const summary = await enMarcha;
    assert.equal(summary.cancelled, true);
  });

  it('una búsqueda nueva abandona a la anterior', async () => {
    // Es el caso real: se teclea mientras se busca. Sin esto, dos recorridos compiten por el disco
    // y el panel acaba enseñando una mezcla de los dos.
    const vieja = searchService.searchWorkspace(root, options({ query: 'Product' }));
    const nueva = searchService.searchWorkspace(root, options({ query: 'Acme' }));

    const [primera, segunda] = await Promise.all([vieja, nueva]);

    assert.equal(primera.cancelled, true);
    assert.equal(segunda.cancelled, false);
    assert.ok(segunda.files.length > 0);
  });

  it('una búsqueda cancelada no emite avances de otra', async () => {
    const lotes = [];
    const vieja = searchService.searchWorkspace(root, options({ query: 'Product' }), {
      onProgress: (progress) => lotes.push(progress),
    });
    const nueva = searchService.searchWorkspace(root, options({ query: 'Acme' }));

    const [primera] = await Promise.all([vieja, nueva]);

    assert.ok(lotes.every((lote) => lote.searchId === primera.searchId));
  });
});
