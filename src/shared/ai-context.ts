/**
 * Inyección de contexto RAG y prompt de sistema del asistente.
 *
 * Todo lo de este archivo es **función pura**: entra el estado del IDE (solución abierta, archivo
 * activo, selección, diagnósticos) y sale el texto exacto que se le manda al modelo. Eso permite
 * probar con Node puro lo que de otro modo sólo se podría comprobar mirando respuestas, que es la
 * forma más cara y menos fiable de depurar un prompt.
 *
 * Dos decisiones que conviene no perder de vista:
 *
 * 1. **El prompt de sistema lo compone el proceso principal**, no el renderer. Las reglas de
 *    arquitectura no son una sugerencia de la interfaz: son parte del contrato del asistente y no
 *    deben poder quitarse desde el lado que pinta botones.
 * 2. **El contexto se recorta con criterio.** Un archivo de 4.000 líneas no entra entero en un
 *    prompt razonable; se conserva la ventana alrededor de la selección, que es de lo que se
 *    está hablando, y se dice explícitamente que se ha recortado.
 */
import type { BuildDiagnostic, ProjectInfo, SolutionInfo } from './contracts.js';
import type {
  AiArchitecture,
  AiContext,
  AiDiagnosticContext,
  AiFileContext,
  AiProjectContext,
  AiSelectionContext,
  AiTask,
} from './ai.js';

/** Tope del archivo activo en el contexto. Por encima se recorta con ventana. */
export const MAX_FILE_CHARS = 24_000;

/** Tope de la selección. Una selección más larga que esto ya no es "este trozo de código". */
export const MAX_SELECTION_CHARS = 8_000;

/** Diagnósticos que se adjuntan. Más de una docena no orienta: satura. */
export const MAX_DIAGNOSTICS = 12;

// ---------------------------------------------------------------------------------------------
// Arquitectura
// ---------------------------------------------------------------------------------------------

/**
 * Arquitectura de la solución abierta.
 *
 * El manifiesto `dotforge.json` manda: si la solución la generó DotForge, la respuesta es exacta.
 * Para todo lo demás se deduce de los nombres de proyecto, que en estas tres arquitecturas son
 * muy característicos (`.Ports` + `.Adapters.*` sólo aparece en hexagonal, `.SharedKernel` en DDD).
 * Cuando ninguna señal es concluyente se devuelve `unknown` y el prompt lo dice, en vez de
 * inventarse unas reglas que el proyecto no sigue.
 */
export function detectArchitecture(solution: SolutionInfo | null): AiArchitecture {
  if (!solution) return 'unknown';
  if (solution.generatedBy) return solution.generatedBy.architecture;

  const names = solution.projects.map((project) => project.name.toLowerCase());
  const has = (fragment: string): boolean => names.some((name) => name.includes(fragment));

  // Hexagonal primero: es la única con puertos y adaptadores explícitos.
  if (has('.ports') && has('.adapters')) return 'hexagonal';
  if (has('.sharedkernel') || has('.shared-kernel')) return 'ddd';

  if (has('.domain') && has('.application') && has('.infrastructure')) {
    // Clean y DDD comparten las tres capas; el reparto de los repositorios las distingue.
    // En DDD el repositorio es del dominio, así que la pista está en los agregados.
    return has('.aggregates') || has('.domainevents') ? 'ddd' : 'clean';
  }

  return 'unknown';
}

const LAYER_RULES: ReadonlyArray<{ match: RegExp; layer: string }> = [
  { match: /\.sharedkernel$/i, layer: 'Shared Kernel' },
  { match: /\.domain$/i, layer: 'Dominio' },
  { match: /\.application$/i, layer: 'Aplicación' },
  { match: /\.infrastructure$/i, layer: 'Infraestructura' },
  { match: /\.ports$/i, layer: 'Puertos' },
  { match: /\.adapters\./i, layer: 'Adaptador' },
  { match: /\.webapi$/i, layer: 'Presentación (Web API)' },
  { match: /\.blazor$/i, layer: 'Presentación (Blazor)' },
  { match: /(tests|unittests|integrationtests)$/i, layer: 'Pruebas' },
];

/** Capa que le corresponde a un proyecto por su nombre. */
export function layerOf(projectName: string): string {
  for (const rule of LAYER_RULES) {
    if (rule.match.test(projectName)) return rule.layer;
  }
  return 'Sin clasificar';
}

export function projectContexts(projects: readonly ProjectInfo[]): AiProjectContext[] {
  return projects.map((project) => ({ name: project.name, layer: layerOf(project.name) }));
}

