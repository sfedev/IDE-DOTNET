/**
 * Pruebas de la disposición de pestañas de terminal.
 *
 * Dos cosas se ejercitan aquí y las dos se equivocan en silencio: el saneado de lo que llega —del
 * renderer y del disco, que son dos orígenes que no controlamos— y qué se puede reabrir de verdad
 * en esta máquina. Un identificador de perfil guardado por otra versión del IDE acaba decidiendo
 * qué intérprete se lanza, así que "se sanea al leer" no es una formalidad.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  coerceIncomingLayout,
  coerceStoredLayout,
  emptyLayout,
  isRestorable,
  MAX_REMEMBERED_WORKSPACES,
  MAX_RESTORED_TABS,
  restorablePlan,
  terminalLayoutStore,
} from '../../build/main-lib.mjs';

describe('saneado de lo que llega del renderer', () => {
  it('deja pasar una disposición normal', () => {
    const layout = coerceIncomingLayout({ tabs: ['powershell', 'cmd'], activeIndex: 1 }, 'win32');
    assert.deepEqual(layout, { tabs: ['powershell', 'cmd'], activeIndex: 1 });
  });

  /**
   * Un identificador desconocido no es un error: es una migración. Cae al perfil por defecto en vez
   * de tirar la disposición entera o, peor, acabar como nombre de un programa a lanzar.
   */
  it('un perfil desconocido cae al de por defecto de la plataforma', () => {
    assert.deepEqual(coerceIncomingLayout({ tabs: ['fish'] }, 'win32').tabs, ['powershell']);
    assert.deepEqual(coerceIncomingLayout({ tabs: ['C:\\evil.exe'] }, 'win32').tabs, ['powershell']);
  });

  it('un perfil de otra plataforma tampoco pasa', () => {
    assert.deepEqual(coerceIncomingLayout({ tabs: ['zsh'] }, 'win32').tabs, ['powershell']);
    assert.deepEqual(coerceIncomingLayout({ tabs: ['cmd'] }, 'darwin').tabs, ['zsh']);
  });

  it('lo que no es una disposición no revienta: sale una vacía', () => {
    for (const raw of [null, undefined, 42, 'tabs', { tabs: 'powershell' }]) {
      assert.deepEqual(coerceIncomingLayout(raw, 'win32'), { tabs: [], activeIndex: 0 });
    }
  });

  it('el índice activo se pinza dentro del rango en vez de tirarlo todo', () => {
    assert.equal(coerceIncomingLayout({ tabs: ['cmd', 'lite'], activeIndex: 99 }, 'win32').activeIndex, 1);
    assert.equal(coerceIncomingLayout({ tabs: ['cmd', 'lite'], activeIndex: -3 }, 'win32').activeIndex, 0);
    assert.equal(coerceIncomingLayout({ tabs: ['cmd'], activeIndex: 1.7 }, 'win32').activeIndex, 0);
    assert.equal(coerceIncomingLayout({ tabs: [], activeIndex: 4 }, 'win32').activeIndex, 0);
  });

  /**
   * El tope se aplica al guardar, no al restaurar: así el archivo dice la verdad sobre lo que se va
   * a hacer con él. Doce intérpretes abriéndose a la vez mientras el IDE carga Monaco y parsea el
   * `.sln` es una tormenta de procesos en el peor momento.
   */
  it('no se guardan más pestañas de las que se van a reabrir', () => {
    const many = Array.from({ length: MAX_RESTORED_TABS + 5 }, () => 'cmd');
    assert.equal(coerceIncomingLayout({ tabs: many }, 'win32').tabs.length, MAX_RESTORED_TABS);
  });
});

describe('saneado de lo que llega del disco', () => {
  it('conserva el directorio guardado', () => {
    const layout = coerceStoredLayout({ tabs: ['cmd'], activeIndex: 0, cwd: 'C:\\repos\\Acme' }, 'win32');
    assert.equal(layout.cwd, 'C:\\repos\\Acme');
  });

  it('un directorio que no es una ruta desaparece', () => {
    for (const cwd of [null, 42, '', '   ', {}]) {
      assert.equal(coerceStoredLayout({ tabs: ['cmd'], cwd }, 'win32').cwd, null);
    }
  });

  it('un archivo ilegible da una disposición vacía, no una excepción', () => {
    assert.deepEqual(coerceStoredLayout(null, 'win32'), emptyLayout());
    assert.deepEqual(coerceStoredLayout('{}', 'win32'), emptyLayout());
  });

  it('los perfiles del disco pasan por el mismo saneado que los del renderer', () => {
    assert.deepEqual(coerceStoredLayout({ tabs: ['zsh', 'cmd'] }, 'win32').tabs, ['powershell', 'cmd']);
  });
});

