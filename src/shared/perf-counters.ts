/**
 * Monitor de rendimiento: lectura de `dotnet-counters`.
 *
 * Los contadores que importan mientras se desarrolla una API son cuatro y siempre los mismos:
 * cuánta memoria está reteniendo el montón administrado, cuánta CPU se está gastando, con qué
 * frecuencia recolecta cada generación y cuántas peticiones por segundo aguanta. Los cuatro los
 * publica el propio runtime por EventCounters, y `dotnet-counters` es la herramienta oficial para
 * leerlos sin instrumentar la aplicación.
 *
 * Aquí sólo vive el modelo: qué contadores se piden, cómo se parsea lo que escupe la herramienta y
 * cómo se convierte una serie de números en la geometría de un gráfico. Todo puro.
 *
 * **Dos formatos, un parser.** `dotnet-counters monitor` pinta una tabla que se refresca en el
 * sitio (con secuencias de escape ANSI de por medio) y `dotnet-counters collect --format csv`
 * escribe filas. Se reconocen los dos, porque la tabla es lo que se puede leer en directo y el CSV
 * es lo que queda cuando la sesión termina.
 *
 * **Los nombres de contador no están traducidos.** Son constantes del runtime (`CPU Usage`,
 * `GC Heap Size`), no mensajes de la CLI, así que aquí sí se puede decidir sobre el texto — al
 * revés que con la salida de git o de `dotnet test`.
 */

/** Métricas que el panel enseña. Cualquier contador que no encaje en una de ellas se ignora. */
export type MetricId =
  | 'cpu'
  | 'heapMb'
  | 'workingSetMb'
  | 'gen0'
  | 'gen1'
  | 'gen2'
  | 'allocRate'
  | 'timeInGc'
  | 'exceptions'
  | 'threadPool'
  | 'requestsPerSecond'
  | 'currentRequests'
  | 'totalRequests';

export interface MetricInfo {
  id: MetricId;
  label: string;
  unit: string;
  /** Familia a la que pertenece, que es como se agrupan las filas del panel. */
  group: 'cpu' | 'memory' | 'gc' | 'http';
  /**
   * Valor que se considera "lleno" al pintar la barra. No es un límite ni una alarma: es la
   * escala. Null en los contadores que no tienen techo razonable (peticiones totales).
   */
  full: number | null;
}

export const METRICS: readonly MetricInfo[] = [
  { id: 'cpu', label: 'CPU', unit: '%', group: 'cpu', full: 100 },
  { id: 'heapMb', label: 'Montón administrado', unit: 'MB', group: 'memory', full: 512 },
  { id: 'workingSetMb', label: 'Conjunto de trabajo', unit: 'MB', group: 'memory', full: 1024 },
  { id: 'allocRate', label: 'Reserva', unit: 'MB/s', group: 'memory', full: 64 },
  { id: 'gen0', label: 'GC Gen 0', unit: '', group: 'gc', full: null },
  { id: 'gen1', label: 'GC Gen 1', unit: '', group: 'gc', full: null },
  { id: 'gen2', label: 'GC Gen 2', unit: '', group: 'gc', full: null },
  { id: 'timeInGc', label: 'Tiempo en GC', unit: '%', group: 'gc', full: 100 },
  { id: 'exceptions', label: 'Excepciones', unit: '/s', group: 'cpu', full: null },
  { id: 'threadPool', label: 'Hilos del pool', unit: '', group: 'cpu', full: null },
  { id: 'requestsPerSecond', label: 'Peticiones', unit: '/s', group: 'http', full: 200 },
  { id: 'currentRequests', label: 'Peticiones en curso', unit: '', group: 'http', full: 50 },
  { id: 'totalRequests', label: 'Peticiones totales', unit: '', group: 'http', full: null },
];

export function metricInfo(id: MetricId): MetricInfo {
  return METRICS.find((metric) => metric.id === id) ?? METRICS[0]!;
}

