#!/usr/bin/env node
/**
 * Lee píxeles concretos de una captura PNG.
 *
 *   node scripts/read-pixels.mjs docs/screenshot-workspace.png 890,15 40,400
 *
 * Existe porque mirar una captura no es medirla: un visor puede aplicar su propio perfil de color
 * o su propio tema y hacer pasar por oscuro lo que en el archivo es claro. Esto lee los bytes.
 *
 * Decodifica PNG de 8 bits sin paleta ni entrelazado, que es lo que produce `--screenshot=`.
 * Sin dependencias, como el resto del proyecto.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const file = process.argv[2];
const points = process.argv.slice(3).map((p) => p.split(',').map(Number));

const buffer = readFileSync(file);
let offset = 8;
let width = 0;
let height = 0;
let colorType = 0;
const idat = [];

while (offset < buffer.length) {
  const length = buffer.readUInt32BE(offset);
  const type = buffer.toString('ascii', offset + 4, offset + 8);
  const data = buffer.subarray(offset + 8, offset + 8 + length);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    colorType = data[9];
  } else if (type === 'IDAT') {
    idat.push(data);
  } else if (type === 'IEND') break;
  offset += 12 + length;
}

const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
if (channels === 0) throw new Error(`colorType ${colorType} no soportado`);

const raw = inflateSync(Buffer.concat(idat));
const stride = width * channels;
const pixels = Buffer.alloc(stride * height);

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? pixels[y * stride + x - channels] : 0;
    const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
    const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
    const value = line[x];
    pixels[y * stride + x] =
      filter === 0 ? value
      : filter === 1 ? value + a
      : filter === 2 ? value + b
      : filter === 3 ? value + ((a + b) >> 1)
      : value + paeth(a, b, c);
  }
}

console.log(`${file}  ${width}x${height}  canales=${channels}`);
for (const [x, y] of points) {
  const index = y * stride + x * channels;
  console.log(`  (${x}, ${y}) -> rgb(${pixels[index]}, ${pixels[index + 1]}, ${pixels[index + 2]})`);
}
