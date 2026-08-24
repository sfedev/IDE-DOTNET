/**
 * Pruebas del sistema de actualizaciones.
 *
 * Lo que se ejercita aquí es lo que decide si el usuario ve la tarjeta y qué se baja: la
 * comparación de versiones, la lectura del feed de releases y la elección del artefacto. Los tres
 * tienen casos borde que no se ven mirando el camino feliz —`2.10.0` frente a `2.9.0`, un
 * prelanzamiento, un `.dmg` de arm64 en un Windows x64— y los tres se equivocan en silencio.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assetFor,
  compareVersions,
  emptyUpdateState,
  installPlan,
  isNewerVersion,
  parseReleaseFeed,
  parseVersion,
  releaseNotesLines,
  selectUpdate,
  updateHeadline,
  UPDATE_FEED,
} from '../../build/ui-lib.mjs';

/** Respuesta real de la API de releases de GitHub, recortada a lo que se usa. */
const FEED = [
  {
    tag_name: 'v2.2.0',
    name: 'DotForge IDE 2.2.0',
    body: '## Novedades\n\n- Explorador de **extensiones** de Open VSX\n- Corregido el [visor](https://x.dev) de registro\n\n---\n',
    draft: false,
    prerelease: false,
    published_at: '2026-09-10T08:00:00Z',
    html_url: 'https://github.com/sfedev/IDE-DOTNET/releases/tag/v2.2.0',
    assets: [
      {
        name: 'DotForge IDE-2.2.0-Setup-x64.exe',
        browser_download_url: 'https://github.com/sfedev/IDE-DOTNET/releases/download/v2.2.0/Setup-x64.exe',
        size: 118_000_000,
        content_type: 'application/x-msdownload',
      },
      {
        name: 'DotForge IDE-2.2.0-win-x64.zip',
        browser_download_url: 'https://github.com/sfedev/IDE-DOTNET/releases/download/v2.2.0/win-x64.zip',
        size: 140_000_000,
        content_type: 'application/zip',
      },
      {
        name: 'DotForge IDE-2.2.0-arm64.dmg',
        browser_download_url: 'https://github.com/sfedev/IDE-DOTNET/releases/download/v2.2.0/arm64.dmg',
        size: 132_000_000,
        content_type: 'application/x-apple-diskimage',
      },
      {
        name: 'DotForge IDE-2.2.0-x64.dmg',
        browser_download_url: 'https://github.com/sfedev/IDE-DOTNET/releases/download/v2.2.0/x64.dmg',
        size: 136_000_000,
        content_type: 'application/x-apple-diskimage',
      },
    ],
  },
  {
    tag_name: 'v2.3.0-beta.1',
    name: 'Beta',
    body: 'Prueba',
    draft: false,
    prerelease: true,
    published_at: '2026-09-20T08:00:00Z',
    html_url: null,
    assets: [],
  },
  {
    tag_name: 'v2.0.0',
    name: 'DotForge IDE 2.0.0',
    body: 'IntelliSense estable',
    draft: false,
    prerelease: false,
    published_at: '2026-08-24T08:00:00Z',
    assets: [],
  },
];

describe('comparación de versiones', () => {
  it('ordena por número, no por texto', () => {
    assert.equal(isNewerVersion('2.10.0', '2.9.0'), true, '2.10.0 es posterior a 2.9.0');
    assert.equal(isNewerVersion('2.9.0', '2.10.0'), false);
  });

  it('acepta el tag con la v delante y la normaliza', () => {
    const parsed = parseVersion('v2.1.0');
    assert.equal(parsed.raw, '2.1.0');
    assert.equal(parsed.major, 2);
    assert.equal(parsed.minor, 1);
  });

  it('un prelanzamiento es anterior a la versión final', () => {
    assert.equal(isNewerVersion('2.1.0-rc.1', '2.1.0'), false);
    assert.equal(isNewerVersion('2.1.0', '2.1.0-rc.1'), true);
  });

  it('ordena los identificadores de prelanzamiento por SemVer', () => {
    const order = ['2.1.0-alpha', '2.1.0-alpha.1', '2.1.0-beta.2', '2.1.0-beta.11', '2.1.0'];
    for (let index = 1; index < order.length; index++) {
      assert.equal(isNewerVersion(order[index], order[index - 1]), true, `${order[index]} > ${order[index - 1]}`);
    }
  });

  it('los identificadores numéricos van antes que los alfanuméricos', () => {
    assert.equal(compareVersions(parseVersion('1.0.0-1'), parseVersion('1.0.0-alpha')) < 0, true);
  });

  it('los metadatos de build no cambian el orden', () => {
    assert.equal(compareVersions(parseVersion('2.1.0+abc'), parseVersion('2.1.0+zzz')), 0);
  });

  it('la misma versión no es más nueva: no se ofrece actualizar a lo que ya se tiene', () => {
    assert.equal(isNewerVersion('2.1.0', '2.1.0'), false);
  });

  /**
   * Un tag que no es una versión no puede convertirse en "hay actualización". Un repositorio real
   * acumula `nightly`, `latest` y tags de pruebas.
   */
  it('lo que no tiene forma de versión no se entiende, y no es más nuevo', () => {
    assert.equal(parseVersion('nightly'), null);
    assert.equal(parseVersion('v2.1'), null);
    assert.equal(isNewerVersion('nightly', '2.0.0'), false);
  });
});

