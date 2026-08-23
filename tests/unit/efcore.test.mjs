/**
 * Pruebas del gestor de Entity Framework Core.
 *
 * Dos bloques bien distintos:
 *
 *  - el **parseo de la salida de `dotnet ef`**, que llega envuelta en las líneas del build y que
 *    sólo es fiable por su bloque JSON;
 *  - el **esquema deducido de las migraciones**, que es análisis de texto de C# generado y donde
 *    están todos los casos borde: paréntesis dentro de cadenas, claves compuestas, columnas
 *    añadidas tres migraciones después de la tabla y migraciones con SQL crudo.
 *
 * Las dos cosas son funciones puras: se prueban con Node pelado, sin SDK y sin base de datos.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSchema,
  describeColumn,
  describeConnection,
  detectProvider,
  efArgs,
  EF_OPERATIONS,
  extractJsonBlock,
  isValidMigrationName,
  maskConnectionString,
  migrationName,
  migrationTimestamp,
  namedArguments,
  parseConnectionStrings,
  parseDbContexts,
  parseMigrations,
  parseMigrationOperations,
  readBalanced,
  splitArguments,
  stringList,
  stringLiteral,
  stripJsonComments,
  upMethodBody,
} from '../../build/ui-lib.mjs';

/** Salida realista: EF compila el proyecto antes y escribe el JSON entre marcas. */
const LIST_OUTPUT = `Build started...
Build succeeded.
//BEGIN
[
  { "id": "20260101120000_InitialCreate", "name": "InitialCreate", "safeName": "InitialCreate", "applied": true },
  { "id": "20260210093000_AddSku", "name": "AddSku", "safeName": "AddSku", "applied": false }
]
//END
`;

describe('salida de dotnet ef', () => {
  it('extrae el bloque JSON de entre las líneas del build', () => {
    const block = extractJsonBlock(LIST_OUTPUT);
    assert.ok(block.startsWith('['));
    assert.equal(JSON.parse(block).length, 2);
  });

  it('devuelve null cuando no hay bloque', () => {
    assert.equal(extractJsonBlock('Build started...\nBuild FAILED.\n'), null);
  });

  it('cuenta aplicadas y pendientes', () => {
    const list = parseMigrations(LIST_OUTPUT);
    assert.equal(list.migrations.length, 2);
    assert.equal(list.applied, 1);
    assert.equal(list.pending, 1);
    assert.equal(list.degraded, false);
  });

  it('rellena el nombre y la fecha a partir del identificador', () => {
    const [first] = parseMigrations(LIST_OUTPUT).migrations;
    assert.equal(first.name, 'InitialCreate');
    assert.equal(first.timestampUtc, '2026-01-01T12:00:00.000Z');
  });

  it('cae al texto plano si no hay JSON y lo marca como degradado', () => {
    const list = parseMigrations('20260101120000_InitialCreate\n20260210093000_AddSku (Pending)\n');
    assert.equal(list.applied, 1);
    assert.equal(list.pending, 1);
    assert.equal(list.degraded, true);
  });

  it('un JSON mal formado no revienta el panel', () => {
    const list = parseMigrations('//BEGIN\n[ {,, ]\n//END');
    assert.deepEqual(list.migrations, []);
  });

  it('un identificador sin marca de tiempo se queda tal cual', () => {
    assert.equal(migrationName('InitialCreate'), 'InitialCreate');
    assert.equal(migrationTimestamp('InitialCreate'), null);
  });

  it('lee los DbContext', () => {
    const contexts = parseDbContexts(
      '//BEGIN\n[{"fullName":"Acme.Shop.Infrastructure.ShopDbContext","safeName":"ShopDbContext","name":"ShopDbContext"}]\n//END',
    );
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].name, 'ShopDbContext');
  });

  it('sin bloque JSON no hay contextos, y no es un error', () => {
    assert.deepEqual(parseDbContexts('No project was found.'), []);
  });
});

