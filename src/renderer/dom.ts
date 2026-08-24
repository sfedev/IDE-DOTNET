/**
 * Ayudantes de DOM.
 *
 * Todo el renderer construye la interfaz con estos helpers en vez de `innerHTML`: el contenido
 * viene de rutas de archivo, mensajes del compilador y descripciones de paquetes NuGet, es decir,
 * texto que no controlamos. Con `textContent` no hay forma de inyectar marcado.
 */
import { captureFocus, FOCUS_KEY_ATTRIBUTE, restoreFocus, type FocusableField } from './focus-guard.js';

type Child = Node | string | number | null | undefined | false;

export interface ElementOptions {
  className?: string;
  text?: string | number;
  title?: string;
  id?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  hidden?: boolean;
  disabled?: boolean;
  role?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
  }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.title) node.title = options.title;
  if (options.id) node.id = options.id;
  if (options.role) node.setAttribute('role', options.role);
  if (options.hidden) node.hidden = true;

  if (options.type && 'type' in node) (node as HTMLInputElement).type = options.type;
  if (options.value !== undefined && 'value' in node) (node as HTMLInputElement).value = options.value;
  if (options.placeholder && 'placeholder' in node) (node as HTMLInputElement).placeholder = options.placeholder;
  if (options.disabled && 'disabled' in node) (node as HTMLButtonElement).disabled = true;

  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
  }
  if (options.style) Object.assign(node.style, options.style);

  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      node.addEventListener(event, handler as EventListener);
    }
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Element, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`falta el elemento #${id} en index.html`);
  return node as T;
}

/**
 * Repinta un contenedor sin perder el foco ni el cursor del campo que se estuviera usando.
 *
 * Es la contrapartida DOM de `focus-guard.ts`, que es donde están las reglas y las pruebas. El
 * reparto es deliberado: aquí sólo se busca el nodo enfocado y el que ocupa su lugar después; qué
 * se anota y qué se restaura se decide en funciones puras.
 *
 * Sólo entran en el trato los campos marcados con `data-focus-key`, y sólo si el foco estaba
 * **dentro** de este contenedor: un repintado del panel de NuGet no puede robarle el cursor a la
 * terminal.
 */
export function repaintPreservingFocus(container: Element, paint: () => void): void {
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && container.contains(active);
  const snapshot = inside ? captureFocus(active as unknown as FocusableField) : null;

  paint();

  if (snapshot === null) return;

  const restored = container.querySelector(`[${FOCUS_KEY_ATTRIBUTE}="${CSS.escape(snapshot.key)}"]`);
  restoreFocus(snapshot, (restored as unknown as FocusableField | null) ?? null);
}

/** Formatea un número grande de forma compacta: 12345678 -> "12,3 M". */
export function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace('.', ',')} MM`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace('.', ',')} K`;
  return String(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Retrasa la ejecución hasta que dejen de llegar llamadas: para búsquedas mientras se teclea. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): (...args: A) => void {
  let timer: number | undefined;
  return (...args: A) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delayMs);
  };
}

/** Último segmento de una ruta, independientemente del separador. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? path : path.slice(0, index);
}

export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** Coincidencia difusa por subsecuencia, como la de las paletas de comandos. */
export function fuzzyMatch(needle: string, haystack: string): boolean {
  if (needle === '') return true;
  const target = haystack.toLowerCase();
  const query = needle.toLowerCase();

  let index = 0;
  for (const char of query) {
    index = target.indexOf(char, index);
    if (index === -1) return false;
    index++;
  }
  return true;
}
