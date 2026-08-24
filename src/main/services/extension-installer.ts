/**
 * Instalación de extensiones `.vsix` en `userData/extensions/`.
 *
 * Un `.vsix` es un ZIP, así que se reutiliza el lector propio (`zip.ts`) y —lo importante— el
 * **instalador verificable** del toolchain: cada extensión queda con su manifiesto de instalación,
 * con el tamaño y el hash de cada archivo escrito (ADR-041). No se inventa aquí un marcador de
 * "instalada"; ese error ya costó nueve versiones de IntelliSense roto.
 *
 * Lo que **no** hace, y se dice en la interfaz en vez de dejar que se descubra: DotForge no es
 * VS Code y no ejecuta el punto de entrada de una extensión. Lo que aprovecha es lo declarativo
 * —temas, fragmentos, gramáticas, definiciones de lenguaje—, y `describeContributions` reparte
 * cada `contributes` entre lo que sirve aquí y lo que no.
 *
 * Como el resto de servicios probables, no importa `electron`: la ruta de `userData` se inyecta.
 */
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import { isTrustedDownload } from '../../shared/open-vsx.js';
import {
  EXTENSION_MANIFEST,
  extensionFolderName,
  installedFrom,
  isExtensionEntry,
  manifestId,
  parseVsixManifest,
  sortInstalled,
  VSIX_MANIFEST,
  VsixError,
  type InstalledExtension,
  type VsixManifest,
} from '../../shared/vsix.js';
import { installArchive, readInstallManifest, verifyInstall } from './toolchain-install.js';
import { listEntries, readEntry } from './zip.js';

/** Tope de tamaño de un `.vsix`. El paquete entero se maneja en memoria, como el del toolchain. */
const MAX_VSIX_BYTES = 220 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

let extensionsRoot: string | null = null;

export function initialize(userDataPath: string): void {
  extensionsRoot = join(userDataPath, 'extensions');
}

export function extensionsDirectory(): string {
  if (extensionsRoot === null) throw new Error('el gestor de extensiones no está inicializado');
  return extensionsRoot;
}

/**
 * Ruta de instalación de una carpeta, comprobada contra la raíz de extensiones.
 *
 * El nombre de carpeta sale de `publisher` y `name` del manifiesto, que son texto de un archivo
 * descargado. `parseVsixManifest` ya rechaza lo que no sea un identificador, y esto es el segundo
 * cierre: dos comprobaciones baratas frente a escribir en cualquier sitio del disco.
 */
function insideExtensions(folder: string): string {
  const root = resolve(extensionsDirectory());
  const target = resolve(root, folder);

  if (target !== root && !target.startsWith(root + sep)) {
    throw new VsixError(`la carpeta de la extensión se sale del directorio de extensiones: ${folder}`);
  }

  return target;
}

// ---------------------------------------------------------------------------------------------
// Lectura de lo instalado
// ---------------------------------------------------------------------------------------------

async function readInstalled(directory: string): Promise<InstalledExtension | null> {
  try {
    // Sin `existsSync`: la ausencia del archivo la resuelve el propio `readFile`, por el mismo
    // camino que un `package.json` ilegible, y sin una llamada síncrona de disco en el hilo
    // principal por cada carpeta de extensión.
    const manifest = parseVsixManifest(await readFile(join(directory, EXTENSION_MANIFEST), 'utf8'));
    const install = await readInstallManifest(directory);
    return installedFrom(manifest, directory, install?.installedAtUtc ?? null);
  } catch {
    // Una carpeta con un `package.json` que no es de una extensión no es un error del usuario:
    // simplemente no se lista.
    return null;
  }
}

/** Extensiones instaladas, ordenadas por nombre visible. */
export async function listInstalled(): Promise<InstalledExtension[]> {
  const root = extensionsDirectory();

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // Todavía no se ha instalado ninguna: la carpeta no existe y eso no es un error.
    return [];
  }

  const found: InstalledExtension[] = [];

  for (const entry of entries) {
    const directory = join(root, entry);
    try {
      if (!(await stat(directory)).isDirectory()) continue;
    } catch {
      continue;
    }

    const installed = await readInstalled(directory);
    if (installed !== null) found.push(installed);
  }

  return sortInstalled(found);
}

