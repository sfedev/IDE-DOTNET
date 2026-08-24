/**
 * Pruebas del monitor de rendimiento.
 *
 * Hay **dos generaciones de contadores** y el panel tiene que entender las dos:
 *
 *  - los EventCounters clásicos (`CPU Usage`, `GC Heap Size`, `Requests / sec`), que es lo que
 *    publica .NET 8 y anteriores;
 *  - las métricas del `Meter` de `System.Runtime` que las sustituyen desde .NET 9
 *    (`dotnet.process.cpu.time`, `dotnet.gc.collections[gc.heap.generation=gen0]`), con nombres al
 *    estilo OpenTelemetry, unidad declarada y etiquetas.
 *
 * El CSV de este archivo es salida **real** de `dotnet-counters collect` contra una Web API en
 * net10.0 generada por el propio scaffolding. Soportar sólo los nombres clásicos dejaba el panel
 * vacío justo en el framework que este IDE targetea.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySamples,
  counterUnit,
  countersCollectArgs,
  COUNTERS_REFRESH_SECONDS,
  COUNTER_PROVIDERS,
  fillRatio,
  formatMetric,
  mappingForCounter,
  METRICS,
  metricForCounter,
  metricInfo,
  parseCounterName,
  parseCounterSamples,
  parseCounterValue,
  parseDotnetProcesses,
  pushPoint,
  sparklinePath,
  stripAnsi,
} from '../../build/ui-lib.mjs';

const ESC = String.fromCharCode(27);

/** Tabla de `dotnet-counters monitor` sobre un proceso .NET 8: nombres clásicos. */
const MONITOR_OUTPUT = `Press p to pause, r to resume, q to quit.
    Status: Running

[System.Runtime]
    % Time in GC since last GC (%)                         3
    Allocation Rate (B / 1 sec)                    8,388,608
    CPU Usage (%)                                         12
    GC Heap Size (MB)                                     47
    Gen 0 GC Count (Count / 1 sec)                         2
    Gen 1 GC Count (Count / 1 sec)                         1
    Gen 2 GC Count (Count / 1 sec)                         0
    ThreadPool Thread Count                               11
    Working Set (MB)                                     153
[Microsoft.AspNetCore.Hosting]
    Current Requests                                       3
    Requests / sec                                        42
    Total Requests                                      1284
`;

/** Salida real de `collect --format csv` contra una Web API en net10.0. */
const CSV_OUTPUT = `Timestamp,Provider,Counter Name,Counter Type,Mean/Increment
08/24/2026 02:00:21,System.Runtime,dotnet.process.cpu.count ({cpu}),Metric,12
08/24/2026 02:00:21,System.Runtime,dotnet.process.cpu.time (s / 2 sec),Metric,1.2
08/24/2026 02:00:21,System.Runtime,dotnet.process.memory.working_set (By),Metric,157286400
08/24/2026 02:00:21,System.Runtime,dotnet.gc.last_collection.memory.committed_size (By),Metric,49283072
08/24/2026 02:00:21,System.Runtime,dotnet.gc.heap.total_allocated (By / 2 sec),Metric,16777216
08/24/2026 02:00:21,System.Runtime,dotnet.gc.pause.time (s / 2 sec),Metric,0.06
08/24/2026 02:00:21,System.Runtime,dotnet.gc.collections ({collection} / 2 sec)[gc.heap.generation=gen0],Metric,3
08/24/2026 02:00:21,System.Runtime,dotnet.gc.collections ({collection} / 2 sec)[gc.heap.generation=gen1],Metric,1
08/24/2026 02:00:21,System.Runtime,dotnet.gc.collections ({collection} / 2 sec)[gc.heap.generation=gen2],Metric,0
08/24/2026 02:00:21,System.Runtime,dotnet.thread_pool.thread.count ({thread} / 2 sec),Metric,9
08/24/2026 02:00:21,System.Runtime,dotnet.assembly.count ({assembly}),Metric,142
08/24/2026 02:00:21,Microsoft.AspNetCore.Hosting,http.server.active_requests ({request}),Metric,4
`;

describe('stripAnsi', () => {
  it('quita las secuencias de escape que usa la tabla para repintarse', () => {
    assert.equal(stripAnsi(`${ESC}[2J${ESC}[HCPU Usage (%)`), 'CPU Usage (%)');
    assert.equal(stripAnsi(`${ESC}[1;32mverde${ESC}[0m`), 'verde');
  });

  it('no toca los corchetes del proveedor ni los paréntesis de la unidad', () => {
    assert.equal(stripAnsi('[System.Runtime]'), '[System.Runtime]');
    assert.equal(stripAnsi('GC Heap Size (MB)'), 'GC Heap Size (MB)');
  });
});

