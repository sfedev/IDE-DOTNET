/**
 * Motor de sugerencias de la terminal integrada.
 *
 * Es una función pura: recibe la línea que se está escribiendo y el contexto del workspace
 * (ramas de git, proyectos de la solución) y devuelve candidatos ordenados. No toca el DOM ni
 * hace E/S, así que se prueba con Node puro desde `build/ui-lib.mjs`.
 *
 * Diseño:
 *  - **Sin fuzzy matching.** Se completa por prefijo. En una terminal, una sugerencia que no
 *    empieza por lo que has escrito es ruido: rompe la memoria muscular de escribir y pulsar Tab.
 *  - **El contexto se pasa, no se consulta.** Las ramas y los proyectos llegan ya resueltos desde
 *    el proceso principal; el motor no sabe que existe git.
 *  - **La primera sugerencia manda.** Es la que se pinta como texto fantasma y la que acepta el
 *    tabulador; el resto sólo se ve en el menú.
 */

export type SuggestionKind =
  | 'program'
  | 'subcommand'
  | 'flag'
  | 'branch'
  | 'package'
  | 'project'
  | 'container'
  | 'image'
  | 'script'
  | 'slash';

export interface Suggestion {
  /** Texto que sustituye al token que se está escribiendo. */
  value: string;
  /** Qué se enseña en el menú (normalmente igual que `value`). */
  label: string;
  /** Explicación corta a la derecha. */
  detail: string;
  kind: SuggestionKind;
}

export interface SuggestContext {
  /** Ramas locales y remotas, ya resueltas. */
  branches?: readonly string[];
  /** Nombres de proyecto de la solución abierta. */
  projects?: readonly string[];
  /** Programas que la terminal admite (lista blanca del proceso principal). */
  programs?: readonly string[];
  /**
   * Contenedores de Docker existentes, en ejecución o parados, ya resueltos.
   *
   * Se ofrecen los parados también a propósito: `docker start` y `docker rm` se escriben
   * justamente sobre contenedores que no están corriendo.
   */
  containers?: readonly string[];
  /** Imágenes locales (`repositorio:etiqueta`). */
  images?: readonly string[];
  /** Scripts declarados en el `package.json` del workspace. */
  npmScripts?: readonly string[];
}

interface CommandSpec {
  value: string;
  detail: string;
}

/** Programas de la lista blanca que además tienen sugerencias propias. */
const DEFAULT_PROGRAMS: CommandSpec[] = [
  { value: 'dotnet', detail: 'SDK de .NET' },
  { value: 'git', detail: 'control de versiones' },
  { value: 'npm', detail: 'paquetes de Node' },
  { value: 'npx', detail: 'ejecuta un paquete de Node' },
  { value: 'node', detail: 'runtime de Node' },
  { value: 'docker', detail: 'contenedores' },
  { value: 'az', detail: 'CLI de Azure' },
  // No lo lanza esta terminal: `claude` es una interfaz de pantalla completa y la asistida no tiene
  // pseudoterminal. Escribirlo abre su pestaña, que sí la tiene (ADR-062), y por eso se ofrece aquí:
  // es lo que la gente va a teclear.
  { value: 'claude', detail: 'abre Claude Code en su pestaña' },
];

/** Subcomandos de git, ordenados por frecuencia real de uso, no alfabéticamente. */
const GIT_SUBCOMMANDS: CommandSpec[] = [
  { value: 'status', detail: 'qué ha cambiado' },
  { value: 'add .', detail: 'prepara todos los cambios' },
  { value: 'commit -m ""', detail: 'confirma con mensaje' },
  { value: 'pull', detail: 'trae y fusiona' },
  { value: 'push', detail: 'publica la rama' },
  { value: 'switch', detail: 'cambia de rama' },
  { value: 'checkout -b', detail: 'crea rama y cambia a ella' },
  { value: 'branch', detail: 'lista o crea ramas' },
  { value: 'merge', detail: 'fusiona otra rama' },
  { value: 'rebase', detail: 'reaplica commits sobre otra base' },
  { value: 'log --oneline', detail: 'historial compacto' },
  { value: 'diff', detail: 'cambios sin preparar' },
  { value: 'stash', detail: 'guarda cambios a un lado' },
  { value: 'restore', detail: 'descarta cambios de un archivo' },
  { value: 'fetch', detail: 'trae sin fusionar' },
];

