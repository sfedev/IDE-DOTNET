#!/usr/bin/env node
/**
 * Empaquetado para macOS.
 *
 * electron-builder sólo puede construir artefactos de macOS desde macOS (y, con limitaciones,
 * desde Linux). Desde Windows falla con un mensaje escueto; este wrapper explica por qué y qué
 * hacer, en vez de dejar un error críptico y un `/dist` a medias.
 *
 * En macOS o Linux delega directamente en electron-builder.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUPPORTED = new Set(['darwin', 'linux']);

function explainUnsupported() {
  console.error(`
  No se pueden generar artefactos de macOS desde ${process.platform}.

  Es una limitación de electron-builder, no de la configuración de este proyecto: el .dmg
  necesita herramientas del sistema que sólo existen en macOS (hdiutil, codesign).

  Formas de obtener el .dmg y el .app:

    1. En un Mac, con este mismo repositorio:
         npm ci
         npm run dist:mac

    2. En CI, con el workflow ya incluido (.github/workflows/release.yml):
         se ejecuta en un runner macos-latest y publica los artefactos de arm64 y x64.

    3. En Linux (soporte parcial, sin firma ni notarización):
         npm run dist:mac

  Los artefactos de Windows sí se generan aquí:
         npm run dist:win
`);
}

function run() {
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron-builder', '--mac', '--publish', 'never'],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );

  child.on('close', (code) => process.exit(code ?? 1));
  child.on('error', (error) => {
    console.error(`  no se ha podido lanzar electron-builder: ${error.message}`);
    process.exit(1);
  });
}

if (!SUPPORTED.has(process.platform)) {
  explainUnsupported();
  process.exit(2);
}

run();
