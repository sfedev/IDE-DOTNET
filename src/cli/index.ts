/**
 * CLI `dotforge` — el generador de arquitecturas sin interfaz gráfica.
 *
 * Existe por tres razones:
 *  1. Los tests automatizados lo usan para generar soluciones y compilarlas con `dotnet build`.
 *  2. Permite usar el generador en CI o en un servidor sin Electron ni display.
 *  3. Es la misma ruta de código que ejecuta el wizard visual, así que probarlo prueba el wizard.
 */
import { resolve } from 'node:path';

import type {
  ArchitectureId,
  DbProvider,
  FrameworkMoniker,
  ScaffoldOptions,
  UiTarget,
} from '../shared/scaffold-types.js';
import { DEFAULT_SCAFFOLD_OPTIONS } from '../shared/scaffold-types.js';
import { isArchitectureId, listBlueprints } from '../scaffold/blueprints/index.js';
import { generateSolution } from '../scaffold/generator.js';
import { APP_VERSION as VERSION } from '../shared/version.js';

const COLORS = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  purple: '\u001b[35m',
  cyan: '\u001b[36m',
};

const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'];

function paint(text: string, color: keyof typeof COLORS): string {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }

  return { positional, flags };
}

function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function flagBoolean(flags: ParsedArgs['flags'], name: string, fallback: boolean): boolean {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value !== 'false' && value !== '0' && value !== 'no';
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string, fallback: T): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`valor inválido para --${name}: "${value}". Admitidos: ${allowed.join(', ')}`);
}

function printBanner(): void {
  console.log(paint(`\n  DotForge  ${paint(`v${VERSION}`, 'dim')}`, 'purple'));
  console.log(paint('  Generador de arquitecturas .NET\n', 'dim'));
}

function printHelp(): void {
  printBanner();
  console.log(`${paint('USO', 'bold')}
  dotforge list                          Muestra las arquitecturas disponibles
  dotforge new <arquitectura> [opciones] Genera una solución
  dotforge --version                     Muestra la versión

${paint('ARQUITECTURAS', 'bold')}
  clean        Clean Architecture (Domain / Application / Infrastructure / UI)
  hexagonal    Ports & Adapters  (Domain / Ports / Adapters)
  ddd          Domain-Driven Design + CQRS

${paint('OPCIONES DE "new"', 'bold')}
  --name <Nombre>        Nombre de la solución.            (obligatorio)
  --output <ruta>        Directorio contenedor.            (por defecto: directorio actual)
  --ui <valor>           webapi | blazor | both            (por defecto: both)
  --framework <valor>    net9.0 | net10.0                  (por defecto: net9.0)
  --db <valor>           sqlite | inmemory                 (por defecto: sqlite)
  --entity <Nombre>      Entidad del CRUD de ejemplo.      (por defecto: Product)
  --no-tests             No genera el proyecto de pruebas.
  --git                  Inicializa un repositorio git con un commit inicial.
  --force                Sobrescribe el directorio si ya existe.
  --json                 Emite el resultado como JSON (para scripts y para el IDE).

${paint('EJEMPLOS', 'bold')}
  dotforge new clean --name Acme.Shop --output ./workspace
  dotforge new ddd --name Acme.Billing --entity Invoice --ui webapi
  dotforge new hexagonal --name Acme.Iot --db inmemory --no-tests --force
`);
}

function printList(asJson: boolean): void {
  const blueprints = listBlueprints();

  if (asJson) {
    console.log(JSON.stringify(blueprints, null, 2));
    return;
  }

  printBanner();
  for (const blueprint of blueprints) {
    console.log(`${paint(blueprint.id.padEnd(11), 'cyan')}${paint(blueprint.title, 'bold')}`);
    console.log(`${' '.repeat(11)}${paint(blueprint.tagline, 'dim')}`);
    console.log(`${' '.repeat(11)}Capas: ${blueprint.layers.map((layer) => layer.name).join(' -> ')}`);
    console.log(`${' '.repeat(11)}Patrones: ${paint(blueprint.patterns.join(', '), 'dim')}`);
    console.log();
  }
}

