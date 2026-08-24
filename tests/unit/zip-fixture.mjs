/**
 * Constructor de ZIP en memoria para las pruebas del toolchain.
 *
 * No es un archivo `*.test.mjs`, así que el runner no lo ejecuta: sólo se importa.
 *
 * Se construye el ZIP a mano —cabecera local, directorio central y EOCD— en vez de fingir el
 * extractor, porque lo que hay que probar es justamente el camino real: que el tamaño declarado en
 * el directorio central se compara con lo que sale del inflate, y que el manifiesto anota lo que de
 * verdad se escribió. Un doble del extractor no probaría nada de eso.
 */
import { deflateRawSync } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/**
 * @param {Array<[string, Buffer]>} files rutas dentro del ZIP (con `/`) y su contenido
 * @returns {Buffer}
 */
export function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, contents] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = deflateRawSync(contents);
    const crc = 0; // El extractor no lo comprueba; aquí se prueban los tamaños.

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
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
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

/**
 * Falsea el tamaño descomprimido de la primera entrada en el directorio central.
 *
 * Sirve para comprobar que el extractor se niega a escribir un archivo que no mide lo que el ZIP
 * declara, en vez de dejarlo a medias y que el fallo salga mucho más tarde.
 */
export function corruptDeclaredSize(zip, declared) {
  const signature = Buffer.alloc(4);
  signature.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  const copy = Buffer.from(zip);
  copy.writeUInt32LE(declared, copy.indexOf(signature) + 24);
  return copy;
}
