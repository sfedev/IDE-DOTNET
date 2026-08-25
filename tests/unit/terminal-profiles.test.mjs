/**
 * Pruebas de los perfiles de terminal y del servicio de pseudoterminales (Fase 21).
 *
 * Dos mitades muy distintas:
 *
 *  - El **catálogo** es dato puro y se prueba con Node pelado: qué se ofrece en cada plataforma,
 *    qué pasa con un identificador guardado por otra versión del IDE y cómo se numeran las
 *    pestañas.
 *  - El **servicio** abre un intérprete de verdad en un directorio temporal. Una terminal que sólo
 *    se prueba con dobles no está probada: lo que hay que saber es que escribe, que contesta y que
 *    al cerrarla no queda nada vivo.
 *
 * Si `node-pty` no está disponible en este equipo, la mitad del servicio se salta con una razón
 * escrita en vez de ponerse en rojo: la ausencia del binario opcional es un estado válido y el IDE
 * tiene que seguir funcionando con la terminal asistida.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  coerceProfileId,
  defaultProfileId,
  findProfile,
  MAX_PTY_SESSIONS,
  MAX_WRITE_CHARS,
  profilesFor,
  ptyService,
  PtyUnavailableError,
  TERMINAL_PROFILES,
  terminalTabName,
} from '../../build/main-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('catálogo de perfiles', () => {
  it('cada perfil declara lo que hace falta para lanzarlo o para no lanzarlo', () => {
    for (const profile of TERMINAL_PROFILES) {
      assert.ok(profile.id, 'todo perfil tiene identificador');
      assert.ok(profile.label, `${profile.id} sin etiqueta`);
      assert.ok(profile.hint, `${profile.id} sin explicación: el menú necesita decir qué aporta`);
      assert.ok(profile.platforms.length > 0, `${profile.id} sin plataformas`);

      if (profile.kind === 'pty') assert.ok(profile.file, `${profile.id} es de PTY y no dice qué lanzar`);
      else assert.equal(profile.file, null, 'la terminal asistida no lanza ningún intérprete');
    }
  });

  it('los identificadores no se repiten', () => {
    const ids = TERMINAL_PROFILES.map((profile) => profile.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('la terminal asistida está en todas las plataformas: es la que funciona siempre', () => {
    const lite = findProfile('lite');
    assert.equal(lite.kind, 'lite');
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.ok(profilesFor(platform).some((profile) => profile.id === 'lite'), platform);
    }
  });

  it('cada plataforma ofrece lo suyo y nada de las otras', () => {
    const windows = profilesFor('win32').map((profile) => profile.id);
    assert.deepEqual(windows, ['pwsh', 'powershell', 'cmd', 'lite']);
    assert.ok(!windows.includes('bash'), 'bash no se ofrece en Windows');

    const mac = profilesFor('darwin').map((profile) => profile.id);
    assert.ok(mac.includes('zsh') && mac.includes('bash'));
    assert.ok(!mac.includes('cmd'), 'cmd.exe no se ofrece en macOS');
  });

  it('en Windows el predeterminado es PowerShell, no la asistida', () => {
    // Quien abre una terminal en un IDE espera una terminal: descubrir que no ejecuta lo que
    // acaba de escribir es una sorpresa desagradable.
    assert.equal(defaultProfileId('win32'), 'powershell');
    assert.notEqual(defaultProfileId('darwin'), 'lite');
  });

  it('el orden del menú pone primero lo que se va a elegir', () => {
    const windows = profilesFor('win32');
    assert.equal(windows[0].id, 'pwsh', 'quien tiene PowerShell 7 instalado lo tiene por algo');
    assert.equal(windows.at(-1).id, 'lite', 'la asistida va la última: es la alternativa');
  });
});

describe('saneado del identificador de perfil', () => {
  it('acepta uno bueno', () => {
    assert.equal(coerceProfileId('cmd', 'win32'), 'cmd');
  });

  it('un perfil desconocido cae al predeterminado en vez de lanzar', () => {
    // Puede venir de una preferencia escrita por otra versión del IDE: eso es una migración, no un
    // error.
    assert.equal(coerceProfileId('fish', 'win32'), 'powershell');
    assert.equal(coerceProfileId(42, 'win32'), 'powershell');
    assert.equal(coerceProfileId(null, 'win32'), 'powershell');
    assert.equal(coerceProfileId(undefined, 'win32'), 'powershell');
  });

  it('un perfil de otra plataforma tampoco cuela', () => {
    assert.equal(coerceProfileId('cmd', 'darwin'), profilesFor('darwin')[0].id);
    assert.equal(coerceProfileId('zsh', 'win32'), 'powershell');
  });

  it('lo que devuelve siempre es un perfil real de esta plataforma', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const value of ['fish', '', '../../etc/passwd', 'lite', 'powershell']) {
        const id = coerceProfileId(value, platform);
        assert.ok(
          profilesFor(platform).some((profile) => profile.id === id),
          `${value} en ${platform} devolvió ${id}`,
        );
      }
    }
  });
});

describe('nombre de las pestañas', () => {
  it('la primera de cada clase va sin número', () => {
    assert.equal(terminalTabName(findProfile('powershell'), 0), 'PowerShell');
  });

  it('se numera por perfil, no con un contador global', () => {
    // Con dos PowerShell y un cmd abiertos, "PowerShell 2" dice algo y "Terminal 3" no dice nada.
    assert.equal(terminalTabName(findProfile('powershell'), 1), 'PowerShell 2');
    assert.equal(terminalTabName(findProfile('cmd'), 0), 'Símbolo del sistema');
  });
});

/**
 * Sesiones de verdad.
 *
 * Las que abren un intérprete se ejecutan en `pty-session.probe.mjs`, **como proceso aparte**, y no
 * por comodidad: al matar una sesión de ConPTY node-pty lanza un ayudante que deja el bucle de
 * eventos del padre vivo, y con él dentro de `node --test` la suite pasaba en verde y no terminaba
 * nunca. Es el mismo fallo que ya costó caro con la prueba de humo de Electron y con el servidor
 * HTTP sin cerrar: verde y colgada es peor que roja.
 *
 * Aquí se prueba lo que no necesita intérprete —los estados de error, los topes y la lista— y se
 * comprueba el resultado de la sonda.
 */