/**
 * Proveedores de EventCounters que se piden.
 *
 * `Microsoft.AspNetCore.Hosting` sólo publica algo si la aplicación es una web; pedirlo en una
 * consola no falla, simplemente no llega nada, así que no hace falta decidir antes qué se está
 * monitorizando.
 */
export const COUNTER_PROVIDERS = [
  'System.Runtime',
  'Microsoft.AspNetCore.Hosting',
] as const;

/**
 * Cómo se convierte el valor bruto de un contador en la métrica que enseña el panel.
 *
 *  - `raw`: el número ya es lo que se enseña (una cuenta, un número de hilos);
 *  - `bytesToMb`: el contador da bytes y la fila se lee en MB;
 *  - `bytesPerIntervalToMbPerSecond`: bytes acumulados en el intervalo -> MB/s;
 *  - `secondsPerIntervalToPercent`: segundos consumidos en el intervalo -> % del intervalo;
 *  - `cpuPercent`: igual que el anterior pero repartido entre los núcleos, que es lo que
 *    convierte "8 segundos de CPU en 2" en "50% de una máquina de 8 núcleos".
 */
type CounterTransform =
  | 'raw'
  | 'bytesToMb'
  | 'bytesPerIntervalToMbPerSecond'
  | 'secondsPerIntervalToPercent'
  | 'cpuPercent';

interface CounterMapping {
  metric: MetricId;
  transform: CounterTransform;
}

/**
 * Nombre del contador (ya reducido a letras y dígitos) -> métrica y transformación.
 *
 * Conviven **dos generaciones de nombres**, y las dos hacen falta:
 *
 *  - los **EventCounters clásicos** (`CPU Usage`, `GC Heap Size`, `Requests / sec`), que son lo
 *    que publica .NET 8 y anteriores;
 *  - las **métricas del `Meter` de System.Runtime** que las sustituyen desde .NET 9
 *    (`dotnet.process.cpu.time`, `dotnet.gc.collections`), con nombres al estilo OpenTelemetry,
 *    unidades declaradas y etiquetas.
 *
 * Soportar sólo las primeras deja el panel vacío justo en el framework que este IDE targetea, que
 * fue exactamente lo que pasó al probarlo contra una Web API en net10.0.
 */
const MAPPINGS: Record<string, CounterMapping> = {
  // --- EventCounters clásicos (hasta .NET 8) ---------------------------------------------------
  cpuusage: { metric: 'cpu', transform: 'raw' },
  gcheapsize: { metric: 'heapMb', transform: 'raw' },
  workingset: { metric: 'workingSetMb', transform: 'raw' },
  allocationrate: { metric: 'allocRate', transform: 'raw' },
  allocrate: { metric: 'allocRate', transform: 'raw' },
  gen0gccount: { metric: 'gen0', transform: 'raw' },
  gen1gccount: { metric: 'gen1', transform: 'raw' },
  gen2gccount: { metric: 'gen2', transform: 'raw' },
  timeingcsincelastgc: { metric: 'timeInGc', transform: 'raw' },
  timeingc: { metric: 'timeInGc', transform: 'raw' },
  exceptioncount: { metric: 'exceptions', transform: 'raw' },
  threadpoolthreadcount: { metric: 'threadPool', transform: 'raw' },
  requestspersecond: { metric: 'requestsPerSecond', transform: 'raw' },
  requestssec: { metric: 'requestsPerSecond', transform: 'raw' },
  currentrequests: { metric: 'currentRequests', transform: 'raw' },
  totalrequests: { metric: 'totalRequests', transform: 'raw' },

  // --- Meter de System.Runtime (.NET 9+) -------------------------------------------------------
  dotnetprocesscputime: { metric: 'cpu', transform: 'cpuPercent' },
  dotnetprocessmemoryworkingset: { metric: 'workingSetMb', transform: 'bytesToMb' },
  dotnetgclastcollectionmemorycommittedsize: { metric: 'heapMb', transform: 'bytesToMb' },
  dotnetgcheaptotalallocated: { metric: 'allocRate', transform: 'bytesPerIntervalToMbPerSecond' },
  dotnetgcpausetime: { metric: 'timeInGc', transform: 'secondsPerIntervalToPercent' },
  dotnetthreadpoolthreadcount: { metric: 'threadPool', transform: 'raw' },
  dotnetexceptions: { metric: 'exceptions', transform: 'raw' },
  httpserveractiverequests: { metric: 'currentRequests', transform: 'raw' },
  kestrelactiveconnections: { metric: 'currentRequests', transform: 'raw' },
};

