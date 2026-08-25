/**
 * Pruebas de empaquetado.
 *
 * Verifican lo que se puede verificar sin ejecutar una build de 10 minutos: que la configuración
 * declara los targets prometidos, que la salida de la compilación está completa y que los iconos
 * generados son archivos válidos según sus formatos, no bytes con la extensión correcta.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isStaleArtifact, selectStaleArtifacts } from '../../scripts/lib/dist-artifacts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Tamaño total de un directorio, en bytes. */
function directorySize(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    total += entry.isDirectory() ? directorySize(full) : statSync(full).size;
  }
  return total;
}
const buildDir = join(root, 'build');
const iconsDir = join(root, 'resources', 'icons');

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8');

describe('package.json', () => {
  it('apunta al bundle compilado del proceso principal', () => {
    assert.equal(packageJson.main, 'build/main.js');
  });

  it('declara los scripts que documenta CLAUDE.md', () => {
    for (const script of [
      'build', 'watch', 'dev', 'start', 'icons', 'clean',
      'test', 'test:unit', 'test:scaffold', 'test:package',
      'pack', 'dist:win', 'dist:mac', 'dist:all', 'verify:dist', 'fetch:toolchain',
    ]) {
      assert.ok(packageJson.scripts[script], `falta el script "${script}"`);
    }
  });

  it('expone la CLI dotforge', () => {
    assert.equal(packageJson.bin.dotforge, 'build/cli.js');
  });

  /**
   * La regla no es "ninguna dependencia nativa": es **ninguna que haya que compilar** (ADR-059).
   *
   * Lo que hacía inaceptable una nativa era el paso de rebuild por plataforma —node-gyp, Visual
   * Studio Build Tools, un artefacto distinto por versión de Electron—, no el hecho de que hubiera
   * un `.node` por medio. `node-pty` publica los binarios ya compilados dentro del paquete y son
   * Node-API, que es ABI estable: valen para Electron sin `electron-rebuild`.
   *
   * Sigue siendo `optionalDependency` y no `dependency`, y eso tampoco es un detalle: una
   * instalación sin binario para esta plataforma tiene que dejar el IDE funcionando con la terminal
   * asistida, no romperlo.
   */
  it('la única dependencia nativa es node-pty, y es opcional', () => {
    const nativeSuspects = ['node-pty', 'sqlite3', 'better-sqlite3', 'serialport', 'canvas', 'sharp'];
    for (const suspect of nativeSuspects) {
      assert.ok(!packageJson.dependencies?.[suspect], `dependencia nativa en "dependencies": ${suspect}`);
    }

    for (const suspect of nativeSuspects.filter((name) => name !== 'node-pty')) {
      assert.ok(!packageJson.optionalDependencies?.[suspect], `dependencia nativa inesperada: ${suspect}`);
    }

    assert.ok(packageJson.optionalDependencies?.['node-pty'], 'node-pty debe declararse como opcional');
  });

  it('node-pty trae binarios precompilados: no hay paso de rebuild en el equipo del usuario', () => {
    // Si algún día dejaran de venir en el paquete, esto se pone en rojo antes de que alguien
    // descubra en su máquina que hace falta node-gyp.
    const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds');
    if (!existsSync(prebuilds)) return; // Instalación sin el opcional: es un estado válido.

    const platforms = readdirSync(prebuilds);
    assert.ok(platforms.length > 0, 'node-pty no trae ningún binario precompilado');

    const mine = `${process.platform}-${process.arch}`;
    assert.ok(platforms.includes(mine), `no hay binario precompilado para ${mine}: ${platforms.join(', ')}`);
  });

  it('el bundle del proceso principal no incrusta node-pty: se resuelve en ejecución', () => {
    // Un binario nativo no se puede bundlear, y además su ausencia tiene que ser un valor y no un
    // error de carga: por eso es externo y se resuelve con `createRequire` dentro de un try/catch.
    const main = readFileSync(join(buildDir, 'main.js'), 'utf8');

    assert.match(main, /createRequire\)?\(\w+\)\("node-pty"\)/, 'el módulo se resuelve en ejecución');
    // Una marca del código de node-pty: si apareciera, es que ha entrado en el bundle.
    assert.doesNotMatch(main, /WindowsPtyAgent/, 'node-pty no puede acabar dentro del bundle');
  });

  it('no usa "type": "module": el proceso principal de Electron se carga como CommonJS', () => {
    assert.equal(packageJson.type, undefined);
  });
});