describe('parseCounterName', () => {
  it('separa nombre, unidad y etiquetas', () => {
    const parsed = parseCounterName('dotnet.gc.collections ({collection} / 2 sec)[gc.heap.generation=gen0]');

    assert.equal(parsed.name, 'dotnet.gc.collections');
    assert.equal(parsed.unit, '{collection} / 2 sec');
    assert.deepEqual(parsed.tags, { 'gc.heap.generation': 'gen0' });
    assert.equal(parsed.intervalSeconds, 2);
  });

  it('saca el intervalo de la unidad, que es lo que convierte un acumulado en una tasa', () => {
    assert.equal(parseCounterName('dotnet.gc.heap.total_allocated (By / 2 sec)').intervalSeconds, 2);
    assert.equal(parseCounterName('Allocation Rate (B / 1 sec)').intervalSeconds, 1);
  });

  it('un contador instantáneo no declara intervalo', () => {
    const parsed = parseCounterName('dotnet.process.memory.working_set (By)');

    assert.equal(parsed.intervalSeconds, null);
    assert.equal(parsed.unit, 'By');
    assert.deepEqual(parsed.tags, {});
  });

  it('un nombre sin unidad ni etiquetas se devuelve tal cual', () => {
    assert.deepEqual(parseCounterName('Total Requests'), {
      name: 'Total Requests',
      unit: null,
      tags: {},
      intervalSeconds: null,
    });
  });

  it('counterUnit sigue leyendo la unidad', () => {
    assert.equal(counterUnit('GC Heap Size (MB)'), 'MB');
    assert.equal(counterUnit('Total Requests'), null);
  });
});

describe('metricForCounter', () => {
  it('reconoce los EventCounters clásicos, con y sin unidad', () => {
    assert.equal(metricForCounter('CPU Usage (%)'), 'cpu');
    assert.equal(metricForCounter('GC Heap Size (MB)'), 'heapMb');
    assert.equal(metricForCounter('Working Set (MB)'), 'workingSetMb');
    assert.equal(metricForCounter('Gen 0 GC Count (Count / 1 sec)'), 'gen0');
    assert.equal(metricForCounter('Requests / sec'), 'requestsPerSecond');
  });

  it('reconoce las métricas nuevas del Meter de .NET 9+', () => {
    assert.equal(metricForCounter('dotnet.process.cpu.time (s / 2 sec)'), 'cpu');
    assert.equal(metricForCounter('dotnet.process.memory.working_set (By)'), 'workingSetMb');
    assert.equal(metricForCounter('dotnet.gc.last_collection.memory.committed_size (By)'), 'heapMb');
    assert.equal(metricForCounter('dotnet.gc.heap.total_allocated (By / 2 sec)'), 'allocRate');
    assert.equal(metricForCounter('http.server.active_requests ({request})'), 'currentRequests');
  });

  it('las generaciones del GC se distinguen por la etiqueta, no por el nombre', () => {
    const name = 'dotnet.gc.collections ({collection} / 2 sec)';

    assert.equal(metricForCounter(name, { 'gc.heap.generation': 'gen0' }), 'gen0');
    assert.equal(metricForCounter(name, { 'gc.heap.generation': 'gen2' }), 'gen2');
    assert.equal(metricForCounter(name, { 'gc.heap.generation': 'loh' }), null);
    assert.equal(metricForCounter(name), null);
  });

  it('declara la transformación de cada contador', () => {
    assert.equal(mappingForCounter('dotnet.process.cpu.time (s / 2 sec)').transform, 'cpuPercent');
    assert.equal(mappingForCounter('dotnet.process.memory.working_set (By)').transform, 'bytesToMb');
    assert.equal(mappingForCounter('CPU Usage (%)').transform, 'raw');
  });

  it('lo que no se reconoce es null y se ignora en vez de colarse en el panel', () => {
    assert.equal(metricForCounter('dotnet.assembly.count ({assembly})'), null);
    assert.equal(metricForCounter('Assembly Count'), null);
  });
});

describe('parseCounterValue', () => {
  it('lee un entero y un decimal con punto', () => {
    assert.equal(parseCounterValue('12'), 12);
    assert.equal(parseCounterValue('3.5'), 3.5);
  });

  it('trata los millares en el formato inglés', () => {
    assert.equal(parseCounterValue('8,388,608'), 8388608);
    assert.equal(parseCounterValue('1,284'), 1284);
  });

  it('trata los millares y el decimal en el formato español', () => {
    assert.equal(parseCounterValue('8.388.608'), 8388608);
    assert.equal(parseCounterValue('3,5'), 3.5);
  });

  it('con los dos separadores manda el que está más a la derecha', () => {
    assert.equal(parseCounterValue('1.234,5'), 1234.5);
    assert.equal(parseCounterValue('1,234.5'), 1234.5);
  });

  it('lo que no es un número devuelve null', () => {
    assert.equal(parseCounterValue('Running'), null);
    assert.equal(parseCounterValue(''), null);
  });
});

