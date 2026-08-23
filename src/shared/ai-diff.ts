/**
 * Extracción de código y cálculo de diferencias de las respuestas del modelo.
 *
 * El asistente en línea (Ctrl+I) promete algo muy concreto: enseñar exactamente qué va a cambiar
 * antes de tocar el archivo. Para eso hacen falta tres cosas que aquí son funciones puras y por
 * tanto probables sin abrir una ventana:
 *
 *  1. sacar el bloque de código de una respuesta que puede venir con prosa alrededor,
 *  2. reindentarlo para que encaje donde estaba el fragmento sustituido,
 *  3. compararlo línea a línea con el original.
 *
 * El paso 2 no es cosmético: un modelo devuelve casi siempre el código pegado al margen, y
 * pegarlo tal cual dentro de un método deja un archivo que no compila bien y que el usuario
 * rechaza por motivos que no tienen nada que ver con la calidad de la sugerencia.
 */

export interface CodeBlock {
  /** Lenguaje declarado en la valla, en minúsculas. Vacío si no venía. */
  language: string;
  code: string;
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*$/;

/**
 * Bloques de código de un texto en Markdown.
 *
 * Se admiten vallas de tres o más caracteres y de los dos tipos (` y ~), y se respeta la
 * indentación de la valla de apertura: un bloque dentro de una lista viene sangrado y sus líneas
 * llevan esa sangría de más, que no es parte del código.
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: CodeBlock[] = [];

  let open: { indent: string; marker: string; language: string; body: string[] } | null = null;

  for (const line of lines) {
    const match = FENCE.exec(line);

    if (open === null) {
      if (match) {
        open = { indent: match[1] ?? '', marker: match[2] ?? '```', language: (match[3] ?? '').toLowerCase(), body: [] };
      }
      continue;
    }

    // Cierra sólo una valla del mismo tipo y al menos igual de larga que la de apertura.
    const closes =
      match !== null &&
      (match[3] ?? '') === '' &&
      (match[2] ?? '').startsWith(open.marker[0] ?? '`') &&
      (match[2] ?? '').length >= open.marker.length;

    if (closes) {
      blocks.push({ language: open.language, code: open.body.join('\n') });
      open = null;
      continue;
    }

    open.body.push(line.startsWith(open.indent) ? line.slice(open.indent.length) : line);
  }

  // Una valla sin cerrar es lo que ocurre cuando la respuesta se corta por `max_tokens`. Se
  // conserva lo que llegó: media sugerencia visible es más útil que un error genérico.
  if (open !== null && open.body.length > 0) {
    blocks.push({ language: open.language, code: open.body.join('\n') });
  }

  return blocks;
}

/**
 * Código propuesto por el modelo, o null si la respuesta no traía ninguno.
 *
 * Se prefiere el primer bloque de un lenguaje conocido: una respuesta puede empezar enseñando el
 * error en un bloque `text` o `bash` y traer la solución después.
 */
export function proposedCode(text: string, preferredLanguages: readonly string[] = CODE_LANGUAGES): string | null {
  const blocks = extractCodeBlocks(text);
  if (blocks.length === 0) return null;

  const preferred = blocks.find((block) => preferredLanguages.includes(block.language));
  const chosen = preferred ?? blocks[0];
  const code = (chosen?.code ?? '').replace(/\s+$/, '');

  return code.trim() === '' ? null : code;
}

export const CODE_LANGUAGES: readonly string[] = ['csharp', 'cs', 'c#', 'razor', 'cshtml', 'xml', 'json'];

// ---------------------------------------------------------------------------------------------
// Indentación
// ---------------------------------------------------------------------------------------------

/** Sangría común a todas las líneas no vacías. */
export function commonIndent(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return '';

  let indent: string | null = null;
  for (const line of lines) {
    const current = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (indent === null) {
      indent = current;
      continue;
    }
    let index = 0;
    while (index < indent.length && index < current.length && indent[index] === current[index]) index++;
    indent = indent.slice(0, index);
  }

  return indent ?? '';
}

/**
 * Reindenta `replacement` para que encaje donde estaba `original`.
 *
 * Hay dos formas de haber seleccionado el mismo código y sólo se distinguen por la columna en la
 * que empieza la selección. Si empieza en la columna 1, la sangría de la primera línea forma parte
 * del texto que se sustituye y hay que reponerla; si empieza después (el caso habitual: doble clic
 * sobre un identificador, o `Ctrl+I` con el cursor dentro del método), el hueco ya está en el
 * archivo y volver a ponerlo desplazaría la línea.
 *
 * `keepFirstLineIndent` es esa distinción. Sin ella, un `Ctrl+I` sobre líneas completas devolvía
 * la primera línea pegada al margen.
 */
export function reindent(original: string, replacement: string, keepFirstLineIndent = false): string {
  const target = commonIndent(original);
  const source = commonIndent(replacement);

  const lines = replacement.split(/\r?\n/).map((line) => {
    if (line.trim() === '') return '';
    const stripped = source !== '' && line.startsWith(source) ? line.slice(source.length) : line;
    return `${target}${stripped}`;
  });

  if (!keepFirstLineIndent) {
    // La primera línea hereda el hueco que ya dejó la selección.
    const first = lines[0] ?? '';
    lines[0] = first.startsWith(target) ? first.slice(target.length) : first;
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Diferencias
// ---------------------------------------------------------------------------------------------

export type DiffKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** Número de línea en el original (1-based) o null si es una adición. */
  beforeLine: number | null;
  /** Número de línea en la propuesta (1-based) o null si es una eliminación. */
  afterLine: number | null;
}

export interface DiffSummary {
  added: number;
  removed: number;
  /** true si las dos versiones son idénticas: no hay nada que aceptar. */
  identical: boolean;
}

/** Por encima de esto la subsecuencia común más larga cuesta demasiada memoria. */
const MAX_DIFF_LINES = 1500;

/**
 * Diferencia línea a línea por subsecuencia común más larga.
 *
 * Para fragmentos grandes se degrada a "todo fuera, todo dentro", que sigue siendo correcto y no
 * bloquea el renderer durante segundos. El asistente en línea trabaja sobre selecciones, así que
 * el caso normal está muy por debajo del límite.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const source = before.split(/\r?\n/);
  const target = after.split(/\r?\n/);

  if (source.length > MAX_DIFF_LINES || target.length > MAX_DIFF_LINES) {
    return [
      ...source.map((text, index) => ({ kind: 'remove' as const, text, beforeLine: index + 1, afterLine: null })),
      ...target.map((text, index) => ({ kind: 'add' as const, text, beforeLine: null, afterLine: index + 1 })),
    ];
  }

  // lcs[i][j] = longitud de la subsecuencia común de source[i..] y target[j..].
  const lcs: number[][] = Array.from({ length: source.length + 1 }, () => new Array<number>(target.length + 1).fill(0));

  for (let i = source.length - 1; i >= 0; i--) {
    for (let j = target.length - 1; j >= 0; j--) {
      const row = lcs[i];
      const next = lcs[i + 1];
      if (!row || !next) continue;
      row[j] = source[i] === target[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < source.length && j < target.length) {
    if (source[i] === target[j]) {
      result.push({ kind: 'context', text: source[i] ?? '', beforeLine: i + 1, afterLine: j + 1 });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      result.push({ kind: 'remove', text: source[i] ?? '', beforeLine: i + 1, afterLine: null });
      i++;
    } else {
      result.push({ kind: 'add', text: target[j] ?? '', beforeLine: null, afterLine: j + 1 });
      j++;
    }
  }

  while (i < source.length) {
    result.push({ kind: 'remove', text: source[i] ?? '', beforeLine: i + 1, afterLine: null });
    i++;
  }
  while (j < target.length) {
    result.push({ kind: 'add', text: target[j] ?? '', beforeLine: null, afterLine: j + 1 });
    j++;
  }

  return result;
}

export function summarizeDiff(lines: readonly DiffLine[]): DiffSummary {
  const added = lines.filter((line) => line.kind === 'add').length;
  const removed = lines.filter((line) => line.kind === 'remove').length;
  return { added, removed, identical: added === 0 && removed === 0 };
}

/**
 * Diferencia en formato unificado, con contexto acotado.
 *
 * Se usa para la vista previa en texto y para las pruebas: una cadena estable es mucho más fácil
 * de aseverar que un árbol de nodos del DOM.
 */
export function formatUnifiedDiff(lines: readonly DiffLine[], contextLines = 2): string {
  const marker: Record<DiffKind, string> = { context: ' ', add: '+', remove: '-' };

  // Índices de las líneas que hay que enseñar: los cambios y su contexto.
  const visible = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    for (let offset = -contextLines; offset <= contextLines; offset++) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) visible.add(target);
    }
  });

  const output: string[] = [];
  let previous = -1;

  for (let index = 0; index < lines.length; index++) {
    if (!visible.has(index)) continue;
    if (previous !== -1 && index > previous + 1) output.push('@@');

    const line = lines[index];
    if (line) output.push(`${marker[line.kind]}${line.text}`);
    previous = index;
  }

  return output.join('\n');
}
