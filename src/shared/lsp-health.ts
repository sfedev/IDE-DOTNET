/**
 * Salud del servidor de lenguaje: detectar que se ha roto y dejar constancia de qué versión fue.
 *
 * El caso que motiva este archivo es el más traicionero que ha dado el proyecto. El servidor de
 * Roslyn **no se cae** cuando su gráfico MEF no compone: escribe el error por stderr, sigue vivo,
 * contesta al handshake `initialize` y hasta anuncia "Language server initialized" por stdout. Lo
 * que queda es un servidor que responde `null` a hover, completado, símbolos y tokens semánticos
 * con la barra de estado diciendo "listo". Por fuera es indistinguible de uno que funciona.
 *
 * De ahí las tres reglas de este módulo:
 *
 *  - **Se mira stderr, no el código de salida.** El proceso termina con 0.
 *  - **Se buscan nombres de tipo de excepción, nunca mensajes.** El mensaje de este mismo fallo sale
 *    en español en un Windows en español ("No se pudo cargar el ensamblado […] para su análisis"),
 *    así que cualquier regex sobre el texto funciona en la máquina de quien la escribió. Un
 *    `PartDiscoveryException` se llama igual en las trece culturas que trae el paquete.
 *  - **Se exige que el trozo venga en un bloque de nivel `fail:` o `crit:`.** Roslyn registra por
 *    stderr un montón de cosas informativas, y alguna menciona rutas que no existen.
 *
 * Todo es puro. El servicio se limita a empujar los trozos de stderr según llegan.
 */

/** Categoría del fallo. Decide el texto que ve el usuario y si la versión merece cuarentena. */
export type ServerFaultCategory = 'mef' | 'assembly' | 'crash';

export interface ServerFault {
  category: ServerFaultCategory;
  /** El nombre de tipo que lo delató. */
  signature: string;
  /** La línea completa, recortada, para el registro. */
  detail: string;
}

/**
 * Nombres de tipo que significan "este servidor no va a servir para nada".
 *
 * Deliberadamente **no** está `OutOfMemoryException`: eso habla de la máquina, no del paquete, y
 * poner una versión en cuarentena por quedarse sin memoria dejaría al usuario sin Roslyn para
 * siempre por un pico de un día.
 */
export const FATAL_SIGNATURES: readonly { signature: string; category: ServerFaultCategory }[] = [
  { signature: 'PartDiscoveryException', category: 'mef' },
  { signature: 'CompositionFailedException', category: 'mef' },
  { signature: 'ComposedPartNotFoundException', category: 'mef' },
  { signature: 'ReflectionTypeLoadException', category: 'assembly' },
  { signature: 'BadImageFormatException', category: 'assembly' },
  { signature: 'FileNotFoundException', category: 'assembly' },
  { signature: 'FileLoadException', category: 'assembly' },
  { signature: 'TypeLoadException', category: 'assembly' },
  { signature: 'MissingMethodException', category: 'assembly' },
  { signature: 'MissingMemberException', category: 'assembly' },
  { signature: 'TypeInitializationException', category: 'crash' },
];

/** Niveles del registro de consola de `Microsoft.Extensions.Logging`, que es lo que usa el servidor. */
export type ServerLogLevel = 'trce' | 'dbug' | 'info' | 'warn' | 'fail' | 'crit';

const LEVEL_LINE = /^(trce|dbug|info|warn|fail|crit):\s/;
const EXCEPTION_HEADER = /^[A-Za-z0-9_.]+Exception:\s/;

/** ¿Es un nivel que indica que algo se ha roto de verdad? */
export function isFatalLevel(level: ServerLogLevel | null): boolean {
  return level === 'fail' || level === 'crit';
}

/** El nivel que declara una línea, o `null` si es continuación de la anterior. */
export function logLevelOf(line: string): ServerLogLevel | null {
  const match = LEVEL_LINE.exec(line);
  return match === null ? null : (match[1] as ServerLogLevel);
}

function signatureIn(line: string): { signature: string; category: ServerFaultCategory } | null {
  for (const entry of FATAL_SIGNATURES) {
    if (line.includes(entry.signature)) return entry;
  }
  return null;
}

export interface ServerLogScanner {
  /**
   * Empuja un trozo de stderr. Devuelve el fallo la **primera** vez que lo reconoce y `null`
   * después: una traza de MEF ocupa veinte líneas y no hace falta avisar veinte veces.
   */
  push(chunk: string): ServerFault | null;
  /** Procesa lo que quede sin salto de línea final (el proceso ha terminado). */
  flush(): ServerFault | null;
  /** El fallo reconocido, si hubo alguno. */
  fault(): ServerFault | null;
}

/**
 * Escáner con búfer de líneas.
 *
 * El búfer no es un adorno: los trozos de un stream **no respetan los límites de línea**, y una
 * lectura puede cortar `PartDiscoveryEx` / `ception: …` por la mitad. Sin búfer el fallo se
 * detecta de forma intermitente, que es la peor forma de no detectarlo.
 */
