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

// ---------------------------------------------------------------------------------------------
// Ciclo de vida del canal del proceso depurado
// ---------------------------------------------------------------------------------------------

/** Estados que publica el controlador de depuración. Copia del contrato, para no importarlo. */
export type DebugPhase = 'idle' | 'acquiring' | 'starting' | 'running' | 'paused' | 'error';

export interface DebugChannelTransition {
  /** true mientras haya una sesión de verdad viva. */
  active: boolean;
  /** Qué hacer con el canal del proceso depurado. */
  close: 'none' | 'ok' | 'failed';
}

/**
 * Qué le pasa al canal del proceso depurado ante un cambio de estado del depurador.
 *
 * Existe como función pura por un fallo concreto: `debug:start` **empieza parando** la sesión
 * anterior, y ese `stop` emite `idle` antes de arrancar nada. Cerrar el canal en cualquier `idle`
 * lo mataba recién abierto, y a partir de ahí la salida de la aplicación —incluido el puerto en el
 * que escucha— volvía al canal de compilación: era lo que hacía aparecer "Compilación :5013".
 *
 * La regla, por tanto, es: **un `idle` sólo cierra si antes hubo sesión**. Un `error`, en cambio,
 * cierra siempre: el canal se abre antes de arrancar, así que un fallo al arrancar también tiene
 * que dejarlo marcado.
 */
export function debugChannelTransition(active: boolean, status: DebugPhase): DebugChannelTransition {
  switch (status) {
    case 'starting':
    case 'running':
    case 'paused':
      return { active: true, close: 'none' };

    case 'error':
      return { active: false, close: 'failed' };

    case 'idle':
      return active ? { active: false, close: 'ok' } : { active: false, close: 'none' };

    // `acquiring` es la descarga de NetCoreDbg: todavía no hay sesión, pero tampoco se ha caído.
    case 'acquiring':
      return { active, close: 'none' };
  }
}
