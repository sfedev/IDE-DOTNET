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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

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
  verifyInstall,
  ZipError,
} from '../../build/toolchain.mjs';

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
    assert.equal(selection.reason, 'stable');
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

/** Construye un ZIP mínimo en memoria: es más honesto que fingir el extractor. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, contents] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = deflateRawSync(contents);
    const crc = 0; // El extractor no lo comprueba; lo que se prueba aquí son los tamaños.

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(contents.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, body);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

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
    const corrupto = makeZip([['x.dll', Buffer.from('ochoocho')]]);
    corrupto.writeUInt32LE(100, corrupto.indexOf(Buffer.from('PK\u0001\u0002', 'latin1')) + 24);

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