/** Subcomandos de la CLI de .NET, incluidos los compuestos. */
const DOTNET_SUBCOMMANDS: CommandSpec[] = [
  { value: 'build', detail: 'compila' },
  { value: 'run', detail: 'compila y ejecuta' },
  { value: 'watch', detail: 'ejecuta con Hot Reload' },
  { value: 'test', detail: 'ejecuta las pruebas' },
  { value: 'restore', detail: 'restaura paquetes' },
  { value: 'clean', detail: 'borra la salida de compilación' },
  { value: 'format', detail: 'aplica el estilo de código' },
  { value: 'publish', detail: 'genera la salida de publicación' },
  { value: 'add package', detail: 'añade un paquete NuGet' },
  { value: 'add reference', detail: 'añade una referencia de proyecto' },
  { value: 'remove package', detail: 'quita un paquete NuGet' },
  { value: 'list package', detail: 'lista los paquetes del proyecto' },
  { value: 'new', detail: 'crea un proyecto desde plantilla' },
  { value: 'sln add', detail: 'añade un proyecto a la solución' },
  { value: 'ef migrations add', detail: 'crea una migración de EF Core' },
  { value: 'ef database update', detail: 'aplica las migraciones' },
  { value: 'ef migrations list', detail: 'lista las migraciones' },
  { value: 'dev-certs https --trust', detail: 'confía en el certificado de desarrollo' },
  { value: 'tool install --global', detail: 'instala una herramienta global' },
];

/** Paquetes que aparecen una y otra vez en una solución .NET moderna. */
const COMMON_PACKAGES: CommandSpec[] = [
  { value: 'Microsoft.EntityFrameworkCore.Design', detail: 'herramientas de diseño de EF Core' },
  { value: 'Microsoft.EntityFrameworkCore.Sqlite', detail: 'proveedor SQLite' },
  { value: 'Microsoft.EntityFrameworkCore.SqlServer', detail: 'proveedor SQL Server' },
  { value: 'Npgsql.EntityFrameworkCore.PostgreSQL', detail: 'proveedor PostgreSQL' },
  { value: 'Serilog.AspNetCore', detail: 'logging estructurado' },
  { value: 'Scalar.AspNetCore', detail: 'documentación de API' },
  { value: 'FluentValidation', detail: 'validación de mensajes' },
  { value: 'xunit', detail: 'framework de pruebas' },
  { value: 'xunit.runner.visualstudio', detail: 'runner de xUnit' },
  { value: 'Microsoft.NET.Test.Sdk', detail: 'infraestructura de pruebas' },
  { value: 'NSubstitute', detail: 'dobles de prueba' },
  { value: 'Bogus', detail: 'datos falsos para pruebas' },
];

/**
 * Subcomandos de Docker, ordenados por lo que se teclea de verdad en un flujo .NET.
 *
 * `compose up -d` va arriba del todo por un motivo concreto: en una solución con SQL Server o
 * Redis de apoyo, levantar el compose es lo primero que se hace cada mañana.
 */
const DOCKER_SUBCOMMANDS: CommandSpec[] = [
  { value: 'compose up -d', detail: 'levanta los servicios en segundo plano' },
  { value: 'compose down', detail: 'para y elimina los servicios' },
  { value: 'ps', detail: 'contenedores en ejecución' },
  { value: 'ps -a', detail: 'todos los contenedores, parados incluidos' },
  { value: 'logs -f', detail: 'sigue la salida de un contenedor' },
  { value: 'exec -it', detail: 'abre un comando dentro del contenedor' },
  { value: 'build -t', detail: 'construye una imagen con etiqueta' },
  { value: 'run', detail: 'crea y arranca un contenedor' },
  { value: 'start', detail: 'arranca un contenedor parado' },
  { value: 'stop', detail: 'para un contenedor' },
  { value: 'restart', detail: 'reinicia un contenedor' },
  { value: 'rm', detail: 'elimina un contenedor' },
  { value: 'images', detail: 'imágenes locales' },
  { value: 'pull', detail: 'descarga una imagen' },
  { value: 'inspect', detail: 'detalle en JSON' },
  { value: 'stats', detail: 'consumo en vivo' },
  { value: 'system prune -f', detail: 'libera espacio de lo no usado' },
];