describe('argumentos de dotnet ef', () => {
  it('lista migraciones en JSON con proyecto y proyecto de arranque', () => {
    assert.deepEqual(
      efArgs('migrations-list', { project: 'C:/s/Infra/Infra.csproj', startupProject: 'C:/s/Api/Api.csproj' }),
      [
        'ef', 'migrations', 'list', '--json',
        '--project', 'C:/s/Infra/Infra.csproj',
        '--startup-project', 'C:/s/Api/Api.csproj',
      ],
    );
  });

  it('añade --context sólo cuando se pide uno', () => {
    const withContext = efArgs('database-update', { project: 'p.csproj', context: 'ShopDbContext' });
    assert.ok(withContext.includes('--context'));
    assert.equal(efArgs('database-update', { project: 'p.csproj' }).includes('--context'), false);
  });

  it('la migración objetivo va suelta detrás de "database update"', () => {
    const args = efArgs('database-update', { project: 'p.csproj', targetMigration: '20260101120000_InitialCreate' });
    assert.deepEqual(args.slice(0, 4), ['ef', 'database', 'update', '20260101120000_InitialCreate']);
  });

  it('quitar una migración aplicada exige --force', () => {
    assert.ok(efArgs('migrations-remove', { project: 'p.csproj', force: true }).includes('--force'));
    assert.equal(efArgs('migrations-remove', { project: 'p.csproj' }).includes('--force'), false);
  });

  it('rechaza un nombre de migración que no es un identificador de C#', () => {
    assert.throws(() => efArgs('migrations-add', { project: 'p.csproj', name: 'add products; rm -rf /' }));
    assert.throws(() => efArgs('migrations-add', { project: 'p.csproj', name: '9Migration' }));
    assert.equal(isValidMigrationName('Add_Products2'), true);
    assert.equal(isValidMigrationName(''), false);
  });

  it('todas las operaciones declaradas construyen argumentos', () => {
    for (const operation of EF_OPERATIONS) {
      const args = efArgs(operation, { project: 'p.csproj', name: 'Init' });
      assert.equal(args[0], 'ef');
      assert.ok(args.includes('--project'));
    }
  });
});

describe('cadenas de conexión', () => {
  const appsettings = `{
  // El de desarrollo apunta a un contenedor local.
  "ConnectionStrings": {
    "Default": "Server=localhost,1433;Database=AcmeShop;User Id=sa;Password=Sup3rSecreto!;TrustServerCertificate=True",
    "Sqlite": "Data Source=acme.db",
    "Reporting": "Host=localhost;Port=5432;Database=reporting;Username=postgres;Password=postgres",
  },
  "Logging": { "LogLevel": { "Default": "Information" } }
}`;

  it('lee el JSON aunque tenga comentarios y comas colgantes', () => {
    const connections = parseConnectionStrings(appsettings);
    assert.deepEqual(connections.map((entry) => entry.name), ['Default', 'Sqlite', 'Reporting']);
  });

  it('deduce el proveedor por las claves de la cadena', () => {
    assert.equal(detectProvider('Server=localhost;Database=Acme;User Id=sa;Password=x'), 'sqlserver');
    assert.equal(detectProvider('Data Source=acme.db'), 'sqlite');
    assert.equal(detectProvider('Host=localhost;Database=reporting;Username=postgres'), 'postgres');
    assert.equal(detectProvider('algo que no es una cadena de conexión'), 'unknown');
  });

  it('extrae servidor y base de datos', () => {
    const info = describeConnection('Default', 'Server=localhost,1433;Database=AcmeShop;User Id=sa;Password=x');
    assert.equal(info.server, 'localhost,1433');
    assert.equal(info.database, 'AcmeShop');
  });

  it('SQLite no tiene servidor y su base de datos es el archivo', () => {
    const info = describeConnection('Sqlite', 'Data Source=acme.db');
    assert.equal(info.server, null);
    assert.equal(info.database, 'acme.db');
  });

  it('tapa la contraseña: la cadena se pinta en la interfaz', () => {
    const masked = maskConnectionString('Server=localhost;Database=Acme;User Id=sa;Password=Sup3rSecreto!');
    assert.equal(masked.includes('Sup3rSecreto'), false);
    assert.ok(masked.includes('Password=********'));
    // Lo demás se conserva intacto: sirve para reconocer la conexión.
    assert.ok(masked.includes('Database=Acme'));
  });

  it('un appsettings sin ConnectionStrings devuelve una lista vacía, no un error', () => {
    assert.deepEqual(parseConnectionStrings('{ "Logging": {} }'), []);
    assert.deepEqual(parseConnectionStrings('esto no es json'), []);
  });

  it('los comentarios dentro de una cadena no se tocan', () => {
    const text = stripJsonComments('{ "url": "https://acme.test//api", "x": 1 }');
    assert.ok(text.includes('https://acme.test//api'));
  });
});

// ---------------------------------------------------------------------------------------------
// Esquema deducido de las migraciones
// ---------------------------------------------------------------------------------------------

const CREATE_MIGRATION = `using Microsoft.EntityFrameworkCore.Migrations;

public partial class InitialCreate : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Products",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                Price = table.Column<decimal>(type: "decimal(18,2)", nullable: false),
                Notes = table.Column<string>(type: "nvarchar(max)", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Products", x => x.Id);
            });

        migrationBuilder.CreateIndex(
            name: "IX_Products_Name",
            table: "Products",
            column: "Name",
            unique: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "Products");
    }
}`;

const ALTER_MIGRATION = `public partial class AddSku : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "Sku",
            table: "Products",
            type: "nvarchar(32)",
            maxLength: 32,
            nullable: true);

        migrationBuilder.DropColumn(name: "Notes", table: "Products");

        migrationBuilder.RenameTable(name: "Products", newName: "CatalogItems");
    }
}`;

