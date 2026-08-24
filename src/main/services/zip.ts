/**
 * Lector de archivos ZIP en Node puro.
 *
 * Existe para no añadir una dependencia nativa ni depender de `Expand-Archive`/`unzip`, que no
 * están garantizados en todas las máquinas. Los `.nupkg` y las releases de OmniSharp y NetCoreDbg
 * son ZIP, así que con esto se cubre todo el toolchain.
 *
 * Se leen la cabecera EOCD y el directorio central (no las cabeceras locales, cuyos tamaños
 * pueden venir a cero cuando el ZIP se escribió en streaming). Soporta los métodos 0 (stored) y
 * 8 (deflate), que son los únicos que usan estos artefactos.
 *
 * **Nada de esto puede bloquear el bucle de eventos.** `zlib` y `crypto` ofrecen las dos versiones
 * de cada operación y la síncrona es la cómoda de escribir: `inflateRawSync` y `createHash().update()`
 * hacen su trabajo en C++, sí, pero **en el hilo principal**. Instalar un `.vsix` de 30 MB son
 * cientos de inflados y cientos de hashes seguidos sin una sola cesión del bucle, y eso en Electron
 * no es "un poco lento": es la ventana sin repintar, el renderer sin recibir IPC y el usuario
 * pensando que la aplicación se ha colgado. Las variantes asíncronas van al pool de libuv, así que
 * cada `await` es además un respiro para el bucle. Ver ADR-051.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { inflateRaw, inflateRawSync } from 'node:zlib';

const inflateRawAsync = promisify(inflateRaw);

/**
 * Tamaño de bloque para hashear sin bloquear.
 *
 * 4 MiB es un compromiso medido: bastante grande para que el coste por bloque sea despreciable y
 * bastante pequeño para que ningún bloque pase de unos pocos milisegundos, que es lo que hace falta
 * para que el bucle de eventos no se note parado.
 */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

export interface ZipEntry {
  /** Ruta dentro del archivo, siempre con separador POSIX. */
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // El EOCD mide 22 bytes más un comentario de hasta 64 KB: se busca desde el final.
  const maxScan = Math.min(buffer.length, 0xffff + 22);
  for (let offset = buffer.length - 22; offset >= buffer.length - maxScan && offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError('no se encuentra la cabecera EOCD: el archivo no es un ZIP válido');
}

interface CentralDirectoryLocation {
  offset: number;
  entries: number;
}

function locateCentralDirectory(buffer: Buffer): CentralDirectoryLocation {
  const eocd = findEndOfCentralDirectory(buffer);
  let entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  // Marcadores de ZIP64: los .nupkg grandes y las releases con muchos archivos los usan.
  if (entries === 0xffff || offset === 0xffffffff) {
    const locatorOffset = eocd - 20;
    if (locatorOffset >= 0 && buffer.readUInt32LE(locatorOffset) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
      const zip64Offset = Number(buffer.readBigUInt64LE(locatorOffset + 8));
      if (buffer.readUInt32LE(zip64Offset) !== ZIP64_EOCD_SIGNATURE) {
        throw new ZipError('cabecera ZIP64 EOCD corrupta');
      }
      entries = Number(buffer.readBigUInt64LE(zip64Offset + 32));
      offset = Number(buffer.readBigUInt64LE(zip64Offset + 48));
    }
  }

  return { offset, entries };
}

/** Lee el directorio central y devuelve la lista de entradas. */
export function listEntries(buffer: Buffer): ZipEntry[] {
  const { offset, entries } = locateCentralDirectory(buffer);
  const result: ZipEntry[] = [];

  let cursor = offset;
  for (let i = 0; i < entries; i++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`entrada ${i} del directorio central con firma inesperada`);
    }

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    let compressedSize = buffer.readUInt32LE(cursor + 20);
    let uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    let localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    // Campo extra ZIP64 (id 0x0001): sustituye los valores marcados con 0xFFFFFFFF.
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      let extraCursor = cursor + 46 + nameLength;
      const extraEnd = extraCursor + extraLength;
      while (extraCursor + 4 <= extraEnd) {
        const headerId = buffer.readUInt16LE(extraCursor);
        const dataSize = buffer.readUInt16LE(extraCursor + 2);
        let field = extraCursor + 4;
        if (headerId === 0x0001) {
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buffer.readBigUInt64LE(field));
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buffer.readBigUInt64LE(field));
            field += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(buffer.readBigUInt64LE(field));
          }
          break;
        }
        extraCursor += 4 + dataSize;
      }
    }

    result.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return result;
}

/** Datos comprimidos de una entrada, localizados a través de su cabecera local. */
function rawDataOf(buffer: Buffer, entry: ZipEntry): Buffer {
  // La cabecera local sí hace falta para saber dónde empiezan los datos.
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  return buffer.subarray(start, start + entry.compressedSize);
}

/**
 * Descomprime una entrada concreta, **sin bloquear el bucle de eventos**.
 *
 * Es la que usa la extracción: `inflateRaw` va al pool de libuv, así que el hilo principal sigue
 * atendiendo IPC y repintando mientras se descomprime cada archivo.
 */
export async function readEntryAsync(buffer: Buffer, entry: ZipEntry): Promise<Buffer> {
  const raw = rawDataOf(buffer, entry);

  switch (entry.compressionMethod) {
    case 0:
      return Buffer.from(raw);
    case 8:
      return inflateRawAsync(raw);
    default:
      throw new ZipError(`método de compresión no soportado (${entry.compressionMethod}) en "${entry.name}"`);
  }
}