/** Generación -> métrica, para `dotnet.gc.collections`, que llega una vez por generación. */
const GENERATION_METRIC: Record<string, MetricId> = {
  gen0: 'gen0',
  gen1: 'gen1',
  gen2: 'gen2',
};

/** Número de núcleos: no se enseña, pero sin él no se puede pasar de segundos de CPU a por ciento. */
const CPU_COUNT_COUNTER = 'dotnetprocesscpucount';

export interface CounterSample {
  provider: string | null;
  /** Nombre sin la unidad ni las etiquetas, para poder enseñarlo si no se reconoce. */
  counter: string;
  metric: MetricId | null;
  value: number;
  unit: string | null;
  /** Etiquetas del contador: `dotnet.gc.collections[gc.heap.generation=gen0]`. */
  tags: Record<string, string>;
  /**
   * Segundos que cubre el valor, declarados en la unidad (`By / 2 sec`).
   * Null en un contador instantáneo, como el conjunto de trabajo.
   */
  intervalSeconds: number | null;
}

/**
 * Instantánea de las métricas conocidas.
 *
 * `cpuCount` no es una métrica que se enseñe: es el dato que hace falta para pasar de "segundos de
 * CPU consumidos en el intervalo" a un porcentaje, y llega en su propio contador.
 */
export type MetricsSnapshot = Partial<Record<MetricId, number>> & { at: number; cpuCount?: number };


export const EMPTY_SNAPSHOT: MetricsSnapshot = { at: 0 };

export type MetricsStatus = 'idle' | 'starting' | 'running' | 'error';

/**
 * Estado de la sesión de monitorización, tal y como lo ve la interfaz.
 *
 * Vive en el modelo y no en el servicio porque cruza el IPC: el panel lo pinta y el proceso
 * principal lo produce, así que la forma tiene que estar declarada en un sitio que puedan importar
 * los dos.
 */
export interface MetricsState {
  status: MetricsStatus;
  /** Proceso monitorizado. Null cuando no hay sesión. */
  pid: number | null;
  processName: string | null;
  /** Qué está pasando: la herramienta que falta, el proceso que se ha ido. */
  message: string | null;
  /** true si `dotnet-counters` está instalado. */
  available: boolean;
}

export const IDLE_METRICS: MetricsState = {
  status: 'idle',
  pid: null,
  processName: null,
  message: null,
  available: false,
};

/** Lo que viaja por el evento de métricas: el estado y, si las hay, las muestras nuevas. */
export interface MetricsEvent {
  state: MetricsState;
  samples: CounterSample[];
  at: number;
}

/**
 * Quita las secuencias de escape ANSI.
 *
 * `dotnet-counters monitor` mueve el cursor para repintar la tabla en el sitio, así que su salida
 * viene salpicada de `ESC[…`. Sin limpiarlas, el primer nombre de cada bloque llega con basura
 * pegada delante y no casa con nada.
 */
export function stripAnsi(text: string): string {
  // El carácter de escape se construye con `String.fromCharCode(27)`: un archivo fuente con
  // bytes de control dentro es un archivo que cualquier herramienta puede estropear al
  // reescribirlo, y aquí ya pasó una vez.
  const escape = String.fromCharCode(27);
  const pattern = new RegExp(escape + String.raw`\[[0-9;?]*[ -/]*[@-~]`, 'g');
  return text.replace(pattern, '');
}

/**
 * Descompone el nombre de un contador en sus piezas.
 *
 * Formato de `dotnet-counters`: `nombre (unidad)[etiqueta=valor,etiqueta=valor]`. La unidad puede
 * traer el intervalo dentro (`By / 2 sec`), que es lo que permite convertir un acumulado en una
 * tasa sin tener que saber con qué frecuencia se pidió la sesión.
 */
