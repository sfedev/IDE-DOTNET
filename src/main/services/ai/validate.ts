/**
 * Validación de la petición que llega del renderer.
 *
 * `ipcRenderer.invoke` puede llamarse con cualquier cosa, así que aquí no se confía en nada:
 * cada campo se comprueba y se recorta a un tamaño razonable antes de llegar a un `fetch` con la
 * clave de API del usuario dentro. Un contexto sin tope sería una forma barata de convertir un
 * fallo del renderer en una factura.
 *
 * Es lógica pura para poder probarla con Node puro, sin Electron.
 */
import type {
  AiContext,
  AiDiagnosticContext,
  AiMessage,
  AiProjectContext,
  AiChatRequest,
  AiTask,
} from '../../../shared/ai.js';
import { EMPTY_AI_CONTEXT } from '../../../shared/ai.js';
import { MAX_DIAGNOSTICS, MAX_FILE_CHARS, MAX_SELECTION_CHARS } from '../../../shared/ai-context.js';

/** Turnos que se aceptan en una conversación. Más historial no cabe ni aporta. */
export const MAX_MESSAGES = 40;

/** Tope de un mensaje escrito por el usuario. */
export const MAX_MESSAGE_CHARS = 32_000;

const TASKS: readonly AiTask[] = ['chat', 'explain', 'tests', 'fix', 'edit'];
const ARCHITECTURES = ['clean', 'hexagonal', 'ddd', 'unknown'] as const;
const SEVERITIES = ['error', 'warning', 'info'] as const;

export class AiRequestError extends Error {}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiRequestError(`"${name}" debe ser un objeto`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function positiveInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : 1;
}

function coerceMessages(raw: unknown): AiMessage[] {
  if (!Array.isArray(raw)) throw new AiRequestError('"messages" debe ser un array');

  const messages = raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .filter((entry) => entry['role'] === 'user' || entry['role'] === 'assistant')
    .map((entry) => ({
      role: entry['role'] as AiMessage['role'],
      content: text(entry['content'], MAX_MESSAGE_CHARS),
    }))
    .filter((message) => message.content.trim() !== '')
    // Se conservan los últimos turnos: el final de la conversación es lo que da contexto.
    .slice(-MAX_MESSAGES);

  if (messages.length === 0) throw new AiRequestError('la conversación no tiene ningún mensaje');
  if (messages[messages.length - 1]?.role !== 'user') {
    throw new AiRequestError('la conversación debe terminar en un mensaje del usuario');
  }

  return messages;
}

function coerceContext(raw: unknown): AiContext {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_AI_CONTEXT };
  const source = raw as Record<string, unknown>;

  const architecture = ARCHITECTURES.includes(source['architecture'] as never)
    ? (source['architecture'] as AiContext['architecture'])
    : 'unknown';

  const fileRaw = typeof source['file'] === 'object' && source['file'] !== null
    ? (source['file'] as Record<string, unknown>)
    : null;

  const file = fileRaw && typeof fileRaw['path'] === 'string'
    ? {
        path: fileRaw['path'],
        relativePath: text(fileRaw['relativePath'], 512) || fileRaw['path'],
        languageId: text(fileRaw['languageId'], 40) || 'plaintext',
        text: text(fileRaw['text'], MAX_FILE_CHARS),
        truncated: fileRaw['truncated'] === true,
      }
    : null;

  const selectionRaw = typeof source['selection'] === 'object' && source['selection'] !== null
    ? (source['selection'] as Record<string, unknown>)
    : null;

  const selection = selectionRaw && typeof selectionRaw['text'] === 'string' && selectionRaw['text'].trim() !== ''
    ? {
        startLine: positiveInteger(selectionRaw['startLine']),
        endLine: positiveInteger(selectionRaw['endLine']),
        text: selectionRaw['text'].slice(0, MAX_SELECTION_CHARS),
      }
    : null;

  const projects: AiProjectContext[] = Array.isArray(source['projects'])
    ? source['projects']
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .slice(0, 40)
        .map((entry) => ({ name: text(entry['name'], 160), layer: text(entry['layer'], 60) }))
        .filter((project) => project.name !== '')
    : [];

  const diagnostics: AiDiagnosticContext[] = Array.isArray(source['diagnostics'])
    ? source['diagnostics']
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .slice(0, MAX_DIAGNOSTICS)
        .map((entry) => ({
          file: typeof entry['file'] === 'string' ? entry['file'].slice(0, 512) : null,
          line: positiveInteger(entry['line']),
          severity: SEVERITIES.includes(entry['severity'] as never)
            ? (entry['severity'] as AiDiagnosticContext['severity'])
            : 'error',
          code: text(entry['code'], 32),
          message: text(entry['message'], 600),
        }))
    : [];

  return {
    architecture,
    solutionName: typeof source['solutionName'] === 'string' ? source['solutionName'].slice(0, 200) : null,
    projects,
    file,
    selection,
    diagnostics,
  };
}

/** Normaliza la petición del renderer o lanza `AiRequestError` con un motivo concreto. */
export function coerceChatRequest(raw: unknown): AiChatRequest {
  const source = requireRecord(raw, 'request');

  // No se recorta: un id truncado seguiría siendo válido pero ya no casaría con el que espera el
  // renderer, y los deltas irían a una conversación que no los reclama.
  const requestId = typeof source['requestId'] === 'string' ? source['requestId'] : '';
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(requestId)) {
    throw new AiRequestError('"requestId" debe ser un identificador alfanumérico');
  }

  const task = TASKS.includes(source['task'] as AiTask) ? (source['task'] as AiTask) : 'chat';

  return {
    requestId,
    task,
    messages: coerceMessages(source['messages']),
    context: coerceContext(source['context']),
  };
}
