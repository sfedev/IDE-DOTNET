#!/usr/bin/env node
/**
 * Runner de la suite de DotForge IDE.
 *
 * Se apoya en el runner nativo de Node (`node --test`): cero dependencias de test, cero
 * configuración, y los mismos archivos se pueden ejecutar sueltos con `node --test <archivo>`.
 *
 *   node scripts/run-tests.mjs                 -> toda la suite
 *   node scripts/run-tests.mjs --filter unit   -> sólo un grupo
 *   node scripts/run-tests.mjs --no-build      -> no recompila antes
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Grupos de la suite. El orden es deliberado: lo rápido primero, para fallar antes. */
const GROUPS = [
  { name: 'unit', dir: 'tests/unit', description: 'motor de plantillas, nombres, blueprints y .sln' },
  { name: 'security', dir: 'tests/security', description: 'superficie IPC y validación de rutas' },
  { name: 'package', dir: 'tests/package', description: 'configuración de empaquetado y árbol de dist' },
  { name: 'scaffold', dir: 'tests/scaffold', description: 'generación real + dotnet build + dotnet test' },
];

function parseArgs(argv) {
  const filters = [];
  let build = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--filter') {
      const value = argv[i + 1];
      if (value) filters.push(value);
      i++;
    } else if (argv[i] === '--no-build') {
      build = false;
    }
  }
  return { filters, build };
}

function findTests(dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((file) => file.endsWith('.test.mjs'))
    .map((file) => join(full, file))
    .filter((file) => statSync(file).isFile());
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`  no se pudo lanzar ${command}: ${error.message}`);
      resolve(1);
    });
  });
}

async function main() {
  const { filters, build } = parseArgs(process.argv.slice(2));
  const selected = filters.length > 0 ? GROUPS.filter((group) => filters.includes(group.name)) : GROUPS;

  if (selected.length === 0) {
    console.error(`  filtro sin coincidencias. Grupos: ${GROUPS.map((g) => g.name).join(', ')}`);
    process.exit(1);
  }

  console.log('\n  DotForge IDE — suite de pruebas\n');

  if (build) {
    console.log('  Compilando antes de probar...\n');
    const code = await run(process.execPath, [join(root, 'scripts', 'build.mjs')]);
    if (code !== 0) {
      console.error('\n  La build ha fallado: se aborta la suite.\n');
      process.exit(code);
    }
  }

  const results = [];

  for (const group of selected) {
    const files = findTests(group.dir);
    if (files.length === 0) {
      console.log(`  [${group.name}] sin archivos de prueba en ${group.dir} — omitido`);
      results.push({ group: group.name, code: 0, files: 0, skipped: true });
      continue;
    }

    console.log(`\n  ── ${group.name} ─ ${group.description} (${files.length} archivos)\n`);

    // Concurrencia 1 en el grupo de scaffolding: varios `dotnet build` a la vez se pelean por
    // la caché de NuGet y por la CPU, y el resultado es más lento y menos legible.
    const concurrency = group.name === 'scaffold' ? '1' : '4';
    const code = await run(process.execPath, [
      '--test',
      `--test-concurrency=${concurrency}`,
      ...files.map((file) => relative(root, file)),
    ]);

    results.push({ group: group.name, code, files: files.length, skipped: false });
  }

  console.log('\n  ── Resumen ─────────────────────────────────\n');
  let failed = 0;
  for (const result of results) {
    const status = result.skipped ? 'OMITIDO' : result.code === 0 ? 'OK     ' : 'FALLO  ';
    if (result.code !== 0) failed++;
    console.log(`  ${status}  ${result.group.padEnd(10)} ${result.files} archivo(s)`);
  }

  if (failed > 0) {
    console.error(`\n  ${failed} grupo(s) en rojo.\n`);
    process.exit(1);
  }

  console.log('\n  Suite completa en verde.\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
