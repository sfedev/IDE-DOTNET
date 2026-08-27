/**
 * Pruebas de la navegación por el disco desde la terminal.
 *
 * El fallo de partida no era una restricción: era una ausencia. Cada línea se lanzaba con el
 * directorio de la solución como `cwd` y nadie llevaba la cuenta de dónde estaba el usuario, así
 * que `cd src` intentaba ejecutar un programa llamado `cd` —que no existe, porque `cd` es una orden
 * del intérprete— y fallaba con un mensaje sobre programas permitidos que no venía a cuento.
 *
 * Se prueban las dos mitades puras: **qué pretende una línea** y **cómo se enseña la ruta**. La
 * tercera —resolver contra el disco— se prueba aparte, con directorios de verdad, en
 * `terminal-session.test.mjs`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLine,
  elide,
  isBareDrive,
  isInsideDirectory,
  resolveTarget,
  shortenPath,
  TerminalCwdError,
  tokenize,
} from '../../build/main-lib.mjs';

/** Clasifica una línea tal y como llega: troceada por el mismo `tokenize` del ejecutor. */
const classify = (line) => classifyLine(tokenize(line));

describe('qué pretende una línea', () => {
  it('reconoce `cd` con destino', () => {
    assert.deepEqual(classify('cd src'), { kind: 'change-directory', target: 'src' });
    assert.deepEqual(classify('cd ..'), { kind: 'change-directory', target: '..' });
    assert.deepEqual(classify('cd /'), { kind: 'change-directory', target: '/' });
  });

  it('reconoce `cd` a secas', () => {
    assert.deepEqual(classify('cd'), { kind: 'change-directory', target: null });
    assert.deepEqual(classify('   cd   '), { kind: 'change-directory', target: null });
  });

  it('reconoce las tres familias que se escriben sin pensar', () => {
    // cmd, POSIX y PowerShell conviven en la cabeza de quien usa Windows para .NET.
    for (const line of ['cd src', 'chdir src', 'Set-Location src', 'sl src']) {
      assert.deepEqual(classify(line), { kind: 'change-directory', target: 'src' }, line);
    }
  });

  it('no distingue mayúsculas en la palabra clave', () => {
    assert.deepEqual(classify('CD src'), { kind: 'change-directory', target: 'src' });
    assert.deepEqual(classify('SET-LOCATION src'), { kind: 'change-directory', target: 'src' });
  });

  /**
   * `cd /d D:\proyectos` es la forma de cambiar de unidad **y** de carpeta en cmd. Sin descartar el
   * `/d`, se intentaría entrar en una carpeta llamada `/d` y el error no diría nada útil.
   */
  it('descarta el modificador /d de cmd', () => {
    assert.deepEqual(classify('cd /d D:\\proyectos'), { kind: 'change-directory', target: 'D:\\proyectos' });
    assert.deepEqual(classify('cd /D D:\\proyectos'), { kind: 'change-directory', target: 'D:\\proyectos' });
  });

  it('conserva una ruta con espacios entrecomillada', () => {
    assert.deepEqual(classify('cd "C:\\Mis Proyectos\\Acme"'), {
      kind: 'change-directory',
      target: 'C:\\Mis Proyectos\\Acme',
    });
  });

  it('`D:` a secas cambia de unidad', () => {
    assert.deepEqual(classify('D:'), { kind: 'change-directory', target: 'D:' });
    assert.deepEqual(classify('d:\\'), { kind: 'change-directory', target: 'd:\\' });
    assert.equal(isBareDrive('C:'), true);
    assert.equal(isBareDrive('C:\\algo'), false);
    assert.equal(isBareDrive('cd'), false);
  });

  it('`D: algo` no es un cambio de unidad: es un comando que fallará diciendo lo que pasa', () => {
    assert.deepEqual(classify('D: algo'), { kind: 'command' });
  });

  it('reconoce las preguntas por el directorio actual', () => {
    for (const line of ['pwd', 'Get-Location', 'gl', 'cwd']) {
      assert.deepEqual(classify(line), { kind: 'print-directory' }, line);
    }
  });

  it('`pwd` con argumentos no es una pregunta', () => {
    assert.deepEqual(classify('pwd algo'), { kind: 'command' });
  });

  it('cualquier otra cosa es un comando', () => {
    for (const line of ['dotnet build', 'git status', 'npm run dev', 'cdk deploy', 'cder']) {
      assert.deepEqual(classify(line), { kind: 'command' }, line);
    }
  });

  it('una línea vacía es un comando (y el ejecutor la rechaza como siempre)', () => {
    assert.deepEqual(classifyLine([]), { kind: 'command' });
    assert.deepEqual(classifyLine(['']), { kind: 'command' });
  });
});

