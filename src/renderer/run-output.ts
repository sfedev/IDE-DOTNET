/**
 * Lectura de la salida de un proceso en marcha.
 *
 * El proceso principal ya extrae la URL de la aplicación al **terminar** una tarea, pero un
 * `dotnet run` no termina: hay que sacarla mientras escribe. Aquí se hace en el renderer, línea a
 * línea, para poder enseñar el puerto de cada proyecto en su canal en cuanto aparece.
 *
 * Sin DOM ni E/S: se prueba con Node puro desde `build/ui-lib.mjs`.
 */

/**
 * URLs que anuncian los hosts del ecosistema. Se comprueban en orden, de la más específica a la
 * más genérica, y se exige `http(s)://` para no confundir una ruta con una URL.
 */
const LISTENING_PATTERNS: RegExp[] = [
  // Kestrel: "Now listening on: https://localhost:7156"
  new RegExp(String.raw`Now listening on:\s*(https?://\S+)`, 'i'),
  // Localizado al español por DOTNET_CLI_UI_LANGUAGE.
  new RegExp(String.raw`Escuchando en:\s*(https?://\S+)`, 'i'),
  // `dotnet watch` reenvía la del proceso hijo con su propio prefijo.
  new RegExp(String.raw`watch.*?(https?://localhost:\d+)`, 'i'),
];

/**
 * Extrae la URL en la que escucha un proceso, o `null` si esta línea no la anuncia.
 *
 * Se descarta explícitamente `http://[::]` y `0.0.0.0`: son direcciones de escucha válidas pero
 * no se pueden abrir en un navegador, y enseñarlas como enlace sería una promesa falsa.
 */
export function detectListeningUrl(line: string): string | null {
  for (const pattern of LISTENING_PATTERNS) {
    const match = pattern.exec(line);
    const url = match?.[1];
    if (!url) continue;

    const cleaned = url.replace(/[.,;)]+$/, '');
    if (cleaned.includes('[::]') || cleaned.includes('0.0.0.0')) continue;

    return cleaned;
  }

  return null;
}

/** Puerto de una URL, para enseñarlo compacto en el canal ("5355" en vez de la URL entera). */
export function portOf(url: string): string | null {
  const match = new RegExp(String.raw`:(\d{2,5})(?:/|$)`).exec(url);
  return match?.[1] ?? null;
}
