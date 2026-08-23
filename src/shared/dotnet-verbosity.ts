/**
 * Nivel de detalle de la salida de la CLI de .NET.
 *
 * Un solo ajuste gobierna todo lo que el IDE lanza: `dotnet build`, `run`, `watch`, `test`,
 * `clean`, `restore`, `format` y el proceso que arranca el depurador. La traducción de "nivel" a
 * "argumentos y variables de entorno" vive aquí, en funciones puras, por dos motivos:
 *
 * 1. Cada verbo de la CLI admite la bandera de una forma distinta —`dotnet watch` no tiene
 *    `--verbosity`, tiene `--verbose`, y va **antes** del subcomando—, y eso es exactamente el
 *    tipo de detalle que se descubre tarde y a mano si no está probado.
 * 2. "Recopilar todas las excepciones de ensamblados y las trazas de arranque" no es una bandera
 *    de MSBuild: son variables de entorno del host de .NET y del logger de ASP.NET Core. Ponerlas
 *    en el mismo sitio que la bandera evita que un nivel diga una cosa y el proceso haga otra.
 */

export const DOTNET_VERBOSITY_LEVELS = ['minimal', 'normal', 'detailed', 'diagnostic'] as const;

export type DotnetVerbosity = (typeof DOTNET_VERBOSITY_LEVELS)[number];

export const DEFAULT_DOTNET_VERBOSITY: DotnetVerbosity = 'minimal';

export interface DotnetVerbosityInfo {
  id: DotnetVerbosity;
  label: string;
  hint: string;
}

export const DOTNET_VERBOSITY_INFO: readonly DotnetVerbosityInfo[] = [
  {
    id: 'minimal',
    label: 'Minimal',
    hint: 'Errores, advertencias y el resumen. Es lo que enseña `dotnet build` por defecto.',
  },
  {
    id: 'normal',
    label: 'Normal',
    hint: 'Añade los objetivos de MSBuild que se ejecutan y los proyectos que se compilan.',
  },
  {
    id: 'detailed',
    label: 'Detailed',
    hint:
      'Traza de MSBuild completa, registro de ASP.NET Core en Debug y errores detallados de la ' +
      'aplicación. Es el nivel para averiguar por qué algo no arranca.',
  },
  {
    id: 'diagnostic',
    label: 'Diagnostic',
    hint:
      'Todo lo anterior más la resolución de ensamblados del host (COREHOST_TRACE) y el registro ' +
      'en Trace. Escribe muchísimo: úsalo para un fallo concreto, no para el día a día.',
  },
];

export function verbosityInfo(level: DotnetVerbosity): DotnetVerbosityInfo {
  return DOTNET_VERBOSITY_INFO.find((entry) => entry.id === level) ?? DOTNET_VERBOSITY_INFO[0]!;
}

/** Valida lo que llegue de `settings.json` o del renderer. */
export function coerceVerbosity(raw: unknown): DotnetVerbosity {
  return typeof raw === 'string' && (DOTNET_VERBOSITY_LEVELS as readonly string[]).includes(raw)
    ? (raw as DotnetVerbosity)
    : DEFAULT_DOTNET_VERBOSITY;
}

/**
 * Verbos de la CLI que aceptan `--verbosity <nivel>`.
 *
 * `watch` no está en la lista a propósito: su bandera es `--verbose`, sin nivel, y cualquier
 * argumento desconocido se lo pasa al comando hijo, así que colar aquí un `--verbosity` acabaría
 * llegando a la aplicación como argumento suyo.
 */
const SUPPORTS_VERBOSITY: ReadonlySet<string> = new Set([
  'build', 'rebuild', 'clean', 'restore', 'test', 'run', 'format', 'publish', 'pack',
]);

/** Niveles a partir de los cuales `dotnet watch` pasa a modo verboso. */
const WATCH_VERBOSE_FROM: ReadonlySet<DotnetVerbosity> = new Set<DotnetVerbosity>([
  'detailed',
  'diagnostic',
]);

export interface DotnetVerbosityPlan {
  /** Argumentos que van justo detrás del verbo: `dotnet watch --verbose --project X`. */
  leading: string[];
  /** Argumentos que van detrás del objetivo: `dotnet build App.csproj --verbosity detailed`. */
  trailing: string[];
}

/**
 * Argumentos que hay que inyectar para un verbo concreto.
 *
 * El nivel se emite **siempre**, incluso `minimal`: coincide con el valor por defecto de MSBuild,
 * así que no cambia nada, pero deja el comando escrito en la salida diciendo la verdad sobre con
 * qué verbosidad se lanzó.
 */
export function verbosityPlan(kind: string, level: DotnetVerbosity): DotnetVerbosityPlan {
  if (kind === 'watch') {
    return { leading: WATCH_VERBOSE_FROM.has(level) ? ['--verbose'] : [], trailing: [] };
  }

  if (!SUPPORTS_VERBOSITY.has(kind)) return { leading: [], trailing: [] };

  return { leading: [], trailing: ['--verbosity', level] };
}

/**
 * Variables de entorno del nivel.
 *
 * Qué aporta cada una:
 *  - `MSBUILDTERMINALLOGGER=off`: el logger de terminal del SDK 9+ colapsa la salida en un
 *    resumen animado. Con verbosidad alta eso se come justo lo que se ha pedido ver.
 *  - `Logging__LogLevel__*`: el registro de la aplicación ASP.NET Core, que es donde aparecen las
 *    excepciones tragadas por un middleware.
 *  - `ASPNETCORE_DETAILEDERRORS`: la página de error con la excepción entera en vez de un 500 mudo.
 *  - `COREHOST_TRACE`: resolución de ensamblados y arranque del host. Es lo único que explica un
 *    "no se pudo cargar el archivo o ensamblado" sin más contexto.
 */
export function verbosityEnvironment(level: DotnetVerbosity): Record<string, string> {
  if (level === 'minimal' || level === 'normal') return {};

  const base: Record<string, string> = {
    MSBUILDTERMINALLOGGER: 'off',
    ASPNETCORE_DETAILEDERRORS: 'true',
    DOTNET_EnableDiagnostics: '1',
    Logging__LogLevel__Default: 'Debug',
    'Logging__LogLevel__Microsoft.AspNetCore': 'Debug',
    'Logging__LogLevel__Microsoft.Hosting.Lifetime': 'Debug',
  };

  if (level === 'detailed') return base;

  return {
    ...base,
    Logging__LogLevel__Default: 'Trace',
    'Logging__LogLevel__Microsoft.AspNetCore': 'Trace',
    'Logging__LogLevel__Microsoft.Hosting.Lifetime': 'Trace',
    'Logging__LogLevel__Microsoft.EntityFrameworkCore': 'Debug',
    COREHOST_TRACE: '1',
    COREHOST_TRACE_VERBOSITY: '3',
    DOTNET_CLI_CONTEXT_VERBOSE: 'true',
  };
}

/**
 * Entorno del proceso que lanza el depurador.
 *
 * NetCoreDbg arranca el `.dll` directamente: no hay MSBuild por medio, así que la variable del
 * logger de terminal no pinta nada. Lo demás sí, y es justo lo que hace que una sesión de
 * depuración diga por qué no ha podido cargar un ensamblado.
 */
export function debugEnvironment(level: DotnetVerbosity): Record<string, string> {
  const environment = { ...verbosityEnvironment(level) };
  delete environment['MSBUILDTERMINALLOGGER'];
  return environment;
}

/** Resumen para la salida: `Verbosidad: detailed`. */
export function describeVerbosity(level: DotnetVerbosity): string {
  return `${verbosityInfo(level).label} (${level})`;
}
