/**
 * Pruebas de la sesión de la terminal, con carpetas de verdad.
 *
 * Lo que aquí se comprueba es la mitad que no se puede probar sin disco: que `cd` resuelve contra
 * el sistema de archivos, que un destino que no existe se rechaza **con la ruta ya resuelta** en el
 * mensaje —"no existe `src`" no ayuda; "no existe `C:\repos\Acme\src`" se comprueba de un vistazo—
 * y que la sesión recuerda dónde estaba para poder volver.
 *
 * Se crean directorios temporales en vez de fingir `fs`: lo que se quiere saber es que la
 * resolución de rutas se comporta igual que en la máquina del usuario, incluidas las mayúsculas y
 * los separadores de Windows. Un doble de `fs` probaría el doble.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { terminalSession, TerminalCwdError } from '../../build/main-lib.mjs';

let root;
let home;
let workspace;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dotforge-term-'));
  home = join(root, 'usuario');
  workspace = join(root, 'repos', 'Acme.Shop');

  await mkdir(join(workspace, 'src', 'Acme.Shop.Api'), { recursive: true });
  await mkdir(join(workspace, 'tests'), { recursive: true });
  await mkdir(join(root, 'repos', 'Otra.Sln'), { recursive: true });
  await mkdir(join(home, 'Descargas'), { recursive: true });
  await writeFile(join(workspace, 'Acme.Shop.sln'), '', 'utf8');
});

after(async () => {
  terminalSession.reset();
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  terminalSession.reset();
  terminalSession.setContext({ home, workspace, workspaceName: 'Acme.Shop' });
});

describe('dónde arranca la terminal', () => {
  it('con una solución abierta, en su raíz', () => {
    assert.equal(terminalSession.cwd().path, resolve(workspace));
    assert.equal(terminalSession.cwd().display, 'Acme.Shop');
  });

  it('sin solución abierta, en la carpeta personal', () => {
    terminalSession.reset();
    terminalSession.setContext({ home, workspace: null, workspaceName: null });

    assert.equal(terminalSession.cwd().path, home);
    assert.equal(terminalSession.cwd().display, '~');
  });

  /**
   * Abrir otra solución muda la terminal. Seguir en la carpeta de la anterior es defendible en la
   * teoría y desconcertante en la práctica: el prompt diría una cosa y el explorador otra.
   */
  it('abrir otra solución muda la terminal', async () => {
    await terminalSession.changeDirectory('src');
    assert.match(terminalSession.cwd().display, /^Acme\.Shop/);

    const otra = join(root, 'repos', 'Otra.Sln');
    terminalSession.setContext({ home, workspace: otra, workspaceName: 'Otra.Sln' });

    assert.equal(terminalSession.cwd().path, resolve(otra));
  });

  it('reabrir la misma solución respeta dónde estaba el usuario', async () => {
    const inside = await terminalSession.changeDirectory('src');

    // Una relectura de la solución manda el mismo contexto: no puede tirar la navegación.
    terminalSession.setContext({ home, workspace, workspaceName: 'Acme.Shop' });
    assert.equal(terminalSession.cwd().path, inside.path);
  });
});

