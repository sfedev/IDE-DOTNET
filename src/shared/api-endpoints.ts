/**
 * Detección de endpoints HTTP en código C#.
 *
 * Sirve para dos cosas: pintar una lente de código sobre cada endpoint ("Probar", "Copiar como
 * petición") y generar de golpe el archivo `.http` de un proyecto. Las dos necesitan lo mismo:
 * verbo, ruta y en qué línea está.
 *
 * **Por qué no se usa el LSP para esto.** Sería más exacto pedirle a Roslyn el árbol sintáctico,
 * pero la lente tiene que aparecer mientras se escribe, con el servidor arrancando o degradado, y
 * en archivos que ni siquiera compilan. Un análisis de texto acotado da el 95% de los casos sin
 * depender de nada, y cuando se equivoca lo hace de la forma barata: ofrece una prueba de más.
 *
 * Se reconocen las dos formas que existen hoy en ASP.NET Core:
 *  - **Minimal API**: `app.MapGet("/products", ...)`, incluidos los grupos
 *    (`var group = app.MapGroup("/api/products"); group.MapGet("/", ...)`);
 *  - **Controladores**: `[Route("api/[controller]")]` en la clase y `[HttpGet("{id}")]` en el
 *    método, con el token `[controller]` sustituido por el nombre de la clase sin sufijo.
 *
 * Todo es función pura sobre el texto del archivo.
 */

export type EndpointSource = 'minimal' | 'controller';

export interface ApiEndpoint {
  method: string;
  /** Ruta absoluta empezando por `/`, con los parámetros tal cual (`/api/products/{id}`). */
  route: string;
  /** Línea en base 1 donde se ancla la lente. */
  line: number;
  source: EndpointSource;
  /** Nombre del método o del handler, cuando se puede deducir. */
  name: string | null;
  /** Nombre del grupo (`MapGroup`) o del controlador al que pertenece. */
  group: string | null;
}

const MAP_METHODS: Record<string, string> = {
  MapGet: 'GET',
  MapPost: 'POST',
  MapPut: 'PUT',
  MapPatch: 'PATCH',
  MapDelete: 'DELETE',
};

const HTTP_ATTRIBUTES: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpPatch: 'PATCH',
  HttpDelete: 'DELETE',
  HttpHead: 'HEAD',
  HttpOptions: 'OPTIONS',
};

/** Une dos trozos de ruta sin duplicar ni perder la barra. */
export function joinRoutes(prefix: string, suffix: string): string {
  const left = prefix.trim().replace(/\/+$/, '');
  const right = suffix.trim().replace(/^\/+/, '');

  const joined = right === '' ? left : left === '' ? `/${right}` : `${left}/${right}`;
  const normalized = joined === '' ? '/' : joined;

  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/**
 * Sustituye los tokens de ruta de los controladores.
 *
 * `[controller]` es el nombre de la clase sin el sufijo `Controller`; `[action]` es el nombre del
 * método. Son los dos únicos que usa alguien en la práctica.
 */
export function expandRouteTokens(route: string, controller: string | null, action: string | null): string {
  return route
    .replace(/\[controller\]/gi, controller ?? 'controller')
    .replace(/\[action\]/gi, action ?? 'action');
}

/** Cadena literal de C# (admite `@"..."`), sin comillas. Null si la expresión no lo es. */
function literal(expression: string): string | null {
  const match = /^\s*@?"((?:[^"\\]|\\.)*)"/.exec(expression);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : null;
}

/** Número de línea en base 1 de una posición del texto. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Grupos declarados con `MapGroup`, indexados por el nombre de la variable.
 *
 * `var products = app.MapGroup("/api/products").WithTags("Products");` -> `products` -> ruta.
 * Un grupo colgado de otro grupo se resuelve encadenando, que es como se escribe de verdad.
 */
export function collectGroups(source: string): Map<string, string> {
  const groups = new Map<string, string>();
  const pattern = /(?:var|RouteGroupBuilder)\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\.\s*MapGroup\s*\(\s*(@?"(?:[^"\\]|\\.)*")/g;

  for (const match of source.matchAll(pattern)) {
    const variable = match[1]!;
    const parent = match[2]!;
    const route = literal(match[3]!) ?? '';
    groups.set(variable, joinRoutes(groups.get(parent) ?? '', route));
  }

  return groups;
}

/** Endpoints de Minimal API declarados con `MapGet`, `MapPost`, ... */
export function findMinimalApiEndpoints(source: string): ApiEndpoint[] {
  const groups = collectGroups(source);
  const endpoints: ApiEndpoint[] = [];
  const pattern = /([A-Za-z_]\w*)\s*\.\s*(MapGet|MapPost|MapPut|MapPatch|MapDelete)\s*(?:<[^>]*>\s*)?\(\s*(@?"(?:[^"\\]|\\.)*")/g;

  for (const match of source.matchAll(pattern)) {
    const receiver = match[1]!;
    const method = MAP_METHODS[match[2]!]!;
    const route = literal(match[3]!);
    if (route === null) continue;

    const prefix = groups.get(receiver) ?? '';

    endpoints.push({
      method,
      route: joinRoutes(prefix, route),
      line: lineOf(source, match.index ?? 0),
      source: 'minimal',
      name: nameAfterMap(source, (match.index ?? 0) + match[0].length),
      group: groups.has(receiver) ? receiver : null,
    });
  }

  return endpoints;
}

/**
 * Nombre del endpoint declarado con `.WithName("...")`, si lo hay cerca.
 *
 * Se mira sólo la misma sentencia (hasta el siguiente `;`) para no atribuirle a un endpoint el
 * nombre del siguiente.
 */
