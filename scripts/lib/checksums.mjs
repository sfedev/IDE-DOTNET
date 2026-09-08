/**
 * Sumas SHA-256 de los artefactos de una release.
 *
 * Vive aparte del script que lee el disco por el mismo motivo que `dist-artifacts.mjs` y
 * `release-notes.mjs`: lo que decide, puro; lo que ejecuta, delgado. Aquí no se abre ningún
 * archivo — se compone y se lee el texto del `SHA256SUMS.txt`, que es lo que merece pruebas.
 *
 * **Para qué existe.** Un instalador de 126 MB sin firmar que sale de una release de GitHub no
 * ofrece a quien lo descarga ninguna forma de comprobar que es el que construyó la CI. No es una
 * preocupación teórica: en un equipo corporativo, la respuesta de un antivirus a "esto lo he
 * compilado yo" es "demuéstralo", y sin un hash publicado no hay nada que enseñar. La firma
 * Authenticode resuelve esto de raíz y esto no la sustituye; mientras no la haya, es lo que hay.
 *
 * **El formato es el de `sha256sum`**, con sus dos espacios entre el hash y el nombre, y no un JSON
 * ni una tabla bonita. Es lo que hace que el archivo se pueda verificar sin instalar nada:
 *
 *     sha256sum -c SHA256SUMS.txt                             (Linux, macOS, Git Bash)
 *     Get-FileHash .\DotForge.IDE-2.9.1-Setup-x64.exe         (PowerShell, se compara a ojo)
 *
 * Un formato propio obligaría a escribir el verificador, y el verificador que nadie ejecuta no
 * verifica nada.
 */

/** Nombre del archivo de sumas que se adjunta a la release. En mayúsculas, por convención. */
export const CHECKSUM_FILE_NAME = 'SHA256SUMS.txt';

/**
 * El nombre con el que un artefacto acaba publicado en la release.
 *
 * **GitHub renombra los assets al subirlos**: sustituye por puntos los caracteres que no admite en
 * el nombre de un asset, y el espacio es uno de ellos. `DotForge IDE-2.9.2-Setup-x64.exe` se
 * descarga como `DotForge.IDE-2.9.2-Setup-x64.exe`.
 *
 * Sin esto, el manifiesto lleva el nombre de compilación y quien lo descarga tiene el de descarga,
 * así que `sha256sum -c` falla con "No such file or directory" en **todas** las entradas — con los
 * hashes correctos. Pasó en la v2.9.2, que es la primera release que publicó sumas. Una
 * verificación que no encuentra el archivo no dice que esté mal: dice que no se ha comprobado
 * nada, y se lee igual de rojo.
 *
 * Se normaliza sólo el espacio, no todo lo que GitHub pueda tocar: el nombre lo compone
 * `artifactName` de electron-builder a partir de `productName`, y sólo produce letras, dígitos,
 * puntos, guiones y ese espacio. Inventar el resto de la tabla sería adivinar.
 */
export function publishedAssetName(name) {
  if (typeof name !== 'string') {
    throw new TypeError('publishedAssetName requiere un nombre de archivo');
  }
  return name.replace(/ /g, '.');
}

/** Un SHA-256 en hexadecimal: 64 dígitos, en minúsculas. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Una línea del formato `sha256sum`: hash, separador y nombre.
 *
 * El separador son dos caracteres: dos espacios para un archivo de texto y espacio más asterisco
 * para uno binario. `sha256sum` genera el segundo con `-b` y acepta los dos al verificar, así que
 * aquí se leen ambos aunque sólo se escriba el primero.
 */
const CHECKSUM_LINE = /^([0-9a-f]{64})\s[\s*](.+)$/;

/**
 * Compone el contenido del `SHA256SUMS.txt`.
 *
 * Ordena por nombre en vez de conservar el orden de llegada: el archivo se compara entre versiones
 * —"¿ha cambiado algo más que el instalador?"— y un orden que dependa de cómo `readdir` haya
 * devuelto la carpeta convierte cualquier comparación en ruido.
 */
export function formatChecksumFile(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('formatChecksumFile requiere una lista de entradas');
  }

  const lines = [...entries]
    .map((entry) => normalizeEntry(entry))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map((entry) => `${entry.sha256}  ${entry.name}`);

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * Lee un `SHA256SUMS.txt` y devuelve sus entradas.
 *
 * Tolerante con lo que no es una entrada —líneas en blanco, comentarios con `#`— y estricto con lo
 * que lo parece y está mal: una línea con un hash de 63 dígitos no se ignora en silencio, porque
 * ignorarla convierte un archivo corrupto en una verificación que pasa.
 */
export function parseChecksumFile(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseChecksumFile requiere el contenido del archivo');
  }

  const entries = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = CHECKSUM_LINE.exec(line);
    if (match === null) {
      throw new Error(`línea con formato inesperado en ${CHECKSUM_FILE_NAME}: ${line}`);
    }

    entries.push({ sha256: match[1], name: match[2].trim() });
  }

  return entries;
}

/**
 * Compara lo publicado con lo que hay de verdad.
 *
 * Devuelve las tres formas de no cuadrar por separado, y no un booleano: "falta un archivo", "sobra
 * un archivo" y "el hash no coincide" mandan a mirar a tres sitios distintos. La tercera es la
 * única alarmante; las otras dos casi siempre significan que la lista se generó en otro momento.
 */
export function verifyChecksums(expected, actual) {
  const expectedByName = indexByName(expected, 'expected');
  const actualByName = indexByName(actual, 'actual');

  const missing = [];
  const mismatched = [];
  for (const [name, sha256] of expectedByName) {
    const found = actualByName.get(name);
    if (found === undefined) missing.push(name);
    else if (found !== sha256) mismatched.push({ name, expected: sha256, actual: found });
  }

  const extra = [...actualByName.keys()].filter((name) => !expectedByName.has(name));

  return {
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    missing: missing.sort(),
    extra: extra.sort(),
    mismatched: mismatched.sort((a, b) => a.name.localeCompare(b.name, 'en')),
  };
}

/** Valida una entrada y la devuelve normalizada. Un hash en mayúsculas es válido y se baja. */
function normalizeEntry(entry) {
  const name = entry?.name;
  const sha256 = typeof entry?.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : entry?.sha256;

  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('cada entrada necesita el nombre del archivo');
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new TypeError(`"${name}" no trae un SHA-256 de 64 dígitos hexadecimales`);
  }
  // El nombre acaba en un archivo que se verifica desde una consola: un salto de línea o una barra
  // dentro romperían el formato o apuntarían a otro directorio.
  if (/[\n\r]/.test(name) || name.includes('/') || name.includes('\\')) {
    throw new TypeError(`nombre de artefacto no válido para ${CHECKSUM_FILE_NAME}: ${name}`);
  }

  return { name: name.trim(), sha256 };
}

/** Lista de entradas -> mapa nombre => hash, detectando duplicados. */
function indexByName(entries, label) {
  if (!Array.isArray(entries)) {
    throw new TypeError(`verifyChecksums requiere una lista de entradas (${label})`);
  }

  const map = new Map();
  for (const entry of entries) {
    const { name, sha256 } = normalizeEntry(entry);
    if (map.has(name)) throw new Error(`"${name}" aparece dos veces en la lista ${label}`);
    map.set(name, sha256);
  }
  return map;
}
