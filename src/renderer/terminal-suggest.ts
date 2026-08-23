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

export type SuggestionKind = 'program' | 'subcommand' | 'flag' | 'branch' | 'package' | 'project';

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

  return [];
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
} as const;
