/**
 * Pruebas de la adquisición del servidor de lenguaje: qué versión se elige, cómo se detecta que el
 * servidor se ha roto y cómo se comprueba que la instalación del disco sigue siendo la que se
 * instaló.
 *
 * Las tres cosas nacen del mismo fallo, que estuvo vivo desde la v1.1 hasta la v2.0 y que este
 * archivo fija para que no vuelva:
 *
 *   El IntelliSense de C# nunca funcionó en la máquina de desarrollo. El servidor de Roslyn
 *   arrancaba, contestaba al handshake, decía "listo" y devolvía `null` a todo. Por stderr escribía
 *   un `PartDiscoveryException` sobre `Microsoft.CodeAnalysis.CSharp.Features.dll`, y de ahí se
 *   concluyó —en la v1.9— que el paquete del feed estaba mal.
 *
 *   No lo estaba. El `.nupkg` es correcto y su SHA-256 coincide con el del feed. Lo que estaba mal
 *   era **un archivo de los 462 extraídos**, truncado en disco a 5.242.880 bytes exactos cuando el
 *   ZIP declara 6.396.176. Con ese DLL mutilado, MEF no compone. Extraído de nuevo, el mismo
 *   paquete y la misma versión arrancan sin un solo `fail:`.
 *
 * Las cifras y las cadenas de este archivo son reales: el índice del feed es el que publica
 * `vs-impl`, y la traza de stderr está capturada de la ejecución del servidor en Windows en
 * español —con su mensaje traducido, que es justamente por lo que la detección mira nombres de tipo
 * y no texto—.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addQuarantineEntry,
  buildManifest,
  compareRoslynVersions,
  configurationResponse,
  createServerLogScanner,
  describeFault,
  describeProblems,
  describeSelection,
  diffInstall,
  installArchive,
  isUnstableVersion,
  logLevelOf,
  MANIFEST_FILE,
  MAX_QUARANTINE_ENTRIES,
  parseManifest,
  parseQuarantine,
  parseRoslynVersion,
  pickLatestVersion,
  quarantinedVersions,
  readInstallManifest,
  removeQuarantineEntry,
  ROSLYN_PINNED_VERSION,
  ROSLYN_VERIFIED_VERSIONS,
  selectRoslynVersion,
  serializeQuarantine,
  serverRequestResponse,
  staleQuarantineEntries,
  verifyInstall,
  ZipError,
} from '../../build/toolchain.mjs';
import { corruptDeclaredSize, makeZip } from './zip-fixture.mjs';

/** Raíz del repositorio, para las comprobaciones estructurales sobre el código fuente. */
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Trozo real del índice de `microsoft.codeanalysis.languageserver.win-x64`.
 *
 * El feed lo devuelve **descendente**, que es la trampa original: coger la última daba la más
 * antigua. Y conviven cuatro cosas distintas —la rama principal sin publicar (`5.4.0-2.*`), una
 * compilación declarada de prueba (`5.3.0-2-test.*`), bandas publicadas (`4.14.0-3.*`) y bandas
 * viejas (`4.8.0-7.*`)—, ninguna de ellas estable en el sentido de SemVer.
 */
const FEED_INDEX = [
  '5.4.0-2.26179.14',
  '5.4.0-2.26177.7',
  '5.3.0-2-test.25610.8',
  '5.3.0-1.25506.7',
  '5.0.0-2.26423.4',
  '4.15.0-1.25175.5',
  '4.14.0-3.26423.7',
  '4.14.0-3.25465.8',
  '4.12.0-3.26423.8',
  '4.8.0-7.25324.2',
];