function nameAfterMap(source: string, from: number): string | null {
  const end = source.indexOf(';', from);
  const statement = source.slice(from, end === -1 ? Math.min(from + 400, source.length) : end);
  const match = /\.WithName\s*\(\s*(@?"(?:[^"\\]|\\.)*")/.exec(statement);
  return match ? literal(match[1]!) : null;
}

/** Nombre de la clase sin el sufijo `Controller`: `ProductsController` -> `Products`. */
export function controllerName(className: string): string {
  return className.replace(/Controller$/, '');
}

/**
 * Endpoints declarados con atributos en un controlador.
 *
 * Se recorre el archivo en orden guardando la última clase vista y su `[Route]`: un archivo con
 * dos controladores (raro pero legal) sigue asignando cada método al suyo.
 */
export function findControllerEndpoints(source: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const pattern =
    /\[\s*(Route|Http[A-Za-z]+)\s*(?:\(\s*(@?"(?:[^"\\]|\\.)*")?[^)]*\))?\s*\]|class\s+([A-Za-z_]\w*)/g;

  let currentClass: string | null = null;
  let classRoute = '';
  let pendingRoute: string | null = null;

  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;

    // Declaración de clase: cierra el controlador anterior y adopta el `[Route]` pendiente.
    if (match[3] !== undefined) {
      currentClass = match[3];
      classRoute = pendingRoute ?? '';
      pendingRoute = null;
      continue;
    }

    const attribute = match[1]!;
    const value = match[2] !== undefined ? literal(match[2]) : null;

    if (attribute === 'Route') {
      // Un `[Route]` antes de la clase es el prefijo del controlador; después, la ruta del método.
      if (currentClass === null) pendingRoute = value ?? '';
      else pendingRoute = value ?? '';
      continue;
    }

    const method = HTTP_ATTRIBUTES[attribute];
    if (method === undefined) continue;

    const action = methodNameAfter(source, index);
    const controller = currentClass === null ? null : controllerName(currentClass);
    const prefix = expandRouteTokens(classRoute, controller, action);
    const suffix = expandRouteTokens(value ?? pendingRoute ?? '', controller, action);
    pendingRoute = null;

    endpoints.push({
      method,
      route: joinRoutes(prefix, suffix),
      line: lineOf(source, index),
      source: 'controller',
      name: action,
      group: currentClass,
    });
  }

  return endpoints;
}

/** Nombre del método que sigue a un atributo, saltándose otros atributos y modificadores. */
function methodNameAfter(source: string, from: number): string | null {
  const window = source.slice(from, from + 600);
  const match = /\b(?:public|internal|protected|private)\s[\s\S]*?\b([A-Za-z_]\w*)\s*\(/.exec(window);
  return match ? match[1]! : null;
}

/** Todos los endpoints del archivo, ordenados por línea. */
export function findEndpoints(source: string): ApiEndpoint[] {
  return [...findMinimalApiEndpoints(source), ...findControllerEndpoints(source)].sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------------------------
// Generación del archivo .http
// ---------------------------------------------------------------------------------------------

/** Valor de ejemplo para un parámetro de ruta, según su nombre y su restricción de tipo. */
export function sampleForParameter(parameter: string): string {
  const [rawName = '', constraint = ''] = parameter.split(':');
  const name = rawName.toLowerCase();

  if (constraint.startsWith('int') || constraint.startsWith('long')) return '1';
  if (constraint.startsWith('guid')) return '00000000-0000-0000-0000-000000000000';
  if (constraint.startsWith('datetime')) return '2026-01-01';
  if (name.endsWith('id')) return '1';
  return 'valor';
}

/** Sustituye `{id:int}` por un valor de ejemplo, dejando la ruta lista para enviarse. */
export function fillRouteParameters(route: string): string {
  return route.replace(/\{([^}]+)\}/g, (_match, parameter: string) =>
    sampleForParameter(parameter.replace(/\?$/, '')),
  );
}

/** Cuerpo de ejemplo para los verbos que lo llevan. */
function sampleBody(endpoint: ApiEndpoint): string {
  if (endpoint.method === 'GET' || endpoint.method === 'DELETE' || endpoint.method === 'HEAD') return '';
  return '\nContent-Type: application/json\n\n{\n  "nombre": "ejemplo"\n}';
}

export interface HttpFileOptions {
  /** Nombre de la variable de base: `@host = https://localhost:7001`. */
  variable?: string;
  baseUrl?: string;
  title?: string;
}

/**
 * Archivo `.http` completo a partir de una lista de endpoints.
 *
 * La URL base sale a una variable en vez de repetirse en cada petición: cambiar de entorno debe
 * ser editar una línea, no veinte.
 */
export function buildHttpFile(endpoints: readonly ApiEndpoint[], options: HttpFileOptions = {}): string {
  const variable = options.variable ?? 'host';
  const baseUrl = options.baseUrl ?? 'https://localhost:7001';
  const title = options.title ?? 'Peticiones generadas por DotForge';

  const head = [`# ${title}`, `@${variable} = ${baseUrl}`, ''].join('\n');

  const blocks = endpoints.map((endpoint) => requestFor(endpoint, variable));

  return `${head}\n${blocks.join('\n\n')}\n`;
}

/** Una petición suelta, tal como se inserta desde la lente de código. */
export function requestFor(endpoint: ApiEndpoint, variable = 'host'): string {
  const label = endpoint.name ?? `${endpoint.method} ${endpoint.route}`;
  const url = `{{${variable}}}${fillRouteParameters(endpoint.route)}`;

  return `### ${label}\n${endpoint.method} ${url}\nAccept: application/json${sampleBody(endpoint)}`;
}

/** Nombre del archivo `.http` de un proyecto: `Acme.WebApi.http`, junto al `.csproj`. */
export function httpFileNameFor(projectName: string): string {
  return `${projectName}.http`;
}
