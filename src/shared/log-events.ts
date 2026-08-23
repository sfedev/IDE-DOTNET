/**
 * Modelo del visor de logs estructurados.
 *
 * Convierte la salida cruda de una aplicación .NET en eventos con nivel, categoría, mensaje y
 * traza de excepción, de modo que el panel pueda filtrar por nivel y ofrecer un salto al archivo
 * exacto donde se lanzó la excepción.
 *
 * Se reconocen los cuatro formatos que salen de una solución .NET real sin configurar nada:
 *
 *  1. **Serilog con la plantilla por defecto** — `[12:34:56 INF] Mensaje`.
 *  2. **Serilog con marca de tiempo completa** — `2026-08-23 12:34:56.789 +02:00 [ERR] Mensaje`.
 *  3. **`Microsoft.Extensions.Logging` por consola** — dos líneas: `info: Categoría[14]` y el
 *     mensaje indentado debajo. Es el formato del `dotnet run` de cualquier plantilla.
 *  4. **NLog con su layout habitual** — `2026-08-23 12:34:56.7890|ERROR|Categoría|Mensaje`.
 *  5. **JSON por línea (CLEF)** — `{"@t":"…","@l":"Error","@m":"…","@x":"…"}`, que es lo que
 *     escribe `Serilog.Formatting.Compact`.
 *
 * Tres reglas que gobiernan el archivo:
 *
 * - **Nada que no encaje se pierde.** Una línea que no casa con ningún formato sigue siendo un
 *   evento, con nivel `information`: un visor que se come la mitad de la salida es peor que no
 *   tener visor.
 * - **Las trazas se pegan al evento que las provocó**, no se listan sueltas: una excepción son
 *   veinte líneas que sólo tienen sentido juntas.
 * - **Ni "at" ni "en".** El marcador de un marco de pila está traducido al idioma del sistema, así
 *   que el marco se reconoce por su forma (`… in <ruta>:line <n>`), no por la palabra inicial.
 *
 * Todo es función pura: entra texto, sale modelo.
 */

// ---------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'information' | 'warning' | 'error' | 'critical';

/** Orden de severidad, para el filtro "de este nivel hacia arriba". */
export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'information', 'warning', 'error', 'critical'];

export interface StackFrame {
  /** Método tal cual aparece en la traza. */
  method: string;
  /** Ruta del archivo fuente, si la traza la lleva (compilado con símbolos). */
  file: string | null;
  line: number;
  /** Línea original, para poder pintarla tal cual. */
  raw: string;
}

export interface LogEvent {
  level: LogLevel;
  /** Marca de tiempo tal cual venía, sin normalizar a una zona horaria. */
  timestamp: string | null;
  /** Categoría o logger de origen (`Microsoft.Hosting.Lifetime`). */
  category: string | null;
  message: string;
  /** Líneas de la excepción, ya separadas de las de la traza. */
  exception: string[];
  frames: StackFrame[];
  /** Índice de la primera línea del evento dentro del canal, para poder anclar la selección. */
  index: number;
}

export const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: 'Traza',
  debug: 'Depuración',
  information: 'Información',
  warning: 'Aviso',
  error: 'Error',
  critical: 'Crítico',
};

/** Abreviaturas de nivel de los formatos habituales, en minúsculas. */
const LEVEL_BY_TOKEN: Record<string, LogLevel> = {
  vrb: 'trace', verbose: 'trace', trace: 'trace', trc: 'trace',
  dbg: 'debug', debug: 'debug',
  inf: 'information', info: 'information', information: 'information',
  wrn: 'warning', warn: 'warning', warning: 'warning',
  err: 'error', error: 'error', fail: 'error',
  ftl: 'critical', fatal: 'critical', crit: 'critical', critical: 'critical',
};

/** Nivel a partir de cualquiera de sus nombres. `null` si el token no es un nivel. */
export function toLevel(token: string): LogLevel | null {
  return LEVEL_BY_TOKEN[token.trim().toLowerCase()] ?? null;
}

export function isAtLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}

// ---------------------------------------------------------------------------------------------
// Marcos de pila
// ---------------------------------------------------------------------------------------------

/**
 * Marco de una traza de .NET.
 *
 * El formato es `   at Espacio.Tipo.Método(args) in C:\ruta\Archivo.cs:line 42`, y tanto `at` como
 * `in` y `line` se traducen: en español salen `en` … `en` … `línea`. Por eso se busca la **forma**
 * —una ruta que acaba en una extensión de código y un número al final— y no las palabras.
 */
