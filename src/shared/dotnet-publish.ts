/**
 * Publicación de un proyecto: de las opciones del diálogo a los argumentos de `dotnet publish`.
 *
 * Es un modelo puro, y está aparte por el mismo motivo que la verbosidad: `dotnet publish` tiene
 * banderas que **dependen unas de otras**, y esa clase de regla es la que se descubre tarde y a
 * mano si no está probada.
 *
 * Las dos que importan:
 *
 *  - **`PublishSingleFile` y `PublishReadyToRun` sólo existen si hay un RID.** Sin `-r` (o sin
 *    `--self-contained`, que lo implica en la práctica) el SDK las ignora o falla según la versión;
 *    en el mejor caso se publica un directorio normal y el usuario se queda esperando el `.exe`
 *    único que había pedido. Aquí no se emiten: la interfaz atenúa la casilla y el modelo la
 *    descarta aunque llegue encendida, porque las preferencias guardadas de la vez anterior pueden
 *    traerla puesta con un modo distinto.
 *  - **La ruta de salida se sanea antes de ser un argumento.** No por inyección —todo viaja como
 *    array, nunca como línea de shell (ADR-004)— sino porque una ruta con barras mezcladas, con
 *    espacios al principio o terminada en separador produce un `bin/Release/net9.0/publish/` que no
 *    es el que el usuario escribió y que luego no encuentra.
 *
 * Lo que **no** decide este módulo: dónde está el proyecto ni si la ruta de salida es aceptable.
 * Eso lo comprueba el proceso principal contra el workspace, como todo lo demás.
 */

export const PUBLISH_CONFIGURATIONS = ['Release', 'Debug'] as const;

export type PublishConfiguration = (typeof PUBLISH_CONFIGURATIONS)[number];

/**
 * Modo de despliegue.
 *
 *  - `framework-dependent`: lo que produce `dotnet publish` a secas. Necesita el runtime instalado
 *    en la máquina de destino y pesa unos megas.
 *  - `self-contained`: lleva el runtime dentro. Exige RID y pesa entre 60 y 80 MB.
 *  - `runtime-dependent`: dependiente del framework **pero** compilado para un RID concreto. Es el
 *    modo que casi nadie recuerda que existe y el que permite `PublishSingleFile` sin cargar con
 *    el runtime entero.
 */
export const PUBLISH_MODES = ['framework-dependent', 'runtime-dependent', 'self-contained'] as const;

export type PublishMode = (typeof PUBLISH_MODES)[number];

export interface PublishModeInfo {
  id: PublishMode;
  label: string;
  hint: string;
  /** true si el modo exige un identificador de runtime. */
  needsRuntime: boolean;
}

export const PUBLISH_MODE_INFO: readonly PublishModeInfo[] = [
  {
    id: 'framework-dependent',
    label: 'Dependiente del framework',
    hint:
      'Portable. La máquina de destino necesita el runtime de .NET instalado. Es lo que produce ' +
      '`dotnet publish` sin más banderas.',
    needsRuntime: false,
  },
  {
    id: 'runtime-dependent',
    label: 'Dependiente del framework, para un destino',
    hint:
      'Compilado para un sistema concreto pero sin el runtime dentro. Permite el archivo único ' +
      'sin cargar con los 60 MB del runtime.',
    needsRuntime: true,
  },
  {
    id: 'self-contained',
    label: 'Autocontenido',
    hint:
      'Lleva el runtime dentro: se ejecuta en una máquina sin .NET instalado. Ocupa entre 60 y ' +
      '80 MB antes de recortar.',
    needsRuntime: true,
  },
];

export function publishModeInfo(mode: PublishMode): PublishModeInfo {
  return PUBLISH_MODE_INFO.find((entry) => entry.id === mode) ?? PUBLISH_MODE_INFO[0]!;
}

/**
 * Identificadores de runtime ofrecidos.
 *
 * No es la lista entera del catálogo de RID —son cientos— sino la de los destinos que alguien
 * publica de verdad desde un IDE de escritorio. El diálogo admite además escribir uno a mano, y
 * `isValidRuntimeIdentifier` es quien decide si vale.
 */