describe('lectura del C# de una migración', () => {
  it('encuentra el cierre correcto aunque haya paréntesis dentro de una cadena', () => {
    const source = `Sql("insert into T values (')')")`;
    const block = readBalanced(source, source.indexOf('('));
    assert.equal(block.end, source.length - 1);
  });

  it('trocea argumentos por las comas de nivel cero', () => {
    assert.deepEqual(splitArguments('name: "A", columns: new[] { "x", "y" }, unique: true'), [
      'name: "A"',
      'columns: new[] { "x", "y" }',
      'unique: true',
    ]);
  });

  it('indexa los argumentos con nombre', () => {
    const named = namedArguments('name: "Products", table: "Catalog"');
    assert.equal(stringLiteral(named.get('name')), 'Products');
    assert.equal(stringLiteral(named.get('table')), 'Catalog');
  });

  it('lee una lista de cadenas y una cadena suelta', () => {
    assert.deepEqual(stringList('new[] { "OrderId", "LineId" }'), ['OrderId', 'LineId']);
    assert.deepEqual(stringList('"Name"'), ['Name']);
  });

  it('sólo mira el método Up: el Down es la operación inversa', () => {
    const body = upMethodBody(CREATE_MIGRATION);
    assert.ok(body.includes('CreateTable'));
    assert.equal(body.includes('DropTable'), false);
  });
});

describe('esquema a partir de las migraciones', () => {
  it('crea la tabla con sus columnas, tipos y nulabilidad', () => {
    const schema = buildSchema([{ id: 'InitialCreate', source: CREATE_MIGRATION }]);
    const [products] = schema.tables;

    assert.equal(products.name, 'Products');
    assert.deepEqual(products.columns.map((column) => column.name), ['Id', 'Name', 'Price', 'Notes']);

    const name = products.columns.find((column) => column.name === 'Name');
    assert.equal(name.storeType, 'nvarchar(200)');
    assert.equal(name.maxLength, 200);
    assert.equal(name.nullable, false);
    assert.equal(products.columns.find((column) => column.name === 'Notes').nullable, true);
  });

  it('marca la clave primaria declarada en las restricciones', () => {
    const [products] = buildSchema([{ id: 'InitialCreate', source: CREATE_MIGRATION }]).tables;
    assert.equal(products.columns.find((column) => column.name === 'Id').primaryKey, true);
    assert.equal(products.columns.find((column) => column.name === 'Name').primaryKey, false);
  });

  it('recoge los índices con su unicidad', () => {
    const [products] = buildSchema([{ id: 'InitialCreate', source: CREATE_MIGRATION }]).tables;
    assert.deepEqual(products.indexes, [{ name: 'IX_Products_Name', columns: ['Name'], unique: true }]);
  });

  it('aplica las migraciones en orden: añadir, quitar y renombrar', () => {
    const schema = buildSchema([
      { id: 'InitialCreate', source: CREATE_MIGRATION },
      { id: 'AddSku', source: ALTER_MIGRATION },
    ]);

    assert.deepEqual(schema.tables.map((table) => table.name), ['CatalogItems']);

    const columns = schema.tables[0].columns.map((column) => column.name);
    assert.ok(columns.includes('Sku'));
    assert.equal(columns.includes('Notes'), false);
  });

  it('una clave compuesta marca todas sus columnas', () => {
    const source = `protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "OrderLines",
            columns: table => new
            {
                OrderId = table.Column<Guid>(type: "TEXT", nullable: false),
                LineId = table.Column<int>(type: "INTEGER", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_OrderLines", x => new { x.OrderId, x.LineId });
            });
    }`;

    const [lines] = buildSchema([{ id: 'Lines', source }]).tables;
    assert.deepEqual(lines.columns.filter((column) => column.primaryKey).map((column) => column.name), [
      'OrderId',
      'LineId',
    ]);
  });

  it('una migración con SQL crudo se marca como opaca', () => {
    const source = `protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("update Products set Price = Price * 1.21");
    }`;

    const schema = buildSchema([{ id: '20260301_Vat', source }]);
    assert.deepEqual(schema.opaqueMigrations, ['20260301_Vat']);
  });

  it('un proyecto sin migraciones no tiene tablas y no falla', () => {
    const schema = buildSchema([]);
    assert.deepEqual(schema.tables, []);
    assert.equal(schema.migrations, 0);
  });

  it('describe la columna como se pinta en el panel', () => {
    const [products] = buildSchema([{ id: 'InitialCreate', source: CREATE_MIGRATION }]).tables;
    assert.equal(describeColumn(products.columns[0]), 'uniqueidentifier, not null');
    assert.equal(describeColumn(products.columns[3]), 'nvarchar(max), null');
  });

  it('reconoce las operaciones sueltas de una migración', () => {
    const kinds = parseMigrationOperations(ALTER_MIGRATION).map((operation) => operation.kind);
    assert.deepEqual(kinds, ['add-column', 'drop-column', 'rename-table']);
  });
});
