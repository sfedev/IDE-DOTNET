/**
 * Modelo de las actualizaciones automáticas.
 *
 * Todo lo que decide *si hay una versión nueva*, *cuál de los artefactos publicados sirve para
 * esta máquina* y *cómo se instala* vive aquí, y es puro: se prueba con respuestas reales del feed
 * sin red, sin Electron y sin instalar nada.
 *
 * Tres decisiones que parecen detalles y no lo son:
 *
 *  - **La comparación es SemVer de verdad, no de cadenas.** `2.10.0` es posterior a `2.9.0` aunque
 *    ordenadas como texto digan lo contrario, y `2.1.0-beta.1` es *anterior* a `2.1.0`. Un IDE que
 *    ofrece "actualizar" a una versión más vieja pierde la confianza del usuario para siempre.
 *  - **El artefacto se elige por plataforma y arquitectura**, no por orden de publicación. Un `.dmg`
 *    de arm64 descargado en un Windows x64 es una descarga de 120 MB que no sirve para nada.
 *  - **No todo se puede instalar en silencio.** En Windows el instalador NSIS acepta `/S`; un `.dmg`
 *    de macOS necesita que alguien arrastre la app a Aplicaciones. El modelo lo dice explícitamente
 *    (`silent` frente a `open`) en vez de fingir que los dos casos son iguales.
 *  - **Un ciclo que empieza tiene que cerrarse.** Aplicar una actualización cierra el IDE, y lo
 *    siguiente que ve el usuario es un arranque idéntico al de siempre: no sabe si se instaló, si
 *    canceló el aviso de permisos de Windows o si el instalador falló. `judgePending` mira el
 *    registro que quedó en el disco y dicta cuál de los cuatro casos se ha dado; `outcomeHeadline`
 *    y `outcomeMessage` lo ponen en palabras. Es puro a propósito: el texto que cierra el bucle es
 *    justo el que no se puede revisar sin publicar una release de verdad.
 */

/** Feed de versiones: las releases publicadas del repositorio. Público y sin autenticación. */
export const UPDATE_FEED = 'https://api.github.com/repos/sfedev/IDE-DOTNET/releases';

/** Cuánto se espera antes de la primera comprobación automática, desde el arranque. */
export const STARTUP_CHECK_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// SemVer
// ---------------------------------------------------------------------------------------------

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  /** Identificadores de prelanzamiento ya troceados: `2.1.0-beta.2` -> `['beta', 2]`. */
  prerelease: Array<string | number>;
  raw: string;
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Trocea una versión. Devuelve `null` si no encaja: un tag de release puede ser cualquier cosa
 * (`nightly`, `latest`, `v2.1`), y lo que no se entiende se descarta en vez de adivinarse.
 */
export function parseVersion(value: string): SemanticVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;

  const prerelease = (match[4] ?? '')
    .split('.')
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: value.trim().replace(/^v/, ''),
  };
}

function comparePrerelease(a: Array<string | number>, b: Array<string | number>): number {
  // Sin prelanzamiento gana: 2.1.0 es posterior a 2.1.0-rc.1.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];

    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftIsNumber = typeof left === 'number';
    const rightIsNumber = typeof right === 'number';

    // Los identificadores numéricos van siempre antes que los alfanuméricos (regla de SemVer).
    if (leftIsNumber && !rightIsNumber) return -1;
    if (!leftIsNumber && rightIsNumber) return 1;

    if (leftIsNumber && rightIsNumber) {
      if (left !== right) return left < right ? -1 : 1;
      continue;
    }

    const comparison = String(left).localeCompare(String(right));
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }

  return 0;
}

/** Orden SemVer: negativo si `a` es anterior a `b`. Los metadatos de build no cuentan. */
export function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * ¿`candidate` es posterior a `current`?
 *
 * Una versión que no se entiende **no** es más nueva. Es la respuesta conservadora: como mucho no
 * se ofrece una actualización que existía; al revés se ofrecería una que no existe.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (left === null || right === null) return false;
  return compareVersions(left, right) > 0;
}

// ---------------------------------------------------------------------------------------------
// Feed de releases
// ---------------------------------------------------------------------------------------------

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  contentType: string | null;
}