describe('electron-builder.yml', () => {
  it('define el identificador y el nombre de producto', () => {
    assert.match(builderConfig, /appId:\s*dev\.dotforge\.ide/);
    assert.match(builderConfig, /productName:\s*DotForge IDE/);
  });

  it('escribe los artefactos en dist/', () => {
    assert.match(builderConfig, /output:\s*dist/);
  });

  it('declara los targets de Windows: instalador NSIS y portable ZIP', () => {
    const windows = builderConfig.slice(builderConfig.indexOf('win:'), builderConfig.indexOf('mac:'));
    assert.match(windows, /target:\s*nsis/);
    assert.match(windows, /target:\s*zip/);
    assert.match(windows, /icon:\s*resources\/icons\/icon\.ico/);
  });

  it('declara los targets de macOS: dmg y zip, en arm64 y x64', () => {
    const mac = builderConfig.slice(builderConfig.indexOf('mac:'), builderConfig.indexOf('dmg:'));
    assert.match(mac, /target:\s*dmg/);
    assert.match(mac, /target:\s*zip/);
    assert.match(mac, /arm64/);
    assert.match(mac, /x64/);
    assert.match(mac, /icon:\s*resources\/icons\/icon\.icns/);
  });

  it('permite elegir el directorio de instalación en Windows', () => {
    assert.match(builderConfig, /allowToChangeInstallationDirectory:\s*true/);
    assert.match(builderConfig, /oneClick:\s*false/);
  });

  it('deja Monaco fuera del asar', () => {
    assert.match(builderConfig, /asarUnpack:/);
    assert.match(builderConfig, /build\/vendor/);
  });

  it('deja node-pty fuera del asar y lo incluye en el paquete', () => {
    // Node necesita una ruta real para cargar un `.node`: dentro del asar no se puede.
    assert.match(builderConfig, /asarUnpack:[\s\S]*node_modules\/node-pty/);
    assert.match(builderConfig, /files:[\s\S]*node_modules\/node-pty/);
  });

  it('copia las plantillas de scaffolding a resources/templates', () => {
    assert.match(builderConfig, /extraResources:/);
    assert.match(builderConfig, /from:\s*build\/templates/);
    assert.match(builderConfig, /to:\s*templates/);
  });

  it('no publica en ningún sitio automáticamente', () => {
    assert.match(builderConfig, /publish:\s*null/);
  });
});

