/**
 * Inspección ligera del esquema a partir de las migraciones de EF Core.
 *
 * El IDE **no se conecta a la base de datos**. Sería la forma obvia de listar tablas y columnas,
 * pero obligaría a vendorear un driver por motor (SQL Server, PostgreSQL, MySQL, SQLite), a pedir
 * credenciales y a fallar en cuanto la base de datos no esté levantada. En su lugar se lee lo que
 * ya está en el repositorio: los archivos de migración, que describen exactamente el esquema que
 * el proyecto va a crear.
 *
 * A cambio hay que asumir dos límites, y el panel los dice:
 *  - lo que se ve es el esquema **según las migraciones**, no según el servidor;
 *  - una migración con SQL crudo (`migrationBuilder.Sql("...")`) es opaca y se marca como tal.
 *
 * Todo es función pura sobre el texto del `.cs`: no hay E/S ni dependencias.
 */

// ---------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------

export interface SchemaColumn {
  name: string;
  /** Tipo CLR del genérico: `table.Column<string>` -> `string`. */
  clrType: string;
  /** Tipo del motor tal cual lo escribe la migración (`nvarchar(max)`, `TEXT`). */
  storeType: string | null;
  nullable: boolean;
  maxLength: number | null;
  primaryKey: boolean;
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
}

export interface DatabaseSchema {
  tables: SchemaTable[];
  /** Migraciones que se han leído para construirlo. */
  migrations: number;
  /** Migraciones que ejecutan SQL crudo: su efecto no se puede deducir del archivo. */
  opaqueMigrations: string[];
}

export const EMPTY_SCHEMA: DatabaseSchema = { tables: [], migrations: 0, opaqueMigrations: [] };

/** Operación de una migración, ya normalizada. */
export type SchemaOperation =
  | { kind: 'create-table'; table: string; columns: SchemaColumn[] }
  | { kind: 'drop-table'; table: string }
  | { kind: 'rename-table'; table: string; newName: string }
  | { kind: 'add-column'; table: string; column: SchemaColumn }
  | { kind: 'drop-column'; table: string; column: string }
  | { kind: 'rename-column'; table: string; column: string; newName: string }
  | { kind: 'create-index'; table: string; index: SchemaIndex }
  | { kind: 'primary-key'; table: string; columns: string[] }
  | { kind: 'raw-sql' };

// ---------------------------------------------------------------------------------------------
// Lectura del texto
// ---------------------------------------------------------------------------------------------

/**
 * Contenido entre paréntesis, llaves o corchetes equilibrados, empezando por la apertura.
 *
 * Cuenta la profundidad y respeta cadenas y caracteres: `Sql("insert into T values (')')")`
 * tiene un paréntesis dentro de una cadena y contarlo rompería el resto del archivo.
 */
export function readBalanced(text: string, openIndex: number): { body: string; end: number } | null {
  const open = text[openIndex];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : null;
  if (close === null) return null;

  let depth = 0;
  let inString: '"' | "'" | null = null;
  let verbatim = false;

  for (let i = openIndex; i < text.length; i++) {
    const char = text[i]!;

    if (inString) {
      if (char === '\\' && !verbatim) i++;
      else if (char === inString) inString = null;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = char;
      verbatim = text[i - 1] === '@';
      continue;
    }

    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return { body: text.slice(openIndex + 1, i), end: i };
    }
  }

  return null;
}

