#!/usr/bin/env node
/**
 * Limpieza de salidas de build.
 *
 *   node scripts/clean.mjs           borra build/ y dist/
 *   node scripts/clean.mjs --all     borra además la caché de toolchain descargado
 */
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');

const targets = [join(root, 'build'), join(root, 'dist')];

if (all) {
  // Ruta de `app.getPath('userData')` por plataforma, sin arrancar Electron para averiguarla.
  const appName = 'DotForge IDE';
  const userData =
    process.platform === 'win32'
      ? join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), appName)
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', appName)
        : join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), appName);

  targets.push(join(userData, 'toolchain'));
}

console.log('\n  DotForge IDE — limpieza\n');

for (const target of targets) {
  if (!existsSync(target)) {
    console.log(`  ·  ${target} (no existe)`);
    continue;
  }
  await rm(target, { recursive: true, force: true });
  console.log(`  ✓  ${target}`);
}

console.log();
