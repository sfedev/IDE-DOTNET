/**
 * Pruebas de las sumas SHA-256 que se publican con cada release.
 *
 * Lo que hay que garantizar aquí no es que se sepa concatenar un hash y un nombre, sino que el
 * archivo resultante lo entienda `sha256sum -c` — es un formato ajeno, y lo que lo hace útil es
 * justamente que no sea nuestro— y que la comparación no dé por buena una lista que no describe
 * lo que hay en el disco.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKSUM_FILE_NAME,
  formatChecksumFile,
  parseChecksumFile,
  verifyChecksums,
} from '../../scripts/lib/checksums.mjs';
import { isPublishableArtifact, PUBLISHABLE_EXTENSIONS } from '../../scripts/lib/dist-artifacts.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

describe('formato del archivo de sumas', () => {
  it('escribe el formato de sha256sum: hash, dos espacios y nombre', () => {
    const text = formatChecksumFile([{ name: 'DotForge IDE-2.9.1-Setup-x64.exe', sha256: HASH_A }]);
    assert.equal(text, `${HASH_A}  DotForge IDE-2.9.1-Setup-x64.exe\n`);
  });

  it('ordena por nombre, no por orden de llegada', () => {
    // El archivo se compara entre versiones; un orden heredado de readdir convierte esa
    // comparación en ruido.
    const text = formatChecksumFile([
      { name: 'zeta.zip', sha256: HASH_B },
      { name: 'alfa.exe', sha256: HASH_A },
    ]);
    assert.deepEqual(text.trimEnd().split('\n'), [`${HASH_A}  alfa.exe`, `${HASH_B}  zeta.zip`]);
  });

  it('termina en salto de línea, y una lista vacía no produce archivo', () => {
    assert.ok(formatChecksumFile([{ name: 'a.exe', sha256: HASH_A }]).endsWith('\n'));
    assert.equal(formatChecksumFile([]), '');
  });

  it('acepta un hash en mayúsculas y lo normaliza', () => {
    const text = formatChecksumFile([{ name: 'a.exe', sha256: HASH_A.toUpperCase() }]);
    assert.equal(text, `${HASH_A}  a.exe\n`);
  });

  it('rechaza lo que no es un SHA-256 de 64 dígitos', () => {
    assert.throws(() => formatChecksumFile([{ name: 'a.exe', sha256: 'a'.repeat(63) }]), TypeError);
    assert.throws(() => formatChecksumFile([{ name: 'a.exe', sha256: 'z'.repeat(64) }]), TypeError);
    assert.throws(() => formatChecksumFile([{ name: 'a.exe' }]), TypeError);
    assert.throws(() => formatChecksumFile([{ name: '', sha256: HASH_A }]), TypeError);
  });

  /**
   * El nombre acaba en un archivo que alguien va a verificar desde una consola. Un salto de línea
   * partiría la entrada en dos y una barra apuntaría a otro directorio: las dos cosas convierten
   * el archivo en algo que ya no describe lo que hay al lado.
   */
  it('rechaza un nombre con salto de línea o con ruta', () => {
    assert.throws(() => formatChecksumFile([{ name: 'a.exe\nb.exe', sha256: HASH_A }]), TypeError);
    assert.throws(() => formatChecksumFile([{ name: 'sub/a.exe', sha256: HASH_A }]), TypeError);
    assert.throws(() => formatChecksumFile([{ name: String.raw`sub\a.exe`, sha256: HASH_A }]), TypeError);
  });
});

