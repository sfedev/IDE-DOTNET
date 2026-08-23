/**
 * Operaciones de archivo del workspace.
 *
 * Toda ruta pasa por `assertInsideWorkspace` antes de tocar el disco: este módulo asume que sus
 * llamadores son hostiles.
 */
import { readdir, readFile, rename, rm, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type { EditorDocument, FileNode } from '../../shared/contracts.js';
import { IGNORED_DIRECTORIES } from './solution-service.js';
import { assertInsideWorkspace } from './workspace-guard.js';

/** Tamaño máximo que se abre en el editor. Por encima, Monaco se arrastra y no aporta nada. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;

/** Extensión -> id de lenguaje de Monaco. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.cs': 'csharp',
  '.csx': 'csharp',
  '.razor': 'razor',
  '.cshtml': 'razor',
  '.csproj': 'xml',
  '.fsproj': 'xml',
  '.vbproj': 'xml',
  '.props': 'xml',
  '.targets': 'xml',
  '.xml': 'xml',
  '.config': 'xml',
  '.nuspec': 'xml',
  '.resx': 'xml',
  '.axaml': 'xml',
  '.xaml': 'xml',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.htm': 'html',
  '.sql': 'sql',
  '.sh': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.sln': 'ini',
  '.slnx': 'xml',
  '.editorconfig': 'ini',
  '.gitignore': 'plaintext',
  '.dockerfile': 'dockerfile',
};

export function languageIdFor(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === '.editorconfig') return 'ini';
  if (name === '.gitignore') return 'plaintext';
  return LANGUAGE_BY_EXTENSION[extname(name)] ?? 'plaintext';
}

/** Un directorio se oculta si es ruido de build o control de versiones. */
function isHiddenDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

export async function listDirectory(rawPath: string): Promise<FileNode[]> {
  const directory = assertInsideWorkspace(rawPath);
  const entries = await readdir(directory, { withFileTypes: true });

  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && isHiddenDirectory(entry.name)) continue;

    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: fullPath,
        kind: 'directory',
        loaded: false,
        children: [],
        extension: '',
      });
    } else if (entry.isFile()) {
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await stat(fullPath)).size;
      } catch {
        sizeBytes = undefined;
      }
      nodes.push({
        name: entry.name,
        path: fullPath,
        kind: 'file',
        extension: extname(entry.name).toLowerCase(),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      });
    }
  }

  // Carpetas primero y alfabético dentro de cada grupo: es lo que espera cualquiera que venga
  // de Visual Studio o de VS Code.
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'es', { numeric: true });
  });

  return nodes;
}

export async function readDocument(rawPath: string): Promise<EditorDocument> {
  const filePath = assertInsideWorkspace(rawPath);
  const info = await stat(filePath);

  if (!info.isFile()) {
    throw new Error(`no es un archivo: ${filePath}`);
  }
  if (info.size > MAX_EDITABLE_BYTES) {
    throw new Error(
      `el archivo pesa ${(info.size / 1048576).toFixed(1)} MB y supera el máximo editable de ${MAX_EDITABLE_BYTES / 1048576} MB`,
    );
  }

  const raw = await readFile(filePath);

  // Un byte nulo en los primeros 8 KB es la heurística habitual para detectar binarios.
  if (raw.subarray(0, 8192).includes(0)) {
    throw new Error('el archivo parece binario y no se puede abrir en el editor');
  }

  // Se retira el BOM: Monaco lo mostraría como un carácter invisible al principio.
  const content = raw.toString('utf8').replace(/^﻿/, '');

  return {
    path: filePath,
    content,
    languageId: languageIdFor(filePath),
    encoding: 'utf8',
    readOnly: false,
    mtimeMs: info.mtimeMs,
  };
}

export async function writeDocument(rawPath: string, content: string): Promise<{ mtimeMs: number }> {
  const filePath = assertInsideWorkspace(rawPath);
  if (typeof content !== 'string') {
    throw new Error('el contenido debe ser una cadena');
  }

  await writeFile(filePath, content, 'utf8');
  return { mtimeMs: (await stat(filePath)).mtimeMs };
}

export async function createFile(rawPath: string, content = ''): Promise<void> {
  const filePath = assertInsideWorkspace(rawPath);
  await mkdir(join(filePath, '..'), { recursive: true });
  // `wx` falla si ya existe: crear no debe sobrescribir en silencio.
  await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
}

export async function createDirectory(rawPath: string): Promise<void> {
  const directory = assertInsideWorkspace(rawPath);
  await mkdir(directory, { recursive: true });
}

export async function renamePath(rawFrom: string, rawTo: string): Promise<void> {
  const from = assertInsideWorkspace(rawFrom);
  const to = assertInsideWorkspace(rawTo);
  await rename(from, to);
}

export async function deletePath(rawPath: string): Promise<void> {
  const target = assertInsideWorkspace(rawPath);
  await rm(target, { recursive: true, force: true });
}