describe('política de versiones del servidor de Roslyn', () => {
  it('descompone una versión del feed en banda, números de sufijo y marcadores', () => {
    const parsed = parseRoslynVersion('5.4.0-2.26179.14');
    assert.deepEqual(parsed.release, [5, 4, 0]);
    assert.deepEqual(parsed.prereleaseNumbers, [2, 26179, 14]);
    assert.deepEqual(parsed.markers, []);

    const test = parseRoslynVersion('5.3.0-2-test.25610.8');
    assert.deepEqual(test.release, [5, 3, 0]);
    assert.deepEqual(test.markers, ['test'], 'el marcador se extrae aunque venga pegado a un número');
  });

  it('ordena por banda antes que por sufijo', () => {
    assert.ok(compareRoslynVersions('5.4.0-2.26179.14', '4.8.0-7.25324.2') > 0);
    assert.ok(compareRoslynVersions('4.14.0-3.26423.7', '4.14.0-3.25465.8') > 0);
    assert.equal(compareRoslynVersions('4.14.0-3.26423.7', '4.14.0-3.26423.7'), 0);
  });

  it('una versión sin sufijo gana a la misma banda con sufijo', () => {
    // Hoy el feed no publica ninguna, pero el día que lo haga debe ganar sin tocar código.
    assert.ok(compareRoslynVersions('5.0.0', '5.0.0-2.26423.4') > 0);
  });

  it('pickLatestVersion no se fía del orden del feed', () => {
    assert.equal(pickLatestVersion(FEED_INDEX), '5.4.0-2.26179.14');
    assert.equal(pickLatestVersion([...FEED_INDEX].reverse()), '5.4.0-2.26179.14');
    assert.equal(pickLatestVersion([]), null);
  });

  it('reconoce los marcadores de inestabilidad como trozo completo, no como subcadena', () => {
    assert.equal(isUnstableVersion('5.3.0-2-test.25610.8'), true);
    assert.equal(isUnstableVersion('4.14.0-3.26423.7'), false);
    // "3.26423" contiene "rc"? No. Pero sí contiene dígitos sueltos: buscar subcadenas casaría
    // con cualquier cosa. Se comprueba que una banda normal no se descarta por accidente.
    assert.equal(isUnstableVersion('5.4.0-2.26179.14'), false);
  });

  it('elige la versión fijada mientras el feed la publique', () => {
    const selection = selectRoslynVersion(FEED_INDEX);
    assert.equal(selection.version, ROSLYN_PINNED_VERSION);
    assert.equal(selection.reason, 'pinned');
    assert.match(describeSelection(selection), /fijada/);
  });

  it('la versión fijada está en la lista de verificadas y es la primera', () => {
    assert.equal(ROSLYN_VERIFIED_VERSIONS[0], ROSLYN_PINNED_VERSION);
    assert.ok(ROSLYN_VERIFIED_VERSIONS.length >= 1);
  });

  it('sin la fijada, coge la más alta que no se declare de prueba', () => {
    const sinFijada = FEED_INDEX.filter((version) => version !== ROSLYN_PINNED_VERSION);
    const selection = selectRoslynVersion(sinFijada);
    assert.equal(selection.version, '5.4.0-2.26179.14');
    assert.equal(selection.reason, 'stable');
  });

  it('nunca elige una compilación declarada de prueba mientras quede otra cosa', () => {
    const selection = selectRoslynVersion(['5.3.0-2-test.25610.8', '4.8.0-7.25324.2']);
    assert.equal(selection.version, '4.8.0-7.25324.2');
    assert.equal(selection.reason, 'stable');
  });

  it('si sólo quedan compilaciones de prueba, coge una antes que dejar al usuario sin servidor', () => {
    const selection = selectRoslynVersion(['5.3.0-2-test.25610.8']);
    assert.equal(selection.version, '5.3.0-2-test.25610.8');
    assert.equal(selection.reason, 'fallback');
  });

  it('salta las versiones en cuarentena, incluida la fijada', () => {
    const selection = selectRoslynVersion(FEED_INDEX, { blocked: [ROSLYN_PINNED_VERSION] });
    assert.notEqual(selection.version, ROSLYN_PINNED_VERSION);
    // El motivo era `stable`, que se traduce como "la fijada ya no está en el feed". Aquí sí está:
    // lo que pasa es que este equipo la ha vetado, que es lo contrario y lleva a otro sitio.
    assert.equal(selection.reason, 'quarantined');
  });

  it('devuelve null cuando no queda ninguna candidata', () => {
    assert.equal(selectRoslynVersion([]), null);
    assert.equal(selectRoslynVersion(FEED_INDEX, { blocked: FEED_INDEX }), null);
  });
});