describe('a dónde lleva cada destino', () => {
  const context = {
    current: 'C:\\repos\\Acme\\src',
    home: 'C:\\Users\\dev',
    previous: 'C:\\repos\\Otra',
    workspace: 'C:\\repos\\Acme',
  };

  it('una ruta relativa se deja tal cual, para que la resuelva el servicio', () => {
    assert.deepEqual(resolveTarget('Acme.Api', context), { path: 'Acme.Api', absolute: false });
    assert.deepEqual(resolveTarget('..', context), { path: '..', absolute: false });
  });

  /**
   * `cd` a secas tiene historia: en POSIX lleva al hogar y en cmd sólo imprime dónde estás. Dentro
   * de un IDE lo que uno quiere es "vuélveme a la solución", que además es lo que hace que la orden
   * sirva para algo en vez de ser una curiosidad de plataforma.
   */
  it('`cd` a secas vuelve a la raíz del workspace', () => {
    assert.deepEqual(resolveTarget(null, context), { path: 'C:\\repos\\Acme', absolute: true });
    assert.deepEqual(resolveTarget('  ', context), { path: 'C:\\repos\\Acme', absolute: true });
  });

  it('sin workspace abierto, `cd` a secas va al hogar', () => {
    assert.deepEqual(resolveTarget(null, { ...context, workspace: null }), {
      path: 'C:\\Users\\dev',
      absolute: true,
    });
  });

  it('`~` es el hogar, y `~/algo` cuelga de él', () => {
    assert.deepEqual(resolveTarget('~', context), { path: 'C:\\Users\\dev', absolute: true });
    assert.deepEqual(resolveTarget('~/repos', context), { path: 'C:\\Users\\dev/repos', absolute: true });
    assert.deepEqual(resolveTarget('~\\repos', context), { path: 'C:\\Users\\dev/repos', absolute: true });
  });

  it('`-` vuelve al anterior', () => {
    assert.deepEqual(resolveTarget('-', context), { path: 'C:\\repos\\Otra', absolute: true });
  });

  it('`-` sin anterior lo dice en vez de no hacer nada', () => {
    assert.throws(() => resolveTarget('-', { ...context, previous: null }), TerminalCwdError);
    assert.throws(() => resolveTarget('-', { ...context, previous: null }), /directorio anterior/);
  });

  it('una unidad suelta lleva a su raíz', () => {
    assert.deepEqual(resolveTarget('D:', context), { path: 'D:\\', absolute: true });
    assert.deepEqual(resolveTarget('d:\\', context), { path: 'd:\\', absolute: true });
  });
});

describe('dentro de qué carpeta está una ruta', () => {
  it('compara por segmentos, no por prefijo de texto', () => {
    assert.equal(isInsideDirectory('C:\\repos\\Acme', 'C:\\repos\\Acme\\src'), true);
    // "Acme-viejo" empieza por "Acme" como texto y no está dentro de "Acme".
    assert.equal(isInsideDirectory('C:\\repos\\Acme', 'C:\\repos\\Acme-viejo\\src'), false);
  });

  it('una carpeta está dentro de sí misma', () => {
    assert.equal(isInsideDirectory('C:\\repos\\Acme', 'C:\\repos\\Acme'), true);
  });

  it('no distingue mayúsculas: en Windows es la misma carpeta', () => {
    assert.equal(isInsideDirectory('c:\\repos\\acme', 'C:\\Repos\\Acme\\src'), true);
  });

  it('tolera los dos separadores y las barras repetidas', () => {
    assert.equal(isInsideDirectory('/home/dev', '/home/dev/repos'), true);
    assert.equal(isInsideDirectory('C:/repos/Acme', 'C:\\repos\\Acme\\src'), true);
    assert.equal(isInsideDirectory('C:\\repos\\\\Acme', 'C:\\repos\\Acme'), true);
  });

  it('lo de fuera queda fuera', () => {
    assert.equal(isInsideDirectory('C:\\repos\\Acme', 'C:\\repos'), false);
    assert.equal(isInsideDirectory('C:\\repos\\Acme', 'D:\\repos\\Acme\\src'), false);
    assert.equal(isInsideDirectory('', 'C:\\repos'), false);
  });
});

