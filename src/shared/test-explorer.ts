/**
 * Modelo del explorador de pruebas: descubrir, filtrar y leer resultados.
 *
 * **Por qué se descubren por texto y no con `dotnet test --list-tests`.** Listar exige compilar
 * la solución entera: entre veinte segundos y varios minutos la primera vez. La lente de código
 * tiene que aparecer mientras se escribe la prueba, en un archivo que todavía no compila, y el
 * árbol lateral tiene que estar lleno nada más abrir la solución. Un análisis de texto acotado da
 * el 99% de los casos al instante y, cuando se equivoca, se equivoca de la forma barata: ofrece
 * ejecutar algo que `dotnet test` dirá que no existe. Es la misma decisión que ya se tomó con las
 * lentes de endpoints (ADR-027).
 *
 * **Por qué los resultados se leen de un TRX y no de la consola.** La salida del logger de consola
 * de VSTest está traducida al idioma del sistema: en un Windows en español dice `Con error` donde
 * la documentación dice `Failed`. Decidir sobre esas palabras es la trampa que ya costó dos
 * errores en este proyecto (los mensajes de git, la ausencia de `dotnet-ef`). El TRX es XML con
 * los nombres de estado invariables, así que la verdad sale de ahí; el parseo de la consola existe
 * sólo como camino degradado y se marca como tal.
 *
 * Todo lo de este archivo es puro: entra texto, sale estructura.
 */

export type TestFramework = 'xunit' | 'nunit' | 'mstest';

/** `fact` es una prueba sin datos; `theory`, una parametrizada. NUnit y MSTest usan `test`. */
export type TestKind = 'fact' | 'theory' | 'test';

export type TestStatus = 'unknown' | 'running' | 'passed' | 'failed' | 'skipped';

export interface TestCase {
  /** Nombre completamente cualificado. Es la identidad de la prueba en todo el IDE. */
  id: string;
  namespace: string | null;
  className: string;
  method: string;
  /** `DisplayName` del atributo si lo hay; si no, el nombre del método. */
  displayName: string;
  file: string;
  /** Línea del primer atributo: es donde se ancla la lente de código, encima de `[Fact]`. */
  line: number;
  /** Línea de la firma del método: es a donde salta el árbol al hacer clic. */
  methodLine: number;
  framework: TestFramework;
  kind: TestKind;
  /** Motivo declarado en `Skip = "..."`. Null si la prueba no está omitida en el código. */
  skip: string | null;
  /** Proyecto (.csproj) al que pertenece. Lo rellena quien recorre el disco. */
  project: string | null;
}

export interface TestResult {
  id: string;
  status: TestStatus;
  durationMs: number;
  /** Mensaje del assert que ha fallado. */
  message: string | null;
  stackTrace: string | null;
}

export interface TestRunSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** Duración total de la ejecución, en milisegundos. */
  durationMs: number;
  results: TestResult[];
  /**
   * true si los resultados salen de parsear la consola en vez del TRX. La interfaz lo dice: los
   * nombres pueden venir incompletos y las trazas partidas.
   */
  degraded: boolean;
}

export const EMPTY_SUMMARY: TestRunSummary = {
  passed: 0,
  failed: 0,
  skipped: 0,
  durationMs: 0,
  results: [],
  degraded: false,
};

// ---------------------------------------------------------------------------------------------
// Descubrimiento
// ---------------------------------------------------------------------------------------------

/** Atributo -> marco y naturaleza de la prueba. */
const TEST_ATTRIBUTES: Record<string, { framework: TestFramework; kind: TestKind }> = {
  Fact: { framework: 'xunit', kind: 'fact' },
  Theory: { framework: 'xunit', kind: 'theory' },
  Test: { framework: 'nunit', kind: 'test' },
  TestCase: { framework: 'nunit', kind: 'test' },
  TestCaseSource: { framework: 'nunit', kind: 'test' },
  TestMethod: { framework: 'mstest', kind: 'test' },
  DataTestMethod: { framework: 'mstest', kind: 'test' },
};

/** Modificadores y palabras que pueden preceder al tipo de retorno de un método. */
const METHOD_SIGNATURE = new RegExp(
  String.raw`^\s*(?:\[[^\]]*\]\s*)*` +
    String.raw`(?:(?:public|private|protected|internal|static|async|override|virtual|sealed|new|extern|unsafe|partial)\s+)*` +
    String.raw`[A-Za-z_][\w<>,\.\[\]\?\s]*?\s+` +
    String.raw`([A-Za-z_]\w*)\s*(?:<[^>()]*>)?\s*\(`,
);

