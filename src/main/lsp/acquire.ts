/**
 * Adquisición del servidor de lenguaje C#.
 *
 * Preferencia: `Microsoft.CodeAnalysis.LanguageServer` (Roslyn, MIT), que es el mismo servidor
 * que usa la extensión open source de C# para VS Code. Respaldo: OmniSharp-Roslyn (MIT).
 *
 * Nada de esto se vendorea en el instalador: pesa cientos de megas y depende del RID. Se descarga
 * la primera vez a `userData/toolchain/` y queda cacheado, con un `.dotforge-ok` que marca que la
 * extracción terminó (si el usuario cierra el IDE a mitad, la próxima vez se vuelve a descargar
 * en vez de arrancar un servidor incompleto).
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extractTo, sha256 } from '../services/zip.js';

/** Feed público donde Microsoft publica el servidor de Roslyn. No requiere autenticación. */
const ROSLYN_FEED = 'https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3';
const OMNISHARP_RELEASES = 'https://api.github.com/repos/OmniSharp/omnisharp-roslyn/releases/latest';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MARKER = '.dotforge-ok';

export type ServerKind = 'roslyn' | 'omnisharp';

export interface AcquiredServer {
  kind: ServerKind;
  displayName: string;
  version: string;
  /** Ejecutable o dll a lanzar. */
  entryPoint: string;
  /** Argumentos previos al entryPoint (p. ej. `dotnet <dll>`). */
  command: string;
  args: string[];
  directory: string;
}

export interface AcquireProgress {
  (phase: 'resolving' | 'downloading' | 'extracting' | 'done', ratio: number | null, detail: string): void;
}

/** Identificador de runtime de .NET para la plataforma actual. */
export function currentRid(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  switch (process.platform) {
    case 'win32':
      return `win-${arch}`;
    case 'darwin':
      return `osx-${arch}`;
    default:
      return `linux-${arch}`;
  }
}

