#!/usr/bin/env node
/**
 * Compilación de DotForge IDE con esbuild.
 *
 * Objetivos:
 *  - build/cli.js       CLI headless (CJS, Node)
 *  - build/main.js      proceso principal de Electron (CJS, Node, electron externo)
 *  - build/preload.js   puente contextIsolation (CJS)
 *  - build/renderer.js  UI (IIFE, navegador)
 *  - build/templates/   plantillas de scaffolding copiadas tal cual
 *  - build/vendor/monaco/  Monaco Editor servido localmente (no se bundlea)
 *  - build/*.html, build/styles/  activos estáticos del renderer
 *
 * Monaco no se bundlea a propósito: su loader AMD y sus web workers funcionan mucho mejor
 * servidos como archivos, y así el bundle del renderer baja de varios MB a unos pocos KB.
 */
import { build, context } from 'esbuild';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify') || process.env.NODE_ENV === 'production';

const banner = { js: '/* DotForge IDE — generado por scripts/build.mjs. No editar. */' };

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    label: 'cli',
    entryPoints: [join(root, 'src/cli/index.ts')],
    outfile: join(outDir, 'cli.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    bundle: true,
    banner: { js: '#!/usr/bin/env node\n' + banner.js },
  },
  {
    label: 'scaffold',
    entryPoints: [join(root, 'src/scaffold/index.ts')],
    outfile: join(outDir, 'scaffold.mjs'),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    bundle: true,
    banner,
  },
  {
    label: 'toolchain',
    entryPoints: [join(root, 'src/main/toolchain.ts')],
    outfile: join(outDir, 'toolchain.mjs'),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    bundle: true,
    banner,
  },
  {
    label: 'main-lib',
    entryPoints: [join(root, 'src/main/testable.ts')],
    outfile: join(outDir, 'main-lib.mjs'),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    bundle: true,
    banner,
  },
  {
    label: 'razor-lang',
    entryPoints: [join(root, 'src/renderer/languages/razor.ts')],
    outfile: join(outDir, 'razor-lang.mjs'),
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    bundle: true,
    banner,
  },
  {
    label: 'main',
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(outDir, 'main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    bundle: true,
    external: ['electron'],
    banner,
  },
  {
    label: 'preload',
    entryPoints: [join(root, 'src/main/preload.ts')],
    outfile: join(outDir, 'preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    bundle: true,
    external: ['electron'],
    banner,
  },
  {
    label: 'renderer',
    entryPoints: [join(root, 'src/renderer/index.ts')],
    outfile: join(outDir, 'renderer.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    bundle: true,
    // Monaco se carga con su propio loader AMD desde build/vendor/monaco.
    external: ['monaco-editor'],
    loader: { '.css': 'text', '.svg': 'text' },
    banner,
  },
];

async function copyDirectory(from, to, { filter } = {}) {
  if (!existsSync(from)) return 0;
  await mkdir(to, { recursive: true });
  let count = 0;

  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) {
      count += await copyDirectory(source, destination, { filter });
    } else if (!filter || filter(source)) {
      await cp(source, destination);
      count++;
    }
  }
  return count;
}

async function copyAssets() {
  const templatesFrom = join(root, 'src/scaffold/templates');
  const templatesTo = join(outDir, 'templates');
  await rm(templatesTo, { recursive: true, force: true });
  const templateCount = await copyDirectory(templatesFrom, templatesTo);
  console.log(`  templates   ${templateCount} archivos`);

  const monacoFrom = join(root, 'node_modules/monaco-editor/min/vs');
  const monacoTo = join(outDir, 'vendor/monaco/vs');
  if (existsSync(monacoFrom)) {
    if (!existsSync(monacoTo)) {
      const monacoCount = await copyDirectory(monacoFrom, monacoTo);
      console.log(`  monaco      ${monacoCount} archivos`);
    } else {
      console.log('  monaco      ya presente (omitido)');
    }
  } else {
    console.warn('  monaco      AVISO: no se encuentra monaco-editor en node_modules');
  }

  const xtermCss = join(root, 'node_modules/@xterm/xterm/css/xterm.css');
  if (existsSync(xtermCss)) {
    await mkdir(join(outDir, 'vendor'), { recursive: true });
    await cp(xtermCss, join(outDir, 'vendor/xterm.css'));
  }

  const staticFrom = join(root, 'src/renderer/static');
  const staticCount = await copyDirectory(staticFrom, outDir);
  if (staticCount > 0) console.log(`  static      ${staticCount} archivos`);

  const stylesCount = await copyDirectory(
    join(root, 'src/renderer/styles'),
    join(outDir, 'styles'),
    { filter: (file) => file.endsWith('.css') },
  );
  if (stylesCount > 0) console.log(`  styles      ${stylesCount} archivos`);

  const iconsFrom = join(root, 'resources/icons');
  const iconsCount = await copyDirectory(iconsFrom, join(outDir, 'icons'), {
    filter: (file) => file.endsWith('.png') || file.endsWith('.svg'),
  });
  if (iconsCount > 0) console.log(`  icons       ${iconsCount} archivos`);
}

async function run() {
  const started = Date.now();
  await mkdir(outDir, { recursive: true });

  const available = targets.filter((target) => {
    const entry = target.entryPoints[0];
    if (existsSync(entry)) return true;
    console.warn(`  ${target.label.padEnd(11)} omitido (falta ${relative(root, entry)})`);
    return false;
  });

  for (const target of available) {
    const { label, ...options } = target;
    const buildOptions = { ...options, sourcemap: !minify, minify, logLevel: 'warning' };

    if (watch) {
      const ctx = await context(buildOptions);
      await ctx.watch();
      console.log(`  ${label.padEnd(11)} watch activo`);
    } else {
      await build(buildOptions);
      const info = await stat(options.outfile);
      console.log(`  ${label.padEnd(11)} ${(info.size / 1024).toFixed(1)} KB`);
    }
  }

  await copyAssets();

  // Marca de build consumida por la pantalla "Acerca de" y por verify-dist.
  await writeFile(
    join(outDir, 'build-info.json'),
    `${JSON.stringify(
      {
        builtAtUtc: new Date().toISOString(),
        node: process.version,
        minified: minify,
        targets: available.map((target) => target.label),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\n  Build completada en ${Date.now() - started} ms -> ${relative(root, outDir)}\n`);

  if (watch) {
    console.log('  Esperando cambios. Ctrl+C para salir.');
    await new Promise(() => {});
  }
}

console.log('\n  DotForge IDE — build\n');
run().catch((error) => {
  console.error('\n  Build fallida:', error.message);
  process.exit(1);
});
