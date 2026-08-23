/**
 * Pruebas del toolchain .NET del proceso principal: parseo de soluciones y proyectos, y
 * traducción de la salida de MSBuild a diagnósticos.
 *
 * Las fixtures de solución no se escriben a mano: se generan con el propio scaffolder, así que
 * estas pruebas también verifican que lo que produce el generador es legible por el explorador.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSolution } from '../../build/scaffold.mjs';
import {
  detectApplicationUrl,
  findSolutionFile,
  languageIdFor,
  loadSolution,
  parseMsBuildDiagnostics,
  summarize,
} from '../../build/main-lib.mjs';

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'build');

let workspace;
let generated;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dfsln-'));
  generated = await generateSolution(
    {
      architecture: 'ddd',
      solutionName: 'Fx.Shop',
      outputDir: workspace,
      ui: 'both',
      framework: 'net9.0',
      db: 'sqlite',
      entity: 'Product',
      includeTests: true,
      force: true,
      gitInit: false,
    },
    buildDir,
  );
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('carga de la solución', () => {
  it('encuentra el archivo .sln', async () => {
    const found = await findSolutionFile(generated.rootDir);
    assert.ok(found?.endsWith('Fx.Shop.sln'), `encontrado: ${found}`);
  });

  it('lee todos los proyectos declarados', async () => {
    const solution = await loadSolution(generated.rootDir);

    assert.equal(solution.name, 'Fx.Shop');
    assert.equal(solution.format, 'sln');
    assert.equal(solution.projects.length, generated.projects.length);
    assert.deepEqual(solution.warnings, []);
  });

  it('agrupa los proyectos por carpeta de solución', async () => {
    const solution = await loadSolution(generated.rootDir);
    const folders = new Set(solution.projects.map((project) => project.solutionFolder));

    assert.ok(folders.has('1-Domain'), `carpetas: ${[...folders].join(', ')}`);
    assert.ok(folders.has('2-Application'));
  });

  it('extrae el target framework de cada .csproj', async () => {
    const solution = await loadSolution(generated.rootDir);

    for (const project of solution.projects) {
      assert.deepEqual(
        project.targetFrameworks,
        ['net9.0'],
        `${project.name}: ${project.targetFrameworks.join(',')}`,
      );
    }
  });

  it('detecta los proyectos web y los de pruebas', async () => {
    const solution = await loadSolution(generated.rootDir);

    const web = solution.projects.filter((project) => project.isWebProject).map((project) => project.name);
    const tests = solution.projects.filter((project) => project.isTestProject).map((project) => project.name);

    assert.deepEqual(web.sort(), ['Fx.Shop.Blazor', 'Fx.Shop.WebApi']);
    assert.deepEqual(tests, ['Fx.Shop.UnitTests']);
  });

  it('resuelve las referencias entre proyectos', async () => {
    const solution = await loadSolution(generated.rootDir);
    const application = solution.projects.find((project) => project.name === 'Fx.Shop.Application');

    assert.ok(application);
    assert.deepEqual(
      application.projectReferences.map((reference) => reference.name),
      ['Fx.Shop.Domain'],
    );
  });

  it('lee las referencias de paquete y marca las de gestión centralizada', async () => {
    const solution = await loadSolution(generated.rootDir);
    const infrastructure = solution.projects.find((project) => project.name === 'Fx.Shop.Infrastructure');

    assert.ok(infrastructure);
    assert.ok(infrastructure.packageReferences.length >= 3);

    // Las plantillas usan Central Package Management: los .csproj no llevan Version.
    assert.ok(
      infrastructure.packageReferences.every((reference) => reference.centrallyManaged),
      'se esperaba gestión centralizada de versiones',
    );
  });

  it('lee el manifiesto dotforge.json', async () => {
    const solution = await loadSolution(generated.rootDir);

    assert.ok(solution.generatedBy);
    assert.equal(solution.generatedBy.architecture, 'ddd');
    assert.equal(solution.generatedBy.entity, 'Product');
  });

  it('avisa, en vez de fallar, si un proyecto declarado no existe', async () => {
    const broken = join(workspace, 'roto');
    await rm(broken, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(broken, { recursive: true });

    await writeFile(
      join(broken, 'Roto.sln'),
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Fantasma", "src\\Fantasma\\Fantasma.csproj", "{11111111-1111-4111-8111-111111111111}"',
        'EndProject',
        'Global',
        'EndGlobal',
      ].join('\r\n'),
      'utf8',
    );

    const solution = await loadSolution(broken);
    assert.equal(solution.projects.length, 0);
    assert.equal(solution.warnings.length, 1);
    assert.match(solution.warnings[0], /falta en disco/);
  });

  it('funciona sin .sln, descubriendo los .csproj', async () => {
    const solution = await loadSolution(join(generated.rootDir, 'src'));

    assert.equal(solution.format, 'none');
    assert.ok(solution.projects.length >= 4, `proyectos: ${solution.projects.length}`);
  });
});

describe('diagnósticos de MSBuild', () => {
  it('parsea un error con archivo, línea y columna', () => {
    const [diagnostic] = parseMsBuildDiagnostics(
      'C:\\a\\Program.cs(12,9): error CS1061: falta un método [C:\\a\\App.csproj]',
    );

    assert.equal(diagnostic.file, 'C:\\a\\Program.cs');
    assert.equal(diagnostic.line, 12);
    assert.equal(diagnostic.column, 9);
    assert.equal(diagnostic.severity, 'error');
    assert.equal(diagnostic.code, 'CS1061');
    assert.equal(diagnostic.message, 'falta un método');
    assert.equal(diagnostic.project, 'C:\\a\\App.csproj');
  });

  it('parsea una advertencia sin columna', () => {
    const [diagnostic] = parseMsBuildDiagnostics('/x/App.cs(3): warning CS0168: variable sin usar');

    assert.equal(diagnostic.severity, 'warning');
    assert.equal(diagnostic.line, 3);
    assert.equal(diagnostic.column, 0);
  });

  it('parsea un error sin archivo', () => {
    const [diagnostic] = parseMsBuildDiagnostics('error NETSDK1045: el SDK no soporta este framework');

    assert.equal(diagnostic.file, null);
    assert.equal(diagnostic.code, 'NETSDK1045');
  });

  it('entiende la salida localizada al español', () => {
    const [diagnostic] = parseMsBuildDiagnostics('/x/App.cs(1,1): advertencia CS0219: valor no usado');
    assert.equal(diagnostic.severity, 'warning');
  });

  it('elimina duplicados: MSBuild repite cada diagnóstico en el resumen', () => {
    const line = 'C:\\a\\Program.cs(12,9): error CS1061: falta un método [C:\\a\\App.csproj]';
    const diagnostics = parseMsBuildDiagnostics([line, line, line].join('\n'));

    assert.equal(diagnostics.length, 1);
  });

  it('ignora las líneas que no son diagnósticos', () => {
    const output = [
      'Determinando los proyectos que se van a restaurar...',
      '  App -> C:\\a\\bin\\Debug\\net9.0\\App.dll',
      'Compilación correcta.',
      '    0 Advertencia(s)',
    ].join('\n');

    assert.deepEqual(parseMsBuildDiagnostics(output), []);
  });

  it('cuenta errores y advertencias por separado', () => {
    const diagnostics = parseMsBuildDiagnostics(
      [
        '/x/A.cs(1,1): error CS0001: uno',
        '/x/B.cs(2,2): warning CS0002: dos',
        '/x/C.cs(3,3): warning CS0003: tres',
      ].join('\n'),
    );

    assert.deepEqual(summarize(diagnostics), { errors: 1, warnings: 2 });
  });
});

describe('detección de la URL de la aplicación', () => {
  it('reconoce la salida de Kestrel en inglés', () => {
    assert.equal(
      detectApplicationUrl('info: Now listening on: http://localhost:5123\nmás salida'),
      'http://localhost:5123',
    );
  });

  it('reconoce la salida en español', () => {
    assert.equal(detectApplicationUrl('Escuchando en: https://localhost:7043'), 'https://localhost:7043');
  });

  it('recorta la puntuación final', () => {
    assert.equal(detectApplicationUrl('Now listening on: http://localhost:5000.'), 'http://localhost:5000');
  });

  it('devuelve null si no hay URL', () => {
    assert.equal(detectApplicationUrl('Compilación correcta.'), null);
  });
});

describe('detección de lenguaje por extensión', () => {
  const cases = [
    ['Program.cs', 'csharp'],
    ['Index.razor', 'razor'],
    ['View.cshtml', 'razor'],
    ['App.csproj', 'xml'],
    ['Directory.Packages.props', 'xml'],
    ['appsettings.json', 'json'],
    ['README.md', 'markdown'],
    ['ci.yml', 'yaml'],
    ['app.css', 'css'],
    ['Acme.sln', 'ini'],
    ['.editorconfig', 'ini'],
    ['Dockerfile', 'dockerfile'],
    ['algo.desconocido', 'plaintext'],
  ];

  for (const [file, expected] of cases) {
    it(`${file} -> ${expected}`, () => {
      assert.equal(languageIdFor(file), expected);
    });
  }
});
