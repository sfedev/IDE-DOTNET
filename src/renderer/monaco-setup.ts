/**
 * Carga y configuración de Monaco.
 *
 * Monaco no se bundlea: se copia `monaco-editor/min/vs` a `build/vendor/monaco` y se carga con su
 * propio loader AMD. Así los web workers funcionan sin trucos y el bundle del renderer se queda
 * en unos pocos KB en vez de varios MB.
 */
import type * as MonacoApi from 'monaco-editor';

import { registerRazorLanguage } from './languages/razor.js';

/**
 * El loader AMD que expone `vendor/monaco/vs/loader.js`.
 *
 * No se declara como global `require`: en este proyecto los tipos de Node ya definen ese nombre y
 * declararlo otra vez rompe la compilación. Se accede a través de `window` con un tipo propio.
 */
interface AmdLoader {
  (modules: string[], onLoad: (...args: unknown[]) => void, onError?: (error: unknown) => void): void;
  config(options: { paths: Record<string, string> }): void;
}

function amdLoader(): AmdLoader {
  const loader = (window as unknown as { require?: AmdLoader }).require;
  if (!loader) {
    throw new Error('no se ha cargado vendor/monaco/vs/loader.js antes que renderer.js');
  }
  return loader;
}

let monacoInstance: typeof MonacoApi | null = null;
let loadPromise: Promise<typeof MonacoApi> | null = null;

/** Lee un token de color del tema activo y lo devuelve sin el `#`, como espera Monaco. */
function token(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.replace('#', '') || '000000';
}

function themeColors(): Record<string, string> {
  const read = (name: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || '#000000';
  };

  return {
    'editor.background': read('--bg'),
    'editor.foreground': read('--text'),
    'editorLineNumber.foreground': read('--text-faint'),
    'editorLineNumber.activeForeground': read('--accent'),
    'editorCursor.foreground': read('--accent'),
    'editor.selectionBackground': read('--surface-3'),
    'editor.inactiveSelectionBackground': read('--surface-2'),
    'editor.lineHighlightBackground': read('--surface-1'),
    'editorIndentGuide.background1': read('--border-subtle'),
    'editorIndentGuide.activeBackground1': read('--border-strong'),
    'editorWidget.background': read('--surface-1'),
    'editorWidget.border': read('--border'),
    'editorSuggestWidget.background': read('--surface-1'),
    'editorSuggestWidget.border': read('--border'),
    'editorSuggestWidget.selectedBackground': read('--surface-3'),
    'editorHoverWidget.background': read('--surface-1'),
    'editorHoverWidget.border': read('--border'),
    'editorGutter.background': read('--bg'),
    'editorError.foreground': read('--danger'),
    'editorWarning.foreground': read('--warning'),
    'editorInfo.foreground': read('--info'),
    'scrollbarSlider.background': `${read('--border-strong')}66`,
    'scrollbarSlider.hoverBackground': `${read('--border-strong')}aa`,
    'minimap.background': read('--bg'),
  };
}

function buildTheme(base: 'vs' | 'vs-dark'): MonacoApi.editor.IStandaloneThemeData {
  return {
    base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: token('--syntax-comment'), fontStyle: 'italic' },
      { token: 'comment.cs', foreground: token('--syntax-comment'), fontStyle: 'italic' },
      { token: 'comment.razor', foreground: token('--syntax-comment'), fontStyle: 'italic' },
      { token: 'comment.html', foreground: token('--syntax-comment'), fontStyle: 'italic' },

      { token: 'keyword', foreground: token('--syntax-keyword') },
      { token: 'keyword.cs', foreground: token('--syntax-keyword') },
      { token: 'keyword.directive.razor', foreground: token('--syntax-razor'), fontStyle: 'bold' },
      { token: 'delimiter.razor', foreground: token('--syntax-razor') },
      { token: 'keyword.control.razor', foreground: token('--syntax-control'), fontStyle: 'bold' },

      { token: 'string', foreground: token('--syntax-string') },
      { token: 'string.cs', foreground: token('--syntax-string') },
      { token: 'string.razor', foreground: token('--syntax-string') },
      { token: 'string.escape.cs', foreground: token('--syntax-number') },

      { token: 'number', foreground: token('--syntax-number') },
      { token: 'number.cs', foreground: token('--syntax-number') },

      { token: 'type', foreground: token('--syntax-type') },
      { token: 'type.cs', foreground: token('--syntax-type') },
      { token: 'type.identifier', foreground: token('--syntax-type') },

      { token: 'identifier.cs', foreground: token('--syntax-variable') },
      { token: 'identifier.razor', foreground: token('--syntax-variable') },

      { token: 'tag.html', foreground: token('--syntax-tag') },
      { token: 'tag.component.razor', foreground: token('--syntax-component'), fontStyle: 'bold' },
      { token: 'attribute.name.html', foreground: token('--syntax-attribute') },
      { token: 'attribute.value.html', foreground: token('--syntax-string') },
      { token: 'attribute.razor', foreground: token('--syntax-razor') },
      { token: 'metatag.html', foreground: token('--syntax-comment') },

      { token: 'operator.cs', foreground: token('--syntax-control') },
    ],
    colors: themeColors(),
  };
}

export const DARK_THEME = 'dotforge-dark';
export const LIGHT_THEME = 'dotforge-light';

/** (Re)define los temas de Monaco a partir de los tokens CSS actuales. */
export function defineThemes(monaco: typeof MonacoApi): void {
  monaco.editor.defineTheme(DARK_THEME, buildTheme('vs-dark'));
  monaco.editor.defineTheme(LIGHT_THEME, buildTheme('vs'));
}

/** Carga Monaco una sola vez y lo deja configurado con lenguajes y temas de DotForge. */
export function loadMonaco(): Promise<typeof MonacoApi> {
  if (monacoInstance) return Promise.resolve(monacoInstance);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<typeof MonacoApi>((resolve, reject) => {
    // Los workers se crean desde un blob que hace `importScripts` del worker real: es la receta
    // oficial para servir Monaco desde `file://`, donde no hay un origen que compartir.
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorkerUrl(): string {
        const bootstrap = `
          self.MonacoEnvironment = { baseUrl: '${new URL('vendor/monaco/', window.location.href).href}' };
          importScripts('${new URL('vendor/monaco/vs/base/worker/workerMain.js', window.location.href).href}');
        `;
        return URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
      },
    };

    const loader = amdLoader();
    loader.config({ paths: { vs: 'vendor/monaco/vs' } });

    loader(
      ['vs/editor/editor.main'],
      () => {
        const monaco = (window as unknown as { monaco: typeof MonacoApi }).monaco;
        registerRazorLanguage(monaco);
        defineThemes(monaco);
        monacoInstance = monaco;
        resolve(monaco);
      },
      (error: unknown) => {
        reject(new Error(`no se ha podido cargar Monaco: ${error instanceof Error ? error.message : String(error)}`));
      },
    );
  });

  return loadPromise;
}

export function getMonaco(): typeof MonacoApi {
  if (!monacoInstance) throw new Error('Monaco todavía no está cargado');
  return monacoInstance;
}
