#!/usr/bin/env node
/**
 * Pre-descarga del toolchain externo (servidor de lenguaje y depurador).
 *
 * DotForge los descarga solo la primera vez que se abre una solución. Este script permite
 * hacerlo por adelantado: útil para preparar una imagen de CI, un equipo sin red o una
 * instalación corporativa donde el primer arranque no debería depender de internet.
 *
 *   node scripts/fetch-toolchain.mjs
 *   node scripts/fetch-toolchain.mjs --dir ./toolchain
 *   node scripts/fetch-toolchain.mjs --only lsp
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);

function flag(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function defaultToolchainDir() {
  const appName = 'DotForge IDE';
  const userData =
    process.platform === 'win32'
      ? join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), appName)
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', appName)
        : join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), appName);

  return join(userData, 'toolchain');
}

const toolchainDir = flag('dir') ?? defaultToolchainDir();
const only = flag('only');

function progressLine(detail, ratio) {
  const percent = ratio === null || ratio === undefined ? '' : ` ${Math.round(ratio * 100)}%`;
  process.stdout.write(`\r  ${detail}${percent}`.padEnd(78));
}

async function main() {
  console.log('\n  DotForge IDE — descarga del toolchain\n');
  console.log(`  Destino: ${toolchainDir}\n`);

  // Se importa desde el bundle compilado para no depender de un cargador de TypeScript.
  const { acquireLanguageServer } = await import('../build/toolchain.mjs');
  const { acquireDebugger } = await import('../build/toolchain.mjs');

  if (only !== 'debugger') {
    try {
      const server = await acquireLanguageServer(toolchainDir, (_phase, ratio, detail) =>
        progressLine(detail, ratio),
      );
      console.log(`\r  ✓ ${server.displayName} ${server.version}`.padEnd(78));
      console.log(`    ${server.directory}`);
    } catch (error) {
      console.error(`\r  ✗ servidor de lenguaje: ${error.message}`.padEnd(78));
      process.exitCode = 1;
    }
  }

  if (only !== 'lsp') {
    try {
      const debuggerBinary = await acquireDebugger(toolchainDir, (detail, ratio) => progressLine(detail, ratio));
      console.log(`\r  ✓ NetCoreDbg ${debuggerBinary.version}`.padEnd(78));
      console.log(`    ${debuggerBinary.directory}`);
    } catch (error) {
      console.error(`\r  ✗ depurador: ${error.message}`.padEnd(78));
      // El depurador es opcional: sin él el IDE sigue siendo plenamente usable para editar y
      // compilar, así que no se marca la ejecución como fallida.
    }
  }

  console.log();
}

main().catch((error) => {
  console.error('\n  Descarga del toolchain fallida:', error);
  process.exit(1);
});
