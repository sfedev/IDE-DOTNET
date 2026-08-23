/**
 * Cliente de streaming del asistente.
 *
 * Es el único punto del programa que habla con un proveedor de IA. Recibe una petición ya
 * validada, compone el prompt de sistema con las reglas de la arquitectura, abre la conexión y va
 * entregando el texto al renderer trozo a trozo.
 *
 * Tres invariantes que conviene no romper:
 *
 *  - **El prompt de sistema se compone aquí.** El renderer manda contexto y mensajes; las reglas
 *    de arquitectura las pone el proceso principal en cada petición.
 *  - **Toda petición se puede cancelar.** Un `AbortController` por `requestId`; cerrar el panel o
 *    pulsar Detener corta la conexión de verdad, no sólo deja de pintar.
 *  - **Ningún error se traga.** Un fallo termina el stream con `reason: 'error'` y un mensaje que
 *    dice qué hacer, porque el usuario está mirando un cursor parpadeando.
 */
import type {
  AiChatRequest,
  AiProbeResult,
  AiProviderId,
  AiSettings,
  AiStatus,
  AiStreamDelta,
  AiStreamEnd,
  AiUsage,
} from '../../../shared/ai.js';
import { providerInfo, resolveBaseUrl, resolveModel } from '../../../shared/ai.js';
import { composeUserMessage, systemPrompt } from '../../../shared/ai-context.js';
import { buildChatRequest, buildProbeRequest, type ChatRequestInput } from './request-builder.js';
import { createStreamParser, describeApiError, describeHttpStatus } from './stream-parser.js';

export interface AiCallbacks {
  onDelta(payload: AiStreamDelta): void;
  onEnd(payload: AiStreamEnd): void;
}

/**
 * De dónde salen las claves de API.
 *
 * Se inyecta en vez de importar el almacén directamente por dos motivos. El primero es de diseño:
 * este archivo no tiene por qué saber si el secreto vive en el llavero del sistema, en una
 * variable de entorno o en memoria. El segundo es práctico: `secret-store.ts` importa
 * `safeStorage` de Electron, y con esa dependencia el cliente de streaming no se podría ejercitar
 * con Node puro contra un servidor de mentira, que es la única forma de probarlo entero sin gastar
 * tokens de verdad.
 */
export interface CredentialSource {
  get(provider: AiProviderId): string | null;
  configured(): AiProviderId[];
}

let credentials: CredentialSource = {
  get: () => null,
  configured: () => [],
};

export function setCredentialSource(source: CredentialSource): void {
  credentials = source;
}

/** Sin un solo byte en este tiempo se corta: una conexión colgada no se distingue de una lenta. */
const IDLE_TIMEOUT_MS = 90_000;

/** Peticiones vivas, para poder cancelarlas por id. */
const inFlight = new Map<string, AbortController>();

function requestInput(settings: AiSettings, provider: AiProviderId): Omit<ChatRequestInput, 'system' | 'messages'> {
  return {
    provider,
    baseUrl: resolveBaseUrl(settings, provider),
    model: resolveModel(settings, provider),
    apiKey: credentials.get(provider),
    maxTokens: settings.maxTokens,
    effort: settings.effort,
  };
}

/** Estado que se enseña en la cabecera del panel y en los ajustes. */
export function status(settings: AiSettings): AiStatus {
  const provider = settings.provider;
  const info = providerInfo(provider);
  const hasKey = credentials.get(provider) !== null;
  const ready = settings.enabled && (!info.needsApiKey || hasKey);

  let message: string | null = null;
  if (!settings.enabled) message = 'El asistente está desactivado en Ajustes.';
  else if (info.needsApiKey && !hasKey) message = `Falta la clave de API de ${info.label}.`;

  return {
    enabled: settings.enabled,
    provider,
    providerLabel: info.label,
    model: resolveModel(settings, provider),
    ready,
    message,
    configured: credentials.configured(),
  };
}

/**
 * Lanza una conversación en streaming.
 *
 * La promesa se resuelve cuando el stream termina, con éxito o sin él; el resultado real llega
 * por los callbacks. El llamante (el handler IPC) no espera: devuelve el `requestId` en cuanto
 * la petición está aceptada, para que la interfaz pueda enseñar el cursor enseguida.
 */