async function download(url: string, onProgress: AcquireProgress, label: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'DotForge-IDE/1.0', Accept: 'application/octet-stream' },
  });

  if (!response.ok) {
    throw new Error(`descarga fallida (${response.status} ${response.statusText}): ${url}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  const chunks: Uint8Array[] = [];
  let received = 0;

  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress('downloading', total > 0 ? received / total : null, `${label} ${(received / 1048576).toFixed(1)} MB`);
    }
  }

  return Buffer.concat(chunks);
}

function markerPath(directory: string): string {
  return join(directory, MARKER);
}

async function isComplete(directory: string): Promise<string | null> {
  const marker = markerPath(directory);
  if (!existsSync(marker)) return null;
  try {
    return (await readFile(marker, 'utf8')).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Roslyn LanguageServer
// ---------------------------------------------------------------------------------------------

async function latestRoslynVersion(rid: string): Promise<string> {
  const packageId = `microsoft.codeanalysis.languageserver.${rid}`;
  const response = await fetch(`${ROSLYN_FEED}/flat2/${packageId}/index.json`, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'DotForge-IDE/1.0' },
  });

  if (!response.ok) {
    throw new Error(`no hay servidor de Roslyn publicado para ${rid} (${response.status})`);
  }

  const { versions } = (await response.json()) as { versions: string[] };
  const latest = pickLatestVersion(versions);
  if (!latest) throw new Error(`el feed no lista versiones para ${packageId}`);
  return latest;
}

/**
 * Elige la versión más alta de una lista.
 *
 * No se puede asumir el orden del feed: este devuelve las versiones en orden descendente, así que
 * coger la última daba la más antigua. Se comparan los segmentos numéricos uno a uno
 * (`5.4.0-2.26179.14` gana a `4.8.0-7.25324.2` por el primer segmento).
 */
export function pickLatestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;

  const segmentsOf = (version: string): number[] =>
    version
      .split(/[^0-9]+/)
      .filter((part) => part !== '')
      .map((part) => Number.parseInt(part, 10));

  let best = versions[0]!;
  let bestSegments = segmentsOf(best);

  for (const candidate of versions.slice(1)) {
    const candidateSegments = segmentsOf(candidate);
    const length = Math.max(bestSegments.length, candidateSegments.length);

    for (let i = 0; i < length; i++) {
      const a = candidateSegments[i] ?? 0;
      const b = bestSegments[i] ?? 0;
      if (a === b) continue;
      if (a > b) {
        best = candidate;
        bestSegments = candidateSegments;
      }
      break;
    }
  }

  return best;
}

async function acquireRoslyn(toolchainDir: string, onProgress: AcquireProgress): Promise<AcquiredServer> {
  const rid = currentRid();

  onProgress('resolving', null, 'resolviendo la última versión del servidor de Roslyn');
  const version = await latestRoslynVersion(rid);

  const directory = join(toolchainDir, 'roslyn', `${version}-${rid}`);
  const already = await isComplete(directory);

  if (!already) {
    const packageId = `microsoft.codeanalysis.languageserver.${rid}`;
    const url = `${ROSLYN_FEED}/flat2/${packageId}/${version}/${packageId}.${version}.nupkg`;

    const nupkg = await download(url, onProgress, 'servidor de Roslyn');

    onProgress('extracting', null, 'extrayendo el servidor de Roslyn');
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });

    // Dentro del .nupkg el servidor vive en content/LanguageServer/<rid>/.
    const prefix = `content/LanguageServer/${rid}/`;
    const extracted = await extractTo(nupkg, directory, {
      filter: (entry) => entry.name.startsWith(prefix),
      strip: prefix.split('/').filter(Boolean).length,
    });

    if (extracted === 0) {
      throw new Error(`el paquete ${packageId} ${version} no contiene ${prefix}`);
    }

    await writeFile(markerPath(directory), `${version}\n${sha256(nupkg)}\n`, 'utf8');
  }

  const dll = join(directory, 'Microsoft.CodeAnalysis.LanguageServer.dll');
  const exe = join(directory, process.platform === 'win32' ? 'Microsoft.CodeAnalysis.LanguageServer.exe' : 'Microsoft.CodeAnalysis.LanguageServer');

  const useExe = existsSync(exe);
  if (!useExe && !existsSync(dll)) {
    const contents = existsSync(directory) ? (await readdir(directory)).slice(0, 20).join(', ') : '(vacío)';
    throw new Error(`no se encuentra el ejecutable del servidor en ${directory}. Contenido: ${contents}`);
  }

  onProgress('done', 1, `Roslyn LanguageServer ${version}`);

  return {
    kind: 'roslyn',
    displayName: 'Roslyn LanguageServer',
    version,
    entryPoint: useExe ? exe : dll,
    command: useExe ? exe : 'dotnet',
    args: useExe ? [] : [dll],
    directory,
  };
}

// ---------------------------------------------------------------------------------------------
// OmniSharp (respaldo)
// ---------------------------------------------------------------------------------------------

function omnisharpAssetName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  switch (process.platform) {
    case 'win32':
      return `omnisharp-win-${arch}-net6.0.zip`;
    case 'darwin':
      return `omnisharp-osx-${arch}-net6.0.zip`;
    default:
      return `omnisharp-linux-${arch}-net6.0.zip`;
  }
}

async function acquireOmniSharp(toolchainDir: string, onProgress: AcquireProgress): Promise<AcquiredServer> {
  onProgress('resolving', null, 'resolviendo la última release de OmniSharp');

  const response = await fetch(OMNISHARP_RELEASES, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'DotForge-IDE/1.0', Accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    throw new Error(`no se ha podido consultar las releases de OmniSharp (${response.status})`);
  }

  const release = (await response.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  const wanted = omnisharpAssetName();
  const asset = release.assets.find((item) => item.name === wanted);
  if (!asset) {
    throw new Error(`la release ${release.tag_name} de OmniSharp no publica ${wanted}`);
  }

  const version = release.tag_name;
  const directory = join(toolchainDir, 'omnisharp', version);

  if (!(await isComplete(directory))) {
    const archive = await download(asset.browser_download_url, onProgress, 'OmniSharp');

    onProgress('extracting', null, 'extrayendo OmniSharp');
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await extractTo(archive, directory);

    await writeFile(markerPath(directory), `${version}\n${sha256(archive)}\n`, 'utf8');
  }

  const dll = join(directory, 'OmniSharp.dll');
  const exe = join(directory, process.platform === 'win32' ? 'OmniSharp.exe' : 'OmniSharp');
  const useExe = existsSync(exe);

  if (!useExe && !existsSync(dll)) {
    throw new Error(`no se encuentra OmniSharp en ${directory}`);
  }

  onProgress('done', 1, `OmniSharp ${version}`);

  return {
    kind: 'omnisharp',
    displayName: 'OmniSharp',
    version,
    entryPoint: useExe ? exe : dll,
    command: useExe ? exe : 'dotnet',
    args: useExe ? ['-lsp'] : [dll, '-lsp'],
    directory,
  };
}

/**
 * Devuelve un servidor listo para lanzar. Intenta Roslyn y, si falla (feed caído, RID sin
 * publicar, red corporativa), cae a OmniSharp antes de rendirse.
 */
export async function acquireLanguageServer(
  toolchainDir: string,
  onProgress: AcquireProgress,
): Promise<AcquiredServer> {
  await mkdir(toolchainDir, { recursive: true });

  try {
    return await acquireRoslyn(toolchainDir, onProgress);
  } catch (roslynError) {
    const detail = roslynError instanceof Error ? roslynError.message : String(roslynError);
    onProgress('resolving', null, `Roslyn no disponible (${detail}); probando OmniSharp`);

    try {
      return await acquireOmniSharp(toolchainDir, onProgress);
    } catch (omnisharpError) {
      const fallbackDetail = omnisharpError instanceof Error ? omnisharpError.message : String(omnisharpError);
      throw new Error(
        `no se ha podido obtener ningún servidor de lenguaje.\n` +
          `  Roslyn:    ${detail}\n` +
          `  OmniSharp: ${fallbackDetail}`,
      );
    }
  }
}