describe('lectura del feed de releases', () => {
  it('lee la lista y la ordena de la más reciente a la más antigua', () => {
    const releases = parseReleaseFeed(FEED);
    assert.deepEqual(
      releases.map((release) => release.version),
      ['2.3.0-beta.1', '2.2.0', '2.0.0'],
    );
  });

  it('acepta también la release suelta de /releases/latest', () => {
    const releases = parseReleaseFeed(FEED[0]);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].version, '2.2.0');
  });

  it('descarta los tags que no son versiones', () => {
    const releases = parseReleaseFeed([...FEED, { tag_name: 'nightly', assets: [] }]);
    assert.equal(releases.some((release) => release.tag === 'nightly'), false);
  });

  it('marca como prelanzamiento lo que lo dice en el tag aunque el feed no lo declare', () => {
    const releases = parseReleaseFeed([{ tag_name: 'v3.0.0-rc.1', prerelease: false, assets: [] }]);
    assert.equal(releases[0].prerelease, true);
  });

  /**
   * El artefacto acaba ejecutándose en la máquina del usuario: una URL sin TLS sería una
   * actualización manipulable en tránsito.
   */
  it('descarta los artefactos que no se sirven por HTTPS', () => {
    const releases = parseReleaseFeed([
      {
        tag_name: 'v9.0.0',
        assets: [{ name: 'malo.exe', browser_download_url: 'http://ejemplo.dev/malo.exe', size: 10 }],
      },
    ]);
    assert.deepEqual(releases[0].assets, []);
  });

  it('sobrevive a una respuesta que no es lo que se esperaba', () => {
    assert.deepEqual(parseReleaseFeed(null), []);
    assert.deepEqual(parseReleaseFeed('vaya'), []);
    assert.deepEqual(parseReleaseFeed({ message: 'API rate limit exceeded' }), []);
  });
});

describe('elección del artefacto', () => {
  const release = parseReleaseFeed(FEED)[1];

  it('en Windows prefiere el instalador NSIS al portable', () => {
    assert.match(assetFor(release, 'win32', 'x64').name, /Setup-x64\.exe$/);
  });

  it('en macOS elige el .dmg de la arquitectura correcta', () => {
    assert.match(assetFor(release, 'darwin', 'arm64').name, /arm64\.dmg$/);
    assert.match(assetFor(release, 'darwin', 'x64').name, /-x64\.dmg$/);
  });

  it('un Windows nunca se lleva un artefacto de macOS', () => {
    const onlyMac = { ...release, assets: release.assets.filter((asset) => asset.name.endsWith('.dmg')) };
    assert.equal(assetFor(onlyMac, 'win32', 'x64'), null);
  });

  it('sin artefacto para la plataforma devuelve null en vez de uno cualquiera', () => {
    assert.equal(assetFor({ ...release, assets: [] }, 'linux', 'x64'), null);
  });

  /**
   * Si alguno declara la arquitectura, los que no la declaran no valen: bajarse un arm64 en un
   * x64 produce un instalador que no arranca y un informe de error incomprensible.
   */
  it('con artefactos por arquitectura, no se cuela el que no la declara', () => {
    const mixed = {
      ...release,
      assets: [
        { name: 'DotForge-2.2.0.dmg', url: 'https://x/1', size: 1, contentType: null },
        { name: 'DotForge-2.2.0-arm64.dmg', url: 'https://x/2', size: 1, contentType: null },
      ],
    };
    assert.match(assetFor(mixed, 'darwin', 'arm64').name, /arm64/);
  });
});

