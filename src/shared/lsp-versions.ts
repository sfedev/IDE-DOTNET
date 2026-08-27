/**
 * Elección de la versión del servidor de lenguaje de Roslyn.
 *
 * El feed `vs-impl` publica **763 versiones** de `Microsoft.CodeAnalysis.LanguageServer` y
 * **ninguna de ellas es estable en el sentido de SemVer**: todas llevan sufijo de prelanzamiento,
 * porque son las compilaciones internas con las que Visual Studio y la extensión de C# de VS Code
 * se sirven. Conviven bandas ya publicadas (`4.14.0-3.*`), bandas de la rama principal que todavía
 * no ha salido (`5.4.0-2.*`) y hasta compilaciones de prueba declaradas (`5.3.0-2-test.*`).
 *
 * Coger "la más alta" —que es lo que se hacía— significa coger cada día la compilación de anoche de
 * la rama principal de Roslyn, sin nadie que la haya ejecutado nunca contra este IDE. Eso no es una
 * política de versiones: es una lotería diaria.
 *
 * La política que se aplica aquí, en orden:
 *
 *  1. **La versión fijada**, si el feed todavía la lista y no está en cuarentena. Es una versión
 *     concreta que se ha descargado, extraído y arrancado a mano en la máquina de desarrollo.
 *  2. Si desapareció del feed, la más alta que **no** declare marcadores de inestabilidad
 *     (`test`, `preview`, `alpha`, `beta`, `rc`…) y no esté en cuarentena.
 *  3. Si no queda ninguna, la más alta que no esté en cuarentena, para no quedarse sin servidor.
 *
 * Todo esto es puro y se prueba con el índice real del feed capturado en las pruebas.
 */

/** Versión descompuesta en lo que hace falta para ordenarla y para juzgar su estabilidad. */
export interface RoslynVersion {
  raw: string;
  /** `5.4.0` -> `[5, 4, 0]`. */
  release: number[];
  /** Todo lo que va detrás del primer guion, o `null` si no hay sufijo. */
  prerelease: string | null;
  /** Trozos numéricos del sufijo, en orden: `2.26179.14` -> `[2, 26179, 14]`. */
  prereleaseNumbers: number[];
  /** Trozos **no** numéricos del sufijo, en minúsculas: `2-test.25610.8` -> `['test']`. */
  markers: string[];
}

/**
 * Marcadores que descalifican una compilación.
 *
 * Se buscan como trozo completo del sufijo, no como subcadena: `-3.26423.7` no contiene ninguno,
 * y buscar `rc` por dentro casaría con cualquier cosa que llevara esas dos letras seguidas.
 */
export const UNSTABLE_MARKERS: readonly string[] = [
  'alpha',
  'beta',
  'preview',
  'pre',
  'rc',
  'test',
  'ci',
  'nightly',
  'dev',
  'experimental',
];

/**
 * Versiones verificadas a mano, en orden de preferencia.
 *
 * "Verificada" quiere decir exactamente esto: se ha descargado el `.nupkg` de esa versión, se ha
 * extraído y se ha lanzado el ejecutable, y ha compuesto su gráfico MEF y contestado por stdio sin
 * un solo `fail:`. No es la opinión de nadie sobre qué número parece más redondo.
 *
 * `4.14.0-3.26423.7` está en una banda ya publicada, existe para los seis RID que soporta DotForge
 * y —lo que decide el empate— su `runtimeconfig.json` declara `net9.0` con `rollForward: Major`,
 * así que arranca con el runtime 9 **o** con el 10. Las bandas 5.x declaran `net10.0` y dejan sin
 * servidor a quien tenga instalado justo el .NET 9 que este IDE pide como mínimo.
 */
export const ROSLYN_VERIFIED_VERSIONS: readonly string[] = ['4.14.0-3.26423.7'];

/** La versión que se usa mientras el feed la siga publicando. */
export const ROSLYN_PINNED_VERSION: string = ROSLYN_VERIFIED_VERSIONS[0]!;

/**
 * Por qué se eligió lo que se eligió. Se enseña en la barra de estado y se comprueba en las pruebas.
 *
 * `quarantined` existe porque el mensaje mentía. Cuando la fijada estaba vetada **en este equipo**,
 * la selección caía a `stable` y la barra de estado decía "la fijada ya no está en el feed", que es
 * falso y manda a buscar el problema al sitio equivocado: al feed de Azure en vez de a un archivo
 * de `userData`. Costó una sesión entera de diagnóstico averiguarlo, y la conclusión general es que
 * un estado degradado tiene que decir **cuál** de sus causas se ha dado, no la más probable.
 */
export type RoslynSelectionReason = 'pinned' | 'verified' | 'stable' | 'fallback' | 'quarantined';

export interface RoslynSelection {
  version: string;
  reason: RoslynSelectionReason;
}

const NUMERIC = /^[0-9]+$/;