describe('salida de la compilación', () => {
  const required = [
    'main.js',
    'preload.js',
    'renderer.js',
    'cli.js',
    'scaffold.mjs',
    'toolchain.mjs',
    'main-lib.mjs',
    'index.html',
    'build-info.json',
    'styles/theme.css',
    'styles/layout.css',
    'styles/components.css',
    'vendor/monaco/vs/loader.js',
    'vendor/monaco/vs/editor/editor.main.js',
    'vendor/xterm/xterm.js',
    'vendor/xterm/xterm.css',
    'vendor/xterm/addon-fit.js',
    'templates/_common/Directory.Build.props.tmpl',
    'templates/clean/src/__Solution__.Domain/__Solution__.Domain.csproj.tmpl',
    'templates/hexagonal/src/__Solution__.Ports/__Solution__.Ports.csproj.tmpl',
    'templates/ddd/src/__Solution__.SharedKernel/__Solution__.SharedKernel.csproj.tmpl',
  ];

  for (const file of required) {
    it(`build/${file} existe y no está vacío`, () => {
      const path = join(buildDir, file);
      assert.ok(existsSync(path), `falta ${path} — ejecuta \`npm run build\``);
      assert.ok(statSync(path).size > 0, `${file} está vacío`);
    });
  }

  it('el bundle del proceso principal no incrusta Electron', () => {
    // `electron` es externo: si acabara dentro del bundle, la app cargaría dos copias del módulo.
    const main = readFileSync(join(buildDir, 'main.js'), 'utf8');
    assert.match(main, /require\("electron"\)/);
  });

  it('el bundle del renderer no incrusta Monaco', () => {
    const renderer = readFileSync(join(buildDir, 'renderer.js'), 'utf8');
    const vendor = join(buildDir, 'vendor/monaco/vs');

    // La comprobación de verdad es de proporción, no de tamaño absoluto: el renderer crece con
    // cada vista nueva, pero Monaco pesa megas y se sirve como archivos del vendor. Si algún día
    // acabara dentro del bundle, éste dejaría de ser un orden de magnitud más pequeño que la
    // carpeta que dice no incrustar, y esto se pondría en rojo.
    if (existsSync(vendor)) {
      const vendorSize = directorySize(vendor);
      assert.ok(
        renderer.length * 4 < vendorSize,
        `el renderer pesa ${renderer.length} bytes frente a los ${vendorSize} de Monaco: parece incrustado`,
      );
    }

    // Tope absoluto de cordura, por si el vendor no está presente en este árbol de build.
    assert.ok(renderer.length < 1024 * 1024, `el bundle del renderer pesa ${renderer.length} bytes`);
  });

  it('el CLI empieza por el shebang, y sólo una vez', () => {
    const cli = readFileSync(join(buildDir, 'cli.js'), 'utf8');
    assert.ok(cli.startsWith('#!/usr/bin/env node\n'));
    assert.equal(cli.split('\n').filter((line) => line.startsWith('#!')).length, 1);
  });

  it('la marca de build registra los targets compilados', () => {
    const info = JSON.parse(readFileSync(join(buildDir, 'build-info.json'), 'utf8'));
    assert.ok(Array.isArray(info.targets));
    for (const target of ['cli', 'scaffold', 'main', 'preload', 'renderer']) {
      assert.ok(info.targets.includes(target), `falta el target ${target}`);
    }
  });
});

describe('iconos de la aplicación', () => {
  it('existen todos los tamaños PNG', () => {
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      const path = join(iconsDir, `icon-${size}.png`);
      assert.ok(existsSync(path), `falta icon-${size}.png — ejecuta \`npm run icons\``);
    }
  });

  it('los PNG tienen firma y dimensiones correctas', () => {
    for (const size of [16, 256, 1024]) {
      const buffer = readFileSync(join(iconsDir, `icon-${size}.png`));

      assert.deepEqual(
        [...buffer.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        `icon-${size}.png no tiene firma PNG`,
      );

      // La cabecera IHDR empieza en el byte 8: longitud(4) + 'IHDR'(4) + ancho(4) + alto(4)
      assert.equal(buffer.toString('ascii', 12, 16), 'IHDR');
      assert.equal(buffer.readUInt32BE(16), size, `ancho incorrecto en icon-${size}.png`);
      assert.equal(buffer.readUInt32BE(20), size, `alto incorrecto en icon-${size}.png`);
    }
  });

  it('el .ico es válido y contiene 7 resoluciones', () => {
    const path = join(iconsDir, 'icon.ico');
    assert.ok(existsSync(path), 'falta icon.ico');

    const buffer = readFileSync(path);
    assert.equal(buffer.readUInt16LE(0), 0, 'campo reservado incorrecto');
    assert.equal(buffer.readUInt16LE(2), 1, 'el tipo debería ser 1 (icono)');

    const count = buffer.readUInt16LE(4);
    assert.equal(count, 7, `se esperaban 7 imágenes, hay ${count}`);

    // Cada entrada del directorio debe apuntar dentro del archivo y a un PNG real.
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16;
      const size = buffer.readUInt32LE(entry + 8);
      const offset = buffer.readUInt32LE(entry + 12);

      assert.ok(offset + size <= buffer.length, `la entrada ${index} se sale del archivo`);
      assert.deepEqual(
        [...buffer.subarray(offset, offset + 4)],
        [0x89, 0x50, 0x4e, 0x47],
        `la entrada ${index} no es un PNG`,
      );
    }
  });

  it('el .icns es válido y sus entradas cuadran con la longitud declarada', () => {
    const path = join(iconsDir, 'icon.icns');
    assert.ok(existsSync(path), 'falta icon.icns');

    const buffer = readFileSync(path);
    assert.equal(buffer.toString('ascii', 0, 4), 'icns');
    assert.equal(buffer.readUInt32BE(4), buffer.length, 'la longitud declarada no coincide');

    const types = [];
    let cursor = 8;
    while (cursor + 8 <= buffer.length) {
      const osType = buffer.toString('ascii', cursor, cursor + 4);
      const length = buffer.readUInt32BE(cursor + 4);

      assert.ok(length >= 8 && cursor + length <= buffer.length, `entrada ${osType} con longitud inválida`);
      assert.deepEqual(
        [...buffer.subarray(cursor + 8, cursor + 12)],
        [0x89, 0x50, 0x4e, 0x47],
        `la entrada ${osType} no contiene un PNG`,
      );

      types.push(osType);
      cursor += length;
    }

    assert.equal(cursor, buffer.length, 'las entradas no cubren el archivo entero');
    // Las variantes modernas que macOS usa en el Dock y en Finder.
    for (const osType of ['ic07', 'ic08', 'ic09', 'ic10']) {
      assert.ok(types.includes(osType), `falta la entrada ${osType}`);
    }
  });

  it('electron-builder encontrará los iconos donde los apunta la configuración', () => {
    assert.ok(existsSync(join(root, 'resources', 'icons', 'icon.ico')));
    assert.ok(existsSync(join(root, 'resources', 'icons', 'icon.icns')));
    assert.ok(existsSync(join(root, 'resources', 'icon.png')));
  });
});

