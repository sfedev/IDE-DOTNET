/**
 * Soporte del lenguaje de los archivos `.http` / `.rest` en Monaco.
 *
 * Un archivo `.http` es texto plano con cuatro cosas distintas dentro: separadores, variables,
 * una línea de petición, cabeceras y un cuerpo que casi siempre es JSON. Sin colores, todo eso se
 * lee igual de mal que un `.txt`; con colores se distingue de un vistazo dónde acaba una petición
 * y empieza la siguiente.
 *
 * La gramática es deliberadamente sencilla y **se apoya en estados por línea**: tras la línea de
 * petición vienen cabeceras hasta la primera línea en blanco, y a partir de ahí, cuerpo. Esa es
 * exactamente la regla del formato, así que el estado del tokenizador y el del parser coinciden;
 * si algún día divergen, el parser (`src/shared/http-file.ts`) es el que manda.
 */
import type * as MonacoApi from 'monaco-editor';

export const HTTP_LANGUAGE_ID = 'http';

export const httpLanguageConfiguration: MonacoApi.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"', notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
  folding: {
    markers: {
      // Cada `###` abre un pliegue: plegar una petición entera es lo que se quiere hacer.
      start: new RegExp(String.raw`^###`),
      end: new RegExp(String.raw`^###`),
    },
  },
};

/**
 * Gramática Monarch.
 *
 * `{{variable}}` se resalta en cualquier posición —URL, cabecera o cuerpo— porque es lo que hay
 * que ver antes de enviar: una variable sin declarar viaja tal cual y el error llega del servidor,
 * no del editor.
 */
export const httpMonarchTokens: MonacoApi.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.http',
  ignoreCase: false,

  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'],

  tokenizer: {
    root: [
      // Separador de peticiones, con su título opcional.
      [/^###.*$/, 'metatag'],
      [/^\s*(?:#|\/\/).*$/, 'comment'],

      // Variable de archivo: `@base = https://localhost:7001`.
      [/^\s*(@[A-Za-z_][\w-]*)(\s*=\s*)(.*)$/, ['variable', 'delimiter', 'string']],

      // Línea de petición completa: verbo, URL y versión.
      //
      // Se resuelve en una sola regla en vez de con un estado propio a propósito: los estados de
      // Monarch **sobreviven al salto de línea**, así que un estado "url" que no se cierre tiñe
      // de URL todas las cabeceras siguientes. Una regla por línea no puede tener ese fallo.
      [
        /^\s*([A-Z]+)(\s+)(\S+)(.*)$/,
        [{ cases: { '@methods': 'keyword', '@default': '' } }, 'white', 'string.link', 'keyword'],
      ],

      // Una URL suelta sin verbo también es una petición (GET implícito).
      [/^\s*https?:\/\/\S*$/, 'string.link'],

      // Cabecera: `Content-Type: application/json`.
      [/^\s*([A-Za-z][\w-]*)(\s*:\s*)/, ['attribute.name', 'delimiter']],

      { include: '@interpolation' },

      // Cuerpo JSON: lo justo para que se distinga clave de valor.
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/[{}[\],]/, 'delimiter'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/-?\d+(?:\.\d+)?/, 'number'],
    ],

    interpolation: [[/\{\{[^}]*\}\}/, 'variable.predefined']],
  },
};

/** Registra el lenguaje en Monaco. Idempotente: registrarlo dos veces no duplica nada. */
export function registerHttpLanguage(monaco: typeof MonacoApi): void {
  if (monaco.languages.getLanguages().some((language) => language.id === HTTP_LANGUAGE_ID)) return;

  monaco.languages.register({
    id: HTTP_LANGUAGE_ID,
    extensions: ['.http', '.rest'],
    aliases: ['HTTP', 'http', 'rest'],
  });

  monaco.languages.setLanguageConfiguration(HTTP_LANGUAGE_ID, httpLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(HTTP_LANGUAGE_ID, httpMonarchTokens);
}
