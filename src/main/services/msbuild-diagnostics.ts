/**
 * Parseo de la salida de MSBuild a diagnósticos estructurados.
 *
 * MSBuild emite el formato canónico:
 *   ruta(línea,columna): error CS1002: mensaje [ruta\del\proyecto.csproj]
 *   ruta(línea): warning MSB3277: mensaje
 *   error NETSDK1045: mensaje            (sin archivo)
 *
 * El objetivo es que cada error del compilador sea clicable en la UI, no una línea de texto
 * más en un panel de salida.
 */
import type { BuildDiagnostic, DiagnosticSeverity } from '../../shared/contracts.js';

/**
 * Grupos:
 *  1 archivo (opcional)  2 línea  3 columna  4 severidad  5 código  6 mensaje  7 proyecto
 *
 * `dotnet build` traduce "error"/"warning" según el idioma del SDK, así que se aceptan también
 * las formas en español para que el panel de problemas funcione con la CLI localizada.
 */
const DIAGNOSTIC_LINE =
  /^(?:(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*)?(error|warning|advertencia|aviso)\s+([A-Za-z]+[0-9]+)\s*:\s*(.+?)(?:\s+\[([^\]]+)\])?\s*$/i;

function toSeverity(raw: string): DiagnosticSeverity {
  const normalized = raw.toLowerCase();
  if (normalized === 'error') return 'error';
  if (normalized === 'warning' || normalized === 'advertencia' || normalized === 'aviso') return 'warning';
  return 'info';
}

/** Extrae los diagnósticos de un volcado de salida de MSBuild, sin duplicados. */
export function parseMsBuildDiagnostics(output: string): BuildDiagnostic[] {
  const found = new Map<string, BuildDiagnostic>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    const match = DIAGNOSTIC_LINE.exec(line);
    if (!match) continue;

    const [, file, lineNumber, column, severity, code, message, project] = match;

    const diagnostic: BuildDiagnostic = {
      file: file ?? null,
      line: lineNumber ? Number.parseInt(lineNumber, 10) : 0,
      column: column ? Number.parseInt(column, 10) : 0,
      severity: toSeverity(severity!),
      code: code!,
      message: message!.trim(),
      project: project ?? null,
    };

    // MSBuild repite el mismo diagnóstico una vez por target-framework y otra en el resumen.
    const key = `${diagnostic.file}|${diagnostic.line}|${diagnostic.column}|${diagnostic.code}|${diagnostic.message}`;
    if (!found.has(key)) found.set(key, diagnostic);
  }

  return [...found.values()];
}

/**
 * Detecta la URL en la que ha quedado escuchando la aplicación.
 * Sirve para ofrecer "abrir en el navegador" tras `dotnet run` o `dotnet watch`.
 */
export function detectApplicationUrl(output: string): string | null {
  const patterns = [
    /Now listening on:\s*(https?:\/\/\S+)/i,
    /Escuchando en:\s*(https?:\/\/\S+)/i,
    /Application started.*?(https?:\/\/localhost:\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match?.[1]) return match[1].replace(/[.,]$/, '');
  }

  return null;
}

/** Resumen legible para la barra de estado. */
export function summarize(diagnostics: BuildDiagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors++;
    else if (diagnostic.severity === 'warning') warnings++;
  }
  return { errors, warnings };
}
