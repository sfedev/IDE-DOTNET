/**
 * Adquisición del servidor de lenguaje C#.
 *
 * Preferencia: `Microsoft.CodeAnalysis.LanguageServer` (Roslyn, MIT), que es el mismo servidor
 * que usa la extensión open source de C# para VS Code. Respaldo: OmniSharp-Roslyn (MIT).
 *
 * Nada de esto se vendorea en el instalador: pesa cientos de megas y depende del RID. Se descarga
 * la primera vez a `userData/toolchain/` y queda cacheado.
 *
 * Desde la v2.0 hay tres cosas que antes no había, y cada una tapa un agujero real:
 *
 *  - **La versión no se elige sola.** El feed publica 763 compilaciones, todas de prelanzamiento, y
 *    "la más alta" es la de anoche de la rama principal de Roslyn. Ahora manda una versión fijada y
 *    verificada a mano (`src/shared/lsp-versions.ts`).
 *  - **La instalación se verifica en cada arranque**, archivo a archivo, contra el manifiesto que se
 *    escribió al extraerla. Un marcador que sólo comprobaba el `.nupkg` ya descartado dejó pasar
 *    durante nueve versiones un DLL truncado en disco.
 *  - **Una versión que no arranca queda en cuarentena** y deja de elegirse en esta máquina.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  addQuarantineEntry,
  parseQuarantine,
  quarantinedVersions,
  staleQuarantineEntries,
  removeQuarantineEntry,
  serializeQuarantine,
  type QuarantineRecord,
} from '../../shared/lsp-health.js';
import { githubToken, rateLimitHint, requestHeaders } from '../../shared/github-api.js';
import { describeSelection, selectRoslynVersion, type RoslynSelection } from '../../shared/lsp-versions.js';
import { describeProblems } from '../../shared/toolchain-manifest.js';
import { installArchive, removeInstall, verifyInstall } from '../services/toolchain-install.js';

/** Feed público donde Microsoft publica el servidor de Roslyn. No requiere autenticación. */
const ROSLYN_FEED = 'https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3';
const OMNISHARP_RELEASES = 'https://api.github.com/repos/OmniSharp/omnisharp-roslyn/releases/latest';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const QUARANTINE_FILE = 'lsp-quarantine.json';

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
  /** Por qué se eligió esta versión, para el registro y la barra de estado. Null en OmniSharp. */
  note: string | null;
}

export interface AcquireProgress {
  (
    phase: 'resolving' | 'downloading' | 'extracting' | 'verifying' | 'done',
    ratio: number | null,
    detail: string,
  ): void;
}

/**
 * Versión de DotForge en marcha, para fechar y caducar los vetos de cuarentena (ADR-063).
 *
 * Se inyecta en vez de importar `electron`: este módulo se prueba con Node pelado. Sin fijarla, las
 * entradas se comparan contra `0.0.0`, que no coincide con ninguna versión real — todas las
 * cuarentenas se considerarían de otra versión y se reintentarían. Es la respuesta conservadora
 * para el caso en el que nadie la haya fijado.
 */
let ideVersion = '0.0.0';

export function setIdeVersion(version: string): void {
  if (version.trim() !== '') ideVersion = version.trim();
}

