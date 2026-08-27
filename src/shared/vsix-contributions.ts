/**
 * Contribuciones declarativas de una extensión instalada: temas de color y fragmentos de código.
 *
 * Esto es la deuda del ADR-048 que aquí se paga. Hasta ahora el IDE instalaba el `.vsix`, leía su
 * manifiesto y decía en la ficha qué aportaba… y no consumía nada, ni siquiera lo que declaraba
 * como "sirve aquí". La lista de contribuciones soportadas era una promesa, no un hecho.
 *
 * Este módulo es puro: convierte texto en datos y datos en la forma que espera Monaco. Quien lee el
 * disco es `extension-contributions.ts`, que además traduce un `.tmTheme` (que es XML) al mismo
 * documento de tema que se maneja aquí. El reparto es el de siempre en este repositorio: lo que
 * decide, puro y probado; lo que ejecuta, delgado.
 *
 * Tres cosas que parecen detalles y son la diferencia entre funcionar y no:
 *
 *  - **Monaco rechaza los colores que VS Code acepta.** `defineTheme` **lanza** ante un color que
 *    no sea `#rrggbb` en `colors`, y en las reglas quiere el color **sin** almohadilla. Los temas
 *    reales usan `#rrggbbaa` a manos llenas (todo lo translúcido: selecciones, resaltados, bordes)
 *    y también `#abc`. Sin normalizar, el primer tema de verdad que se cargue tira el editor entero.
 *  - **Un tema puede incluir a otro.** `dark_plus.json` es un puñado de reglas más `"include":
 *    "./dark_vs.json"`. Sin resolver la inclusión se obtiene un tema casi vacío que **no falla**:
 *    simplemente se ve mal, y parece que la conversión funciona a medias.
 *  - **La regla sin `scope` no es una regla.** En `tokenColors`, la entrada sin ámbito lleva el
 *    color de primer plano y el fondo por defecto del editor, no el de un token concreto.
 */

// ---------------------------------------------------------------------------------------------
// Lo que declara el manifiesto
// ---------------------------------------------------------------------------------------------

/** Un tema declarado en `contributes.themes`. */
export interface ContributedTheme {
  /** Identificador estable dentro del IDE: `ext:<publisher>.<name>:<etiqueta>`. */
  id: string;
  /** Extensión que lo aporta, en la forma `publisher.name`. */
  extensionId: string;
  /** Cómo lo llama su autor. Es lo que se enseña en el desplegable. */
  label: string;
  /** Claro u oscuro, según lo declare el propio tema. Decide el aspecto del resto del IDE. */
  uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  /** Ruta del archivo dentro de la extensión, tal cual la declara el manifiesto. */
  path: string;
}

/** Un archivo de fragmentos declarado en `contributes.snippets`. */
export interface ContributedSnippetFile {
  extensionId: string;
  /** Lenguaje de Monaco al que se ofrecen. */
  language: string;
  path: string;
}

/** Prefijo de los temas que vienen de una extensión. Lo que no lo lleve es de DotForge. */
export const EXTENSION_THEME_PREFIX = 'ext:';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Identificador de un tema de extensión.
 *
 * Lleva dentro la extensión **y** la etiqueta porque una extensión puede aportar diez temas
 * (los paquetes de temas lo hacen siempre) y el usuario elige uno concreto. Se guarda en las
 * preferencias, así que tiene que sobrevivir a una actualización de la extensión: por eso no lleva
 * la versión.
 */
export function themeId(extensionId: string, label: string): string {
  return `${EXTENSION_THEME_PREFIX}${extensionId}:${label}`;
}

export function isExtensionTheme(id: string): boolean {
  return id.startsWith(EXTENSION_THEME_PREFIX);
}

