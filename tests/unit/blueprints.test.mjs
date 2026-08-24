/**
 * Invariantes estructurales de los blueprints.
 *
 * Estas pruebas son baratas y atrapan la clase de error más cara: un blueprint que declara un
 * proyecto sin plantilla de .csproj, una plantilla huérfana o un token inexistente. Sin ellas
 * el fallo aparecería mucho más tarde, en el `dotnet build`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHITECTURE_IDS,
  BLUEPRINTS,
  buildTemplateContext,
  getBlueprint,
  inspectTemplate,
  isArchitectureId,
  listBlueprints,
  packageVersionsFor,
  resolveOptions,
} from '../../build/scaffold.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const templatesRoot = join(root, 'src', 'scaffold', 'templates');

/**
 * Lee una plantilla con los saltos de línea normalizados a LF.
 *
 * Las aserciones de este archivo son expresiones regulares que llevan un salto de línea dentro
 * —el diagrama Mermaid se busca como la valla de código seguida de `flowchart`— y comparaciones
 * literales. En un clon de Windows con `core.autocrlf`, el archivo llega con CRLF y esos patrones
 * dejan de casar: pasó en la primera ejecución del pipeline sobre el tag v2.1.0, y sólo en Windows.
 * El `.gitattributes` fuerza LF en el árbol de trabajo, y esto hace además que la prueba no dependa
 * de la configuración de git de quien la ejecute.
 */
function readTemplate(file) {
  return readFileSync(file, 'utf8').replace(new RegExp(String.raw`\r\n`, 'g'), '\n');
}

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (entry.endsWith('.tmpl')) found.push(full);
  }
  return found;
}

const baseOptions = {
  architecture: 'clean',
  solutionName: 'Acme.Shop',
  outputDir: '.',
  ui: 'both',
  framework: 'net9.0',
  db: 'sqlite',
  entity: 'Product',
  includeTests: true,
  force: false,
  gitInit: false,
};

describe('registro de arquitecturas', () => {
  it('expone exactamente las tres arquitecturas del producto', () => {
    assert.deepEqual([...ARCHITECTURE_IDS].sort(), ['clean', 'ddd', 'hexagonal']);
  });

  it('isArchitectureId discrimina', () => {
    assert.ok(isArchitectureId('clean'));
    assert.ok(!isArchitectureId('microservicios'));
  });

  it('getBlueprint falla con un id desconocido', () => {
    assert.throws(() => getBlueprint('noexiste'), /arquitectura desconocida/);
  });

  it('listBlueprints devuelve metadatos completos y presentables', () => {
    for (const info of listBlueprints()) {
      assert.ok(info.title.length > 0, `${info.id}: sin título`);
      assert.ok(info.tagline.length > 0, `${info.id}: sin tagline`);
      assert.ok(info.description.length > 40, `${info.id}: descripción demasiado corta`);
      assert.ok(info.layers.length >= 3, `${info.id}: menos de 3 capas`);
      assert.ok(info.highlights.length >= 3, `${info.id}: menos de 3 puntos destacados`);
      assert.ok(info.patterns.length >= 3, `${info.id}: menos de 3 patrones`);
    }
  });

  it('las dependencias declaradas entre capas apuntan a capas existentes', () => {
    for (const info of listBlueprints()) {
      const names = new Set(info.layers.map((layer) => layer.name));
      for (const layer of info.layers) {
        for (const dependency of layer.dependsOn) {
          assert.ok(names.has(dependency), `${info.id}: ${layer.name} depende de "${dependency}", que no existe`);
        }
      }
    }
  });

  it('la primera capa de cada arquitectura es el núcleo y no depende de nadie', () => {
    for (const info of listBlueprints()) {
      assert.deepEqual(info.layers[0].dependsOn, [], `${info.id}: la capa base no debe depender de nada`);
    }
  });
});

