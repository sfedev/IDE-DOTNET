/**
 * Lo que las extensiones instaladas aportan de verdad: temas de color y fragmentos de código.
 *
 * Paga la deuda del ADR-048. Hasta ahora el IDE instalaba el `.vsix`, leía su manifiesto y decía en
 * la ficha qué aportaba, pero **no consumía nada**: ni siquiera lo que la propia ficha listaba
 * como soportado. Instalar un tema y que el editor siguiera igual es la clase de cosa que hace que
 * un gestor de extensiones se perciba como decorativo.
 *
 * El reparto es el de siempre: aquí se lee el disco; lo que decide está en
 * `src/shared/vsix-contributions.ts` y se prueba sin tocar ningún archivo.
 *
 * Dos cosas que no son evidentes:
 *
 *  - **Nada síncrono** (ADR-051). Un paquete de temas trae veinte archivos JSON de 40 KB, y el hilo
 *    que los leería es el que repinta la ventana y atiende el IPC.
 *  - **Toda ruta del manifiesto se valida contra la carpeta de la extensión.** `contributes` es
 *    JSON escrito por un tercero, y su `path` acaba en un `readFile`: un `../../../` ahí dentro
 *    leería lo que quisiera del disco del usuario. Es el mismo cuidado que ya se tiene con el
 *    nombre de la carpeta al instalar (ADR-047).
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { parseJsonText } from '../../shared/json-text.js';
import {
  convertTheme,
  monacoBaseFor,
  parseContributedSnippets,
  parseContributedThemes,
  parseSnippetFile,
  type CodeSnippet,
  type ContributedTheme,
  type MonacoThemeData,
  type VsCodeThemeDocument,
} from '../../shared/vsix-contributions.js';
import { listInstalled } from './extension-installer.js';

/** Tope de inclusiones encadenadas. Un `include` circular no puede colgar el arranque. */
const MAX_INCLUDE_DEPTH = 8;

/** Un tema listo para `monaco.editor.defineTheme`, con lo que hace falta para ofrecerlo. */
export interface LoadedTheme {
  id: string;
  label: string;
  extensionId: string;
  uiTheme: ContributedTheme['uiTheme'];
  data: MonacoThemeData;
}

export interface LoadedContributions {
  themes: LoadedTheme[];
  snippets: CodeSnippet[];
  /** Qué no se ha podido cargar y por qué. Se enseña, no se traga. */
  problems: string[];
}

/**
 * Resuelve una ruta declarada en el manifiesto contra la carpeta de la extensión.
 *
 * Devuelve `null` si se sale de ella. No es paranoia teórica: el manifiesto viene dentro de un
 * `.vsix` descargado de un registro público, y esta ruta se pasa a `readFile`.
 */
function insideExtension(directory: string, declared: string): string | null {
  if (isAbsolute(declared)) return null;

  const target = resolve(directory, declared);
  const rootRelative = relative(resolve(directory), target);

  if (rootRelative === '' || rootRelative.startsWith('..') || isAbsolute(rootRelative)) return null;
  if (rootRelative.split(sep).includes('..')) return null;

  return target;
}

/**
 * Lector de plist.
 *
 * `preserveOrder` no es un detalle de configuración: es lo único que hace legible un plist. Un
 * `<dict>` alterna `<key>` y su valor como **hermanos**, no como pares anidados, y sin conservar el
 * orden fast-xml-parser los agrupa por etiqueta —todas las claves en una lista, todas las cadenas
 * en otra— y la correspondencia entre una clave y su valor se pierde para siempre. El síntoma es un
 * tema que se parsea sin error y sale vacío.
 */
const plist = new XMLParser({ ignoreAttributes: true, trimValues: true, preserveOrder: true });

/** Un nodo en modo ordenado: un único par etiqueta -> hijos, más el `:@` de los atributos. */
type OrderedNode = Record<string, unknown>;

function tagOf(node: OrderedNode): string | null {
  return Object.keys(node).find((key) => key !== ':@') ?? null;
}

function childrenOf(node: OrderedNode, tag: string): OrderedNode[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

/** Texto de un nodo hoja (`<string>rojo</string>` -> `rojo`). */
function textOf(node: OrderedNode, tag: string): string {
  const first = childrenOf(node, tag)[0];
  const text = first?.['#text'];
  return text === undefined ? '' : String(text);
}

/**
 * Pares clave/valor de un `<dict>`, emparejando cada `<key>` con el nodo que la sigue.
 *
 * Es exactamente por esto que hace falta el orden: el valor de una clave es su hermano siguiente.
 */
function dictEntries(children: readonly OrderedNode[]): Array<[string, OrderedNode]> {
  const entries: Array<[string, OrderedNode]> = [];

  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    if (node === undefined || tagOf(node) !== 'key') continue;

    const value = children[index + 1];
    if (value === undefined) continue;

    entries.push([textOf(node, 'key'), value]);
    index++;
  }

  return entries;
}

function lookup(children: readonly OrderedNode[], key: string): OrderedNode | null {
  return dictEntries(children).find(([name]) => name === key)?.[1] ?? null;
}

/** `<dict><key>foreground</key><string>#fff</string></dict>` -> `{ foreground: '#fff' }`. */
function flattenDict(node: OrderedNode): Record<string, string> {
  const flat: Record<string, string> = {};

  for (const [key, value] of dictEntries(childrenOf(node, 'dict'))) {
    const tag = tagOf(value);
    if (tag === 'string' || tag === 'integer') flat[key] = textOf(value, tag);
  }

  return flat;
}