const CLASS_DECLARATION = new RegExp(
  String.raw`^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|record)\s+)*` +
    String.raw`(?:class|record)\s+([A-Za-z_]\w*)`,
);

const FILE_SCOPED_NAMESPACE = new RegExp(String.raw`^\s*namespace\s+([\w\.]+)\s*;`);
const BLOCK_NAMESPACE = new RegExp(String.raw`^\s*namespace\s+([\w\.]+)\s*\{?\s*$`);

/** Nombres de atributo de una línea `[Theory, InlineData(1)]` o `[Fact(Skip = "…")]`. */
export function attributeNames(line: string): string[] {
  const names: string[] = [];
  const pattern = /(?:^|[\[,])\s*([A-Za-z_]\w*)/g;

  const inner = line.trim();
  if (!inner.startsWith('[')) return names;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    const name = match[1]!;
    names.push(name.endsWith('Attribute') ? name.slice(0, -'Attribute'.length) : name);
  }

  return names;
}

/** Valor de un argumento con nombre de un atributo: `DisplayName = "crea el producto"`. */
export function namedArgument(text: string, name: string): string | null {
  const pattern = new RegExp(String.raw`\b` + name + String.raw`\s*[:=]\s*"((?:[^"\\]|\\.)*)"`);
  const match = pattern.exec(text);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : null;
}

/**
 * Pruebas declaradas en un archivo C#.
 *
 * El recorrido es de una pasada y acumula los atributos que preceden a cada método: es como se
 * escriben de verdad, uno por línea o varios en la misma, y a veces con `[InlineData]` entre
 * medias. Un atributo que no pertenezca a ninguna prueba se descarta al llegar a la firma.
 */
export function findTests(source: string, file: string, project: string | null = null): TestCase[] {
  const lines = source.split(/\r?\n/);
  const tests: TestCase[] = [];

  let namespaceName: string | null = null;
  let className: string | null = null;

  let pending: { names: string[]; text: string; line: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('//')) continue;

    const fileScoped = FILE_SCOPED_NAMESPACE.exec(line);
    if (fileScoped) {
      namespaceName = fileScoped[1]!;
      continue;
    }

    const blockScoped = BLOCK_NAMESPACE.exec(line);
    if (blockScoped) {
      namespaceName = blockScoped[1]!;
      continue;
    }

    if (trimmed.startsWith('[')) {
      const names = attributeNames(trimmed);
      pending = pending === null
        ? { names, text: trimmed, line: index + 1 }
        : { names: [...pending.names, ...names], text: `${pending.text} ${trimmed}`, line: pending.line };
      continue;
    }

    const declaration = CLASS_DECLARATION.exec(line);
    if (declaration) {
      className = declaration[1]!;
      pending = null;
      continue;
    }

    if (pending === null) continue;

    const signature = METHOD_SIGNATURE.exec(line);
    if (!signature) {
      // Cualquier otra cosa (un campo, una llave suelta) rompe la cadena de atributos.
      if (trimmed !== '') pending = null;
      continue;
    }

    const attribute = pending.names.map((name) => TEST_ATTRIBUTES[name]).find((entry) => entry !== undefined);

    if (attribute !== undefined && className !== null) {
      const method = signature[1]!;
      const displayName = namedArgument(pending.text, 'DisplayName') ?? method;
      const skip = namedArgument(pending.text, 'Skip') ?? namedArgument(pending.text, 'Ignore');
      const id = qualify(namespaceName, className, method);

      tests.push({
        id,
        namespace: namespaceName,
        className,
        method,
        displayName,
        file,
        line: pending.line,
        methodLine: index + 1,
        framework: attribute.framework,
        // Un `[Theory]` sin datos y un `[Fact]` se ejecutan igual; la distinción es informativa.
        kind: pending.names.includes('Theory') ? 'theory' : attribute.kind,
        skip,
        project,
      });
    }

    pending = null;
  }

  return tests;
}

/** `Ns.Clase.Método`, con el espacio de nombres omitido si no lo hay. */
export function qualify(namespaceName: string | null, className: string, method: string): string {
  return namespaceName === null || namespaceName === '' ? `${className}.${method}` : `${namespaceName}.${className}.${method}`;
}

/** true si el archivo tiene pinta de contener pruebas. Evita leer medio repositorio. */
export function looksLikeTestFile(path: string): boolean {
  return /\.cs$/i.test(path) && !/\.(Designer|g|generated)\.cs$/i.test(path);
}

// ---------------------------------------------------------------------------------------------
// Árbol
// ---------------------------------------------------------------------------------------------

export interface TestClassNode {
  /** `Ns.Clase`, que es lo que se enseña en la fila de clase. */
  id: string;
  namespace: string | null;
  className: string;
  file: string;
  line: number;
  tests: TestCase[];
}