describe('coherencia entre blueprints y plantillas', () => {
  for (const id of ARCHITECTURE_IDS) {
    const blueprint = BLUEPRINTS[id];

    it(`${id}: cada proyecto declarado tiene su plantilla de .csproj`, () => {
      const files = walk(join(templatesRoot, blueprint.templateDir)).map((file) =>
        file.replaceAll('\\', '/'),
      );

      for (const project of blueprint.projects) {
        const expected = `${blueprint.templateDir}/${project.dir}/${project.name}.csproj.tmpl`;
        assert.ok(
          files.some((file) => file.endsWith(expected.slice(blueprint.templateDir.length + 1))),
          `${id}: falta la plantilla ${expected}`,
        );
      }
    });

    it(`${id}: los nombres de proyecto empiezan por el token de solución`, () => {
      for (const project of blueprint.projects) {
        assert.ok(project.name.startsWith('__Solution__'), `${id}: ${project.name}`);
        assert.ok(project.dir.startsWith('src/') || project.dir.startsWith('tests/'), `${id}: ${project.dir}`);
      }
    });

    it(`${id}: la capa de cada proyecto está declarada en los metadatos`, () => {
      const layers = new Set([...blueprint.info.layers.map((layer) => layer.name), 'Tests']);
      for (const project of blueprint.projects) {
        assert.ok(layers.has(project.layer), `${id}: capa "${project.layer}" no declarada`);
      }
    });

    it(`${id}: includeFile respeta las opciones de presentación y pruebas`, () => {
      const soloApi = resolveOptions({ ...baseOptions, architecture: id, ui: 'webapi', includeTests: false });
      const soloBlazor = resolveOptions({ ...baseOptions, architecture: id, ui: 'blazor', includeTests: true });

      const blazorProject = blueprint.projects.find((project) => /Blazor$/.test(project.name));
      const webProject = blueprint.projects.find((project) => /(WebApi|Adapters\.Web)$/.test(project.name));

      assert.ok(blazorProject && webProject, `${id}: faltan proyectos de presentación`);

      assert.equal(blueprint.includeFile(`${blazorProject.dir}/Program.cs`, soloApi), false);
      assert.equal(blueprint.includeFile(`${webProject.dir}/Program.cs`, soloApi), true);
      assert.equal(blueprint.includeFile(`${blazorProject.dir}/Program.cs`, soloBlazor), true);
      assert.equal(blueprint.includeFile(`${webProject.dir}/Program.cs`, soloBlazor), false);
      assert.equal(blueprint.includeFile('tests/x/y.cs', soloApi), false);
      assert.equal(blueprint.includeFile('tests/x/y.cs', soloBlazor), true);
    });
  }
});

describe('README didáctico de cada arquitectura', () => {
  /** Secciones exigidas por el diseño del generador de documentación. */
  const SECCIONES = [
    /## 1\. La arquitectura en dos minutos/,
    /## 2\. Estructura y responsabilidades/,
    /## 3\. Guía paso a paso/,
    /## 4\. El ejemplo incluido, explicado/,
    /## 5\. Comandos útiles y pruebas/,
    /## 6\. Errores frecuentes/,
  ];

  for (const id of ARCHITECTURE_IDS) {
    const blueprint = BLUEPRINTS[id];
    const file = join(templatesRoot, blueprint.templateDir, 'README.md.tmpl');

    it(`${id}: la plantilla existe y cubre las seis secciones`, () => {
      const source = readTemplate(file);
      for (const seccion of SECCIONES) {
        assert.match(source, seccion, `${id}: falta la sección ${seccion}`);
      }
    });

    it(`${id}: incluye diagramas Mermaid de dependencias y de flujo`, () => {
      const source = readTemplate(file);
      assert.match(source, /```mermaid\n(flowchart|graph)/, `${id}: sin diagrama de dependencias`);
      assert.match(source, /```mermaid\nsequenceDiagram/, `${id}: sin diagrama de flujo`);
      // Mermaid usa {{texto}} para los nodos hexagonales, y el motor lo interpretaría como token.
      assert.ok(!/\{\{\s*\}\}/.test(source), `${id}: nodo Mermaid ambiguo para el motor de plantillas`);
    });

    it(`${id}: documenta las reglas de dependencia de cada capa`, () => {
      const source = readTemplate(file);
      assert.match(source, /DEBE estar aquí/, `${id}: no dice qué código va en cada capa`);
      assert.match(source, /TIENE PROHIBIDO estar aquí/, `${id}: no dice qué código NO va en cada capa`);

      const permitidas = source.match(/Dependencias permitidas/g) ?? [];
      assert.ok(
        permitidas.length >= 3,
        `${id}: sólo ${permitidas.length} bloques de dependencias permitidas`,
      );
    });

    it(`${id}: la guía paso a paso llega hasta la presentación y cierra con checklist`, () => {
      const source = readTemplate(file);
      for (const paso of ['Paso 1 ·', 'Paso 2 ·', 'Paso 3 ·', 'Paso 4 ·', 'Paso 5 ·']) {
        assert.ok(source.includes(paso), `${id}: falta el ${paso}`);
      }
      assert.match(source, /Checklist/i, `${id}: la guía no termina en una lista de verificación`);
    });

    it(`${id}: los comandos de la CLI de .NET están documentados`, () => {
      const source = readTemplate(file);
      for (const comando of ['dotnet restore', 'dotnet build', 'dotnet test', 'dotnet run --project', 'dotnet watch']) {
        assert.ok(source.includes(comando), `${id}: falta el comando ${comando}`);
      }
    });
  }
});