export async function chat(request: AiChatRequest, settings: AiSettings, callbacks: AiCallbacks): Promise<void> {
  const provider = settings.provider;
  const controller = new AbortController();
  inFlight.set(request.requestId, controller);

  let usage: AiUsage | null = null;
  let finished = false;

  const finish = (reason: AiStreamEnd['reason'], message: string | null): void => {
    if (finished) return;
    finished = true;
    inFlight.delete(request.requestId);
    callbacks.onEnd({ requestId: request.requestId, reason, message, usage });
  };

  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('sin respuesta del proveedor')), IDLE_TIMEOUT_MS);
  };

  try {
    if (!settings.enabled) throw new Error('el asistente está desactivado en Ajustes');

    // El último mensaje del usuario es el que lleva el contexto: el histórico ya lo llevaba
    // cuando se envió, y repetirlo en cada turno multiplicaría el prompt sin aportar nada.
    const messages = request.messages.map((message, index) =>
      index === request.messages.length - 1 && message.role === 'user'
        ? { role: message.role, content: composeUserMessage(message.content, request.context) }
        : message,
    );

    const http = buildChatRequest({
      ...requestInput(settings, provider),
      system: systemPrompt(request.context, request.task),
      messages,
    });

    resetIdleTimer();

    const response = await fetch(http.url, {
      method: http.method,
      headers: http.headers,
      body: http.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(describeHttpStatus(response.status, provider, extractErrorDetail(detail)));
    }
    if (!response.body) throw new Error('el proveedor no ha devuelto ningún cuerpo de respuesta');

    const parser = createStreamParser(provider);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      resetIdleTimer();

      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (event.type === 'text') callbacks.onDelta({ requestId: request.requestId, text: event.text });
        else if (event.type === 'usage') usage = event.usage;
        else if (event.type === 'error') throw new Error(event.message);
      }
    }

    for (const event of parser.flush()) {
      if (event.type === 'text') callbacks.onDelta({ requestId: request.requestId, text: event.text });
      else if (event.type === 'usage') usage = event.usage;
    }

    finish('done', null);
  } catch (error) {
    const aborted = controller.signal.aborted;
    finish(aborted ? 'cancelled' : 'error', aborted ? null : describeFailure(error, provider));
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    inFlight.delete(request.requestId);
  }
}

export function cancel(requestId: string): void {
  inFlight.get(requestId)?.abort();
  inFlight.delete(requestId);
}

export function cancelAll(): void {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
}

/**
 * Comprueba que el proveedor responde con la configuración actual.
 *
 * Es el botón "Probar conexión" de los ajustes: mucho mejor descubrir que la clave está mal aquí
 * que a mitad de la primera pregunta.
 */
export async function probe(settings: AiSettings, provider: AiProviderId): Promise<AiProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const http = buildProbeRequest({
      ...requestInput(settings, provider),
      system: '',
      messages: [],
    });

    const response = await fetch(http.url, {
      method: http.method,
      headers: http.headers,
      ...(http.method === 'POST' ? { body: http.body } : {}),
      signal: controller.signal,
    });

    const text = await response.text().catch(() => '');

    if (!response.ok) {
      return { ok: false, message: describeHttpStatus(response.status, provider, extractErrorDetail(text)), models: [] };
    }

    return {
      ok: true,
      message: `${providerInfo(provider).label} responde correctamente.`,
      models: extractModelNames(text),
    };
  } catch (error) {
    return { ok: false, message: describeFailure(error, provider), models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Nombres de modelo de una respuesta de `/api/tags` (Ollama). Vacío en el resto. */
function extractModelNames(payload: string): string[] {
  try {
    const parsed: unknown = JSON.parse(payload);
    const models = (parsed as { models?: unknown })?.models;
    if (!Array.isArray(models)) return [];

    return models
      .map((entry) => (entry as { name?: unknown })?.name)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}

/** Saca el `message` del cuerpo de error si es JSON; si no, devuelve el texto recortado. */
function extractErrorDetail(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    const error = (parsed as { error?: unknown })?.error;

    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
      return describeApiError(error as Record<string, unknown>);
    }
  } catch {
    // No era JSON.
  }
  return payload.slice(0, 200);
}

/**
 * Traduce un fallo de red a algo accionable.
 *
 * `fetch failed` es el mensaje más inútil posible cuando lo que pasa es que Ollama no está
 * arrancado, que es con diferencia la causa más frecuente en el proveedor local.
 */
function describeFailure(error: unknown, provider: AiProviderId): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return provider === 'ollama'
      ? 'no se ha podido conectar con Ollama. Comprueba que está en marcha (`ollama serve`) y que la URL de Ajustes es correcta.'
      : `no se ha podido conectar con ${providerInfo(provider).label}. Comprueba la conexión de red y la URL configurada.`;
  }

  if (/aborted|AbortError/i.test(message)) {
    return `${providerInfo(provider).label} no ha respondido a tiempo.`;
  }

  return message;
}
