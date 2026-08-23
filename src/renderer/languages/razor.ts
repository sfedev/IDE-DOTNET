/**
 * Soporte del lenguaje Razor/Blazor en Monaco.
 *
 * Razor mezcla tres lenguajes en un mismo archivo: HTML, C# incrustado con `@` y directivas de
 * archivo. La gramática vive en `razor-tokens.ts`; aquí están la configuración del lenguaje, los
 * snippets y el auto-cierre de etiquetas.
 */
import type * as MonacoApi from 'monaco-editor';

import { razorMonarchTokens } from './razor-tokens.js';

export const RAZOR_LANGUAGE_ID = 'razor';

export { razorMonarchTokens, RAZOR_DIRECTIVES, CSHARP_KEYWORDS } from './razor-tokens.js';

/** Etiquetas HTML sin contenido: nunca deben auto-cerrarse con `</tag>`. */
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr',
]);

export const razorLanguageConfiguration: MonacoApi.languages.LanguageConfiguration = {
  comments: { blockComment: ['@*', '*@'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
    ['<', '>'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '<', close: '>' },
  ],
  folding: {
    markers: {
      start: new RegExp(String.raw`^\s*<!--\s*#region\b.*-->`),
      end: new RegExp(String.raw`^\s*<!--\s*#endregion\b.*-->`),
    },
  },
  // Al pulsar Enter entre una etiqueta abierta y su cierre, indenta y deja el cierre debajo.
  onEnterRules: [
    {
      beforeText: new RegExp(
        String.raw`<(?!(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr))([\w.:-]+)(?:[^>]*(?!/)>)[^<]*$`,
        'i',
      ),
      afterText: new RegExp(String.raw`^</([\w.:-]+)\s*>`, 'i'),
      action: { indentAction: 3 /* IndentAction.IndentOutdent */ },
    },
  ],
};

/** Snippets de Blazor más usados en el día a día. */
export const razorSnippets: Array<{ label: string; detail: string; insertText: string }> = [
  { label: 'page', detail: 'Directiva @page', insertText: '@page "/${1:ruta}"\n$0' },
  { label: 'code', detail: 'Bloque @code', insertText: '@code {\n\t$0\n}' },
  { label: 'inject', detail: 'Inyectar un servicio', insertText: '@inject ${1:IServicio} ${2:Servicio}\n$0' },
  { label: 'rendermode', detail: 'Modo de render interactivo', insertText: '@rendermode InteractiveServer\n$0' },
  {
    label: 'parameter',
    detail: 'Parámetro de componente',
    insertText: '[Parameter]\npublic ${1:string} ${2:Valor} { get; set; }$0',
  },
  {
    label: 'oninit',
    detail: 'OnInitializedAsync',
    insertText: 'protected override async Task OnInitializedAsync()\n{\n\t$0\n}',
  },
  {
    label: 'onparams',
    detail: 'OnParametersSetAsync',
    insertText: 'protected override async Task OnParametersSetAsync()\n{\n\t$0\n}',
  },
  {
    label: 'editform',
    detail: 'EditForm con validación',
    insertText:
      '<EditForm Model="${1:model}" OnValidSubmit="${2:OnSubmitAsync}">\n' +
      '\t<DataAnnotationsValidator />\n' +
      '\t<ValidationSummary />\n\t$0\n' +
      '\t<button type="submit">Guardar</button>\n' +
      '</EditForm>',
  },
  { label: 'foreach', detail: 'Bucle @foreach', insertText: '@foreach (var ${1:item} in ${2:items})\n{\n\t$0\n}' },
  { label: 'if', detail: 'Condicional @if', insertText: '@if (${1:condicion})\n{\n\t$0\n}' },
  { label: 'bind', detail: 'Enlace bidireccional', insertText: '@bind-Value="${1:Propiedad}"$0' },
  { label: 'onclick', detail: 'Manejador de clic', insertText: '@onclick="${1:OnClickAsync}"$0' },
  { label: 'navlink', detail: 'NavLink', insertText: '<NavLink href="${1:ruta}">${2:Texto}</NavLink>$0' },
];

/** Registra el lenguaje, la gramática y los snippets. */
export function registerRazorLanguage(monaco: typeof MonacoApi): void {
  monaco.languages.register({
    id: RAZOR_LANGUAGE_ID,
    extensions: ['.razor', '.cshtml'],
    aliases: ['Razor', 'Blazor', 'razor'],
    mimetypes: ['text/x-razor'],
  });

  monaco.languages.setLanguageConfiguration(RAZOR_LANGUAGE_ID, razorLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(RAZOR_LANGUAGE_ID, razorMonarchTokens);

  monaco.languages.registerCompletionItemProvider(RAZOR_LANGUAGE_ID, {
    triggerCharacters: ['@', '<'],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range: MonacoApi.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      return {
        suggestions: razorSnippets.map((snippet) => ({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.detail,
          insertText: snippet.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}

/**
 * Decide si al teclear `>` hay que insertar la etiqueta de cierre.
 *
 * Se expone aparte de Monaco para poder probarlo sin editor: la lógica es donde están los casos
 * borde (etiquetas void, autocerradas y cierres ya presentes), no en la integración.
 *
 * @param lineUntilCursor  texto de la línea desde el inicio hasta el cursor, `>` incluido
 * @param textAfterCursor  texto inmediatamente a la derecha del cursor
 * @returns la etiqueta de cierre a insertar, o null si no procede
 */
export function closingTagFor(lineUntilCursor: string, textAfterCursor: string): string | null {
  if (!lineUntilCursor.endsWith('>')) return null;

  // Etiqueta autocerrada: <br />, <Foo />
  if (lineUntilCursor.endsWith('/>')) return null;

  const match = /<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>$/.exec(lineUntilCursor);
  if (!match) return null;

  const tagName = match[1]!;
  if (VOID_ELEMENTS.has(tagName.toLowerCase())) return null;

  // Una etiqueta de cierre (`</div>`) no abre nada.
  if (/<\/[\w.:-]+>$/.test(lineUntilCursor)) return null;

  const closing = `</${tagName}>`;

  // Ya está cerrada justo detrás: no se duplica.
  if (textAfterCursor.startsWith(closing)) return null;

  return closing;
}

/**
 * Instala el auto-cierre de etiquetas en un editor.
 * Monaco sólo lo trae de serie para HTML, así que en Razor hay que hacerlo a mano.
 */
export function installTagAutoClose(
  monaco: typeof MonacoApi,
  editor: MonacoApi.editor.IStandaloneCodeEditor,
): MonacoApi.IDisposable {
  return editor.onDidChangeModelContent((event) => {
    const model = editor.getModel();
    if (!model) return;

    const languageId = model.getLanguageId();
    if (languageId !== RAZOR_LANGUAGE_ID && languageId !== 'html') return;

    const change = event.changes[0];
    if (!change || change.text !== '>') return;

    const position = editor.getPosition();
    if (!position) return;

    const lineUntilCursor = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });

    const textAfterCursor = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: position.lineNumber,
      endColumn: model.getLineMaxColumn(position.lineNumber),
    });

    const closing = closingTagFor(lineUntilCursor, textAfterCursor);
    if (!closing) return;

    editor.executeEdits('razor-autoclose', [
      {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
        text: closing,
        forceMoveMarkers: false,
      },
    ]);

    // El cursor debe quedar entre la etiqueta de apertura y la de cierre.
    editor.setPosition(position);
  });
}