export interface TestProjectNode {
  /** Ruta del `.csproj`. */
  project: string;
  name: string;
  classes: TestClassNode[];
  count: number;
}

/**
 * Agrupa una lista plana en proyecto -> clase -> prueba.
 *
 * Se ordena por nombre en los tres niveles: un árbol que cambia de orden entre dos ejecuciones
 * hace imposible volver a encontrar la prueba que se acaba de mirar.
 */
export function buildTestTree(tests: readonly TestCase[], projectNames: Record<string, string> = {}): TestProjectNode[] {
  const byProject = new Map<string, Map<string, TestClassNode>>();

  for (const test of tests) {
    const project = test.project ?? '';
    const classes = byProject.get(project) ?? new Map<string, TestClassNode>();
    byProject.set(project, classes);

    const classId = test.namespace === null ? test.className : `${test.namespace}.${test.className}`;
    const node = classes.get(classId) ?? {
      id: classId,
      namespace: test.namespace,
      className: test.className,
      file: test.file,
      line: test.methodLine,
      tests: [],
    };

    node.tests.push(test);
    if (test.methodLine < node.line) node.line = test.methodLine;
    classes.set(classId, node);
  }

  return [...byProject.entries()]
    .map(([project, classes]) => ({
      project,
      name: projectNames[project] ?? baseName(project),
      classes: [...classes.values()]
        .map((node) => ({ ...node, tests: [...node.tests].sort((a, b) => a.method.localeCompare(b.method)) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      count: [...classes.values()].reduce((total, node) => total + node.tests.length, 0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return (parts[parts.length - 1] ?? path).replace(/\.csproj$/i, '');
}

/** Estado agregado de un grupo: falla > omitida > pasada > desconocida. */
export function aggregateStatus(statuses: readonly TestStatus[]): TestStatus {
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.length > 0 && statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.length > 0 && statuses.every((status) => status === 'skipped')) return 'skipped';
  if (statuses.includes('passed')) return 'passed';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Filtros y argumentos
// ---------------------------------------------------------------------------------------------

/**
 * Escapa un valor para el filtro de VSTest.
 *
 * Los operadores del lenguaje de filtros (`|`, `&`, `!`, `(`, `)`, `=`, `~`, `,`) se escapan con
 * barra invertida. Un nombre de método de C# no puede contener ninguno, pero el valor llega de
 * fuera de esta función y no es sitio para confiar.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/([\\|&!()=~,])/g, '\\$1');
}

/** `FullyQualifiedName=A|FullyQualifiedName=B`, que es como se ejecutan pruebas sueltas. */
export function filterForTests(ids: readonly string[]): string | null {
  const unique = [...new Set(ids.filter((id) => id.trim() !== ''))];
  if (unique.length === 0) return null;
  return unique.map((id) => `FullyQualifiedName=${escapeFilterValue(id)}`).join('|');
}

/**
 * Filtro de una clase entera.
 *
 * Se usa `~` (contiene) con el punto final, y no `=`: el nombre completamente cualificado de una
 * prueba es `Clase.Método`, así que una igualdad con el nombre de la clase no casaría con nada.
 */
export function filterForClass(classId: string): string {
  return `FullyQualifiedName~${escapeFilterValue(`${classId}.`)}`;
}

export interface TestRunArgsOptions {
  /** `.sln` o `.csproj` sobre el que se ejecuta. */
  target: string;
  filter?: string | null;
  /** Nombre del archivo TRX. Va dentro de `resultsDirectory`. */
  trxFileName: string;
  resultsDirectory: string;
  /** `--verbosity` heredado del ajuste global. */
  verbosity?: string | null;
  /** true para no volver a compilar: la segunda ejecución seguida es la mitad de rápida. */
  noBuild?: boolean;
}

/**
 * Argumentos de `dotnet test`.
 *
 * El logger TRX es la parte que no se puede quitar: es la única fuente de resultados que no
 * depende del idioma del sistema.
 */
export function testRunArgs(options: TestRunArgsOptions): string[] {
  const args = ['test', options.target, '--nologo'];

  if (options.noBuild === true) args.push('--no-build');
  if (options.filter !== undefined && options.filter !== null && options.filter !== '') {
    args.push('--filter', options.filter);
  }

  args.push('--logger', `trx;LogFileName=${options.trxFileName}`, '--results-directory', options.resultsDirectory);

  if (options.verbosity !== undefined && options.verbosity !== null && options.verbosity !== '') {
    args.push('--verbosity', options.verbosity);
  }

  return args;
}

// ---------------------------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------------------------

/** Estados del TRX. Son nombres de enumeración, no texto traducido. */
const TRX_OUTCOME: Record<string, TestStatus> = {
  passed: 'passed',
  failed: 'failed',
  error: 'failed',
  timeout: 'failed',
  aborted: 'failed',
  notexecuted: 'skipped',
  skipped: 'skipped',
  inconclusive: 'skipped',
  notrunnable: 'skipped',
  warning: 'skipped',
  pending: 'unknown',
  inprogress: 'running',
};

export function outcomeToStatus(outcome: string): TestStatus {
  return TRX_OUTCOME[outcome.trim().toLowerCase()] ?? 'unknown';
}

/**
 * `01:23:45.6789012` -> milisegundos.
 *
 * El TRX escribe la duración como un `TimeSpan` de .NET, con hasta siete decimales de segundo.
 * Un valor irreconocible vale 0: una duración es información, no un resultado.
 */
export function parseDuration(value: string | null | undefined): number {
  if (typeof value !== 'string') return 0;

  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return 0;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);

  return Math.round(((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000);
}

/**
 * Nombre completamente cualificado de una prueba parametrizada, sin los datos.
 *
 * xUnit publica `Ns.Clase.Método(valor: 3)` como nombre de la ejecución; el árbol tiene una sola
 * fila por método, así que los casos de un `[Theory]` se agregan bajo ella.
 */
export function baseTestId(fullyQualifiedName: string): string {
  const parenthesis = fullyQualifiedName.indexOf('(');
  return (parenthesis === -1 ? fullyQualifiedName : fullyQualifiedName.slice(0, parenthesis)).trim();
}

/** Une los resultados de varios casos de un mismo método en una sola fila del árbol. */
export function collapseResults(results: readonly TestResult[]): TestResult[] {
  const byId = new Map<string, TestResult>();

  for (const result of results) {
    const id = baseTestId(result.id);
    const existing = byId.get(id);

    if (existing === undefined) {
      byId.set(id, { ...result, id });
      continue;
    }

    byId.set(id, {
      id,
      // Un solo caso en rojo pinta el método en rojo: es lo que hay que ir a arreglar.
      status: aggregateStatus([existing.status, result.status]),
      durationMs: existing.durationMs + result.durationMs,
      message: existing.message ?? result.message,
      stackTrace: existing.stackTrace ?? result.stackTrace,
    });
  }

  return [...byId.values()];
}

export function summarize(results: readonly TestResult[], durationMs = 0, degraded = false): TestRunSummary {
  return {
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    durationMs,
    results: [...results],
    degraded,
  };
}

/**
 * Camino degradado: leer los resultados de la salida de consola.
 *
 * Sólo se usa cuando el TRX no existe —el runner ha reventado antes de escribirlo, o el proyecto
 * no es de pruebas—, y **se marca como degradado** porque decide sobre palabras traducidas. Se
 * reconocen las cuatro que escriben todos los loggers en inglés y sus equivalentes en español,
 * que es el idioma con el que se desarrolla este IDE; cualquier otro idioma cae en "desconocido"
 * en vez de inventarse un estado.
 */
const CONSOLE_OUTCOMES: Array<{ words: string[]; status: TestStatus }> = [
  { words: ['passed', 'correcto', 'superada'], status: 'passed' },
  { words: ['failed', 'con error', 'erróneo', 'error'], status: 'failed' },
  { words: ['skipped', 'omitido', 'omitida'], status: 'skipped' },
];

export function parseConsoleResults(output: string): TestResult[] {
  const results: TestResult[] = [];
  const seen = new Set<string>();

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;

    const match = /^([A-Za-zÁÉÍÓÚÑáéíóúñ ]{3,12})\s+([\w\.]+(?:\([^)]*\))?)(?:\s+\[[^\]]*\])?$/.exec(line);
    if (!match) continue;

    const word = match[1]!.trim().toLowerCase();
    const entry = CONSOLE_OUTCOMES.find((candidate) => candidate.words.includes(word));
    if (entry === undefined) continue;

    const id = match[2]!;
    if (seen.has(`${entry.status}:${id}`)) continue;
    seen.add(`${entry.status}:${id}`);

    results.push({ id, status: entry.status, durationMs: 0, message: null, stackTrace: null });
  }

  return results;
}

/** Texto corto para la barra de avisos: `14 correctas · 1 con error · 0 omitidas (3,2 s)`. */
export function describeSummary(summary: TestRunSummary): string {
  const seconds = (summary.durationMs / 1000).toFixed(1).replace('.', ',');
  return `${summary.passed} correctas · ${summary.failed} con error · ${summary.skipped} omitidas (${seconds} s)`;
}