/** Trocea una lista de argumentos por las comas de nivel cero. */
export function splitArguments(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let current = '';

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;

    if (inString) {
      current += char;
      if (char === '\\') {
        current += body[i + 1] ?? '';
        i++;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '{' || char === '[') depth++;
    if (char === ')' || char === '}' || char === ']') depth--;

    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** Argumentos con nombre (`name: "Products"`) de una llamada, indexados por nombre. */
export function namedArguments(body: string): Map<string, string> {
  const named = new Map<string, string>();

  for (const part of splitArguments(body)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(part);
    if (match) named.set(match[1]!, match[2]!.trim());
  }

  return named;
}

/** Valor de una cadena literal de C#, sin comillas. Devuelve null si no lo es. */
export function stringLiteral(expression: string): string | null {
  const trimmed = expression.trim();
  const match = /^@?"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : null;
}

/** Lista de cadenas (`new[] { "A", "B" }`) o una sola cadena. */
export function stringList(expression: string): string[] {
  const single = stringLiteral(expression);
  if (single !== null) return [single];

  const open = expression.indexOf('{');
  if (open === -1) return [];

  const block = readBalanced(expression, open);
  if (!block) return [];

  return splitArguments(block.body)
    .map((entry) => stringLiteral(entry))
    .filter((entry): entry is string => entry !== null);
}

// ---------------------------------------------------------------------------------------------
// Operaciones de una migración
// ---------------------------------------------------------------------------------------------

/** Cuerpo del método `Up` de una migración. Si no está, se devuelve el archivo entero. */
export function upMethodBody(source: string): string {
  const signature = /protected\s+override\s+void\s+Up\s*\(/.exec(source);
  if (!signature) return source;

  const brace = source.indexOf('{', signature.index + signature[0].length);
  if (brace === -1) return source;

  return readBalanced(source, brace)?.body ?? source;
}

function parseColumnCall(name: string, expression: string): SchemaColumn | null {
  const generic = /table\.Column\s*<([^>]+)>\s*\(/.exec(expression) ?? /\.Column\s*<([^>]+)>\s*\(/.exec(expression);
  if (!generic) return null;

  const open = expression.indexOf('(', generic.index + generic[0].length - 1);
  const block = readBalanced(expression, open);
  const args = block ? namedArguments(block.body) : new Map<string, string>();

  const maxLength = args.get('maxLength');

  return {
    name,
    clrType: generic[1]!.trim(),
    storeType: stringLiteral(args.get('type') ?? ''),
    // EF escribe siempre `nullable:`; si faltara, lo prudente es asumir que admite nulos.
    nullable: (args.get('nullable') ?? 'true').trim() !== 'false',
    maxLength: maxLength !== undefined && /^\d+$/.test(maxLength.trim()) ? Number(maxLength.trim()) : null,
    primaryKey: false,
  };
}

/** Columnas del bloque `columns: table => new { Id = table.Column<int>(...), ... }`. */
function parseColumnsBlock(expression: string): SchemaColumn[] {
  const open = expression.indexOf('{');
  if (open === -1) return [];

  const block = readBalanced(expression, open);
  if (!block) return [];

  return splitArguments(block.body)
    .map((entry) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(entry);
      return match ? parseColumnCall(match[1]!, match[2]!) : null;
    })
    .filter((column): column is SchemaColumn => column !== null);
}

/** Columnas de la clave primaria declarada en `constraints: table => { table.PrimaryKey(...); }`. */
function parsePrimaryKey(expression: string): string[] {
  const call = /table\.PrimaryKey\s*\(/.exec(expression);
  if (!call) return [];

  const block = readBalanced(expression, expression.indexOf('(', call.index + call[0].length - 1));
  if (!block) return [];

  const args = splitArguments(block.body);
  // `table.PrimaryKey("PK_Products", x => x.Id)` o `x => new { x.OrderId, x.LineId }`.
  const selector = args[1] ?? '';
  const properties = [...selector.matchAll(/[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => match[1]!)
    // El parámetro del lambda (`x`) aparece antes del punto, no después: no se cuela.
    .filter((property) => property !== '');

  return properties;
}

/**
 * Operaciones de una migración, en orden de aparición dentro de `Up`.
 *
 * Se reconocen las que cambian la forma del esquema. Lo que no se reconoce se ignora salvo
 * `Sql(...)`, que se marca como opaco porque puede haber cambiado cualquier cosa.
 */
export function parseMigrationOperations(source: string): SchemaOperation[] {
  const body = upMethodBody(source);
  const operations: SchemaOperation[] = [];

  const pattern = /migrationBuilder\.([A-Za-z]+)\s*(?:<[^>]+>\s*)?\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    const method = match[1]!;
    const open = body.indexOf('(', match.index + match[0].length - 1);
    const block = readBalanced(body, open);
    if (!block) continue;

    // Se sigue buscando después de la llamada: los argumentos pueden contener otras llamadas.
    pattern.lastIndex = block.end;

    const args = namedArguments(block.body);
    const positional = splitArguments(block.body);
    const nameOf = (key: string): string | null =>
      stringLiteral(args.get(key) ?? '') ?? (args.size === 0 ? stringLiteral(positional[0] ?? '') : null);

    if (method === 'Sql') {
      operations.push({ kind: 'raw-sql' });
      continue;
    }

    if (method === 'CreateTable') {
      const table = nameOf('name');
      if (table === null) continue;

      const columns = parseColumnsBlock(args.get('columns') ?? '');
      const keyColumns = new Set(parsePrimaryKey(args.get('constraints') ?? ''));
      operations.push({
        kind: 'create-table',
        table,
        columns: columns.map((column) => ({ ...column, primaryKey: keyColumns.has(column.name) })),
      });
      continue;
    }

    if (method === 'DropTable') {
      const table = nameOf('name');
      if (table !== null) operations.push({ kind: 'drop-table', table });
      continue;
    }

    if (method === 'RenameTable') {
      const table = nameOf('name');
      const newName = stringLiteral(args.get('newName') ?? '');
      if (table !== null && newName !== null) operations.push({ kind: 'rename-table', table, newName });
      continue;
    }

    if (method === 'AddColumn') {
      const table = stringLiteral(args.get('table') ?? '');
      const name = stringLiteral(args.get('name') ?? '');
      const generic = /migrationBuilder\.AddColumn\s*<([^>]+)>/.exec(body.slice(match.index, open + 1));
      if (table === null || name === null) continue;

      const maxLength = args.get('maxLength');
      operations.push({
        kind: 'add-column',
        table,
        column: {
          name,
          clrType: generic ? generic[1]!.trim() : 'object',
          storeType: stringLiteral(args.get('type') ?? ''),
          nullable: (args.get('nullable') ?? 'true').trim() !== 'false',
          maxLength: maxLength !== undefined && /^\d+$/.test(maxLength.trim()) ? Number(maxLength.trim()) : null,
          primaryKey: false,
        },
      });
      continue;
    }

    if (method === 'DropColumn') {
      const table = stringLiteral(args.get('table') ?? '');
      const column = stringLiteral(args.get('name') ?? '');
      if (table !== null && column !== null) operations.push({ kind: 'drop-column', table, column });
      continue;
    }

    if (method === 'RenameColumn') {
      const table = stringLiteral(args.get('table') ?? '');
      const column = stringLiteral(args.get('name') ?? '');
      const newName = stringLiteral(args.get('newName') ?? '');
      if (table !== null && column !== null && newName !== null) {
        operations.push({ kind: 'rename-column', table, column, newName });
      }
      continue;
    }

    if (method === 'CreateIndex') {
      const table = stringLiteral(args.get('table') ?? '');
      const name = stringLiteral(args.get('name') ?? '');
      if (table === null || name === null) continue;

      const columns = stringList(args.get('columns') ?? args.get('column') ?? '');
      operations.push({
        kind: 'create-index',
        table,
        index: { name, columns, unique: (args.get('unique') ?? 'false').trim() === 'true' },
      });
      continue;
    }

    if (method === 'AddPrimaryKey') {
      const table = stringLiteral(args.get('table') ?? '');
      if (table === null) continue;
      operations.push({ kind: 'primary-key', table, columns: stringList(args.get('columns') ?? args.get('column') ?? '') });
    }
  }

  return operations;
}

// ---------------------------------------------------------------------------------------------
// Esquema resultante
// ---------------------------------------------------------------------------------------------

export interface MigrationSource {
  /** Identificador de la migración, para poder decir cuál es opaca. */
  id: string;
  source: string;
}

/**
 * Aplica las migraciones **en el orden recibido** y devuelve el esquema resultante.
 *
 * Quien llama debe ordenarlas por identificador: el orden es el que da sentido a un `AddColumn`
 * sobre una tabla creada tres migraciones antes.
 */
export function buildSchema(migrations: readonly MigrationSource[]): DatabaseSchema {
  const tables = new Map<string, SchemaTable>();
  const opaque: string[] = [];

  for (const migration of migrations) {
    for (const operation of parseMigrationOperations(migration.source)) {
      switch (operation.kind) {
        case 'raw-sql':
          if (!opaque.includes(migration.id)) opaque.push(migration.id);
          break;

        case 'create-table':
          tables.set(operation.table, { name: operation.table, columns: operation.columns, indexes: [] });
          break;

        case 'drop-table':
          tables.delete(operation.table);
          break;

        case 'rename-table': {
          const table = tables.get(operation.table);
          if (table) {
            tables.delete(operation.table);
            tables.set(operation.newName, { ...table, name: operation.newName });
          }
          break;
        }

        case 'add-column': {
          const table = tables.get(operation.table);
          if (table && !table.columns.some((column) => column.name === operation.column.name)) {
            table.columns.push(operation.column);
          }
          break;
        }

        case 'drop-column': {
          const table = tables.get(operation.table);
          if (table) table.columns = table.columns.filter((column) => column.name !== operation.column);
          break;
        }

        case 'rename-column': {
          const column = tables.get(operation.table)?.columns.find((entry) => entry.name === operation.column);
          if (column) column.name = operation.newName;
          break;
        }

        case 'create-index': {
          const table = tables.get(operation.table);
          if (table && !table.indexes.some((index) => index.name === operation.index.name)) {
            table.indexes.push(operation.index);
          }
          break;
        }

        case 'primary-key': {
          const table = tables.get(operation.table);
          if (table) {
            for (const column of table.columns) {
              if (operation.columns.includes(column.name)) column.primaryKey = true;
            }
          }
          break;
        }
      }
    }
  }

  return {
    tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    migrations: migrations.length,
    opaqueMigrations: opaque,
  };
}

/** Descripción corta de una columna para la fila del panel: `nvarchar(200), null`. */
export function describeColumn(column: SchemaColumn): string {
  const parts = [column.storeType ?? column.clrType];
  if (column.maxLength !== null && column.storeType === null) parts.push(`max ${column.maxLength}`);
  parts.push(column.nullable ? 'null' : 'not null');
  return parts.join(', ');
}