describe('parseCounterSamples: tabla de monitor', () => {
  const samples = parseCounterSamples(MONITOR_OUTPUT);

  it('lee todos los contadores de la tabla', () => {
    assert.equal(samples.length, 12);
  });

  it('les pega el proveedor de su bloque', () => {
    const cpu = samples.find((sample) => sample.metric === 'cpu');
    const requests = samples.find((sample) => sample.metric === 'requestsPerSecond');

    assert.equal(cpu.provider, 'System.Runtime');
    assert.equal(cpu.value, 12);
    assert.equal(requests.provider, 'Microsoft.AspNetCore.Hosting');
    assert.equal(requests.value, 42);
  });

  it('no confunde la cabecera ni el estado con un contador', () => {
    assert.equal(samples.some((sample) => sample.counter.includes('Status')), false);
    assert.equal(samples.some((sample) => sample.counter.includes('Press p')), false);
  });

  it('sobrevive a los escapes de repintado', () => {
    assert.equal(parseCounterSamples(`${ESC}[2J${ESC}[H${MONITOR_OUTPUT}`).length, 12);
  });

  it('una salida sin nada reconocible no produce muestras', () => {
    assert.deepEqual(parseCounterSamples('Press p to pause, r to resume, q to quit.'), []);
    assert.deepEqual(parseCounterSamples(''), []);
  });
});

describe('parseCounterSamples: CSV de collect', () => {
  const samples = parseCounterSamples(CSV_OUTPUT);

  it('lee una muestra por fila, sin contar la cabecera', () => {
    assert.equal(samples.length, 12);
  });

  it('conserva las etiquetas del nombre', () => {
    const gen1 = samples.find((sample) => sample.metric === 'gen1');

    assert.deepEqual(gen1.tags, { 'gc.heap.generation': 'gen1' });
    assert.equal(gen1.value, 1);
    assert.equal(gen1.counter, 'dotnet.gc.collections');
  });

  it('reconoce el proveedor de ASP.NET Core', () => {
    const active = samples.find((sample) => sample.metric === 'currentRequests');
    assert.equal(active.provider, 'Microsoft.AspNetCore.Hosting');
    assert.equal(active.value, 4);
  });

  it('deja sin métrica lo que no interesa, pero no lo descarta', () => {
    const assemblies = samples.find((sample) => sample.counter === 'dotnet.assembly.count');
    assert.equal(assemblies.metric, null);
  });
});

describe('applySamples', () => {
  it('convierte las métricas nuevas a lo que enseña el panel', () => {
    const snapshot = applySamples({ at: 0 }, parseCounterSamples(CSV_OUTPUT), 1000);

    // 1,2 s de CPU en 2 s repartidos entre 12 núcleos = 5%.
    assert.equal(Math.round(snapshot.cpu * 10) / 10, 5);
    assert.equal(snapshot.workingSetMb, 150);
    assert.equal(snapshot.heapMb, 47);
    // 16 MB reservados en 2 s = 8 MB/s.
    assert.equal(snapshot.allocRate, 8);
    // 0,06 s de pausa en 2 s = 3%.
    assert.equal(Math.round(snapshot.timeInGc * 10) / 10, 3);
    assert.deepEqual([snapshot.gen0, snapshot.gen1, snapshot.gen2], [3, 1, 0]);
    assert.equal(snapshot.threadPool, 9);
    assert.equal(snapshot.currentRequests, 4);
  });

  it('el número de núcleos se guarda pero no se enseña como métrica', () => {
    const snapshot = applySamples({ at: 0 }, parseCounterSamples(CSV_OUTPUT), 1000);
    assert.equal(snapshot.cpuCount, 12);
  });

  it('sigue entendiendo los EventCounters clásicos', () => {
    const snapshot = applySamples({ at: 0 }, parseCounterSamples(MONITOR_OUTPUT), 1000);

    assert.equal(snapshot.cpu, 12);
    assert.equal(snapshot.heapMb, 47);
    assert.equal(snapshot.workingSetMb, 153);
    assert.equal(snapshot.requestsPerSecond, 42);
    // La reserva clásica viene en bytes por intervalo: 8 MiB.
    assert.equal(snapshot.allocRate, 8);
  });

  it('mezcla en vez de reemplazar: un contador que no se repite no se pierde', () => {
    const first = applySamples({ at: 0 }, parseCounterSamples(CSV_OUTPUT), 1000);
    const second = applySamples(
      first,
      parseCounterSamples('[System.Runtime]\n    CPU Usage (%)   30\n'),
      2000,
    );

    assert.equal(second.cpu, 30);
    assert.equal(second.heapMb, 47, 'se ha perdido el montón al llegar un refresco parcial');
    assert.equal(second.at, 2000);
  });

  it('ignora las muestras que no corresponden a ninguna métrica', () => {
    const snapshot = applySamples(
      { at: 0 },
      [{ provider: null, counter: 'dotnet.assembly.count', metric: null, value: 9, unit: null, tags: {}, intervalSeconds: null }],
      1,
    );

    assert.deepEqual(Object.keys(snapshot), ['at']);
  });
});