export function parseCounterName(raw: string): {
  name: string;
  unit: string | null;
  tags: Record<string, string>;
  intervalSeconds: number | null;
} {
  const text = raw.trim();

  const tags: Record<string, string> = {};
  const tagMatch = /\[([^\]]*)\]\s*$/.exec(text);
  if (tagMatch) {
    for (const pair of tagMatch[1]!.split(',')) {
      const separator = pair.indexOf('=');
      if (separator === -1) continue;
      tags[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    }
  }

  const withoutTags = tagMatch ? text.slice(0, tagMatch.index).trim() : text;

  const unitMatch = /\(([^)]*)\)\s*$/.exec(withoutTags);
  const unit = unitMatch ? unitMatch[1]!.trim() : null;
  const name = unitMatch ? withoutTags.slice(0, unitMatch.index).trim() : withoutTags;

  const interval = unit === null ? null : /\/\s*([\d.]+)\s*sec/.exec(unit);

  return {
    name,
    unit,
    tags,
    intervalSeconds: interval ? Number.parseFloat(interval[1]!) : null,
  };
}

/** Nombre de contador -> clave de la tabla: sólo letras y dígitos, sin unidad ni etiquetas. */
export function compactCounterName(raw: string): string {
  return parseCounterName(raw).name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Unidad declarada entre paréntesis: `GC Heap Size (MB)` -> `MB`. */
export function counterUnit(raw: string): string | null {
  return parseCounterName(raw).unit;
}

/**
 * Métrica y transformación de un contador.
 *
 * `dotnet.gc.collections` llega una vez por generación y se distingue por su etiqueta: es el único
 * caso en el que el nombre no basta.
 */
export function mappingForCounter(raw: string, tags: Record<string, string> = {}): CounterMapping | null {
  const key = compactCounterName(raw);

  if (key === 'dotnetgccollections') {
    const metric = GENERATION_METRIC[tags['gc.heap.generation'] ?? ''];
    return metric === undefined ? null : { metric, transform: 'raw' };
  }

  return MAPPINGS[key] ?? null;
}

export function metricForCounter(raw: string, tags: Record<string, string> = {}): MetricId | null {
  return mappingForCounter(raw, tags)?.metric ?? null;
}

/** Un número: admite separadores de millar y coma o punto decimal. */
export function parseCounterValue(raw: string): number | null {
  const text = raw.trim();
  if (!/^[-+]?[\d.,]+(?:[eE][-+]?\d+)?$/.test(text)) return null;

  // El valor usa la configuración regional de la máquina: `8.168` puede ser ocho mil ciento
  // sesenta y ocho. Se decide por la forma, no por la configuración del IDE.
  const value = Number(normalizeNumber(text));
  return Number.isFinite(value) ? value : null;
}

function normalizeNumber(text: string): string {
  const commas = (text.match(/,/g) ?? []).length;
  const dots = (text.match(/\./g) ?? []).length;

  if (commas > 0 && dots > 0) {
    // El separador decimal es el que aparece más a la derecha.
    return text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  }

  if (commas > 1) return text.replace(/,/g, '');
  if (dots > 1) return text.replace(/\./g, '');

  if (commas === 1) {
    const decimals = text.length - text.indexOf(',') - 1;
    return decimals === 3 ? text.replace(',', '') : text.replace(',', '.');
  }

  return text;
}

const PROVIDER_HEADER = /^\[([\w.]+)\]$/;
const TABLE_ROW = new RegExp(String.raw`^\s{2,}(\S.*?)\s{2,}([-+]?[\d.,]+(?:[eE][-+]?\d+)?)\s*$`);
const CSV_ROW = new RegExp(String.raw`^[^,]*,([\w.]+),(.+),[^,]*,\s*([-+]?[\d.,]+(?:[eE][-+]?\d+)?)\s*$`);

/**
 * Muestras contenidas en un trozo de salida.
 *
 * Se aceptan los dos formatos de `dotnet-counters`: las filas CSV de `collect` —que es lo que usa
 * el IDE, porque `monitor` necesita una consola de verdad— y la tabla de `monitor`, que sigue
 * sirviendo para pegar aquí una salida capturada a mano. Lo que no encaje se descarta: la salida
 * trae también cabeceras y el estado de la sesión.
 */
export function parseCounterSamples(text: string): CounterSample[] {
  const samples: CounterSample[] = [];
  let provider: string | null = null;

  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') continue;

    const header = PROVIDER_HEADER.exec(line.trim());
    if (header) {
      provider = header[1]!;
      continue;
    }

    const csv = CSV_ROW.exec(line);
    if (csv) {
      const value = parseCounterValue(csv[3]!);
      if (value !== null) samples.push(toSample(csv[1]!, csv[2]!, value));
      continue;
    }

    const row = TABLE_ROW.exec(line);
    if (!row) continue;

    const value = parseCounterValue(row[2]!);
    if (value !== null) samples.push(toSample(provider, row[1]!, value));
  }

  return samples;
}

