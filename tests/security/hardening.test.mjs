/**
 * Pruebas de endurecimiento.
 *
 * Dos clases de aserción:
 *  - de comportamiento: el guardián de rutas rechaza de verdad lo que debe rechazar.
 *  - estructurales sobre el código fuente: la configuración de seguridad de Electron no puede
 *    relajarse "temporalmente" sin que la suite se ponga en rojo.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allowRoot,
  assertInsideWorkspace,
  clearExtraRoots,
  isInside,
  PathAccessError,
  setWorkspaceRoot,
  toWorkspaceRelative,
  tokenize,
  ALLOWED_COMMANDS,
  CommandError,
} from '../../build/main-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKSPACE = resolve(root, 'tests', '.fixture-workspace');

function readSource(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function walkSources(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'templates') continue; // Las plantillas son código C#, no del IDE.
      found.push(...walkSources(full));
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('guardián de rutas del workspace', () => {
  before(() => {
    clearExtraRoots();
    setWorkspaceRoot(WORKSPACE);
  });

  after(() => {
    clearExtraRoots();
    setWorkspaceRoot(null);
  });

  it('acepta una ruta dentro del workspace', () => {
    const inside = join(WORKSPACE, 'src', 'Program.cs');
    assert.equal(assertInsideWorkspace(inside), resolve(inside));
  });

  it('acepta el propio directorio raíz', () => {
    assert.equal(assertInsideWorkspace(WORKSPACE), WORKSPACE);
  });

  it('normaliza rutas con segmentos redundantes que siguen dentro', () => {
    const messy = join(WORKSPACE, 'src', '..', 'src', 'Program.cs');
    assert.equal(assertInsideWorkspace(messy), resolve(join(WORKSPACE, 'src', 'Program.cs')));
  });

  it('rechaza el escape por ..', () => {
    assert.throws(
      () => assertInsideWorkspace(join(WORKSPACE, '..', '..', 'secreto.txt')),
      PathAccessError,
    );
  });

  it('rechaza una ruta absoluta fuera del workspace', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
    assert.throws(() => assertInsideWorkspace(outside), /acceso denegado/);
  });

  it('rechaza rutas con byte nulo', () => {
    assert.throws(() => assertInsideWorkspace(`${WORKSPACE}\u0000/etc/passwd`), /caracteres no válidos/);
  });

  it('rechaza valores que no son cadenas', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      assert.throws(() => assertInsideWorkspace(value), PathAccessError);
    }
  });

  it('rechaza la cadena vacía', () => {
    assert.throws(() => assertInsideWorkspace('   '), PathAccessError);
  });

  it('rechaza todo si no hay workspace abierto', () => {
    setWorkspaceRoot(null);
    clearExtraRoots();
    assert.throws(() => assertInsideWorkspace(join(WORKSPACE, 'a.cs')), /no hay ningún workspace abierto/);
    setWorkspaceRoot(WORKSPACE);
  });

  it('permite raíces adicionales autorizadas explícitamente', () => {
    const extra = resolve(root, 'tests', '.fixture-extra');
    assert.throws(() => assertInsideWorkspace(join(extra, 'x.cs')), PathAccessError);

    allowRoot(extra);
    assert.equal(assertInsideWorkspace(join(extra, 'x.cs')), resolve(join(extra, 'x.cs')));

    clearExtraRoots();
    assert.throws(() => assertInsideWorkspace(join(extra, 'x.cs')), PathAccessError);
  });

  it('isInside distingue prefijos que sólo lo parecen', () => {
    // "/workspace-malicioso" empieza por "/workspace" como texto, pero no está dentro.
    assert.equal(isInside('/a/workspace', '/a/workspace/sub'), true);
    assert.equal(isInside('/a/workspace', '/a/workspace-malicioso/sub'), false);
  });

  it('toWorkspaceRelative devuelve rutas con separador POSIX', () => {
    setWorkspaceRoot(WORKSPACE);
    assert.equal(toWorkspaceRelative(join(WORKSPACE, 'src', 'App.cs')), 'src/App.cs');
    assert.equal(toWorkspaceRelative(WORKSPACE), '.');
  });
});

describe('configuración de seguridad de Electron', () => {
  const main = readSource('src/main/main.ts');

  it('mantiene el aislamiento de contexto activado', () => {
    assert.match(main, /contextIsolation:\s*true/);
  });

  it('mantiene la integración de Node desactivada en el renderer', () => {
    assert.match(main, /nodeIntegration:\s*false/);
    assert.equal(/nodeIntegration:\s*true/.test(main), false);
  });

  it('deniega todas las peticiones de permisos del navegador', () => {
    assert.match(main, /setPermissionRequestHandler/);
    assert.match(main, /callback\(false\)/);
  });

  it('impide abrir ventanas nuevas dentro de la aplicación', () => {
    assert.match(main, /setWindowOpenHandler/);
    assert.match(main, /action:\s*'deny'/);
  });

  it('desactiva la etiqueta webview', () => {
    assert.match(main, /webviewTag:\s*false/);
  });

  it('mata los procesos hijo al salir', () => {
    assert.match(main, /before-quit/);
    assert.match(main, /killAll\(\)/);
  });
});

describe('superficie del preload', () => {
  const preload = readSource('src/main/preload.ts');

  it('expone una única API con nombre', () => {
    const exposures = preload.match(/contextBridge\.exposeInMainWorld/g) ?? [];
    assert.equal(exposures.length, 1);
    assert.match(preload, /exposeInMainWorld\('dotforge', api\)/);
  });

  it('no expone ipcRenderer ni un invocador genérico', () => {
    assert.equal(/exposeInMainWorld\([^)]*ipcRenderer/.test(preload), false);
    assert.equal(/invoke:\s*\(channel/.test(preload), false, 'hay un puente genérico por canal');
    assert.equal(/send:\s*\(channel/.test(preload), false, 'hay un emisor genérico por canal');
  });

  it('todos los canales usados están declarados en el contrato', () => {
    const contracts = readSource('src/shared/contracts.ts');
    const used = [...preload.matchAll(/IPC\.(\w+)/g)].map((match) => match[1]);
    const declared = [...contracts.matchAll(/^\s{2}(\w+):\s*'[^']+',$/gm)].map((match) => match[1]);

    assert.ok(used.length > 20, `sólo se han detectado ${used.length} canales`);
    for (const channel of new Set(used)) {
      assert.ok(declared.includes(channel), `el canal IPC.${channel} no está declarado en contracts.ts`);
    }
  });
});

describe('política de seguridad de contenidos del renderer', () => {
  const html = readSource('src/renderer/static/index.html');

  /**
   * Se analiza el valor del atributo `content`, no el archivo entero: los comentarios del HTML
   * mencionan "unsafe-eval" para explicar por qué NO se usa, y buscarlo en todo el texto daría
   * un falso positivo.
   */
  const policy = (() => {
    const match = /http-equiv="Content-Security-Policy"\s*content="([^"]+)"/s.exec(html);
    assert.ok(match, 'no se encuentra la meta de Content-Security-Policy');
    return match[1].replace(/\s+/g, ' ').trim();
  })();

  const directive = (name) => {
    const match = new RegExp(`${name} ([^;]+)`).exec(policy);
    return match ? match[1].trim() : '';
  };

  it('declara una CSP', () => {
    assert.ok(policy.length > 40, `CSP sospechosamente corta: ${policy}`);
  });

  it('no permite eval', () => {
    assert.equal(policy.includes('unsafe-eval'), false, `la CSP permite eval: ${policy}`);
  });

  it('parte de default-src none', () => {
    assert.equal(directive('default-src'), "'none'");
  });

  it('no permite scripts remotos', () => {
    const scriptSrc = directive('script-src');
    assert.ok(scriptSrc.length > 0, 'no hay directiva script-src');
    assert.equal(/https?:/.test(scriptSrc), false, `script-src permite orígenes remotos: ${scriptSrc}`);
  });

  it('no carga imágenes remotas: los iconos de NuGet se dibujan localmente', () => {
    const imgSrc = directive('img-src');
    assert.ok(imgSrc.length > 0, 'no hay directiva img-src');
    assert.equal(/https?:/.test(imgSrc), false, `img-src permite orígenes remotos: ${imgSrc}`);
  });

  it('bloquea objetos y marcos embebidos', () => {
    assert.equal(directive('object-src'), "'none'");
    assert.equal(directive('frame-src'), "'none'");
  });
});