describe('selección de la actualización a ofrecer', () => {
  const releases = parseReleaseFeed(FEED);
  const query = { currentVersion: '2.1.0', platform: 'win32', arch: 'x64' };

  it('ofrece la última estable e ignora los prelanzamientos', () => {
    assert.equal(selectUpdate(releases, query).release.version, '2.2.0');
  });

  it('con prelanzamientos permitidos ofrece la beta', () => {
    assert.equal(selectUpdate(releases, { ...query, allowPrerelease: true }).release.version, '2.3.0-beta.1');
  });

  it('estando en la última, no ofrece nada', () => {
    assert.equal(selectUpdate(releases, { ...query, currentVersion: '2.2.0' }), null);
  });

  it('nunca ofrece retroceder de versión', () => {
    assert.equal(selectUpdate(releases, { ...query, currentVersion: '9.0.0' }), null);
  });

  it('un borrador no está publicado y no cuenta', () => {
    const drafts = parseReleaseFeed([{ tag_name: 'v5.0.0', draft: true, assets: [] }]);
    assert.equal(selectUpdate(drafts, query), null);
  });

  /**
   * Una release sin instalador para esta plataforma **sí** se ofrece: existe y el usuario debe
   * enterarse. Lo que no hay es descarga, y la tarjeta lo dice.
   */
  it('ofrece la versión aunque no haya artefacto para esta plataforma', () => {
    const candidate = selectUpdate(releases, { ...query, platform: 'linux' });
    assert.equal(candidate.release.version, '2.2.0');
    assert.equal(candidate.asset, null);
  });
});

describe('notas de la versión', () => {
  it('quita el marcado y conserva el texto', () => {
    const lines = releaseNotesLines(FEED[0].body);
    assert.deepEqual(lines, [
      'Novedades',
      '· Explorador de extensiones de Open VSX',
      '· Corregido el visor de registro',
    ]);
  });

  it('respeta el tope de líneas', () => {
    const body = Array.from({ length: 40 }, (_, index) => `- línea ${index}`).join('\n');
    assert.equal(releaseNotesLines(body, 5).length, 5);
  });

  it('con cuerpo vacío no inventa nada', () => {
    assert.deepEqual(releaseNotesLines(''), []);
  });

  it('no arrastra los saltos de línea de Windows', () => {
    assert.deepEqual(releaseNotesLines('- uno\r\n- dos\r\n'), ['· uno', '· dos']);
  });
});

describe('plan de instalación', () => {
  it('en Windows el instalador NSIS se lanza en silencio', () => {
    const plan = installPlan('win32', 'C:\\Users\\x\\AppData\\updates\\Setup.exe');
    assert.equal(plan.kind, 'silent');
    assert.deepEqual(plan.args, ['/S']);
  });

  /**
   * Un `.dmg` sin firmar y sin framework de actualización no se instala solo: alguien tiene que
   * arrastrar la app a Aplicaciones. El modelo lo dice en vez de fingir que sí.
   */
  it('en macOS se abre la imagen de disco y se explica por qué', () => {
    const plan = installPlan('darwin', '/tmp/DotForge.dmg');
    assert.equal(plan.kind, 'open');
    assert.match(plan.note, /Aplicaciones/);
  });

  it('un portable de Windows tampoco se instala solo', () => {
    assert.equal(installPlan('win32', 'C:\\x\\portable.zip').kind, 'open');
  });
});

describe('estado inicial y presentación', () => {
  it('arranca sin nada que ofrecer', () => {
    const state = emptyUpdateState('2.1.0');
    assert.equal(state.status, 'idle');
    assert.equal(state.version, null);
    assert.equal(state.applyOnQuit, false);
    assert.equal(state.dismissed, false);
  });

  it('el titular lleva el cohete y la versión', () => {
    assert.equal(updateHeadline('2.2.0'), '🚀 Nueva versión disponible (v2.2.0)');
  });

  it('el feed apunta al repositorio del producto por HTTPS', () => {
    assert.match(UPDATE_FEED, /^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases$/);
  });
});