// ---------------------------------------------------------------------------------------------
// Recorte
// ---------------------------------------------------------------------------------------------

/** Ruta relativa a la raíz de la solución, con separador POSIX. Vacía si no cuelga de ella. */
export function relativeTo(root: string | null, path: string): string {
  if (!root) return path.split('\\').join('/');

  const normalizedRoot = root.split('\\').join('/').replace(/\/+$/, '');
  const normalized = path.split('\\').join('/');

  if (normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

/**
 * Recorta un archivo a `limit` caracteres conservando lo que importa.
 *
 * Con selección, la ventana se centra en ella: el modelo necesita ver el `using`, la clase que
 * envuelve al método y lo que hay justo alrededor. Sin selección se conserva la cabecera, que es
 * donde están el namespace y las dependencias.
 */
export function windowAround(
  text: string,
  limit: number,
  selection: { startLine: number; endLine: number } | null,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };

  const lines = text.split(/\r?\n/);

  if (!selection) {
    return { text: `${text.slice(0, limit)}\n// … archivo recortado por tamaño …`, truncated: true };
  }

  // Se crece simétricamente alrededor de la selección hasta agotar el presupuesto.
  const center = Math.floor((selection.startLine + selection.endLine) / 2);
  let first = Math.max(0, center - 1);
  let last = Math.min(lines.length - 1, center);
  let size = (lines[first]?.length ?? 0) + (lines[last]?.length ?? 0);

  while (size < limit && (first > 0 || last < lines.length - 1)) {
    if (first > 0) {
      first--;
      size += (lines[first]?.length ?? 0) + 1;
    }
    if (size < limit && last < lines.length - 1) {
      last++;
      size += (lines[last]?.length ?? 0) + 1;
    }
  }

  const head = first > 0 ? '// … inicio del archivo recortado …\n' : '';
  const tail = last < lines.length - 1 ? '\n// … resto del archivo recortado …' : '';

  // Tope duro: una sola línea puede ser más larga que todo el presupuesto —un `.razor` minificado
  // o un JSON en una línea— y entonces la ventana por líneas no recorta nada.
  const windowed = lines.slice(first, last + 1).join('\n');
  const capped = windowed.length > limit ? `${windowed.slice(0, limit)}\n// … línea recortada …` : windowed;

  return { text: `${head}${capped}${tail}`, truncated: true };
}

// ---------------------------------------------------------------------------------------------
// Construcción del contexto
// ---------------------------------------------------------------------------------------------

export interface ContextInput {
  solution: SolutionInfo | null;
  file: { path: string; languageId: string; text: string } | null;
  selection: AiSelectionContext | null;
  diagnostics: readonly BuildDiagnostic[];
  include: {
    activeFile: boolean;
    selection: boolean;
    architecture: boolean;
    diagnostics: boolean;
  };
}

/**
 * Compone el contexto que acompaña a cada mensaje.
 *
 * Los diagnósticos se filtran al archivo activo cuando lo hay: los 40 errores de otro proyecto no
 * ayudan a explicar el método que el usuario tiene delante, y sí gastan contexto.
 */
export function buildContext(input: ContextInput): AiContext {
  const architecture = input.include.architecture ? detectArchitecture(input.solution) : 'unknown';

  const selection =
    input.include.selection && input.selection && input.selection.text.trim() !== ''
      ? {
          startLine: input.selection.startLine,
          endLine: input.selection.endLine,
          text: input.selection.text.slice(0, MAX_SELECTION_CHARS),
        }
      : null;

  let file: AiFileContext | null = null;
  if (input.include.activeFile && input.file) {
    const windowed = windowAround(input.file.text, MAX_FILE_CHARS, selection);
    file = {
      path: input.file.path,
      relativePath: relativeTo(input.solution?.directory ?? null, input.file.path),
      languageId: input.file.languageId,
      text: windowed.text,
      truncated: windowed.truncated,
    };
  }

  const diagnostics: AiDiagnosticContext[] = input.include.diagnostics
    ? input.diagnostics
        .filter((diagnostic) => diagnostic.severity !== 'info')
        .filter((diagnostic) => (file ? diagnostic.file === null || diagnostic.file === file.path : true))
        .slice(0, MAX_DIAGNOSTICS)
        .map((diagnostic) => ({
          file: diagnostic.file === null ? null : relativeTo(input.solution?.directory ?? null, diagnostic.file),
          line: diagnostic.line,
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
        }))
    : [];

  return {
    architecture,
    solutionName: input.solution?.name ?? null,
    projects: input.include.architecture ? projectContexts(input.solution?.projects ?? []) : [],
    file,
    selection,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------------------------
// Reglas de arquitectura
// ---------------------------------------------------------------------------------------------

const COMMON_RULES: readonly string[] = [
  'La solución es .NET 9 o superior con C# moderno: usings implícitos, tipos de referencia anulables activados, minimal APIs y `file-scoped namespace`.',
  'No propongas MediatR: la plantilla usa un despachador CQRS propio (`IDispatcher`). Si hace falta un mediador, extiende el existente.',
  'No inventes tipos ni paquetes: si necesitas algo que no está en el contexto, dilo y pregunta en vez de suponer su firma.',
  'Cuando cites un archivo, usa su ruta relativa a la solución.',
];

const ARCHITECTURE_RULES: Record<AiArchitecture, readonly string[]> = {
  clean: [
    'Arquitectura: **Clean Architecture**. La regla de dependencia apunta hacia dentro: Presentación → Infraestructura → Aplicación → Dominio.',
    'El proyecto `.Domain` NO puede referenciar EF Core, ASP.NET Core, ni ningún paquete de infraestructura. Nada de `DbContext`, `[Table]`, `[Key]` ni atributos de serialización dentro del dominio.',
    'El proyecto `.Application` define interfaces (`I*Repository`, `IUnitOfWork`, `IClock`) y NO conoce su implementación; la implementación vive en `.Infrastructure`.',
    'El mapeo de EF Core va en `Infrastructure/Persistence/Configurations`, con `IEntityTypeConfiguration<T>`, nunca con atributos en la entidad.',
    'Los endpoints viven en `.WebApi/Endpoints` y sólo hablan con los servicios de aplicación; no tocan el `DbContext` directamente.',
  ],
  hexagonal: [
    'Arquitectura: **Hexagonal (Puertos y Adaptadores)**. El núcleo (`.Domain` + `.Ports`) no conoce a ningún adaptador.',
    'Los puertos de entrada (`Ports/Inbound`) los implementa el servicio de aplicación; los de salida (`Ports/Outbound`) los implementan los adaptadores.',
    'Un adaptador (`.Adapters.Persistence`, `.Adapters.Web`, `.Adapters.Notifications`) NUNCA se referencia desde el núcleo: la inyección de dependencias los une en el arranque.',
    'El proyecto `.Domain` no puede referenciar EF Core ni ASP.NET Core. El `DbContext` vive en `.Adapters.Persistence`.',
    'Si hace falta una capacidad externa nueva, primero se define el puerto en `.Ports/Outbound` y después su adaptador.',
  ],
  ddd: [
    'Arquitectura: **DDD + CQRS**. El modelo es rico: la lógica vive en el agregado, no en el servicio.',
    'El proyecto `.Domain` no puede referenciar EF Core ni ASP.NET Core. Nada de anotaciones de persistencia en agregados ni en objetos de valor.',
    'Los objetos de valor son inmutables, se comparan por valor (heredan de `ValueObject`) y validan en la construcción lanzando `DomainException`.',
    'Un agregado sólo se modifica por sus métodos; las propiedades tienen `private set` y los cambios relevantes publican un evento de dominio.',
    'Los comandos y consultas viven en `.Application/<Agregado>/Commands` y `/Queries`, con un handler por caso de uso, y se despachan con `IDispatcher`.',
    'Las interfaces de repositorio pertenecen al dominio (`.Domain/<Agregado>/I*Repository.cs`); su implementación EF Core, a `.Infrastructure`.',
  ],
  unknown: [
    'No se ha podido determinar la arquitectura de la solución. No supongas una: propón soluciones idiomáticas de .NET y señala la decisión de diseño cuando exista más de una opción razonable.',
  ],
};

export function architectureRules(architecture: AiArchitecture): readonly string[] {
  return ARCHITECTURE_RULES[architecture] ?? ARCHITECTURE_RULES.unknown;
}

const TASK_INSTRUCTIONS: Record<AiTask, string> = {
  chat:
    'Responde en español, de forma directa y sin relleno. Usa bloques de código con el lenguaje ' +
    'indicado (```csharp, ```razor). Si la petición viola la arquitectura, dilo y ofrece la ' +
    'alternativa correcta en vez de obedecer.',
  explain:
    'Explica el código en español: qué hace, por qué está escrito así y qué papel juega en su ' +
    'capa. Señala los problemas que veas —incluidas las violaciones de la arquitectura— pero no ' +
    'reescribas el archivo si no te lo piden.',
  tests:
    'Escribe pruebas con xUnit v2 y aserciones de la propia librería (`Assert`), sin FluentAssertions ' +
    'ni Moq salvo que ya estén en el proyecto. Sigue el patrón Arrange/Act/Assert con nombres de ' +
    'método descriptivos. Devuelve UN solo bloque ```csharp con el archivo de pruebas completo, ' +
    'listo para guardar, y nada más aparte de una frase de contexto.',
  fix:
    'Corrige el problema señalado respetando la arquitectura. Explica en una o dos frases la causa ' +
    'raíz y devuelve UN solo bloque ```csharp con el código corregido del fragmento afectado.',
  edit:
    'Devuelve EXCLUSIVAMENTE el código que sustituye al fragmento seleccionado, en UN solo bloque ' +
    'de código con el lenguaje indicado. Conserva la indentación original del fragmento. No ' +
    'añadas explicaciones, ni comentarios de cortesía, ni texto antes o después del bloque.',
};

/**
 * Prompt de sistema completo: identidad, reglas de la arquitectura y formato de salida.
 *
 * Se compone en el proceso principal en cada petición, así que un cambio de solución cambia las
 * reglas sin que haya que reiniciar nada.
 */
export function systemPrompt(context: AiContext, task: AiTask): string {
  const sections: string[] = [
    'Eres DotForge AI, el asistente integrado en un IDE de C#, .NET 9+ y Blazor. Tu trabajo es ' +
      'ayudar sin romper la arquitectura del proyecto abierto.',
    '## Reglas de la arquitectura del proyecto',
    ...architectureRules(context.architecture).map((rule) => `- ${rule}`),
    ...COMMON_RULES.map((rule) => `- ${rule}`),
    '## Formato de la respuesta',
    TASK_INSTRUCTIONS[task],
  ];

  if (context.projects.length > 0) {
    sections.push(
      '## Proyectos de la solución',
      ...context.projects.map((project) => `- ${project.name} — ${project.layer}`),
    );
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------------------------
// Bloque de contexto
// ---------------------------------------------------------------------------------------------

const FENCE = '```';

/**
 * Bloque que se antepone al mensaje del usuario.
 *
 * Va como parte del turno de usuario y no del prompt de sistema porque cambia en cada mensaje:
 * mantenerlo fuera del prefijo estable es lo que permite que la caché del proveedor sirva de algo.
 */
export function renderContextBlock(context: AiContext): string {
  const parts: string[] = [];

  if (context.solutionName) {
    const architecture =
      context.architecture === 'unknown' ? 'sin determinar' : ARCHITECTURE_LABELS[context.architecture];
    parts.push(`Solución abierta: ${context.solutionName} (arquitectura ${architecture}).`);
  }

  if (context.file) {
    const label = `${context.file.relativePath}${context.file.truncated ? ' (recortado)' : ''}`;
    parts.push(
      `Archivo activo: ${label}`,
      `${FENCE}${context.file.languageId}`,
      context.file.text,
      FENCE,
    );
  }

  if (context.selection) {
    parts.push(
      `Selección del usuario (líneas ${context.selection.startLine}-${context.selection.endLine}):`,
      `${FENCE}${context.file?.languageId ?? ''}`,
      context.selection.text,
      FENCE,
    );
  }

  if (context.diagnostics.length > 0) {
    parts.push(
      'Diagnósticos activos de compilación:',
      ...context.diagnostics.map(
        (diagnostic) =>
          `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code} en ${diagnostic.file ?? 'la solución'}:` +
          `${diagnostic.line} — ${diagnostic.message}`,
      ),
    );
  }

  return parts.join('\n');
}

const ARCHITECTURE_LABELS: Record<AiArchitecture, string> = {
  clean: 'Clean Architecture',
  hexagonal: 'Hexagonal (Puertos y Adaptadores)',
  ddd: 'DDD + CQRS',
  unknown: 'sin determinar',
};

/** Mensaje de usuario definitivo: contexto primero, petición después. */
export function composeUserMessage(prompt: string, context: AiContext): string {
  const block = renderContextBlock(context);
  if (block === '') return prompt;
  return `<contexto-del-ide>\n${block}\n</contexto-del-ide>\n\n${prompt}`;
}

/** Etiqueta legible de la arquitectura, para la cabecera del panel de chat. */
export function architectureLabel(architecture: AiArchitecture): string {
  return ARCHITECTURE_LABELS[architecture] ?? ARCHITECTURE_LABELS.unknown;
}