export const PUBLISH_RUNTIMES: readonly { id: string; label: string }[] = [
  { id: 'win-x64', label: 'Windows x64' },
  { id: 'win-arm64', label: 'Windows ARM64' },
  { id: 'linux-x64', label: 'Linux x64' },
  { id: 'linux-arm64', label: 'Linux ARM64' },
  { id: 'linux-musl-x64', label: 'Linux x64 (musl / Alpine)' },
  { id: 'osx-x64', label: 'macOS Intel' },
  { id: 'osx-arm64', label: 'macOS Apple Silicon' },
];

/**
 * Forma de un identificador de runtime.
 *
 * Acaba dentro de un `argv`, así que se valida antes de construirlo: minúsculas, dígitos y guiones,
 * empezando por letra. `win-x64`, `linux-musl-arm64`, `osx.13-arm64`. Lo que no encaje se descarta
 * en vez de escaparse, que es la decisión conservadora: como mucho se publica portable.
 */
const RUNTIME_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*(?:-[a-z0-9]+)+$/;

export function isValidRuntimeIdentifier(value: string): boolean {
  return RUNTIME_ID.test(value.trim());
}

/**
 * Forma de un marco de destino (`net9.0`, `net10.0-windows`, `netstandard2.1`).
 *
 * Mismo criterio: llega del `.csproj` —o sea, de un archivo del disco— y acaba siendo un argumento.
 */
const FRAMEWORK_ID = /^[a-z][a-z0-9.]*(?:-[a-z0-9.]+)?$/;

export function isValidFramework(value: string): boolean {
  return FRAMEWORK_ID.test(value.trim());
}

export interface PublishOptions {
  configuration: PublishConfiguration;
  /** Marco de destino. Cadena vacía = el único que declare el proyecto, sin `-f`. */
  framework: string;
  mode: PublishMode;
  /** Identificador de runtime. Se ignora en el modo dependiente del framework. */
  runtime: string;
  /** Carpeta de salida. Vacía = la que elija el SDK (`bin/<config>/<tfm>/publish`). */
  outputDir: string;
  singleFile: boolean;
  readyToRun: boolean;
  /** `PublishTrimmed`: sólo tiene sentido autocontenido, y recorta de verdad. */
  trimmed: boolean;
}

export const DEFAULT_PUBLISH_OPTIONS: PublishOptions = {
  configuration: 'Release',
  framework: '',
  mode: 'framework-dependent',
  runtime: '',
  outputDir: '',
  singleFile: false,
  readyToRun: false,
  trimmed: false,
};

/**
 * ¿Hay un RID efectivo?
 *
 * Es la pregunta de la que cuelga todo lo demás: sin RID no hay archivo único, no hay ReadyToRun y
 * no hay recorte. Un modo que lo exige y llega sin él **no** tiene RID: no se inventa uno, porque
 * adivinar el destino de una publicación es justo lo que no se le puede pedir a un IDE.
 */
export function effectiveRuntime(options: PublishOptions): string | null {
  if (!publishModeInfo(options.mode).needsRuntime) return null;

  const runtime = options.runtime.trim();
  return runtime !== '' && isValidRuntimeIdentifier(runtime) ? runtime : null;
}

/** true si el modo lleva el runtime dentro. */
export function isSelfContained(options: PublishOptions): boolean {
  return options.mode === 'self-contained';
}

/**
 * ¿Se puede pedir archivo único / ReadyToRun / recorte?
 *
 * La interfaz atenúa las casillas con esto, y el constructor de argumentos lo vuelve a comprobar:
 * las preferencias guardadas de una publicación anterior pueden traer la casilla encendida con un
 * modo que ya no la admite, y una bandera que se emite y no hace nada es peor que no ofrecerla.
 */
export function supportsSingleFile(options: PublishOptions): boolean {
  return effectiveRuntime(options) !== null;
}

export function supportsReadyToRun(options: PublishOptions): boolean {
  return effectiveRuntime(options) !== null;
}

export function supportsTrimming(options: PublishOptions): boolean {
  return isSelfContained(options) && effectiveRuntime(options) !== null;
}

