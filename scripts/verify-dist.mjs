#!/usr/bin/env node
/**
 * Verificación de los artefactos de distribución.
 *
 * Comprueba qué hay realmente en `/dist`, su tamaño y su naturaleza, e informa con claridad de lo
 * que falta. La regla del proyecto es no dar por bueno un release "porque el comando terminó":
 * si un target no se generó, aquí sale en rojo con el motivo.
 *
 *   node scripts/verify-dist.mjs            informe legible
 *   node scripts/verify-dist.mjs --json     salida JSON para CI
 *   node scripts/verify-dist.mjs --require win   falla si faltan los artefactos de Windows
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const required = argv
  .map((argument, index) => (argument === '--require' ? argv[index + 1] : null))
  .filter((value) => value !== null);

/** Qué se espera por plataforma. `optional` marca lo que puede faltar sin ser un fallo. */
const EXPECTATIONS = {
  win: [
    { label: 'Instalador NSIS', pattern: /-Setup-.*\.exe$/i, minBytes: 40 * 1024 * 1024 },
    { label: 'Portable ZIP', pattern: /-win-.*\.zip$/i, minBytes: 60 * 1024 * 1024 },
    { label: 'Carpeta desempaquetada', pattern: /^win-unpacked$/, directory: true },
  ],
  mac: [
    { label: 'Imagen de disco (arm64)', pattern: /-arm64\.dmg$/i, minBytes: 40 * 1024 * 1024 },
    { label: 'Imagen de disco (x64)', pattern: /-x64\.dmg$/i, minBytes: 40 * 1024 * 1024 },
    { label: 'App comprimida (arm64)', pattern: /-mac-arm64\.zip$/i, minBytes: 40 * 1024 * 1024 },
    { label: 'App comprimida (x64)', pattern: /-mac-x64\.zip$/i, minBytes: 40 * 1024 * 1024 },
  ],
  linux: [{ label: 'AppImage', pattern: /\.AppImage$/i, minBytes: 40 * 1024 * 1024, optional: true }],
};

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function directorySize(path) {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
  }
  return total;
}

/** Un ejecutable de Windows firmado tiene una entrada en el directorio de certificados del PE. */
function isSignedPe(path) {
  try {
    const buffer = readFileSync(path);
    if (buffer.length < 0x200 || buffer.readUInt16LE(0) !== 0x5a4d) return false;

    const peOffset = buffer.readUInt32LE(0x3c);
    if (buffer.readUInt32LE(peOffset) !== 0x00004550) return false;

    const magic = buffer.readUInt16LE(peOffset + 24);
    const isPe32Plus = magic === 0x20b;
    const dataDirectory = peOffset + 24 + (isPe32Plus ? 112 : 96);
    const certificateEntry = dataDirectory + 4 * 8; // índice 4 = tabla de certificados

    return buffer.readUInt32LE(certificateEntry) !== 0 && buffer.readUInt32LE(certificateEntry + 4) !== 0;
  } catch {
    return false;
  }
}

async function main() {
  if (!existsSync(distDir)) {
    const message = 'No existe la carpeta dist/. Ejecuta `npm run dist:win` o `npm run dist:mac`.';
    if (asJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(`\n  ${message}\n`);
    process.exit(1);
  }

  const entries = await readdir(distDir, { withFileTypes: true });

  const found = [];
  for (const entry of entries) {
    const path = join(distDir, entry.name);
    const size = entry.isDirectory() ? await directorySize(path) : (await stat(path)).size;
    found.push({ name: entry.name, path, size, directory: entry.isDirectory() });
  }

  const report = { platforms: {}, artifacts: [], problems: [] };

  for (const [platform, expectations] of Object.entries(EXPECTATIONS)) {
    const results = [];

    for (const expectation of expectations) {
      const match = found.find(
        (item) => expectation.pattern.test(item.name) && item.directory === (expectation.directory === true),
      );

      if (!match) {
        results.push({ label: expectation.label, status: 'missing', optional: expectation.optional === true });
        continue;
      }

      const tooSmall = expectation.minBytes !== undefined && match.size < expectation.minBytes;
      results.push({
        label: expectation.label,
        status: tooSmall ? 'suspicious' : 'ok',
        file: match.name,
        size: match.size,
        sizeText: formatBytes(match.size),
        ...(tooSmall ? { note: `pesa menos de lo esperado (${formatBytes(expectation.minBytes)})` } : {}),
      });
    }

    report.platforms[platform] = results;
  }

  // Estado de firma de los ejecutables de Windows presentes.
  for (const item of found) {
    if (!item.directory && extname(item.name).toLowerCase() === '.exe') {
      report.artifacts.push({
        name: item.name,
        size: item.size,
        sizeText: formatBytes(item.size),
        signed: isSignedPe(item.path),
      });
    } else if (!item.directory) {
      report.artifacts.push({ name: item.name, size: item.size, sizeText: formatBytes(item.size) });
    }
  }

  for (const platform of required) {
    const results = report.platforms[platform] ?? [];
    for (const result of results) {
      if (result.status === 'missing' && !result.optional) {
        report.problems.push(`falta ${result.label} (${platform})`);
      }
      if (result.status === 'suspicious') {
        report.problems.push(`${result.label}: ${result.note}`);
      }
    }
  }

  report.ok = report.problems.length === 0;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log('\n  DotForge IDE — verificación de /dist\n');

  for (const [platform, results] of Object.entries(report.platforms)) {
    const anyPresent = results.some((result) => result.status !== 'missing');
    if (!anyPresent && !required.includes(platform)) continue;

    console.log(`  ${platform.toUpperCase()}`);
    for (const result of results) {
      const symbol = result.status === 'ok' ? '✓' : result.status === 'suspicious' ? '!' : result.optional ? '·' : '✗';
      const detail =
        result.status === 'missing'
          ? 'no generado'
          : `${result.file}  ${result.sizeText}${result.note ? ` — ${result.note}` : ''}`;
      console.log(`    ${symbol} ${result.label.padEnd(28)} ${detail}`);
    }
    console.log();
  }

  const executables = report.artifacts.filter((artifact) => artifact.signed !== undefined);
  if (executables.length > 0) {
    console.log('  FIRMA');
    for (const executable of executables) {
      console.log(`    ${executable.signed ? '✓ firmado ' : '· sin firmar'}  ${executable.name}`);
    }
    console.log('\n  Nota: sin firma, Windows mostrará el aviso de SmartScreen y macOS pedirá');
    console.log('  confirmación en Gatekeeper. Es lo esperado sin certificado de desarrollador.\n');
  }

  if (report.problems.length > 0) {
    console.error('  PROBLEMAS');
    for (const problem of report.problems) console.error(`    ✗ ${problem}`);
    console.error();
    process.exit(1);
  }

  console.log('  Verificación completada sin problemas.\n');
}

main().catch((error) => {
  console.error('\n  Verificación fallida:', error);
  process.exit(1);
});
