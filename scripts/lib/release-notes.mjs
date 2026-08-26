/**
 * Cuerpo de una release de GitHub, compuesto a partir de los commits del rango.
 *
 * Vive aparte del script que llama a `git` y a `gh` por el mismo motivo que `dist-artifacts.mjs`:
 * una función que decide *qué texto ve el usuario* merece pruebas, y no se pueden escribir contra
 * un `git log` real ni contra la API de GitHub.
 *
 * Lo que hace especial a este texto es **quién lo lee**. No es sólo la página de la release: el
 * mismo cuerpo vuelve al IDE por el feed de actualizaciones y lo pinta la tarjeta flotante, que lo
 * pasa por `releaseNotesLines` (`src/shared/updates.ts`) y se queda con las primeras líneas ya sin
 * marcas de Markdown. De ahí tres reglas que no son de estilo:
 *
 *  - **Lo importante va arriba.** La tarjeta enseña doce líneas. Un cuerpo que empieza por la
 *    plantilla de instalación deja al usuario mirando instrucciones en vez de qué ha cambiado.
 *  - **Nada de tablas ni de HTML.** El renderer no inyecta marcado (regla del sistema de diseño):
 *    una tabla Markdown llega a la tarjeta como una fila de barras verticales.
 *  - **Ninguna línea puede quedar vacía al limpiarla.** `releaseNotesLines` descarta los separadores
 *    (`---`) y las líneas que sólo eran adorno. Una lista de guiones sueltos se ve entera en GitHub
 *    y desaparece por completo en el IDE.
 */

/** Repositorio del que se publican las versiones. El mismo que consulta `UPDATE_FEED`. */
export const RELEASE_REPO = 'sfedev/IDE-DOTNET';

/** Cuántos commits se listan como mucho. Por encima, se dice cuántos quedan fuera. */
export const MAX_COMMITS = 40;

/**
 * Prefijos de commits que no cuentan como cambio para quien lee la release.
 *
 * Se comparan en minúsculas y sólo al principio del asunto: un commit que *hable* de un merge en
 * mitad de la frase sí es un cambio. La lista es corta a propósito — filtrar de más deja una
 * release que no explica lo que trae, que es peor que una con ruido.
 */
const NOISE_PREFIXES = ['merge branch', 'merge pull request', 'merge remote-tracking'];

/** `2.5.0` -> `v2.5.0`. Idempotente: un tag ya prefijado se devuelve tal cual. */
export function releaseTagFor(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new TypeError('releaseTagFor requiere una versión');
  }
  const clean = version.trim();
  return clean.startsWith('v') ? clean : `v${clean}`;
}

/**
 * `v2.5.0` -> `2.5.0`, y `null` si el tag no tiene forma de versión.
 *
 * Misma respuesta conservadora que `parseVersion` en el modelo del actualizador: lo que no se
 * entiende no se convierte en una versión inventada. Un tag `nightly` no es la `0.0.0`.
 */
export function versionFromTag(tag) {
  if (typeof tag !== 'string') return null;
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  return match === null ? null : match[1];
}

/**
 * Trocea la salida de `git log --pretty=format:%s` en asuntos de commit.
 *
 * Quita los merges, los vacíos y los duplicados consecutivos —un `git log` de un rango con
 * cherry-picks los produce— conservando el orden, que es del más reciente al más antiguo.
 */
export function parseCommitSubjects(raw) {
  if (typeof raw !== 'string') return [];

  const subjects = [];
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const subject = line.trim();
    if (subject === '') continue;

    const lower = subject.toLowerCase();
    if (NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    if (subjects[subjects.length - 1] === subject) continue;

    subjects.push(subject);
  }

  return subjects;
}

/** URL de comparación entre dos tags, o `null` si no hay tag anterior (primera release). */
export function compareUrl(previousTag, tag, repo = RELEASE_REPO) {
  if (typeof previousTag !== 'string' || previousTag.trim() === '') return null;
  return `https://github.com/${repo}/compare/${previousTag.trim()}...${tag}`;
}

/**
 * Compone el cuerpo Markdown de la release.
 *
 * `commits` llega ya troceado (`parseCommitSubjects`). `artifacts` son los nombres de archivo que
 * se van a adjuntar; si viene vacío no se inventa una sección de descargas, porque la propia
 * página de la release ya lista lo que haya.
 */
export function buildReleaseNotes(options) {
  const { version, commits = [], previousTag = null, artifacts = [], repo = RELEASE_REPO } = options ?? {};

  if (typeof version !== 'string' || version.trim() === '') {
    throw new TypeError('buildReleaseNotes requiere una versión');
  }

  const tag = releaseTagFor(version);
  const clean = versionFromTag(tag) ?? version.trim();
  const lines = [`## DotForge IDE ${tag}`, ''];

  if (commits.length === 0) {
    // Pasa de verdad: una release creada sobre el mismo commit que la anterior. Decirlo es mejor
    // que dejar el cuerpo en blanco, que se lee como un fallo del workflow.
    lines.push('Sin cambios registrados desde la versión anterior.', '');
  } else {
    lines.push('### Cambios', '');
    for (const subject of commits.slice(0, MAX_COMMITS)) {
      lines.push(`- ${subject}`);
    }

    // Un tope silencioso se lee como "esto es todo lo que hay". Se dice cuántos faltan y dónde
    // están los demás.
    const omitted = commits.length - MAX_COMMITS;
    if (omitted > 0) {
      lines.push(`- …y ${omitted} ${omitted === 1 ? 'cambio más' : 'cambios más'} en el historial.`);
    }
    lines.push('');
  }

  if (artifacts.length > 0) {
    lines.push('### Descargas', '');
    for (const artifact of artifacts) {
      lines.push(`- ${artifact}${describeArtifact(artifact)}`);
    }
    lines.push('');
  }

  lines.push(
    '### Actualización automática',
    '',
    `DotForge IDE ${clean} se ofrece solo desde cualquier versión anterior: el IDE comprueba esta`,
    'misma publicación al arrancar y aplica la instalación al cerrarse.',
    '',
  );

  const compare = compareUrl(previousTag, tag, repo);
  if (compare !== null) lines.push(`Cambios completos: ${compare}`);

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Qué es cada artefacto, en palabras.
 *
 * Un `.exe` y un `.zip` de 120 y 165 MB no se distinguen por el nombre si no se sabe que uno
 * instala y el otro no. Lo que no se reconoce no se anota: inventar una descripción es peor.
 */
function describeArtifact(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.exe')) return ' — instalador para Windows.';
  if (lower.endsWith('.dmg')) return ' — imagen de disco para macOS.';
  if (lower.endsWith('.zip') && lower.includes('-win-')) return ' — portable para Windows, sin instalar.';
  if (lower.endsWith('.zip') && lower.includes('-mac-')) return ' — aplicación de macOS comprimida.';
  return '';
}