/**
 * Sanea una ruta de salida.
 *
 * Qué hace, y por qué cada cosa:
 *  - recorta espacios de los extremos: pegar una ruta desde el explorador de Windows arrastra uno
 *    delante más veces de las que parece, y `dotnet` crearía una carpeta cuyo nombre empieza por
 *    espacio;
 *  - unifica las barras a `/`, que las dos plataformas entienden, en vez de mezclarlas;
 *  - colapsa los separadores repetidos, salvo el `\\` inicial de una ruta UNC de Windows;
 *  - quita el separador final: `-o out/` y `-o out` son la misma carpeta, y dejarlo hace que la
 *    ruta que se enseña al terminar no coincida con la que se escribió.
 *
 * Lo que **no** hace: decidir si la ruta es aceptable. Eso es del guardián del workspace.
 */
export function sanitizeOutputDir(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';

  const unc = /^[\\/]{2}[^\\/]/.test(trimmed);
  const normalized = trimmed.replace(/[\\/]+/g, '/');
  const withPrefix = unc ? `//${normalized.replace(/^\/+/, '')}` : normalized;

  // La barra final sobra salvo que la ruta sea sólo eso: `/` y `C:/` son raíces, no rutas con cola.
  const withoutTail = withPrefix.replace(/(?<=.)\/+$/, '');
  return /^[A-Za-z]:$/.test(withoutTail) ? `${withoutTail}/` : withoutTail;
}

/**
 * Argumentos de `dotnet publish`, sin el verbo.
 *
 * El orden es el que se lee bien en el panel: qué se publica, con qué configuración, para qué
 * destino, adónde va y por último las propiedades de MSBuild. La verbosidad la añade el servicio,
 * como en cualquier otra tarea.
 */
export function publishArgs(projectPath: string, options: PublishOptions): string[] {
  const args: string[] = [projectPath, '-c', options.configuration];

  const framework = options.framework.trim();
  if (framework !== '' && isValidFramework(framework)) args.push('-f', framework);

  const runtime = effectiveRuntime(options);
  if (runtime !== null) args.push('--runtime', runtime);

  // `--self-contained` se emite **siempre que haya RID**, también en `false`: desde .NET 6 un `-r`
  // sin la bandera avisa de que el valor por defecto cambió, y dejarlo implícito es exactamente el
  // tipo de detalle que hace que dos máquinas produzcan artefactos distintos.
  if (runtime !== null) args.push('--self-contained', isSelfContained(options) ? 'true' : 'false');

  const output = sanitizeOutputDir(options.outputDir);
  if (output !== '') args.push('-o', output);

  // Las tres dependen del RID. Se vuelven a comprobar aquí y no se confía en la interfaz: lo que
  // llega puede venir de `publish-profiles.json`, escrito por otra versión del IDE.
  if (options.singleFile && supportsSingleFile(options)) args.push('-p:PublishSingleFile=true');
  if (options.readyToRun && supportsReadyToRun(options)) args.push('-p:PublishReadyToRun=true');
  if (options.trimmed && supportsTrimming(options)) args.push('-p:PublishTrimmed=true');

  return args;
}

/**
 * Valida lo que llega del renderer o del disco.
 *
 * Nunca lanza: un campo inválido vuelve a su valor por defecto. Y las banderas que dependen del RID
 * se **apagan** si el modo resultante no las admite, en vez de conservarse: guardadas encendidas
 * reaparecerían en el diálogo marcadas y sin efecto.
 */
export function coercePublishOptions(raw: unknown): PublishOptions {
  const options: PublishOptions = { ...DEFAULT_PUBLISH_OPTIONS };
  if (typeof raw !== 'object' || raw === null) return options;

  const source = raw as Record<string, unknown>;

  if ((PUBLISH_CONFIGURATIONS as readonly string[]).includes(source['configuration'] as string)) {
    options.configuration = source['configuration'] as PublishConfiguration;
  }
  if ((PUBLISH_MODES as readonly string[]).includes(source['mode'] as string)) {
    options.mode = source['mode'] as PublishMode;
  }
  if (typeof source['framework'] === 'string' && isValidFramework(source['framework'])) {
    options.framework = source['framework'].trim();
  }
  if (typeof source['runtime'] === 'string' && isValidRuntimeIdentifier(source['runtime'])) {
    options.runtime = source['runtime'].trim();
  }
  if (typeof source['outputDir'] === 'string') {
    options.outputDir = sanitizeOutputDir(source['outputDir']);
  }

  options.singleFile = source['singleFile'] === true && supportsSingleFile(options);
  options.readyToRun = source['readyToRun'] === true && supportsReadyToRun(options);
  options.trimmed = source['trimmed'] === true && supportsTrimming(options);

  return options;
}