describe('sesiones de pseudoterminal', () => {
  let workspace;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'dfpty-'));
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('la disponibilidad se contesta con un motivo escrito, nunca con una excepción', () => {
    const state = ptyService.availability();
    assert.equal(typeof state.available, 'boolean');
    if (!state.available) assert.match(state.reason, /node-pty/);
    else assert.equal(state.reason, null);
  });

  it('un perfil que no abre intérprete se rechaza como estado, no como fallo de programa', () => {
    assert.throws(
      () => ptyService.create({ profileId: 'lite', cwd: workspace }, { onData() {}, onExit() {} }),
      PtyUnavailableError,
    );
  });

  it('un perfil inventado tampoco abre nada', () => {
    assert.throws(
      () => ptyService.create({ profileId: 'fish', cwd: workspace }, { onData() {}, onExit() {} }),
      PtyUnavailableError,
    );
  });

  it('escribir, redimensionar o cerrar una sesión que no existe devuelve false, no lanza', () => {
    assert.equal(ptyService.write('no-existe', 'hola'), false);
    assert.equal(ptyService.resize('no-existe', 80, 24), false);
    assert.equal(ptyService.dispose('no-existe'), false);
  });

  it('los topes están declarados y son razonables', () => {
    assert.ok(MAX_WRITE_CHARS >= 64 * 1024, 'un pegado normal tiene que caber entero');
    assert.ok(MAX_WRITE_CHARS <= 4 * 1024 * 1024, 'pero no puede ser ilimitado');
    assert.ok(MAX_PTY_SESSIONS >= 4 && MAX_PTY_SESSIONS <= 64);
  });

  /**
   * La tubería entera, contra un intérprete real: spawn, escritura, evento de datos, `exit` y
   * limpieza. Una terminal que sólo se prueba con dobles no está probada.
   */
  it('abre un intérprete de verdad, le escribe, lee lo que contesta y no deja nada vivo', async (t) => {
    if (!ptyService.availability().available) {
      t.skip('node-pty no está disponible en este equipo');
      return;
    }

    const probe = join(root, 'tests', 'unit', 'pty-session.probe.mjs');
    const { stdout, code } = await ejecutar(process.execPath, [probe], 60_000);

    assert.equal(code, 0, `la sonda ha fallado: ${stdout.trim()}`);
    assert.match(stdout, /PTY_OK/, stdout.trim());

    const resultado = JSON.parse(stdout.slice(stdout.indexOf('PTY_OK') + 'PTY_OK'.length));
    assert.ok(resultado.pid > 0, 'la sesión tiene un proceso detrás');
    assert.equal(resultado.eco, true, 'el intérprete devolvió lo que se le escribió');
    assert.equal(typeof resultado.salida, 'number', 'el `exit` del intérprete avisa');
    assert.equal(resultado.sesionesTrasCerrar, 0, 'la sesión se descuenta sola al terminar');
  });
});

describe('localización de intérpretes', () => {
  it('encuentra un programa que existe en el PATH', async () => {
    const conocido = process.platform === 'win32' ? 'cmd.exe' : 'sh';
    assert.equal(await ptyService.programExists(conocido), true);
  });

  it('no inventa uno que no existe', async () => {
    assert.equal(await ptyService.programExists('interprete-que-no-existe-12345'), false);
  });

  it('una ruta absoluta se comprueba tal cual', async () => {
    assert.equal(await ptyService.programExists(join(tmpdir(), 'no-existe-12345')), false);
  });
});

/** Lanza la sonda y recoge lo que imprime. Nunca rechaza: un fallo es un código de salida. */
function ejecutar(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, cwd: root }, (error, stdout, stderr) => {
      resolve({ stdout: `${stdout}${stderr}`, code: error ? (error.code ?? 1) : 0 });
    });
  });
}
