/**
 * Micro motor de plantillas de DotForge.
 *
 * Soporta lo justo para generar código .NET de forma legible y verificable:
 *   {{Token}}                       sustitución (falla si el token no existe)
 *   {{#if flag}} ... {{/if}}        condicional (anidable)
 *   {{#if flag}} ... {{else}} ...   rama alternativa
 *   {{#unless flag}} ... {{/unless}}negación
 *
 * Decisiones de diseño:
 * - Estricto por defecto: un token desconocido lanza un error con línea y nombre. Un typo en una
 *   plantilla debe romper el test, no colarse hasta el `dotnet build`.
 * - Sin evaluación de expresiones. Las condiciones son nombres de flags booleanos precalculados
 *   por el generador. Nada de `eval`, nada de lógica en las plantillas.
 * - Independiente de Node: sólo strings. Se puede testear sin tocar el sistema de archivos.
 */

export type TemplateScalar = string | number;

export interface TemplateContext {
  /** Valores sustituibles con {{Token}}. */
  tokens: Record<string, TemplateScalar>;
  /** Flags booleanos evaluables con {{#if}} / {{#unless}}. */
  flags: Record<string, boolean>;
}

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly offset: number,
  ) {
    const line = source.slice(0, offset).split('\n').length;
    super(`${message} (línea ${line})`);
    this.name = 'TemplateError';
  }
}

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'token'; name: string; offset: number }
  | { kind: 'cond'; flag: string; negate: boolean; offset: number; then: Node[]; otherwise: Node[] };

const TAG = /\{\{\s*(?:(#if|#unless|\/if|\/unless|else)\s*([A-Za-z0-9_]*)|([A-Za-z0-9_]+))\s*\}\}/g;

/** Convierte la plantilla en un AST. Lanza TemplateError ante etiquetas desbalanceadas. */
export function parseTemplate(source: string): Node[] {
  TAG.lastIndex = 0;

  interface Frame {
    flag: string;
    negate: boolean;
    offset: number;
    then: Node[];
    otherwise: Node[];
    inElse: boolean;
  }

  const root: Node[] = [];
  const stack: Frame[] = [];
  let cursor = 0;

  const target = (): Node[] => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.inElse ? top.otherwise : top.then;
  };

  const pushText = (value: string): void => {
    if (value.length > 0) target().push({ kind: 'text', value });
  };

  let match: RegExpExecArray | null;
  while ((match = TAG.exec(source)) !== null) {
    pushText(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const directive = match[1];
    const directiveArg = match[2] ?? '';
    const tokenName = match[3];

    if (tokenName !== undefined) {
      target().push({ kind: 'token', name: tokenName, offset: match.index });
      continue;
    }

    switch (directive) {
      case '#if':
      case '#unless': {
        if (!directiveArg) {
          throw new TemplateError(`${directive} requiere un nombre de flag`, source, match.index);
        }
        stack.push({
          flag: directiveArg,
          negate: directive === '#unless',
          offset: match.index,
          then: [],
          otherwise: [],
          inElse: false,
        });
        break;
      }
      case 'else': {
        const top = stack[stack.length - 1];
        if (!top) throw new TemplateError('{{else}} fuera de un condicional', source, match.index);
        if (top.inElse) throw new TemplateError('{{else}} duplicado', source, match.index);
        top.inElse = true;
        break;
      }
      case '/if':
      case '/unless': {
        const top = stack.pop();
        if (!top) {
          throw new TemplateError(`{{${directive}}} sin apertura`, source, match.index);
        }
        const expected = top.negate ? '/unless' : '/if';
        if (directive !== expected) {
          throw new TemplateError(
            `cierre incorrecto: se esperaba {{${expected}}} y llegó {{${directive}}}`,
            source,
            match.index,
          );
        }
        target().push({
          kind: 'cond',
          flag: top.flag,
          negate: top.negate,
          offset: top.offset,
          then: top.then,
          otherwise: top.otherwise,
        });
        break;
      }
      default:
        throw new TemplateError(`directiva desconocida: ${directive}`, source, match.index);
    }
  }

  pushText(source.slice(cursor));

  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw new TemplateError(
      `condicional sin cerrar sobre el flag "${unclosed.flag}"`,
      source,
      unclosed.offset,
    );
  }

  return root;
}

function renderNodes(nodes: Node[], ctx: TemplateContext, source: string, out: string[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out.push(node.value);
        break;
      case 'token': {
        const value = ctx.tokens[node.name];
        if (value === undefined) {
          const known = Object.keys(ctx.tokens).sort().join(', ');
          throw new TemplateError(
            `token desconocido "${node.name}". Tokens disponibles: ${known}`,
            source,
            node.offset,
          );
        }
        out.push(String(value));
        break;
      }
      case 'cond': {
        const raw = ctx.flags[node.flag];
        if (raw === undefined) {
          const known = Object.keys(ctx.flags).sort().join(', ');
          throw new TemplateError(
            `flag desconocido "${node.flag}". Flags disponibles: ${known}`,
            source,
            node.offset,
          );
        }
        const active = node.negate ? !raw : raw;
        renderNodes(active ? node.then : node.otherwise, ctx, source, out);
        break;
      }
    }
  }
}

/** Renderiza una plantilla completa. */
export function renderTemplate(source: string, ctx: TemplateContext): string {
  const ast = parseTemplate(source);
  const out: string[] = [];
  renderNodes(ast, ctx, source, out);
  return normalizeOutput(out.join(''));
}

/**
 * Limpia el residuo típico de los condicionales: líneas que sólo contenían una directiva
 * quedan como líneas en blanco. Se colapsan runs de 3+ saltos a 2 y se garantiza salto final.
 */
export function normalizeOutput(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

/**
 * Sustituye tokens en una ruta de plantilla. Usa el estilo `__Token__` porque `{{ }}` no es
 * válido en nombres de archivo en Windows.
 *
 *   src/__Solution__.Domain/__Entity__.cs  ->  src/Acme.Shop.Domain/Product.cs
 */
export function renderPath(templatePath: string, tokens: Record<string, TemplateScalar>): string {
  return templatePath.replace(/__([A-Za-z0-9_]+)__/g, (whole, name: string) => {
    const value = tokens[name];
    if (value === undefined) {
      throw new Error(`token de ruta desconocido "${name}" en "${templatePath}"`);
    }
    return String(value);
  });
}

/** Lista los tokens y flags referenciados por una plantilla. Lo usan los tests de cobertura. */
export function inspectTemplate(source: string): { tokens: string[]; flags: string[] } {
  const tokens = new Set<string>();
  const flags = new Set<string>();
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (node.kind === 'token') tokens.add(node.name);
      else if (node.kind === 'cond') {
        flags.add(node.flag);
        walk(node.then);
        walk(node.otherwise);
      }
    }
  };
  walk(parseTemplate(source));
  return { tokens: [...tokens].sort(), flags: [...flags].sort() };
}
