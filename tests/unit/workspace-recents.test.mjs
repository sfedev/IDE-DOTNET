/**
 * Pruebas del historial de workspaces recientes.
 *
 * El fallo que originó este módulo: al arrancar, el IDE intentaba reabrir el último workspace sin
 * comprobar si seguía existiendo, y el proceso principal escupía un ENOENT crudo en cada arranque.
 * Estas pruebas fijan las dos reglas que lo evitan: qué se considera abrible y qué se reabre.
 *
 * Se usan carpetas y archivos de verdad: comprobar la existencia con un doble no probaría nada.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeRecents, firstAvailable, isOpenableWorkspace } from '../../build/main-lib.mjs';

let workspace;
let existente;
let borrada;
let archivo;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dfwr-'));

  existente = join(workspace, 'proyecto-vivo');
  await mkdir(existente, { recursive: true });

  borrada = join(workspace, 'proyecto-borrado');
  await mkdir(borrada, { recursive: true });
  await rm(borrada, { recursive: true, force: true });

  archivo = join(workspace, 'esto-es-un-archivo.txt');
  await writeFile(archivo, 'no soy una carpeta', 'utf8');
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('isOpenableWorkspace', () => {
  it('acepta una carpeta que existe', () => {
    assert.equal(isOpenableWorkspace(existente), true);
  });

  it('rechaza una carpeta borrada', () => {
    assert.equal(isOpenableWorkspace(borrada), false);
  });

  it('rechaza un archivo con el nombre de la carpeta que hubo', () => {
    // Si se aceptara, el error aparecería más adelante y con un mensaje peor.
    assert.equal(isOpenableWorkspace(archivo), false);
  });

  it('rechaza rutas vacías o que no son cadenas sin lanzar', () => {
    assert.equal(isOpenableWorkspace(''), false);
    assert.equal(isOpenableWorkspace('   '), false);
    assert.equal(isOpenableWorkspace(null), false);
    assert.equal(isOpenableWorkspace(undefined), false);
    assert.equal(isOpenableWorkspace(42), false);
  });
});

describe('describeRecents', () => {
  it('marca cada entrada con su disponibilidad y conserva el orden', () => {
    const result = describeRecents([borrada, existente]);

    assert.deepEqual(result, [
      { path: borrada, available: false },
      { path: existente, available: true },
    ]);
  });

  it('no borra del historial lo que no está disponible', () => {
    // Una carpeta en un disco desconectado debe seguir en la lista: perder el historial por
    // arrancar sin el disco puesto sería peor que enseñar una entrada apagada.
    assert.equal(describeRecents([borrada]).length, 1);
  });

  it('descarta duplicados y basura sin romperse', () => {
    const result = describeRecents([existente, existente, '', '   ', null, 7, undefined]);

    assert.equal(result.length, 1);
    assert.equal(result[0].path, existente);
  });

  it('un historial vacío devuelve una lista vacía', () => {
    assert.deepEqual(describeRecents([]), []);
  });
});

describe('firstAvailable', () => {
  it('devuelve el primero que se puede abrir de verdad, no el primero de la lista', () => {
    assert.equal(firstAvailable(describeRecents([borrada, existente])), existente);
  });

  it('devuelve null si ninguno está disponible: no hay nada que reabrir', () => {
    assert.equal(firstAvailable(describeRecents([borrada])), null);
    assert.equal(firstAvailable([]), null);
  });

  it('respeta el orden del historial entre los disponibles', () => {
    const otro = join(workspace, 'otro-vivo');
    assert.equal(firstAvailable([
      { path: otro, available: false },
      { path: existente, available: true },
    ]), existente);
  });
});
