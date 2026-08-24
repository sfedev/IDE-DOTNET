/**
 * Pruebas del explorador de pruebas.
 *
 * Dos mitades:
 *  - el **descubrimiento por texto**, que es lo que llena el árbol y pinta las lentes de código.
 *    Se ejercita con código C# como el que genera el propio scaffolding: `[Fact]`, `[Theory]` con
 *    `[InlineData]`, atributos en la misma línea, `DisplayName`, `Skip`, y un `namespace` de
 *    archivo, que es como se escribe hoy;
 *  - la **lectura de resultados**, que sale de un TRX de verdad. El TRX es la fuente porque los
 *    estados de la consola están traducidos; aquí se comprueba que los nombres de una `[Theory]`
 *    se agregan bajo su método y que la traza llega entera.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateStatus,
  attributeNames,
  baseTestId,
  buildTestTree,
  collapseResults,
  describeSummary,
  escapeFilterValue,
  filterForClass,
  filterForTests,
  findTests,
  namedArgument,
  outcomeToStatus,
  parseConsoleResults,
  parseDuration,
  qualify,
  testRunArgs,
} from '../../build/ui-lib.mjs';
import { parseTrx } from '../../build/main-lib.mjs';

const SOURCE = `using System;
using Xunit;

namespace Acme.Shop.UnitTests.Domain;

public class ProductTests
{
    private readonly IClock _clock = new FakeClock();

    [Fact]
    public void Create_sets_the_name()
    {
        Assert.Equal("Café", Product.Create("Café").Name);
    }

    [Fact(DisplayName = "no admite un nombre vacío", Skip = "pendiente del validador")]
    public void Create_rejects_empty_name()
    {
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task Price_must_be_positive(decimal price)
    {
        await Task.CompletedTask;
    }

    [Theory, InlineData("SKU-1")]
    public void Sku_is_normalized(string sku)
    {
    }

    // Un método sin atributo no es una prueba.
    public void Helper()
    {
    }
}
`;

const BLOCK_NAMESPACE_SOURCE = `namespace Acme.Api.Tests
{
    [TestFixture]
    public class HealthTests
    {
        [Test]
        public void Responds_ok() { }
    }

    [TestClass]
    public class PingTests
    {
        [TestMethod]
        public void Answers() { }
    }
}
`;

describe('attributeNames', () => {
  it('lee los atributos de una línea, juntos o sueltos', () => {
    assert.deepEqual(attributeNames('[Fact]'), ['Fact']);
    assert.deepEqual(attributeNames('[Theory, InlineData(1)]'), ['Theory', 'InlineData']);
    assert.deepEqual(attributeNames('[Fact(DisplayName = "x")]'), ['Fact']);
  });

  it('quita el sufijo Attribute, que es sintaxis equivalente', () => {
    assert.deepEqual(attributeNames('[FactAttribute]'), ['Fact']);
  });

  it('una línea que no es un atributo no devuelve nada', () => {
    assert.deepEqual(attributeNames('public void Foo()'), []);
  });
});

describe('namedArgument', () => {
  it('lee el valor entrecomillado de un argumento con nombre', () => {
    assert.equal(namedArgument('[Fact(DisplayName = "crea el producto")]', 'DisplayName'), 'crea el producto');
    assert.equal(namedArgument('[Fact(Skip = "flaky")]', 'Skip'), 'flaky');
  });

  it('devuelve null si el argumento no está', () => {
    assert.equal(namedArgument('[Fact]', 'Skip'), null);
  });
});

describe('findTests', () => {
  const tests = findTests(SOURCE, 'C:/repo/tests/ProductTests.cs', 'C:/repo/tests/Tests.csproj');

  it('encuentra las cuatro pruebas y ninguna más', () => {
    assert.deepEqual(
      tests.map((test) => test.method),
      ['Create_sets_the_name', 'Create_rejects_empty_name', 'Price_must_be_positive', 'Sku_is_normalized'],
    );
  });

  it('cualifica con el espacio de nombres de archivo y la clase', () => {
    assert.equal(tests[0].id, 'Acme.Shop.UnitTests.Domain.ProductTests.Create_sets_the_name');
    assert.equal(tests[0].namespace, 'Acme.Shop.UnitTests.Domain');
    assert.equal(tests[0].className, 'ProductTests');
  });

  it('ancla la lente en el atributo y la navegación en la firma', () => {
    const test = tests[0];
    assert.equal(SOURCE.split('\n')[test.line - 1].trim(), '[Fact]');
    assert.match(SOURCE.split('\n')[test.methodLine - 1], /Create_sets_the_name/);
    assert.ok(test.methodLine > test.line);
  });

  it('lee DisplayName y Skip', () => {
    const skipped = tests[1];
    assert.equal(skipped.displayName, 'no admite un nombre vacío');
    assert.equal(skipped.skip, 'pendiente del validador');
  });

  it('sin DisplayName el nombre visible es el del método', () => {
    assert.equal(tests[0].displayName, 'Create_sets_the_name');
    assert.equal(tests[0].skip, null);
  });

  it('distingue una teoría de un hecho, aunque los datos vayan en la misma línea', () => {
    assert.equal(tests[2].kind, 'theory');
    assert.equal(tests[3].kind, 'theory');
    assert.equal(tests[0].kind, 'fact');
  });

  it('reconoce un método asíncrono que devuelve Task', () => {
    assert.equal(tests[2].method, 'Price_must_be_positive');
  });

  it('guarda el archivo y el proyecto que le pasan', () => {
    assert.equal(tests[0].file, 'C:/repo/tests/ProductTests.cs');
    assert.equal(tests[0].project, 'C:/repo/tests/Tests.csproj');
  });

  it('entiende NUnit y MSTest con namespace de bloque', () => {
    const found = findTests(BLOCK_NAMESPACE_SOURCE, 'H.cs');

    assert.deepEqual(
      found.map((test) => `${test.framework}:${test.id}`),
      ['nunit:Acme.Api.Tests.HealthTests.Responds_ok', 'mstest:Acme.Api.Tests.PingTests.Answers'],
    );
  });

  it('un archivo sin pruebas no devuelve nada', () => {
    assert.deepEqual(findTests('public class Foo { public void Bar() {} }', 'Foo.cs'), []);
  });

  it('un atributo que no es de prueba no genera una prueba', () => {
    const found = findTests('public class C {\n  [Obsolete]\n  public void M() {}\n}', 'C.cs');
    assert.deepEqual(found, []);
  });
});

describe('qualify', () => {
  it('omite el espacio de nombres cuando no lo hay', () => {
    assert.equal(qualify(null, 'Tests', 'Works'), 'Tests.Works');
    assert.equal(qualify('Ns', 'Tests', 'Works'), 'Ns.Tests.Works');
  });
});

describe('buildTestTree', () => {
  const tests = [
    ...findTests(SOURCE, 'C:/repo/tests/ProductTests.cs', 'C:/repo/tests/Acme.Tests.csproj'),
    ...findTests(BLOCK_NAMESPACE_SOURCE, 'C:/repo/api/H.cs', 'C:/repo/api/Acme.Api.Tests.csproj'),
  ];

  it('agrupa en proyecto -> clase -> prueba', () => {
    const tree = buildTestTree(tests, { 'C:/repo/tests/Acme.Tests.csproj': 'Acme.Tests' });

    assert.equal(tree.length, 2);
    assert.equal(tree[0].name, 'Acme.Api.Tests');
    assert.equal(tree[1].name, 'Acme.Tests');
    assert.equal(tree[1].count, 4);
    assert.equal(tree[1].classes[0].className, 'ProductTests');
  });

  it('ordena las clases y las pruebas por nombre para que no bailen entre ejecuciones', () => {
    const tree = buildTestTree(tests);
    const methods = tree[0].classes.map((node) => node.className);
    assert.deepEqual(methods, [...methods].sort((a, b) => a.localeCompare(b)));
  });

  it('el nombre del proyecto sale de la ruta si no se le da uno', () => {
    const tree = buildTestTree(tests);
    assert.ok(tree.some((project) => project.name === 'Acme.Tests'));
  });
});

describe('aggregateStatus', () => {
  it('un solo fallo pinta el grupo en rojo', () => {
    assert.equal(aggregateStatus(['passed', 'failed', 'passed']), 'failed');
  });

  it('en ejecución manda sobre todo lo demás', () => {
    assert.equal(aggregateStatus(['failed', 'running']), 'running');
  });

  it('todas correctas es correcto; todas omitidas es omitido', () => {
    assert.equal(aggregateStatus(['passed', 'passed']), 'passed');
    assert.equal(aggregateStatus(['skipped', 'skipped']), 'skipped');
  });

  it('un grupo vacío o sin ejecutar es desconocido', () => {
    assert.equal(aggregateStatus([]), 'unknown');
    assert.equal(aggregateStatus(['unknown', 'unknown']), 'unknown');
  });
});

describe('filtros de VSTest', () => {
  it('varias pruebas se unen con la barra vertical', () => {
    assert.equal(
      filterForTests(['Ns.C.A', 'Ns.C.B']),
      'FullyQualifiedName=Ns.C.A|FullyQualifiedName=Ns.C.B',
    );
  });

  it('quita duplicados y vacíos', () => {
    assert.equal(filterForTests(['Ns.C.A', 'Ns.C.A', '  ']), 'FullyQualifiedName=Ns.C.A');
  });

  it('sin identificadores no hay filtro', () => {
    assert.equal(filterForTests([]), null);
  });

  it('una clase usa contiene, no igual: el nombre completo incluye el método', () => {
    assert.equal(filterForClass('Ns.ProductTests'), 'FullyQualifiedName~Ns.ProductTests.');
  });

  it('escapa los operadores del lenguaje de filtros', () => {
    assert.equal(escapeFilterValue('A|B'), 'A\\|B');
    assert.equal(escapeFilterValue('A(B)'), 'A\\(B\\)');
  });
});

describe('testRunArgs', () => {
  it('pone siempre el logger TRX, que es la fuente de los resultados', () => {
    const args = testRunArgs({
      target: 'C:/repo/Acme.sln',
      filter: null,
      trxFileName: 'dotforge.trx',
      resultsDirectory: 'C:/tmp/run',
    });

    assert.deepEqual(args, [
      'test',
      'C:/repo/Acme.sln',
      '--nologo',
      '--logger',
      'trx;LogFileName=dotforge.trx',
      '--results-directory',
      'C:/tmp/run',
    ]);
  });

  it('añade el filtro y la verbosidad cuando los hay', () => {
    const args = testRunArgs({
      target: 'A.csproj',
      filter: 'FullyQualifiedName=Ns.C.A',
      trxFileName: 'r.trx',
      resultsDirectory: 'out',
      verbosity: 'detailed',
      noBuild: true,
    });

    assert.ok(args.includes('--no-build'));
    assert.equal(args[args.indexOf('--filter') + 1], 'FullyQualifiedName=Ns.C.A');
    assert.equal(args[args.indexOf('--verbosity') + 1], 'detailed');
  });
});

describe('parseDuration', () => {
  it('lee el TimeSpan de .NET en milisegundos', () => {
    assert.equal(parseDuration('00:00:00.0123456'), 12);
    assert.equal(parseDuration('00:00:03.5000000'), 3500);
    assert.equal(parseDuration('00:02:00.0000000'), 120_000);
    assert.equal(parseDuration('1.00:00:00.0000000'), 86_400_000);
  });

  it('un valor irreconocible vale cero: una duración es información, no un resultado', () => {
    assert.equal(parseDuration('ayer'), 0);
    assert.equal(parseDuration(null), 0);
    assert.equal(parseDuration(undefined), 0);
  });
});

describe('outcomeToStatus', () => {
  it('traduce los nombres de enumeración del TRX, que no están traducidos', () => {
    assert.equal(outcomeToStatus('Passed'), 'passed');
    assert.equal(outcomeToStatus('Failed'), 'failed');
    assert.equal(outcomeToStatus('Error'), 'failed');
    assert.equal(outcomeToStatus('Timeout'), 'failed');
    assert.equal(outcomeToStatus('NotExecuted'), 'skipped');
    assert.equal(outcomeToStatus('Inconclusive'), 'skipped');
  });

  it('un estado que no se reconoce es desconocido, no un aprobado', () => {
    assert.equal(outcomeToStatus('Marciano'), 'unknown');
  });
});

describe('collapseResults', () => {
  it('agrega los casos de una teoría bajo su método', () => {
    const collapsed = collapseResults([
      { id: 'Ns.C.Theory(price: 0)', status: 'passed', durationMs: 3, message: null, stackTrace: null },
      { id: 'Ns.C.Theory(price: -1)', status: 'failed', durationMs: 5, message: 'boom', stackTrace: 'at Ns.C' },
    ]);

    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].id, 'Ns.C.Theory');
    assert.equal(collapsed[0].status, 'failed');
    assert.equal(collapsed[0].durationMs, 8);
    assert.equal(collapsed[0].message, 'boom');
  });

  it('baseTestId quita los argumentos y respeta un nombre sin ellos', () => {
    assert.equal(baseTestId('Ns.C.M(a: 1)'), 'Ns.C.M');
    assert.equal(baseTestId('Ns.C.M'), 'Ns.C.M');
  });
});

const TRX = `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="8d0f" name="run" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Times creation="2026-08-24T10:00:00" start="2026-08-24T10:00:01.0000000+02:00" finish="2026-08-24T10:00:04.2000000+02:00" />
  <Results>
    <UnitTestResult executionId="e1" testId="t1" testName="Acme.Tests.ProductTests.Create_sets_the_name" outcome="Passed" duration="00:00:00.0120000" />
    <UnitTestResult executionId="e2" testId="t2" testName="Acme.Tests.ProductTests.Price_must_be_positive(price: 0)" outcome="Failed" duration="00:00:00.0450000">
      <Output>
        <ErrorInfo>
          <Message>Assert.True() Failure&#xD;&#xA;Expected: True&#xD;&#xA;Actual: False</Message>
          <StackTrace>   at Acme.Tests.ProductTests.Price_must_be_positive(Decimal price) in C:\\repo\\tests\\ProductTests.cs:line 42</StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
    <UnitTestResult executionId="e3" testId="t3" testName="Acme.Tests.ProductTests.Create_rejects_empty_name" outcome="NotExecuted" duration="00:00:00.0000000" />
  </Results>
  <TestDefinitions>
    <UnitTest name="Create_sets_the_name" storage="acme.tests.dll" id="t1">
      <TestMethod codeBase="acme.tests.dll" className="Acme.Tests.ProductTests" name="Create_sets_the_name" />
    </UnitTest>
    <UnitTest name="Price_must_be_positive(price: 0)" storage="acme.tests.dll" id="t2">
      <TestMethod codeBase="acme.tests.dll" className="Acme.Tests.ProductTests" name="Price_must_be_positive" />
    </UnitTest>
    <UnitTest name="Create_rejects_empty_name" storage="acme.tests.dll" id="t3">
      <TestMethod codeBase="acme.tests.dll" className="Acme.Tests.ProductTests" name="Create_rejects_empty_name" />
    </UnitTest>
  </TestDefinitions>
  <ResultSummary outcome="Failed">
    <Counters total="3" executed="2" passed="1" failed="1" notExecuted="1" />
  </ResultSummary>
</TestRun>
`;

describe('parseTrx', () => {
  const summary = parseTrx(TRX);

  it('cuenta correctas, con error y omitidas', () => {
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.degraded, false);
  });

  it('usa el nombre de la definición, no el de la ejecución con sus argumentos', () => {
    const ids = summary.results.map((result) => result.id);
    assert.ok(ids.includes('Acme.Tests.ProductTests.Price_must_be_positive'), ids.join(', '));
    assert.equal(ids.some((id) => id.includes('(')), false, 'ha colado un nombre con argumentos');
  });

  it('trae el mensaje del assert y la traza completa', () => {
    const failed = summary.results.find((result) => result.status === 'failed');
    assert.match(failed.message, /Assert\.True\(\) Failure/);
    assert.match(failed.stackTrace, /ProductTests\.cs:line 42/);
  });

  it('descodifica las referencias numéricas: el TRX escribe los saltos como &#xD;&#xA;', () => {
    const failed = summary.results.find((result) => result.status === 'failed');

    assert.equal(failed.message.includes('&#x'), false, failed.message);
    assert.match(failed.message, /Expected: True/);
    // Y el salto de línea es un salto de línea de verdad, no un literal.
    assert.ok(failed.message.split(String.fromCharCode(10)).length >= 3, failed.message);
  });

  it('la duración total sale de los tiempos de la ejecución', () => {
    assert.equal(summary.durationMs, 3200);
  });

  it('un TRX ilegible devuelve un resumen vacío en vez de lanzar', () => {
    const empty = parseTrx('no soy XML <');
    assert.equal(empty.results.length, 0);
    assert.equal(empty.passed, 0);
  });
});

describe('parseConsoleResults (camino degradado)', () => {
  it('lee los estados en inglés y en español', () => {
    const results = parseConsoleResults(
      [
        '  Passed Acme.Tests.ProductTests.Create [3 ms]',
        '  Failed Acme.Tests.ProductTests.Rejects [12 ms]',
        '  Omitido Acme.Tests.ProductTests.Pending',
        'Restore complete (0,4s)',
      ].join('\n'),
    );

    assert.deepEqual(
      results.map((result) => [result.status, result.id]),
      [
        ['passed', 'Acme.Tests.ProductTests.Create'],
        ['failed', 'Acme.Tests.ProductTests.Rejects'],
        ['skipped', 'Acme.Tests.ProductTests.Pending'],
      ],
    );
  });

  it('no confunde una línea cualquiera de MSBuild con un resultado', () => {
    assert.deepEqual(parseConsoleResults('  Determining projects to restore...'), []);
  });
});

describe('describeSummary', () => {
  it('resume en una línea con los segundos en formato español', () => {
    const summary = {
      passed: 14,
      failed: 1,
      skipped: 0,
      durationMs: 3200,
      results: [],
      degraded: false,
    };

    assert.equal(describeSummary(summary), '14 correctas · 1 con error · 0 omitidas (3,2 s)');
  });
});
