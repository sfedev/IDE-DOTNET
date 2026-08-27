/**
 * Pruebas del ciclo de vida del actualizador in-app.
 *
 * Aquí se ejercita lo que sólo ocurre **entre dos sesiones**: el IDE se cierra, el instalador se
 * lanza y el arranque siguiente tiene que decir si aquello pasó o no. Es la mitad del actualizador
 * que nadie prueba a mano, porque hacerlo exige publicar una release, instalarla y —para el caso
 * interesante— cancelarle a Windows el aviso de permisos.
 *
 * Todo esto se puede probar con Node pelado porque el servicio no importa `electron`: `userData`,
 * la versión que corre y el cierre se le inyectan. Lo único que se fabrica aquí es el directorio
 * `updates/` con su `pending.json` y un archivo que hace de instalador descargado.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { updaterService } from '../../build/main-lib.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const roots = [];

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dotforge-updates-'));
  roots.push(root);
  mkdirSync(join(root, 'updates'), { recursive: true });
  return root;
}

/** Deja en el disco un instalador descargado y su registro, como los habría dejado la sesión anterior. */
function seedPending(root, record) {
  const file = join(root, 'updates', 'DotForge IDE-2.8.0-Setup-x64.exe');
  if (record.fileExists !== false) writeFileSync(file, 'instalador de mentira');

  writeFileSync(
    join(root, 'updates', 'pending.json'),
    `${JSON.stringify({ file, savedAtUtc: '2026-08-20T09:00:00Z', ...record.entry }, null, 2)}\n`,
    'utf8',
  );

  return file;
}

function environment(root, currentVersion, quit = () => {}) {
  return { userDataPath: root, currentVersion, platform: 'win32', arch: 'x64', quit };
}

beforeEach(async () => {
  // El servicio guarda estado de módulo: sin esto, una prueba arrastra el `pending` de la anterior.
  await updaterService.forget().catch(() => {});
  updaterService.setListener(null);
});

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('el arranque cierra el ciclo de la sesión anterior', () => {
  it('la versión prometida ya es la que corre: felicita y borra la descarga', async () => {
    const root = freshRoot();
    const file = seedPending(root, {
      entry: { version: '2.8.0', attempts: 1, notes: ['· Publicar un proyecto'], releaseUrl: 'https://x/y' },
    });

    const state = await updaterService.initialize(environment(root, '2.8.0'));

    assert.equal(state.outcome?.kind, 'just-updated');
    assert.equal(state.outcome.version, '2.8.0');
    assert.deepEqual(state.outcome.notes, ['· Publicar un proyecto']);
    assert.equal(state.applyOnQuit, false);

    // 130 MB de instalador ya aplicado no tienen por qué seguir ahí.
    assert.equal(existsSync(file), false, 'la descarga aplicada se borra');
    assert.equal(updaterService.hasPendingInstall(), false);
  });

  /**
   * El caso que justifica todo esto. Hasta ahora, cancelar el aviso de permisos de Windows dejaba
   * al usuario en la versión de siempre con la tarjeta callada: lo que pulsó no ocurrió y no había
   * ninguna forma de enterarse.
   */
  it('se lanzó el instalador y el IDE sigue en la versión de antes: lo dice, y a la vista', async () => {
    const root = freshRoot();
    seedPending(root, { entry: { version: '2.8.0', attempts: 1, notes: [], releaseUrl: null } });

    const state = await updaterService.initialize(environment(root, '2.7.0'));

    assert.equal(state.outcome?.kind, 'install-failed');
    assert.equal(state.outcome.attempts, 1);
    // `dismissed` es lo que decide si la tarjeta se pinta: un aviso escondido no es un aviso.
    assert.equal(state.dismissed, false);
    // Y no se reintenta solo: pudo cancelarse a propósito.
    assert.equal(state.applyOnQuit, false);
    assert.equal(updaterService.hasPendingInstall(), false);
    // La descarga se conserva: reintentarlo no puede volver a bajar 130 MB.
    assert.equal(state.downloadedPath !== null && existsSync(state.downloadedPath), true);
  });

  it('descargada y nunca lanzada: se rearma la promesa en silencio, como siempre', async () => {
    const root = freshRoot();
    seedPending(root, { entry: { version: '2.8.0', attempts: 0, notes: [], releaseUrl: null } });

    const state = await updaterService.initialize(environment(root, '2.7.0'));

    assert.equal(state.status, 'ready');
    assert.equal(state.outcome, null);
    assert.equal(state.dismissed, true);
    assert.equal(state.applyOnQuit, true);
    assert.equal(updaterService.hasPendingInstall(), true);
  });

  /**
   * `pending.json` lo escribe una versión del IDE y lo lee otra. El de la v2.7.0 no tiene
   * `attempts` ni `notes`: descartarlo entero perdería una descarga de 130 MB, y tratarlo como un
   * intento fallido pintaría un aviso de error a todo el que actualice desde esa versión.
   */
  it('un registro de una versión anterior del IDE se lee y no se malinterpreta', async () => {
    const root = freshRoot();
    seedPending(root, { entry: { version: '2.8.0' } });

    const state = await updaterService.initialize(environment(root, '2.7.0'));

    assert.equal(state.status, 'ready');
    assert.equal(state.outcome, null);
    assert.equal(state.applyOnQuit, true);
  });

  it('sin el archivo descargado no queda nada que hacer ni nada que decir', async () => {
    const root = freshRoot();
    seedPending(root, { fileExists: false, entry: { version: '2.8.0', attempts: 1 } });

    const state = await updaterService.initialize(environment(root, '2.7.0'));

    assert.equal(state.status, 'idle');
    assert.equal(state.outcome, null);
  });

  it('sin nada pendiente, el arranque no inventa ningún aviso', async () => {
    const root = freshRoot();
    const state = await updaterService.initialize(environment(root, '2.7.0'));

    assert.equal(state.status, 'idle');
    assert.equal(state.outcome, null);
  });
});

