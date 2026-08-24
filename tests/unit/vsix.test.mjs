/**
 * Pruebas del formato `.vsix` y de su instalación.
 *
 * El paquete se construye a mano con la forma real de un `.vsix` —`extension/package.json` más los
 * dos archivos de OPC— y se instala de verdad en un directorio temporal. Un doble del extractor no
 * probaría lo que hay que probar: que se descarta el primer nivel, que los archivos de envoltorio
 * no acaban en el disco y que la instalación queda con su manifiesto verificable.
 *
 * La parte que más importa es la que no se ve: `publisher` y `name` salen de un JSON descargado y
 * acaban formando un **nombre de carpeta**. Un `name` con `../` no es un caso teórico.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  describeContributions,
  extensionFolderName,
  hasNewerVersion,
  isExtensionEntry,
  manifestId,
  parseVsixManifest,
  sortInstalled,
  STATIC_CONTRIBUTIONS,
} from '../../build/ui-lib.mjs';
import {
  extensionsDirectory,
  findInstalled,
  initializeExtensions,
  installFromBuffer,
  listInstalled,
  readVsixManifest,
  uninstallExtension,
} from '../../build/main-lib.mjs';
import { MANIFEST_FILE } from '../../build/toolchain.mjs';
import { makeZip } from './zip-fixture.mjs';

const MANIFEST = {
  name: 'csharp-theme',
  displayName: 'C# Theme',
  publisher: 'dotforge',
  version: '1.2.0',
  description: 'Un tema de color para C#.',
  engines: { vscode: '^1.80.0' },
  categories: ['Themes'],
  license: 'MIT',
  repository: { type: 'git', url: 'https://github.com/dotforge/tema' },
  contributes: {
    themes: [{ label: 'DotForge', uiTheme: 'vs-dark', path: './themes/dotforge.json' }],
    snippets: [{ language: 'csharp', path: './snippets/csharp.json' }],
    commands: [{ command: 'tema.aplicar', title: 'Aplicar' }],
  },
};

/** Un `.vsix` con la forma real: envoltorio de OPC fuera, contenido bajo `extension/`. */
function makeVsix(manifest = MANIFEST) {
  return makeZip([
    ['[Content_Types].xml', Buffer.from('<Types />')],
    ['extension.vsixmanifest', Buffer.from('<PackageManifest />')],
    ['extension/package.json', Buffer.from(JSON.stringify(manifest, null, 2))],
    ['extension/themes/dotforge.json', Buffer.from('{ "colors": {} }')],
    ['extension/snippets/csharp.json', Buffer.from('{ }')],
  ]);
}

async function withExtensions(run) {
  const root = await mkdtemp(join(tmpdir(), 'dotforge-ext-'));
  initializeExtensions(root);
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('manifiesto de una extensión', () => {
  it('lee lo que la interfaz necesita enseñar', () => {
    const manifest = parseVsixManifest(JSON.stringify(MANIFEST));
    assert.equal(manifestId(manifest), 'dotforge.csharp-theme');
    assert.equal(manifest.displayName, 'C# Theme');
    assert.equal(manifest.engine, '^1.80.0');
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.repository, 'https://github.com/dotforge/tema');
    assert.deepEqual(manifest.contributes, ['themes', 'snippets', 'commands']);
    assert.equal(manifest.hasCode, false);
  });

  it('admite `repository` como cadena, que también es legal', () => {
    const manifest = parseVsixManifest(
      JSON.stringify({ ...MANIFEST, repository: 'https://github.com/x/y' }),
    );
    assert.equal(manifest.repository, 'https://github.com/x/y');
  });

  it('detecta que trae código de activación', () => {
    const manifest = parseVsixManifest(JSON.stringify({ ...MANIFEST, main: './out/extension.js' }));
    assert.equal(manifest.hasCode, true);
  });

  it('sin publisher, name o version no es instalable y lo dice', () => {
    assert.throws(() => parseVsixManifest(JSON.stringify({ name: 'x', version: '1.0.0' })), /publisher/);
    assert.throws(() => parseVsixManifest('{ no es json'), /JSON/);
    assert.throws(() => parseVsixManifest('[]'), /objeto/);
  });

  /** Lo que acaba siendo un nombre de carpeta se valida antes de tocar el disco. */
  it('rechaza identificadores que se salen del directorio de extensiones', () => {
    for (const name of ['../fuera', 'a/b', '..', 'con espacio']) {
      assert.throws(
        () => parseVsixManifest(JSON.stringify({ ...MANIFEST, name })),
        /identificador válido/,
        `debería rechazar name="${name}"`,
      );
    }
  });

  it('la carpeta lleva la versión, para poder convivir con la anterior', () => {
    const manifest = parseVsixManifest(JSON.stringify(MANIFEST));
    assert.equal(extensionFolderName(manifest), 'dotforge.csharp-theme-1.2.0');
  });

  it('sólo se instala el subárbol de la extensión', () => {
    assert.equal(isExtensionEntry('extension/package.json'), true);
    assert.equal(isExtensionEntry('[Content_Types].xml'), false);
    assert.equal(isExtensionEntry('extension.vsixmanifest'), false);
    assert.equal(isExtensionEntry('extension/'), false);
  });
});

