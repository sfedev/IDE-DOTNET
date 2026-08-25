/**
 * Lectura de JSON escrito por otras herramientas.
 *
 * Por qué existe: los archivos JSON de un proyecto .NET no los escribe este IDE. Los escribe
 * Visual Studio, `dotnet new` o una mano humana con el Bloc de notas, y en Windows todos ellos
 * guardan a menudo con **marca de orden de bytes** UTF-8 (`EF BB BF`, que descodificado es el
 * carácter U+FEFF). `JSON.parse` la rechaza: no es espacio en blanco para la gramática de JSON,
 * así que el archivo entero falla en la posición 0 con un mensaje que ni siquiera consigue
 * imprimir el carácter que le molesta.
 *
 * El daño no es el error, que se ve; es lo que pasa cuando el error se traga. Un
 * `launchSettings.json` con BOM dejaba la sesión sin `ASPNETCORE_URLS` ni
 * `ASPNETCORE_ENVIRONMENT`, y Kestrel arrancaba en el 5000 por HTTP, en Production y sin *static
 * web assets*: un fallo que se manifiesta tres pantallas más allá del sitio donde está la causa
 * (ADR-058).
 *
 * Puro, sin `node:*` y sin DOM: lo usan el proceso principal, el renderer y las pruebas.
 */

/**
 * Marca de orden de bytes UTF-8, ya descodificada.
 *
 * Se construye por código y no como literal a propósito: escrita a mano es un carácter invisible
 * dentro del archivo fuente, y lo invisible se pierde en el primer copiado.
 */
export const BOM = String.fromCharCode(0xfeff);

/**
 * Quita la marca de orden de bytes del principio del texto.
 *
 * **Sólo la del principio.** Un U+FEFF en mitad del archivo es un carácter de contenido (un
 * espacio de ancho cero) y borrarlo cambiaría el valor de una cadena; el problema de codificación
 * es sólo el de la primera posición.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * `JSON.parse` tolerante con el BOM.
 *
 * Se sigue lanzando `SyntaxError` con cualquier otro error de formato: lo que se arregla aquí es
 * una diferencia de codificación, no una invitación a tragarse un archivo roto.
 */
export function parseJsonText<T = unknown>(text: string): T {
  return JSON.parse(stripBom(text)) as T;
}
