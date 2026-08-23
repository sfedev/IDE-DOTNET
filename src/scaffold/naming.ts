/**
 * Utilidades de nombres para el generador: validación de identificadores .NET, pluralización
 * inglesa suficiente para nombres de DbSet/rutas REST y GUIDs deterministas para el .sln.
 */
import { createHash } from 'node:crypto';

/** Palabras reservadas de C# que no pueden usarse como nombre de entidad. */
const CSHARP_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class',
  'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event',
  'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if',
  'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new',
  'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public',
  'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static',
  'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong',
  'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);

/** Nombres de archivo/dispositivo reservados en Windows. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export class NamingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NamingError';
  }
}

/**
 * Valida el nombre de solución. Admite segmentos separados por punto (`Acme.Shop.Api`),
 * cada uno un identificador C# válido.
 */
export function validateSolutionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new NamingError('el nombre de la solución no puede estar vacío');
  if (trimmed.length > 100) {
    throw new NamingError('el nombre de la solución no puede superar 100 caracteres');
  }
  const segments = trimmed.split('.');
  for (const segment of segments) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      throw new NamingError(
        `segmento inválido "${segment}" en "${trimmed}": cada segmento debe empezar por letra o _ y contener sólo letras, dígitos o _`,
      );
    }
    if (CSHARP_KEYWORDS.has(segment.toLowerCase())) {
      throw new NamingError(`"${segment}" es una palabra reservada de C#`);
    }
    if (WINDOWS_RESERVED.has(segment.toLowerCase())) {
      throw new NamingError(`"${segment}" es un nombre reservado en Windows`);
    }
  }
  return trimmed;
}

/** Valida el nombre de la entidad de ejemplo y lo normaliza a PascalCase. */
export function validateEntityName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new NamingError('el nombre de la entidad no puede estar vacío');
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(trimmed)) {
    throw new NamingError(
      `entidad inválida "${trimmed}": sólo letras y dígitos, empezando por letra`,
    );
  }
  if (CSHARP_KEYWORDS.has(trimmed.toLowerCase())) {
    throw new NamingError(`"${trimmed}" es una palabra reservada de C#`);
  }
  return toPascalCase(trimmed);
}

export function toPascalCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function toCamelCase(value: string): string {
  if (!value) return value;
  // Respeta acrónimos iniciales: "URLBuilder" -> "urlBuilder", "API" -> "api".
  // El lookahead ya excluye del acrónimo la mayúscula que abre la siguiente palabra
  // (la "B" de "URLBuilder"), así que se minusculiza el run completo.
  const upperRun = /^[A-Z]+(?![a-z])/.exec(value);
  if (upperRun && upperRun[0].length > 1) {
    const run = upperRun[0];
    return run.toLowerCase() + value.slice(run.length);
  }
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/** Convierte a kebab-case para rutas REST y nombres de archivo. */
export function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  tooth: 'teeth',
  foot: 'feet',
  mouse: 'mice',
  goose: 'geese',
};

const UNCHANGED_PLURALS = new Set(['equipment', 'information', 'series', 'species', 'data', 'staff']);

/**
 * Pluralización inglesa. No pretende ser lingüísticamente completa: cubre las reglas que
 * afectan a nombres de DbSet, rutas REST y colecciones en el código generado.
 */
export function pluralize(word: string): string {
  if (!word) return word;
  const lower = word.toLowerCase();

  if (UNCHANGED_PLURALS.has(lower)) return word;

  const irregular = IRREGULAR_PLURALS[lower];
  if (irregular) return matchCase(word, irregular);

  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^f]fe$/i.test(word)) return `${word.slice(0, -2)}ves`;
  if (/[^f]f$/i.test(word)) return `${word.slice(0, -1)}ves`;
  return `${word}s`;
}

function matchCase(source: string, replacement: string): string {
  return /^[A-Z]/.test(source) ? toPascalCase(replacement) : replacement;
}

/**
 * GUID determinista a partir de una semilla. Reproducible: la misma solución generada dos veces
 * produce el mismo .sln, lo que hace los diffs y los tests estables.
 */
export function deterministicGuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  const hex = hash.slice(0, 32);
  // Fija la versión (4) y la variante (RFC 4122) para que sea un UUID bien formado.
  const versioned = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 32)}`;
  return [
    versioned.slice(0, 8),
    versioned.slice(8, 12),
    versioned.slice(12, 16),
    versioned.slice(16, 20),
    versioned.slice(20, 32),
  ]
    .join('-')
    .toUpperCase();
}