/**
 * Nombre con el que se registra el tema **dentro de Monaco**.
 *
 * Monaco valida el nombre y **lanza** `Illegal theme name!` con cualquier cosa que no sean letras,
 * dígitos y guiones: ni dos puntos, ni puntos, ni espacios. Y el identificador que se guarda en las
 * preferencias los lleva los tres, porque tiene que ser legible y contener la extensión y la
 * etiqueta (`ext:acme.temas:Noche`).
 *
 * Así que son dos nombres distintos y a propósito: el `id` es el que se guarda y se enseña, y éste
 * es el que entiende Monaco. Lleva un sufijo derivado del identificador completo porque el saneado
 * pierde información —`ext:a.b:C D` y `ext:a-b:C-D` se aplanarían igual— y dos temas registrados
 * con el mismo nombre serían el mismo tema.
 */
export function monacoThemeName(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  // FNV-1a de 32 bits: determinista, corto y sin dependencias. No es criptográfico y no hace falta
  // que lo sea: sólo separa dos identificadores que se aplanan al mismo texto.
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `${slug === '' ? 'ext' : slug}-${hash.toString(36)}`;
}

/**
 * Qué aspecto tiene el resto del IDE con este tema.
 *
 * Un tema de VS Code sólo describe el **editor**: no sabe nada de la barra de actividad, del panel
 * ni del explorador de este IDE, que se pintan con los tokens de `theme.css`. Así que se elige el
 * tema propio que menos desentone, y el ajuste lo dice con esas palabras en vez de fingir que la
 * extensión reviste la ventana entera.
 */
export function chromeThemeFor(uiTheme: ContributedTheme['uiTheme']): 'dotforge-dark' | 'dotforge-light' {
  return uiTheme === 'vs' || uiTheme === 'hc-light' ? 'dotforge-light' : 'dotforge-dark';
}

/** Base de Monaco sobre la que se apoya el tema convertido. */
export function monacoBaseFor(uiTheme: ContributedTheme['uiTheme']): 'vs' | 'vs-dark' | 'hc-black' {
  if (uiTheme === 'vs' || uiTheme === 'hc-light') return 'vs';
  if (uiTheme === 'hc-black') return 'hc-black';
  return 'vs-dark';
}

/**
 * Temas que declara el manifiesto ya parseado (el `package.json` de la extensión).
 *
 * Un tema sin `path` no se puede cargar y uno sin etiqueta no se puede elegir: los dos se
 * descartan en silencio, porque el manifiesto lo escribe un tercero y un `contributes` a medias no
 * es motivo para no instalar nada de lo demás.
 */
export function parseContributedThemes(manifest: unknown, extensionId: string): ContributedTheme[] {
  const contributes = asRecord(asRecord(manifest)?.['contributes'] ?? null);
  const declared = contributes?.['themes'];
  if (!Array.isArray(declared)) return [];

  const themes: ContributedTheme[] = [];
  const seen = new Set<string>();

  for (const entry of declared) {
    const source = asRecord(entry);
    if (source === null) continue;

    const path = stringOf(source, 'path');
    if (path === null) continue;

    // `label` es el nombre que ve el usuario; si falta, VS Code cae a `id`. Sin ninguno de los dos
    // no hay forma de nombrarlo en un desplegable.
    const label = stringOf(source, 'label') ?? stringOf(source, 'id');
    if (label === null) continue;

    const declaredUi = stringOf(source, 'uiTheme') ?? 'vs-dark';
    const uiTheme = (['vs', 'vs-dark', 'hc-black', 'hc-light'] as const).find((value) => value === declaredUi);

    const id = themeId(extensionId, label);
    if (seen.has(id)) continue;
    seen.add(id);

    themes.push({ id, extensionId, label, uiTheme: uiTheme ?? 'vs-dark', path });
  }

  return themes;
}

/**
 * Archivos de fragmentos que declara el manifiesto.
 *
 * VS Code admite `language` como cadena; se descarta lo que no la traiga, porque un fragmento sin
 * lenguaje no se puede ofrecer en ninguna parte.
 */
export function parseContributedSnippets(manifest: unknown, extensionId: string): ContributedSnippetFile[] {
  const contributes = asRecord(asRecord(manifest)?.['contributes'] ?? null);
  const declared = contributes?.['snippets'];
  if (!Array.isArray(declared)) return [];

  const files: ContributedSnippetFile[] = [];

  for (const entry of declared) {
    const source = asRecord(entry);
    if (source === null) continue;

    const path = stringOf(source, 'path');
    const language = stringOf(source, 'language');
    if (path === null || language === null) continue;

    files.push({ extensionId, language: language.toLowerCase(), path });
  }

  return files;
}

