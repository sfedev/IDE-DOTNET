/**
 * Pruebas de la instalación de NetCoreDbg.
 *
 * El depurador se instalaba con el mismo patrón que dejó el servidor de lenguaje inservible durante
 * nueve versiones: extraer el ZIP y dejar un marcador `.dotforge-ok` con el SHA-256 **del archivo
 * descargado**. Eso comprueba un archivo que ya no está en el disco y no dice nada de los que sí
 * están (ADR-041).
 *
 * Aquí el fallo se manifiesta peor que en el servidor de lenguaje. Un `Microsoft.CodeAnalysis.*.dll`
 * truncado al menos deja un `PartDiscoveryException` en el registro; un `netcoredbg.exe` cortado no
 * da ningún error legible, da una sesión de depuración que no arranca.
 *
 * La adquisición de verdad va contra la API de GitHub y se ejercita en la prueba de integración
 * `tests/scaffold/debugger.test.mjs`, que descarga el binario, compila un programa y para en un
 * breakpoint. Lo que se prueba aquí es lo que se puede probar sin red: que el ZIP con la forma real
 * de NetCoreDbg —todo bajo una carpeta `netcoredbg/`— se instala con su manifiesto, y que la
 * verificación caza lo que el marcador antiguo no veía.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assetNameForPlatform,
  installArchive,
  MANIFEST_FILE,
  readInstallManifest,
  verifyInstall,
} from '../../build/toolchain.mjs';
import { makeZip } from './zip-fixture.mjs';

/**
 * La forma real del ZIP de una release de NetCoreDbg: todo cuelga de `netcoredbg/`, que es el nivel
 * que la adquisición descarta con `strip: 1`.
 */
const RELEASE_ZIP = makeZip([
  ['netcoredbg/netcoredbg.exe', Buffer.alloc(2_100_000, 3)],
  ['netcoredbg/ManagedPart.dll', Buffer.alloc(120_000, 9)],
  ['netcoredbg/dbgshim.dll', Buffer.from('dbgshim')],
]);

/**
 * La forma real del ZIP de macOS, que **no** es la de Windows.
 *
 * El paquete se comprime en un Mac, así que llega con el árbol `__MACOSX/` de bifurcaciones de
 * recurso: un `._nombre` por cada archivo. Con `strip: 1`, `__MACOSX/netcoredbg/._netcoredbg` se
 * queda en `netcoredbg/._netcoredbg` y crea una **carpeta** que se llama igual que el ejecutable.
 * Como esas entradas van antes en el directorio central, cuando toca escribir el binario el nombre
 * ya está ocupado y la instalación muere con `EISDIR`.
 *
 * El fixture de arriba sólo copiaba la forma de Windows, y por eso esto no lo cazó nadie: el
 * depurador no se ha podido instalar en macOS en ninguna versión publicada.
 */
const RELEASE_ZIP_OSX = makeZip([
  ['__MACOSX/netcoredbg/._Microsoft.CodeAnalysis.dll', Buffer.from('bifurcación de recurso')],
  ['netcoredbg/Microsoft.CodeAnalysis.dll', Buffer.alloc(4_096, 7)],
  ['__MACOSX/netcoredbg/._netcoredbg', Buffer.from('bifurcación de recurso')],
  ['netcoredbg/netcoredbg', Buffer.alloc(2_625_896, 5)],
  ['netcoredbg/libdbgshim.dylib', Buffer.from('dbgshim')],
  ['netcoredbg/.DS_Store', Buffer.from('basura del Finder')],
]);

async function install() {
  const root = await mkdtemp(join(tmpdir(), 'dotforge-dbg-'));
  const directory = join(root, 'netcoredbg', 'v3.1.2-1054');
  await installArchive(RELEASE_ZIP, directory, {
    kind: 'netcoredbg',
    packageVersion: 'v3.1.2-1054',
    rid: 'win32-x64',
    strip: 1,
    now: () => new Date('2026-08-24T10:00:00.000Z'),
  });
  return { root, directory };
}