export async function findInstalled(id: string): Promise<InstalledExtension | null> {
  const all = await listInstalled();
  return all.find((extension) => extension.id.toLowerCase() === id.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Instalación
// ---------------------------------------------------------------------------------------------

/** Lee el manifiesto que va dentro del `.vsix` sin extraer nada al disco. */
export function readVsixManifest(archive: Buffer): VsixManifest {
  const entry = listEntries(archive).find((candidate) => candidate.name === VSIX_MANIFEST);
  if (!entry) throw new VsixError(`el paquete no contiene ${VSIX_MANIFEST}: no parece un .vsix`);

  return parseVsixManifest(readEntry(archive, entry).toString('utf8'));
}

export interface InstallOutcome {
  extension: InstalledExtension;
  /** Versión que había instalada y se ha reemplazado, si la había. */
  replaced: string | null;
  files: number;
}

/**
 * Instala un `.vsix` ya descargado.
 *
 * Sólo se escribe el subárbol `extension/`, sin su primer nivel: los dos archivos de OPC del
 * paquete (`[Content_Types].xml`, `extension.vsixmanifest`) son envoltorio del canal de
 * distribución y no le sirven a nadie una vez en el disco.
 */
export async function installFromBuffer(archive: Buffer): Promise<InstallOutcome> {
  if (archive.length > MAX_VSIX_BYTES) {
    throw new VsixError(`el paquete pesa ${Math.round(archive.length / 1048576)} MB: demasiado para instalarse`);
  }

  const manifest = readVsixManifest(archive);
  const id = manifestId(manifest);
  const directory = insideExtensions(extensionFolderName(manifest));

  // Otra versión de la misma extensión: se quita después de instalar la nueva, no antes. Si la
  // instalación falla a mitad, el usuario se queda con la que ya tenía funcionando.
  const previous = await findInstalled(id);

  await mkdir(extensionsDirectory(), { recursive: true });

  const result = await installArchive(archive, directory, {
    kind: `extension:${id}`,
    packageVersion: manifest.version,
    rid: 'any',
    strip: 1,
    filter: (entry) => isExtensionEntry(entry.name),
  });

  const verification = await verifyInstall(directory);
  if (verification.problems.length > 0) {
    await rm(directory, { recursive: true, force: true });
    throw new VsixError(
      `la extensión ${id} se ha extraído incompleta (${verification.problems.length} archivo(s) con problemas)`,
    );
  }

  if (previous !== null && resolve(previous.directory) !== resolve(directory)) {
    await rm(previous.directory, { recursive: true, force: true });
  }

  const installed = await readInstalled(directory);
  if (installed === null) throw new VsixError(`la extensión ${id} se ha instalado sin manifiesto legible`);

  return { extension: installed, replaced: previous?.version ?? null, files: result.files };
}

/**
 * Descarga un `.vsix` y lo instala.
 *
 * La URL llega dentro de la respuesta del registro, es decir, es texto de la red que acaba siendo
 * el origen de algo que se escribe en el disco del usuario: se comprueba el host contra la lista
 * de confianza antes de pedir nada.
 */
export async function installFromUrl(url: string): Promise<InstallOutcome> {
  if (!isTrustedDownload(url)) {
    throw new VsixError(`la descarga no viene de Open VSX y no se acepta: ${url}`);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'DotForge-IDE/2.1' },
  });

  if (!response.ok) {
    throw new Error(`la descarga de la extensión respondió ${response.status} ${response.statusText}`);
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_VSIX_BYTES) {
    throw new VsixError(`el paquete anuncia ${Math.round(declared / 1048576)} MB: demasiado para instalarse`);
  }

  const archive = Buffer.from(await response.arrayBuffer());

  // Misma regla que en el toolchain: un archivo cortado se detecta ahora, no dentro del extractor.
  if (declared > 0 && archive.length !== declared) {
    throw new Error(`descarga incompleta de la extensión: ${archive.length} de ${declared} bytes`);
  }

  return installFromBuffer(archive);
}

/** Desinstala por identificador. Devuelve `false` si no había nada que desinstalar. */
export async function uninstall(id: string): Promise<boolean> {
  const installed = await findInstalled(id);
  if (installed === null) return false;

  // La carpeta viene de `listInstalled`, pero se vuelve a comprobar: es un `rm -r`.
  const target = insideExtensions(basename(installed.directory));
  await rm(target, { recursive: true, force: true });
  return true;
}