/** Subcomandos de `docker compose`. */
const COMPOSE_SUBCOMMANDS: CommandSpec[] = [
  { value: 'up -d', detail: 'levanta en segundo plano' },
  { value: 'up --build', detail: 'reconstruye y levanta' },
  { value: 'down', detail: 'para y elimina' },
  { value: 'down -v', detail: 'para y borra también los volúmenes' },
  { value: 'ps', detail: 'estado de los servicios' },
  { value: 'logs -f', detail: 'sigue la salida' },
  { value: 'build', detail: 'construye las imágenes' },
  { value: 'restart', detail: 'reinicia los servicios' },
  { value: 'pull', detail: 'descarga las imágenes' },
  { value: 'exec', detail: 'ejecuta dentro de un servicio' },
  { value: 'config', detail: 'muestra la configuración resuelta' },
];

/** Subcomandos de la CLI de Azure, acotados a lo que usa un desarrollador .NET. */
const AZ_SUBCOMMANDS: CommandSpec[] = [
  { value: 'login', detail: 'inicia sesión en Azure' },
  { value: 'account show', detail: 'suscripción activa' },
  { value: 'account set --subscription', detail: 'cambia de suscripción' },
  { value: 'webapp up', detail: 'publica la aplicación en App Service' },
  { value: 'webapp list --output table', detail: 'lista las webapps' },
  { value: 'webapp log tail', detail: 'sigue el log en vivo' },
  { value: 'webapp deployment source config-zip', detail: 'despliega un zip' },
  { value: 'webapp config appsettings set', detail: 'cambia la configuración' },
  { value: 'group create', detail: 'crea un grupo de recursos' },
  { value: 'group list --output table', detail: 'lista los grupos' },
  { value: 'group delete', detail: 'borra un grupo de recursos' },
  { value: 'sql server create', detail: 'crea un servidor SQL' },
  { value: 'sql db create', detail: 'crea una base de datos' },
  { value: 'containerapp up', detail: 'publica un contenedor en Container Apps' },
  { value: 'acr build', detail: 'construye la imagen en el registro' },
  { value: 'acr login', detail: 'autentica contra el registro' },
  { value: 'staticwebapp create', detail: 'crea una Static Web App (Blazor WASM)' },
  { value: 'keyvault secret show', detail: 'lee un secreto' },
  { value: 'logout', detail: 'cierra la sesión' },
];

/** Grupos de `az` que se completan solos al escribir el primer nivel. */
const AZ_GROUPS: Record<string, CommandSpec[]> = {
  webapp: [
    { value: 'up', detail: 'publica la aplicación' },
    { value: 'list --output table', detail: 'lista las webapps' },
    { value: 'log tail', detail: 'sigue el log en vivo' },
    { value: 'restart', detail: 'reinicia la aplicación' },
    { value: 'create', detail: 'crea una webapp' },
    { value: 'delete', detail: 'borra una webapp' },
  ],
  group: [
    { value: 'create --name', detail: 'crea un grupo de recursos' },
    { value: 'list --output table', detail: 'lista los grupos' },
    { value: 'delete --name', detail: 'borra un grupo' },
  ],
  sql: [
    { value: 'server create', detail: 'crea un servidor SQL' },
    { value: 'db create', detail: 'crea una base de datos' },
    { value: 'db list --output table', detail: 'lista las bases de datos' },
  ],
  acr: [
    { value: 'build --registry', detail: 'construye la imagen en el registro' },
    { value: 'login --name', detail: 'autentica contra el registro' },
    { value: 'repository list', detail: 'lista los repositorios' },
  ],
  containerapp: [
    { value: 'up', detail: 'publica el contenedor' },
    { value: 'list --output table', detail: 'lista las aplicaciones' },
    { value: 'logs show', detail: 'muestra el log' },
  ],
  account: [
    { value: 'show', detail: 'suscripción activa' },
    { value: 'list --output table', detail: 'lista las suscripciones' },
    { value: 'set --subscription', detail: 'cambia de suscripción' },
  ],
};

/** Subcomandos de npm. Los scripts del `package.json` llegan por contexto. */
const NPM_SUBCOMMANDS: CommandSpec[] = [
  { value: 'run', detail: 'ejecuta un script del package.json' },
  { value: 'install', detail: 'instala las dependencias' },
  { value: 'ci', detail: 'instala exactamente el lockfile' },
  { value: 'install --save-dev', detail: 'añade una dependencia de desarrollo' },
  { value: 'uninstall', detail: 'quita una dependencia' },
  { value: 'update', detail: 'actualiza dentro del rango' },
  { value: 'outdated', detail: 'qué se ha quedado atrás' },
  { value: 'audit fix', detail: 'corrige vulnerabilidades' },
  { value: 'version patch', detail: 'sube la versión de parche' },
  { value: 'publish --dry-run', detail: 'ensaya la publicación' },
];

