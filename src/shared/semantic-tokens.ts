/**
 * Tokens semánticos: de la clasificación de Roslyn al color del editor.
 *
 * La gramática Monarch de C# sabe lo que puede saber mirando texto: esto es una palabra clave,
 * esto una cadena, esto un número. Lo que **no** puede saber es si `Product` es una clase, una
 * interfaz o una variable, ni si `Create` es un método o una propiedad — eso exige haber compilado
 * el archivo. Roslyn sí lo sabe, y lo publica por `textDocument/semanticTokens/full`.
 *
 * Este módulo es la traducción entre los dos mundos, y es **puro** a propósito: el formato de LSP
 * es un array de enteros con codificación relativa —cinco por token, cada uno respecto al
 * anterior— y equivocarse en un desplazamiento tiñe el archivo entero a partir de ese punto sin
 * ningún error. Eso se prueba con datos, no a ojo.
 *
 * Tres piezas:
 *
 *  1. **La leyenda del cliente** (`CLIENT_TOKEN_TYPES`): lo que DotForge anuncia en sus
 *     capacidades. Sin ella el servidor no manda nada: una lista vacía significa "no entiendo
 *     ningún tipo de token", no "mándamelos todos".
 *  2. **La normalización de nombres**: el servidor responde con **su** leyenda, y la de Roslyn no
 *     es la estándar. Ahí conviven `class`, `class name`, `keyword - control` y
 *     `xml doc comment - text`. Se normalizan por forma (minúsculas, sin separadores, sin el
 *     sufijo `name`) y se mapean a un conjunto pequeño de ámbitos con significado visual.
 *  3. **El reempaquetado para Monaco**, que usa la misma codificación relativa pero con la leyenda
 *     que le hayamos dado nosotros.
 *
 * Monaco resuelve el color de un token semántico uniendo el tipo y sus modificadores con puntos
 * (`method.static`) y buscando la regla más específica del tema. Por eso los ámbitos de aquí son
 * exactamente los nombres de las reglas de `monaco-setup.ts`, y no hay ninguna tabla intermedia.
 */

/**
 * Tipos de token que el cliente declara entender.
 *
 * Es la lista estándar de LSP. Roslyn añade los suyos y los publica en su propia leyenda; se
 * traducen al vuelo en `scopeForTokenType`, así que no hace falta declararlos aquí.
 */
export const CLIENT_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
] as const;

/** Modificadores estándar de LSP. No cambian el color, pero sí pueden cambiar el estilo. */
export const CLIENT_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
] as const;

/**
 * Ámbitos que el tema sabe colorear.
 *
 * Es deliberadamente corto: un desarrollador distingue de un vistazo seis o siete familias
 * (tipos, interfaces, métodos, miembros, variables, palabras clave, literales). Veinte colores no
 * son más información, son ruido.
 */
export const SEMANTIC_SCOPES = [
  'comment',
  'comment.doc',
  'keyword',
  'keyword.control',
  'string',
  'string.escape',
  'number',
  'regexp',
  'operator',
  'namespace',
  'type',
  'type.parameter',
  'interface',
  'method',
  'property',
  'field',
  'constant',
  'enum.member',
  'event',
  'variable',
  'parameter',
  'label',
] as const;

export type SemanticScope = (typeof SEMANTIC_SCOPES)[number];

/** Leyenda tal y como la publica el servidor en su respuesta a `initialize`. */
export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

/** Un token ya resuelto a coordenadas absolutas, en base 0 como en LSP. */
export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  /** Nombre del tipo tal y como lo mandó el servidor, sin normalizar. */
  type: string;
  modifiers: string[];
}

/**
 * Nombre de tipo del servidor -> ámbito del tema.
 *
 * Las claves están ya normalizadas (minúsculas, sin espacios ni guiones, sin el sufijo `name`),
 * que es como las deja `normalizeTokenType`.
 */
const SCOPE_BY_TYPE: Record<string, SemanticScope> = {
  // Tipos: clases, estructuras, enumeraciones, delegados y registros comparten color. Es lo que
  // hace que `WebApplication`, `Serilog` y `AppDbContext` se lean como la misma familia.
  type: 'type',
  class: 'type',
  struct: 'type',
  enum: 'type',
  delegate: 'type',
  record: 'type',
  recordclass: 'type',
  recordstruct: 'type',
  module: 'type',
  typeparameter: 'type.parameter',

  interface: 'interface',

  // Invocaciones y declaraciones de método, incluidos los de extensión y los constructores
  // locales que Roslyn clasifica como funciones.
  method: 'method',
  extensionmethod: 'method',
  function: 'method',

  property: 'property',
  field: 'field',
  constant: 'constant',
  enummember: 'enum.member',
  event: 'event',

  variable: 'variable',
  local: 'variable',
  parameter: 'parameter',
  label: 'label',

  keyword: 'keyword',
  plainkeyword: 'keyword',
  modifier: 'keyword',
  preprocessorkeyword: 'keyword',
  macro: 'keyword',
  keywordcontrol: 'keyword.control',
  controlkeyword: 'keyword.control',

  string: 'string',
  stringverbatim: 'string',
  verbatimstring: 'string',
  preprocessortext: 'string',
  stringescapecharacter: 'string.escape',

  number: 'number',
  operator: 'operator',
  operatoroverloaded: 'operator',
  namespace: 'namespace',
  comment: 'comment',
  regexp: 'regexp',
};

