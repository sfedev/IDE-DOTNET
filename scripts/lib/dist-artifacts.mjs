/**
 * Reglas para decidir qué artefactos de `/dist` pertenecen a una versión anterior.
 *
 * Vive aparte del script que borra archivos para poder probarlas sin tocar el disco: una función
 * que decide qué se borra merece pruebas, y no se pueden escribir contra `rm -rf`.
 *
 * El nombre de artefacto lo compone electron-builder con `${productName}-${version}-...`, así que
 * la versión va incrustada en el nombre:
 *
 *   DotForge IDE-1.1.0-Setup-x64.exe
 *   DotForge IDE-1.1.0-win-x64.zip
 *   DotForge IDE-1.1.0-arm64.dmg
 */

/** Reconoce el sello de versión de un nombre de artefacto: `-1.2.0-` o `-1.2.0.` */
const VERSION_STAMP = /-\d+\.\d+\.\d+[-.]/;

/**
 * ¿Es este archivo el artefacto de una versión que ya no es la actual?
 *
 * Conservador por diseño: sólo devuelve `true` si el nombre lleva un sello de versión **y** ese
 * sello no es el de la versión actual. Un archivo sin versión en el nombre (`win-unpacked`,
 * `builder-debug.yml`, `latest.yml`) nunca se considera obsoleto porque cada build lo reescribe.
 *
 * La comparación se hace por cadena y no extrayendo la versión con una expresión regular, para
 * que las preliberaciones (`1.2.0-beta.1`) no se confundan con el sufijo de plataforma
 * (`1.2.0-win-x64`): con el sello actual presente, el archivo es de la versión actual y punto.
 *
 * Limitación deliberada de esa decisión: estando en la `1.2.0`, un artefacto `1.2.0-beta.1` se
 * conserva, porque su nombre contiene el sello `-1.2.0-`. Se acepta a cambio de la garantía que
 * de verdad importa: **nunca borrar un artefacto de la versión actual**. Distinguir ahí obligaría
 * a mantener una lista de sufijos de destino (`win`, `mac`, `arm64`, `Setup`, ...) y a acertar con
 * ella siempre; equivocarse borraría el instalador recién construido. Un `.exe` de una beta que
 * sobrevive se borra a mano; el que se acaba de compilar, no se recupera sin volver a compilar.
 */
export function isStaleArtifact(name, currentVersion) {
  if (typeof name !== 'string' || typeof currentVersion !== 'string' || currentVersion === '') {
    throw new TypeError('isStaleArtifact requiere un nombre y una versión actual');
  }

  if (name.includes(`-${currentVersion}-`) || name.includes(`-${currentVersion}.`)) return false;

  return VERSION_STAMP.test(name);
}

/** Filtra una lista de nombres y devuelve, ordenados, los que sobran. */
export function selectStaleArtifacts(names, currentVersion) {
  return names.filter((name) => isStaleArtifact(name, currentVersion)).sort();
}
