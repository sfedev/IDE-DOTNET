/**
 * Pruebas del visor de registro estructurado.
 *
 * Los cinco formatos que se reconocen conviven en la misma salida: el arranque de una aplicación
 * .NET escribe con la consola de `Microsoft.Extensions.Logging` **antes** de que Serilog tome el
 * control, así que el parser tiene que aceptarlos mezclados sin perder líneas.
 *
 * Los casos que de verdad importan, y que están todos aquí:
 *  - una excepción con su traza tiene que quedar **pegada** al evento que la anunció;
 *  - un marco de pila debe reconocerse aunque el runtime escriba "en" y "línea" en vez de "at" y
 *    "line", porque esas palabras están traducidas;
 *  - una línea que no encaja con nada sigue siendo un evento: un visor que se come la salida es
 *    peor que no tener visor.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  countByLevel,
  filterEvents,
  firstNavigableFrame,
  isAtLeast,
  isExceptionLine,
  parseLogEvents,
  parseStackFrame,
  toLevel,
} from '../../build/ui-lib.mjs';

describe('niveles', () => {
  it('acepta las abreviaturas de Serilog, NLog y la consola de .NET', () => {
    assert.equal(toLevel('INF'), 'information');
    assert.equal(toLevel('wrn'), 'warning');
    assert.equal(toLevel('ERROR'), 'error');
    assert.equal(toLevel('fail'), 'error');
    assert.equal(toLevel('FTL'), 'critical');
    assert.equal(toLevel('crit'), 'critical');
    assert.equal(toLevel('vrb'), 'trace');
  });

  it('lo que no es un nivel no lo es', () => {
    assert.equal(toLevel('Producto'), null);
    assert.equal(toLevel(''), null);
  });

  it('el filtro por nivel mínimo incluye todo lo más grave', () => {
    assert.equal(isAtLeast('error', 'warning'), true);
    assert.equal(isAtLeast('information', 'warning'), false);
    assert.equal(isAtLeast('critical', 'critical'), true);
  });
});

describe('formatos reconocidos', () => {
  it('Serilog con la plantilla por defecto', () => {
    const [event] = parseLogEvents('[12:34:56 INF] Escuchando en https://localhost:7001');
    assert.equal(event.level, 'information');
    assert.equal(event.timestamp, '12:34:56');
    assert.equal(event.message, 'Escuchando en https://localhost:7001');
  });

  it('Serilog con marca de tiempo completa', () => {
    const [event] = parseLogEvents('2026-08-23 12:34:56.789 +02:00 [ERR] Fallo al guardar el producto');
    assert.equal(event.level, 'error');
    assert.ok(event.timestamp.startsWith('2026-08-23'));
    assert.equal(event.message, 'Fallo al guardar el producto');
  });

  it('la consola de .NET, con el mensaje en la línea siguiente', () => {
    const events = parseLogEvents(
      'info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: https://localhost:7001\n',
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].level, 'information');
    assert.equal(events[0].category, 'Microsoft.Hosting.Lifetime');
    assert.equal(events[0].message, 'Now listening on: https://localhost:7001');
  });

  it('NLog con su layout habitual', () => {
    const [event] = parseLogEvents('2026-08-23 12:34:56.7890|WARN|Acme.Shop.Api.Products|Sin stock');
    assert.equal(event.level, 'warning');
    assert.equal(event.category, 'Acme.Shop.Api.Products');
    assert.equal(event.message, 'Sin stock');
  });

  it('JSON compacto (CLEF)', () => {
    const [event] = parseLogEvents(
      '{"@t":"2026-08-23T12:34:56.789Z","@l":"Error","@m":"Se ha caído","SourceContext":"Acme.Shop"}',
    );

    assert.equal(event.level, 'error');
    assert.equal(event.message, 'Se ha caído');
    assert.equal(event.category, 'Acme.Shop');
  });

  it('CLEF omite el nivel cuando es Information: la ausencia significa eso', () => {
    const [event] = parseLogEvents('{"@t":"2026-08-23T12:34:56Z","@m":"Arrancando"}');
    assert.equal(event.level, 'information');
  });

  it('una línea suelta sigue siendo un evento', () => {
    const [event] = parseLogEvents('Restauración completada en 1,2s');
    assert.equal(event.level, 'information');
    assert.equal(event.message, 'Restauración completada en 1,2s');
  });

  it('los formatos conviven en la misma salida', () => {
    const events = parseLogEvents(
      [
        'info: Microsoft.Hosting.Lifetime[0]',
        '      Application started.',
        '[12:34:57 WRN] La caché está fría',
        'Compilación correcta.',
      ].join('\n'),
    );

    assert.deepEqual(events.map((event) => event.level), ['information', 'warning', 'information']);
  });
});

describe('marcos de pila', () => {
  it('reconoce un marco con archivo y línea en inglés', () => {
    const frame = parseStackFrame(
      '   at Acme.Shop.Application.ProductService.CreateAsync(CreateProduct command) in C:\\src\\Acme.Shop\\Application\\ProductService.cs:line 42',
    );

    assert.equal(frame.file, 'C:\\src\\Acme.Shop\\Application\\ProductService.cs');
    assert.equal(frame.line, 42);
    assert.ok(frame.method.startsWith('Acme.Shop.Application.ProductService.CreateAsync'));
  });

  it('reconoce el mismo marco traducido al español', () => {
    const frame = parseStackFrame(
      '   en Acme.Shop.Domain.Product.Rename(String nombre) en C:\\src\\Acme.Shop\\Domain\\Product.cs:línea 17',
    );

    assert.equal(frame.file, 'C:\\src\\Acme.Shop\\Domain\\Product.cs');
    assert.equal(frame.line, 17);
  });

  it('un marco sin símbolos se conserva, pero no se puede navegar a él', () => {
    const frame = parseStackFrame('   at System.Threading.Tasks.Task.ThrowIfExceptional(Boolean flag)');
    assert.equal(frame.file, null);
    assert.equal(frame.line, 0);
  });

  it('una línea normal no es un marco', () => {
    assert.equal(parseStackFrame('[12:34:56 INF] Hola'), null);
    assert.equal(parseStackFrame(''), null);
  });

  it('reconoce la primera línea de una excepción por su forma', () => {
    assert.equal(isExceptionLine('System.InvalidOperationException: la entidad no existe'), true);
    assert.equal(isExceptionLine(' ---> Microsoft.Data.SqlClient.SqlException: login failed'), true);
    assert.equal(isExceptionLine('Producto: Teclado'), false);
  });
});

describe('excepción con traza', () => {
  const OUTPUT = [
    '[12:34:56 INF] Arrancando',
    '[12:34:57 ERR] Fallo al procesar el pedido',
    'System.InvalidOperationException: El producto no existe',
    '   at Acme.Shop.Application.OrderService.PlaceAsync(Guid id) in C:\\src\\Acme.Shop\\Application\\OrderService.cs:line 88',
    '   at Acme.Shop.WebApi.Endpoints.OrderEndpoints.Handle() in C:\\src\\Acme.Shop\\WebApi\\OrderEndpoints.cs:line 25',
    '[12:34:58 INF] Petición completada',
  ].join('\n');

  const events = parseLogEvents(OUTPUT);

  it('la traza se pega al evento que la provocó, no queda suelta', () => {
    assert.equal(events.length, 3);
    assert.equal(events[1].level, 'error');
    assert.equal(events[1].frames.length, 2);
    assert.deepEqual(events[1].exception, ['System.InvalidOperationException: El producto no existe']);
  });

  it('el evento siguiente vuelve a empezar limpio', () => {
    assert.equal(events[2].message, 'Petición completada');
    assert.deepEqual(events[2].frames, []);
  });

  it('ofrece el primer marco navegable, que es el que abre el editor', () => {
    const frame = firstNavigableFrame(events[1]);
    assert.ok(frame.file.endsWith('OrderService.cs'));
    assert.equal(frame.line, 88);
  });

  it('cuenta por nivel para las pastillas del filtro', () => {
    const counts = countByLevel(events);
    assert.equal(counts.information, 2);
    assert.equal(counts.error, 1);
    assert.equal(counts.warning, 0);
  });

  it('filtra por nivel mínimo', () => {
    assert.equal(filterEvents(events, { minimum: 'warning' }).length, 1);
    assert.equal(filterEvents(events, { minimum: 'trace' }).length, 3);
  });

  it('filtra por texto, mirando también dentro de la excepción', () => {
    assert.equal(filterEvents(events, { query: 'pedido' }).length, 1);
    assert.equal(filterEvents(events, { query: 'InvalidOperation' }).length, 1);
    assert.equal(filterEvents(events, { query: 'no aparece' }).length, 0);
  });
});
