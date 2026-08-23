/**
 * Construcción de la petición HTTP de cada proveedor.
 *
 * Es una función pura a propósito: dado (proveedor, modelo, clave, mensajes) devuelve la URL, las
 * cabeceras y el cuerpo, sin abrir un socket. Así se puede aseverar en las pruebas que a Anthropic
 * se le manda `x-api-key` y `anthropic-version`, que a Ollama no se le manda ninguna credencial y
 * que a un modelo antiguo no se le cuela un parámetro que devolvería 400 — sin red y sin claves.
 *
 * Los tres proveedores hablan HTTP directamente en vez de a través de sus SDK. La razón está en
 * ADR-017: un solo cliente de streaming para tres formatos pesa menos que tres SDK, y mezclar SDK
 * con `fetch` dentro del mismo módulo sería peor que no usar ninguno.
 */
import type { AiEffort, AiMessage, AiProviderId } from '../../../shared/ai.js';
import { modelInfo } from '../../../shared/ai.js';

export interface AiHttpRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  /** Cuerpo ya serializado. Vacío en las peticiones GET. */
  body: string;
}

export interface ChatRequestInput {
  provider: AiProviderId;
  /** Base sin barra final, ya resuelta contra el catálogo y las preferencias. */
  baseUrl: string;
  model: string;
  apiKey: string | null;
  system: string;
  messages: readonly AiMessage[];
  maxTokens: number;
  effort: AiEffort;
}

/** Versión de la API de mensajes de Anthropic. Es una cabecera obligatoria y fija. */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * ¿Acepta este modelo un nivel de esfuerzo?
 *
 * Los modelos de la generación actual lo aceptan dentro de `output_config`; los anteriores
 * devuelven 400 si se les manda. Un modelo escrito a mano (Ollama, o un id nuevo que aún no está
 * en el catálogo) se trata como que no lo acepta: equivocarse por omisión no rompe nada.
 */
export function supportsEffort(provider: AiProviderId, model: string): boolean {
  return modelInfo(provider, model)?.supportsEffort ?? false;
}

export function buildChatRequest(input: ChatRequestInput): AiHttpRequest {
  switch (input.provider) {
    case 'anthropic':
      return anthropicRequest(input);
    case 'openai':
      return openAiRequest(input);
    case 'ollama':
      return ollamaRequest(input);
    default:
      throw new Error(`proveedor de IA no soportado: ${String(input.provider)}`);
  }
}

function requireKey(input: ChatRequestInput): string {
  const key = input.apiKey?.trim() ?? '';
  if (key === '') {
    throw new Error(
      `falta la clave de API de ${input.provider}. Añádela en Ajustes → Asistente de IA.`,
    );
  }
  return key;
}

function anthropicRequest(input: ChatRequestInput): AiHttpRequest {
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
    stream: true,
  };

  // `output_config.effort` sólo existe en los modelos que lo declaran; `temperature` y
  // `budget_tokens` están retirados en la generación actual y no se mandan nunca.
  if (supportsEffort('anthropic', input.model)) {
    body['output_config'] = { effort: input.effort };
    body['thinking'] = { type: 'adaptive' };
  }

  return {
    url: `${input.baseUrl}/v1/messages`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': requireKey(input),
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  };
}

function openAiRequest(input: ChatRequestInput): AiHttpRequest {
  const body: Record<string, unknown> = {
    model: input.model,
    // El prompt de sistema viaja como primer mensaje: es lo que espera chat completions.
    messages: [
      { role: 'system', content: input.system },
      ...input.messages.map((message) => ({ role: message.role, content: message.content })),
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: input.maxTokens,
  };

  if (supportsEffort('openai', input.model)) {
    body['reasoning_effort'] = input.effort;
  }

  return {
    url: `${input.baseUrl}/v1/chat/completions`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${requireKey(input)}`,
    },
    body: JSON.stringify(body),
  };
}

function ollamaRequest(input: ChatRequestInput): AiHttpRequest {
  return {
    url: `${input.baseUrl}/api/chat`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      stream: true,
      options: { num_predict: input.maxTokens },
    }),
  };
}

/**
 * Petición de comprobación del proveedor ("Probar conexión" en ajustes).
 *
 * En Ollama se listan los modelos instalados, que es justo lo que hace falta saber. En los
 * proveedores con clave se manda un mensaje mínimo sin streaming: es la única forma honesta de
 * comprobar que la clave vale, porque un endpoint puede responder 200 a un GET y 401 a un POST.
 */
export function buildProbeRequest(input: ChatRequestInput): AiHttpRequest {
  if (input.provider === 'ollama') {
    return {
      url: `${input.baseUrl}/api/tags`,
      method: 'GET',
      headers: { accept: 'application/json' },
      body: '',
    };
  }

  const probe: ChatRequestInput = {
    ...input,
    system: 'Responde con una sola palabra: ok.',
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 16,
  };

  const request = buildChatRequest(probe);
  const body = JSON.parse(request.body) as Record<string, unknown>;
  body['stream'] = false;

  // Sin razonamiento: la comprobación debe ser barata y no gastar tokens de pensamiento.
  delete body['thinking'];
  delete body['output_config'];
  delete body['reasoning_effort'];
  delete body['stream_options'];

  return { ...request, headers: { ...request.headers, accept: 'application/json' }, body: JSON.stringify(body) };
}
