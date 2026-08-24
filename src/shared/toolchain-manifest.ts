/**
 * Manifiesto de una instalación del toolchain.
 *
 * Hasta la v1.9 lo único que se guardaba tras extraer un paquete era un marcador `.dotforge-ok`
 * con la versión y el SHA-256 **del `.nupkg` descargado**. Eso comprueba la descarga y no comprueba
 * nada más: verifica el archivo que ya no está en el disco y no dice ni una palabra de los 462 que
 * sí están.
 *
 * Y ahí se escondía el fallo que dejó el IntelliSense de C# muerto durante nueve versiones. De los
 * 462 archivos del servidor de Roslyn, **uno** quedó truncado en disco a 5 MiB exactos —el
 * `.nupkg` era correcto, su SHA-256 coincide con el del feed y el extractor lo descomprime bien
 * cuando se le vuelve a pedir—. Como el marcador decía "ok", nadie volvió a mirar aquel directorio
 * jamás, y el servidor arrancaba cada día para morir componiendo su gráfico MEF sobre un ensamblado
 * mutilado.
 *
 * El manifiesto guarda **tamaño y hash de cada archivo extraído**, y con eso hay dos comprobaciones
 * con costes muy distintos:
 *
 *  - **superficial** (`size`): un `stat` por archivo, milisegundos. Se hace en cada arranque, y es
 *    la que habría cazado este fallo el primer día.
 *  - **profunda** (`sha256`): releer y hashear los ~250 MB. Se hace **sólo** cuando el servidor ya
 *    ha fallado, para poder distinguir dos cosas que se parecen mucho y se arreglan al revés: una
 *    instalación corrupta (se repara volviendo a extraer) de una compilación mala del paquete (se
 *    pone la versión en cuarentena).
 */

/** Nombre del archivo dentro del directorio de la instalación. */
export const MANIFEST_FILE = '.dotforge-install.json';

export interface ManifestFile {
  /** Ruta relativa al directorio de instalación, siempre con `/`. */
  path: string;
  size: number;
  sha256: string;
}

export interface InstallManifest {
  version: 1;
  /** `roslyn`, `omnisharp`, `netcoredbg`… */
  kind: string;
  /** Versión del paquete instalado. */
  packageVersion: string;
  rid: string;
  /** SHA-256 del archivo descargado, que es lo único que comprobaba el marcador antiguo. */
  sourceSha256: string;
  installedAtUtc: string;
  files: ManifestFile[];
}

export interface ManifestInput {
  kind: string;
  packageVersion: string;
  rid: string;
  sourceSha256: string;
  installedAtUtc: string;
  files: readonly ManifestFile[];
}

export function buildManifest(input: ManifestInput): InstallManifest {
  return {
    version: 1,
    kind: input.kind,
    packageVersion: input.packageVersion,
    rid: input.rid,
    sourceSha256: input.sourceSha256,
    installedAtUtc: input.installedAtUtc,
    files: [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

export function serializeManifest(manifest: InstallManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

function isManifestFile(value: unknown): value is ManifestFile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['path'] === 'string' &&
    record['path'] !== '' &&
    typeof record['size'] === 'number' &&
    Number.isFinite(record['size']) &&
    typeof record['sha256'] === 'string'
  );
}

/**
 * Lee un manifiesto.
 *
 * Devuelve `null` ante cualquier duda —archivo ilegible, versión desconocida, sin archivos—, y
 * `null` significa "esta instalación no está verificada", que se trata igual que "no está": se
 * vuelve a extraer. Es lo que convierte la caché rota de un usuario de la v1.9 en una caché sana
 * la primera vez que abre la v2.0, sin que tenga que borrar nada a mano.
 */
export function parseManifest(text: string): InstallManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (record['version'] !== 1) return null;
  const files = record['files'];
  if (!Array.isArray(files) || files.length === 0) return null;
  if (!files.every(isManifestFile)) return null;

  const text_ = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');
  if (text_('packageVersion') === '') return null;

  return {
    version: 1,
    kind: text_('kind'),
    packageVersion: text_('packageVersion'),
    rid: text_('rid'),
    sourceSha256: text_('sourceSha256'),
    installedAtUtc: text_('installedAtUtc'),
    files: files as ManifestFile[],
  };
}

export type ProblemKind = 'missing' | 'size' | 'hash';

export interface InstallProblem {
  path: string;
  kind: ProblemKind;
  expected: string;
  actual: string;
}

/** Lo que se ha encontrado de verdad en el disco para un archivo del manifiesto. */
export interface ObservedFile {
  size: number;
  /** Sólo en la comprobación profunda; `null` en la superficial. */
  sha256?: string | null;
}

/**
 * Compara el manifiesto con lo observado en el disco.
 *
 * Un archivo que no aparece en `observed` cuenta como ausente. Los archivos **de más** no son un
 * problema: el servidor escribe sus propios registros y cachés de composición dentro de su
 * directorio, y borrar la instalación por eso sería reinstalar 60 MB cada arranque.
 */
export function diffInstall(
  manifest: InstallManifest,
  observed: ReadonlyMap<string, ObservedFile | null>,
): InstallProblem[] {
  const problems: InstallProblem[] = [];

  for (const file of manifest.files) {
    const actual = observed.get(file.path) ?? null;

    if (actual === null) {
      problems.push({ path: file.path, kind: 'missing', expected: String(file.size), actual: '(no está)' });
      continue;
    }

    if (actual.size !== file.size) {
      problems.push({ path: file.path, kind: 'size', expected: String(file.size), actual: String(actual.size) });
      continue;
    }

    if (typeof actual.sha256 === 'string' && actual.sha256 !== file.sha256) {
      problems.push({ path: file.path, kind: 'hash', expected: file.sha256, actual: actual.sha256 });
    }
  }

  return problems;
}

/** Resumen legible de los problemas, con el primero por extenso. Para el registro y la barra de estado. */
export function describeProblems(problems: readonly InstallProblem[]): string {
  if (problems.length === 0) return 'instalación íntegra';

  const first = problems[0]!;
  const what =
    first.kind === 'missing'
      ? `falta "${first.path}"`
      : first.kind === 'size'
        ? `"${first.path}" mide ${first.actual} bytes y debería medir ${first.expected}`
        : `"${first.path}" no coincide con su hash`;

  return problems.length === 1 ? what : `${what} (y ${problems.length - 1} archivo(s) más)`;
}
