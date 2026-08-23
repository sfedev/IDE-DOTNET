/**
 * Gramática Monarch de Razor/Blazor.
 *
 * Notas de Monarch que condicionan el diseño (y que costaron una tanda de depuración):
 *  - Si una expresión regular tiene N grupos de captura, la acción debe ser un array de N
 *    acciones, una por grupo. Un `{ cases: ... }` en el nivel superior con un regex de varios
 *    grupos NO funciona: hay que poner el `cases` dentro de la acción del grupo concreto.
 *  - No existe `goBack`. Para volver a procesar el carácter actual en otro estado se usa el token
 *    especial `@rematch` junto con `next`.
 *  - `switchTo` sólo tiene sentido en la primera regla que se evalúa al entrar en un estado; es
 *    más simple y más robusto emparejar `@(` o `@{` en una sola regla de dos grupos.
 */
import type * as MonacoApi from 'monaco-editor';

/** Directivas de nivel de archivo o de bloque que admite Razor. */
export const RAZOR_DIRECTIVES = [
  'page', 'model', 'using', 'inject', 'inherits', 'implements', 'layout', 'namespace',
  'attribute', 'typeparam', 'preservewhitespace', 'rendermode', 'addTagHelper',
  'removeTagHelper', 'tagHelperPrefix', 'section', 'functions', 'code',
];

export const CSHARP_KEYWORDS = [
  'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
  'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double',
  'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for',
  'foreach', 'get', 'goto', 'if', 'implicit', 'in', 'init', 'int', 'interface', 'internal', 'is',
  'lock', 'long', 'nameof', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override',
  'params', 'private', 'protected', 'public', 'readonly', 'record', 'ref', 'required', 'return',
  'sbyte', 'sealed', 'set', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe',
  'ushort', 'using', 'var', 'virtual', 'void', 'volatile', 'when', 'where', 'while', 'with',
  'yield',
];

