/**
 * Presentación de rutas del sistema de archivos.
 *
 * Una ruta absoluta nunca cabe en el ancho que le toca en la interfaz, y el recorte automático
 * del navegador corta por el final, que es justo la parte que identifica la carpeta. Aquí se
 * decide qué trozo se enseña; la ruta completa sigue estando en el tooltip.
 */

/**
 * Ubicación legible de un workspace: las dos últimas carpetas que lo contienen.
 *
 * Dos soluciones con el mismo nombre en carpetas distintas se distinguen por el final de la ruta:
 * `C:\Users\...\Te…` no dice nada, `…\scratchpad\final` sí.
 */
export function containerOf(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/';
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const from = Math.max(0, segments.length - 3);
  const container = segments.slice(from, segments.length - 1);
  if (container.length === 0) return path;

  const text = container.join(separator);
  return from === 0 ? text : `…${separator}${text}`;
}