describe('qué merece restaurarse', () => {
  /**
   * Restaurar "una pestaña asistida" es exactamente lo que el panel ya hace al arrancar. Ofrecerlo
   * como restauración sería trabajo y parpadeo para dejar la pantalla igual.
   */
  it('una sola asistida no es una disposición que restaurar', () => {
    assert.equal(isRestorable({ tabs: ['lite'], activeIndex: 0, cwd: null }), false);
    assert.equal(isRestorable(emptyLayout()), false);
  });

  it('cualquier otra cosa sí', () => {
    assert.equal(isRestorable({ tabs: ['powershell'], activeIndex: 0, cwd: null }), true);
    assert.equal(isRestorable({ tabs: ['lite', 'lite'], activeIndex: 0, cwd: null }), true);
  });
});

describe('plan de reapertura', () => {
  const layout = (tabs, activeIndex = 0) => ({ tabs, activeIndex, cwd: null });

  it('con pseudoterminales disponibles se reabre todo', () => {
    const plan = restorablePlan(layout(['powershell', 'cmd', 'lite'], 1), { ptyAvailable: true });
    assert.deepEqual(plan, { tabs: ['powershell', 'cmd', 'lite'], activeIndex: 1, skipped: 0 });
  });

  /**
   * Sin `node-pty` no se abre una pestaña de intérprete: dejaría una pestaña muerta con un mensaje
   * dentro, que es justo lo que `openTerminal` evita al crearlas a mano.
   */
  it('sin pseudoterminales se saltan las que las necesitan, y se dice cuántas', () => {
    const plan = restorablePlan(layout(['powershell', 'lite', 'cmd'], 2), { ptyAvailable: false });
    assert.deepEqual(plan, { tabs: ['lite'], activeIndex: 0, skipped: 2 });
  });

  it('si no queda ninguna, no se inventa ninguna: lo decide quien restaura', () => {
    const plan = restorablePlan(layout(['powershell', 'cmd']), { ptyAvailable: false });
    assert.deepEqual(plan, { tabs: [], activeIndex: 0, skipped: 2 });
  });

  /**
   * El índice activo señala una posición de la lista guardada. Si se cae una pestaña por delante,
   * el mismo número apunta a otra: hay que recalcularlo, no arrastrarlo.
   */
  it('la pestaña activa sigue siendo la misma aunque se caigan las de delante', () => {
    const plan = restorablePlan(layout(['powershell', 'cmd', 'lite'], 2), { ptyAvailable: false });
    assert.equal(plan.tabs[plan.activeIndex], 'lite');
  });

  it('si la activa es una de las que se caen, se activa la primera que quede', () => {
    const plan = restorablePlan(layout(['lite', 'cmd'], 1), { ptyAvailable: false });
    assert.deepEqual(plan, { tabs: ['lite'], activeIndex: 0, skipped: 1 });
  });

  it('un perfil que ya no existe en el catálogo se ignora sin contarlo como saltado', () => {
    // No es que no se pueda abrir aquí: es que ya no existe. Contarlo diría al usuario que le
    // faltan pseudoterminales, que es una explicación falsa.
    const plan = restorablePlan(layout(['fantasma', 'lite']), { ptyAvailable: true });
    assert.deepEqual(plan, { tabs: ['lite'], activeIndex: 0, skipped: 0 });
  });
});

/**
 * El almacén, contra un directorio de verdad.
 *
 * Lo que se ejercita es lo que sólo se ve escribiendo: que la entrada se guarda por solución, que
 * la poda se lleva la que lleva más tiempo sin tocarse y no la primera que se creó, y que un
 * archivo escrito por Visual Studio —o por cualquier cosa que ponga marca de orden de bytes— se
 * sigue leyendo (ADR-058).
 */