describe('el intento se anota antes de lanzar el instalador', () => {
  it('lanzar suma un intento en el disco, que es lo que lo hace visible en el arranque siguiente', async () => {
    const root = freshRoot();
    seedPending(root, { entry: { version: '2.8.0', attempts: 0, notes: [], releaseUrl: null } });

    await updaterService.initialize(environment(root, '2.7.0'));
    assert.equal(updaterService.hasPendingInstall(), true);

    // Lanza el instalador de mentira. Que el `spawn` falle o no da igual: lo que se comprueba es la
    // anotación, que ocurre **antes** — para cuando el instalador termina ya no hay proceso que
    // pueda escribir nada.
    updaterService.runPendingInstaller();

    const record = JSON.parse(readFileSync(join(root, 'updates', 'pending.json'), 'utf8'));
    assert.equal(record.attempts, 1);

    // Y el arranque siguiente lo lee como lo que es.
    const state = await updaterService.initialize(environment(root, '2.7.0'));
    assert.equal(state.outcome?.kind, 'install-failed');
  });

  /**
   * Dos cierres sin que la instalación llegue a aplicarse tienen que contarse como dos, no como
   * uno: el mensaje dice cuántos van a partir del segundo, y con un contador que se pisa a sí mismo
   * el usuario leería "primer intento" indefinidamente.
   */
  it('los intentos se acumulan entre sesiones', async () => {
    const root = freshRoot();
    seedPending(root, { entry: { version: '2.8.0', attempts: 0, notes: [], releaseUrl: null } });

    await updaterService.initialize(environment(root, '2.7.0'));
    updaterService.runPendingInstaller();

    // Segunda sesión: el aviso aparece, el usuario reintenta y vuelve a no aplicarse.
    await updaterService.initialize(environment(root, '2.7.0'));
    await updaterService.applyOnQuit(true);
    updaterService.runPendingInstaller();

    const record = JSON.parse(readFileSync(join(root, 'updates', 'pending.json'), 'utf8'));
    assert.equal(record.attempts, 2);

    const state = await updaterService.initialize(environment(root, '2.7.0'));
    assert.equal(state.outcome?.attempts, 2);
  });
});

describe('las acciones de la tarjeta no se pisan entre sí', () => {
  /**
   * Cerrar el "✅ ¡Actualizado!" es cerrar una noticia, no posponer una actualización. Con
   * `dismiss` armando `applyOnQuit` a ciegas, ese clic dejaba programada al cierre una instalación
   * que ya no existía.
   */
  it('descartar sin nada pendiente no programa ninguna instalación', async () => {
    const root = freshRoot();
    seedPending(root, { entry: { version: '2.8.0', attempts: 1, notes: [], releaseUrl: null } });

    await updaterService.initialize(environment(root, '2.8.0'));
    const state = updaterService.dismiss();

    assert.equal(state.applyOnQuit, false);
    assert.equal(updaterService.hasPendingInstall(), false);
  });

  it('"entendido" borra el aviso y no toca nada más', async () => {
    const root = freshRoot();
    seedPending(root, { entry: { version: '2.8.0', attempts: 1, notes: ['· Algo'], releaseUrl: null } });

    await updaterService.initialize(environment(root, '2.8.0'));
    const state = updaterService.acknowledgeOutcome();

    assert.equal(state.outcome, null);
    assert.equal(state.dismissed, false);
  });

  it('reintentar retira el aviso de fallo: si vuelve a fallar, lo reescribe el arranque siguiente', async () => {
    const root = freshRoot();
    seedPending(root, { entry: { version: '2.8.0', attempts: 1, notes: [], releaseUrl: null } });

    let quits = 0;
    await updaterService.initialize(environment(root, '2.7.0', () => (quits += 1)));
    assert.equal(updaterService.getState().outcome?.kind, 'install-failed');

    const state = await updaterService.applyOnQuit(true);

    assert.equal(state.outcome, null);
    assert.equal(state.applyOnQuit, true);
    assert.equal(quits, 1, 'aplicar con `now` cierra el IDE, que es lo que dispara la instalación');
  });
});

/**
 * Dónde se lanza el instalador.
 *
 * Es una comprobación estructural porque lo que se vigila sólo ocurre dentro de Electron y sólo
 * cuando hay un archivo sin guardar: `before-quit` se emite al *empezar* a cerrar, y el aviso de
 * cambios sin guardar puede anular la salida después. El instalador se lanzaba igual y reemplazaba
 * los archivos de una aplicación que se quedaba abierta, justo después de anunciar lo contrario.
 */
describe('el instalador se lanza cuando la salida ya es un hecho', () => {
  const main = readFileSync(join(repoRoot, 'src', 'main', 'main.ts'), 'utf8');

  it('la instalación cuelga de `will-quit`, no de `before-quit`', () => {
    const willQuit = main.indexOf("app.on('will-quit'");
    const beforeQuit = main.indexOf("app.on('before-quit'");

    assert.ok(willQuit > 0, 'existe un manejador de will-quit');
    assert.ok(beforeQuit > 0, 'existe un manejador de before-quit');
    assert.ok(
      main.indexOf('runPendingInstaller()') > willQuit,
      'runPendingInstaller vive dentro de will-quit',
    );
    assert.equal(
      main.slice(beforeQuit, willQuit).includes('runPendingInstaller'),
      false,
      'before-quit no puede lanzar el instalador: ese cierre todavía se puede cancelar',
    );
  });
});
