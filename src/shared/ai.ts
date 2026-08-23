/**
 * Modelo compartido del asistente de IA.
 *
 * Vive en `shared/` porque lo necesitan los tres lados: el proceso principal (que habla con el
 * proveedor), el renderer (que pinta el chat y el widget en línea) y las pruebas, que ejercitan
 * la lógica con Node puro. No importa nada de Electron ni del DOM a propósito.
 *
 * Regla de diseño: aquí sólo hay **datos y catálogos**. Cómo se construye una petición HTTP vive
 * en `src/main/services/ai/`, y cómo se pinta, en `src/renderer/views/ai-*.ts`.
 */
import type { ArchitectureId } from './scaffold-types.js';

// ---------------------------------------------------------------------------------------------
// Proveedores y modelos
// ---------------------------------------------------------------------------------------------

export type AiProviderId = 'anthropic' | 'openai' | 'ollama';

/** Nivel de esfuerzo de razonamiento. Sólo lo aceptan los modelos que lo declaran. */
export type AiEffort = 'low' | 'medium' | 'high';

export interface AiModelInfo {
  id: string;
  label: string;
  /** Una línea de ayuda en el desplegable: para qué sirve este modelo. */
  hint: string;
  /**
   * El modelo acepta `output_config.effort` y razonamiento adaptativo. Los modelos anteriores
   * devuelven 400 si se les manda, así que el flag decide qué se envía y qué no.
   */
  supportsEffort: boolean;
  /** Generación anterior: se sigue ofreciendo, pero no es la opción por defecto. */
  legacy: boolean;
}

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  /** Endpoint por defecto. El usuario puede cambiarlo (proxy corporativo, Ollama remoto…). */
  baseUrl: string;
  /** false en Ollama: un modelo local no tiene clave. */
  needsApiKey: boolean;
  /** true si el modelo se escribe a mano en vez de elegirse de una lista (Ollama). */
  freeformModel: boolean;
  hint: string;
  /** Dónde se consigue la clave. Se abre en el navegador del sistema, nunca dentro de la app. */
  keyUrl: string | null;
  models: AiModelInfo[];
}

/**
 * Catálogo de proveedores.
 *
 * Los modelos de Anthropic son los de la generación actual (familia Claude 5 + Haiku 4.5); los
 * de la generación anterior quedan marcados como `legacy` para quien tenga una clave con acceso
 * limitado o quiera reproducir resultados antiguos. Ver ADR-018.
 */
export const AI_PROVIDERS: readonly AiProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsApiKey: true,
    freeformModel: false,
    hint: 'Claude, vía la API de mensajes. La clave se guarda cifrada en este equipo.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      {
        id: 'claude-opus-5',
        label: 'Claude Opus 5',
        hint: 'El más capaz: refactorizaciones grandes y diseño de arquitectura.',
        supportsEffort: true,
        legacy: false,
      },
      {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        hint: 'Equilibrio entre calidad y coste para el trabajo del día a día.',
        supportsEffort: true,
        legacy: false,
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        hint: 'Rápido y barato: explicaciones cortas y conversiones mecánicas.',
        supportsEffort: false,
        legacy: false,
      },
      {
        id: 'claude-3-7-sonnet-latest',
        label: 'Claude 3.7 Sonnet',
        hint: 'Generación anterior. Sin esfuerzo configurable.',
        supportsEffort: false,
        legacy: true,
      },
      {
        id: 'claude-3-5-haiku-latest',
        label: 'Claude 3.5 Haiku',
        hint: 'Generación anterior, la más económica.',
        supportsEffort: false,
        legacy: true,
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    needsApiKey: true,
    freeformModel: false,
    hint: 'API de chat completions. Compatible también con endpoints que la imitan.',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      {
        id: 'gpt-4o',
        label: 'GPT-4o',
        hint: 'Modelo general para conversación y código.',
        supportsEffort: false,
        legacy: false,
      },
      {
        id: 'o3-mini',
        label: 'o3-mini',
        hint: 'Razonamiento con esfuerzo configurable.',
        supportsEffort: true,
        legacy: false,
      },
    ],
  },
  {
    id: 'ollama',
    label: 'Local (Ollama)',
    baseUrl: 'http://localhost:11434',
    needsApiKey: false,
    freeformModel: true,
    hint: 'Modelo local. Nada sale del equipo: es la opción para código bajo NDA.',
    keyUrl: 'https://ollama.com/library',
    models: [
      {
        id: 'deepseek-coder:6.7b',
        label: 'deepseek-coder:6.7b',
        hint: 'Especializado en código, cabe en 8 GB de VRAM.',
        supportsEffort: false,
        legacy: false,
      },
      {
        id: 'llama3.2',
        label: 'llama3.2',
        hint: 'Generalista ligero.',
        supportsEffort: false,
        legacy: false,
      },
      {
        id: 'qwen2.5-coder:7b',
        label: 'qwen2.5-coder:7b',
        hint: 'Buen resultado en C# para su tamaño.',
        supportsEffort: false,
        legacy: false,
      },
    ],
  },
];

export const AI_PROVIDER_IDS: readonly AiProviderId[] = AI_PROVIDERS.map((provider) => provider.id);

