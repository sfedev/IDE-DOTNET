/**
 * Pruebas del inyector de contexto RAG.
 *
 * Lo que se comprueba aquí es lo que decide si el asistente sirve para algo en un proyecto .NET:
 * que reconoce la arquitectura de la solución abierta, que las reglas que se le imponen al modelo
 * son las de **esa** arquitectura, y que el contexto que se envía está acotado.
 *
 * La regla más importante —"el dominio no referencia EF Core"— tiene su propia aserción por
 * arquitectura: es la que convierte al asistente en un asistente de arquitectura y no en un
 * autocompletado con buenos modales.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DIAGNOSTICS,
  MAX_FILE_CHARS,
  MAX_SELECTION_CHARS,
  architectureLabel,
  architectureRules,
  buildContext,
  composeUserMessage,
  detectArchitecture,
  layerOf,
  projectContexts,
  relativeTo,
  renderContextBlock,
  systemPrompt,
  windowAround,
} from '../../build/main-lib.mjs';

const ALL = { activeFile: true, selection: true, architecture: true, diagnostics: true };

function solution(names, options = {}) {
  return {
    name: options.name ?? 'Acme.Shop',
    path: 'C:/dev/Acme.Shop/Acme.Shop.sln',
    directory: 'C:/dev/Acme.Shop',
    format: 'sln',
    projects: names.map((name) => ({
      kind: 'library',
      name,
      path: `C:/dev/Acme.Shop/src/${name}/${name}.csproj`,
      directory: `C:/dev/Acme.Shop/src/${name}`,
      targetFrameworks: ['net9.0'],
      sdk: 'Microsoft.NET.Sdk',
      outputType: null,
      isTestProject: false,
      isWebProject: false,
      projectReferences: [],
      packageReferences: [],
      solutionFolder: null,
    })),
    generatedBy: options.generatedBy ?? null,
    warnings: [],
  };
}

const CLEAN = ['Acme.Shop.Domain', 'Acme.Shop.Application', 'Acme.Shop.Infrastructure', 'Acme.Shop.WebApi'];
const HEXAGONAL = ['Acme.Shop.Domain', 'Acme.Shop.Ports', 'Acme.Shop.Adapters.Persistence', 'Acme.Shop.Adapters.Web'];
const DDD = ['Acme.Shop.SharedKernel', 'Acme.Shop.Domain', 'Acme.Shop.Application', 'Acme.Shop.Infrastructure'];

// ---------------------------------------------------------------------------------------------

describe('detección de arquitectura', () => {
  it('sin solución abierta no se inventa ninguna', () => {
    assert.equal(detectArchitecture(null), 'unknown');
    assert.equal(detectArchitecture(solution([])), 'unknown');
  });

  it('el manifiesto de DotForge manda sobre cualquier heurística', () => {
    const generated = solution(CLEAN, { generatedBy: { architecture: 'ddd', solutionName: 'Acme.Shop' } });
    assert.equal(detectArchitecture(generated), 'ddd');
  });

  it('reconoce las tres arquitecturas por la forma de la solución', () => {
    assert.equal(detectArchitecture(solution(CLEAN)), 'clean');
    assert.equal(detectArchitecture(solution(HEXAGONAL)), 'hexagonal');
    assert.equal(detectArchitecture(solution(DDD)), 'ddd');
  });

  it('una solución cualquiera no se fuerza a encajar', () => {
    assert.equal(detectArchitecture(solution(['MiApp', 'MiApp.Tests'])), 'unknown');
    assert.equal(detectArchitecture(solution(['Acme.Shop.Domain'])), 'unknown');
  });

  it('cada arquitectura tiene una etiqueta legible', () => {
    assert.equal(architectureLabel('clean'), 'Clean Architecture');
    assert.match(architectureLabel('hexagonal'), /Puertos/);
    assert.match(architectureLabel('ddd'), /CQRS/);
    assert.match(architectureLabel('unknown'), /sin determinar/);
  });
});

describe('mapa de capas', () => {
  it('asigna la capa por el sufijo del proyecto', () => {
    assert.equal(layerOf('Acme.Shop.Domain'), 'Dominio');
    assert.equal(layerOf('Acme.Shop.Application'), 'Aplicación');
    assert.equal(layerOf('Acme.Shop.Ports'), 'Puertos');
    assert.equal(layerOf('Acme.Shop.Adapters.Persistence'), 'Adaptador');
    assert.equal(layerOf('Acme.Shop.SharedKernel'), 'Shared Kernel');
    assert.equal(layerOf('Acme.Shop.UnitTests'), 'Pruebas');
    assert.equal(layerOf('Acme.Shop.WebApi'), 'Presentación (Web API)');
  });

  it('un proyecto que no encaja se marca como tal en vez de adivinarse', () => {
    assert.equal(layerOf('Herramienta.Interna'), 'Sin clasificar');
  });

  it('el mapa de proyectos conserva el orden de la solución', () => {
    const contexts = projectContexts(solution(HEXAGONAL).projects);
    assert.deepEqual(
      contexts.map((project) => project.layer),
      ['Dominio', 'Puertos', 'Adaptador', 'Adaptador'],
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe('reglas de arquitectura del prompt', () => {
  /**
   * La regla que justifica todo el módulo: sugerir un `DbContext` dentro del dominio es
   * exactamente el error que un asistente genérico comete a diario en estos proyectos.
   */
  it('las tres arquitecturas prohíben EF Core en el dominio', () => {
    for (const architecture of ['clean', 'hexagonal', 'ddd']) {
      const rules = architectureRules(architecture).join('\n');
      assert.match(rules, /EF Core/, `${architecture} no menciona EF Core`);
      assert.match(rules, /\.Domain/, `${architecture} no menciona el proyecto de dominio`);
    }
  });

  it('cada arquitectura impone sus propias reglas y no las de la vecina', () => {
    assert.match(architectureRules('hexagonal').join('\n'), /adaptador/i);
    assert.match(architectureRules('ddd').join('\n'), /agregado/i);
    assert.match(architectureRules('clean').join('\n'), /regla de dependencia/i);

    assert.equal(/Puertos y Adaptadores/.test(architectureRules('clean').join('\n')), false);
  });

  it('sin arquitectura reconocida se dice que no se sabe, no se elige una al azar', () => {
    const rules = architectureRules('unknown').join('\n');
    assert.match(rules, /No se ha podido determinar/);
    assert.equal(/EF Core/.test(rules), false);
  });

  it('el prompt de sistema incluye las reglas, el formato y el mapa de proyectos', () => {
    const context = buildContext({
      solution: solution(DDD),
      file: null,
      selection: null,
      diagnostics: [],
      include: ALL,
    });

    const prompt = systemPrompt(context, 'tests');

    assert.match(prompt, /DotForge AI/);
    assert.match(prompt, /agregado/i);
    assert.match(prompt, /xUnit/);
    assert.match(prompt, /Acme\.Shop\.SharedKernel — Shared Kernel/);
    // Decisión registrada en ADR-002: las plantillas no usan MediatR.
    assert.match(prompt, /MediatR/);
  });

  it('la tarea decide el formato de salida', () => {
    const context = buildContext({ solution: null, file: null, selection: null, diagnostics: [], include: ALL });

    assert.match(systemPrompt(context, 'edit'), /EXCLUSIVAMENTE/);
    assert.match(systemPrompt(context, 'explain'), /no reescribas el archivo/);
    assert.match(systemPrompt(context, 'tests'), /Arrange\/Act\/Assert/);
    assert.match(systemPrompt(context, 'chat'), /viola la arquitectura/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('rutas relativas', () => {
  it('recorta la raíz de la solución y normaliza el separador', () => {
    assert.equal(relativeTo('C:/dev/Acme.Shop', 'C:\\dev\\Acme.Shop\\src\\Domain\\Product.cs'), 'src/Domain/Product.cs');
  });

  it('un archivo de fuera de la solución conserva su ruta', () => {
    assert.equal(relativeTo('C:/dev/Acme.Shop', 'D:/otro/Program.cs'), 'D:/otro/Program.cs');
  });

  it('sin raíz devuelve la ruta con separador POSIX', () => {
    assert.equal(relativeTo(null, 'C:\\dev\\a.cs'), 'C:/dev/a.cs');
  });
});

describe('recorte del archivo activo', () => {
  const long = Array.from({ length: 400 }, (_, index) => `linea ${index}`).join('\n');

  it('un archivo que cabe no se toca', () => {
    const result = windowAround('corto', 100, null);
    assert.equal(result.truncated, false);
    assert.equal(result.text, 'corto');
  });

  it('sin selección se conserva la cabecera, que es donde están los using', () => {
    const result = windowAround(long, 200, null);
    assert.equal(result.truncated, true);
    assert.ok(result.text.startsWith('linea 0'));
    assert.match(result.text, /recortado/);
  });

  it('con selección se conserva la ventana que la rodea', () => {
    const result = windowAround(long, 200, { startLine: 300, endLine: 302 });

    assert.equal(result.truncated, true);
    assert.match(result.text, /linea 300/);
    assert.equal(result.text.includes('linea 0\n'), false);
    assert.ok(result.text.length < 400, `la ventana no se ha acotado: ${result.text.length}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe('construcción del contexto', () => {
  const file = {
    path: 'C:/dev/Acme.Shop/src/Acme.Shop.Domain/Entities/Product.cs',
    languageId: 'csharp',
    text: 'public sealed class Product { }',
  };

  const diagnostics = [
    { file: file.path, line: 12, column: 5, severity: 'error', code: 'CS0246', message: 'no se encuentra el tipo', project: null },
    { file: 'C:/dev/Acme.Shop/src/Otro/Otro.cs', line: 3, column: 1, severity: 'error', code: 'CS1002', message: 'falta ;', project: null },
    { file: file.path, line: 4, column: 1, severity: 'info', code: 'IDE0005', message: 'using innecesario', project: null },
  ];

  it('reúne archivo, selección, arquitectura y diagnósticos', () => {
    const context = buildContext({
      solution: solution(CLEAN),
      file,
      selection: { startLine: 1, endLine: 1, text: 'public sealed class Product { }' },
      diagnostics,
      include: ALL,
    });

    assert.equal(context.architecture, 'clean');
    assert.equal(context.solutionName, 'Acme.Shop');
    assert.equal(context.file.relativePath, 'src/Acme.Shop.Domain/Entities/Product.cs');
    assert.equal(context.selection.text, 'public sealed class Product { }');
    assert.equal(context.projects.length, 4);
  });

  it('los diagnósticos se filtran al archivo activo y se quedan los que importan', () => {
    const context = buildContext({ solution: solution(CLEAN), file, selection: null, diagnostics, include: ALL });

    assert.equal(context.diagnostics.length, 1);
    assert.equal(context.diagnostics[0].code, 'CS0246');
    // La ruta se convierte a relativa también en los diagnósticos.
    assert.equal(context.diagnostics[0].file, 'src/Acme.Shop.Domain/Entities/Product.cs');
  });

  it('nunca se adjuntan más diagnósticos de la cuenta', () => {
    const many = Array.from({ length: MAX_DIAGNOSTICS + 30 }, (_, index) => ({
      file: null,
      line: index + 1,
      column: 1,
      severity: 'error',
      code: `CS${index}`,
      message: 'error',
      project: null,
    }));

    const context = buildContext({ solution: null, file: null, selection: null, diagnostics: many, include: ALL });
    assert.equal(context.diagnostics.length, MAX_DIAGNOSTICS);
  });

  /** Las preferencias de privacidad tienen que ser efectivas, no decorativas. */
  it('cada interruptor apagado deja su pieza fuera del contexto', () => {
    const context = buildContext({
      solution: solution(CLEAN),
      file,
      selection: { startLine: 1, endLine: 1, text: 'x' },
      diagnostics,
      include: { activeFile: false, selection: false, architecture: false, diagnostics: false },
    });

    assert.equal(context.file, null);
    assert.equal(context.selection, null);
    assert.equal(context.diagnostics.length, 0);
    assert.equal(context.architecture, 'unknown');
    assert.deepEqual(context.projects, []);
  });

  it('una selección vacía o en blanco no cuenta como selección', () => {
    const context = buildContext({
      solution: null,
      file,
      selection: { startLine: 1, endLine: 1, text: '   \n  ' },
      diagnostics: [],
      include: ALL,
    });
    assert.equal(context.selection, null);
  });

  it('archivo y selección se recortan por tamaño', () => {
    const context = buildContext({
      solution: null,
      file: { ...file, text: 'x'.repeat(MAX_FILE_CHARS * 2) },
      selection: { startLine: 1, endLine: 2, text: 'y'.repeat(MAX_SELECTION_CHARS * 2) },
      diagnostics: [],
      include: ALL,
    });

    assert.equal(context.selection.text.length, MAX_SELECTION_CHARS);
    assert.ok(context.file.text.length <= MAX_FILE_CHARS + 200);
    assert.equal(context.file.truncated, true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('bloque de contexto del mensaje', () => {
  const context = buildContext({
    solution: solution(HEXAGONAL),
    file: {
      path: 'C:/dev/Acme.Shop/src/Acme.Shop.Ports/Inbound/IManageProducts.cs',
      languageId: 'csharp',
      text: 'public interface IManageProducts { }',
    },
    selection: { startLine: 1, endLine: 1, text: 'public interface IManageProducts { }' },
    diagnostics: [
      { file: null, line: 9, column: 1, severity: 'error', code: 'CS0234', message: 'falta la referencia', project: null },
    ],
    include: ALL,
  });

  const block = renderContextBlock(context);

  it('nombra la solución y su arquitectura', () => {
    assert.match(block, /Acme\.Shop/);
    assert.match(block, /Puertos y Adaptadores/);
  });

  it('incluye el archivo en un bloque de código con su lenguaje', () => {
    assert.match(block, /```csharp/);
    assert.match(block, /IManageProducts/);
    assert.match(block, /src\/Acme\.Shop\.Ports\/Inbound\/IManageProducts\.cs/);
  });

  it('incluye la selección con sus números de línea', () => {
    assert.match(block, /Selección del usuario \(líneas 1-1\)/);
  });

  it('incluye los diagnósticos con su código', () => {
    assert.match(block, /ERROR CS0234/);
  });

  it('el mensaje final envuelve el contexto en una etiqueta y deja la petición al final', () => {
    const message = composeUserMessage('¿esto viola la arquitectura?', context);

    assert.match(message, /^<contexto-del-ide>/);
    assert.match(message, /<\/contexto-del-ide>/);
    assert.ok(message.trimEnd().endsWith('¿esto viola la arquitectura?'));
  });

  it('sin contexto no se envuelve nada: el mensaje viaja tal cual', () => {
    const empty = buildContext({ solution: null, file: null, selection: null, diagnostics: [], include: ALL });
    assert.equal(composeUserMessage('hola', empty), 'hola');
  });
});