// ---------------------------------------------------------------------------------------------
// Detección del servidor roto
// ---------------------------------------------------------------------------------------------

/**
 * stderr **real** del servidor 5.4.0-2.26179.14 sobre la instalación con el DLL truncado, en un
 * Windows en español.
 *
 * Obsérvese que el mensaje de la excepción viene traducido ("No se pudo cargar el ensamblado […]
 * para su análisis") y que el nombre del tipo no. Ahí está la regla entera de este módulo.
 */
const STDERR_MEF = [
  'info: Program[0]',
  '      Server started with process ID 18992',
  'fail: Microsoft.CodeAnalysis.Remote.ExportProviderBuilder[0]',
  '      Encountered exception in the MEF composition',
  '      Microsoft.VisualStudio.Composition.PartDiscoveryException: No se pudo cargar el ensamblado "C:\\toolchain\\Microsoft.CodeAnalysis.CSharp.Features.dll" para su análisis.',
  '       ---> System.IO.FileNotFoundException: Could not find assembly Microsoft.CodeAnalysis.CSharp.Features, Version=5.4.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35 in any extension context.',
  '',
].join('\n');

/** El mismo servidor cuando todo va bien: sólo informativo. */
const STDERR_SANO = ['info: Program[0]', '      Server started with process ID 4242', ''].join('\n');

describe('detección de un servidor de lenguaje roto', () => {
  it('reconoce el nivel declarado por cada línea', () => {
    assert.equal(logLevelOf('fail: Microsoft.CodeAnalysis.Remote.ExportProviderBuilder[0]'), 'fail');
    assert.equal(logLevelOf('info: Program[0]'), 'info');
    assert.equal(logLevelOf('      Encountered exception'), null, 'las continuaciones no declaran nivel');
  });

  it('caza el fallo de composición de MEF', () => {
    const scanner = createServerLogScanner();
    const fault = scanner.push(STDERR_MEF);

    assert.ok(fault, 'el fallo tiene que detectarse');
    assert.equal(fault.category, 'mef');
    assert.equal(fault.signature, 'PartDiscoveryException');
    assert.match(describeFault(fault, 'Roslyn LanguageServer'), /Roslyn LanguageServer/);
  });

  it('no se inventa fallos con un arranque sano', () => {
    const scanner = createServerLogScanner();
    assert.equal(scanner.push(STDERR_SANO), null);
    assert.equal(scanner.fault(), null);
  });

  it('ignora una excepción mencionada en una línea informativa', () => {
    const scanner = createServerLogScanner();
    scanner.push('info: Workspace[0]\n      descartado FileNotFoundException al sondear el disco\n');
    assert.equal(scanner.fault(), null, 'sólo cuenta dentro de un bloque fail: o crit:');
  });

  it('detecta igual con el stream troceado byte a byte', () => {
    // Los trozos de un stream no respetan los límites de línea: `PartDiscoveryEx` + `ception:` es
    // una lectura perfectamente normal, y sin búfer el fallo se detecta de forma intermitente.
    const scanner = createServerLogScanner();
    let fault = null;
    for (const character of STDERR_MEF) {
      fault = scanner.push(character) ?? fault;
    }
    assert.ok(fault);
    assert.equal(fault.signature, 'PartDiscoveryException');
  });

  it('avisa una sola vez aunque la traza siga llegando', () => {
    const scanner = createServerLogScanner();
    assert.ok(scanner.push(STDERR_MEF));
    assert.equal(scanner.push(STDERR_MEF), null, 'la segunda mitad de la traza no vuelve a avisar');
  });

  it('recoge un volcado sin registro previo al cerrarse el proceso', () => {
    const scanner = createServerLogScanner();
    // Sin salto de línea final: un proceso que se muere termina justo así.
    scanner.push('System.TypeInitializationException: The type initializer threw an exception.');
    const fault = scanner.flush();
    assert.ok(fault);
    assert.equal(fault.category, 'crash');
  });

  it('no considera fatal quedarse sin memoria', () => {
    const scanner = createServerLogScanner();
    scanner.push('fail: Program[0]\n      System.OutOfMemoryException: sin memoria\n');
    assert.equal(scanner.fault(), null, 'eso habla de la máquina, no del paquete');
  });
});