describe('lectura del archivo de sumas', () => {
  it('vuelve a leer lo que escribe', () => {
    const entries = [
      { name: 'DotForge IDE-2.9.1-Setup-x64.exe', sha256: HASH_A },
      { name: 'DotForge IDE-2.9.1-win-x64.zip', sha256: HASH_B },
    ];
    assert.deepEqual(parseChecksumFile(formatChecksumFile(entries)), entries);
  });

  it('acepta el separador binario de sha256sum (espacio y asterisco)', () => {
    // `sha256sum -b` lo genera así y el propio `-c` lo acepta: leerlo cuesta un carácter en el
    // patrón y evita rechazar un archivo perfectamente válido escrito por otra herramienta.
    assert.deepEqual(parseChecksumFile(`${HASH_A} *a.exe\n`), [{ name: 'a.exe', sha256: HASH_A }]);
  });

  it('ignora líneas en blanco y comentarios, y tolera CRLF', () => {
    const text = `# DotForge IDE\r\n\r\n${HASH_A}  a.exe\r\n`;
    assert.deepEqual(parseChecksumFile(text), [{ name: 'a.exe', sha256: HASH_A }]);
  });

  /**
   * La otra mitad de la regla: lo que no parece una entrada se ignora, y lo que lo parece y está
   * mal **falla**. Ignorar una línea rota en silencio convierte un archivo corrupto en una
   * verificación que pasa, que es exactamente lo contrario de para lo que existe el archivo.
   */
  it('falla ante una línea que quiere ser una entrada y no lo es', () => {
    assert.throws(() => parseChecksumFile(`${'a'.repeat(63)}  a.exe\n`), /formato inesperado/);
    assert.throws(() => parseChecksumFile(`${HASH_A}\n`), /formato inesperado/);
    assert.throws(() => parseChecksumFile('no soy una suma\n'), /formato inesperado/);
  });

  it('nombra el archivo en el error, porque quien lo lee no sabe de dónde salió', () => {
    assert.throws(() => parseChecksumFile('mal\n'), new RegExp(CHECKSUM_FILE_NAME));
  });
});

describe('comparación con lo que hay en el disco', () => {
  const published = [
    { name: 'a.exe', sha256: HASH_A },
    { name: 'b.zip', sha256: HASH_B },
  ];

  it('todo coincide', () => {
    assert.deepEqual(verifyChecksums(published, published), {
      ok: true,
      missing: [],
      extra: [],
      mismatched: [],
    });
  });

  /**
   * Las tres formas de no cuadrar se devuelven por separado porque mandan a mirar a tres sitios
   * distintos, y sólo una es alarmante: un hash que no coincide es contenido distinto del
   * publicado. Que falte o sobre un archivo casi siempre significa que la lista se generó en otro
   * momento.
   */
  it('distingue lo que falta, lo que sobra y lo que no coincide', () => {
    const actual = [
      { name: 'a.exe', sha256: HASH_C },
      { name: 'c.dmg', sha256: HASH_C },
    ];
    const result = verifyChecksums(published, actual);

    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['b.zip']);
    assert.deepEqual(result.extra, ['c.dmg']);
    assert.deepEqual(result.mismatched, [{ name: 'a.exe', expected: HASH_A, actual: HASH_C }]);
  });

  it('un archivo repetido en la lista es un error, no la última entrada', () => {
    const repeated = [
      { name: 'a.exe', sha256: HASH_A },
      { name: 'a.exe', sha256: HASH_B },
    ];
    assert.throws(() => verifyChecksums(repeated, published), /dos veces/);
  });
});

describe('qué se cuelga de una release', () => {
  it('reconoce los tres formatos que se publican, mire como mire la extensión', () => {
    assert.ok(isPublishableArtifact('DotForge IDE-2.9.1-Setup-x64.exe'));
    assert.ok(isPublishableArtifact('DotForge IDE-2.9.1-win-x64.zip'));
    assert.ok(isPublishableArtifact('DotForge IDE-2.9.1-arm64.DMG'));
  });

  it('deja fuera el material de compilación y el propio archivo de sumas', () => {
    for (const name of ['builder-debug.yml', 'latest.yml', 'win-unpacked', CHECKSUM_FILE_NAME]) {
      assert.equal(isPublishableArtifact(name), false, `${name} no debería publicarse como artefacto`);
    }
  });

  /**
   * El archivo de sumas no puede ser también un artefacto que se hashea a sí mismo: se adjunta a
   * la release, pero fuera de la lista. Es la misma razón por la que en el workflow se sube aparte
   * y no dentro del array que se comprueba.
   */
  it('el archivo de sumas no lleva una extensión publicable', () => {
    assert.ok(!PUBLISHABLE_EXTENSIONS.some((extension) => CHECKSUM_FILE_NAME.toLowerCase().endsWith(extension)));
  });
});
