/**
 * Parseo incremental de la respuesta en streaming de cada proveedor.
 *
 * Los tres formatos son distintos —SSE con tipos de evento en Anthropic, SSE con `[DONE]` en
 * OpenAI y NDJSON a secas en Ollama— pero el problema es el mismo: los trozos que entrega la red
 * no respetan los límites de línea. Un `data: {"type":"content_bl` es normal, y un parser que
 * asuma líneas completas se come tokens de forma intermitente e irreproducible.
 *
 * Por eso el parser guarda su propio búfer y sólo procesa líneas terminadas. Es lógica pura, sin
 * red, así que las pruebas pueden trocear una respuesta real por caracteres sueltos y comprobar
 * que el texto reconstruido es idéntico.
 */
import type { AiProviderId, AiUsage } from '../../../shared/ai.js';

export type AiStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: AiUsage }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface StreamParser {
  /** Procesa un trozo de la respuesta y devuelve los eventos completos que contenía. */
  push(chunk: string): AiStreamEvent[];
  /** Cierra el búfer al terminar la respuesta: procesa una última línea sin salto final. */
  flush(): AiStreamEvent[];
}

/** Divide en líneas completas y conserva el resto para la siguiente vuelta. */
class LineBuffer {
  private buffer = '';

  take(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  drain(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() === '' ? [] : [rest];
  }
}

function parseJson(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    // Una línea que no es JSON válido no debe tumbar la conversación entera: se ignora.
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function createStreamParser(provider: AiProviderId): StreamParser {
  switch (provider) {
    case 'anthropic':
      return new AnthropicParser();
    case 'openai':
      return new OpenAiParser();
    case 'ollama':
      return new OllamaParser();
    default:
      throw new Error(`proveedor de IA no soportado: ${String(provider)}`);
  }
}

/**
 * Anthropic: SSE con `event:` + `data:`.
 *
 * El tipo va también dentro del JSON, así que se ignora la línea `event:` y se decide por el
 * campo `type` del cuerpo: una fuente de verdad en vez de dos que pueden discrepar.
 */
class AnthropicParser implements StreamParser {
  private readonly lines = new LineBuffer();
  private input = 0;
  private output = 0;

  push(chunk: string): AiStreamEvent[] {
    return this.consume(this.lines.take(chunk));
  }

  flush(): AiStreamEvent[] {
    return this.consume(this.lines.drain());
  }

  private consume(lines: string[]): AiStreamEvent[] {
    const events: AiStreamEvent[] = [];

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;

      const payload = parseJson(line.slice('data:'.length).trim());
      if (!payload) continue;

      switch (payload['type']) {
        case 'content_block_delta': {
          const delta = asRecord(payload['delta']);
          // `thinking_delta` se descarta: el razonamiento no es la respuesta.
          if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            events.push({ type: 'text', text: delta['text'] });
          }
          break;
        }
        case 'message_start': {
          const usage = asRecord(asRecord(payload['message'])?.['usage']);
          this.input = asNumber(usage?.['input_tokens']);
          break;
        }
        case 'message_delta': {
          const usage = asRecord(payload['usage']);
          this.output = asNumber(usage?.['output_tokens']);
          break;
        }
        case 'message_stop':
          events.push({ type: 'usage', usage: { inputTokens: this.input, outputTokens: this.output } });
          events.push({ type: 'done' });
          break;
        case 'error': {
          const error = asRecord(payload['error']);
          events.push({ type: 'error', message: describeApiError(error) });
          break;
        }
        default:
          break;
      }
    }

    return events;
  }
}

/** OpenAI: SSE con `data:` y un centinela `[DONE]`. */
class OpenAiParser implements StreamParser {
  private readonly lines = new LineBuffer();

  push(chunk: string): AiStreamEvent[] {
    return this.consume(this.lines.take(chunk));
  }

  flush(): AiStreamEvent[] {
    return this.consume(this.lines.drain());
  }