export function parseStackFrame(line: string, index = 0): StackFrame | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  // Una traza siempre viene indentada y empieza por la palabra de "at" en el idioma del sistema.
  if (!/^\s{2,}\S/.test(line) && !/^\s*(?:at|en)\s/i.test(line)) return null;

  // El ancla es el **último paréntesis** de la firma del método: lo que va detrás es siempre
  // `<palabra traducida> <ruta>:<palabra traducida> <número>`. Buscarlo así evita dos trampas: la
  // palabra "in"/"en" cambia con el idioma, y una ruta de Windows lleva sus propios dos puntos
  // (`C:\`), que un patrón menos anclado confunde con el separador de la línea.
  const located = new RegExp(
    String.raw`^(.*\))\s+\S+\s+(.+?\.(?:cs|razor|cshtml|vb|fs)):\S+\s+(\d+)\s*$`,
    'i',
  ).exec(trimmed);

  if (located) {
    return {
      method: located[1]!.replace(/^(?:at|en)\s+/i, '').trim(),
      file: located[2]!.trim(),
      line: Number(located[3]),
      raw: trimmed,
    };
  }

  // Marco sin símbolos: se conserva igualmente, pero no se puede navegar a él.
  if (/^(?:at|en)\s+\S+\(/i.test(trimmed) || /^\s{3,}\S+\.\S+\(/.test(line)) {
    return { method: trimmed.replace(/^(?:at|en)\s+/i, ''), file: null, line: 0, raw: trimmed };
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Cabeceras de evento
// ---------------------------------------------------------------------------------------------

interface Header {
  level: LogLevel;
  timestamp: string | null;
  category: string | null;
  message: string;
  /** true si el mensaje llega en la línea siguiente, indentado (formato de la consola de MEL). */
  messageOnNextLine: boolean;
}

/** `[12:34:56 INF] Mensaje` y `2026-08-23 12:34:56.789 +02:00 [ERR] Mensaje`. */
const SERILOG = new RegExp(String.raw`^(?:(.*?)\s+)?\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+)?([A-Za-z]{3,11})\]\s?(.*)$`);

/** `2026-08-23 12:34:56.7890|ERROR|Acme.Shop.Api|Mensaje`. */
const NLOG = new RegExp(String.raw`^([\d\-\/: .+]+)\|([A-Za-z]+)\|([^|]*)\|(.*)$`);

/** `info: Microsoft.Hosting.Lifetime[14]`, con el mensaje indentado en la línea siguiente. */
const MEL = new RegExp(String.raw`^(trce|dbug|info|warn|fail|crit)\s*:\s*([^\[]+)\[(\d+)\]\s*$`, 'i');

function parseHeader(line: string): Header | null {
  const clef = parseClef(line);
  if (clef) return clef;

  const mel = MEL.exec(line.trim());
  if (mel) {
    return {
      level: toLevel(mel[1]!) ?? 'information',
      timestamp: null,
      category: mel[2]!.trim(),
      message: '',
      messageOnNextLine: true,
    };
  }

  const nlog = NLOG.exec(line);
  if (nlog) {
    const level = toLevel(nlog[2]!);
    if (level) {
      return {
        level,
        timestamp: nlog[1]!.trim(),
        category: nlog[3]!.trim() === '' ? null : nlog[3]!.trim(),
        message: nlog[4]!.trim(),
        messageOnNextLine: false,
      };
    }
  }

  const serilog = SERILOG.exec(line);
  if (serilog) {
    const level = toLevel(serilog[3]!);
    if (level) {
      const prefix = (serilog[1] ?? '').trim();
      const inner = (serilog[2] ?? '').trim();
      const timestamp = [prefix, inner].filter((part) => part !== '').join(' ');

      return {
        level,
        timestamp: timestamp === '' ? null : timestamp,
        category: null,
        message: serilog[4]!.trim(),
        messageOnNextLine: false,
      };
    }
  }

  return null;
}

/** Evento en JSON por línea, tal como lo escribe `Serilog.Formatting.Compact`. */
function parseClef(line: string): Header | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = parsed as Record<string, unknown>;

  const message = event['@m'] ?? event['@mt'] ?? event['message'] ?? event['Message'];
  if (typeof message !== 'string') return null;

  const rawLevel = event['@l'] ?? event['level'] ?? event['Level'];
  const timestamp = event['@t'] ?? event['timestamp'] ?? event['Timestamp'];
  const category = event['SourceContext'] ?? event['category'];

  return {
    // CLEF omite el nivel cuando es Information: la ausencia significa eso, no "desconocido".
    level: typeof rawLevel === 'string' ? (toLevel(rawLevel) ?? 'information') : 'information',
    timestamp: typeof timestamp === 'string' ? timestamp : null,
    category: typeof category === 'string' ? category : null,
    message,
    messageOnNextLine: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Parseo del flujo
// ---------------------------------------------------------------------------------------------

/**
 * Convierte un bloque de salida en eventos.
 *
 * Cada línea que no abre un evento nuevo se acumula en el que esté abierto: así una excepción con
 * su traza queda pegada al mensaje que la anunció, que es como se lee.
 */
export function parseLogEvents(text: string, startIndex = 0): LogEvent[] {
  const events: LogEvent[] = [];
  const lines = text.split(/\r?\n/);

  let current: LogEvent | null = null;
  let pendingMessage = false;

  const push = (event: LogEvent): void => {
    events.push(event);
    current = event;
  };

  lines.forEach((line, offset) => {
    if (line.trim() === '') {
      pendingMessage = false;
      return;
    }

    const header = parseHeader(line);

    if (header) {
      push({
        level: header.level,
        timestamp: header.timestamp,
        category: header.category,
        message: header.message,
        exception: [],
        frames: [],
        index: startIndex + offset,
      });
      pendingMessage = header.messageOnNextLine;
      return;
    }

    // Segunda línea del formato de la consola de .NET: el mensaje va indentado bajo la cabecera.
    if (pendingMessage && current !== null && current.message === '') {
      current.message = line.trim();
      pendingMessage = false;
      return;
    }

    const frame = parseStackFrame(line, offset);

    if (frame && current !== null) {
      current.frames.push(frame);
      return;
    }

    if (current !== null && (frame !== null || /^\s/.test(line) || isExceptionLine(line))) {
      current.exception.push(line.trimEnd());
      return;
    }

    // Línea suelta sin formato reconocible: sigue siendo información que alguien quiere leer.
    push({
      level: 'information',
      timestamp: null,
      category: null,
      message: line.trim(),
      exception: [],
      frames: [],
      index: startIndex + offset,
    });
    pendingMessage = false;
  });

  return events;
}

/**
 * Primera línea de una excepción: `System.InvalidOperationException: mensaje`.
 *
 * Se reconoce por la forma —un nombre con puntos que acaba en `Exception` seguido de dos puntos—,
 * no por una lista de excepciones conocidas.
 */
export function isExceptionLine(line: string): boolean {
  return /^\s*(?:--->\s*)?[A-Za-z_][\w.`+]*Exception(?:`\d+)?\s*:/.test(line);
}

/** Cuenta de eventos por nivel, para las pastillas del filtro. */
export function countByLevel(events: readonly LogEvent[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = {
    trace: 0, debug: 0, information: 0, warning: 0, error: 0, critical: 0,
  };

  for (const event of events) counts[event.level]++;
  return counts;
}

/** Filtra por nivel mínimo y por texto libre, que es como se busca de verdad en un log. */
export function filterEvents(
  events: readonly LogEvent[],
  options: { minimum?: LogLevel; query?: string; levels?: readonly LogLevel[] } = {},
): LogEvent[] {
  const query = (options.query ?? '').trim().toLowerCase();
  const allowed = options.levels;

  return events.filter((event) => {
    if (allowed !== undefined && !allowed.includes(event.level)) return false;
    if (options.minimum !== undefined && !isAtLeast(event.level, options.minimum)) return false;
    if (query === '') return true;

    return (
      event.message.toLowerCase().includes(query) ||
      (event.category ?? '').toLowerCase().includes(query) ||
      event.exception.some((entry) => entry.toLowerCase().includes(query))
    );
  });
}

/** Primer marco con archivo conocido: es el que abre el editor al pulsar en la excepción. */
export function firstNavigableFrame(event: LogEvent): StackFrame | null {
  return event.frames.find((frame) => frame.file !== null && frame.line > 0) ?? null;
}