describe('flujo de macOS', () => {
  it('dist:mac pasa por el wrapper que explica la limitación de plataforma', () => {
    assert.match(packageJson.scripts['dist:mac'], /scripts\/dist-mac\.mjs/);
    assert.ok(existsSync(join(root, 'scripts', 'dist-mac.mjs')));
  });

  /**
   * macOS está desactivado a propósito en el workflow, y esto lo sostiene.
   *
   * Cuidado con **cómo** se comprueba. Lo que había aquí era `/runs-on:\s*macos-latest/` contra el
   * texto entero del archivo, y una expresión así casa igual de bien con la línea comentada. Es
   * decir: al comentar el job, esta prueba habría seguido en verde afirmando que el workflow
   * construye macOS. Por eso ahora se separan las líneas activas de las comentadas antes de mirar
   * nada; una prueba que no distingue lo uno de lo otro no está comprobando nada.
   */
  const workflowLines = () =>
    readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8').split(/\r?\n/);

  const activeLines = () => workflowLines().filter((line) => !line.trimStart().startsWith('#'));
  const commentedLines = () => workflowLines().filter((line) => line.trimStart().startsWith('#'));

  it('macOS está desactivado: ninguna línea activa lo menciona', () => {
    const activas = activeLines().join('\n');

    assert.doesNotMatch(activas, /macos-latest/, 'queda macOS activo en el workflow');
    assert.doesNotMatch(activas, /npm run dist:mac/, 'queda un dist:mac activo en el workflow');
  });

  it('la receta de macOS sigue guardada para poder reactivarla', () => {
    // Desactivar no es borrar: cuando haya un Mac, el job tiene que volver descomentando, no
    // reinventándolo. Si alguien limpia estos comentarios, esto se pone en rojo.
    const comentadas = commentedLines().join('\n');

    assert.match(comentadas, /runs-on:\s*macos-latest/, 'se ha perdido el runner de macOS');
    assert.match(comentadas, /npm run dist:mac/, 'se ha perdido el paso dist:mac');
    assert.match(comentadas, /verify-dist\.mjs --require mac/, 'se ha perdido la verificación de mac');
    assert.match(comentadas, /MACOS-DESACTIVADO/, 'falta la marca por la que se encuentra todo esto');
  });

  it('Windows sigue siendo la puerta de calidad y produce sus artefactos', () => {
    const activas = activeLines().join('\n');

    assert.match(activas, /windows-latest/);
    assert.match(activas, /npm run dist:win/);
    assert.match(activas, /verify-dist\.mjs --require win/);
  });
});