/**
 * Carpeta que va a contener el resultado, para poder abrirla al terminar.
 *
 * Sin `-o`, el SDK escribe en `<proyecto>/bin/<configuración>/<tfm>/publish`, y con RID mete el
 * identificador por medio. Se reproduce esa ruta en vez de rastrear la salida de MSBuild: el
 * mensaje "…-> ruta" está traducido al idioma del sistema, que es justo lo que el ADR-028 dice que
 * no se puede mirar.
 *
 * `framework` vacío devuelve `null`: sin saber el marco de destino no se puede componer la ruta, y
 * enseñar una carpeta que no existe es peor que no enseñar ninguna.
 */
export function publishOutputPath(projectDirectory: string, options: PublishOptions): string | null {
  const output = sanitizeOutputDir(options.outputDir);
  if (output !== '') return output;

  const framework = options.framework.trim();
  if (framework === '' || !isValidFramework(framework)) return null;

  const runtime = effectiveRuntime(options);
  const base = projectDirectory.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const segments = ['bin', options.configuration, framework, ...(runtime ? [runtime] : []), 'publish'];

  return `${base}/${segments.join('/')}`;
}

/** Resumen de una línea para la salida del panel: qué se está publicando y cómo. */
export function describePublish(options: PublishOptions): string {
  const parts: string[] = [options.configuration];
  if (options.framework.trim() !== '') parts.push(options.framework.trim());

  const runtime = effectiveRuntime(options);
  parts.push(runtime === null ? 'portable' : runtime);
  if (isSelfContained(options)) parts.push('autocontenido');
  if (options.singleFile && supportsSingleFile(options)) parts.push('archivo único');
  if (options.readyToRun && supportsReadyToRun(options)) parts.push('ReadyToRun');
  if (options.trimmed && supportsTrimming(options)) parts.push('recortado');

  return parts.join(' · ');
}

/**
 * Aviso de por qué una casilla está atenuada.
 *
 * Una casilla apagada y sin explicación se lee como un fallo del IDE. `null` cuando no hay nada que
 * explicar, para que la vista no tenga que comparar cadenas.
 */
export function disabledReason(options: PublishOptions): string | null {
  if (effectiveRuntime(options) !== null) return null;

  return publishModeInfo(options.mode).needsRuntime
    ? 'Elige un destino: el archivo único y ReadyToRun necesitan un identificador de runtime.'
    : 'El archivo único y ReadyToRun necesitan publicar para un destino concreto.';
}

export interface PublishSummary {
  message: string;
  level: 'ok' | 'error';
  /** Carpeta que abrir, si se pudo deducir y la publicación fue bien. */
  folder: string | null;
}

/**
 * Resultado, tal y como se escribe en el panel inferior.
 *
 * Se nombra el proyecto y la carpeta: "publicado correctamente" obliga a ir a buscar dónde, y quien
 * acaba de publicar lo siguiente que quiere es abrir esa carpeta.
 */
export function summarizePublish(
  projectName: string,
  outputPath: string | null,
  exitCode: number | null,
): PublishSummary {
  if (exitCode !== 0) {
    return {
      message: `No se ha podido publicar ${projectName} (código ${exitCode ?? 'desconocido'}). La salida está en el panel inferior.`,
      level: 'error',
      folder: null,
    };
  }

  return {
    message:
      outputPath === null
        ? `${projectName} publicado.`
        : `${projectName} publicado en ${outputPath}`,
    level: 'ok',
    folder: outputPath,
  };
}