export const razorMonarchTokens: MonacoApi.languages.IMonarchLanguage = {
  defaultToken: '',
  // Los nombres de token ya llevan su propio sufijo (`.razor`, `.cs`, `.html`), que es lo que
  // distingue las tres gramáticas mezcladas. Añadir además `tokenPostfix` produciría nombres
  // como `comment.razor.razor`.
  tokenPostfix: '',
  ignoreCase: false,

  keywords: CSHARP_KEYWORDS,

  /**
   * Alternación de directivas para usar dentro de una expresión regular.
   *
   * Monarch exige que una referencia `@atributo` dentro de un regex apunte a una **cadena**, no a
   * un array (los arrays sólo valen en las guardas de `cases`). Se ordena de mayor a menor
   * longitud para que la alternación no case un prefijo antes que la directiva completa.
   */
  directivesPattern: [...RAZOR_DIRECTIVES].sort((a, b) => b.length - a.length).join('|'),

  tokenizer: {
    root: [
      // Comentario Razor: @* ... *@
      [/@\*/, { token: 'comment.razor', next: '@razorComment' }],

      // En Razor, `@@` es una arroba literal (correo@@ejemplo.com), no el inicio de una expresión.
      //
      // Ojo: en Monarch `@@` es el escape de UN `@` literal dentro de la expresión regular, así
      // que para casar dos arrobas hay que escribir cuatro. Con `/@@/` la regla casaba una sola
      // arroba y se tragaba el `@` de toda directiva antes de llegar a su regla.
      [/@@@@/, 'text'],

      // Expresión explícita: @(...)
      [/(@)(\()/, ['delimiter.razor', { token: 'delimiter.parenthesis', next: '@razorParen' }]],

      // Bloque anónimo: @{ ... }
      [/(@)(\{)/, ['delimiter.razor', { token: 'delimiter.curly', next: '@razorBlock' }]],

      // `@using (x) { }` es un bloque de control; `@using System.Text;` es una directiva de
      // import. Sólo el paréntesis los distingue, así que se mira por delante.
      [/(@)(using)(?=\s*\()/, ['delimiter.razor', { token: 'keyword.control.razor', next: '@razorControl' }]],

      // Bloques de control: @if, @foreach, @while...
      [
        /(@)(else if|if|else|foreach|for|while|switch|try|catch|finally|lock|do)(?![\w-])/,
        ['delimiter.razor', { token: 'keyword.control.razor', next: '@razorControl' }],
      ],

      // Directiva conocida: @page, @code, @inject...
      //
      // Se usa la alternación que Monarch genera a partir del atributo `directives` en lugar de
      // un `{ cases: ... }` dentro de la acción de un grupo: esa forma compila pero no resuelve
      // en tiempo de ejecución, y el resultado es que TODO el archivo cae en la regla comodín.
      [
        /(@)(@directivesPattern)(?![\w-])/,
        ['delimiter.razor', { token: 'keyword.directive.razor', next: '@directiveLine' }],
      ],

      // Cualquier otra cosa tras @ es una expresión implícita: @Model.Nombre, @item.Precio
      [/(@)([a-zA-Z_]\w*)/, ['delimiter.razor', { token: 'identifier.razor', next: '@razorExpression' }]],

      { include: '@htmlTags' },

      [/[^<@]+/, 'text'],
      [/./, 'text'],
    ],

    htmlTags: [
      [/<!DOCTYPE/, { token: 'metatag.html', next: '@doctype' }],
      [/<!--/, { token: 'comment.html', next: '@htmlComment' }],
      // Los componentes Blazor empiezan por mayúscula: se resaltan distinto de las etiquetas HTML.
      [/(<)(\/?)([A-Z][\w.]*)/, ['delimiter.html', 'delimiter.html', { token: 'tag.component.razor', next: '@tag' }]],
      [/(<)(\/?)([a-z][\w:-]*)/, ['delimiter.html', 'delimiter.html', { token: 'tag.html', next: '@tag' }]],
      [/</, 'delimiter.html'],
    ],

    razorComment: [
      [/\*@/, { token: 'comment.razor', next: '@pop' }],
      [/[^*]+/, 'comment.razor'],
      [/./, 'comment.razor'],
    ],

    // Resto de la línea de una directiva: es C#, salvo la ruta de @page, que es una cadena.
    directiveLine: [
      [/\{/, { token: 'delimiter.curly', next: '@razorBlock' }],
      [/"([^"\\]|\\.)*"/, 'string.razor'],
      [/\b\d[\d_]*(\.\d+)?\b/, 'number.cs'],
      [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword.cs', '@default': 'identifier.cs' } }],
      [/[<>()[\].,;:]/, 'delimiter'],
      [/\s+/, ''],
      [/$/, { token: '', next: '@pop' }],
      [/./, 'identifier.cs'],
    ],

    /**
     * Bloque de control: `@foreach (var x in xs) { ... }`.
     *
     * Se mantiene vivo entre la condición y el cuerpo para que `} else {` siga reconociéndose,
     * y se abandona en cuanto aparece algo que no forma parte de la construcción.
     */
    razorControl: [
      [/\(/, { token: 'delimiter.parenthesis', next: '@razorParen' }],
      [/\{/, { token: 'delimiter.curly', next: '@razorBlock' }],
      [/\s+/, ''],
      [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword.cs', '@default': 'identifier.cs' } }],
      [/./, { token: '@rematch', next: '@pop' }],
    ],

    // Expresión implícita: @item.Precio, @Model.Nombre
    razorExpression: [
      [/[a-zA-Z_]\w*/, 'identifier.cs'],
      [/\./, 'delimiter'],
      [/\(/, { token: 'delimiter.parenthesis', next: '@razorParen' }],
      [/\[/, { token: 'delimiter.square', next: '@razorBracket' }],
      [/$/, { token: '', next: '@pop' }],
      // Cualquier otra cosa cierra la expresión y se vuelve a procesar en el estado anterior.
      [/./, { token: '@rematch', next: '@pop' }],
    ],

    razorParen: [
      [/\)/, { token: 'delimiter.parenthesis', next: '@pop' }],
      [/\(/, { token: 'delimiter.parenthesis', next: '@razorParen' }],
      { include: '@csharpCommon' },
    ],

    razorBracket: [
      [/\]/, { token: 'delimiter.square', next: '@pop' }],
      { include: '@csharpCommon' },
    ],

    // Bloque de código C#. Puede contener HTML anidado (el caso de @foreach { <li>...</li> }).
    razorBlock: [
      [/\}/, { token: 'delimiter.curly', next: '@pop' }],
      [/\{/, { token: 'delimiter.curly', next: '@razorBlock' }],
      [/@\*/, { token: 'comment.razor', next: '@razorComment' }],
      [/@@@@/, 'text'],
      // Dentro de un bloque también hay transiciones a Razor: `<li>@item.Nombre</li>`.
      // Va antes que csharpCommon para que el `@` no quede sin token, pero después de la regla
      // de cadenas verbatim (`@"..."`), que csharpCommon resuelve por su cuenta.
      [/(@)(?=[a-zA-Z_])/, 'delimiter.razor'],
      { include: '@htmlTags' },
      { include: '@csharpCommon' },
    ],

    csharpCommon: [
      [/\/\/.*$/, 'comment.cs'],
      [/\/\*/, { token: 'comment.cs', next: '@csharpBlockComment' }],
      [/"""/, { token: 'string.cs', next: '@rawString' }],
      [/\$?@?"/, { token: 'string.cs', next: '@csharpString' }],
      [/'(\\.|[^'\\])'/, 'string.cs'],
      [/\b\d[\d_]*(\.\d+)?([eE][-+]?\d+)?[fFdDmMlLuU]*\b/, 'number.cs'],
      [/\b[A-Z][A-Za-z0-9_]*\b/, 'type.cs'],
      [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword.cs', '@default': 'identifier.cs' } }],
      [/[+\-*/%=!<>&|^~?:]+/, 'operator.cs'],
      [/[;,.]/, 'delimiter'],
      [/[()[\]]/, 'delimiter.parenthesis'],
      [/\s+/, ''],
    ],

    csharpBlockComment: [
      [/\*\//, { token: 'comment.cs', next: '@pop' }],
      [/[^*]+/, 'comment.cs'],
      [/./, 'comment.cs'],
    ],

    csharpString: [
      [/[^\\"]+/, 'string.cs'],
      [/\\./, 'string.escape.cs'],
      [/"/, { token: 'string.cs', next: '@pop' }],
    ],

    rawString: [
      [/"""/, { token: 'string.cs', next: '@pop' }],
      [/./, 'string.cs'],
    ],

    tag: [
      [/\/?>/, { token: 'delimiter.html', next: '@pop' }],
      // Atributos de Blazor: @onclick, @bind-Value, @key
      [/@[a-zA-Z_][\w.-]*/, 'attribute.razor'],
      [/([\w@:.-]+)(\s*=\s*)("[^"]*"|'[^']*')/, ['attribute.name.html', 'delimiter', 'attribute.value.html']],
      [/[\w@:.-]+/, 'attribute.name.html'],
      [/\s+/, ''],
      [/./, 'delimiter.html'],
    ],

    htmlComment: [
      [/-->/, { token: 'comment.html', next: '@pop' }],
      [/[^-]+/, 'comment.html'],
      [/./, 'comment.html'],
    ],

    doctype: [
      [/>/, { token: 'metatag.html', next: '@pop' }],
      [/[^>]+/, 'metatag.html'],
    ],
  },
};
