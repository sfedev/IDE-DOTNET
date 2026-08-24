/**
 * Instalaciones verificables del toolchain.
 *
 * Extraer un ZIP y dejar un marcador de "listo" no es instalar: es esperar que nada haya salido
 * mal y no volver a mirar. Este servicio hace las tres operaciones que faltaban —anotar lo que se
 * escribió, comprobar que sigue ahí y reparar lo que no— sobre el modelo puro de
 * `src/shared/toolchain-manifest.ts`.
 *
 * No importa `electron`: sólo `node:fs`, para que las pruebas puedan instalar un ZIP de mentira en
 * un directorio temporal, corromper un archivo a mano y comprobar que la verificación lo caza.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildManifest,
  diffInstall,
  MANIFEST_FILE,
  parseManifest,
  serializeManifest,
  type InstallManifest,
  type InstallProblem,
  type ManifestFile,
  type ObservedFile,
} from '../../shared/toolchain-manifest.js';
import { extractTo, sha256, type ZipEntry } from './zip.js';

export interface InstallOptions {
  kind: string;
  packageVersion: string;
  rid: string;
  /** Qué entradas del ZIP interesan. */
  filter?: (entry: ZipEntry) => boolean;
  /** Segmentos iniciales de ruta a descartar. */
  strip?: number;
  /** Se inyecta para que las pruebas no dependan del reloj. */
  now?: () => Date;
}

export interface InstallResult {
  directory: string;
  manifest: InstallManifest;
  files: number;
}

/**
 * Extrae el archivo al directorio y deja el manifiesto.
 *
 * El manifiesto se escribe **el último**, a propósito: si el IDE se cierra a mitad de la
 * extracción, lo que queda es un directorio sin manifiesto, y un directorio sin manifiesto se
 * vuelve a instalar entero. Un marcador escrito antes de tiempo es una mentira permanente.
 */
export async function installArchive(
  archive: Buffer,
  directory: string,
  options: InstallOptions,
): Promise<InstallResult> {
  const files: ManifestFile[] = [];

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  const written = await extractTo(archive, directory, {
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.strip !== undefined ? { strip: options.strip } : {}),
    onFile: (relativePath, contents) => {
      files.push({ path: relativePath, size: contents.length, sha256: sha256(contents) });
    },
  });

  const now = options.now ?? (() => new Date());
  const manifest = buildManifest({
    kind: options.kind,
    packageVersion: options.packageVersion,
    rid: options.rid,
    sourceSha256: sha256(archive),
    installedAtUtc: now().toISOString(),
    files,
  });

  await writeFile(join(directory, MANIFEST_FILE), serializeManifest(manifest), 'utf8');

  return { directory, manifest, files: written };
}

/** Lee el manifiesto de una instalación, o `null` si no hay o no se entiende. */
export async function readInstallManifest(directory: string): Promise<InstallManifest | null> {
  const path = join(directory, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  try {
    return parseManifest(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export interface VerifyResult {
  /** `false` cuando no hay manifiesto: la instalación no es que esté mal, es que no consta. */
  verified: boolean;
  problems: InstallProblem[];
  manifest: InstallManifest | null;
}

/**
 * Comprueba que la instalación sigue siendo la que se anotó.
 *
 * Con `deep: false` (lo normal, en cada arranque) mira sólo el tamaño: es un `stat` por archivo y
 * cuesta milisegundos. Es la comprobación que habría cazado el DLL truncado a 5 MiB que dejó el
 * IntelliSense de C# muerto desde la v1.1.
 *
 * Con `deep: true` relee y hashea todo. Sólo se pide cuando el servidor **ya** ha fallado, porque
 * es lo único que distingue "esta copia está corrupta" (se repara) de "esta compilación del
 * paquete está mal" (se pone en cuarentena), y esas dos se arreglan al revés.
 */
export async function verifyInstall(directory: string, options: { deep?: boolean } = {}): Promise<VerifyResult> {
  const manifest = await readInstallManifest(directory);
  if (manifest === null) return { verified: false, problems: [], manifest: null };

  const observed = new Map<string, ObservedFile | null>();

  for (const file of manifest.files) {
    const target = join(directory, ...file.path.split('/'));
    try {
      const info = await stat(target);
      if (!info.isFile()) {
        observed.set(file.path, null);
        continue;
      }

      if (options.deep === true && info.size === file.size) {
        const contents = await readFile(target);
        observed.set(file.path, { size: info.size, sha256: createHash('sha256').update(contents).digest('hex') });
      } else {
        observed.set(file.path, { size: info.size, sha256: null });
      }
    } catch {
      observed.set(file.path, null);
    }
  }

  return { verified: true, problems: diffInstall(manifest, observed), manifest };
}

/** Borra la instalación para que la próxima adquisición la vuelva a bajar entera. */
export async function removeInstall(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
