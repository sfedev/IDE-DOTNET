/**
 * Validación de las preferencias del asistente.
 *
 * Mismo criterio que el resto de `settings.json`: un archivo editado a mano o corrompido no puede
 * impedir que el IDE arranque, sólo hacer que se ignore el valor que no vale. Aquí, además, hay
 * un motivo de seguridad: el `baseUrl` acaba siendo el destino de una petición con la clave de
 * API dentro, así que se acepta únicamente http/https y se rechaza cualquier otra cosa.
 */
import type { AiEffort, AiProviderId, AiProviderPreferences, AiSettings } from '../../../shared/ai.js';
import { AI_PROVIDER_IDS, DEFAULT_AI_SETTINGS, providerInfo } from '../../../shared/ai.js';

/** Tope duro de la respuesta. Por debajo no cabe ni un método; por encima no es un chat de IDE. */
export const MIN_MAX_TOKENS = 256;
export const MAX_MAX_TOKENS = 64_000;

const EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high'];

/**
 * Normaliza un endpoint escrito por el usuario.
 *
 * Devuelve cadena vacía —"usa el del catálogo"— para todo lo que no sea una URL http/https. Un
 * `file:` o un `ftp:` aquí no es un despiste inofensivo: es a dónde se mandaría la clave.
 */
export function coerceBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function coerceProviderPreferences(raw: unknown, provider: AiProviderId): AiProviderPreferences {
  const fallback = DEFAULT_AI_SETTINGS.providers[provider];
  if (typeof raw !== 'object' || raw === null) return { ...fallback };

  const source = raw as Record<string, unknown>;
  const model = typeof source['model'] === 'string' && source['model'].trim() !== ''
    ? source['model'].trim()
    : fallback.model;

  // En los proveedores con catálogo cerrado, un modelo desconocido se descarta: escribir mal el
  // id sólo se descubriría con un 404 a mitad de una conversación.
  const info = providerInfo(provider);
  const known = info.models.some((entry) => entry.id === model);

  return {
    model: info.freeformModel || known ? model : fallback.model,
    baseUrl: coerceBaseUrl(source['baseUrl']),
  };
}

export function coerceAiSettings(raw: unknown): AiSettings {
  const settings: AiSettings = {
    ...DEFAULT_AI_SETTINGS,
    providers: {
      anthropic: { ...DEFAULT_AI_SETTINGS.providers.anthropic },
      openai: { ...DEFAULT_AI_SETTINGS.providers.openai },
      ollama: { ...DEFAULT_AI_SETTINGS.providers.ollama },
    },
  };

  if (typeof raw !== 'object' || raw === null) return settings;
  const source = raw as Record<string, unknown>;

  if (AI_PROVIDER_IDS.includes(source['provider'] as AiProviderId)) {
    settings.provider = source['provider'] as AiProviderId;
  }

  const providers = typeof source['providers'] === 'object' && source['providers'] !== null
    ? (source['providers'] as Record<string, unknown>)
    : {};

  for (const provider of AI_PROVIDER_IDS) {
    settings.providers[provider] = coerceProviderPreferences(providers[provider], provider);
  }

  if (typeof source['maxTokens'] === 'number' && Number.isFinite(source['maxTokens'])) {
    settings.maxTokens = Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(source['maxTokens'])));
  }

  if (EFFORTS.includes(source['effort'] as AiEffort)) {
    settings.effort = source['effort'] as AiEffort;
  }

  for (const flag of ['enabled', 'includeActiveFile', 'includeSelection', 'includeArchitecture', 'includeDiagnostics'] as const) {
    if (typeof source[flag] === 'boolean') settings[flag] = source[flag];
  }

  return settings;
}