function toSample(provider: string | null, raw: string, value: number): CounterSample {
  const parsed = parseCounterName(raw);

  return {
    provider,
    counter: parsed.name,
    metric: metricForCounter(raw, parsed.tags),
    value,
    unit: parsed.unit,
    tags: parsed.tags,
    intervalSeconds: parsed.intervalSeconds,
  };
}

const BYTES_PER_MB = 1024 * 1024;

/**
 * Aplica muestras nuevas sobre la instantánea anterior.
 *
 * Se mezcla en vez de reemplazar porque no todos los contadores llegan en cada refresco: sustituir
 * la instantánea entera dejaría el panel parpadeando entre "47 MB" y "—".
 */
export function applySamples(
  previous: MetricsSnapshot,
  samples: readonly CounterSample[],
  at: number,
  defaultIntervalSeconds = 2,
): MetricsSnapshot {
  const next: MetricsSnapshot = { ...previous, at };

  // El número de núcleos puede venir en este mismo lote: se lee antes de convertir nada.
  for (const sample of samples) {
    if (compactCounterName(sample.counter) === CPU_COUNT_COUNTER && sample.value > 0) {
      next.cpuCount = sample.value;
    }
  }

  for (const sample of samples) {
    const mapping = mappingForCounter(sample.counter, sample.tags);
    if (mapping === null) continue;

    const interval = sample.intervalSeconds ?? defaultIntervalSeconds;
    const cores = next.cpuCount ?? 1;

    switch (mapping.transform) {
      case 'bytesToMb':
        next[mapping.metric] = sample.value / BYTES_PER_MB;
        break;
      case 'bytesPerIntervalToMbPerSecond':
        next[mapping.metric] = interval > 0 ? sample.value / interval / BYTES_PER_MB : 0;
        break;
      case 'secondsPerIntervalToPercent':
        next[mapping.metric] = interval > 0 ? (sample.value / interval) * 100 : 0;
        break;
      case 'cpuPercent':
        next[mapping.metric] = interval > 0 ? (sample.value / interval / cores) * 100 : 0;
        break;
      default:
        // El EventCounter clásico de reserva da bytes por intervalo aunque no lo declare.
        next[mapping.metric] =
          mapping.metric === 'allocRate' && (sample.unit ?? '').toUpperCase().includes('B')
            ? sample.value / BYTES_PER_MB
            : sample.value;
        break;
    }
  }

  return next;
}


/** Texto de una métrica, con la precisión que le corresponde. */
export function formatMetric(id: MetricId, value: number | undefined): string {
  if (value === undefined) return '—';

  const info = metricInfo(id);
  const digits = info.unit === '%' || info.unit === 'MB/s' ? 1 : info.unit === 'MB' ? 0 : 0;
  const text = value.toFixed(digits).replace('.', ',');

  return info.unit === '' ? text : `${text} ${info.unit}`;
}