describe('cobertura de tokens y flags de las plantillas', () => {
  const context = buildTemplateContext(resolveOptions(baseOptions), 2026);
  const knownTokens = new Set(Object.keys(context.tokens));
  const knownFlags = new Set(Object.keys(context.flags));

  const allTemplates = walk(templatesRoot);

  it('hay plantillas que analizar', () => {
    assert.ok(allTemplates.length > 100, `sólo se han encontrado ${allTemplates.length} plantillas`);
  });

  it('ninguna plantilla usa un token o flag inexistente', () => {
    const problems = [];

    for (const file of allTemplates) {
      const source = readTemplate(file);
      let found;
      try {
        found = inspectTemplate(source);
      } catch (error) {
        problems.push(`${file}: no se puede analizar -> ${error.message}`);
        continue;
      }

      for (const token of found.tokens) {
        if (!knownTokens.has(token)) problems.push(`${file}: token desconocido "${token}"`);
      }
      for (const flag of found.flags) {
        if (!knownFlags.has(flag)) problems.push(`${file}: flag desconocido "${flag}"`);
      }
    }

    assert.deepEqual(problems, []);
  });

  it('toda plantilla termina en .tmpl y ninguna se colaría en un build de .NET', () => {
    for (const file of allTemplates) {
      assert.ok(file.endsWith('.tmpl'), file);
    }
  });
});

describe('matriz de versiones de paquetes', () => {
  it('cubre los frameworks soportados', () => {
    for (const framework of ['net9.0', 'net10.0']) {
      const versions = packageVersionsFor(framework);
      for (const [name, value] of Object.entries(versions)) {
        assert.match(value, /^\d+\.\d+\.\d+$/, `${framework}/${name} = ${value}`);
      }
    }
  });

  it('falla con un framework no soportado', () => {
    assert.throws(() => packageVersionsFor('net6.0'), /framework no soportado/);
  });

  it('alinea EF Core y las extensiones de la plataforma con el framework', () => {
    assert.ok(packageVersionsFor('net9.0').efCore.startsWith('9.'));
    assert.ok(packageVersionsFor('net9.0').extensions.startsWith('9.'));
    assert.ok(packageVersionsFor('net10.0').efCore.startsWith('10.'));
    assert.ok(packageVersionsFor('net10.0').extensions.startsWith('10.'));
  });
});

describe('resolveOptions', () => {
  it('deriva el plural y los flags de presentación', () => {
    const resolved = resolveOptions({ ...baseOptions, entity: 'category', ui: 'webapi' });
    assert.equal(resolved.entity, 'Category');
    assert.equal(resolved.entityPlural, 'Categories');
    assert.equal(resolved.hasWebApi, true);
    assert.equal(resolved.hasBlazor, false);
  });

  it('propaga la validación de nombres', () => {
    assert.throws(() => resolveOptions({ ...baseOptions, solutionName: 'Acme Shop' }), /segmento inválido/);
  });

  it('genera puertos distintos por solución y sin colisión entre api y blazor', () => {
    const a = buildTemplateContext(resolveOptions({ ...baseOptions, solutionName: 'Uno' }), 2026).tokens;
    const b = buildTemplateContext(resolveOptions({ ...baseOptions, solutionName: 'Dos' }), 2026).tokens;

    assert.notEqual(a.ApiHttpPort, b.ApiHttpPort);
    const puertos = new Set([a.ApiHttpPort, a.ApiHttpsPort, a.BlazorHttpPort, a.BlazorHttpsPort]);
    assert.equal(puertos.size, 4);
  });
});

/**
 * El registro que escriben las soluciones generadas.
 *
 * Lo destapó el visor de registro de la v1.7.0 al enseñar `[HH:mm:ss INF] Application started`:
 * la plantilla de salida de Serilog llevaba la hora como **texto literal** en vez de como el
 * marcador `{Timestamp:HH:mm:ss}`, así que todas las soluciones generadas escribían la misma hora
 * falsa en cada línea. Nadie lo había visto porque el resto de la línea era correcto.
 */
describe('plantilla de salida de Serilog', () => {
  const appsettings = walk(templatesRoot).filter((file) => file.endsWith('appsettings.json.tmpl'));

  it('hay un appsettings por proyecto de presentación', () => {
    assert.ok(appsettings.length >= 6, `sólo se han encontrado ${appsettings.length}`);
  });

  for (const file of appsettings) {
    const contents = readTemplate(file);
    if (!contents.includes('outputTemplate')) continue;

    it(`${file.slice(templatesRoot.length + 1)}: la hora es un marcador, no texto`, () => {
      assert.ok(
        contents.includes('{Timestamp:HH:mm:ss}'),
        'la plantilla escribiría "HH:mm:ss" literal en cada línea',
      );
      assert.ok(contents.includes('{Level:u3}'));
    });
  }
});