describe('instalación de NetCoreDbg', () => {
  it('descarta el primer nivel del ZIP y anota cada archivo', async () => {
    const { root, directory } = await install();
    try {
      assert.ok(existsSync(join(directory, 'netcoredbg.exe')), 'el ejecutable queda en la raíz');

      const manifest = await readInstallManifest(directory);
      assert.equal(manifest.kind, 'netcoredbg');
      assert.equal(manifest.packageVersion, 'v3.1.2-1054');
      assert.deepEqual(
        manifest.files.map((file) => file.path),
        ['ManagedPart.dll', 'dbgshim.dll', 'netcoredbg.exe'],
        'ninguna ruta conserva el prefijo netcoredbg/',
      );
      assert.equal(manifest.files.find((file) => file.path === 'netcoredbg.exe').size, 2_100_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('una instalación intacta se verifica en verde', async () => {
    const { root, directory } = await install();
    try {
      const check = await verifyInstall(directory);
      assert.equal(check.verified, true);
      assert.deepEqual(check.problems, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caza un ejecutable truncado, que es lo que el marcador antiguo no veía', async () => {
    const { root, directory } = await install();
    try {
      await truncate(join(directory, 'netcoredbg.exe'), 1_048_576);

      const check = await verifyInstall(directory);
      assert.equal(check.problems.length, 1);
      assert.equal(check.problems[0].path, 'netcoredbg.exe');
      assert.equal(check.problems[0].kind, 'size');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caza una biblioteca sustituida por otra del mismo tamaño, en profundidad', async () => {
    const { root, directory } = await install();
    try {
      await writeFile(join(directory, 'dbgshim.dll'), Buffer.from('DBGSHIM'));

      assert.deepEqual((await verifyInstall(directory)).problems, [], 'el stat no puede ver esto');
      const profunda = await verifyInstall(directory, { deep: true });
      assert.equal(profunda.problems[0].kind, 'hash');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sin manifiesto, la instalación cuenta como no verificada y se reinstala sola', async () => {
    const { root, directory } = await install();
    try {
      // Exactamente lo que se encuentra una caché de la v1.9: archivos y un marcador que ya no vale.
      await rm(join(directory, MANIFEST_FILE));
      await writeFile(join(directory, '.dotforge-ok'), 'v3.1.2-1054\nabc\n');

      const check = await verifyInstall(directory);
      assert.equal(check.verified, false);
      assert.equal(check.manifest, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('el asset publicado depende de la plataforma, y Linux no tiene ZIP', () => {
    const name = assetNameForPlatform();
    if (process.platform === 'win32') assert.equal(name, 'netcoredbg-win64.zip');
    else if (process.platform === 'darwin') assert.match(name, /^netcoredbg-osx-(arm64|amd64)\.zip$/);
    else assert.equal(name, null, 'Linux se publica como .tar.gz y queda fuera');
  });

  it('el paquete de macOS deja el ejecutable como archivo, no como carpeta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dotforge-dbg-osx-'));
    const directory = join(root, 'netcoredbg', '3.2.0-1092');

    await installArchive(RELEASE_ZIP_OSX, directory, {
      kind: 'netcoredbg',
      packageVersion: '3.2.0-1092',
      rid: 'darwin-arm64',
      strip: 1,
    });

    const executable = join(directory, 'netcoredbg');
    assert.ok(existsSync(executable), 'no se ha escrito el ejecutable');
    assert.ok(
      statSync(executable).isFile(),
      'netcoredbg ha quedado como carpeta: las bifurcaciones de recurso se han colado',
    );
    assert.equal(statSync(executable).size, 2_625_896);

    await rm(root, { recursive: true, force: true });
  });

  it('no escribe nada del arbol __MACOSX ni los ._ del Finder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dotforge-dbg-osx-'));
    const directory = join(root, 'netcoredbg', '3.2.0-1092');

    await installArchive(RELEASE_ZIP_OSX, directory, {
      kind: 'netcoredbg',
      packageVersion: '3.2.0-1092',
      rid: 'darwin-arm64',
      strip: 1,
    });

    const manifest = await readInstallManifest(directory);
    const paths = manifest.files.map((file) => file.path);

    assert.deepEqual(
      paths.filter((path) => path.includes('__MACOSX') || path.includes('._') || path.includes('.DS_Store')),
      [],
      `el manifiesto anota basura del empaquetado: ${paths.join(', ')}`,
    );
    assert.deepEqual(paths.sort(), ['Microsoft.CodeAnalysis.dll', 'libdbgshim.dylib', 'netcoredbg'].sort());

    // Y lo que se anota tiene que estar de verdad: un manifiesto que promete de más no verifica.
    const check = await verifyInstall(directory);
    assert.equal(check.verified, true);
    assert.deepEqual(check.problems, []);

    await rm(root, { recursive: true, force: true });
  });
});