describe('qué aporta la extensión', () => {
  it('reparte lo declarativo de lo que aquí no tiene efecto', () => {
    const summary = describeContributions(parseVsixManifest(JSON.stringify(MANIFEST)));
    assert.deepEqual(summary.supported, ['temas de color', 'fragmentos de código']);
    assert.deepEqual(summary.unsupported, ['comandos']);
    assert.equal(summary.hasCode, false);
  });

  it('el código de activación se marca aparte: DotForge no ejecuta extensiones', () => {
    const summary = describeContributions(
      parseVsixManifest(JSON.stringify({ ...MANIFEST, main: './out/x.js' })),
    );
    assert.equal(summary.hasCode, true);
  });

  it('las contribuciones estáticas son las que no necesitan ejecutar nada', () => {
    for (const key of ['themes', 'snippets', 'grammars', 'languages']) {
      assert.ok(STATIC_CONTRIBUTIONS.includes(key), `${key} debería considerarse estática`);
    }
    assert.equal(STATIC_CONTRIBUTIONS.includes('debuggers'), false);
  });
});

describe('versiones de una extensión instalada', () => {
  it('detecta que el registro tiene una posterior', () => {
    assert.equal(hasNewerVersion('1.2.0', '1.3.0'), true);
    assert.equal(hasNewerVersion('1.2.0', '1.2.0'), false);
    assert.equal(hasNewerVersion('1.10.0', '1.9.0'), false);
  });

  it('ordena por nombre visible, que es por lo que se busca', () => {
    const names = sortInstalled([
      { displayName: 'Zeta' },
      { displayName: 'álfa' },
      { displayName: 'Beta' },
    ]).map((entry) => entry.displayName);
    assert.deepEqual(names, ['álfa', 'Beta', 'Zeta']);
  });
});

describe('instalación en el disco', () => {
  it('extrae sólo el contenido de la extensión, sin el envoltorio del paquete', async () => {
    await withExtensions(async () => {
      const { extension, files } = await installFromBuffer(makeVsix());

      assert.equal(extension.id, 'dotforge.csharp-theme');
      assert.equal(extension.version, '1.2.0');
      assert.equal(files, 3, 'los dos archivos de OPC no se escriben');

      assert.ok(existsSync(join(extension.directory, 'package.json')));
      assert.ok(existsSync(join(extension.directory, 'themes', 'dotforge.json')));
      assert.equal(existsSync(join(extension.directory, 'extension')), false, 'el primer nivel se descarta');
      assert.equal(existsSync(join(extension.directory, '[Content_Types].xml')), false);
    });
  });

  /**
   * Nada de marcadores propios: se reutiliza el instalador verificable del toolchain, que anota el
   * tamaño y el hash de cada archivo escrito (ADR-041).
   */
  it('deja el manifiesto de instalación verificable', async () => {
    await withExtensions(async () => {
      const { extension } = await installFromBuffer(makeVsix());
      assert.ok(existsSync(join(extension.directory, MANIFEST_FILE)));
    });
  });

  it('lee el manifiesto sin extraer nada', () => {
    assert.equal(readVsixManifest(makeVsix()).publisher, 'dotforge');
  });

  it('un ZIP que no es un .vsix se rechaza con un mensaje que lo explica', () => {
    const zip = makeZip([['README.md', Buffer.from('hola')]]);
    assert.throws(() => readVsixManifest(zip), /no parece un \.vsix/);
  });

  it('lista lo instalado con lo que aporta ya calculado', async () => {
    await withExtensions(async () => {
      await installFromBuffer(makeVsix());
      const installed = await listInstalled();

      assert.equal(installed.length, 1);
      assert.equal(installed[0].id, 'dotforge.csharp-theme');
      assert.deepEqual(installed[0].contributions.supported, ['temas de color', 'fragmentos de código']);
      assert.notEqual(installed[0].installedAtUtc, null);
    });
  });

  /**
   * Al actualizar, la carpeta antigua desaparece: dos versiones de la misma extensión conviviendo
   * son dos temas con el mismo nombre y ninguna forma de saber cuál manda.
   */
  it('actualizar reemplaza la versión anterior', async () => {
    await withExtensions(async () => {
      await installFromBuffer(makeVsix());
      const outcome = await installFromBuffer(makeVsix({ ...MANIFEST, version: '1.3.0' }));

      assert.equal(outcome.replaced, '1.2.0');

      const installed = await listInstalled();
      assert.equal(installed.length, 1);
      assert.equal(installed[0].version, '1.3.0');

      const folders = await readdir(extensionsDirectory());
      assert.deepEqual(folders, ['dotforge.csharp-theme-1.3.0']);
    });
  });

  it('desinstala por identificador y no deja rastro', async () => {
    await withExtensions(async () => {
      await installFromBuffer(makeVsix());

      assert.equal(await uninstallExtension('dotforge.csharp-theme'), true);
      assert.deepEqual(await listInstalled(), []);
      assert.equal(await findInstalled('dotforge.csharp-theme'), null);
    });
  });

  it('desinstalar algo que no está instalado no es un error', async () => {
    await withExtensions(async () => {
      assert.equal(await uninstallExtension('nadie.nada'), false);
    });
  });

  it('sin ninguna extensión instalada, la lista está vacía y no revienta', async () => {
    await withExtensions(async () => {
      assert.deepEqual(await listInstalled(), []);
    });
  });
});