/** Argumentos habituales de `node`. */
const NODE_SUBCOMMANDS: CommandSpec[] = [
  { value: '--version', detail: 'versión instalada' },
  { value: '--test', detail: 'runner de pruebas nativo' },
  { value: '--watch', detail: 'reinicia al cambiar un archivo' },
  { value: '--inspect', detail: 'abre el depurador' },
  { value: '--env-file=.env', detail: 'carga variables de un archivo' },
];

/**
 * Subcomandos de la CLI de Claude Code.
 *
 * Sólo los que no abren la interfaz interactiva —esos se escriben dentro de la sesión— más las dos
 * banderas que más se usan al arrancarla. Es la lista que sirve **antes** de entrar.
 */
const CLAUDE_SUBCOMMANDS: CommandSpec[] = [
  { value: '--continue', detail: 'retoma la última conversación' },
  { value: '--resume', detail: 'elige una conversación anterior' },
  { value: 'doctor', detail: 'diagnostica la instalación' },
  { value: 'update', detail: 'actualiza la CLI' },
  { value: 'mcp', detail: 'servidores MCP configurados' },
  { value: 'config', detail: 'ajustes de la CLI' },
];

/**
 * Órdenes de barra de una sesión de Claude Code.
 *
 * Se escriben **dentro** de la sesión, que es una pestaña de pseudoterminal donde este motor no
 * interviene: ahí el autocompletado lo pone Claude. Están aquí como referencia, y se ofrecen cuando
 * la línea empieza por `/`, que en la terminal asistida no significa ninguna otra cosa — ningún
 * programa de la lista blanca empieza por barra.
 */
const CLAUDE_SLASH_COMMANDS: CommandSpec[] = [
  { value: '/help', detail: 'todas las órdenes disponibles' },
  { value: '/clear', detail: 'vacía el contexto de la conversación' },
  { value: '/compact', detail: 'resume el contexto para que quepa más' },
  { value: '/cost', detail: 'lo que llevas gastado en la sesión' },
  { value: '/context', detail: 'en qué se está yendo el contexto' },
  { value: '/model', detail: 'cambia de modelo' },
  { value: '/review', detail: 'revisa los cambios pendientes' },
  { value: '/doctor', detail: 'diagnostica la instalación' },
  { value: '/config', detail: 'ajustes de la sesión' },
  { value: '/status', detail: 'versión, cuenta y conexión' },
  { value: '/bug', detail: 'informa de un fallo a Anthropic' },
  { value: '/init', detail: 'genera un CLAUDE.md del repositorio' },
  { value: '/memory', detail: 'edita los archivos de memoria' },
  { value: '/agents', detail: 'sub-agentes disponibles' },
  { value: '/exit', detail: 'cierra la sesión' },
];

/** Subcomandos de Docker que esperan un contenedor como argumento siguiente. */
const DOCKER_CONTAINER_COMMANDS = new Set([
  'logs', 'exec', 'stop', 'start', 'restart', 'rm', 'inspect', 'attach', 'top', 'port', 'kill', 'cp', 'stats',
]);

/** Subcomandos de Docker que esperan una imagen. */
const DOCKER_IMAGE_COMMANDS = new Set(['run', 'rmi', 'push', 'pull', 'tag', 'save', 'history', 'create']);

const GIT_BRANCH_COMMANDS = new Set(['checkout', 'switch', 'merge', 'rebase', 'cherry-pick']);