describe('presentación', () => {
  it('el catálogo no tiene métricas duplicadas', () => {
    const ids = METRICS.map((metric) => metric.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('formatMetric usa la coma decimal y añade la unidad', () => {
    assert.equal(formatMetric('cpu', 12.34), '12,3 %');
    assert.equal(formatMetric('heapMb', 47), '47 MB');
    assert.equal(formatMetric('gen0', 2), '2');
  });

  it('un valor que no ha llegado se enseña como raya, no como cero', () => {
    assert.equal(formatMetric('cpu', undefined), '—');
  });

  it('fillRatio se acota entre 0 y 1 y vale 0 sin techo', () => {
    assert.equal(fillRatio('cpu', 50), 0.5);
    assert.equal(fillRatio('cpu', 300), 1);
    assert.equal(fillRatio('cpu', -1), 0);
    assert.equal(fillRatio('gen0', 500), 0);
    assert.equal(metricInfo('gen0').full, null);
  });
});

describe('series y gráfico', () => {
  it('pushPoint acota la serie por el final', () => {
    let series = [];
    for (let i = 0; i < 10; i++) series = pushPoint(series, i, 4);

    assert.deepEqual(series, [6, 7, 8, 9]);
  });

  it('una serie vacía no dibuja nada', () => {
    assert.equal(sparklinePath([], 72, 18), '');
  });

  it('un solo punto se dibuja plano de lado a lado', () => {
    assert.equal(sparklinePath([50], 72, 18, 100), 'M0 9.00 L72.00 9.00');
  });

  it('la ruta empieza con un moveto y sigue con linetos', () => {
    const path = sparklinePath([0, 50, 100], 72, 18, 100);

    assert.match(path, /^M0\.00 18\.00/);
    assert.equal((path.match(/L/g) ?? []).length, 2);
    assert.match(path, /L72\.00 0\.00$/);
  });

  it('una serie plana no divide por cero', () => {
    assert.equal(sparklinePath([0, 0, 0], 72, 18).includes('NaN'), false);
  });
});

describe('invocación de la herramienta', () => {
  it('usa collect con CSV: monitor necesita una consola de verdad', () => {
    const args = countersCollectArgs(4242, 'C:/tmp/c.csv');

    assert.equal(args[0], 'collect');
    assert.equal(args[args.indexOf('--process-id') + 1], '4242');
    assert.equal(args[args.indexOf('--format') + 1], 'csv');
    assert.equal(args[args.indexOf('--output') + 1], 'C:/tmp/c.csv');
    assert.equal(args[args.indexOf('--counters') + 1], COUNTER_PROVIDERS.join(','));
    assert.equal(args[args.indexOf('--refresh-interval') + 1], String(COUNTERS_REFRESH_SECONDS));
  });

  it('un pid o un destino inválidos no llegan a construir argumentos', () => {
    assert.throws(() => countersCollectArgs(0, 'x.csv'), /pid no válido/);
    assert.throws(() => countersCollectArgs(-3, 'x.csv'), /pid no válido/);
    assert.throws(() => countersCollectArgs(42, '  '), /archivo de salida/);
  });

  it('parseDotnetProcesses lee pid, nombre y ruta con espacios', () => {
    const processes = parseDotnetProcesses(
      [
        '  12345 Acme.WebApi    C:\\repo\\src\\Acme.WebApi\\bin\\Debug\\net9.0\\Acme.WebApi.exe',
        '  6789 Mi App          C:\\Program Files\\Mi App\\app.dll',
        'texto que no es un proceso',
      ].join('\n'),
    );

    assert.equal(processes.length, 2);
    assert.equal(processes[0].pid, 12345);
    assert.equal(processes[0].name, 'Acme.WebApi');
    assert.match(processes[0].path, /Acme\.WebApi\.exe$/);
    assert.match(processes[1].path, /Program Files/);
  });
});
