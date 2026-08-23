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
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

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

/** Descomprime una entrada concreta. */
export function readEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  // La cabecera local sí hace falta para saber dónde empiezan los datos.
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

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
 * Extrae el ZIP a un directorio.
 *
 * Protege contra zip-slip: una entrada llamada `../../evil.exe` escribiría fuera del destino.
 *
 * @param strip  número de segmentos iniciales de ruta a descartar (como `tar --strip-components`).
 * @param filter opcional; devuelve false para saltarse una entrada.
 */
export async function extractTo(
  buffer: Buffer,
  destination: string,
  options: { strip?: number; filter?: (entry: ZipEntry) => boolean } = {},
): Promise<number> {
  const { strip = 0, filter } = options;
  const entries = listEntries(buffer);
  let written = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (filter && !filter(entry)) continue;

    const segments = entry.name.split('/').slice(strip);
    if (segments.length === 0) continue;

    const relativePath = normalize(segments.join(sep));
    if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
      throw new ZipError(`entrada con ruta insegura (zip-slip): "${entry.name}"`);
    }

    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, readEntry(buffer, entry));
    written++;
  }

  return written;
}

/** SHA-256 en hexadecimal, para verificar la integridad de lo descargado. */
export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
