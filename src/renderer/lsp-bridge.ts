/**
 * Puente entre el servidor de lenguaje y Monaco.
 *
 * El renderer no habla con el servidor: envía peticiones al proceso principal, que las reenvía
 * por stdio. Aquí sólo se traducen estructuras LSP a estructuras de Monaco y viceversa.
 *
 * Todo degrada con elegancia: si el servidor no está listo, cada proveedor devuelve "sin
 * resultados" en vez de lanzar. El editor sigue siendo utilizable con resaltado y snippets.
 */
import type * as MonacoApi from 'monaco-editor';

// ---------------------------------------------------------------------------------------------
// Conversión de rutas <-> URIs
// ---------------------------------------------------------------------------------------------

/**
 * Ruta del sistema a URI `file:`.
 * Windows necesita una barra extra y conservar la letra de unidad: `C:\a\b` -> `file:///c%3A/a/b`.
 */
export function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const withRoot = /^[a-zA-Z]:/.test(normalized) ? `/${normalized}` : normalized;
  return `file://${withRoot.split('/').map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment))).join('/')}`;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;

  let path = decodeURIComponent(uri.slice('file://'.length));
  if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);

  // En Windows conviene devolver separadores nativos: es lo que espera el resto de la app.
  return navigator.platform.toLowerCase().includes('win') ? path.replace(/\//g, '\\') : path;
}

// ---------------------------------------------------------------------------------------------
// Conversión de posiciones y rangos
// ---------------------------------------------------------------------------------------------

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** LSP cuenta líneas y columnas desde 0; Monaco desde 1. */
function toLspPosition(position: MonacoApi.IPosition): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toMonacoRange(range: LspRange | undefined, fallback: MonacoApi.IRange): MonacoApi.IRange {
  if (!range) return fallback;
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Tablas de traducción
// ---------------------------------------------------------------------------------------------

/** Índice del array = valor del `CompletionItemKind` de LSP (empieza en 1). */
const COMPLETION_KINDS = [
  'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface',
  'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File',
  'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter',
] as const;

const SYMBOL_KINDS = [
  'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor',
  'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array',
  'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter',
] as const;

/** Severidad de LSP (1 = error) a severidad de marcador de Monaco. */
function markerSeverity(monaco: typeof MonacoApi, severity: number | undefined): MonacoApi.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

function markdown(value: unknown): MonacoApi.IMarkdownString[] {
  if (typeof value === 'string') return [{ value }];

  if (Array.isArray(value)) {
    return value.flatMap((entry) => markdown(entry));
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as { value?: string; kind?: string; language?: string };
    if (typeof record.value === 'string') {
      return record.language
        ? [{ value: `\`\`\`${record.language}\n${record.value}\n\`\`\`` }]
        : [{ value: record.value }];
    }
  }

  return [];
}

// ---------------------------------------------------------------------------------------------
// Ciclo de vida de documentos
// ---------------------------------------------------------------------------------------------

const openDocuments = new Map<string, number>();

export function didOpen(path: string, languageId: string, text: string): void {
  const uri = pathToUri(path);
  const version = 1;
  openDocuments.set(uri, version);

  void window.dotforge.lsp.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: languageId === 'razor' ? 'razor' : languageId, version, text },
  });
}

