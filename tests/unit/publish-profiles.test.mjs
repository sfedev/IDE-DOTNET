/**
 * Pruebas del almacén de opciones de publicación.
 *
 * Lo que se vigila: que lo leído del disco se sanea **igual** que lo que llega del renderer. Este
 * archivo lo escribe una versión del IDE y lo lee otra, se puede editar a mano, y su contenido
 * acaba siendo argumentos de `dotnet`. Un archivo corrupto no puede impedir publicar, y un RID
 * inventado dentro de él no puede llegar a un `argv`.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_PUBLISH_OPTIONS,
  MAX_REMEMBERED_PROJECTS,
  publishProfiles,
} from '../../build/main-lib.mjs';

const roots = [];

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'dotforge-publish-'));
  roots.push(root);
  publishProfiles.initialize(root);
  publishProfiles.resetCache();
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root;
beforeEach(() => {
  root = freshStore();
});

const PROJECT = 'C:/sln/Acme.Api/Acme.Api.csproj';

describe('guardar y recuperar', () => {
  it('un proyecto sin publicar nunca devuelve null', async () => {
    assert.equal(await publishProfiles.load(PROJECT), null);
  });

  it('devuelve lo guardado', async () => {
    await publishProfiles.save(PROJECT, {
      ...DEFAULT_PUBLISH_OPTIONS,
      configuration: 'Debug',
      framework: 'net9.0',
      mode: 'self-contained',
      runtime: 'win-x64',
      singleFile: true,
    });

    const stored = await publishProfiles.load(PROJECT);
    assert.equal(stored.configuration, 'Debug');
    assert.equal(stored.runtime, 'win-x64');
    assert.equal(stored.singleFile, true);
  });

  it('guardar dos veces el mismo proyecto no crea dos entradas', async () => {
    await publishProfiles.save(PROJECT, { ...DEFAULT_PUBLISH_OPTIONS, configuration: 'Debug' });
    await publishProfiles.save(PROJECT, { ...DEFAULT_PUBLISH_OPTIONS, configuration: 'Release' });

    const raw = JSON.parse(readFileSync(join(root, 'publish-profiles.json'), 'utf8'));
    assert.deepEqual(Object.keys(raw), [PROJECT]);
    assert.equal(raw[PROJECT].configuration, 'Release');
  });

  it('cada proyecto tiene sus propias opciones', async () => {
    const other = 'C:/sln/Acme.Web/Acme.Web.csproj';

    await publishProfiles.save(PROJECT, { ...DEFAULT_PUBLISH_OPTIONS, outputDir: 'salida/api' });
    await publishProfiles.save(other, { ...DEFAULT_PUBLISH_OPTIONS, outputDir: 'salida/web' });

    assert.equal((await publishProfiles.load(PROJECT)).outputDir, 'salida/api');
    assert.equal((await publishProfiles.load(other)).outputDir, 'salida/web');
  });

  it('una ruta vacía no se guarda: no habría de qué colgarla', async () => {
    await publishProfiles.save('   ', DEFAULT_PUBLISH_OPTIONS);
    assert.equal(await publishProfiles.load('   '), null);
  });
});

describe('lo leído del disco se sanea como lo del renderer', () => {
  it('un archivo ilegible no impide publicar: se empieza de cero', async () => {
    writeFileSync(join(root, 'publish-profiles.json'), '{ esto no es json', 'utf8');
    publishProfiles.resetCache();

    assert.equal(await publishProfiles.load(PROJECT), null);
  });

  it('tolera la marca de orden de bytes, como todo el JSON que el IDE no escribe', async () => {
    const content = JSON.stringify({ [PROJECT]: { configuration: 'Debug', framework: 'net9.0' } });
    writeFileSync(join(root, 'publish-profiles.json'), `\uFEFF${content}`, 'utf8');
    publishProfiles.resetCache();

    assert.equal((await publishProfiles.load(PROJECT)).configuration, 'Debug');
  });

  it('un RID inventado escrito a mano no llega a un argv', async () => {
    const content = JSON.stringify({
      [PROJECT]: { mode: 'self-contained', runtime: '../../../windows/system32', singleFile: true },
    });
    writeFileSync(join(root, 'publish-profiles.json'), content, 'utf8');
    publishProfiles.resetCache();

    const stored = await publishProfiles.load(PROJECT);
    assert.equal(stored.runtime, '');
    // Y la bandera que dependía de él se apaga con él.
    assert.equal(stored.singleFile, false);
  });

  it('una configuración de otra versión del IDE vuelve a Release', async () => {
    const content = JSON.stringify({ [PROJECT]: { configuration: 'ReleaseAot' } });
    writeFileSync(join(root, 'publish-profiles.json'), content, 'utf8');
    publishProfiles.resetCache();

    assert.equal((await publishProfiles.load(PROJECT)).configuration, 'Release');
  });

  it('una entrada que no es un objeto devuelve los valores de fábrica, no rompe la lectura', async () => {
    const content = JSON.stringify({ [PROJECT]: 'Release', 'C:/otro.csproj': { framework: 'net10.0' } });
    writeFileSync(join(root, 'publish-profiles.json'), content, 'utf8');
    publishProfiles.resetCache();

    assert.deepEqual(await publishProfiles.load(PROJECT), DEFAULT_PUBLISH_OPTIONS);
    assert.equal((await publishProfiles.load('C:/otro.csproj')).framework, 'net10.0');
  });

  it('la ruta de salida se guarda ya saneada', async () => {
    await publishProfiles.save(PROJECT, { ...DEFAULT_PUBLISH_OPTIONS, outputDir: ' C:\\salida\\api\\ ' });

    const raw = JSON.parse(readFileSync(join(root, 'publish-profiles.json'), 'utf8'));
    assert.equal(raw[PROJECT].outputDir, 'C:/salida/api');
  });
});

describe('poda', () => {
  it('se olvidan los proyectos que llevan más tiempo sin publicarse', async () => {
    for (let index = 0; index < MAX_REMEMBERED_PROJECTS + 5; index++) {
      await publishProfiles.save(`C:/sln/P${index}/P${index}.csproj`, DEFAULT_PUBLISH_OPTIONS);
    }

    const raw = JSON.parse(readFileSync(join(root, 'publish-profiles.json'), 'utf8'));
    assert.equal(Object.keys(raw).length, MAX_REMEMBERED_PROJECTS);
    assert.equal(await publishProfiles.load('C:/sln/P0/P0.csproj'), null);
    assert.notEqual(await publishProfiles.load(`C:/sln/P${MAX_REMEMBERED_PROJECTS + 4}/P${MAX_REMEMBERED_PROJECTS + 4}.csproj`), null);
  });

  it('volver a publicar un proyecto lo rescata de la cola de la poda', async () => {
    const first = 'C:/sln/P0/P0.csproj';
    await publishProfiles.save(first, DEFAULT_PUBLISH_OPTIONS);

    for (let index = 1; index < MAX_REMEMBERED_PROJECTS; index++) {
      await publishProfiles.save(`C:/sln/P${index}/P${index}.csproj`, DEFAULT_PUBLISH_OPTIONS);
    }

    // Se vuelve a publicar el primero: pasa al final y ya no es el candidato a irse.
    await publishProfiles.save(first, { ...DEFAULT_PUBLISH_OPTIONS, configuration: 'Debug' });
    await publishProfiles.save('C:/sln/Nuevo/Nuevo.csproj', DEFAULT_PUBLISH_OPTIONS);

    assert.equal((await publishProfiles.load(first)).configuration, 'Debug');
    assert.equal(await publishProfiles.load('C:/sln/P1/P1.csproj'), null);
  });
});