/** Descompone una versión del feed. Nunca lanza: una cadena rara sale con release `[0]` y se ordena al fondo. */
export function parseRoslynVersion(raw: string): RoslynVersion {
  const trimmed = raw.trim();
  const dash = trimmed.indexOf('-');
  const releaseText = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const prerelease = dash === -1 ? null : trimmed.slice(dash + 1);

  const release = releaseText
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0));

  const parts = prerelease === null ? [] : prerelease.split(/[.\-+]/).filter((part) => part !== '');

  return {
    raw: trimmed,
    release: release.length > 0 ? release : [0],
    prerelease,
    prereleaseNumbers: parts.filter((part) => NUMERIC.test(part)).map((part) => Number.parseInt(part, 10)),
    markers: parts.filter((part) => !NUMERIC.test(part)).map((part) => part.toLowerCase()),
  };
}

/** ¿Declara la versión que es una compilación de prueba o de vista previa? */
export function isUnstableVersion(raw: string): boolean {
  return parseRoslynVersion(raw).markers.some((marker) => UNSTABLE_MARKERS.includes(marker));
}

function compareNumbers(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Orden entre dos versiones: negativo si `a` es anterior, positivo si es posterior.
 *
 * Primero la parte de release, que es la banda (`4.14.0` < `5.4.0`), y sólo en caso de empate el
 * sufijo. Una versión **sin** sufijo gana a una que lo tenga, como manda SemVer, aunque en este
 * feed no haya ninguna todavía: el día que Microsoft publique una `5.0.0` limpia debe ganar a
 * `5.0.0-2.26423.4` sin tener que tocar nada aquí.
 */
export function compareRoslynVersions(a: string, b: string): number {
  const left = parseRoslynVersion(a);
  const right = parseRoslynVersion(b);

  const byRelease = compareNumbers(left.release, right.release);
  if (byRelease !== 0) return byRelease;

  if (left.prerelease === null && right.prerelease !== null) return 1;
  if (left.prerelease !== null && right.prerelease === null) return -1;

  const byPrerelease = compareNumbers(left.prereleaseNumbers, right.prereleaseNumbers);
  if (byPrerelease !== 0) return byPrerelease;

  return left.raw === right.raw ? 0 : left.raw < right.raw ? -1 : 1;
}

/**
 * La versión más alta de una lista.
 *
 * No se puede asumir el orden del feed: lo devuelve descendente, así que coger la última daba la
 * más antigua. Se conserva como utilidad porque el depurador y el resto del toolchain la usan.
 */
export function pickLatestVersion(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const candidate of versions) {
    if (best === null || compareRoslynVersions(candidate, best) > 0) best = candidate;
  }
  return best;
}

export interface SelectOptions {
  /** Versiones que ya se probaron en esta máquina y no arrancaron. Ver `lsp-health.ts`. */
  blocked?: readonly string[];
  /** Lista de preferidas, por si una prueba quiere fijar otra. */
  verified?: readonly string[];
}

/**
 * Aplica la política de versiones sobre lo que publica el feed.
 *
 * Devuelve también **por qué**, porque un usuario que ve "Roslyn 5.4.0-2.26179.14" merece saber si
 * está usando la versión que DotForge fijó o una que se eligió sola porque la fijada ya no existe.
 */
export function selectRoslynVersion(
  available: readonly string[],
  options: SelectOptions = {},
): RoslynSelection | null {
  const blocked = new Set(options.blocked ?? []);
  const verified = options.verified ?? ROSLYN_VERIFIED_VERSIONS;

  const published = new Set(available.map((version) => version.trim()).filter((version) => version !== ''));
  const usable = [...published].filter((version) => !blocked.has(version));

  if (usable.length === 0) return null;

  const offered = new Set(usable);
  for (const [index, candidate] of verified.entries()) {
    if (offered.has(candidate)) {
      return { version: candidate, reason: index === 0 ? 'pinned' : 'verified' };
    }
  }

  const stable = usable.filter((version) => !isUnstableVersion(version));
  const best = pickLatestVersion(stable.length > 0 ? stable : usable);
  if (best === null) return null;

  // Las dos causas se parecen desde fuera —no se está usando la fijada— y son opuestas por dentro:
  // una está en el feed y la otra no. Decir la equivocada manda a mirar donde no es.
  const pinnedIsQuarantined = verified.some((candidate) => published.has(candidate) && blocked.has(candidate));
  if (pinnedIsQuarantined) return { version: best, reason: 'quarantined' };

  return { version: best, reason: stable.length > 0 ? 'stable' : 'fallback' };
}

/** Frase corta para la barra de estado y el registro. */
export function describeSelection(selection: RoslynSelection): string {
  switch (selection.reason) {
    case 'pinned':
      return `${selection.version} (versión fijada por DotForge)`;
    case 'verified':
      return `${selection.version} (versión verificada de reserva)`;
    case 'stable':
      return `${selection.version} (la fijada ya no está en el feed; la más reciente sin marcar como prueba)`;
    case 'quarantined':
      return `${selection.version} (la versión fijada falló en este equipo y está descartada; se reintentará al actualizar DotForge)`;
    case 'fallback':
      return `${selection.version} (no queda ninguna versión estable disponible)`;
  }
}