/** Porcentaje de llenado de la barra, acotado a 0..1. */
export function fillRatio(id: MetricId, value: number | undefined): number {
  const info = metricInfo(id);
  if (value === undefined || info.full === null || info.full <= 0) return 0;
  return Math.max(0, Math.min(1, value / info.full));
}

// ---------------------------------------------------------------------------------------------
// Series y gráfico
// ---------------------------------------------------------------------------------------------

/** Añade un punto a una serie acotada. La serie es inmutable: se devuelve una nueva. */
export function pushPoint(series: readonly number[], value: number, max = 60): number[] {
  const next = [...series, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Ruta SVG de un gráfico de líneas.
 *
 * Vive aquí y no en la vista porque es aritmética con casos borde de verdad: una serie vacía, una
 * serie de un punto y una serie plana (todos los valores iguales, que dividiría por cero al
 * escalar). Las tres se prueban.
 */
export function sparklinePath(values: readonly number[], width: number, height: number, ceiling?: number): string {
  if (values.length === 0) return '';

  const top = ceiling !== undefined && ceiling > 0 ? ceiling : Math.max(...values, 1);
  const step = values.length === 1 ? 0 : width / (values.length - 1);

  const y = (value: number): string =>
    (height - Math.max(0, Math.min(1, value / top)) * height).toFixed(2);

  // Un solo punto no es una línea: se dibuja plano de lado a lado, que es lo que dice la verdad
  // ("hay un valor, todavía no hay tendencia") en vez de un punto invisible en la esquina.
  if (values.length === 1) {
    const only = y(values[0]!);
    return `M0 ${only} L${width.toFixed(2)} ${only}`;
  }

  return values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(2)} ${y(value)}`)
    .join(' ');
}

// ---------------------------------------------------------------------------------------------
// Invocación de la herramienta
// ---------------------------------------------------------------------------------------------

/** Nombre del ejecutable. Se instala como herramienta global de .NET. */
export const COUNTERS_COMMAND = 'dotnet-counters';

export const COUNTERS_MISSING_HINT =
  'dotnet-counters no está instalado. Instálalo con: dotnet tool install --global dotnet-counters';

/** Cada cuánto se pide una muestra. Dos segundos es fino para ver un pico y barato de leer. */
export const COUNTERS_REFRESH_SECONDS = 2;

/**
 * Argumentos de la sesión de contadores.
 *
 * Se usa **`collect` con formato CSV y no `monitor`**, y no es una preferencia: `monitor` pinta una
 * tabla que se repinta en el sitio y, con la salida redirigida —que es la única forma de leerla
 * desde el IDE—, revienta con una `NullReferenceException` antes de emitir un solo valor. `collect`
 * escribe filas a un archivo según llegan, que es exactamente lo que hace falta para ir leyéndolas.
 */
export function countersCollectArgs(pid: number, outputPath: string, refreshSeconds = COUNTERS_REFRESH_SECONDS): string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid no válido: ${String(pid)}`);
  if (outputPath.trim() === '') throw new Error('la sesión de contadores necesita un archivo de salida');

  return [
    'collect',
    '--process-id',
    String(pid),
    '--refresh-interval',
    String(Math.max(1, Math.round(refreshSeconds))),
    '--format',
    'csv',
    '--output',
    outputPath,
    '--counters',
    COUNTER_PROVIDERS.join(','),
  ];
}

export interface DotnetProcess {
  pid: number;
  name: string;
  path: string | null;
}

/**
 * Procesos .NET vivos, según `dotnet-counters ps`.
 *
 * El formato es `  <pid> <nombre> <ruta>` con la ruta opcional. Se parte por el primer bloque de
 * espacios, no por espacios sueltos: hay rutas de Windows con espacios y nombres con puntos.
 */
export function parseDotnetProcesses(output: string): DotnetProcess[] {
  const processes: DotnetProcess[] = [];

  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)(?:\s+(.*\S))?\s*$/.exec(raw);
    if (!match) continue;

    processes.push({
      pid: Number(match[1]),
      name: match[2]!,
      path: match[3] !== undefined && match[3] !== '' ? match[3] : null,
    });
  }

  return processes;
}