export function didChange(path: string, text: string): void {
  const uri = pathToUri(path);
  if (!openDocuments.has(uri)) return;

  const version = (openDocuments.get(uri) ?? 1) + 1;
  openDocuments.set(uri, version);

  // Sincronización completa: es lo que anuncian nuestras capacidades y evita toda una clase de
  // errores de desincronización por rangos mal calculados.
  void window.dotforge.lsp.notify('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

export function didSave(path: string, text: string): void {
  const uri = pathToUri(path);
  if (!openDocuments.has(uri)) return;
  void window.dotforge.lsp.notify('textDocument/didSave', { textDocument: { uri }, text });
}

export function didClose(path: string): void {
  const uri = pathToUri(path);
  if (!openDocuments.delete(uri)) return;
  void window.dotforge.lsp.notify('textDocument/didClose', { textDocument: { uri } });
}

export function reopenAll(models: Array<{ path: string; languageId: string; text: string }>): void {
  openDocuments.clear();
  for (const model of models) didOpen(model.path, model.languageId, model.text);
}

// ---------------------------------------------------------------------------------------------
// Diagnósticos
// ---------------------------------------------------------------------------------------------

export interface DiagnosticSink {
  (path: string, markers: MonacoApi.editor.IMarkerData[]): void;
}

/** Traduce una notificación `publishDiagnostics` a marcadores de Monaco. */
export function applyPublishDiagnostics(
  monaco: typeof MonacoApi,
  params: unknown,
  sink: DiagnosticSink,
): void {
  if (typeof params !== 'object' || params === null) return;

  const payload = params as {
    uri?: string;
    diagnostics?: Array<{
      range: LspRange;
      severity?: number;
      code?: string | number;
      source?: string;
      message: string;
    }>;
  };

  if (!payload.uri) return;

  const markers: MonacoApi.editor.IMarkerData[] = (payload.diagnostics ?? []).map((diagnostic) => {
    const range = toMonacoRange(diagnostic.range, {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    });

    return {
      severity: markerSeverity(monaco, diagnostic.severity),
      message: diagnostic.message,
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn,
      code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
      source: diagnostic.source ?? 'C#',
    };
  });

  sink(uriToPath(payload.uri), markers);
}

// ---------------------------------------------------------------------------------------------
// Proveedores de Monaco
// ---------------------------------------------------------------------------------------------

async function ask<T>(method: string, params: unknown): Promise<T | null> {
  try {
    return (await window.dotforge.lsp.request(method, params)) as T | null;
  } catch {
    return null;
  }
}

function documentParams(model: MonacoApi.editor.ITextModel, position?: MonacoApi.IPosition): Record<string, unknown> {
  const uri = pathToUri(model.uri.fsPath ?? model.uri.path);
  return position
    ? { textDocument: { uri }, position: toLspPosition(position) }
    : { textDocument: { uri } };
}

/**
 * Registra todos los proveedores del lenguaje C#.
 * Devuelve un disposable agregado para poder desmontarlos al parar el servidor.
 */
export function registerCSharpProviders(monaco: typeof MonacoApi): MonacoApi.IDisposable {
  const disposables: MonacoApi.IDisposable[] = [];
  const languages = ['csharp', 'razor'];

  for (const language of languages) {
    // --- Completado ------------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['.', ' ', '(', '<', '@', '"'],
        async provideCompletionItems(model, position) {
          const result = await ask<{
            items?: Array<Record<string, unknown>>;
            isIncomplete?: boolean;
          } | Array<Record<string, unknown>>>('textDocument/completion', {
            ...documentParams(model, position),
            context: { triggerKind: 1 },
          });

          if (!result) return { suggestions: [] };

          const items = Array.isArray(result) ? result : (result.items ?? []);
          const word = model.getWordUntilPosition(position);
          const defaultRange: MonacoApi.IRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions: MonacoApi.languages.CompletionItem[] = items.map((item) => {
            const textEdit = item['textEdit'] as { range?: LspRange; newText?: string } | undefined;
            const kindIndex = typeof item['kind'] === 'number' ? (item['kind'] as number) - 1 : 0;
            const kindName = COMPLETION_KINDS[kindIndex] ?? 'Text';

            const insertText =
              textEdit?.newText ??
              (item['insertText'] as string | undefined) ??
              (item['label'] as string);

            return {
              label: String(item['label'] ?? ''),
              kind: monaco.languages.CompletionItemKind[kindName],
              detail: item['detail'] as string | undefined,
              documentation: markdown(item['documentation'])[0],
              insertText,
              insertTextRules:
                item['insertTextFormat'] === 2
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
              range: toMonacoRange(textEdit?.range, defaultRange),
              sortText: item['sortText'] as string | undefined,
              filterText: item['filterText'] as string | undefined,
              preselect: item['preselect'] === true,
            };
          });

          return {
            suggestions,
            incomplete: !Array.isArray(result) && result.isIncomplete === true,
          };
        },
      }),
    );

    // --- Hover -------------------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerHoverProvider(language, {
        async provideHover(model, position) {
          const result = await ask<{ contents?: unknown; range?: LspRange }>(
            'textDocument/hover',
            documentParams(model, position),
          );
          if (!result?.contents) return null;

          const contents = markdown(result.contents);
          if (contents.length === 0) return null;

          const range = result.range
            ? toMonacoRange(result.range, {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              })
            : undefined;

          return range ? { contents, range } : { contents };
        },
      }),
    );

    // --- Ayuda de firma ------------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: ['(', ','],
        signatureHelpRetriggerCharacters: [')'],
        async provideSignatureHelp(model, position) {
          const result = await ask<{
            signatures?: Array<{ label: string; documentation?: unknown; parameters?: Array<{ label: string | [number, number]; documentation?: unknown }> }>;
            activeSignature?: number;
            activeParameter?: number;
          }>('textDocument/signatureHelp', documentParams(model, position));

          if (!result?.signatures?.length) return null;

          return {
            value: {
              signatures: result.signatures.map((signature) => ({
                label: signature.label,
                documentation: markdown(signature.documentation)[0],
                parameters: (signature.parameters ?? []).map((parameter) => ({
                  label: parameter.label,
                  documentation: markdown(parameter.documentation)[0],
                })),
              })),
              activeSignature: result.activeSignature ?? 0,
              activeParameter: result.activeParameter ?? 0,
            },
            dispose: () => undefined,
          };
        },
      }),
    );

    // --- Ir a definición -----------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerDefinitionProvider(language, {
        async provideDefinition(model, position) {
          const result = await ask<unknown>('textDocument/definition', documentParams(model, position));
          return toLocationLinks(monaco, result);
        },
      }),
    );

    disposables.push(
      monaco.languages.registerImplementationProvider(language, {
        async provideImplementation(model, position) {
          const result = await ask<unknown>('textDocument/implementation', documentParams(model, position));
          return toLocationLinks(monaco, result);
        },
      }),
    );

    disposables.push(
      monaco.languages.registerTypeDefinitionProvider(language, {
        async provideTypeDefinition(model, position) {
          const result = await ask<unknown>('textDocument/typeDefinition', documentParams(model, position));
          return toLocationLinks(monaco, result);
        },
      }),
    );

    // --- Referencias ---------------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerReferenceProvider(language, {
        async provideReferences(model, position, context) {
          const result = await ask<unknown>('textDocument/references', {
            ...documentParams(model, position),
            context: { includeDeclaration: context.includeDeclaration },
          });
          return toLocationLinks(monaco, result) as MonacoApi.languages.Location[];
        },
      }),
    );

    // --- Símbolos del documento -------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(language, {
        async provideDocumentSymbols(model) {
          const result = await ask<Array<Record<string, unknown>>>(
            'textDocument/documentSymbol',
            documentParams(model),
          );
          if (!Array.isArray(result)) return [];
          return result.map((symbol) => toDocumentSymbol(monaco, symbol));
        },
      }),
    );

    // --- Formateo ------------------------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerDocumentFormattingEditProvider(language, {
        async provideDocumentFormattingEdits(model, options) {
          const result = await ask<Array<{ range: LspRange; newText: string }>>('textDocument/formatting', {
            ...documentParams(model),
            options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
          });
          if (!Array.isArray(result)) return [];

          return result.map((edit) => ({
            range: toMonacoRange(edit.range, {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 1,
            }),
            text: edit.newText,
          }));
        },
      }),
    );

    // --- Renombrado ------------------------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerRenameProvider(language, {
        async provideRenameEdits(model, position, newName) {
          const result = await ask<{ changes?: Record<string, Array<{ range: LspRange; newText: string }>> }>(
            'textDocument/rename',
            { ...documentParams(model, position), newName },
          );

          const edits: MonacoApi.languages.IWorkspaceTextEdit[] = [];

          for (const [uri, changes] of Object.entries(result?.changes ?? {})) {
            for (const change of changes) {
              edits.push({
                resource: monaco.Uri.file(uriToPath(uri)),
                versionId: undefined,
                textEdit: {
                  range: toMonacoRange(change.range, {
                    startLineNumber: 1,
                    startColumn: 1,
                    endLineNumber: 1,
                    endColumn: 1,
                  }),
                  text: change.newText,
                },
              });
            }
          }

          return { edits };
        },
      }),
    );
  }

  return {
    dispose(): void {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}

function toLocationLinks(monaco: typeof MonacoApi, result: unknown): MonacoApi.languages.Location[] {
  if (!result) return [];
  const entries = Array.isArray(result) ? result : [result];

  return entries
    .map((entry) => {
      const record = entry as { uri?: string; targetUri?: string; range?: LspRange; targetRange?: LspRange };
      const uri = record.uri ?? record.targetUri;
      const range = record.range ?? record.targetRange;
      if (!uri || !range) return null;

      return {
        uri: monaco.Uri.file(uriToPath(uri)),
        range: toMonacoRange(range, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
      } satisfies MonacoApi.languages.Location;
    })
    .filter((entry): entry is MonacoApi.languages.Location => entry !== null);
}

function toDocumentSymbol(monaco: typeof MonacoApi, symbol: Record<string, unknown>): MonacoApi.languages.DocumentSymbol {
  const kindIndex = typeof symbol['kind'] === 'number' ? (symbol['kind'] as number) - 1 : 0;
  const kindName = SYMBOL_KINDS[kindIndex] ?? 'Variable';

  const range = toMonacoRange(symbol['range'] as LspRange | undefined, {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
  });

  const children = Array.isArray(symbol['children'])
    ? (symbol['children'] as Array<Record<string, unknown>>).map((child) => toDocumentSymbol(monaco, child))
    : undefined;

  return {
    name: String(symbol['name'] ?? ''),
    detail: String(symbol['detail'] ?? ''),
    kind: monaco.languages.SymbolKind[kindName],
    tags: [],
    range,
    selectionRange: toMonacoRange(symbol['selectionRange'] as LspRange | undefined, range),
    ...(children ? { children } : {}),
  };
}