describe('cuarentena de versiones', () => {
  const entrada = { version: '5.4.0-2.26179.14', rid: 'win-x64', reason: 'MEF', atUtc: '2026-08-24T10:00:00.000Z' };

  it('guarda y relee', () => {
    const record = addQuarantineEntry({ version: 1, entries: [] }, entrada);
    const releido = parseQuarantine(serializeQuarantine(record));
    assert.deepEqual(quarantinedVersions(releido, 'win-x64'), ['5.4.0-2.26179.14']);
  });

  it('separa por RID: una compilación rota en Windows no dice nada de macOS', () => {
    const record = addQuarantineEntry({ version: 1, entries: [] }, entrada);
    assert.deepEqual(quarantinedVersions(record, 'osx-arm64'), []);
  });

  it('no duplica y deja lo último delante', () => {
    let record = addQuarantineEntry({ version: 1, entries: [] }, entrada);
    record = addQuarantineEntry(record, { ...entrada, reason: 'otra vez' });
    assert.equal(record.entries.length, 1);
    assert.equal(record.entries[0].reason, 'otra vez');
  });

  it('levanta el veto cuando la culpa era de la copia y no de la versión', () => {
    const record = removeQuarantineEntry(addQuarantineEntry({ version: 1, entries: [] }, entrada), entrada.version, 'win-x64');
    assert.deepEqual(quarantinedVersions(record, 'win-x64'), []);
  });

  it('tiene tope: es una lista de fallos, no un historial', () => {
    let record = { version: 1, entries: [] };
    for (let i = 0; i < MAX_QUARANTINE_ENTRIES + 20; i++) {
      record = addQuarantineEntry(record, { ...entrada, version: `4.0.0-${i}` });
    }
    assert.equal(record.entries.length, MAX_QUARANTINE_ENTRIES);
  });

  it('un archivo ilegible es una lista vacía, no una excepción', () => {
    assert.deepEqual(parseQuarantine('{ esto no es json').entries, []);
    assert.deepEqual(parseQuarantine('null').entries, []);
  });
});

// ---------------------------------------------------------------------------------------------
// Instalación verificable
// ---------------------------------------------------------------------------------------------

