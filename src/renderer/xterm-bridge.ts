/**
 * Puente con xterm.js.
 *
 * xterm no se bundlea, por la misma razón que Monaco: son 500 KB que se sirven mucho mejor como
 * archivo del vendor, y la prueba de empaquetado vigila que el bundle del renderer siga siendo un
 * orden de magnitud más pequeño que lo que dice no incrustar. Se carga con dos `<script>` en
 * `index.html` —**antes** que el loader AMD de Monaco, o su envoltorio UMD se registraría como
 * módulo anónimo en vez de dejar `window.Terminal`— y se accede a él desde aquí.
 *
 * Por eso los tipos se declaran a mano y son sólo los que se usan: importar los del paquete
 * ataría la compilación a un módulo que en ejecución no se importa nunca.
 */

import { keyboardGesture, mouseGesture, type ClipboardGesture } from '../shared/terminal-clipboard.js';

export interface XtermDisposable {
  dispose(): void;
}

export interface XtermTerminal {
  readonly cols: number;
  readonly rows: number;
  open(container: HTMLElement): void;
  write(data: string): void;
  writeln(data: string): void;
  clear(): void;
  focus(): void;
  dispose(): void;
  loadAddon(addon: unknown): void;
  onData(listener: (data: string) => void): XtermDisposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): XtermDisposable;
  /**
   * Manejador previo de teclado. Devolver `false` le dice a xterm que no procese el evento; se
   * invoca con `keydown`, `keypress` y `keyup`.
   */
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  /** Pega como si viniera del portapapeles: respeta el modo de pegado entre corchetes y convierte los saltos. */
  paste(data: string): void;
  options: Record<string, unknown>;
}

export interface XtermFitAddon {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

interface XtermGlobals {
  Terminal?: new (options: Record<string, unknown>) => XtermTerminal;
  FitAddon?: { FitAddon: new () => XtermFitAddon };
}

/** ¿Se ha cargado xterm? Si no, las pestañas de pseudoterminal no se pueden pintar. */
export function xtermAvailable(): boolean {
  const globals = window as unknown as XtermGlobals;
  return typeof globals.Terminal === 'function';
}

/**
 * Colores del emulador, tomados del tema activo.
 *
 * Se leen de las variables CSS y no se escriben aquí: es la misma regla que gobierna el resto del
 * sistema de diseño —ningún componente escribe un color literal— y además hace que cambiar de tema
 * claro a oscuro cambie también la terminal, sin una tabla paralela que se olvide de actualizar.
 *
 * Los dieciséis colores ANSI sí son literales: no son decisión de diseño de este IDE, son lo que
 * un programa de consola espera cuando pide "rojo". Se usa una paleta suave, coherente con la
 * regla de no usar negro ni blanco puros.
 */
function themeColors(): Record<string, string> {
  const read = (name: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };

  return {
    background: read('--bg-deep', '#1b1d27'),
    foreground: read('--text', '#c8cee2'),
    cursor: read('--accent', '#a78bfa'),
    cursorAccent: read('--bg-deep', '#1b1d27'),
    selectionBackground: read('--surface-3', '#333849'),
    black: '#2b2f3d',
    red: '#ef8f8f',
    green: '#8fd694',
    yellow: '#e2c08d',
    blue: '#8ab4f8',
    magenta: '#c8a2f8',
    cyan: '#7fd1de',
    white: '#c8cee2',
    brightBlack: '#5b6274',
    brightRed: '#ffa7a7',
    brightGreen: '#a9e8ad',
    brightYellow: '#f2d9ab',
    brightBlue: '#a8c9ff',
    brightMagenta: '#dcbcff',
    brightCyan: '#9fe4ef',
    brightWhite: '#e6eaf5',
  };
}

export interface CreatedTerminal {
  term: XtermTerminal;
  fit: XtermFitAddon | null;
}

/**
 * Crea un emulador listo para engancharse a una sesión.
 *
 * Devuelve `null` si xterm no está cargado, en vez de lanzar: es un estado que el panel sabe
 * contar ("no hay emulador de terminal") y que no puede tumbar el pintado del panel entero.
 */
export function createTerminal(options: { fontFamily: string; fontSize: number }): CreatedTerminal | null {
  const globals = window as unknown as XtermGlobals;
  if (typeof globals.Terminal !== 'function') return null;

  const term = new globals.Terminal({
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    // El histórico de una compilación larga cabe entero: subir a buscar el primer error de MSBuild
    // es la razón principal por la que alguien se desplaza hacia arriba en una terminal.
    scrollback: 10_000,
    allowProposedApi: true,
    theme: themeColors(),
  });

  let fit: XtermFitAddon | null = null;
  if (globals.FitAddon) {
    fit = new globals.FitAddon.FitAddon();
    term.loadAddon(fit);
  }

  return { term, fit };
}

/** Reaplica los colores del tema a un emulador ya abierto. */
export function applyTheme(term: XtermTerminal, options: { fontFamily: string; fontSize: number }): void {
  term.options['theme'] = themeColors();
  term.options['fontFamily'] = options.fontFamily;
  term.options['fontSize'] = options.fontSize;
}

/** Lo que la terminal necesita del portapapeles del sistema: texto plano, en las dos direcciones. */
export interface TerminalClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/**
 * Copiar y pegar en una pestaña de pseudoterminal (Fase 28).
 *
 * xterm por sí solo manda `Ctrl+C` y `Ctrl+V` al intérprete como U+0003 y U+0016, y llama a
 * `preventDefault()`, con lo que tampoco llegan a los `role` del menú. PowerShell disimulaba
 * (PSReadLine lee el portapapeles del sistema por su cuenta); `cmd.exe` pintaba `^V`. Qué gesto es
 * cada tecla lo decide `terminal-clipboard.ts`, que es puro; aquí sólo se ejecuta.
 *
 * El `preventDefault()` de los gestos atendidos es deliberado y no redundante: sin él, el evento
 * sigue hasta el acelerador del menú (`role: 'paste'`), que pega **otra vez** a través del evento
 * `paste` del DOM que xterm también escucha.
 */
export function attachClipboard(
  term: XtermTerminal,
  host: HTMLElement,
  options: { platform: string; clipboard: TerminalClipboard },
): void {
  const context = (): { platform: string; hasSelection: boolean } => ({
    platform: options.platform,
    hasSelection: term.hasSelection(),
  });

  const perform = (gesture: ClipboardGesture): void => {
    if (gesture === 'copy') {
      const text = term.getSelection();
      if (text !== '') void options.clipboard.writeText(text);
      return;
    }
    if (gesture === 'paste') {
      void options.clipboard.readText().then((text) => {
        if (text !== '') term.paste(text);
      });
    }
  };

  term.attachCustomKeyEventHandler((event) => {
    const gesture = keyboardGesture(event, context());
    if (gesture === 'none') return true;
    event.preventDefault();
    perform(gesture);
    return false;
  });

  host.addEventListener('contextmenu', (event) => {
    const gesture = mouseGesture(event.button, context());
    if (gesture === 'none') return;
    event.preventDefault();
    perform(gesture);
    // Como en la consola de Windows: copiar con el botón secundario suelta la selección, que es la
    // señal de que se ha copiado.
    if (gesture === 'copy') term.clearSelection();
    term.focus();
  });
}