/**
 * Deja el nombre de un tipo en su forma canónica.
 *
 * Roslyn manda `class name`, `keyword - control` y `xml doc comment - attribute name` en la misma
 * leyenda que los nombres estándar de LSP. Compararlos tal cual obligaría a enumerar cada
 * variante; normalizar por forma cubre también las que aún no existen.
 */
export function normalizeTokenType(raw: string): string {
  const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
  return compact.endsWith('name') && compact.length > 4 ? compact.slice(0, -4) : compact;
}

/**
 * Ámbito del tema para un tipo de token, o null si no se colorea.
 *
 * Devolver null es una decisión, no una carencia: un token sin ámbito **conserva el color que le
 * dio la gramática Monarch**. Eso mantiene el archivo legible mientras el servidor arranca y evita
 * que una clasificación exótica de Roslyn (código excluido, espacios en blanco, puntuación) apague
 * un trozo del editor.
 */
export function scopeForTokenType(raw: string): SemanticScope | null {
  const name = normalizeTokenType(raw);

  // Familias con prefijo: la documentación XML y los literales de expresión regular o JSON traen
  // media docena de variantes cada una y todas quieren el mismo color.
  if (name.startsWith('xmldoccomment') || name.startsWith('xmlliteral')) return 'comment.doc';
  if (name.startsWith('regex')) return 'regexp';
  if (name.startsWith('json')) return 'string';

  return SCOPE_BY_TYPE[name] ?? null;
}

/**
 * Descodifica el array de LSP a tokens absolutos.
 *
 * El formato son quintetos `[deltaLínea, deltaColumna, longitud, tipo, modificadores]`, cada uno
 * relativo al token anterior — y la columna es relativa **sólo si el token está en la misma
 * línea**. Un array de longitud no múltiplo de cinco está corrupto: se ignora la cola en vez de
 * inventar un token a medias.
 */
export function decodeTokens(data: readonly number[], legend: SemanticTokensLegend): SemanticToken[] {
  const tokens: SemanticToken[] = [];

  let line = 0;
  let character = 0;

  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]!;
    const deltaStart = data[i + 1]!;
    const length = data[i + 2]!;
    const typeIndex = data[i + 3]!;
    const modifierBits = data[i + 4]!;

    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;

    const type = legend.tokenTypes[typeIndex];
    if (type === undefined || length <= 0) continue;

    const modifiers: string[] = [];
    for (let bit = 0; bit < legend.tokenModifiers.length; bit++) {
      if ((modifierBits & (1 << bit)) !== 0) modifiers.push(legend.tokenModifiers[bit]!);
    }

    tokens.push({ line, character, length, type, modifiers });
  }

  return tokens;
}

/**
 * Vuelve a empaquetar tokens absolutos en la codificación relativa que espera Monaco.
 *
 * Los tokens tienen que ir ordenados por posición: es un invariante del formato, no una
 * preferencia. Se ordenan aquí para no depender de que el servidor lo haya hecho.
 */
export function encodeTokens(tokens: readonly SemanticToken[], scopes: readonly string[]): number[] {
  const index = new Map<string, number>();
  scopes.forEach((scope, position) => index.set(scope, position));

  const sorted = [...tokens].sort((a, b) => (a.line === b.line ? a.character - b.character : a.line - b.line));

  const data: number[] = [];
  let lastLine = 0;
  let lastCharacter = 0;

  for (const token of sorted) {
    const scope = scopeForTokenType(token.type);
    if (scope === null) continue;

    const typeIndex = index.get(scope);
    if (typeIndex === undefined) continue;

    const deltaLine = token.line - lastLine;
    const deltaStart = deltaLine === 0 ? token.character - lastCharacter : token.character;

    data.push(deltaLine, deltaStart, token.length, typeIndex, 0);

    lastLine = token.line;
    lastCharacter = token.character;
  }

  return data;
}

/**
 * Camino completo: datos del servidor -> datos para Monaco.
 *
 * Es la función que usa el proveedor del renderer. Se expone entera porque el paso intermedio
 * (los tokens absolutos) sólo interesa a las pruebas.
 */
export function remapTokens(
  data: readonly number[],
  serverLegend: SemanticTokensLegend,
  scopes: readonly string[] = SEMANTIC_SCOPES,
): number[] {
  return encodeTokens(decodeTokens(data, serverLegend), scopes);
}

/**
 * Extrae la leyenda de las capacidades que devolvió el servidor.
 *
 * Un servidor sin tokens semánticos —o uno que los anuncia sin leyenda, que sería un servidor
 * roto— devuelve null, y el renderer simplemente no registra el proveedor.
 */
export function legendFromCapabilities(capabilities: unknown): SemanticTokensLegend | null {
  if (typeof capabilities !== 'object' || capabilities === null) return null;

  const provider = (capabilities as Record<string, unknown>)['semanticTokensProvider'];
  if (typeof provider !== 'object' || provider === null) return null;

  const legend = (provider as Record<string, unknown>)['legend'];
  if (typeof legend !== 'object' || legend === null) return null;

  const { tokenTypes, tokenModifiers } = legend as Record<string, unknown>;
  if (!Array.isArray(tokenTypes) || tokenTypes.length === 0) return null;

  return {
    tokenTypes: tokenTypes.filter((entry): entry is string => typeof entry === 'string'),
    tokenModifiers: Array.isArray(tokenModifiers)
      ? tokenModifiers.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}
