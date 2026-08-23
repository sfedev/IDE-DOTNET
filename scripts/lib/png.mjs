/**
 * Codificador PNG mínimo en Node puro (RGBA de 8 bits, sin filtros).
 *
 * Se escribe a mano para no añadir una dependencia de imagen sólo para generar los iconos de la
 * aplicación. Un PNG es: firma + IHDR + IDAT (zlib de las líneas con byte de filtro) + IEND.
 */
import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Tabla CRC-32 de PNG, calculada una sola vez. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Codifica un buffer RGBA (width * height * 4) como PNG.
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // profundidad de bits
  ihdr.writeUInt8(6, 9); // color type 6 = RGBA
  ihdr.writeUInt8(0, 10); // compresión deflate
  ihdr.writeUInt8(0, 11); // filtro adaptativo
  ihdr.writeUInt8(0, 12); // sin entrelazado

  // Cada línea va precedida de un byte de filtro; 0 = None, suficiente para iconos pequeños.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Empaqueta varios PNG en un archivo .ico.
 * Windows Vista en adelante admite PNG embebido, que es lo que permite incluir un icono de 256px
 * sin que el archivo pese megas.
 *
 * @param {Array<{ size: number, png: Buffer }>} images
 */
export function encodeIco(images) {
  const sorted = [...images].sort((a, b) => a.size - b.size);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo 1 = icono
  header.writeUInt16LE(sorted.length, 4);

  const directory = Buffer.alloc(16 * sorted.length);
  let offset = header.length + directory.length;

  sorted.forEach((image, index) => {
    const entry = index * 16;
    // 256 se codifica como 0 en el campo de un byte.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 0);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // colores de la paleta
    directory.writeUInt8(0, entry + 3); // reservado
    directory.writeUInt16LE(1, entry + 4); // planos
    directory.writeUInt16LE(32, entry + 6); // bits por píxel
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...sorted.map((image) => image.png)]);
}

/**
 * Empaqueta varios PNG en un archivo .icns de macOS.
 *
 * Cada entrada es: OSType (4 bytes) + longitud total incluida la cabecera (4 bytes big-endian) +
 * datos. Los OSType `ic07`..`ic14` admiten PNG directamente.
 *
 * @param {Map<string, Buffer>} entries  OSType -> PNG
 */
export function encodeIcns(entries) {
  const chunks = [];

  for (const [osType, png] of entries) {
    const header = Buffer.alloc(8);
    header.write(osType, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, png);
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);

  return Buffer.concat([header, body]);
}