describe('ejecución de procesos', () => {
  const sources = walkSources(join(root, 'src'));

  it('ningún spawn usa shell: true', () => {
    const offenders = [];
    for (const file of sources) {
      const content = readFileSync(file, 'utf8');
      if (/shell:\s*true/.test(content)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  /**
   * `exec` recibe una línea de shell y es la puerta de entrada a la inyección de comandos.
   * `execFile` y `spawn` reciben un array de argumentos y no la tienen. Se comprueba lo que se
   * importa de `node:child_process`, no las llamadas: buscar "exec(" en el texto daría falsos
   * positivos con cualquier `regex.exec(...)`.
   */
  it('no se importa `exec` de child_process en ninguna parte', () => {
    const offenders = [];

    for (const file of sources) {
      const content = readFileSync(file, 'utf8');
      const imports = [...content.matchAll(/import\s*\{([^}]+)\}\s*from\s*'node:child_process'/g)];

      for (const match of imports) {
        const named = match[1].split(',').map((entry) => entry.trim().split(/\s+as\s+/)[0].trim());
        if (named.includes('exec') || named.includes('execSync')) offenders.push(file);
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('las llamadas a spawn pasan los argumentos como array', () => {
    const offenders = [];

    for (const file of sources) {
      const content = readFileSync(file, 'utf8');
      // Un spawn cuyo segundo argumento sea un string es una línea de shell encubierta.
      for (const match of content.matchAll(/spawn\s*\(\s*[^,)]+,\s*(['"`])/g)) {
        offenders.push(`${file}: spawn con argumentos en ${match[1]}`);
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('el renderer no usa eval ni new Function', () => {
    const rendererSources = walkSources(join(root, 'src', 'renderer'));
    const offenders = [];
    for (const file of rendererSources) {
      const content = readFileSync(file, 'utf8');
      if (/\beval\s*\(/.test(content) || /new Function\s*\(/.test(content)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });
});

describe('descargas del toolchain', () => {
  const sources = [readSource('src/main/lsp/acquire.ts'), readSource('src/main/debug/netcoredbg.ts')];

  it('todas las URLs de descarga son HTTPS', () => {
    for (const source of sources) {
      const urls = source.match(/'https?:\/\/[^']+'/g) ?? [];
      for (const url of urls) {
        assert.ok(url.startsWith("'https://"), `URL no segura: ${url}`);
      }
    }
  });

  it('se registra el hash del artefacto descargado', () => {
    // El depurador lo sigue calculando él mismo; el servidor de lenguaje delega en el instalador
    // verificable, que además del hash del archivo descargado anota uno por cada archivo extraído.
    assert.match(readSource('src/main/debug/netcoredbg.ts'), /sha256\(/);
    assert.match(readSource('src/main/lsp/acquire.ts'), /installArchive\(/);

    const install = readSource('src/main/services/toolchain-install.ts');
    assert.match(install, /sourceSha256: sha256\(archive\)/, 'el hash del artefacto descargado');
    assert.match(install, /sha256: sha256\(contents\)/, 'y uno por archivo extraído');
  });

  /**
   * Una descarga cortada no puede pasar por buena.
   *
   * Un ZIP truncado puede conservar directorio central válido para parte de sus entradas, así que
   * el error no aparece al extraer sino mucho después, dentro del proceso que carga el ensamblado
   * mutilado. Se comprueba contra `content-length` antes de tocar el disco.
   */
  it('la descarga del servidor de lenguaje comprueba la longitud anunciada', () => {
    const source = readSource('src/main/lsp/acquire.ts');
    assert.match(source, /content-length/);
    assert.match(source, /received !== total/);
  });

  /**
   * Y una instalación no se da por buena porque exista una marca: se comprueba archivo a archivo
   * contra el manifiesto. Sin esto, un solo archivo truncado en disco es invisible para siempre.
   */
  it('la instalación del servidor de lenguaje se verifica antes de lanzarlo', () => {
    assert.match(readSource('src/main/lsp/acquire.ts'), /verifyInstall\(directory\)/);
  });
});

describe('extracción de archivos comprimidos', () => {
  const zip = readSource('src/main/services/zip.ts');

  it('protege contra zip-slip', () => {
    assert.match(zip, /zip-slip/);
    assert.match(zip, /relativePath\.startsWith\('\.\.'\)/);
  });
});

describe('terminal integrada', () => {
  it('trocea respetando comillas dobles y simples', () => {
    assert.deepEqual(tokenize('dotnet build'), ['dotnet', 'build']);
    assert.deepEqual(tokenize('dotnet build "C:\Mi Solución\App.sln"'), [
      'dotnet',
      'build',
      'C:\Mi Solución\App.sln',
    ]);
    assert.deepEqual(tokenize("git commit -m 'mensaje con espacios'"), [
      'git',
      'commit',
      '-m',
      'mensaje con espacios',
    ]);
  });

  it('colapsa los espacios sobrantes', () => {
    assert.deepEqual(tokenize('  dotnet    build   '), ['dotnet', 'build']);
  });

  it('conserva una cadena vacía entrecomillada como argumento', () => {
    assert.deepEqual(tokenize('git commit -m ""'), ['git', 'commit', '-m', '']);
  });

  it('falla si queda una comilla sin cerrar', () => {
    assert.throws(() => tokenize('git commit -m "sin cerrar'), CommandError);
  });

  it('NO interpreta metacaracteres de shell: son argumentos literales', () => {
    // Con `shell: false` esto llega como argumentos a `dotnet`, no encadena comandos.
    assert.deepEqual(tokenize('dotnet build && rm -rf /'), ['dotnet', 'build', '&&', 'rm', '-rf', '/']);
    assert.deepEqual(tokenize('dotnet build; echo hola'), ['dotnet', 'build;', 'echo', 'hola']);
    assert.deepEqual(tokenize('dotnet build | cat'), ['dotnet', 'build', '|', 'cat']);
    assert.deepEqual(tokenize('dotnet $(whoami)'), ['dotnet', '$(whoami)']);
    assert.deepEqual(tokenize('dotnet `whoami`'), ['dotnet', '`whoami`']);
  });

  it('la lista de programas permitidos es corta y no incluye intérpretes de shell', () => {
    assert.ok(ALLOWED_COMMANDS.size <= 15, `la lista tiene ${ALLOWED_COMMANDS.size} entradas`);

    for (const forbidden of ['cmd', 'sh', 'bash', 'zsh', 'wsl', 'rundll32', 'reg', 'certutil']) {
      assert.equal(ALLOWED_COMMANDS.has(forbidden), false, `"${forbidden}" no debería estar permitido`);
    }
  });

  it('incluye lo necesario para un flujo .NET', () => {
    for (const expected of ['dotnet', 'git', 'npm']) {
      assert.ok(ALLOWED_COMMANDS.has(expected), `falta "${expected}"`);
    }
  });
});
