/**
 * Pruebas de que instalar no bloquea el bucle de eventos.
 *
 * El síntoma era de usuario, no de registro: instalar una extensión de Open VSX daba tirones
 * severos y ratos de ventana congelada. La causa no era la red ni el disco —los dos ya eran
 * asíncronos— sino las dos operaciones de CPU que había en medio: `inflateRawSync` por cada archivo
 * del paquete y `createHash().update(buffer)` por cada archivo extraído **y** por el paquete
 * entero. Las dos hacen su trabajo en C++, sí, pero en el hilo principal de Electron, que es el
 * mismo que repinta la ventana y atiende el IPC del renderer.
 *
 * **Cómo se mide, y por qué no con un cronómetro.** La primera versión de estas pruebas miraba el
 * hueco más largo entre disparos de un temporizador y exigía que fuera corto. Fallaron, y por un
 * motivo instructivo: esta máquina hashea 96 MB en 17 ms —los procesadores actuales traen SHA-NI—,
 * así que ni siquiera el camino síncrono llegaba al umbral. Una prueba calibrada contra la
 * velocidad del procesador de quien la escribe no vale para la máquina de al lado.
 *
 * Lo que se mide en su lugar es **cuántas vueltas da el bucle de eventos** mientras dura la
 * operación, que es la propiedad de verdad y no depende de la CPU: el camino síncrono da cero
 * —nadie puede repintar ni atender IPC hasta que termine—, y el asíncrono da una vuelta por bloque
 * hasheado y por archivo descomprimido.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractTo,
  installArchive,
  listEntries,
  readEntry,
  readEntryAsync,
  sha256,
  sha256Async,
  verifyInstall,
} from '../../build/toolchain.mjs';
import { makeZip } from './zip-fixture.mjs';

/** Tamaño de bloque de `sha256Async`. Tiene que coincidir con el de `zip.ts`. */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

/** Cinco bloques y pico: suficiente para que se note la diferencia sin tardar en la suite. */
const PAYLOAD_BYTES = 5 * HASH_CHUNK_BYTES + 1024;
const PAYLOAD_CHUNKS = Math.ceil(PAYLOAD_BYTES / HASH_CHUNK_BYTES);

/**
 * Cuenta las vueltas que da el bucle de eventos mientras corre `work`.
 *
 * Un `setImmediate` que se vuelve a programar corre una vez por vuelta del bucle, en la fase de
 * *check*. Mientras el hilo principal esté ocupado en una llamada síncrona no corre ninguna, así
 * que el contador es exactamente "cuántas oportunidades ha tenido la ventana de repintarse".
 */
async function loopTurns(work) {
  let turns = 0;
  let running = true;

  const tick = () => {
    if (!running) return;
    turns++;
    setImmediate(tick);
  };

  setImmediate(tick);
  // Un respiro para que el contador esté ya en marcha antes de empezar a medir.
  await new Promise((resolve) => setImmediate(resolve));
  turns = 0;

  try {
    await work();
  } finally {
    running = false;
  }

  return turns;
}

describe('hashear no bloquea el hilo principal', () => {
  const payload = Buffer.alloc(PAYLOAD_BYTES, 0x5a);

  it('sha256Async da el mismo resultado que sha256', async () => {
    const small = Buffer.from('DotForge IDE', 'utf8');
    assert.equal(await sha256Async(small), sha256(small));
    assert.equal(await sha256Async(Buffer.alloc(0)), sha256(Buffer.alloc(0)));
    // Justo por encima del tamaño de bloque, que es donde se parte el bucle interno.
    const overOneChunk = Buffer.alloc(HASH_CHUNK_BYTES + 7, 0x11);
    assert.equal(await sha256Async(overOneChunk), sha256(overOneChunk));
  });

  it('sha256Async cede el bucle una vez por bloque', async () => {
    const turns = await loopTurns(() => sha256Async(payload));
    assert.ok(turns >= PAYLOAD_CHUNKS - 1, `sólo ${turns} vueltas del bucle para ${PAYLOAD_CHUNKS} bloques`);
  });

  it('control: la versión síncrona no cede ninguna (si no, la medición no vale)', async () => {
    const turns = await loopTurns(async () => {
      sha256(payload);
    });
    assert.equal(turns, 0, 'el camino síncrono ha cedido el bucle: la medición no distingue nada');
  });
});

describe('descomprimir no bloquea el hilo principal', () => {
  /** Ocho archivos, que es el orden de magnitud de un `.vsix` de un tema con sus iconos. */
  const FILES = Array.from({ length: 8 }, (_, index) => [`ext/file-${index}.bin`, Buffer.alloc(512 * 1024, index)]);
  const archive = makeZip(FILES);
  const [entry] = listEntries(archive);

  it('readEntryAsync devuelve lo mismo que readEntry', async () => {
    assert.equal(entry.name, 'ext/file-0.bin');
    assert.deepEqual(await readEntryAsync(archive, entry), readEntry(archive, entry));
  });

  it('extractTo cede el bucle al menos una vez por archivo', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dotforge-extract-'));
    try {
      const turns = await loopTurns(() => extractTo(archive, directory));
      assert.ok(turns >= FILES.length, `sólo ${turns} vueltas del bucle para ${FILES.length} archivos`);

      const written = await readFile(join(directory, 'ext', 'file-3.bin'));
      assert.equal(written.length, 512 * 1024);
      assert.equal(written[0], 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('control: descomprimir en síncrono no cede ninguna', async () => {
    const turns = await loopTurns(async () => {
      for (const candidate of listEntries(archive)) readEntry(archive, candidate);
    });
    assert.equal(turns, 0, 'el camino síncrono ha cedido el bucle: la medición no distingue nada');
  });
});

describe('la instalación sigue siendo verificable', () => {
  /**
   * Lo que no puede cambiar al mover el trabajo fuera del hilo principal: el manifiesto tiene que
   * anotar exactamente los mismos tamaños y hashes que antes, porque de eso depende que una copia
   * corrupta se detecte (ADR-041).
   */
  it('el manifiesto anota el mismo hash que el cálculo síncrono', async () => {
    const contents = {
      'extension/package.json': Buffer.from('{"name":"demo"}', 'utf8'),
      'extension/themes/dark.json': Buffer.alloc(5_000_000, 7),
    };

    const zip = makeZip(Object.entries(contents));
    const directory = await mkdtemp(join(tmpdir(), 'dotforge-install-'));

    try {
      const result = await installArchive(zip, directory, {
        kind: 'extension:demo.demo',
        packageVersion: '1.0.0',
        rid: 'any',
        strip: 1,
        now: () => new Date('2026-08-24T00:00:00.000Z'),
      });

      assert.equal(result.files, 2);
      assert.equal(result.manifest.sourceSha256, sha256(zip));

      for (const [name, body] of Object.entries(contents)) {
        const relative = name.slice('extension/'.length);
        const file = result.manifest.files.find((candidate) => candidate.path === relative);
        assert.ok(file, `falta ${relative} en el manifiesto`);
        assert.equal(file.size, body.length);
        assert.equal(file.sha256, sha256(body));
      }

      const verification = await verifyInstall(directory, { deep: true });
      assert.equal(verification.verified, true);
      assert.deepEqual(verification.problems, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('un directorio sin manifiesto no está verificado, y no revienta', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dotforge-empty-'));
    try {
      const verification = await verifyInstall(directory);
      assert.equal(verification.verified, false);
      assert.equal(verification.manifest, null);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
