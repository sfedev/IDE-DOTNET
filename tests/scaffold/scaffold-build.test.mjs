/**
 * Prueba de integración del módulo estrella: genera soluciones reales y las compila con
 * `dotnet build`. Sin mocks. Si el .NET SDK no está instalado, la suite falla en vez de saltarse:
 * un generador de soluciones .NET que nunca se comprueba contra el SDK no está probado.
 *
 * Las soluciones se generan en un directorio temporal corto para no chocar con el límite de
 * 260 caracteres de rutas en Windows.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSolution } from '../../build/scaffold.mjs';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = join(root, 'build');

/** Compilar una solución .NET con restauración de paquetes tarda; margen amplio y explícito. */
const DOTNET_TIMEOUT_MS = 15 * 60 * 1000;

const SKIP_DOTNET = process.env.DOTFORGE_SKIP_DOTNET === '1';

let workspace;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dfts-'));
});

after(() => {
  if (workspace && !process.env.DOTFORGE_KEEP_OUTPUT) {
    rmSync(workspace, { recursive: true, force: true });
  } else if (workspace) {
    console.log(`[scaffold] salida conservada en ${workspace}`);
  }
});

async function dotnet(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('dotnet', args, {
      cwd,
      timeout: DOTNET_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    return {
      code: error.code ?? 1,
      output: `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`,
    };
  }
}

function summarizeFailure(output) {
  const lines = output.split(/\r?\n/).filter((line) => /error|Error/.test(line));
  return lines.slice(0, 25).join('\n') || output.slice(-4000);
}

/** La matriz cubre las tres arquitecturas y las combinaciones de opciones que cambian el árbol. */
const MATRIX = [
  { id: 'clean-full', architecture: 'clean', ui: 'both', db: 'sqlite', entity: 'Product', includeTests: true },
  { id: 'hexagonal-full', architecture: 'hexagonal', ui: 'both', db: 'sqlite', entity: 'Device', includeTests: true },
  { id: 'ddd-full', architecture: 'ddd', ui: 'both', db: 'sqlite', entity: 'Invoice', includeTests: true },
  { id: 'clean-api-inmemory', architecture: 'clean', ui: 'webapi', db: 'inmemory', entity: 'Category', includeTests: false },
  { id: 'hexagonal-blazor', architecture: 'hexagonal', ui: 'blazor', db: 'inmemory', entity: 'Sensor', includeTests: false },
  { id: 'ddd-api-net10', architecture: 'ddd', ui: 'webapi', db: 'sqlite', entity: 'Order', includeTests: true, framework: 'net10.0' },
];

describe('generación de soluciones', () => {
  it('el bundle del generador está compilado', () => {
    assert.ok(
      existsSync(join(buildDir, 'scaffold.mjs')),
      'falta build/scaffold.mjs — ejecuta `npm run build` antes de los tests',
    );
    assert.ok(existsSync(join(buildDir, 'templates', '_common')), 'faltan las plantillas en build/templates');
  });

  it('rechaza un directorio no vacío sin --force', async () => {
    const target = join(workspace, 'conflicto');
    const options = {
      architecture: 'clean',
      solutionName: 'Dup',
      outputDir: target,
      ui: 'webapi',
      framework: 'net9.0',
      db: 'inmemory',
      entity: 'Thing',
      includeTests: false,
      force: false,
      gitInit: false,
    };

    await generateSolution(options, buildDir);
    await assert.rejects(() => generateSolution(options, buildDir), /no está vacío/);
    await generateSolution({ ...options, force: true }, buildDir);
  });

  it('rechaza un nombre de solución inválido antes de tocar el disco', async () => {
    await assert.rejects(
      () =>
        generateSolution(
          {
            architecture: 'clean',
            solutionName: 'Nombre Con Espacios',
            outputDir: join(workspace, 'invalido'),
            ui: 'webapi',
            framework: 'net9.0',
            db: 'inmemory',
            entity: 'Thing',
            includeTests: false,
            force: true,
            gitInit: false,
          },
          buildDir,
        ),
      /segmento inválido/,
    );
    assert.equal(existsSync(join(workspace, 'invalido')), false, 'no debe crear nada si la validación falla');
  });
});

for (const testCase of MATRIX) {
  describe(`${testCase.id}`, () => {
    let result;
    let solutionDir;

    it('genera la solución', async () => {
      const outputDir = join(workspace, testCase.id);
      result = await generateSolution(
        {
          architecture: testCase.architecture,
          solutionName: 'Df',
          outputDir,
          ui: testCase.ui,
          framework: testCase.framework ?? 'net9.0',
          db: testCase.db,
          entity: testCase.entity,
          includeTests: testCase.includeTests,
          force: true,
          gitInit: false,
        },
        buildDir,
      );

      solutionDir = result.rootDir;

      assert.equal(result.ok, true);
      assert.ok(result.files.length > 15, `sólo ${result.files.length} archivos generados`);
      assert.ok(result.projects.length >= 3, `sólo ${result.projects.length} proyectos`);
      assert.equal(result.warnings.length, 0, `avisos inesperados: ${result.warnings.join('; ')}`);
    });

    it('escribe el .sln y todos los .csproj declarados', () => {
      assert.ok(existsSync(result.solutionFile), `falta ${result.solutionFile}`);
      for (const project of result.projects) {
        assert.ok(
          existsSync(join(solutionDir, ...project.path.split('/'))),
          `falta el proyecto ${project.path}`,
        );
      }
    });

    it('escribe el manifiesto dotforge.json con las opciones usadas', () => {
      const manifest = JSON.parse(readFileSync(join(solutionDir, 'dotforge.json'), 'utf8'));
      assert.equal(manifest.architecture, testCase.architecture);
      assert.equal(manifest.entity, testCase.entity);
      assert.equal(manifest.framework, testCase.framework ?? 'net9.0');
      assert.equal(manifest.projects.length, result.projects.length);
    });

    it('genera un README.md didáctico y coherente con las opciones', () => {
      assert.ok(result.files.includes('README.md'), 'no se ha generado README.md en la raíz');

      const readme = readFileSync(join(solutionDir, 'README.md'), 'utf8');

      // 1. Introducción y diagrama visual: al menos el de dependencias y el del flujo.
      const mermaid = readme.match(/```mermaid/g) ?? [];
      assert.ok(mermaid.length >= 2, `sólo ${mermaid.length} diagramas Mermaid`);
      assert.match(readme, /```mermaid\r?\n(flowchart|graph)/, 'falta el diagrama de dependencias');
      assert.match(readme, /```mermaid\r?\n\s*sequenceDiagram/, 'falta el diagrama de flujo');

      // 2. Estructura y responsabilidades, con lo permitido y lo prohibido en cada capa.
      assert.match(readme, /Estructura y responsabilidades/i);
      assert.match(readme, /DEBE estar aquí/);
      assert.match(readme, /TIENE PROHIBIDO estar aquí/);
      assert.match(readme, /Dependencias permitidas/);

      // 3. Guía paso a paso para añadir una funcionalidad.
      assert.match(readme, /Paso 1 ·/);
      assert.match(readme, /Paso 5 ·/);
      assert.match(readme, /Checklist/i);

      // 4. Explicación del código de ejemplo incluido.
      assert.match(readme, /El ejemplo incluido, explicado/);

      // 5. Comandos útiles y pruebas.
      assert.match(readme, /dotnet build/);
      assert.match(readme, /dotnet restore/);

      // Coherencia con las opciones elegidas.
      assert.ok(readme.includes('Df'), 'el README no menciona el nombre de la solución');
      assert.ok(readme.includes(testCase.entity), 'el README no menciona la entidad de ejemplo');
      assert.ok(readme.includes(testCase.framework ?? 'net9.0'), 'el README no menciona el framework');

      const webProject = result.projects.find((project) => /(WebApi|Adapters\.Web)$/.test(project.name));
      const blazorProject = result.projects.find((project) => /Blazor$/.test(project.name));

      assert.equal(
        readme.includes(`dotnet run --project src/${webProject?.name ?? ' '}`),
        testCase.ui !== 'blazor',
        'la sección de comandos no coincide con la presentación generada',
      );
      assert.equal(
        readme.includes(`dotnet run --project src/${blazorProject?.name ?? ' '}`),
        testCase.ui !== 'webapi',
        'la sección de comandos no coincide con la presentación generada',
      );
      assert.equal(readme.includes('dotnet test'), testCase.includeTests, 'dotnet test mal condicionado');

      // Nunca debe hablar de un proyecto que no existe en esta solución.
      const nombres = new Set(result.projects.map((project) => project.name));
      for (const candidato of ['Df.WebApi', 'Df.Blazor', 'Df.Adapters.Web', 'Df.Adapters.Blazor', 'Df.UnitTests']) {
        if (nombres.has(candidato)) continue;
        assert.ok(
          !readme.includes(`src/${candidato}/`),
          `el README documenta ${candidato}, que no se ha generado`,
        );
      }
    });

    it('respeta las opciones de presentación y de pruebas', () => {
      const names = result.projects.map((project) => project.name);
      const tieneBlazor = names.some((name) => /Blazor$/.test(name));
      const tieneWeb = names.some((name) => /(WebApi|Adapters\.Web)$/.test(name));
      const tieneTests = names.some((name) => /UnitTests$/.test(name));

      assert.equal(tieneBlazor, testCase.ui !== 'webapi');
      assert.equal(tieneWeb, testCase.ui !== 'blazor');
      assert.equal(tieneTests, testCase.includeTests);
    });

    it('no deja ningún token ni directiva sin resolver en los archivos generados', () => {
      const sospechosos = [];
      for (const relative of result.files) {
        if (!/\.(cs|csproj|razor|json|props|md)$/.test(relative)) continue;
        const content = readFileSync(join(solutionDir, ...relative.split('/')), 'utf8');
        if (/\{\{\s*[#/]?[A-Za-z]/.test(content)) sospechosos.push(relative);
        if (/__[A-Za-z]+__/.test(content)) sospechosos.push(`${relative} (token de ruta)`);
      }
      assert.deepEqual(sospechosos, []);
    });

    it('el dominio no referencia infraestructura (regla de dependencia)', () => {
      const core = result.projects.find((project) => /\.(Domain|SharedKernel)$/.test(project.name));
      assert.ok(core, 'no se encuentra el proyecto de núcleo');

      const csproj = readFileSync(join(solutionDir, ...core.path.split('/')), 'utf8');
      assert.equal(/EntityFrameworkCore/.test(csproj), false, 'el núcleo referencia EF Core');
      assert.equal(/AspNetCore/.test(csproj), false, 'el núcleo referencia ASP.NET Core');
    });

    it(
      'compila con dotnet build sin errores ni advertencias',
      { skip: SKIP_DOTNET ? 'DOTFORGE_SKIP_DOTNET=1' : false, timeout: DOTNET_TIMEOUT_MS },
      async () => {
        const { code, output } = await dotnet(['build', '--nologo', '-v', 'quiet'], solutionDir);
        assert.equal(code, 0, `dotnet build falló:\n${summarizeFailure(output)}`);
        assert.match(output, /0 (Advertencia|Warning)/i, `hay advertencias:\n${summarizeFailure(output)}`);
      },
    );
  });
}

describe('las pruebas generadas pasan', () => {
  it(
    'dotnet test sobre una solución net10.0 con proyecto de pruebas',
    { skip: SKIP_DOTNET ? 'DOTFORGE_SKIP_DOTNET=1' : false, timeout: DOTNET_TIMEOUT_MS },
    async () => {
      // Se usa net10.0 porque es el runtime instalado: `dotnet build` de net9.0 funciona, pero
      // EJECUTAR las pruebas requiere tener el runtime del framework objetivo.
      const outputDir = join(workspace, 'run-tests');
      const generated = [];

      for (const architecture of ['clean', 'hexagonal', 'ddd']) {
        const result = await generateSolution(
          {
            architecture,
            solutionName: `T${architecture === 'clean' ? 'C' : architecture === 'ddd' ? 'D' : 'H'}`,
            outputDir,
            ui: 'webapi',
            framework: 'net10.0',
            db: 'inmemory',
            entity: 'Product',
            includeTests: true,
            force: true,
            gitInit: false,
          },
          buildDir,
        );
        generated.push({ architecture, dir: result.rootDir });
      }

      for (const { architecture, dir } of generated) {
        const { code, output } = await dotnet(['test', '--nologo'], dir);
        assert.equal(code, 0, `dotnet test falló en ${architecture}:\n${summarizeFailure(output)}`);
        assert.match(
          output,
          /(Correctas!|Passed!)/,
          `no se detecta resultado correcto en ${architecture}:\n${output.slice(-2000)}`,
        );
      }
    },
  );
});