  private consume(lines: string[]): AiStreamEvent[] {
    const events: AiStreamEvent[] = [];

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();

      if (payload === '[DONE]') {
        events.push({ type: 'done' });
        continue;
      }

      const parsed = parseJson(payload);
      if (!parsed) continue;

      if (parsed['error']) {
        events.push({ type: 'error', message: describeApiError(asRecord(parsed['error'])) });
        continue;
      }

      const choices = Array.isArray(parsed['choices']) ? parsed['choices'] : [];
      for (const choice of choices) {
        const delta = asRecord(asRecord(choice)?.['delta']);
        if (typeof delta?.['content'] === 'string' && delta['content'] !== '') {
          events.push({ type: 'text', text: delta['content'] });
        }
      }

      const usage = asRecord(parsed['usage']);
      if (usage) {
        events.push({
          type: 'usage',
          usage: {
            inputTokens: asNumber(usage['prompt_tokens']),
            outputTokens: asNumber(usage['completion_tokens']),
          },
        });
      }
    }

    return events;
  }
}

/** Ollama: un JSON por línea, sin prefijo `data:`. */
class OllamaParser implements StreamParser {
  private readonly lines = new LineBuffer();

  push(chunk: string): AiStreamEvent[] {
    return this.consume(this.lines.take(chunk));
  }

  flush(): AiStreamEvent[] {
    return this.consume(this.lines.drain());
  }

  private consume(lines: string[]): AiStreamEvent[] {
    const events: AiStreamEvent[] = [];

    for (const line of lines) {
      if (line.trim() === '') continue;
      const payload = parseJson(line);
      if (!payload) continue;

      if (typeof payload['error'] === 'string') {
        events.push({ type: 'error', message: payload['error'] });
        continue;
      }

      const message = asRecord(payload['message']);
      if (typeof message?.['content'] === 'string' && message['content'] !== '') {
        events.push({ type: 'text', text: message['content'] });
      }

      if (payload['done'] === true) {
        events.push({
          type: 'usage',
          usage: {
            inputTokens: asNumber(payload['prompt_eval_count']),
            outputTokens: asNumber(payload['eval_count']),
          },
        });
        events.push({ type: 'done' });
      }
    }

    return events;
  }
}

/**
 * Mensaje legible del error que devuelve un proveedor.
 *
 * Los tres usan formas distintas (`{type, message}`, `{message, code}`, una cadena suelta) y el
 * usuario sólo quiere saber qué le pasa a su clave o a su cuota.
 */
export function describeApiError(error: Record<string, unknown> | null): string {
  if (!error) return 'el proveedor ha devuelto un error sin detalle';

  const message = typeof error['message'] === 'string' ? error['message'] : null;
  const type = typeof error['type'] === 'string' ? error['type'] : null;
  const code = typeof error['code'] === 'string' ? error['code'] : null;

  const detail = message ?? type ?? code;
  if (!detail) return 'el proveedor ha devuelto un error sin detalle';

  return type && message ? `${type}: ${message}` : detail;
}

/** Traduce un código HTTP a algo accionable, que es lo único que sirve en una barra de estado. */
export function describeHttpStatus(status: number, provider: AiProviderId, detail: string): string {
  const suffix = detail.trim() === '' ? '' : ` — ${detail.trim()}`;

  switch (status) {
    case 401:
    case 403:
      return `la clave de API de ${provider} no es válida o no tiene permisos (${status})${suffix}`;
    case 404:
      return `el endpoint o el modelo no existe (${status})${suffix}`;
    case 429:
      return `se ha superado el límite de peticiones de ${provider} (429). Espera unos segundos${suffix}`;
    default:
      return status >= 500
        ? `el proveedor ${provider} ha fallado (${status}). Vuelve a intentarlo${suffix}`
        : `petición rechazada por ${provider} (${status})${suffix}`;
  }
}