export function currentIdeVersion(): string {
  return ideVersion;
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

/**
 * Descarga con verificación de longitud.
 *
 * Si el servidor anuncia `content-length` y llega menos, el `.nupkg` está cortado. Antes se
 * extraía igualmente lo que hubiera, y un ZIP cortado puede seguir teniendo directorio central
 * válido para una parte de sus entradas: el resultado es una instalación incompleta que se
 * consideraba buena.
 */
async function download(url: string, onProgress: AcquireProgress, label: string): Promise<Buffer> {
  // El artefacto no vive en la API: el `.nupkg` sale del feed de Azure y el ZIP de OmniSharp de
  // `objects.githubusercontent.com`. `requestHeaders` no adjunta credencial a ninguno de los dos.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: requestHeaders(url, { accept: 'application/octet-stream' }),
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

  if (total > 0 && received !== total) {
    throw new Error(`descarga incompleta de ${label}: ${received} de ${total} bytes`);
  }

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// Cuarentena de versiones
// ---------------------------------------------------------------------------------------------

function quarantinePath(toolchainDir: string): string {
  return join(toolchainDir, QUARANTINE_FILE);
}

export async function readQuarantine(toolchainDir: string): Promise<QuarantineRecord> {
  try {
    return parseQuarantine(await readFile(quarantinePath(toolchainDir), 'utf8'));
  } catch {
    return { version: 1, entries: [] };
  }
}

/** Veta una versión en esta máquina. Se llama cuando el servidor ya instalado no consigue arrancar. */
export async function quarantineRoslynVersion(
  toolchainDir: string,
  version: string,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const rid = currentRid();
  const record = addQuarantineEntry(await readQuarantine(toolchainDir), {
    version,
    rid,
    reason,
    atUtc: now().toISOString(),
    ideVersion,
  });

  await mkdir(toolchainDir, { recursive: true });
  await writeFile(quarantinePath(toolchainDir), serializeQuarantine(record), 'utf8');
}

/** Levanta el veto: la instalación estaba corrupta, no la compilación, y ya se ha reparado. */
export async function pardonRoslynVersion(toolchainDir: string, version: string): Promise<void> {
  const record = removeQuarantineEntry(await readQuarantine(toolchainDir), version, currentRid());
  await mkdir(toolchainDir, { recursive: true });
  await writeFile(quarantinePath(toolchainDir), serializeQuarantine(record), 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Roslyn LanguageServer
// ---------------------------------------------------------------------------------------------

function roslynPackageId(rid: string): string {
  return `microsoft.codeanalysis.languageserver.${rid}`;
}

/** Todas las versiones que publica el feed para este RID. */
export async function roslynFeedVersions(rid: string): Promise<string[]> {
  const url = `${ROSLYN_FEED}/flat2/${roslynPackageId(rid)}/index.json`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: requestHeaders(url, { accept: 'application/json' }),
  });

  if (!response.ok) {
    throw new Error(`no hay servidor de Roslyn publicado para ${rid} (${response.status})`);
  }

  const { versions } = (await response.json()) as { versions?: string[] };
  return Array.isArray(versions) ? versions : [];
}

async function resolveRoslynVersion(toolchainDir: string, rid: string): Promise<RoslynSelection> {
  const record = await readQuarantine(toolchainDir);
  const blocked = quarantinedVersions(record, rid, ideVersion);

  // Un veto dictado por otra versión del IDE no bloquea: se dice y se reintenta (ADR-063).
  for (const stale of staleQuarantineEntries(record, rid, ideVersion)) {
    console.error(
      `[lsp] ${stale.version} quedó descartada por DotForge ${stale.ideVersion ?? '(sin versión)'}; ` +
        `se vuelve a probar con la ${ideVersion}`,
    );
  }

  const selection = selectRoslynVersion(await roslynFeedVersions(rid), { blocked });

  if (selection === null) {
    throw new Error(
      blocked.length > 0
        ? `todas las versiones publicadas de Roslyn para ${rid} están en cuarentena en este equipo`
        : `el feed no lista versiones de ${roslynPackageId(rid)}`,
    );
  }

  return selection;
}

function roslynEntryPoint(directory: string): { command: string; args: string[]; entryPoint: string } | null {
  const dll = join(directory, 'Microsoft.CodeAnalysis.LanguageServer.dll');
  const exe = join(
    directory,
    process.platform === 'win32' ? 'Microsoft.CodeAnalysis.LanguageServer.exe' : 'Microsoft.CodeAnalysis.LanguageServer',
  );

  if (existsSync(exe)) return { command: exe, args: [], entryPoint: exe };
  if (existsSync(dll)) return { command: 'dotnet', args: [dll], entryPoint: dll };
  return null;
}

async function acquireRoslyn(toolchainDir: string, onProgress: AcquireProgress): Promise<AcquiredServer> {
  const rid = currentRid();

  onProgress('resolving', null, 'eligiendo la versión del servidor de Roslyn');
  const selection = await resolveRoslynVersion(toolchainDir, rid);
  const { version } = selection;

  const directory = join(toolchainDir, 'roslyn', `${version}-${rid}`);

  /**
   * Verificación en cada arranque.
   *
   * Es barata (un `stat` por archivo) y es la que convierte una caché rota en una caché sana sin
   * que el usuario tenga que borrar nada: una instalación sin manifiesto —las de la v1.9 y
   * anteriores— cuenta como no verificada y se vuelve a instalar entera.
   */
  onProgress('verifying', null, `comprobando la instalación de Roslyn ${version}`);
  const check = await verifyInstall(directory);
  const usable = check.verified && check.problems.length === 0 && roslynEntryPoint(directory) !== null;

  if (!usable) {
    if (check.verified && check.problems.length > 0) {
      onProgress('verifying', null, `la copia de Roslyn ${version} está dañada (${describeProblems(check.problems)}); se reinstala`);
    }

    const packageId = roslynPackageId(rid);
    const url = `${ROSLYN_FEED}/flat2/${packageId}/${version}/${packageId}.${version}.nupkg`;
    const nupkg = await download(url, onProgress, 'servidor de Roslyn');

    onProgress('extracting', null, 'extrayendo el servidor de Roslyn');

    // Dentro del .nupkg el servidor vive en content/LanguageServer/<rid>/.
    const prefix = `content/LanguageServer/${rid}/`;
    const result = await installArchive(nupkg, directory, {
      kind: 'roslyn',
      packageVersion: version,
      rid,
      filter: (entry) => entry.name.startsWith(prefix),
      strip: prefix.split('/').filter(Boolean).length,
    });

    if (result.files === 0) {
      throw new Error(`el paquete ${packageId} ${version} no contiene ${prefix}`);
    }
  }

  const launch = roslynEntryPoint(directory);
  if (launch === null) {
    const contents = existsSync(directory) ? (await readdir(directory)).slice(0, 20).join(', ') : '(vacío)';
    throw new Error(`no se encuentra el ejecutable del servidor en ${directory}. Contenido: ${contents}`);
  }

  onProgress('done', 1, `Roslyn LanguageServer ${version}`);

  return {
    kind: 'roslyn',
    displayName: 'Roslyn LanguageServer',
    version,
    entryPoint: launch.entryPoint,
    command: launch.command,
    args: launch.args,
    directory,
    note: describeSelection(selection),
  };
}

/**
 * Auditoría profunda de una instalación ya desplegada.
 *
 * Se pide **después** de que el servidor haya fallado, y sirve para responder la única pregunta que
 * importa entonces: ¿está corrupta esta copia, o está mal la compilación? Se hashea todo, que es
 * caro, pero ocurre una vez y fuera del camino normal.
 */
export async function auditInstall(directory: string): Promise<{ corrupt: boolean; detail: string }> {
  const check = await verifyInstall(directory, { deep: true });

  if (!check.verified) return { corrupt: true, detail: 'la instalación no tiene manifiesto' };
  if (check.problems.length === 0) return { corrupt: false, detail: 'instalación íntegra' };

  return { corrupt: true, detail: describeProblems(check.problems) };
}

/** Borra una instalación dañada para que el siguiente arranque la baje limpia. */
export async function discardInstall(directory: string): Promise<void> {
  await removeInstall(directory);
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

/**
 * Adquiere OmniSharp.
 *
 * Es público porque el respaldo dejó de ser sólo "Roslyn no se ha podido descargar": ahora también
 * se llega aquí con Roslyn perfectamente instalado y arrancado, cuando resulta que no compone.
 */
export async function acquireOmniSharpServer(
  toolchainDir: string,
  onProgress: AcquireProgress,
): Promise<AcquiredServer> {
  await mkdir(toolchainDir, { recursive: true });
  onProgress('resolving', null, 'resolviendo la última release de OmniSharp');

  const response = await fetch(OMNISHARP_RELEASES, {
    signal: AbortSignal.timeout(60_000),
    headers: requestHeaders(OMNISHARP_RELEASES),
  });

  if (!response.ok) {
    // Igual que con NetCoreDbg: un 403 sin token es el límite por IP, no un permiso.
    const hint = rateLimitHint(response.status, githubToken() !== null);
    throw new Error(
      `no se ha podido consultar las releases de OmniSharp (${response.status})${hint === null ? '' : `: ${hint}`}`,
    );
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

  onProgress('verifying', null, `comprobando la instalación de OmniSharp ${version}`);
  const check = await verifyInstall(directory);

  if (!check.verified || check.problems.length > 0) {
    const archive = await download(asset.browser_download_url, onProgress, 'OmniSharp');
    onProgress('extracting', null, 'extrayendo OmniSharp');
    await installArchive(archive, directory, { kind: 'omnisharp', packageVersion: version, rid: currentRid() });
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
    note: null,
  };
}

export interface AcquireOptions {
  /** `omnisharp` salta Roslyn directamente. Se usa al conmutar tras un fallo en marcha. */
  prefer?: ServerKind;
}

/**
 * Devuelve un servidor listo para lanzar. Intenta Roslyn y, si falla (feed caído, RID sin
 * publicar, red corporativa, todas las versiones en cuarentena), cae a OmniSharp antes de rendirse.
 */
export async function acquireLanguageServer(
  toolchainDir: string,
  onProgress: AcquireProgress,
  options: AcquireOptions = {},
): Promise<AcquiredServer> {
  await mkdir(toolchainDir, { recursive: true });

  if (options.prefer === 'omnisharp') {
    return acquireOmniSharpServer(toolchainDir, onProgress);
  }

  try {
    return await acquireRoslyn(toolchainDir, onProgress);
  } catch (roslynError) {
    const detail = roslynError instanceof Error ? roslynError.message : String(roslynError);
    onProgress('resolving', null, `Roslyn no disponible (${detail}); probando OmniSharp`);

    try {
      return await acquireOmniSharpServer(toolchainDir, onProgress);
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
