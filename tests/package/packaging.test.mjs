/**
 * Pruebas de empaquetado.
 *
 * Verifican lo que se puede verificar sin ejecutar una build de 10 minutos: que la configuración
 * declara los targets prometidos, que la salida de la compilación está completa y que los iconos
 * generados son archivos válidos según sus formatos, no bytes con la extensión correcta.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

  it('no tiene dependencias nativas que requieran compilación en el equipo del usuario', () => {
    // Todas las dependencias de runtime deben ser JavaScript puro: si entra una nativa, hay que
    // añadir un paso de rebuild por plataforma y el empaquetado deja de ser reproducible.
    const nativeSuspects = ['node-pty', 'sqlite3', 'better-sqlite3', 'serialport', 'canvas', 'sharp'];
    for (const suspect of nativeSuspects) {
      assert.ok(!packageJson.dependencies?.[suspect], `dependencia nativa detectada: ${suspect}`);
    }
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
    assert.ok(renderer.length < 400 * 1024, `el bundle del renderer pesa ${renderer.length} bytes`);
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

  it('el workflow de CI construye macOS en un runner macOS', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(workflow, /runs-on:\s*macos-latest/);
    assert.match(workflow, /npm run dist:mac/);
    assert.match(workflow, /verify-dist\.mjs --require mac/);
  });
});