describe('instalación verificable del toolchain', () => {
  const ARCHIVE = makeZip([
    ['content/LanguageServer/win-x64/server.dll', Buffer.alloc(6396176, 7)],
    ['content/LanguageServer/win-x64/lib/helper.dll', Buffer.from('ayudante')],
    ['lib/net10.0/otra-cosa.dll', Buffer.from('no interesa')],
  ]);

  async function install() {
    const root = await mkdtemp(join(tmpdir(), 'dotforge-install-'));
    const directory = join(root, 'roslyn');
    const prefix = 'content/LanguageServer/win-x64/';
    const result = await installArchive(ARCHIVE, directory, {
      kind: 'roslyn',
      packageVersion: ROSLYN_PINNED_VERSION,
      rid: 'win-x64',
      filter: (entry) => entry.name.startsWith(prefix),
      strip: 3,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });
    return { root, directory, result };
  }

  it('extrae sólo lo pedido y anota cada archivo con su tamaño y su hash', async () => {
    const { root, directory, result } = await install();
    try {
      assert.equal(result.files, 2, 'la entrada de lib/ no entra en el filtro');

      const manifest = await readInstallManifest(directory);
      assert.equal(manifest.packageVersion, ROSLYN_PINNED_VERSION);
      assert.deepEqual(
        manifest.files.map((file) => file.path),
        ['lib/helper.dll', 'server.dll'],
      );
      assert.equal(manifest.files.find((file) => file.path === 'server.dll').size, 6396176);
      assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('una instalación intacta se verifica en verde', async () => {
    const { root, directory } = await install();
    try {
      const check = await verifyInstall(directory);
      assert.equal(check.verified, true);
      assert.deepEqual(check.problems, []);
      assert.equal(describeProblems(check.problems), 'instalación íntegra');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caza el DLL truncado que dejó el IntelliSense muerto durante nueve versiones', async () => {
    const { root, directory } = await install();
    try {
      // Exactamente lo que había en el disco: 5 MiB clavados donde debía haber 6.396.176 bytes.
      const victima = join(directory, 'server.dll');
      await truncate(victima, 5242880);
      assert.equal((await stat(victima)).size, 5242880);

      const check = await verifyInstall(directory);
      assert.equal(check.verified, true);
      assert.equal(check.problems.length, 1);
      assert.equal(check.problems[0].kind, 'size');
      assert.equal(check.problems[0].path, 'server.dll');
      assert.match(describeProblems(check.problems), /5242880/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caza un archivo con el tamaño bueno y el contenido malo, pero sólo en profundidad', async () => {
    const { root, directory } = await install();
    try {
      await writeFile(join(directory, 'lib/helper.dll'), Buffer.from('AYUDANTE'));

      const superficial = await verifyInstall(directory);
      assert.deepEqual(superficial.problems, [], 'mismo tamaño: el stat no puede verlo');

      const profunda = await verifyInstall(directory, { deep: true });
      assert.equal(profunda.problems.length, 1);
      assert.equal(profunda.problems[0].kind, 'hash');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caza un archivo que ya no está', async () => {
    const { root, directory } = await install();
    try {
      await rm(join(directory, 'server.dll'));
      const check = await verifyInstall(directory);
      assert.equal(check.problems[0].kind, 'missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('una instalación sin manifiesto no está mal: está sin verificar, y se reinstala', async () => {
    const { root, directory } = await install();
    try {
      await rm(join(directory, MANIFEST_FILE));
      const check = await verifyInstall(directory);
      assert.equal(check.verified, false, 'las cachés de la v1.9 caen por aquí');
      assert.deepEqual(check.problems, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('los archivos de más no son un problema', async () => {
    const { root, directory } = await install();
    try {
      // El servidor escribe registros y cachés de composición dentro de su propio directorio.
      await writeFile(join(directory, 'mef-composition.cache'), 'basura');
      assert.deepEqual((await verifyInstall(directory)).problems, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('el manifiesto sobrevive a la ida y vuelta por JSON', async () => {
    const { root, directory } = await install();
    try {
      const text = await readFile(join(directory, MANIFEST_FILE), 'utf8');
      const parsed = parseManifest(text);
      assert.equal(parsed.files.length, 2);
      assert.equal(parseManifest('{"version":2}'), null, 'una versión desconocida es null, no una suposición');
      assert.equal(parseManifest('no es json'), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('diffInstall no inventa problemas cuando lo observado coincide', () => {
    const manifest = buildManifest({
      kind: 'roslyn',
      packageVersion: '1.0.0',
      rid: 'win-x64',
      sourceSha256: 'abc',
      installedAtUtc: '2026-08-24T10:00:00.000Z',
      files: [{ path: 'a.dll', size: 10, sha256: 'hash-a' }],
    });
    assert.deepEqual(diffInstall(manifest, new Map([['a.dll', { size: 10, sha256: 'hash-a' }]])), []);
  });

  it('el extractor se niega a escribir un archivo que no mide lo que declara el ZIP', async () => {
    // Un ZIP cuyo directorio central declara 100 bytes para una entrada que descomprime a 8.
    const corrupto = corruptDeclaredSize(makeZip([['x.dll', Buffer.from('ochoocho')]]), 100);

    const root = await mkdtemp(join(tmpdir(), 'dotforge-zip-'));
    try {
      await assert.rejects(
        () => installArchive(corrupto, join(root, 'out'), { kind: 'x', packageVersion: '1', rid: 'win-x64' }),
        (error) => error instanceof ZipError && /declara 100/.test(error.message),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Lo que el cliente contesta al servidor
// ---------------------------------------------------------------------------------------------

/**
 * Peticiones que Roslyn 4.14 lanza **hacia** el editor mientras carga la solución, capturadas del
 * tráfico real.
 *
 * `workspace/configuration` llega con treinta y tantas secciones. Contestarla con `null` —que era
 * lo que hacía DotForge con toda petición del servidor— hace que Roslyn lance
 * `InvalidOperationException: Unexpected null` dentro de su cola de mensajes, escriba
 * "Error processing queue, shutting down" y **se apague con código 0**, sin una sola línea en
 * stderr y después de haber anunciado que estaba listo. Con una entrada por sección, la solución
 * carga sus cinco proyectos y `semanticTokens` empieza a devolver datos.
 */
const CONFIGURATION_REQUEST = {
  items: [
    { section: 'csharp|symbol_search.dotnet_search_reference_assemblies' },
    { section: 'visual_basic|symbol_search.dotnet_search_reference_assemblies' },
    { section: 'csharp|type_members.dotnet_member_insertion_location' },
    { section: 'csharp|completion.dotnet_show_name_completion_suggestions' },
  ],
};

describe('respuestas del cliente a las peticiones del servidor', () => {
  it('devuelve una entrada por sección pedida', () => {
    const result = serverRequestResponse('workspace/configuration', CONFIGURATION_REQUEST);
    assert.ok(Array.isArray(result), 'un null aquí apaga el servidor');
    assert.equal(result.length, CONFIGURATION_REQUEST.items.length);
    assert.deepEqual(result, [null, null, null, null], 'null por valor significa "usa tu opción por defecto"');
  });

  it('el tamaño es lo que importa: el servidor empareja secciones y respuestas por posición', () => {
    assert.equal(configurationResponse({ items: [] }).length, 0);
    assert.equal(configurationResponse({ items: [{ section: 'a' }] }).length, 1);
  });

  it('no revienta con parámetros raros', () => {
    assert.deepEqual(configurationResponse(null), []);
    assert.deepEqual(configurationResponse({}), []);
    assert.deepEqual(configurationResponse({ items: 'no es un array' }), []);
  });

  it('el resto de peticiones se siguen contestando con null, que es su respuesta correcta', () => {
    assert.equal(serverRequestResponse('client/registerCapability', { registrations: [] }), null);
    assert.equal(serverRequestResponse('window/workDoneProgress/create', { token: 1 }), null);
    assert.equal(serverRequestResponse('workspace/_roslyn_projectNeedsRestore', {}), null);
  });
});

// ---------------------------------------------------------------------------------------------
// Contrato del ADR-040: la versión no se resuelve al vuelo
// ---------------------------------------------------------------------------------------------

/**
 * Lo que el ADR-040 exige, comprobado como contrato y no como intención.
 *
 * El feed publica 763 compilaciones y ninguna es estable en SemVer, así que "la más alta" es la de
 * anoche de la rama principal. La política tiene que apoyarse en una **constante literal** que
 * alguien ha arrancado a mano; en cuanto eso se convierta en un cálculo, el ADR-040 se ha perdido
 * aunque el código siga pareciendo correcto.
 */
describe('contrato del ADR-040: versión fijada y determinista', () => {
  const fuente = readFileSync(join(RAIZ, 'src', 'shared', 'lsp-versions.ts'), 'utf8');

  it('la versión fijada es una constante literal, no algo que se calcule', () => {
    // Una versión concreta, escrita con todos sus dígitos, dentro de la lista de verificadas.
    assert.match(
      fuente,
      /export const ROSLYN_VERIFIED_VERSIONS: readonly string\[\] = \[\s*'\d+\.\d+\.\d+-[0-9A-Za-z.\-]+'/,
      'la lista de versiones verificadas ya no empieza por una versión literal',
    );
    assert.match(
      fuente,
      /export const ROSLYN_PINNED_VERSION: string = ROSLYN_VERIFIED_VERSIONS\[0\]!/,
      'la fijada tiene que ser la primera verificada, no otra cosa',
    );
  });

  it('la fijada tiene forma de versión completa del feed', () => {
    assert.match(ROSLYN_PINNED_VERSION, /^\d+\.\d+\.\d+-\d+\.\d+\.\d+$/);
    assert.equal(isUnstableVersion(ROSLYN_PINNED_VERSION), false, 'la fijada no puede ser una compilación de prueba');
  });

  it('no se elige por fecha ni por "la más alta" cuando la fijada está disponible', () => {
    // El índice trae versiones más altas que la fijada, a propósito: si el selector las prefiriera,
    // esto se pondría en rojo.
    assert.ok(
      FEED_INDEX.some((version) => compareRoslynVersions(version, ROSLYN_PINNED_VERSION) > 0),
      'el índice de prueba tiene que contener versiones más altas que la fijada',
    );
    assert.equal(selectRoslynVersion(FEED_INDEX).version, ROSLYN_PINNED_VERSION);
  });

  it('el orden del feed no cambia lo que se elige', () => {
    for (const orden of [FEED_INDEX, [...FEED_INDEX].reverse(), [...FEED_INDEX].sort()]) {
      assert.equal(selectRoslynVersion(orden).version, ROSLYN_PINNED_VERSION);
    }
  });

  it('la selección es determinista: mismo feed, misma respuesta', () => {
    const primera = selectRoslynVersion(FEED_INDEX);
    const segunda = selectRoslynVersion(FEED_INDEX);
    assert.deepEqual(primera, segunda);
  });

  /**
   * La instalación se verifica archivo a archivo contra el manifiesto (ADR-041), y el manifiesto
   * anota la versión del paquete. Comprobar que **esa** es la que se pidió es lo que separa
   * "verificada" de "descargada".
   */
  it('el manifiesto de la instalación anota la versión exacta que se pidió', () => {
    const manifest = buildManifest({
      kind: 'roslyn',
      packageVersion: ROSLYN_PINNED_VERSION,
      rid: 'win-x64',
      sourceSha256: 'abc',
      installedAtUtc: '2026-08-27T10:00:00.000Z',
      files: [],
    });
    assert.equal(manifest.packageVersion, ROSLYN_PINNED_VERSION);
  });
});

/**
 * El estado degradado tiene que decir **cuál** de sus causas se ha dado.
 *
 * Antes no lo decía: con la fijada vetada en el equipo, la barra de estado anunciaba "la fijada ya
 * no está en el feed". Es falso —seguía publicada— y manda a mirar al feed de Azure cuando el
 * problema está en un archivo de `userData`. Costó una sesión entera de diagnóstico.
 */
describe('por qué no se está usando la versión fijada', () => {
  it('vetada en este equipo: se dice que falló aquí, no que desapareció', () => {
    const selection = selectRoslynVersion(FEED_INDEX, { blocked: [ROSLYN_PINNED_VERSION] });

    assert.equal(selection.reason, 'quarantined');
    const frase = describeSelection(selection);
    assert.match(frase, /falló en este equipo/);
    assert.doesNotMatch(frase, /ya no está en el feed/, 'sigue en el feed: decir lo contrario es mentir');
  });

  it('ausente del feed: entonces sí es lo que dice', () => {
    const sinFijada = FEED_INDEX.filter((version) => version !== ROSLYN_PINNED_VERSION);
    const selection = selectRoslynVersion(sinFijada);

    assert.equal(selection.reason, 'stable');
    assert.match(describeSelection(selection), /ya no está en el feed/);
  });

  it('vetada y además ausente: se prefiere decir que no está, que es lo accionable', () => {
    // Si no está publicada, levantar el veto no serviría de nada: no hay nada que instalar.
    const sinFijada = FEED_INDEX.filter((version) => version !== ROSLYN_PINNED_VERSION);
    const selection = selectRoslynVersion(sinFijada, { blocked: [ROSLYN_PINNED_VERSION] });
    assert.equal(selection.reason, 'stable');
  });

  it('cada motivo tiene su frase, y ninguna se queda sin traducir', () => {
    for (const reason of ['pinned', 'verified', 'stable', 'fallback', 'quarantined']) {
      const frase = describeSelection({ version: '1.2.3-4.5.6', reason });
      assert.ok(frase.includes('1.2.3-4.5.6'), reason);
      assert.ok(frase.length > 20, `${reason}: la frase no explica nada`);
    }
  });
});

/**
 * Un veto de cuarentena caduca al actualizar el IDE (ADR-063).
 *
 * De los fallos de arranque de Roslyn documentados en este proyecto, **dos han resultado ser bugs
 * del cliente**: contestar `null` a `workspace/configuration` (ADR-043) y mandar `shutdown` con
 * `params: null`. Un veto dictado por una versión del IDE que ya no existe es un juicio sobre
 * código que ya no se ejecuta, y mantenerlo deja al usuario con una versión elegida sola para
 * siempre — que es justo lo que el ADR-040 quería evitar.
 */
describe('los vetos de cuarentena caducan con la versión del IDE', () => {
  const vetada = {
    version: '4.14.0-3.26423.7',
    rid: 'win-x64',
    reason: 'se cerró solo con código 0',
    atUtc: '2026-08-25T10:00:59.292Z',
    ideVersion: '2.5.0',
  };

  const record = addQuarantineEntry({ version: 1, entries: [] }, vetada);

  it('la misma versión del IDE sigue respetando su propio veto', () => {
    assert.deepEqual(quarantinedVersions(record, 'win-x64', '2.5.0'), ['4.14.0-3.26423.7']);
  });

  it('otra versión del IDE no lo respeta: se vuelve a probar', () => {
    assert.deepEqual(quarantinedVersions(record, 'win-x64', '2.6.0'), []);
  });

  it('una entrada sin versión del IDE es de antes de que esto existiera, y se reintenta', () => {
    const antiguo = addQuarantineEntry({ version: 1, entries: [] }, { ...vetada, ideVersion: undefined });
    assert.deepEqual(quarantinedVersions(antiguo, 'win-x64', '2.6.0'), []);
    // Sin pedir versión se sigue listando entera: es lo que quiere quien sólo enumera lo que hay.
    assert.deepEqual(quarantinedVersions(antiguo, 'win-x64'), ['4.14.0-3.26423.7']);
  });

  it('los vetos caducados se pueden enumerar para poder decirlo', () => {
    const caducados = staleQuarantineEntries(record, 'win-x64', '2.6.0');
    assert.equal(caducados.length, 1);
    assert.equal(caducados[0].ideVersion, '2.5.0');
    assert.deepEqual(staleQuarantineEntries(record, 'win-x64', '2.5.0'), []);
  });

  it('el veto caducado sigue escrito: caduca, no se borra', () => {
    // Borrarlo perdería el historial de qué falló y cuándo, que es lo único que queda si vuelve
    // a fallar. Lo que cambia es si bloquea, no si existe.
    assert.equal(record.entries.length, 1);
    assert.deepEqual(quarantinedVersions(record, 'win-x64'), ['4.14.0-3.26423.7']);
  });

  it('sobrevive a la ida y vuelta por el archivo', () => {
    const releido = parseQuarantine(serializeQuarantine(record));
    assert.equal(releido.entries[0].ideVersion, '2.5.0');
    assert.deepEqual(quarantinedVersions(releido, 'win-x64', '2.6.0'), []);
  });

  it('una entrada con una versión de IDE que no es una cadena se descarta entera', () => {
    const roto = parseQuarantine(JSON.stringify({ version: 1, entries: [{ ...vetada, ideVersion: 42 }] }));
    assert.deepEqual(roto.entries, []);
  });
});

/**
 * `shutdown` no lleva parámetros, y mandar `null` no es lo mismo que omitirlos.
 *
 * StreamJsonRpc —que es lo que usa Roslyn— cuenta los argumentos de la petición al deserializarla y
 * ante un `null` levanta `InvalidOperationException: Unexpected value kind: Null` **fuera de
 * cualquier try**: el servidor muere con excepción no controlada (0xE0434352). Se comprobó
 * lanzando el servidor real: con `params: null` muere; omitiéndolo, aguanta y contesta.
 */
describe('el cliente no manda params nulos por el cable', () => {
  const cliente = readFileSync(join(RAIZ, 'src', 'main', 'lsp', 'lsp-client.ts'), 'utf8');

  it('los mensajes se componen omitiendo params cuando no hay', () => {
    assert.match(cliente, /\.\.\.paramsField\(params\)/);
    assert.match(cliente, /params === null \|\| params === undefined \? \{\} : \{ params \}/);
  });

  it('ningún mensaje se escribe con params puesto a pelo', () => {
    // `{ jsonrpc: '2.0', id, method, params }` es exactamente lo que mataba al servidor.
    assert.doesNotMatch(cliente, /jsonrpc: '2\.0'[^}]*,\s*params\s*[},]/, 'hay un mensaje con params sin filtrar');
  });
});
