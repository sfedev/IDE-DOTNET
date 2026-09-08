#!/usr/bin/env node
/**
 * Sumas SHA-256 de los artefactos de `/dist`.
 *
 * Lo lanza el workflow de publicación justo después de recoger los binarios y antes de componer
 * las notas, para que el archivo exista cuando las notas lo mencionen. También sirve a mano:
 *
 *   node scripts/checksums.mjs                     escribe dist/SHA256SUMS.txt
 *   node scripts/checksums.mjs --dir dist --check  vuelve a hashear y compara con el archivo
 *
 * `--check` es lo que convierte el archivo en una comprobación y no en un adorno: rehashea lo que
 * hay en el disco y lo compara con lo publicado. Es el mismo gesto que hará quien se descargue la
 * release, hecho aquí antes de publicarla.
 *
 * La composición y la lectura del texto viven en `scripts/lib/checksums.mjs` y están probadas; aquí
 * sólo se habla con el disco.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPublishableArtifact } from './lib/dist-artifacts.mjs';
import {
  CHECKSUM_FILE_NAME,
  formatChecksumFile,
  parseChecksumFile,
  publishedAssetName,
  verifyChecksums,
} from './lib/checksums.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { dir: 'dist', output: null, check: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--dir' && value) { options.dir = value; index++; }
    else if (flag === '--output' && value) { options.output = value; index++; }
    else if (flag === '--check') { options.check = true; }
  }
  return options;
}

/**
 * SHA-256 de un archivo, leído por trozos.
 *
 * En streaming y no `createHash().update(readFileSync(...))` por la misma razón de siempre en este
 * repositorio: el instalador pesa 126 MB y el portable 174, y meterlos enteros en memoria para
 * hashearlos es gratuito de evitar. Aquí es un script y nadie se queda mirando una ventana
 * congelada, pero la regla se aplica igual.
 */
function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Los artefactos publicables del directorio, hasheados y ordenados por nombre.
 *
 * El nombre que se anota es el **publicado** (`publishedAssetName`), no el del disco: este archivo
 * existe para verificar lo que alguien se descarga de la release, y ahí los nombres llevan puntos
 * donde aquí hay espacios. Se aplica en los dos caminos —al escribir y al comprobar— para que
 * `--check` siga comparando cosas comparables sobre los archivos locales.
 */
async function checksumsIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && isPublishableArtifact(entry.name))
    .map((entry) => entry.name)
    .sort();

  const results = [];
  for (const name of names) {
    results.push({ name: publishedAssetName(name), sha256: await sha256Of(join(directory, name)) });
  }
  return results;
}

const options = parseArgs(process.argv.slice(2));
// `resolve` y no `join`: así `--dir dist` se interpreta desde la raíz del repositorio, que es como
// lo llama el workflow, y una ruta absoluta se respeta tal cual en vez de colgarse de la raíz.
const directory = resolve(root, options.dir);
const outputPath = options.output === null
  ? join(directory, CHECKSUM_FILE_NAME)
  : resolve(root, options.output);

let actual;
try {
  actual = await checksumsIn(directory);
} catch (error) {
  console.error(`No se puede leer ${options.dir}/: ${error.message}`);
  process.exit(1);
}

// Un archivo de sumas vacío es peor que no tenerlo: se publica, parece una garantía y no cubre
// nada. Si no hay artefactos es que el traspaso entre jobs ha fallado, y eso se dice aquí.
if (actual.length === 0) {
  console.error(`No hay ningún artefacto publicable en ${options.dir}/: no se escribe ${CHECKSUM_FILE_NAME}.`);
  process.exit(1);
}

if (options.check) {
  let published;
  try {
    published = parseChecksumFile(await readFile(outputPath, 'utf8'));
  } catch (error) {
    console.error(`No se puede leer ${outputPath}: ${error.message}`);
    process.exit(1);
  }

  const result = verifyChecksums(published, actual);
  for (const name of result.missing) console.error(`  ✗ ${name}: está en la lista y no en el disco`);
  for (const name of result.extra) console.error(`  ✗ ${name}: está en el disco y no en la lista`);
  for (const item of result.mismatched) {
    console.error(`  ✗ ${item.name}: el contenido no coincide con su suma publicada`);
    console.error(`      publicado: ${item.expected}`);
    console.error(`      real:      ${item.actual}`);
  }

  if (!result.ok) {
    console.error(`\n${CHECKSUM_FILE_NAME} no describe lo que hay en ${options.dir}/.`);
    process.exit(1);
  }

  console.log(`${CHECKSUM_FILE_NAME} verificado: ${actual.length} artefactos, todas las sumas coinciden.`);
} else {
  await writeFile(outputPath, formatChecksumFile(actual), 'utf8');
  console.log(`${CHECKSUM_FILE_NAME} escrito con ${actual.length} artefactos:`);
  for (const entry of actual) console.log(`  ${entry.sha256}  ${entry.name}`);
}