describe('poda de artefactos de versiones anteriores', () => {
  const currentVersion = '1.2.0';

  it('todos los scripts que escriben en dist/ podan antes', () => {
    for (const script of ['pack', 'dist:win', 'dist:mac', 'dist:all']) {
      assert.match(
        packageJson.scripts[script],
        /scripts\/prune-dist\.mjs/,
        `"${script}" no poda dist/ antes de empaquetar`,
      );
    }
    assert.ok(existsSync(join(root, 'scripts', 'prune-dist.mjs')));
  });

  it('la poda ocurre antes de generar, no después', () => {
    // Al revés borraría lo que se acaba de construir.
    const script = packageJson.scripts['dist:win'];
    assert.ok(
      script.indexOf('prune-dist.mjs') < script.indexOf('electron-builder'),
      'prune-dist.mjs debe ejecutarse antes que electron-builder',
    );
  });

  it('marca como obsoletos los artefactos de otra versión', () => {
    for (const name of [
      'DotForge IDE-1.1.0-Setup-x64.exe',
      'DotForge IDE-1.1.0-Setup-x64.exe.blockmap',
      'DotForge IDE-1.1.0-win-x64.zip',
      'DotForge IDE-0.9.0-arm64.dmg',
      'DotForge IDE-1.1.0-mac-x64.zip',
    ]) {
      assert.equal(isStaleArtifact(name, currentVersion), true, name);
    }
  });

  it('conserva los artefactos de la versión actual', () => {
    for (const name of [
      'DotForge IDE-1.2.0-Setup-x64.exe',
      'DotForge IDE-1.2.0-Setup-x64.exe.blockmap',
      'DotForge IDE-1.2.0-win-x64.zip',
      'DotForge IDE-1.2.0-arm64.dmg',
      'DotForge IDE-1.2.0-mac-arm64.zip',
    ]) {
      assert.equal(isStaleArtifact(name, currentVersion), false, name);
    }
  });

  it('no toca lo que no lleva versión en el nombre: cada build lo reescribe', () => {
    for (const name of ['win-unpacked', 'mac', 'mac-arm64', 'builder-debug.yml', 'builder-effective-config.yaml', 'latest.yml']) {
      assert.equal(isStaleArtifact(name, currentVersion), false, name);
    }
  });

  it('no confunde el sufijo de plataforma con una preliberación', () => {
    // El riesgo real: "1.2.0-win-x64" no es la preliberación "win-x64" de la 1.2.0.
    assert.equal(isStaleArtifact('DotForge IDE-1.2.0-win-x64.zip', '1.2.0'), false);
    assert.equal(isStaleArtifact('DotForge IDE-1.2.0-beta.1-win-x64.zip', '1.2.0-beta.1'), false);
    assert.equal(isStaleArtifact('DotForge IDE-1.2.0-win-x64.zip', '1.2.0-beta.1'), true);
  });

  it('ante la duda conserva: una preliberación de la misma base sobrevive', () => {
    // Limitación asumida y documentada en dist-artifacts.mjs: el sello "-1.2.0-" está presente en
    // el nombre, así que no se borra. Preferimos dejar basura antes que borrar el artefacto que
    // se acaba de construir.
    assert.equal(isStaleArtifact('DotForge IDE-1.2.0-beta.1-win-x64.zip', '1.2.0'), false);
  });

  it('selectStaleArtifacts filtra y ordena, y nunca devuelve algo de la versión actual', () => {
    const entries = [
      'DotForge IDE-1.2.0-win-x64.zip',
      'DotForge IDE-1.1.0-win-x64.zip',
      'DotForge IDE-1.0.0-Setup-x64.exe',
      'win-unpacked',
      'builder-debug.yml',
    ];

    assert.deepEqual(selectStaleArtifacts(entries, currentVersion), [
      'DotForge IDE-1.0.0-Setup-x64.exe',
      'DotForge IDE-1.1.0-win-x64.zip',
    ]);
  });

  it('exige una versión actual válida en vez de borrar a ciegas', () => {
    assert.throws(() => isStaleArtifact('DotForge IDE-1.1.0-win-x64.zip', ''), TypeError);
    assert.throws(() => isStaleArtifact('DotForge IDE-1.1.0-win-x64.zip', undefined), TypeError);
  });
});