describe('cómo se enseña la ruta en el prompt', () => {
  const options = { home: 'C:\\Users\\dev', workspace: 'C:\\repos\\Acme.Shop', workspaceName: 'Acme.Shop' };

  it('dentro del workspace, relativa a él y con su nombre delante', () => {
    assert.equal(shortenPath('C:\\repos\\Acme.Shop', options), 'Acme.Shop');
    assert.equal(shortenPath('C:\\repos\\Acme.Shop\\src\\Api', options), 'Acme.Shop\\src\\Api');
  });

  it('sin nombre de workspace usa el de su carpeta', () => {
    assert.equal(shortenPath('C:\\repos\\Acme.Shop\\src', { ...options, workspaceName: null }), 'Acme.Shop\\src');
  });

  it('fuera del workspace pero dentro del hogar, con ~', () => {
    assert.equal(shortenPath('C:\\Users\\dev\\Descargas', options), '~\\Descargas');
    assert.equal(shortenPath('C:\\Users\\dev', options), '~');
  });

  it('fuera de los dos, la ruta entera', () => {
    assert.equal(shortenPath('D:\\otra', options), 'D:\\otra');
  });

  it('sin workspace abierto sigue funcionando', () => {
    assert.equal(shortenPath('C:\\Users\\dev\\repos', { ...options, workspace: null }), '~\\repos');
  });

  /**
   * El workspace manda sobre el hogar cuando la solución está dentro del hogar, que es lo normal:
   * `~\repos\Acme.Shop\src\Api` no dice más que `Acme.Shop\src\Api` y ocupa el doble.
   */
  it('el workspace gana al hogar cuando la solución cuelga de él', () => {
    const inHome = { home: 'C:\\Users\\dev', workspace: 'C:\\Users\\dev\\repos\\Acme', workspaceName: 'Acme' };
    assert.equal(shortenPath('C:\\Users\\dev\\repos\\Acme\\src', inHome), 'Acme\\src');
  });
});

describe('recortar una ruta larga', () => {
  it('lo que cabe no se toca', () => {
    assert.equal(elide('C:\\repos\\Acme', 40), 'C:\\repos\\Acme');
  });

  /** Se recorta por el medio: el final —dónde estás— es justo lo que importa. */
  it('recorta por el medio conservando principio y final', () => {
    const shortened = elide('C:\\Users\\dev\\repos\\clientes\\acme\\backend\\src\\Api', 30);

    assert.ok(shortened.length <= 30, shortened);
    assert.ok(shortened.startsWith('C:'), shortened);
    assert.ok(shortened.endsWith('Api'), shortened);
    assert.ok(shortened.includes('…'), shortened);
  });

  it('respeta el separador de la ruta que recibe', () => {
    assert.match(elide('/home/dev/repos/clientes/acme/backend/src/Api', 24), /^\/?home\/…\//);
  });

  it('una ruta de dos segmentos no se recorta: no hay nada que quitar por el medio', () => {
    assert.equal(elide('C:\\CarpetaConUnNombreLarguisimoDeVerdad', 10), 'C:\\CarpetaConUnNombreLarguisimoDeVerdad');
  });
});

/**
 * Claude Code como orden del intérprete.
 *
 * Misma familia que `cd` y `pwd` (ADR-055): primero se clasifica, después se lanza. Sin esto,
 * escribir `claude` en la terminal asistida acabaría en el ejecutor, y el error hablaría de la
 * lista de programas permitidos, que no viene a cuento: el problema no es el permiso, es que esa
 * terminal no tiene pseudoterminal y Claude Code es una interfaz de pantalla completa.
 */
describe('claude no es un programa que esta terminal pueda lanzar', () => {
  it('se reconoce a secas', () => {
    assert.deepEqual(classifyLine(['claude']), { kind: 'open-claude' });
  });

  it('con argumentos también: tampoco puede correr aquí', () => {
    assert.deepEqual(classifyLine(['claude', 'doctor']), { kind: 'open-claude' });
    assert.deepEqual(classifyLine(['claude', '--continue']), { kind: 'open-claude' });
  });

  it('se reconoce con las tres formas del ejecutable, sin distinguir mayúsculas', () => {
    for (const word of ['claude', 'Claude', 'CLAUDE', 'claude.cmd', 'claude.exe']) {
      assert.equal(classifyLine([word]).kind, 'open-claude', word);
    }
  });

  it('no se lleva por delante nada que se le parezca', () => {
    // Un programa cuyo nombre empieza igual sigue siendo un programa.
    assert.equal(classifyLine(['claudia']).kind, 'command');
    assert.equal(classifyLine(['claude-code']).kind, 'command');
    assert.equal(classifyLine(['npx', 'claude']).kind, 'command');
  });

  it('cd y pwd siguen clasificándose como siempre', () => {
    assert.equal(classifyLine(['cd', 'src']).kind, 'change-directory');
    assert.equal(classifyLine(['pwd']).kind, 'print-directory');
    assert.equal(classifyLine(['dotnet', 'build']).kind, 'command');
  });
});