/** Flags que se piden a menudo justo después del subcomando. */
const FLAGS: Record<string, CommandSpec[]> = {
  'dotnet build': [
    { value: '--configuration Release', detail: 'compila en Release' },
    { value: '--no-restore', detail: 'no restaura antes' },
    { value: '--nologo', detail: 'sin cabecera' },
  ],
  'dotnet run': [
    { value: '--project', detail: 'proyecto a ejecutar' },
    { value: '--launch-profile', detail: 'perfil de launchSettings.json' },
    { value: '--no-build', detail: 'no compila antes' },
  ],
  'dotnet watch': [{ value: '--project', detail: 'proyecto a observar' }],
  'dotnet test': [
    { value: '--filter', detail: 'selecciona pruebas por nombre' },
    { value: '--logger "console;verbosity=detailed"', detail: 'salida detallada' },
    { value: '--collect:"XPlat Code Coverage"', detail: 'cobertura' },
  ],
  'git push': [
    { value: '--set-upstream origin', detail: 'publica y enlaza la rama' },
    { value: '--force-with-lease', detail: 'reescribe sin pisar a otros' },
  ],
  'git log': [
    { value: '--oneline', detail: 'una línea por commit' },
    { value: '--graph', detail: 'dibuja las ramas' },
  ],
  'docker build': [
    { value: '-t', detail: 'etiqueta de la imagen' },
    { value: '-f', detail: 'Dockerfile alternativo' },
    { value: '--no-cache', detail: 'construye sin caché' },
  ],
  'docker ps': [
    { value: '-a', detail: 'incluye los parados' },
    { value: '--filter status=running', detail: 'sólo los que están arriba' },
  ],
  'npm install': [
    { value: '--save-dev', detail: 'dependencia de desarrollo' },
    { value: '--save-exact', detail: 'fija la versión exacta' },
  ],
};

/**
 * Trocea la línea en tokens y dice si el cursor está empezando uno nuevo.
 *
 * `"git "` -> tokens `['git']` y `typing = ''` (empieza token nuevo).
 * `"git st"` -> tokens `['git']` y `typing = 'st'`.
 */
export function splitLine(line: string): { tokens: string[]; typing: string } {
  const parts = line.split(/\s+/);
  const trailingSpace = /\s$/.test(line);

  if (trailingSpace) {
    return { tokens: parts.filter((part) => part !== ''), typing: '' };
  }

  const typing = parts[parts.length - 1] ?? '';
  return { tokens: parts.slice(0, -1).filter((part) => part !== ''), typing };
}

function toSuggestions(specs: readonly CommandSpec[], kind: SuggestionKind): Suggestion[] {
  return specs.map((spec) => ({ value: spec.value, label: spec.value, detail: spec.detail, kind }));
}

/** Filtra por prefijo, sin distinguir mayúsculas, conservando el orden de la lista original. */
function byPrefix(suggestions: Suggestion[], typing: string): Suggestion[] {
  if (typing === '') return suggestions;
  const needle = typing.toLowerCase();
  return suggestions.filter((suggestion) => suggestion.value.toLowerCase().startsWith(needle));
}

/**
 * Sugerencias para la línea que se está escribiendo.
 *
 * Devuelve una lista vacía cuando no hay nada útil que decir, que es lo correcto: una terminal
 * que sugiere siempre algo acaba estorbando.
 */
export function suggest(line: string, context: SuggestContext = {}): Suggestion[] {
  const { tokens, typing } = splitLine(line);

  // Una barra al principio: órdenes de una sesión de Claude Code. Va antes que nada porque `/`
  // no es el principio de ningún programa de la lista blanca.
  if (tokens.length === 0 && typing.startsWith('/')) {
    return byPrefix(toSuggestions(CLAUDE_SLASH_COMMANDS, 'slash'), typing);
  }

  // Primer token: el programa.
  if (tokens.length === 0) {
    const extra = (context.programs ?? [])
      .filter((program) => !DEFAULT_PROGRAMS.some((known) => known.value === program))
      .map((program) => ({ value: program, detail: 'programa permitido' }));

    return byPrefix(toSuggestions([...DEFAULT_PROGRAMS, ...extra], 'program'), typing);
  }

  const program = tokens[0]!.toLowerCase();

  if (program === 'git') return byPrefix(gitSuggestions(tokens, context), typing);
  if (program === 'dotnet') return byPrefix(dotnetSuggestions(tokens, context), typing);
  if (program === 'docker') return byPrefix(dockerSuggestions(tokens, context), typing);
  if (program === 'az') return byPrefix(azureSuggestions(tokens), typing);
  if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
    return byPrefix(npmSuggestions(tokens, context), typing);
  }
  if (program === 'node') return byPrefix(toSuggestions(NODE_SUBCOMMANDS, 'flag'), typing);
  if (program === 'claude') return byPrefix(toSuggestions(CLAUDE_SUBCOMMANDS, 'subcommand'), typing);

  return [];
}

