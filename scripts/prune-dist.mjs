#!/usr/bin/env node
/**
 * Poda de `/dist`: borra los artefactos de versiones anteriores.
 *
 * electron-builder no limpia su directorio de salida, y como el nombre de artefacto lleva
 * `${version}`, cada release deja los archivos del anterior ahí. Al cabo de tres versiones hay
 * medio giga de instaladores viejos y es fácil subir el que no era.
 *
 * No se borra `/dist` entera a propósito: `dist:win` y `dist:mac` se ejecutan por separado (y en
 * máquinas distintas), así que un borrado total haría que el segundo se llevara por delante los
 * artefactos del primero. Se podan sólo los que llevan un sello de versión que ya no es la actual.
 *
 *   node scripts/prune-dist.mjs             borra los artefactos de versiones anteriores
 *   node scripts/prune-dist.mjs --dry-run   sólo informa de lo que borraría
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectStaleArtifacts } from './lib/dist-artifacts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const dryRun = process.argv.includes('--dry-run');

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function main() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  if (!existsSync(distDir)) {
    console.log(`\n  dist/ no existe todavía: nada que podar (versión actual ${version}).\n`);
    return;
  }

  const entries = await readdir(distDir);
  const stale = selectStaleArtifacts(entries, version);

  if (stale.length === 0) {
    console.log(`\n  dist/ sólo contiene artefactos de la versión ${version}: nada que podar.\n`);
    return;
  }

  console.log(`\n  DotForge IDE — poda de dist/ (versión actual: ${version})\n`);

  let freed = 0;
  for (const name of stale) {
    const target = join(distDir, name);
    const info = await stat(target);
    freed += info.size;

    if (dryRun) {
      console.log(`  ·  ${name}  ${formatBytes(info.size)}  (--dry-run: no se borra)`);
      continue;
    }

    await rm(target, { recursive: true, force: true });
    console.log(`  ✓  ${name}  ${formatBytes(info.size)}`);
  }

  const verb = dryRun ? 'se liberarían' : 'liberados';
  console.log(`\n  ${stale.length} artefacto(s) de versiones anteriores, ${verb} ${formatBytes(freed)}.\n`);
}

await main();