export function createServerLogScanner(): ServerLogScanner {
  let buffer = '';
  let level: ServerLogLevel | null = null;
  let found: ServerFault | null = null;

  const consume = (line: string): void => {
    if (found !== null) return;

    const declared = logLevelOf(line);
    if (declared !== null) level = declared;

    const hit = signatureIn(line);
    if (hit === null) return;

    // Un nombre de excepción sólo cuenta dentro de un bloque `fail:`/`crit:`, o en un volcado
    // sin registro previo (el runtime muriéndose antes de que nadie configurase el logger).
    const unlogged = level === null && EXCEPTION_HEADER.test(line.trimStart());
    if (!isFatalLevel(level) && !unlogged) return;

    found = { category: hit.category, signature: hit.signature, detail: line.trim().slice(0, 500) };
  };

  const drain = (): ServerFault | null => {
    const before = found;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      consume(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    return before === null ? found : null;
  };

  return {
    push(chunk: string): ServerFault | null {
      buffer += chunk;
      return drain();
    },
    flush(): ServerFault | null {
      const before = found;
      if (buffer !== '') {
        consume(buffer.replace(/\r$/, ''));
        buffer = '';
      }
      return before === null ? found : null;
    },
    fault(): ServerFault | null {
      return found;
    },
  };
}

/** Frase para el usuario. Dice qué pasó y qué se ha hecho, sin pedirle que abra una consola. */
export function describeFault(fault: ServerFault, serverName: string): string {
  switch (fault.category) {
    case 'mef':
      return `${serverName} no ha podido componer sus extensiones (${fault.signature})`;
    case 'assembly':
      return `${serverName} no ha podido cargar uno de sus ensamblados (${fault.signature})`;
    case 'crash':
      return `${serverName} ha fallado al inicializarse (${fault.signature})`;
  }
}

// ---------------------------------------------------------------------------------------------
// Cuarentena
// ---------------------------------------------------------------------------------------------

/**
 * Una versión que se probó en **esta** máquina y no arrancó.
 *
 * Se guarda por RID: que una compilación esté rota para `win-x64` no dice nada de `osx-arm64`, y
 * el mismo archivo viaja si el usuario sincroniza su perfil.
 */
export interface QuarantineEntry {
  version: string;
  rid: string;
  reason: string;
  atUtc: string;
  /**
   * Versión de DotForge que dictó el veto.
   *
   * Sin esto, una cuarentena es **para siempre**, y la historia de este proyecto dice que eso está
   * mal: de los fallos de arranque de Roslyn documentados, dos han resultado ser bugs del cliente y
   * no de la compilación —contestar `null` a `workspace/configuration` (ADR-043) y mandar
   * `shutdown` con `params: null` (ADR-063)—. Un veto dictado por una versión del IDE que ya no
   * existe es un juicio sobre código que ya no se ejecuta.
   *
   * Opcional porque los archivos escritos antes de la v2.6.0 no lo llevan; sin él, la entrada se
   * considera de otra versión y se reintenta, que es justo lo que hay que hacer con ella.
   */
  ideVersion?: string;
}

export interface QuarantineRecord {
  version: 1;
  entries: QuarantineEntry[];
}

/** Tope de entradas. Es una lista de fallos, no un historial: lo viejo deja de importar. */
export const MAX_QUARANTINE_ENTRIES = 50;

export const EMPTY_QUARANTINE: QuarantineRecord = { version: 1, entries: [] };

function isEntry(value: unknown): value is QuarantineEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['version'] === 'string' &&
    record['version'] !== '' &&
    typeof record['rid'] === 'string' &&
    typeof record['reason'] === 'string' &&
    typeof record['atUtc'] === 'string' &&
    (record['ideVersion'] === undefined || typeof record['ideVersion'] === 'string')
  );
}

/** Lee el archivo de cuarentena. Un archivo ilegible es una lista vacía, nunca una excepción. */
export function parseQuarantine(text: string): QuarantineRecord {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, entries: [] };
    const entries = (parsed as Record<string, unknown>)['entries'];
    if (!Array.isArray(entries)) return { version: 1, entries: [] };
    return { version: 1, entries: entries.filter(isEntry).slice(0, MAX_QUARANTINE_ENTRIES) };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function serializeQuarantine(record: QuarantineRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Las versiones vetadas para un RID concreto **en esta versión de DotForge**.
 *
 * Un veto caduca al actualizar el IDE, y esa es la parte importante (ADR-063): la cuarentena dice
 * "esta compilación no arrancó **con este cliente**", y cuando el cliente cambia esa afirmación deja
 * de estar comprobada. Se reintenta una vez; si vuelve a fallar, se vuelve a vetar con la versión
 * nueva y esta vez el juicio sí es sobre el código que corre.
 *
 * Sin `ideVersion` no se filtra nada: quien no la pase se lleva la lista entera, que es el
 * comportamiento de antes y el que quieren las herramientas que sólo listan lo que hay.
 */
export function quarantinedVersions(record: QuarantineRecord, rid: string, ideVersion?: string): string[] {
  return record.entries
    .filter((entry) => entry.rid === rid)
    .filter((entry) => ideVersion === undefined || entry.ideVersion === ideVersion)
    .map((entry) => entry.version);
}

/** Vetos que dictó otra versión del IDE: siguen escritos, pero ya no bloquean nada. */
export function staleQuarantineEntries(record: QuarantineRecord, rid: string, ideVersion: string): QuarantineEntry[] {
  return record.entries.filter((entry) => entry.rid === rid && entry.ideVersion !== ideVersion);
}

/** Añade una entrada sin duplicar y dejando la más reciente delante. */
export function addQuarantineEntry(record: QuarantineRecord, entry: QuarantineEntry): QuarantineRecord {
  const rest = record.entries.filter((item) => !(item.version === entry.version && item.rid === entry.rid));
  return { version: 1, entries: [entry, ...rest].slice(0, MAX_QUARANTINE_ENTRIES) };
}

/** Saca una versión de la cuarentena (su instalación estaba corrupta y se ha reparado). */
export function removeQuarantineEntry(record: QuarantineRecord, version: string, rid: string): QuarantineRecord {
  return { version: 1, entries: record.entries.filter((item) => !(item.version === version && item.rid === rid)) };
}