export function providerInfo(id: AiProviderId): AiProviderInfo {
  const found = AI_PROVIDERS.find((provider) => provider.id === id);
  if (!found) throw new Error(`proveedor de IA desconocido: ${String(id)}`);
  return found;
}

/** Descripción del modelo, si está en el catálogo. Ollama admite nombres libres. */
export function modelInfo(provider: AiProviderId, model: string): AiModelInfo | null {
  return providerInfo(provider).models.find((entry) => entry.id === model) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Preferencias
// ---------------------------------------------------------------------------------------------

export interface AiProviderPreferences {
  model: string;
  /** Endpoint efectivo. Vacío significa "el del catálogo". */
  baseUrl: string;
}

export interface AiSettings {
  enabled: boolean;
  provider: AiProviderId;
  providers: Record<AiProviderId, AiProviderPreferences>;
  /** Tope de la respuesta. No se usa `temperature`: los modelos actuales la rechazan. */
  maxTokens: number;
  effort: AiEffort;
  /** Inyección de contexto RAG: cada pieza se puede desactivar por separado. */
  includeActiveFile: boolean;
  includeSelection: boolean;
  includeArchitecture: boolean;
  includeDiagnostics: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  provider: 'anthropic',
  providers: {
    anthropic: { model: 'claude-opus-5', baseUrl: '' },
    openai: { model: 'gpt-4o', baseUrl: '' },
    ollama: { model: 'deepseek-coder:6.7b', baseUrl: '' },
  },
  maxTokens: 8192,
  effort: 'medium',
  includeActiveFile: true,
  includeSelection: true,
  includeArchitecture: true,
  includeDiagnostics: true,
};

/** Endpoint efectivo del proveedor activo, sin barra final. */
export function resolveBaseUrl(settings: AiSettings, provider: AiProviderId): string {
  const configured = settings.providers[provider]?.baseUrl?.trim() ?? '';
  const base = configured === '' ? providerInfo(provider).baseUrl : configured;
  return base.replace(/\/+$/, '');
}

export function resolveModel(settings: AiSettings, provider: AiProviderId): string {
  const configured = settings.providers[provider]?.model?.trim() ?? '';
  return configured === '' ? (providerInfo(provider).models[0]?.id ?? '') : configured;
}

// ---------------------------------------------------------------------------------------------
// Contexto RAG
// ---------------------------------------------------------------------------------------------

/** Arquitectura detectada de la solución abierta. `unknown` cuando no se puede afirmar. */
export type AiArchitecture = ArchitectureId | 'unknown';

export interface AiSelectionContext {
  startLine: number;
  endLine: number;
  text: string;
}

export interface AiFileContext {
  path: string;
  /** Ruta relativa a la solución: es la que entiende un humano y la que cabe en el prompt. */
  relativePath: string;
  languageId: string;
  text: string;
  /** true si `text` se ha recortado por tamaño. */
  truncated: boolean;
}

export interface AiDiagnosticContext {
  file: string | null;
  line: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

/** Proyecto de la solución con la capa que le corresponde en la arquitectura detectada. */
export interface AiProjectContext {
  name: string;
  layer: string;
}

export interface AiContext {
  architecture: AiArchitecture;
  solutionName: string | null;
  projects: AiProjectContext[];
  file: AiFileContext | null;
  selection: AiSelectionContext | null;
  diagnostics: AiDiagnosticContext[];
}

export const EMPTY_AI_CONTEXT: AiContext = {
  architecture: 'unknown',
  solutionName: null,
  projects: [],
  file: null,
  selection: null,
  diagnostics: [],
};

// ---------------------------------------------------------------------------------------------
// Conversación y streaming
// ---------------------------------------------------------------------------------------------

export type AiRole = 'user' | 'assistant';

export interface AiMessage {
  role: AiRole;
  content: string;
}

/**
 * Tarea que origina la petición.
 *
 * No es decorativo: decide qué instrucciones de salida se añaden al prompt de sistema. Una
 * explicación quiere prosa; una refactorización quiere un único bloque de código sustituible.
 */
export type AiTask = 'chat' | 'explain' | 'tests' | 'fix' | 'edit';

export interface AiChatRequest {
  /** Identificador que el renderer genera para poder casar los deltas y cancelar. */
  requestId: string;
  task: AiTask;
  messages: AiMessage[];
  context: AiContext;
}

export interface AiStreamDelta {
  requestId: string;
  text: string;
}

export interface AiStreamEnd {
  requestId: string;
  reason: 'done' | 'cancelled' | 'error';
  /** Mensaje accionable cuando `reason === 'error'`. */
  message: string | null;
  usage: AiUsage | null;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Estado del asistente, para la barra de estado y la cabecera del panel. */
export interface AiStatus {
  enabled: boolean;
  provider: AiProviderId;
  providerLabel: string;
  model: string;
  /** true si el proveedor tiene credencial guardada (o no la necesita). */
  ready: boolean;
  /** Explica por qué no está listo. Null si lo está. */
  message: string | null;
  /** Proveedores con clave guardada. La clave en sí nunca cruza al renderer. */
  configured: AiProviderId[];
}

export interface AiProbeResult {
  ok: boolean;
  message: string;
  /** Modelos que anuncia el endpoint. Ollama los lista; los demás, vacío. */
  models: string[];
}