/**
 * Sugerencias de Docker.
 *
 * La regla que hace útil esto no es la lista de subcomandos —esa se aprende— sino la segunda
 * palabra: `docker logs ` ofrece **tus** contenedores y `docker run ` ofrece **tus** imágenes. Es
 * la diferencia entre autocompletar y recordarle a alguien lo que tiene levantado.
 */
function dockerSuggestions(tokens: string[], context: SuggestContext): Suggestion[] {
  if (tokens.length === 1) return toSuggestions(DOCKER_SUBCOMMANDS, 'subcommand');

  const subcommand = tokens[1]!.toLowerCase();

  if (subcommand === 'compose') {
    if (tokens.length === 2) return toSuggestions(COMPOSE_SUBCOMMANDS, 'subcommand');

    // `docker compose logs `, `docker compose exec `... esperan un servicio, que en la práctica
    // se llama igual que el contenedor que levanta.
    const composeCommand = tokens[2]!.toLowerCase();
    if (['logs', 'exec', 'restart', 'stop', 'start', 'up', 'build', 'pull'].includes(composeCommand)) {
      return containerSuggestions(context);
    }
    return [];
  }

  if (DOCKER_CONTAINER_COMMANDS.has(subcommand)) return containerSuggestions(context);
  if (DOCKER_IMAGE_COMMANDS.has(subcommand)) return imageSuggestions(context);

  return toSuggestions(FLAGS[`docker ${subcommand}`] ?? [], 'flag');
}

function containerSuggestions(context: SuggestContext): Suggestion[] {
  return (context.containers ?? []).map((name) => ({
    value: name,
    label: name,
    detail: 'contenedor',
    kind: 'container' as const,
  }));
}

function imageSuggestions(context: SuggestContext): Suggestion[] {
  return (context.images ?? []).map((name) => ({
    value: name,
    label: name,
    detail: 'imagen local',
    kind: 'image' as const,
  }));
}

/**
 * Sugerencias de la CLI de Azure.
 *
 * `az` tiene miles de comandos; aquí sólo están los del camino de un desarrollador .NET que
 * publica una API o un Blazor. Al escribir el grupo (`az webapp `) se ofrecen sus operaciones,
 * que es donde de verdad se pierde el tiempo buscando en la documentación.
 */
function azureSuggestions(tokens: string[]): Suggestion[] {
  if (tokens.length === 1) return toSuggestions(AZ_SUBCOMMANDS, 'subcommand');

  const group = tokens[1]!.toLowerCase();
  return toSuggestions(AZ_GROUPS[group] ?? [], 'subcommand');
}

/** Sugerencias de npm: subcomandos y, tras `npm run`, los scripts reales del `package.json`. */
function npmSuggestions(tokens: string[], context: SuggestContext): Suggestion[] {
  if (tokens.length === 1) return toSuggestions(NPM_SUBCOMMANDS, 'subcommand');

  const subcommand = tokens[1]!.toLowerCase();

  if (subcommand === 'run' || subcommand === 'run-script') {
    return (context.npmScripts ?? []).map((script) => ({
      value: script,
      label: script,
      detail: 'script del package.json',
      kind: 'script' as const,
    }));
  }

  return toSuggestions(FLAGS[`npm ${subcommand}`] ?? [], 'flag');
}

function gitSuggestions(tokens: string[], context: SuggestContext): Suggestion[] {
  const subcommand = tokens[1]?.toLowerCase();

  if (tokens.length === 1) return toSuggestions(GIT_SUBCOMMANDS, 'subcommand');

  // `git checkout `, `git switch `, `git merge `... esperan una rama.
  if (subcommand && GIT_BRANCH_COMMANDS.has(subcommand)) {
    // `git checkout -b nombre-nuevo` no completa ramas: la rama todavía no existe.
    if (tokens.includes('-b') || tokens.includes('-c')) return [];

    const branches = context.branches ?? [];
    if (branches.length > 0) {
      return branches.map((branch) => ({
        value: branch,
        label: branch,
        detail: branch.startsWith('origin/') ? 'rama remota' : 'rama local',
        kind: 'branch' as const,
      }));
    }
  }

  return toSuggestions(FLAGS[`git ${subcommand}`] ?? [], 'flag');
}