/**
 * Traduce un `.tmTheme` al mismo documento que un tema JSON.
 *
 * Un `.tmTheme` es un plist de XML: un diccionario con una clave `settings` cuyo valor es la lista
 * de reglas, cada una con su `scope` y su propio `settings`.
 */
function parseTmTheme(xml: string): VsCodeThemeDocument | null {
  let parsed: unknown;
  try {
    parsed = plist.parse(xml);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const root = (parsed as OrderedNode[]).find((node) => tagOf(node) === 'plist');
  if (root === undefined) return null;

  const dict = childrenOf(root, 'plist').find((node) => tagOf(node) === 'dict');
  if (dict === undefined) return null;

  const settings = lookup(childrenOf(dict, 'dict'), 'settings');
  if (settings === null || tagOf(settings) !== 'array') return null;

  const tokenColors: unknown[] = [];

  for (const entry of childrenOf(settings, 'array')) {
    if (tagOf(entry) !== 'dict') continue;

    const children = childrenOf(entry, 'dict');
    const rule = lookup(children, 'settings');
    if (rule === null || tagOf(rule) !== 'dict') continue;

    const scopeNode = lookup(children, 'scope');
    const scope = scopeNode !== null && tagOf(scopeNode) === 'string' ? textOf(scopeNode, 'string') : null;

    tokenColors.push({
      ...(scope !== null && scope !== '' ? { scope } : {}),
      settings: flattenDict(rule),
    });
  }

  return { tokenColors };
}

/**
 * Lee un archivo de tema y los que incluya, del más cercano al más lejano.
 *
 * `dark_plus.json` es un puñado de reglas más `"include": "./dark_vs.json"`, y sin resolverlo se
 * obtiene un tema casi vacío que no falla: simplemente se ve mal.
 */
async function readThemeChain(directory: string, file: string): Promise<VsCodeThemeDocument[]> {
  const chain: VsCodeThemeDocument[] = [];
  const visited = new Set<string>();

  let current: string | null = file;

  for (let depth = 0; current !== null && depth < MAX_INCLUDE_DEPTH; depth++) {
    if (visited.has(current)) break;
    visited.add(current);

    // Anotado a propósito: sin el tipo explícito, TypeScript ve un ciclo de inferencia entre este
    // texto, el tema que sale de él y el `current` que se recalcula con su `include`, y lo resuelve
    // dándole `any` — que es exactamente lo que este proyecto no admite.
    const text: string = await readFile(current, 'utf8');
    const theme: VsCodeThemeDocument | null = current.toLowerCase().endsWith('.tmtheme')
      ? parseTmTheme(text)
      : (parseJsonText<VsCodeThemeDocument>(text) as VsCodeThemeDocument);

    if (theme === null) break;
    chain.push(theme);

    const included: string | null = typeof theme.include === 'string' ? theme.include : null;
    // El `include` es relativo al archivo que lo declara, no a la raíz de la extensión.
    current =
      included === null
        ? null
        : insideExtension(directory, relative(directory, join(dirname(current), included)));
  }

  return chain;
}

/**
 * Todo lo que aportan las extensiones instaladas.
 *
 * Un fallo en una extensión no puede impedir cargar las demás: se anota en `problems` y se sigue.
 * Lo que se traga en silencio aquí acaba como "instalé un tema y no aparece", que es exactamente lo
 * que este módulo existe para evitar.
 */
export async function load(): Promise<LoadedContributions> {
  const themes: LoadedTheme[] = [];
  const snippets: CodeSnippet[] = [];
  const problems: string[] = [];

  for (const extension of await listInstalled()) {
    let manifest: unknown;
    try {
      manifest = parseJsonText(await readFile(join(extension.directory, 'package.json'), 'utf8'));
    } catch (error) {
      problems.push(`${extension.id}: no se ha podido leer su manifiesto (${messageOf(error)}).`);
      continue;
    }

    for (const declared of parseContributedThemes(manifest, extension.id)) {
      // Dos motivos distintos y hay que distinguirlos: la ruta se sale de la extensión (que es un
      // problema de la extensión) o el archivo no se deja leer (que puede ser de la instalación).
      const file = insideExtension(extension.directory, declared.path);
      if (file === null) {
        problems.push(`${extension.id}: el tema "${declared.label}" apunta fuera de la extensión.`);
        continue;
      }

      try {
        const chain = await readThemeChain(extension.directory, file);
        if (chain.length === 0) {
          problems.push(`${extension.id}: el tema "${declared.label}" no se ha podido interpretar.`);
          continue;
        }

        themes.push({
          id: declared.id,
          label: declared.label,
          extensionId: extension.id,
          uiTheme: declared.uiTheme,
          data: convertTheme(chain, monacoBaseFor(declared.uiTheme)),
        });
      } catch (error) {
        problems.push(`${extension.id}: el tema "${declared.label}" no se ha podido leer (${messageOf(error)}).`);
      }
    }

    for (const declared of parseContributedSnippets(manifest, extension.id)) {
      const file = insideExtension(extension.directory, declared.path);
      if (file === null) {
        problems.push(`${extension.id}: los fragmentos de ${declared.language} apuntan fuera de la extensión.`);
        continue;
      }

      try {
        snippets.push(...parseSnippetFile(parseJsonText(await readFile(file, 'utf8')), declared.language, extension.id));
      } catch (error) {
        problems.push(`${extension.id}: los fragmentos de ${declared.language} no se han podido leer (${messageOf(error)}).`);
      }
    }
  }

  return { themes, snippets, problems };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
