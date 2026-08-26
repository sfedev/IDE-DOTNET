#!/usr/bin/env node
/**
 * Notas de una release, compuestas desde el historial de git.
 *
 * Lo lanza el workflow de publicación justo antes de crear la release, y también sirve a mano para
 * ver qué se va a publicar antes de empujar el tag:
 *
 *   node scripts/release-notes.mjs                          -> la versión de package.json
 *   node scripts/release-notes.mjs --tag v2.5.0
 *   node scripts/release-notes.mjs --output notas.md --artifacts dist
 *
 * La composición del texto vive en `scripts/lib/release-notes.mjs` y está probada; aquí sólo se
 * habla con `git` y con el disco. El reparto es el mismo de siempre en este repositorio: lo que
 * decide, puro; lo que ejecuta, delgado.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReleaseNotes,
  parseCommitSubjects,
  releaseTagFor,
  versionFromTag,
} from './lib/release-notes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Extensiones que se adjuntan a una release. El resto de `/dist` es material de compilación. */
const PUBLISHABLE = ['.exe', '.zip', '.dmg'];

function parseArgs(argv) {
  const options = { tag: null, previous: null, artifacts: null, output: null };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--tag' && value) { options.tag = value; index++; }
    else if (flag === '--previous' && value) { options.previous = value; index++; }
    else if (flag === '--artifacts' && value) { options.artifacts = value; index++; }
    else if (flag === '--output' && value) { options.output = value; index++; }
  }
  return options;
}

/**
 * Ejecuta git y devuelve su salida, o `null` si falla.
 *
 * Falla constantemente y sin que sea un problema: no hay tag anterior, el tag todavía no existe
 * porque la release se está creando desde un disparo manual, el checkout es superficial. Ninguno
 * de esos casos justifica abortar la publicación, así que se degradan a "sin dato".
 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** ¿Existe esta referencia en el repositorio? */
function refExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
}

/**
 * Tag inmediatamente anterior al que se publica.
 *
 * Se pregunta por orden de versión (`--sort=-v:refname`) y no por fecha: un tag creado a posteriori
 * sobre un commit viejo desordena el historial y produciría un rango de cambios absurdo.
 */
function previousTagFor(tag) {
  const raw = git(['tag', '--list', 'v*', '--sort=-v:refname']);
  if (raw === null) return null;

  const tags = raw.split('\n').map((line) => line.trim()).filter((line) => versionFromTag(line) !== null);
  const index = tags.indexOf(tag);

  // Si el tag ya existe, el anterior es el siguiente de la lista; si todavía no existe (disparo
  // manual antes de etiquetar), el anterior es simplemente el más alto que hay publicado.
  const candidate = index === -1 ? tags[0] : tags[index + 1];
  return candidate !== undefined && candidate !== tag ? candidate : null;
}

/** Asuntos de los commits del rango. Sin tag anterior, todo el historial hasta el punto de corte. */
function commitsFor(tag, previousTag) {
  const head = refExists(tag) ? tag : 'HEAD';
  const range = previousTag !== null && refExists(previousTag) ? `${previousTag}..${head}` : head;
  return parseCommitSubjects(git(['log', '--no-merges', '--pretty=format:%s', range]) ?? '');
}

/** Nombres de los artefactos publicables que hay en un directorio. */
function artifactsIn(directory) {
  const full = join(root, directory);
  if (!existsSync(full)) return [];

  return readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => PUBLISHABLE.some((extension) => name.toLowerCase().endsWith(extension)))
    .sort();
}

const options = parseArgs(process.argv.slice(2));

const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const tag = releaseTagFor(options.tag ?? packageVersion);
const version = versionFromTag(tag);

if (version === null) {
  console.error(`"${tag}" no tiene forma de versión: se esperaba algo como v2.5.0`);
  process.exit(1);
}

const previousTag = options.previous ?? previousTagFor(tag);
const notes = buildReleaseNotes({
  version,
  commits: commitsFor(tag, previousTag),
  previousTag,
  artifacts: options.artifacts === null ? [] : artifactsIn(options.artifacts),
});

if (options.output === null) {
  process.stdout.write(notes);
} else {
  writeFileSync(join(root, options.output), notes, 'utf8');
  console.log(`Notas de ${tag} escritas en ${options.output} (${notes.length} caracteres).`);
}
