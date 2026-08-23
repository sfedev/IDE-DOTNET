#!/usr/bin/env node
/**
 * Generador de iconos de DotForge IDE.
 *
 * Dibuja el logo por código y emite:
 *   resources/icons/icon.png     1024x1024, usado por Linux y como fuente de respaldo
 *   resources/icons/icon-*.png   tamaños sueltos (los usa la UI y el README)
 *   resources/icons/icon.ico     multirresolución 16..256, para Windows
 *   resources/icons/icon.icns    multirresolución 16..1024, para macOS
 *
 * Sin herramientas nativas ni dependencias: sólo `zlib` y aritmética. Así `npm run icons`
 * funciona igual en Windows, macOS y Linux, y en CI sin instalar nada.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeIcns, encodeIco, encodePng } from './lib/png.mjs';
import { Canvas, hexToRgb } from './lib/raster.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, 'resources', 'icons');

/** Paleta de marca: el púrpura de .NET, del claro al oscuro. */
const ACCENT_LIGHT = hexToRgb('#9C7CFF');
const ACCENT_DARK = hexToRgb('#4B24C8');
const GLYPH = hexToRgb('#FFFFFF');

/**
 * Dibuja el logo en un lienzo normalizado de 100x100.
 *
 * El símbolo es `</>` — el gesto universal de "aquí se escribe código" — sobre un cuadrado
 * redondeado con degradado. Se construye con segmentos, así que escala limpio a cualquier tamaño.
 */
function drawLogo(size) {
  const canvas = new Canvas(size);
  const unit = size / 100;

  // Fondo: cuadrado redondeado con degradado vertical.
  canvas.roundedRectGradient(6 * unit, 6 * unit, 94 * unit, 94 * unit, 22 * unit, ACCENT_LIGHT, ACCENT_DARK);

  const thickness = 7.5 * unit;

  // Chevron izquierdo "<"
  canvas.stroke(
    [
      [40 * unit, 33 * unit],
      [23 * unit, 50 * unit],
      [40 * unit, 67 * unit],
    ],
    thickness,
    GLYPH,
  );

  // Chevron derecho ">"
  canvas.stroke(
    [
      [60 * unit, 33 * unit],
      [77 * unit, 50 * unit],
      [60 * unit, 67 * unit],
    ],
    thickness,
    GLYPH,
  );

  // Barra diagonal "/"
  canvas.stroke(
    [
      [55 * unit, 27 * unit],
      [45 * unit, 73 * unit],
    ],
    thickness * 0.85,
    GLYPH,
  );

  return canvas;
}

function renderPng(size) {
  const canvas = drawLogo(size);
  return encodePng(canvas.toRgba(size), size, size);
}

/** Tamaños que hacen falta en alguna de las tres plataformas. */
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

/** OSType de .icns -> tamaño en píxeles. */
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32], // 16x16@2x
  ['ic12', 64], // 32x32@2x
  ['ic13', 256], // 128x128@2x
  ['ic14', 512], // 256x256@2x
];

async function main() {
  await mkdir(outputDir, { recursive: true });

  console.log('\n  DotForge IDE — generación de iconos\n');

  const rendered = new Map();
  for (const size of PNG_SIZES) {
    const png = renderPng(size);
    rendered.set(size, png);
    await writeFile(join(outputDir, `icon-${size}.png`), png);
    console.log(`  icon-${String(size).padStart(4)}.png   ${(png.length / 1024).toFixed(1)} KB`);
  }

  // El PNG principal: Linux y el respaldo de electron-builder.
  await writeFile(join(outputDir, 'icon.png'), rendered.get(1024));
  await writeFile(join(root, 'resources', 'icon.png'), rendered.get(1024));

  // Windows: ICO con PNG embebido (compatible desde Vista).
  const ico = encodeIco(
    [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: rendered.get(size) })),
  );
  await writeFile(join(outputDir, 'icon.ico'), ico);
  await writeFile(join(root, 'resources', 'icon.ico'), ico);
  console.log(`\n  icon.ico              ${(ico.length / 1024).toFixed(1)} KB (7 resoluciones)`);

  // macOS: ICNS con las variantes normales y @2x.
  const icns = encodeIcns(new Map(ICNS_ENTRIES.map(([osType, size]) => [osType, rendered.get(size)])));
  await writeFile(join(outputDir, 'icon.icns'), icns);
  await writeFile(join(root, 'resources', 'icon.icns'), icns);
  console.log(`  icon.icns             ${(icns.length / 1024).toFixed(1)} KB (${ICNS_ENTRIES.length} entradas)`);

  console.log(`\n  Iconos escritos en ${outputDir}\n`);
}

main().catch((error) => {
  console.error('\n  Generación de iconos fallida:', error);
  process.exit(1);
});