// ---------------------------------------------------------------------------------------------
// Colores
// ---------------------------------------------------------------------------------------------

const HEX = /^#?([0-9a-fA-F]{3,8})$/;

/**
 * Normaliza un color de tema a `rrggbb`, **sin** almohadilla, o `null` si no es un color.
 *
 * Aquí está el detalle que rompe el editor entero si se pasa por alto: Monaco valida los colores y
 * **lanza** ante cualquier cosa que no sea hexadecimal de 6 dígitos. Los temas de VS Code usan de
 * todo:
 *
 *  - `#rrggbbaa` — la forma normal de escribir algo translúcido (selecciones, resaltado de la línea
 *    actual, bordes). Es lo más frecuente con diferencia.
 *  - `#rgb` y `#rgba` — abreviadas.
 *
 * La transparencia se pierde a propósito: Monaco no la admite en las reglas de token, y aplanarla
 * contra un fondo que aquí no se conoce daría un color inventado. Se conserva el tono, que es lo
 * que hace reconocible al tema.
 */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const match = HEX.exec(value.trim());
  if (match === null) return null;

  const digits = match[1] ?? '';

  // `rgb` y `rgba`: cada dígito vale por dos.
  if (digits.length === 3 || digits.length === 4) {
    return digits
      .slice(0, 3)
      .split('')
      .map((digit) => digit.repeat(2))
      .join('')
      .toLowerCase();
  }

  // `rrggbb` y `rrggbbaa`: se recorta el canal alfa.
  if (digits.length === 6 || digits.length === 8) return digits.slice(0, 6).toLowerCase();

  return null;
}

/** El mismo color, con almohadilla, para el mapa `colors` de Monaco. */
export function normalizeColorWithHash(value: unknown): string | null {
  const color = normalizeColor(value);
  return color === null ? null : `#${color}`;
}

// ---------------------------------------------------------------------------------------------
// Conversión del tema
// ---------------------------------------------------------------------------------------------

/** Un tema de VS Code ya leído, venga de un `.json` o de un `.tmTheme` traducido. */
export interface VsCodeThemeDocument {
  /** Ruta relativa de otro tema del que éste hereda. */
  include?: string | null;
  colors?: Record<string, unknown>;
  tokenColors?: unknown;
  /** Los `.tmTheme` lo llaman así. Se acepta como sinónimo. */
  settings?: unknown;
}

/** Regla de token en el formato que espera `monaco.editor.defineTheme`. */
export interface MonacoTokenRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black';
  inherit: boolean;
  rules: MonacoTokenRule[];
  colors: Record<string, string>;
}

/**
 * Estilos de fuente que Monaco entiende.
 *
 * VS Code admite combinaciones (`bold italic`) y también `underline` y `strikethrough`. Monaco
 * acepta las mismas palabras separadas por espacios; lo que no reconoce lo ignora, así que se
 * filtra aquí para no mandarle ruido.
 */
const FONT_STYLES = new Set(['italic', 'bold', 'underline', 'strikethrough']);

function normalizeFontStyle(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const parts = value
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => FONT_STYLES.has(part));

  return parts.length === 0 ? null : parts.join(' ');
}

/** Ámbitos de una entrada de `tokenColors`: cadena, lista, o una cadena con comas. */
function scopesOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope !== '');
  }

  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === 'string' && scope.trim() !== '').map((s) => s.trim());
  }

  return [];
}

/**
 * Convierte un tema de VS Code al formato de `monaco.editor.defineTheme`.
 *
 * `documents` llega **ya resuelto**: el primero es el tema y detrás van los que incluye, del más
 * cercano al más lejano. Se recorren al revés para que lo del propio tema pise lo heredado, que es
 * lo que significa `include`.
 *
 * Los ámbitos de TextMate se pasan tal cual como nombre de token: Monaco casa por prefijo, así que
 * una regla para `comment` alcanza a `comment.line.double-slash`, igual que en VS Code. No hace
 * falta traducir la nomenclatura, y traducirla sería inventarse un mapa que se queda corto.
 */