/**
 * Variante síncrona, para leer **una** entrada suelta y pequeña.
 *
 * Sirve para mirar dentro de un paquete sin extraerlo (el `extension.vsixmanifest` de un `.vsix`
 * son unos kilobytes). No debe usarse en bucle sobre un paquete entero: para eso está
 * `readEntryAsync`, y hay una prueba de seguridad que vigila que la extracción no vuelva aquí.
 */
export function readEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const raw = rawDataOf(buffer, entry);

  switch (entry.compressionMethod) {
    case 0:
      return Buffer.from(raw);
    case 8:
      return inflateRawSync(raw);
    default:
      throw new ZipError(`método de compresión no soportado (${entry.compressionMethod}) en "${entry.name}"`);
  }
}

/**
 * Restos del empaquetado en macOS, que no son contenido del paquete.
 *
 * El Finder guarda las bifurcaciones de recurso en un árbol `__MACOSX/` paralelo, con un `._nombre`
 * por cada archivo real. Nunca aportan nada, y combinados con `strip` hacen daño de verdad: en el
 * ZIP de NetCoreDbg para macOS, `__MACOSX/netcoredbg/._netcoredbg` se queda en
 * `netcoredbg/._netcoredbg`, es decir, **crea una carpeta que se llama igual que el ejecutable**.
 * Esa entrada va antes en el directorio central, así que cuando toca escribir el binario el nombre
 * ya lo ocupa un directorio y `writeFile` muere con `EISDIR`. Por eso el depurador no se ha podido
 * instalar nunca en macOS, con un mensaje que no menciona ni a macOS ni al ZIP.
 */
function isMacPackagingArtifact(name: string): boolean {
  const segments = name.split('/');
  if (segments.includes('__MACOSX')) return true;

  const base = segments[segments.length - 1] ?? '';
  return base.startsWith('._') || base === '.DS_Store';
}

/**
 * Extrae el ZIP a un directorio.
 *
 * Protege contra zip-slip: una entrada llamada `../../evil.exe` escribiría fuera del destino.
 *
 * @param strip  número de segmentos iniciales de ruta a descartar (como `tar --strip-components`).
 * @param filter opcional; devuelve false para saltarse una entrada.
 * @param onFile opcional; recibe cada archivo escrito **con su contenido ya descomprimido**. Es lo
 *               que permite anotar tamaño y hash de cada uno en el manifiesto de la instalación sin
 *               volver a leer del disco los 250 MB que se acaban de escribir. Puede ser asíncrono:
 *               se espera antes de seguir, para que quien anota el manifiesto pueda hashear sin
 *               bloquear.
 */
export async function extractTo(
  buffer: Buffer,
  destination: string,
  options: {
    strip?: number;
    filter?: (entry: ZipEntry) => boolean;
    onFile?: (relativePath: string, contents: Buffer) => void | Promise<void>;
  } = {},
): Promise<number> {
  const { strip = 0, filter, onFile } = options;
  const entries = listEntries(buffer);
  let written = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    // Antes que el filtro de quien llama: esto no es una preferencia del paquete, es basura del
    // empaquetado, y nadie debería tener que acordarse de descartarla.
    if (isMacPackagingArtifact(entry.name)) continue;
    if (filter && !filter(entry)) continue;

    const segments = entry.name.split('/').slice(strip);
    if (segments.length === 0) continue;

    const relativePath = normalize(segments.join(sep));
    if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
      throw new ZipError(`entrada con ruta insegura (zip-slip): "${entry.name}"`);
    }

    const target = join(destination, relativePath);
    const contents = await readEntryAsync(buffer, entry);

    // El ZIP declara el tamaño descomprimido en el directorio central. Si lo que sale del inflate
    // no mide eso, el archivo está corrupto y escribirlo sólo sirve para que el fallo aparezca
    // mucho más tarde y en otro sitio.
    if (entry.compressedSize > 0 && contents.length !== entry.uncompressedSize) {
      throw new ZipError(
        `"${entry.name}" se ha descomprimido a ${contents.length} bytes y el archivo declara ${entry.uncompressedSize}`,
      );
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    await onFile?.(segments.join('/'), contents);
    written++;
  }

  return written;
}

/**
 * SHA-256 en hexadecimal, para verificar la integridad de lo descargado.
 *
 * Síncrona a propósito: la usan las pruebas y los caminos que hashean unos pocos kilobytes. Para
 * un archivo grande —y el `.nupkg` del servidor de Roslyn son 250 MB— está `sha256Async`.
 */
export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * SHA-256 troceado, cediendo el bucle de eventos entre bloques.
 *
 * `hash.update(buffer)` sobre 250 MB es medio segundo de hilo principal parado en una sola
 * llamada. Trocearlo cuesta lo mismo en total y no se nota: entre bloque y bloque el bucle atiende
 * el IPC, el repintado y los temporizadores.
 */
export async function sha256Async(buffer: Buffer): Promise<string> {
  const hash = createHash('sha256');

  for (let offset = 0; offset < buffer.length; offset += HASH_CHUNK_BYTES) {
    hash.update(buffer.subarray(offset, Math.min(offset + HASH_CHUNK_BYTES, buffer.length)));
    // Una cesión de verdad al bucle: `setImmediate` corre después de la fase de I/O, así que lo
    // que estuviera esperando (una respuesta IPC, un repintado) llega a ejecutarse.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return hash.digest('hex');
}