export interface ReleaseInfo {
  /** Versión normalizada sin la `v` del tag. */
  version: string;
  tag: string;
  name: string;
  /** Cuerpo de la release tal cual lo publicó quien la creó (Markdown). */
  notes: string;
  publishedAtUtc: string | null;
  prerelease: boolean;
  draft: boolean;
  htmlUrl: string | null;
  assets: ReleaseAsset[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOf(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseAsset(raw: unknown): ReleaseAsset | null {
  const source = asRecord(raw);
  if (source === null) return null;

  const name = stringOf(source, 'name');
  const url = stringOf(source, 'browser_download_url') ?? stringOf(source, 'url');
  if (name === null || url === null) return null;

  // Sólo HTTPS: el feed es texto que viene de la red y acaba siendo el destino de una descarga
  // que después se ejecuta. Un `http://` aquí sería una actualización manipulable en tránsito.
  if (!url.startsWith('https://')) return null;

  const size = source['size'];

  return {
    name,
    url,
    size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
    contentType: stringOf(source, 'content_type'),
  };
}

/**
 * Lee la respuesta del feed: acepta la lista (`/releases`) y la release suelta (`/releases/latest`).
 *
 * Lo que no tenga un tag con forma de versión se descarta. Un repositorio real acumula tags de
 * pruebas, y ninguno de ellos debe poder convertirse en "hay una versión nueva".
 */
export function parseReleaseFeed(raw: unknown): ReleaseInfo[] {
  const entries = Array.isArray(raw) ? raw : [raw];
  const releases: ReleaseInfo[] = [];

  for (const entry of entries) {
    const source = asRecord(entry);
    if (source === null) continue;

    const tag = stringOf(source, 'tag_name') ?? stringOf(source, 'name');
    if (tag === null) continue;

    const version = parseVersion(tag);
    if (version === null) continue;

    const assets: ReleaseAsset[] = [];
    if (Array.isArray(source['assets'])) {
      for (const asset of source['assets']) {
        const parsed = parseAsset(asset);
        if (parsed !== null) assets.push(parsed);
      }
    }

    releases.push({
      version: version.raw,
      tag,
      name: stringOf(source, 'name') ?? tag,
      notes: stringOf(source, 'body') ?? '',
      publishedAtUtc: stringOf(source, 'published_at') ?? stringOf(source, 'created_at'),
      prerelease: source['prerelease'] === true || version.prerelease.length > 0,
      draft: source['draft'] === true,
      htmlUrl: stringOf(source, 'html_url'),
      assets,
    });
  }

  return releases.sort((a, b) => {
    const left = parseVersion(a.version);
    const right = parseVersion(b.version);
    if (left === null || right === null) return 0;
    return compareVersions(right, left);
  });
}

// ---------------------------------------------------------------------------------------------
// Selección de release y de artefacto
// ---------------------------------------------------------------------------------------------

export interface UpdateQuery {
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Con `false` (lo normal) las betas ni se miran. */
  allowPrerelease?: boolean;
}

export interface UpdateCandidate {
  release: ReleaseInfo;
  /** Artefacto que sirve para esta plataforma y arquitectura, o `null` si no hay ninguno. */
  asset: ReleaseAsset | null;
}

/**
 * Extensiones que valen por plataforma, en orden de preferencia.
 *
 * En Windows el instalador NSIS va antes que el portable: es el único que sabe reemplazar la
 * instalación existente sin que el usuario descomprima nada.
 */
const PLATFORM_EXTENSIONS: Record<string, string[]> = {
  win32: ['.exe', '.zip'],
  darwin: ['.dmg', '.zip'],
  linux: ['.appimage', '.zip'],
};

/**
 * Marcas que delatan que un artefacto es de **otra** plataforma.
 *
 * Se comprueban siempre, no sólo cuando la extensión es ambigua: la extensión filtra el `.dmg` de
 * un Windows, pero no el `-win-x64.zip` de un Linux.
 */
const FOREIGN_MARKERS: Record<string, RegExp> = {
  win32: /(-mac-|-osx-|-linux-|\.dmg$|\.appimage$)/,
  darwin: /(-win-|-linux-|setup|\.exe$|\.appimage$)/,
  linux: /(-win-|-mac-|-osx-|setup|\.dmg$|\.exe$)/,
};

function archTokens(arch: string): string[] {
  switch (arch) {
    case 'arm64':
      return ['arm64', 'aarch64'];
    case 'x64':
      return ['x64', 'x86_64', 'amd64'];
    default:
      return [arch];
  }
}

/** Artefacto que corresponde a esta máquina, o `null` si la release no publicó ninguno. */
export function assetFor(release: ReleaseInfo, platform: NodeJS.Platform, arch: string): ReleaseAsset | null {
  const extensions = PLATFORM_EXTENSIONS[platform] ?? ['.zip'];
  const tokens = archTokens(arch);

  const scored = release.assets
    .map((asset) => {
      const name = asset.name.toLowerCase();
      const extensionIndex = extensions.findIndex((extension) => name.endsWith(extension));
      if (extensionIndex === -1) return null;

      // El `.zip` lo publican las tres plataformas y sólo se distinguen por el `-win-` / `-mac-`
      // del nombre: sin esta comprobación, un Linux se bajaría el portable de Windows —que pasa el
      // filtro de extensión— y se quedaría con un artefacto que no sabe abrir.
      if (FOREIGN_MARKERS[platform]?.test(name) === true) return null;

      const matchesArch = tokens.some((token) => name.includes(token));
      const isInstaller = platform === 'win32' && name.includes('setup');

      return {
        asset,
        // Menor es mejor: primero la extensión preferida, luego la arquitectura correcta.
        score: extensionIndex * 10 + (matchesArch ? 0 : 5) + (isInstaller ? -1 : 0),
        matchesArch,
      };
    })
    .filter((entry): entry is { asset: ReleaseAsset; score: number; matchesArch: boolean } => entry !== null);

  if (scored.length === 0) return null;

  // Si alguno declara la arquitectura de esta máquina, ninguno que no la declare vale: bajarse un
  // arm64 en un x64 produce un instalador que no arranca y un informe de error incomprensible.
  const explicit = scored.filter((entry) => entry.matchesArch);
  const pool = explicit.length > 0 ? explicit : scored;

  pool.sort((a, b) => a.score - b.score);
  return pool[0]?.asset ?? null;
}

/**
 * Elige la release a ofrecer, o `null` si ya se está en la última.
 *
 * Los borradores no cuentan (no están publicados) y los prelanzamientos sólo si se piden.
 */
export function selectUpdate(releases: ReleaseInfo[], query: UpdateQuery): UpdateCandidate | null {
  const allowPrerelease = query.allowPrerelease === true;

  for (const release of releases) {
    if (release.draft) continue;
    if (release.prerelease && !allowPrerelease) continue;
    if (!isNewerVersion(release.version, query.currentVersion)) continue;

    return { release, asset: assetFor(release, query.platform, query.arch) };
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Notas de la versión
// ---------------------------------------------------------------------------------------------

/**
 * Convierte el cuerpo Markdown de la release en líneas legibles para la tarjeta.
 *
 * No se renderiza Markdown: el renderer no inyecta marcado (ni con `innerHTML` ni de ninguna otra
 * forma), y el cuerpo de una release es texto de la red. Se limpian los adornos —almohadillas,
 * viñetas, negritas, enlaces— y se queda el texto, que es lo que se quiere leer.
 */
export function releaseNotesLines(body: string, maxLines = 12): string[] {
  const lines: string[] = [];

  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    if (lines.length >= maxLines) break;

    let line = raw.trim();
    if (line === '') continue;
    // Encabezados, citas y viñetas: se les quita la marca y se conserva el texto.
    line = line.replace(/^#{1,6}\s*/, '');
    line = line.replace(/^>\s*/, '');
    line = line.replace(/^[-*+]\s+/, '· ');
    line = line.replace(/^\d+\.\s+/, '· ');
    // Énfasis y código en línea.
    line = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    // Enlaces: se conserva el texto, no la URL.
    line = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    line = line.trim();

    if (line === '' || /^[-=*_]{3,}$/.test(line)) continue;
    lines.push(line);
  }

  return lines;
}

// ---------------------------------------------------------------------------------------------
// Instalación
// ---------------------------------------------------------------------------------------------

export type InstallPlan =
  | { kind: 'silent'; command: string; args: string[]; note: string }
  | { kind: 'open'; path: string; note: string };

/**
 * Cómo se aplica el artefacto descargado.
 *
 * `silent` es lo que espera el usuario que pulsó "Descartar": el IDE se cierra y el instalador se
 * ocupa. `open` es la confesión honesta de que en esa plataforma no se puede: un `.dmg` sin firmar
 * y sin framework de actualización necesita que alguien arrastre la app a Aplicaciones, y fingir
 * que se ha instalado sería peor que decirlo.
 */
export function installPlan(platform: NodeJS.Platform, file: string): InstallPlan {
  const lower = file.toLowerCase();

  if (platform === 'win32' && lower.endsWith('.exe')) {
    // `/S` es el modo silencioso de NSIS, que es el instalador que genera electron-builder.
    //
    // `--force-run` es la otra mitad, y es la que hace que la promesa de la tarjeta —"se vuelve a
    // abrir al terminar"— sea verdad: un instalador NSIS asistido (`oneClick: false`) instalado en
    // silencio **no** relanza la aplicación por su cuenta. Es la misma pareja de banderas que
    // manda `electron-updater` cuando instala una actualización, y NSIS ignora lo que no reconoce.
    return {
      kind: 'silent',
      command: file,
      args: ['/S', '--force-run'],
      note: 'Se instalará en silencio al cerrar el IDE y DotForge se abrirá de nuevo al terminar.',
    };
  }

  if (platform === 'darwin') {
    return {
      kind: 'open',
      path: file,
      note: 'Se abrirá la imagen de disco al cerrar: arrastra DotForge IDE a Aplicaciones.',
    };
  }

  return { kind: 'open', path: file, note: 'Se abrirá el archivo descargado al cerrar el IDE.' };
}

/** Cómo se aplica: `silent` termina solo, `open` necesita que alguien lo remate a mano. */
export type InstallPlanKind = InstallPlan['kind'];

/**
 * Texto del botón que aplica la actualización.
 *
 * "Reiniciar y aplicar" prometía dos cosas que el IDE no hace: que reinicia él —lo que hace es
 * cerrarse y dejar trabajando a un instalador— y que en cualquier plataforma acaba solo. En macOS
 * lo único que ocurre es que se abre una imagen de disco. El botón dice ahora lo que va a pasar.
 */
export function applyActionLabel(kind: InstallPlanKind): string {
  return kind === 'silent' ? 'Cerrar e instalar' : 'Abrir instalador';
}

/** Lo que se le pregunta al usuario antes de cerrarle el IDE. */
export interface ApplyConfirmation {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * Aviso previo al cierre.
 *
 * Cerrar el IDE es lo más intrusivo que hace el actualizador, y hasta ahora ocurría en el mismo
 * gesto de pedirlo: un clic, y la ventana desaparecía. El aviso no es un trámite — dice **cuánto**
 * dura, **quién** termina el trabajo y **si** la aplicación vuelve sola, que son las tres cosas que
 * ya no se pueden comprobar una vez que la ventana no está.
 */
export function applyConfirmation(version: string, kind: InstallPlanKind): ApplyConfirmation {
  if (kind === 'silent') {
    return {
      title: `Cerrar e instalar la v${version}`,
      message: `El IDE se va a cerrar para instalar la versión ${version}.`,
      detail:
        'La instalación tarda unos segundos en segundo plano y DotForge se vuelve a abrir al ' +
        'terminar. Windows puede pedirte permiso antes de empezar: si lo cancelas, el IDE se ' +
        'reabrirá en la versión de ahora y te lo diremos.',
      confirmLabel: applyActionLabel(kind),
      cancelLabel: 'Ahora no',
    };
  }

  return {
    title: `Cerrar y abrir el instalador de la v${version}`,
    message: `El IDE se va a cerrar y se abrirá el instalador de la versión ${version}.`,
    detail:
      'En este sistema la actualización no puede aplicarse sola: tendrás que completar la ' +
      'instalación y volver a abrir DotForge tú.',
    confirmLabel: applyActionLabel(kind),
    cancelLabel: 'Ahora no',
  };
}

// ---------------------------------------------------------------------------------------------
// Cierre de bucle: qué pasó con la instalación que se programó al cerrar
// ---------------------------------------------------------------------------------------------

/**
 * Resultado de la instalación programada en la sesión anterior.
 *
 * `just-updated` es la buena noticia; `install-failed` es la que de verdad justifica todo esto: sin
 * ella, cancelar el aviso de permisos deja al usuario en la versión de siempre, con la tarjeta
 * callada y sin ninguna forma de enterarse de que lo que pulsó no llegó a ocurrir.
 */
export type InstallOutcomeKind = 'just-updated' | 'install-failed';

export interface InstallOutcome {
  kind: InstallOutcomeKind;
  /** Versión de la que se habla: la que se instaló, o la que no llegó a instalarse. */
  version: string;
  /** Cuántas veces se ha lanzado ya el instalador de esa versión. */
  attempts: number;
  /** Notas de la versión, para poder contar qué trae. Vacío si no se guardaron. */
  notes: string[];
  releaseUrl: string | null;
}

/** Lo que el actualizador dejó anotado en el disco, visto por la parte pura. */
export interface PendingRecordView {
  version: string;
  attempts?: number;
  notes?: string[];
  releaseUrl?: string | null;
}

export interface PendingVerdictQuery {
  currentVersion: string;
  /** ¿Sigue estando el archivo descargado? */
  fileExists: boolean;
  /** Cómo se iba a aplicar. Sólo un plan silencioso puede *fallar* sin que nadie lo vea. */
  planKind: InstallPlanKind;
}

export type PendingVerdict =
  /** Se aplicó: la versión que corre ya es la prometida, o una posterior. */
  | { kind: 'applied'; outcome: InstallOutcome }
  /** Se lanzó el instalador y el IDE ha vuelto a abrirse en la versión de antes. */
  | { kind: 'failed'; outcome: InstallOutcome }
  /** Sigue descargada y sin aplicar: se rearma la promesa. */
  | { kind: 'pending' }
  /** No queda nada que hacer con ella: se borra. */
  | { kind: 'stale' };

/**
 * Qué ha pasado con la instalación pendiente, mirando sólo datos.
 *
 * Tres reglas que no son evidentes:
 *
 *  - **"Ya no es más nueva" es la prueba de que se instaló.** No hay a quién preguntárselo: si el
 *    IDE que corre es la versión prometida —o una posterior—, la instalación ocurrió.
 *  - **Un plan `open` no puede declararse fallido.** En macOS, "se abrió la imagen de disco y el
 *    usuario todavía no ha arrastrado nada" es el curso normal, no un fallo; acusar ahí al
 *    instalador sería un aviso falso en cada arranque hasta que alguien complete el arrastre. Sólo
 *    el camino silencioso —que prometía terminar solo— puede incumplir.
 *  - **Las notas viajan con el veredicto sólo si son de la versión que corre.** Si por el camino se
 *    instaló a mano una versión posterior, las notas guardadas son de otra release: contarlas como
 *    novedades de ésta sería mentir con detalle.
 */
export function judgePending(record: PendingRecordView, query: PendingVerdictQuery): PendingVerdict {
  const raw = record.attempts;
  const attempts = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(Math.trunc(raw), 0) : 0;
  const notes = Array.isArray(record.notes) ? record.notes : [];
  const releaseUrl = typeof record.releaseUrl === 'string' ? record.releaseUrl : null;

  if (!isNewerVersion(record.version, query.currentVersion)) {
    const sameRelease = record.version === query.currentVersion;
    return {
      kind: 'applied',
      outcome: {
        kind: 'just-updated',
        version: sameRelease ? record.version : query.currentVersion,
        attempts,
        notes: sameRelease ? notes : [],
        releaseUrl: sameRelease ? releaseUrl : null,
      },
    };
  }

  if (!query.fileExists) return { kind: 'stale' };

  if (query.planKind === 'silent' && attempts > 0) {
    return {
      kind: 'failed',
      outcome: { kind: 'install-failed', version: record.version, attempts, notes, releaseUrl },
    };
  }

  return { kind: 'pending' };
}

/** Titular del aviso de cierre de bucle. Vive aquí para que la prueba fije el formato exacto. */
export function outcomeHeadline(outcome: InstallOutcome): string {
  return outcome.kind === 'just-updated'
    ? `✅ ¡Actualizado con éxito a la v${outcome.version}!`
    : `⚠️ La actualización a la v${outcome.version} no se completó`;
}

/**
 * El aviso, en palabras.
 *
 * El caso que falla dice **qué se hizo**, **dónde ha quedado el usuario** y **qué puede hacer
 * ahora**. Y nombra las dos causas posibles —el aviso de permisos cancelado y el instalador que no
 * termina— en vez de elegir una: el instalador se lanza desprendido justo antes de que el proceso
 * desaparezca, así que nadie llega a leer su código de salida. Elegir sería adivinar en voz alta.
 */
export function outcomeMessage(outcome: InstallOutcome, currentVersion: string): string {
  if (outcome.kind === 'just-updated') {
    return outcome.notes.length > 0
      ? `Ya estás en la v${outcome.version}. Esto es lo que trae:`
      : `Ya estás en la v${outcome.version}.`;
  }

  const tries = outcome.attempts > 1 ? ` Van ${outcome.attempts} intentos.` : '';

  return (
    `Se lanzó el instalador al cerrar y el IDE ha vuelto a abrirse en la v${currentVersion}: o se ` +
    `canceló el aviso de permisos de Windows, o la instalación no llegó a terminar.${tries} La ` +
    'descarga sigue guardada, así que reintentarlo no vuelve a bajar nada.'
  );
}

// ---------------------------------------------------------------------------------------------
// Estado que ve el renderer
// ---------------------------------------------------------------------------------------------

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  /** Versión ofrecida. Null salvo en `available`, `downloading` y `ready`. */
  version: string | null;
  notes: string[];
  /** Tamaño del artefacto en bytes, 0 si el feed no lo declara. */
  size: number;
  /** Progreso de descarga entre 0 y 1, o null si no se puede saber. */
  progress: number | null;
  /** Archivo ya descargado y listo para aplicarse. */
  downloadedPath: string | null;
  /** El usuario ha descartado la tarjeta: se instalará al cerrar, sin volver a molestar. */
  applyOnQuit: boolean;
  /** La tarjeta ya no se enseña. Lo decide el usuario, no el estado de la descarga. */
  dismissed: boolean;
  /** Qué se hará exactamente al aplicar, en palabras. */
  plan: string | null;
  /**
   * Y cómo, como dato.
   *
   * El renderer necesita saberlo para escribir el botón y el aviso previo, y la alternativa —mirar
   * el texto de `plan`— sería decidir el comportamiento comparando una frase traducible.
   */
  planKind: InstallPlanKind | null;
  /**
   * Cierre de bucle: qué pasó con la instalación que se programó en la sesión anterior.
   *
   * Va aparte del `status` a propósito. La comprobación automática de los cinco segundos publica
   * `up-to-date` justo después de arrancar, y con esto dentro del estado el "✅ ¡Actualizado!" se
   * habría borrado solo antes de que a nadie le diera tiempo a leerlo. Vive hasta que el usuario
   * lo cierra (`acknowledgeOutcome`), no hasta el siguiente cambio de estado.
   */
  outcome: InstallOutcome | null;
  message: string | null;
  releaseUrl: string | null;
  checkedAtUtc: string | null;
}

export function emptyUpdateState(currentVersion: string): UpdateState {
  return {
    status: 'idle',
    currentVersion,
    version: null,
    notes: [],
    size: 0,
    progress: null,
    downloadedPath: null,
    applyOnQuit: false,
    dismissed: false,
    plan: null,
    planKind: null,
    outcome: null,
    message: null,
    releaseUrl: null,
    checkedAtUtc: null,
  };
}

/** Título de la tarjeta. Vive aquí para que la prueba pueda fijar el formato exacto. */
export function updateHeadline(version: string): string {
  return `🚀 Nueva versión disponible (v${version})`;
}
