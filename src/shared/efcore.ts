/**
 * Modelo compartido del gestor de Entity Framework Core.
 *
 * Todo lo de este archivo es **función pura**: entra la salida cruda de `dotnet ef` (o el texto
 * de un `appsettings.json`) y sale el modelo que pinta el panel lateral. No importa `electron`,
 * ni `node:*`, ni el DOM, así que lo consumen el proceso principal (que ejecuta la CLI), el
 * renderer (que pinta) y las pruebas.
 *
 * Tres decisiones que gobiernan el archivo:
 *
 * 1. **Se pide `--json` y se parsea el bloque, no el texto.** Las herramientas de EF Core
 *    envuelven su salida JSON entre `//BEGIN` y `//END` para separarla de la del build. Leer ese
 *    bloque es lo único estable: el texto plano cambia de formato entre versiones y el estado
 *    "(Pending)" es una cadena que un día se traducirá.
 * 2. **Hay camino de respaldo, pero es el segundo.** Si no aparece el bloque JSON (una versión
 *    antigua de las herramientas, o un fallo antes de emitirlo) se parsean las líneas sueltas,
 *    marcándolo como degradado para que la UI pueda decirlo.
 * 3. **Los argumentos se construyen aquí, en array.** Nunca una línea de shell: un proyecto en
 *    `C:\Mis Cosas\Api` con espacios es un caso normal, no un caso borde.
 */

// ---------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------

import { stripBom } from './json-text.js';

export interface EfMigration {
  /** Identificador completo: `20260101120000_InitialCreate`. */
  id: string;
  /** Nombre sin la marca de tiempo: `InitialCreate`. */
  name: string;
  applied: boolean;
  /** Marca de tiempo del identificador en ISO, o null si el id no la lleva. */
  timestampUtc: string | null;
}

export interface EfMigrationList {
  migrations: EfMigration[];
  applied: number;
  pending: number;
  /** true si el estado se ha deducido del texto plano porque no había bloque JSON. */
  degraded: boolean;
}

export interface EfDbContext {
  name: string;
  fullName: string;
  safeName: string;
}

/** Operaciones que el panel puede lanzar. Cada una se traduce a un `dotnet ef ...`. */
export type EfOperation =
  | 'migrations-list'
  | 'migrations-add'
  | 'migrations-remove'
  | 'database-update'
  | 'dbcontext-list'
  | 'dbcontext-info';

/** Lista blanca de operaciones. El handler IPC valida contra ella lo que llega del renderer. */
export const EF_OPERATIONS: readonly EfOperation[] = [
  'migrations-list',
  'migrations-add',
  'migrations-remove',
  'database-update',
  'dbcontext-list',
  'dbcontext-info',
];

export interface EfTarget {
  /** Proyecto que contiene el DbContext y las migraciones (`--project`). */
  project: string;
  /** Proyecto que arranca la aplicación (`--startup-project`). Suele ser la Web API. */
  startupProject?: string | null;
  /** DbContext concreto cuando hay más de uno (`--context`). */
  context?: string | null;
}

export interface EfOperationOptions extends EfTarget {
  /** Nombre de la migración nueva (`migrations-add`). */
  name?: string;
  /** Migración objetivo de `database-update`; vacío significa "la última". */
  targetMigration?: string | null;
  /** `migrations-remove` sobre una migración ya aplicada necesita revertir en la base de datos. */
  force?: boolean;
}

export interface ConnectionStringInfo {
  name: string;
  value: string;
  provider: 'sqlite' | 'sqlserver' | 'postgres' | 'mysql' | 'unknown';
  /** Nombre de la base de datos o del archivo, ya extraído. Null si no se reconoce. */
  database: string | null;
  /** Servidor o host. Null en SQLite, que no tiene. */
  server: string | null;
  /** Valor con la contraseña sustituida por asteriscos: es lo que se pinta. */
  masked: string;
}

// ---------------------------------------------------------------------------------------------
// Salida de `dotnet ef --json`
// ---------------------------------------------------------------------------------------------

/**
 * Extrae el bloque JSON que las herramientas de EF Core envuelven entre `//BEGIN` y `//END`.
 *
 * Devuelve null si no está: el `dotnet build` que EF lanza antes escribe muchas líneas por delante
 * y un `JSON.parse` de toda la salida fallaría siempre.
 */
export function extractJsonBlock(stdout: string): string | null {
  const begin = stdout.indexOf('//BEGIN');
  if (begin === -1) return null;

  const end = stdout.indexOf('//END', begin);
  const body = end === -1 ? stdout.slice(begin + '//BEGIN'.length) : stdout.slice(begin + '//BEGIN'.length, end);

  const trimmed = body.trim();
  return trimmed === '' ? null : trimmed;
}