export function convertTheme(
  documents: readonly VsCodeThemeDocument[],
  base: MonacoThemeData['base'],
): MonacoThemeData {
  const rules: MonacoTokenRule[] = [];
  const colors: Record<string, string> = {};

  for (const document of [...documents].reverse()) {
    for (const [key, value] of Object.entries(document.colors ?? {})) {
      const color = normalizeColorWithHash(value);
      if (color !== null) colors[key] = color;
    }

    const tokens = Array.isArray(document.tokenColors)
      ? document.tokenColors
      : Array.isArray(document.settings)
        ? document.settings
        : [];

    for (const entry of tokens) {
      const source = asRecord(entry);
      if (source === null) continue;

      const settings = asRecord(source['settings']);
      if (settings === null) continue;

      const foreground = normalizeColor(settings['foreground']);
      const background = normalizeColor(settings['background']);
      const fontStyle = normalizeFontStyle(settings['fontStyle']);
      if (foreground === null && background === null && fontStyle === null) continue;

      const scopes = scopesOf(source['scope']);

      // La entrada sin ámbito no es una regla de token: lleva los colores por defecto del editor.
      // Es la primera de casi todos los `.tmTheme` y de bastantes `.json`.
      if (scopes.length === 0) {
        if (foreground !== null) colors['editor.foreground'] = `#${foreground}`;
        if (background !== null) colors['editor.background'] = `#${background}`;
        continue;
      }

      for (const scope of scopes) {
        rules.push({
          token: scope,
          ...(foreground !== null ? { foreground } : {}),
          ...(background !== null ? { background } : {}),
          ...(fontStyle !== null ? { fontStyle } : {}),
        });
      }
    }
  }

  return { base, inherit: true, rules, colors };
}

// ---------------------------------------------------------------------------------------------
// Fragmentos
// ---------------------------------------------------------------------------------------------

export interface CodeSnippet {
  /** Lo que se teclea para invocarlo. */
  prefix: string;
  /** Cuerpo con la sintaxis de fragmento (`$1`, `${2:nombre}`, `$0`), ya en una sola cadena. */
  body: string;
  description: string;
  language: string;
  /** Extensión que lo aporta. Se enseña en la lista para saber de dónde sale. */
  extensionId: string;
}

/**
 * Lee un archivo de fragmentos de VS Code.
 *
 * El formato es un objeto de nombre a definición, y el cuerpo puede ser una cadena o una lista de
 * líneas — que es lo normal, porque JSON no tiene cadenas multilínea. El `prefix` puede ser una
 * lista: un mismo fragmento con varios disparadores.
 *
 * La sintaxis de los fragmentos **no se traduce**: la de VS Code y la de Monaco son la misma
 * (`$1`, `${1:algo}`, `${1|a,b|}`, `$0`), porque Monaco es de donde salió.
 */
export function parseSnippetFile(raw: unknown, language: string, extensionId: string): CodeSnippet[] {
  const source = asRecord(raw);
  if (source === null) return [];

  const snippets: CodeSnippet[] = [];

  for (const [name, value] of Object.entries(source)) {
    const definition = asRecord(value);
    if (definition === null) continue;

    const body = snippetBody(definition['body']);
    if (body === null) continue;

    const prefixes =
      typeof definition['prefix'] === 'string'
        ? [definition['prefix']]
        : Array.isArray(definition['prefix'])
          ? definition['prefix'].filter((entry): entry is string => typeof entry === 'string')
          : [];

    for (const prefix of prefixes) {
      if (prefix.trim() === '') continue;
      snippets.push({
        prefix,
        body,
        description: stringOf(definition, 'description') ?? name,
        language,
        extensionId,
      });
    }
  }

  return snippets;
}

function snippetBody(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;

  if (Array.isArray(value)) {
    const lines = value.filter((line): line is string => typeof line === 'string');
    if (lines.length === 0) return null;
    return lines.join('\n');
  }

  return null;
}