describe('navegar', () => {
  it('entra en una subcarpeta relativa', async () => {
    const next = await terminalSession.changeDirectory('src');

    assert.equal(next.path, resolve(workspace, 'src'));
    assert.equal(next.display, 'Acme.Shop\\src');
  });

  it('encadena varios saltos', async () => {
    await terminalSession.changeDirectory('src');
    const next = await terminalSession.changeDirectory('Acme.Shop.Api');

    assert.equal(next.path, resolve(workspace, 'src', 'Acme.Shop.Api'));
    assert.equal(next.display, 'Acme.Shop\\src\\Acme.Shop.Api');
  });

  it('sube con ..', async () => {
    await terminalSession.changeDirectory('src');
    const up = await terminalSession.changeDirectory('..');

    assert.equal(up.path, resolve(workspace));
  });

  it('acepta una ruta absoluta', async () => {
    const next = await terminalSession.changeDirectory(join(root, 'repos', 'Otra.Sln'));
    assert.equal(next.path, resolve(root, 'repos', 'Otra.Sln'));
  });

  /**
   * El caso que motivaba todo esto: salir de la solución para mirar otra. Antes no se podía, y no
   * por una comprobación de seguridad —no había ninguna— sino porque `cd` no llegaba a ejecutarse.
   */
  it('sale del workspace sin pedir permiso a nadie', async () => {
    const outside = await terminalSession.changeDirectory(join(root, 'repos'));

    assert.equal(outside.path, resolve(root, 'repos'));
    // Fuera del workspace y fuera del hogar: se enseña la ruta, no un nombre relativo.
    assert.ok(!outside.display.startsWith('Acme.Shop'), outside.display);
  });

  it('`cd` a secas vuelve a la solución', async () => {
    await terminalSession.changeDirectory(join(root, 'repos'));
    const back = await terminalSession.changeDirectory(null);

    assert.equal(back.path, resolve(workspace));
  });

  it('`~` lleva a la carpeta personal', async () => {
    const next = await terminalSession.changeDirectory('~');
    assert.equal(next.path, resolve(home));
    assert.equal(next.display, '~');
  });

  it('`~/algo` cuelga de la carpeta personal', async () => {
    const next = await terminalSession.changeDirectory('~/Descargas');
    assert.equal(next.path, resolve(home, 'Descargas'));
    assert.equal(next.display, '~\\Descargas');
  });

  it('`-` vuelve al anterior, y otra vez `-` deshace el salto', async () => {
    await terminalSession.changeDirectory('src');
    await terminalSession.changeDirectory('../tests');

    const back = await terminalSession.changeDirectory('-');
    assert.equal(back.path, resolve(workspace, 'src'));

    const forward = await terminalSession.changeDirectory('-');
    assert.equal(forward.path, resolve(workspace, 'tests'));
  });

  it('`-` sin anterior lo dice en vez de no hacer nada', async () => {
    await assert.rejects(() => terminalSession.changeDirectory('-'), TerminalCwdError);
  });
});

describe('destinos que no valen', () => {
  it('una carpeta que no existe se rechaza con la ruta ya resuelta', async () => {
    await assert.rejects(
      () => terminalSession.changeDirectory('no-existe'),
      (error) => {
        assert.ok(error instanceof TerminalCwdError);
        assert.match(error.message, /no existe la carpeta/);
        // La ruta completa, no lo que se escribió: es lo que se puede comprobar de un vistazo.
        assert.ok(error.message.includes(resolve(workspace, 'no-existe')), error.message);
        return true;
      },
    );
  });

  it('un archivo no es una carpeta, y se dice', async () => {
    await assert.rejects(() => terminalSession.changeDirectory('Acme.Shop.sln'), /no es una carpeta/);
  });

  it('un destino inválido no mueve la sesión', async () => {
    const before = terminalSession.cwd().path;
    await assert.rejects(() => terminalSession.changeDirectory('no-existe'));

    assert.equal(terminalSession.cwd().path, before);
  });
});

describe('órdenes que no lanzan ningún proceso', () => {
  it('`cd` se atiende aquí y no llega al ejecutor', async () => {
    const outcome = await terminalSession.handleBuiltin(['cd', 'src']);

    assert.ok(outcome);
    assert.equal(outcome.intent, 'change-directory');
    assert.equal(outcome.cwd.path, resolve(workspace, 'src'));
    assert.deepEqual(outcome.output, []);
  });

  it('`pwd` contesta con la ruta entera y no mueve nada', async () => {
    await terminalSession.changeDirectory('tests');
    const outcome = await terminalSession.handleBuiltin(['pwd']);

    assert.ok(outcome);
    assert.equal(outcome.intent, 'print-directory');
    assert.deepEqual(outcome.output, [resolve(workspace, 'tests')]);
    assert.equal(terminalSession.cwd().path, resolve(workspace, 'tests'));
  });

  /**
   * Devolver `null` —y no un `kind: 'command'` que hay que volver a mirar— es lo que mantiene el
   * ejecutor con un solo camino: si no es una orden del intérprete, se lanza como siempre.
   */
  it('un comando de verdad devuelve null para que lo lance el ejecutor', async () => {
    assert.equal(await terminalSession.handleBuiltin(['dotnet', 'build']), null);
    assert.equal(await terminalSession.handleBuiltin(['git', 'status']), null);
  });
});