/** `20260101120000_InitialCreate` -> `2026-01-01T12:00:00.000Z`. Null si el id no lleva marca. */
export function migrationTimestamp(id: string): string | null {
  const match = /^(\d{14})_/.exec(id);
  if (!match) return null;

  const digits = match[1]!;
  const iso =
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` +
    `T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}.000Z`;

  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** `20260101120000_InitialCreate` -> `InitialCreate`. Un id sin marca se devuelve tal cual. */
export function migrationName(id: string): string {
  const match = /^\d{14}_(.+)$/.exec(id);
  return match ? match[1]! : id;
}

function toMigration(id: string, name: string, applied: boolean): EfMigration {
  return { id, name: name === '' ? migrationName(id) : name, applied, timestampUtc: migrationTimestamp(id) };
}

/**
 * Migraciones a partir de la salida de `dotnet ef migrations list --json`.
 *
 * El camino de respaldo lee líneas sueltas —`20260101120000_Init (Pending)`— y sólo se usa cuando
 * no hay bloque JSON. Se marca `degraded` para que la UI avise en vez de fingir seguridad.
 */
export function parseMigrations(stdout: string): EfMigrationList {
  const block = extractJsonBlock(stdout);

  if (block !== null) {
    try {
      const parsed: unknown = JSON.parse(block);
      if (Array.isArray(parsed)) {
        const migrations = parsed
          .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
          .map((entry) =>
            toMigration(
              typeof entry['id'] === 'string' ? entry['id'] : '',
              typeof entry['name'] === 'string' ? entry['name'] : '',
              entry['applied'] === true,
            ),
          )
          .filter((migration) => migration.id !== '');

        return summarize(migrations, false);
      }
    } catch {
      // JSON mal formado: se cae al camino de texto, que al menos enseña algo.
    }
  }

  const migrations = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d{14}_\S/.test(line))
    .map((line) => {
      const [id = ''] = line.split(/\s+/, 1);
      // `(Pending)` es la única marca que escribe la CLI en texto plano.
      return toMigration(id, '', !/\(pending\)/i.test(line));
    });

  return summarize(migrations, migrations.length > 0);
}

function summarize(migrations: EfMigration[], degraded: boolean): EfMigrationList {
  return {
    migrations,
    applied: migrations.filter((migration) => migration.applied).length,
    pending: migrations.filter((migration) => !migration.applied).length,
    degraded,
  };
}

/** Contextos a partir de `dotnet ef dbcontext list --json`. */
export function parseDbContexts(stdout: string): EfDbContext[] {
  const block = extractJsonBlock(stdout);
  if (block === null) return [];

  try {
    const parsed: unknown = JSON.parse(block);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => {
        const fullName = typeof entry['fullName'] === 'string' ? entry['fullName'] : '';
        const safeName = typeof entry['safeName'] === 'string' ? entry['safeName'] : '';
        const name = typeof entry['name'] === 'string' ? entry['name'] : safeName;
        return { name: name === '' ? fullName.split('.').pop() ?? '' : name, fullName, safeName };
      })
      .filter((context) => context.fullName !== '' || context.name !== '');
  } catch {
    return [];
  }
}

/**
 * Mensaje accionable cuando `dotnet ef` no está instalado.
 *
 * Se detecta por el código de salida y por la ausencia de bloque JSON, no traduciendo el texto de
 * la CLI: ese texto está localizado y cambia entre versiones.
 */
export const EF_TOOL_MISSING_HINT =
  'No se ha podido ejecutar "dotnet ef". Instala las herramientas con ' +
  '`dotnet tool install --global dotnet-ef` y añade el paquete Microsoft.EntityFrameworkCore.Design al proyecto.';

// ---------------------------------------------------------------------------------------------
// Construcción de argumentos
// ---------------------------------------------------------------------------------------------

/** Un nombre de migración es un identificador de C#: se genera una clase con él. */
export function isValidMigrationName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name.trim());
}

/**
 * Argumentos de `dotnet ef` para una operación.
 *
 * `--json` va en todas las de lectura; `--prefix-output` no, porque ya se separa por el bloque.
 * `--no-build` **no** se usa nunca: EF necesita el ensamblado actualizado para leer el modelo, y
 * ahorrarse el build es exactamente cómo se acaba generando una migración contra código viejo.
 */
export function efArgs(operation: EfOperation, options: EfOperationOptions): string[] {
  const head: Record<EfOperation, string[]> = {
    'migrations-list': ['migrations', 'list', '--json'],
    'migrations-add': ['migrations', 'add', (options.name ?? '').trim()],
    'migrations-remove': ['migrations', 'remove', ...(options.force ? ['--force'] : [])],
    'database-update': ['database', 'update', ...(options.targetMigration ? [options.targetMigration] : [])],
    'dbcontext-list': ['dbcontext', 'list', '--json'],
    'dbcontext-info': ['dbcontext', 'info', '--json'],
  };

  if (operation === 'migrations-add' && !isValidMigrationName(options.name ?? '')) {
    throw new Error(
      'el nombre de la migración debe empezar por letra o guion bajo y contener sólo letras, números y guiones bajos',
    );
  }

  return [
    'ef',
    ...head[operation],
    '--project',
    options.project,
    ...(options.startupProject ? ['--startup-project', options.startupProject] : []),
    ...(options.context ? ['--context', options.context] : []),
  ];
}

// ---------------------------------------------------------------------------------------------
// Cadenas de conexión de appsettings.json
// ---------------------------------------------------------------------------------------------

/** Claves de una cadena de conexión, en minúsculas y sin espacios. */
function connectionParts(value: string): Map<string, string> {
  const parts = new Map<string, string>();

  for (const segment of value.split(';')) {
    const index = segment.indexOf('=');
    if (index === -1) continue;

    const key = segment.slice(0, index).trim().toLowerCase().replace(/\s+/g, ' ');
    const raw = segment.slice(index + 1).trim();
    if (key !== '') parts.set(key, raw);
  }

  return parts;
}

const SECRET_KEYS = new Set(['password', 'pwd', 'user password', 'accountkey']);

/** Sustituye la contraseña por asteriscos: la cadena se pinta en la interfaz. */
export function maskConnectionString(value: string): string {
  return value
    .split(';')
    .map((segment) => {
      const index = segment.indexOf('=');
      if (index === -1) return segment;

      const key = segment.slice(0, index).trim().toLowerCase();
      return SECRET_KEYS.has(key) ? `${segment.slice(0, index)}=********` : segment;
    })
    .join(';');
}

/**
 * Proveedor deducido de las claves de la cadena.
 *
 * No hay forma infalible de saberlo sin mirar el `UseXxx` del `Program.cs`, pero las claves son
 * suficientemente distintas: sólo SQLite usa `Data Source` con un archivo, sólo PostgreSQL usa
 * `Host` con `Database`, y SQL Server es el único que usa `Initial Catalog`.
 */
export function detectProvider(value: string): ConnectionStringInfo['provider'] {
  const parts = connectionParts(value);
  const dataSource = parts.get('data source') ?? parts.get('datasource') ?? '';

  if (parts.has('host') && parts.has('database')) return 'postgres';
  if (parts.has('server') && parts.has('uid')) return 'mysql';
  if (parts.has('initial catalog') || (parts.has('server') && parts.has('database'))) return 'sqlserver';
  if (/\.(db|sqlite|sqlite3)$/i.test(dataSource) || dataSource.toLowerCase() === ':memory:') return 'sqlite';
  if (parts.has('filename')) return 'sqlite';
  if (parts.has('server')) return 'sqlserver';

  return 'unknown';
}

export function describeConnection(name: string, value: string): ConnectionStringInfo {
  const parts = connectionParts(value);
  const provider = detectProvider(value);

  const database =
    parts.get('database') ??
    parts.get('initial catalog') ??
    (provider === 'sqlite' ? (parts.get('data source') ?? parts.get('filename') ?? null) : null);

  const server = provider === 'sqlite' ? null : (parts.get('server') ?? parts.get('host') ?? null);

  return { name, value, provider, database: database ?? null, server: server ?? null, masked: maskConnectionString(value) };
}

/**
 * Cadenas de conexión de un `appsettings.json`.
 *
 * Se acepta texto con comentarios y comas colgantes porque los `appsettings.Development.json`
 * escritos a mano los llevan a menudo y `JSON.parse` los rechaza: dejar el panel vacío por una
 * coma sobraría sería un fallo del IDE, no del proyecto.
 */
export function parseConnectionStrings(appsettings: string): ConnectionStringInfo[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stripJsonComments(stripBom(appsettings)));
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) return [];

  const section = (parsed as Record<string, unknown>)['ConnectionStrings'];
  if (typeof section !== 'object' || section === null) return [];

  return Object.entries(section as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
    .map(([name, value]) => describeConnection(name, value));
}

/** Quita comentarios `//` y `/* *\/` y comas colgantes, respetando las cadenas. */
export function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const next = text[i + 1];

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        result += char;
      }
      continue;
    }

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }

    result += char;
  }

  // Comas colgantes: `,` seguida de `}` o `]` con espacios en medio.
  return result.replace(/,(\s*[}\]])/g, '$1');
}
