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
  applyActionLabel,
  applyConfirmation,
  assetFor,
  compareVersions,
  emptyUpdateState,
  installPlan,
  isNewerVersion,
  judgePending,
  outcomeHeadline,
  outcomeMessage,
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
    assert.deepEqual(plan.args, ['/S', '--force-run']);
  });

  /**
   * `--force-run` es lo que hace verdad la frase de la tarjeta. Un NSIS asistido
   * (`oneClick: false`, que es lo que declara `electron-builder.yml`) instalado con `/S` a secas
   * **no** relanza la aplicación: el usuario se quedaría con el escritorio vacío después de haber
   * leído "y se vuelve a abrir al terminar".
   */
  it('el plan silencioso pide explícitamente que la aplicación vuelva a abrirse', () => {
    const plan = installPlan('win32', 'C:\\x\\Setup.exe');
    assert.ok(plan.args.includes('--force-run'));
    assert.match(plan.note, /se abrirá de nuevo al terminar/);
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

/**
 * Aviso previo al cierre.
 *
 * Es texto, y por eso se prueba: es lo único que el usuario lee **antes** de que la ventana
 * desaparezca, y una vez desaparecida ya no hay dónde corregir la impresión que dejó.
 */
describe('aviso previo a aplicar la actualización', () => {
  it('el botón dice lo que hace en cada plataforma', () => {
    assert.equal(applyActionLabel('silent'), 'Cerrar e instalar');
    assert.equal(applyActionLabel('open'), 'Abrir instalador');
  });

  it('el botón nunca promete un reinicio: el IDE se cierra, no se reinicia', () => {
    for (const kind of ['silent', 'open']) {
      assert.doesNotMatch(applyActionLabel(kind), /reinici/i);
      assert.doesNotMatch(applyConfirmation('2.8.0', kind).title, /reinici/i);
    }
  });

  it('el plan silencioso avisa del cierre, de la duración y de que la app vuelve sola', () => {
    const confirmation = applyConfirmation('2.8.0', 'silent');
    assert.match(confirmation.message, /se va a cerrar/);
    assert.match(confirmation.message, /2\.8\.0/);
    assert.match(confirmation.detail, /unos segundos/);
    assert.match(confirmation.detail, /se vuelve a abrir/);
    assert.equal(confirmation.confirmLabel, 'Cerrar e instalar');
  });

  /**
   * En macOS no hay instalación silenciosa ni reapertura automática, y el aviso **no puede**
   * prometer ninguna de las dos: quien lea "se vuelve a abrir al terminar" y se quede con una
   * imagen de disco abierta dará por hecho que algo se ha roto.
   */
  it('el plan abierto no promete ni silencio ni reapertura', () => {
    const confirmation = applyConfirmation('2.8.0', 'open');
    assert.match(confirmation.detail, /tendrás que completar/i);
    assert.doesNotMatch(confirmation.detail, /se vuelve a abrir/);
    assert.doesNotMatch(confirmation.detail, /segundo plano/);
    assert.equal(confirmation.confirmLabel, 'Abrir instalador');
  });

  it('cancelar se llama "ahora no", no "cancelar": la actualización sigue estando', () => {
    assert.equal(applyConfirmation('2.8.0', 'silent').cancelLabel, 'Ahora no');
  });
});

/**
 * Cierre de bucle.
 *
 * Es la mitad del actualizador que sólo se ve en el arranque **siguiente**, y por tanto la que
 * nadie prueba a mano: exige publicar una release, instalarla y —para el caso interesante—
 * cancelarle el aviso de permisos a Windows. Aquí son cuatro veredictos sobre datos.
 */
describe('qué pasó con la instalación programada', () => {
  const record = {
    version: '2.8.0',
    attempts: 1,
    notes: ['· Publicación de proyectos', '· Ctrl+B esconde la barra lateral'],
    releaseUrl: 'https://github.com/sfedev/IDE-DOTNET/releases/tag/v2.8.0',
  };

  const silent = { fileExists: true, planKind: 'silent' };

  it('la versión que corre es la prometida: se instaló', () => {
    const verdict = judgePending(record, { ...silent, currentVersion: '2.8.0' });
    assert.equal(verdict.kind, 'applied');
    assert.equal(verdict.outcome.kind, 'just-updated');
    assert.equal(verdict.outcome.version, '2.8.0');
    assert.deepEqual(verdict.outcome.notes, record.notes);
  });

  /**
   * Si por el camino se instaló a mano una versión posterior, la instalación programada también
   * quedó atrás — pero las notas guardadas son de otra release, y contarlas como novedades de la
   * que corre sería mentir con detalle.
   */
  it('con una versión posterior instalada a mano, se felicita sin inventarse las novedades', () => {
    const verdict = judgePending(record, { ...silent, currentVersion: '2.9.0' });
    assert.equal(verdict.kind, 'applied');
    assert.equal(verdict.outcome.version, '2.9.0');
    assert.deepEqual(verdict.outcome.notes, []);
    assert.equal(verdict.outcome.releaseUrl, null);
  });

  it('se lanzó el instalador y el IDE sigue en la versión de antes: no se completó', () => {
    const verdict = judgePending(record, { ...silent, currentVersion: '2.7.0' });
    assert.equal(verdict.kind, 'failed');
    assert.equal(verdict.outcome.kind, 'install-failed');
    assert.equal(verdict.outcome.version, '2.8.0');
    assert.equal(verdict.outcome.attempts, 1);
  });

  it('descargada y nunca lanzada: se rearma la promesa, sin avisar de nada', () => {
    const verdict = judgePending({ ...record, attempts: 0 }, { ...silent, currentVersion: '2.7.0' });
    assert.equal(verdict.kind, 'pending');
  });

  /**
   * En macOS, "se abrió la imagen de disco y todavía no se ha arrastrado nada" es el curso normal.
   * Declararlo fallido pintaría un aviso rojo en cada arranque hasta que alguien complete el
   * arrastre — y el usuario que decidió no completarlo lo vería para siempre.
   */
  it('un plan que se completa a mano nunca se declara fallido', () => {
    const verdict = judgePending(record, { fileExists: true, planKind: 'open', currentVersion: '2.7.0' });
    assert.equal(verdict.kind, 'pending');
  });

  it('sin el archivo descargado no queda nada que hacer', () => {
    const verdict = judgePending(record, { fileExists: false, planKind: 'silent', currentVersion: '2.7.0' });
    assert.equal(verdict.kind, 'stale');
  });

  /**
   * El `pending.json` lo escribe una versión del IDE y lo lee otra: el de la v2.7.0 no tiene
   * `attempts` ni `notes`. Tratarlo como un intento fallido pintaría un aviso de fallo a todo el
   * que actualice desde una versión anterior a ésta.
   */
  it('un registro escrito por una versión anterior no cuenta como intento', () => {
    const verdict = judgePending({ version: '2.8.0' }, { ...silent, currentVersion: '2.7.0' });
    assert.equal(verdict.kind, 'pending');
  });

  it('un número de intentos absurdo no se propaga', () => {
    const outcome = judgePending({ version: '2.8.0', attempts: -3 }, { ...silent, currentVersion: '2.8.0' });
    assert.equal(outcome.outcome.attempts, 0);
  });
});

describe('el aviso de cierre de bucle, en palabras', () => {
  const applied = { kind: 'just-updated', version: '2.8.0', attempts: 1, notes: ['· Algo'], releaseUrl: null };
  const failed = { kind: 'install-failed', version: '2.8.0', attempts: 1, notes: [], releaseUrl: null };

  it('el éxito lleva la marca y la versión', () => {
    assert.equal(outcomeHeadline(applied), '✅ ¡Actualizado con éxito a la v2.8.0!');
  });

  it('el fallo dice que no se completó, no que haya fallado el IDE', () => {
    assert.equal(outcomeHeadline(failed), '⚠️ La actualización a la v2.8.0 no se completó');
  });

  it('con novedades, el texto las presenta; sin ellas, no las promete', () => {
    assert.match(outcomeMessage(applied, '2.8.0'), /Esto es lo que trae/);
    assert.doesNotMatch(outcomeMessage({ ...applied, notes: [] }, '2.8.0'), /Esto es lo que trae/);
  });

  /**
   * El instalador se lanza desprendido justo antes de que el proceso desaparezca: su código de
   * salida no lo lee nadie. Elegir una de las dos causas sería adivinar delante del usuario.
   */
  it('el fallo nombra las dos causas posibles y dónde ha quedado el usuario', () => {
    const message = outcomeMessage(failed, '2.7.0');
    assert.match(message, /v2\.7\.0/);
    assert.match(message, /permisos de Windows/);
    assert.match(message, /no llegó a terminar/);
    assert.match(message, /sigue guardada/);
  });

  it('a partir del segundo intento, se dice cuántos van', () => {
    assert.match(outcomeMessage({ ...failed, attempts: 3 }, '2.7.0'), /Van 3 intentos/);
    assert.doesNotMatch(outcomeMessage(failed, '2.7.0'), /intentos\./);
  });
});

describe('estado inicial y presentación', () => {
  it('arranca sin nada que ofrecer', () => {
    const state = emptyUpdateState('2.1.0');
    assert.equal(state.status, 'idle');
    assert.equal(state.version, null);
    assert.equal(state.applyOnQuit, false);
    assert.equal(state.dismissed, false);
    assert.equal(state.planKind, null);
    assert.equal(state.outcome, null);
  });

  it('el titular lleva el cohete y la versión', () => {
    assert.equal(updateHeadline('2.2.0'), '🚀 Nueva versión disponible (v2.2.0)');
  });

  it('el feed apunta al repositorio del producto por HTTPS', () => {
    assert.match(UPDATE_FEED, /^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases$/);
  });
});