describe('almacén por solución', () => {
  const workspace = (name) => join(process.platform === 'win32' ? 'C:\\repos' : '/repos', name);

  async function withStore(run) {
    const directory = await mkdtemp(join(tmpdir(), 'dotforge-layouts-'));
    try {
      terminalLayoutStore.initialize(directory);
      await run(directory);
    } finally {
      terminalLayoutStore.resetCache();
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('guarda y devuelve la disposición de cada solución por separado', async () => {
    await withStore(async () => {
      await terminalLayoutStore.save(workspace('Acme'), { tabs: ['powershell', 'cmd'], activeIndex: 1, cwd: 'C:\\repos\\Acme\\src' }, 'win32');
      await terminalLayoutStore.save(workspace('Otra'), { tabs: ['lite'], activeIndex: 0, cwd: null }, 'win32');

      assert.deepEqual((await terminalLayoutStore.load(workspace('Acme'), 'win32')).tabs, ['powershell', 'cmd']);
      assert.deepEqual((await terminalLayoutStore.load(workspace('Otra'), 'win32')).tabs, ['lite']);
    });
  });

  it('una solución sin nada guardado devuelve una disposición vacía', async () => {
    await withStore(async () => {
      assert.deepEqual(await terminalLayoutStore.load(workspace('Nunca'), 'win32'), emptyLayout());
    });
  });

  it('lo guardado sobrevive a releer el archivo del disco', async () => {
    await withStore(async () => {
      await terminalLayoutStore.save(workspace('Acme'), { tabs: ['cmd'], activeIndex: 0, cwd: 'C:\\repos\\Acme\\src' }, 'win32');
      terminalLayoutStore.resetCache();

      const restored = await terminalLayoutStore.load(workspace('Acme'), 'win32');
      assert.deepEqual(restored.tabs, ['cmd']);
      assert.equal(restored.cwd, 'C:\\repos\\Acme\\src');
    });
  });

  it('se lee aunque el archivo lleve marca de orden de bytes', async () => {
    await withStore(async (directory) => {
      const contents = JSON.stringify({ [workspace('Acme')]: { tabs: ['cmd'], activeIndex: 0, cwd: null } });
      await writeFile(join(directory, 'terminal-layouts.json'), `\uFEFF${contents}`, 'utf8');
      terminalLayoutStore.resetCache();

      assert.deepEqual((await terminalLayoutStore.load(workspace('Acme'), 'win32')).tabs, ['cmd']);
    });
  });

  it('un archivo ilegible no impide abrir una solución', async () => {
    await withStore(async (directory) => {
      await writeFile(join(directory, 'terminal-layouts.json'), 'esto no es JSON {{{', 'utf8');
      terminalLayoutStore.resetCache();

      assert.deepEqual(await terminalLayoutStore.load(workspace('Acme'), 'win32'), emptyLayout());
      // Y la primera escritura lo arregla, en vez de arrastrar el archivo roto para siempre.
      await terminalLayoutStore.save(workspace('Acme'), { tabs: ['cmd'], activeIndex: 0, cwd: null }, 'win32');
      assert.deepEqual((await terminalLayoutStore.load(workspace('Acme'), 'win32')).tabs, ['cmd']);
    });
  });

  /**
   * Se poda por uso, no por antigüedad: volver a guardar una solución la lleva al final de la cola.
   * Podando por orden de creación se perdería justo la que más se usa.
   */
  it('la poda se lleva la que lleva más tiempo sin tocarse', async () => {
    await withStore(async () => {
      for (let index = 0; index < MAX_REMEMBERED_WORKSPACES; index++) {
        await terminalLayoutStore.save(workspace(`w${index}`), { tabs: ['cmd'], activeIndex: 0, cwd: null }, 'win32');
      }

      // Se vuelve a tocar la primera: deja de ser la candidata a caer.
      await terminalLayoutStore.save(workspace('w0'), { tabs: ['lite'], activeIndex: 0, cwd: null }, 'win32');
      await terminalLayoutStore.save(workspace('nueva'), { tabs: ['cmd'], activeIndex: 0, cwd: null }, 'win32');

      assert.deepEqual((await terminalLayoutStore.load(workspace('w0'), 'win32')).tabs, ['lite'], 'ha caído la más usada');
      assert.deepEqual((await terminalLayoutStore.load(workspace('w1'), 'win32')).tabs, [], 'debería haber caído w1');
      assert.deepEqual((await terminalLayoutStore.load(workspace('nueva'), 'win32')).tabs, ['cmd']);
    });
  });

  it('sin solución abierta no se guarda nada: no hay de qué colgarlo', async () => {
    await withStore(async (directory) => {
      await terminalLayoutStore.save('', { tabs: ['cmd'], activeIndex: 0, cwd: null }, 'win32');
      assert.equal(existsSync(join(directory, 'terminal-layouts.json')), false);
    });
  });

  it('olvidar una solución no toca las demás', async () => {
    await withStore(async () => {
      await terminalLayoutStore.save(workspace('Acme'), { tabs: ['cmd'], activeIndex: 0, cwd: null }, 'win32');
      await terminalLayoutStore.save(workspace('Otra'), { tabs: ['lite'], activeIndex: 0, cwd: null }, 'win32');

      await terminalLayoutStore.forget(workspace('Acme'), 'win32');
      terminalLayoutStore.resetCache();

      assert.deepEqual((await terminalLayoutStore.load(workspace('Acme'), 'win32')).tabs, []);
      assert.deepEqual((await terminalLayoutStore.load(workspace('Otra'), 'win32')).tabs, ['lite']);
    });
  });
});