function buildOptions(parsed: ParsedArgs): ScaffoldOptions {
  const architecture = parsed.positional[1];
  if (!architecture) {
    throw new Error('falta la arquitectura. Ejecuta `dotforge list` para ver las disponibles.');
  }
  if (!isArchitectureId(architecture)) {
    throw new Error(`arquitectura desconocida: "${architecture}". Ejecuta \`dotforge list\`.`);
  }

  const name = flagString(parsed.flags, 'name') ?? parsed.positional[2];
  if (!name) throw new Error('falta --name con el nombre de la solución.');

  return {
    architecture: architecture as ArchitectureId,
    solutionName: name,
    outputDir: resolve(flagString(parsed.flags, 'output') ?? process.cwd()),
    ui: oneOf<UiTarget>(flagString(parsed.flags, 'ui'), ['webapi', 'blazor', 'both'], 'ui', DEFAULT_SCAFFOLD_OPTIONS.ui),
    framework: oneOf<FrameworkMoniker>(
      flagString(parsed.flags, 'framework'),
      ['net9.0', 'net10.0'],
      'framework',
      DEFAULT_SCAFFOLD_OPTIONS.framework,
    ),
    db: oneOf<DbProvider>(flagString(parsed.flags, 'db'), ['sqlite', 'inmemory'], 'db', DEFAULT_SCAFFOLD_OPTIONS.db),
    entity: flagString(parsed.flags, 'entity') ?? DEFAULT_SCAFFOLD_OPTIONS.entity,
    includeTests: !flagBoolean(parsed.flags, 'no-tests', false),
    force: flagBoolean(parsed.flags, 'force', false),
    gitInit: flagBoolean(parsed.flags, 'git', false),
  };
}

async function runNew(parsed: ParsedArgs): Promise<void> {
  const asJson = flagBoolean(parsed.flags, 'json', false);
  const options = buildOptions(parsed);

  if (!asJson) {
    printBanner();
    console.log(`${paint('Arquitectura', 'dim')}  ${options.architecture}`);
    console.log(`${paint('Solución    ', 'dim')}  ${options.solutionName}`);
    console.log(`${paint('Framework   ', 'dim')}  ${options.framework}`);
    console.log(`${paint('Presentación', 'dim')}  ${options.ui}`);
    console.log(`${paint('Persistencia', 'dim')}  ${options.db}`);
    console.log(`${paint('Entidad     ', 'dim')}  ${options.entity}\n`);
  }

  const result = await generateSolution(options, __dirname);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(paint(`  Solución generada en ${result.rootDir}`, 'green'));
  console.log(`  ${result.files.length} archivos - ${(result.totalBytes / 1024).toFixed(1)} KB - ${result.durationMs} ms\n`);

  console.log(paint('  Proyectos', 'bold'));
  for (const project of result.projects) {
    console.log(`    ${paint(project.layer.padEnd(16), 'cyan')}${project.name}`);
  }

  for (const warning of result.warnings) {
    console.log(paint(`\n  Aviso: ${warning}`, 'yellow'));
  }

  console.log(
    `\n  ${paint('README.md', 'cyan')} explica la arquitectura, las reglas de dependencia,\n` +
      '  cómo añadir una funcionalidad paso a paso y los comandos de compilación y pruebas.',
  );

  console.log(`\n${paint('  Siguientes pasos', 'bold')}`);
  for (const step of result.nextSteps) {
    console.log(`    ${paint('$', 'dim')} ${step}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positional[0];

  if (parsed.flags.has('version') || command === 'version') {
    console.log(VERSION);
    return;
  }

  if (!command || command === 'help' || parsed.flags.has('help')) {
    printHelp();
    return;
  }

  switch (command) {
    case 'list':
      printList(flagBoolean(parsed.flags, 'json', false));
      return;
    case 'new':
      await runNew(parsed);
      return;
    default:
      throw new Error(`comando desconocido: "${command}". Ejecuta \`dotforge help\`.`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${paint('  Error:', 'red')} ${message}\n`);
  process.exitCode = 1;
});