function dotnetSuggestions(tokens: string[], context: SuggestContext): Suggestion[] {
  if (tokens.length === 1) return toSuggestions(DOTNET_SUBCOMMANDS, 'subcommand');

  const rest = tokens.slice(1).map((token) => token.toLowerCase());

  // `dotnet add package `, `dotnet remove package `
  if ((rest[0] === 'add' || rest[0] === 'remove') && rest[1] === 'package') {
    return toSuggestions(COMMON_PACKAGES, 'package');
  }

  // `dotnet add ` -> package | reference
  if (rest[0] === 'add' && rest.length === 1) {
    return toSuggestions(
      [
        { value: 'package', detail: 'añade un paquete NuGet' },
        { value: 'reference', detail: 'añade una referencia de proyecto' },
      ],
      'subcommand',
    );
  }

  // `dotnet ef ` -> subcomandos compuestos, ya escritos enteros en la lista principal.
  if (rest[0] === 'ef' && rest.length === 1) {
    return toSuggestions(
      [
        { value: 'migrations add', detail: 'crea una migración' },
        { value: 'database update', detail: 'aplica las migraciones' },
        { value: 'migrations list', detail: 'lista las migraciones' },
        { value: 'migrations remove', detail: 'quita la última migración' },
      ],
      'subcommand',
    );
  }

  // `dotnet run --project `, `dotnet watch --project `, `dotnet build `
  const last = rest[rest.length - 1];
  if (last === '--project' || (rest[0] === 'build' && rest.length === 1) || (rest[0] === 'test' && rest.length === 1)) {
    const projects = context.projects ?? [];
    if (projects.length > 0 && last === '--project') {
      return projects.map((project) => ({
        value: project,
        label: project,
        detail: 'proyecto de la solución',
        kind: 'project' as const,
      }));
    }
  }

  return toSuggestions(FLAGS[`dotnet ${rest[0]}`] ?? [], 'flag');
}

/**
 * Texto fantasma: lo que falta por escribir para completar la primera sugerencia.
 *
 * Devuelve `null` si no hay nada que añadir, para que la UI no pinte un fantasma vacío.
 */
export function ghostText(line: string, suggestions: readonly Suggestion[]): string | null {
  const first = suggestions[0];
  if (!first) return null;

  const { typing } = splitLine(line);
  if (!first.value.toLowerCase().startsWith(typing.toLowerCase())) return null;

  const remainder = first.value.slice(typing.length);
  return remainder === '' ? null : remainder;
}

/**
 * Aplica una sugerencia a la línea.
 *
 * Sustituye el token que se estaba escribiendo y deja un espacio al final para seguir escribiendo,
 * salvo cuando la sugerencia termina en comillas —`commit -m ""`—, donde lo natural es dejar el
 * cursor dentro. La UI se encarga de colocarlo.
 */
export function applySuggestion(line: string, suggestion: Suggestion): string {
  const { tokens, typing } = splitLine(line);
  const prefix = tokens.length > 0 ? `${tokens.join(' ')} ` : '';
  const completed = `${prefix}${suggestion.value}`;

  return endsInsideQuotes(suggestion.value) ? completed : `${completed} `;
}

/** `git commit -m ""` deja el cursor entre las comillas; nada más lo hace. */
export function endsInsideQuotes(value: string): boolean {
  return value.endsWith('""');
}

/**
 * Posición del cursor tras aceptar una sugerencia: dentro de las comillas si las hay, y al final
 * en cualquier otro caso.
 */
export function caretAfterApply(applied: string): number {
  return applied.endsWith('""') ? applied.length - 1 : applied.length;
}

/** Expuesto para las pruebas y para la ayuda de la propia terminal. */
export const SUGGESTION_SOURCES = {
  programs: DEFAULT_PROGRAMS.map((spec) => spec.value),
  git: GIT_SUBCOMMANDS.map((spec) => spec.value),
  dotnet: DOTNET_SUBCOMMANDS.map((spec) => spec.value),
  packages: COMMON_PACKAGES.map((spec) => spec.value),
  docker: DOCKER_SUBCOMMANDS.map((spec) => spec.value),
  compose: COMPOSE_SUBCOMMANDS.map((spec) => spec.value),
  az: AZ_SUBCOMMANDS.map((spec) => spec.value),
  npm: NPM_SUBCOMMANDS.map((spec) => spec.value),
  node: NODE_SUBCOMMANDS.map((spec) => spec.value),
  claude: CLAUDE_SUBCOMMANDS.map((spec) => spec.value),
  claudeSlash: CLAUDE_SLASH_COMMANDS.map((spec) => spec.value),
} as const;
