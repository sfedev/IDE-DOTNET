/**
 * Perfiles de la terminal: qué se puede abrir en una pestaña nueva.
 *
 * Hasta la v2.4 sólo había una terminal y era la **asistida**: sin pseudoterminal, con lista blanca
 * de programas y autocompletado de `dotnet` y `git` mientras se escribe. Cubre el 95 % de lo que se
 * hace en un flujo .NET y no cubre nada interactivo: ni un REPL, ni `dotnet user-secrets set` con
 * su aviso, ni un `git rebase -i`, ni el propio prompt de PowerShell con sus colores. Para eso hay
 * que salir del IDE, que es exactamente lo que un IDE está para evitar.
 *
 * Desde la v2.5 conviven las dos clases (ADR-059):
 *
 *  - **`pty`**: un intérprete de verdad detrás de un pseudoterminal (`node-pty` + `xterm.js`).
 *    Colores, `Ctrl+C`, autocompletado nativo, `cd` gobernado por el propio intérprete.
 *  - **`lite`**: la asistida de siempre, que no desaparece. Sigue siendo la única que sabe sugerir
 *    subcomandos y ramas, y la única que funciona si `node-pty` no está disponible.
 *
 * Este archivo es dato puro: ni `node:*`, ni `electron`, ni DOM. Lo consumen el proceso principal
 * (para lanzar), el renderer (para pintar el selector) y las pruebas.
 */

/** Cómo se ejecuta lo que se escribe en una pestaña de terminal. */
export type TerminalKind = 'pty' | 'lite';

/** Un programa concreto con sus argumentos, ya troceados. Nunca una línea de shell. */
export interface TerminalLaunch {
  file: string;
  args: readonly string[];
}

/**
 * Con qué se acabó lanzando, y si eso es lo que el perfil pedía.
 *
 * `requested` es el programa del catálogo, antes de resolver; `file` es la ruta que salió de
 * buscarlo. La diferencia importa cuando se ha usado una alternativa: `npx --yes
 * @anthropic-ai/claude-code` no es "claude", es **otra instalación** que se descarga de la red, y
 * el usuario tiene derecho a saber que no está usando la suya.
 */
export interface ResolvedLaunch extends TerminalLaunch {
  /** El programa que declara el perfil, tal cual está en el catálogo. */
  requested: string;
  /** true si el principal no estaba y se ha recurrido a una alternativa. */
  substituted: boolean;
}

export interface TerminalProfile {
  id: string;
  label: string;
  kind: TerminalKind;
  /** Programa del intérprete. `null` en la terminal asistida, que no lanza ninguno. */
  file: string | null;
  /** Argumentos del intérprete, ya troceados: nunca una línea de shell. */
  args: readonly string[];
  /**
   * Otras formas de lanzar lo mismo, en orden de preferencia, si `file` no está instalado.
   *
   * Existe por una herramienta que no es un intérprete del sistema: `claude` se instala de tres
   * maneras distintas —el instalador nativo, `npm install -g` (que en Windows deja un `.cmd` y no
   * un `.exe`) y `npx` sin instalar nada— y ninguna de las tres es "la buena". Un catálogo con un
   * único programa obligaría a elegir una y declarar no disponible a quien tenga otra.
   *
   * **Siguen saliendo del catálogo**: son una lista cerrada escrita aquí, no algo que nadie pueda
   * mandar. La garantía del ADR-059 es que el renderer manda un identificador y nada más, y eso no
   * cambia.
   */
  fallbacks?: readonly TerminalLaunch[];
  /** Plataformas en las que se ofrece (`process.platform`). */
  platforms: readonly string[];
  /** Una línea diciendo qué aporta y qué no. Se enseña en el menú del botón `+`. */
  hint: string;
  /**
   * Qué hacer si no está instalado, con la orden concreta.
   *
   * Para un intérprete del sistema no hace falta —"pwsh.exe no está instalado" ya lo dice todo—,
   * pero una herramienta que se instala con npm merece que el IDE diga **cómo**: quien abre el menú
   * y ve una opción atenuada no tiene por qué saber de dónde sale.
   */
  install?: string;
}

const WINDOWS = ['win32'];
const UNIX = ['darwin', 'linux'];
const ALL = ['win32', 'darwin', 'linux'];

/**
 * Catálogo.
 *
 * El orden es el del menú, y no es alfabético: primero lo que se va a elegir. En Windows eso es
 * PowerShell, que es el intérprete que asume la documentación de .NET —`dotnet user-secrets`,
 * `dotnet ef`, los scripts de publicación— aunque el `cmd` siga estando debajo.
 *
 * `pwsh` (PowerShell 7) va antes que `powershell` (el 5.1 de Windows) porque quien lo tiene
 * instalado lo tiene por algo. Que el programa exista o no lo comprueba quien lanza: aquí sólo se
 * declara, y una lista que mienta sobre lo que hay instalado sería peor que una lista larga.
 */
export const TERMINAL_PROFILES: readonly TerminalProfile[] = [
  {
    id: 'pwsh',
    label: 'PowerShell 7',
    kind: 'pty',
    file: 'pwsh.exe',
    args: ['-NoLogo'],
    platforms: WINDOWS,
    hint: 'PowerShell moderno, si está instalado. Intérprete completo con colores y Ctrl+C.',
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    kind: 'pty',
    file: 'powershell.exe',
    args: ['-NoLogo'],
    platforms: WINDOWS,
    hint: 'El PowerShell que trae Windows. Intérprete completo con colores y Ctrl+C.',
  },
  {
    id: 'cmd',
    label: 'Símbolo del sistema',
    kind: 'pty',
    file: 'cmd.exe',
    args: [],
    platforms: WINDOWS,
    hint: 'cmd.exe, para scripts `.bat` y para lo que no le gusta a PowerShell.',
  },
  {
    id: 'zsh',
    label: 'zsh',
    kind: 'pty',
    file: '/bin/zsh',
    args: ['-l'],
    platforms: UNIX,
    hint: 'El intérprete por defecto de macOS, como sesión de inicio.',
  },
  {
    id: 'bash',
    label: 'bash',
    kind: 'pty',
    file: '/bin/bash',
    args: ['-l'],
    platforms: UNIX,
    hint: 'bash como sesión de inicio.',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    kind: 'pty',
    // En Windows, `npm install -g` deja un `claude.cmd`, no un `.exe`: es el caso más frecuente y
    // por eso va primero. El instalador nativo sí deja un ejecutable, y `npx` funciona sin haber
    // instalado nada. `programExists` resuelve por `PATH` y `PATHEXT`, así que `claude` a secas
    // encuentra también el script sin extensión de macOS y Linux.
    file: 'claude',
    args: [],
    fallbacks: [
      { file: 'claude.cmd', args: [] },
      { file: 'claude.exe', args: [] },
      { file: 'npx', args: ['--yes', '@anthropic-ai/claude-code'] },
    ],
    platforms: ALL,
    hint: 'El asistente de Anthropic en su propia pestaña, sobre la solución abierta.',
    install: 'Instálalo con: npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'lite',
    label: 'Terminal asistida',
    kind: 'lite',
    file: null,
    args: [],
    platforms: ALL,
    hint: 'Sin pseudoterminal: lista blanca de programas y sugerencias de dotnet y git al escribir.',
  },
];

/** Perfiles que tienen sentido en esta plataforma, en el orden del menú. */
export function profilesFor(platform: string): TerminalProfile[] {
  return TERMINAL_PROFILES.filter((profile) => profile.platforms.includes(platform));
}

export function findProfile(id: string): TerminalProfile | null {
  return TERMINAL_PROFILES.find((profile) => profile.id === id) ?? null;
}

/**
 * Todas las formas de lanzar un perfil, en orden de preferencia.
 *
 * La primera es la del propio perfil; detrás van sus alternativas. Un perfil sin programa (la
 * asistida) no tiene ninguna, y quien la pida se lleva una lista vacía en vez de un `null` que
 * haya que comprobar en tres sitios.
 */
export function launchCandidates(profile: TerminalProfile): TerminalLaunch[] {
  if (profile.kind !== 'pty' || profile.file === null) return [];
  return [{ file: profile.file, args: [...profile.args] }, ...(profile.fallbacks ?? [])];
}

/**
 * Con cuál de las alternativas se lanza este perfil en esta máquina, o `null` si con ninguna.
 *
 * La búsqueda se **inyecta** en vez de hacerse aquí: este módulo es puro y se prueba sin tocar el
 * disco, y quien sabe mirar el `PATH` es el proceso principal.
 *
 * Devuelve la **ruta ya resuelta**, no el nombre que se buscó, y esa diferencia no es cosmética:
 * en Windows, `CreateProcess` busca por `PATH` pero sólo prueba `.exe`, así que un `npx` —que es un
 * `npx.cmd`— se encuentra al comprobar y **falla al lanzarse**, con un "Cannot create process,
 * error code: 2" que no menciona ni el programa ni la extensión.
 */
export async function resolveLaunch(
  profile: TerminalProfile,
  resolveProgram: (file: string) => Promise<string | null>,
): Promise<ResolvedLaunch | null> {
  const candidates = launchCandidates(profile);
  for (const [index, candidate] of candidates.entries()) {
    const resolved = await resolveProgram(candidate.file);
    if (resolved !== null) {
      return {
        file: resolved,
        args: candidate.args,
        requested: candidate.file,
        // La primera del catálogo es la que el perfil pide; cualquier otra es un sustituto.
        substituted: index > 0,
      };
    }
  }
  return null;
}

/**
 * Por qué no se puede abrir este perfil, con la orden de instalación si el catálogo la declara.
 *
 * Un perfil atenuado sin motivo es peor que uno ausente: el usuario ve una opción que no responde
 * y no tiene dónde mirar.
 */
export function unavailableReason(profile: TerminalProfile): string {
  const missing = `${profile.file ?? profile.id} no está instalado.`;
  return profile.install === undefined ? missing : `${missing} ${profile.install}`;
}

/**
 * Qué decir cuando se ha lanzado con una alternativa, o `null` si se usó la principal.
 *
 * Existe por un fallo real y difícil de adivinar. `claude` instalado con el instalador nativo vive
 * en una carpeta que **el instalador añade al `PATH` del registro**, pero un proceso ya en marcha
 * —el Explorador de Windows, entre otros— conserva el `PATH` que tenía al arrancar y se lo pasa a
 * todo lo que lanza. Con el IDE abierto desde ese Explorador, `claude` no se encuentra, la búsqueda
 * sigue bajando por el catálogo y acaba en `npx`, que **descarga otra copia distinta** de la red.
 *
 * Lo que veía el usuario era una pestaña que tardaba muchísimo o fallaba sin explicar nada, con su
 * Claude Code perfectamente instalado. El silencio era el problema: la alternativa hacía su trabajo
 * y no decía que estaba usando otra cosa.
 *
 * El aviso no interrumpe ni pregunta: se escribe en la propia pestaña, antes de la primera línea
 * del intérprete, y dice qué falta, con qué se ha arrancado y qué hacer.
 */
export function substitutionNotice(profile: TerminalProfile, launch: ResolvedLaunch): string | null {
  if (!launch.substituted) return null;

  const usado = [launch.requested, ...launch.args].join(' ');
  const detalle =
    launch.requested === 'npx'
      ? `Eso descarga el paquete de npm, que no es tu instalación local.`
      : `Es otra forma de instalarlo, no la que declara el perfil.`;

  return [
    `No he encontrado «${profile.file}» en el PATH.`,
    `Arranco con «${usado}». ${detalle}`,
    `Si lo tienes instalado, su carpeta no está en el PATH de este proceso: reinicia el IDE`,
    `—y si lo instalaste con la sesión ya abierta, reinicia también el Explorador o la sesión—.`,
  ].join('\n');
}

/**
 * Perfil de la pestaña que se abre sola.
 *
 * En Windows, PowerShell; en el resto, el primero de la plataforma. La asistida **no** es el
 * predeterminado: quien abre una terminal en un IDE espera una terminal, y descubrir que no
 * ejecuta lo que sea que acaba de escribir es una sorpresa desagradable. Sigue estando a un clic
 * en el menú del `+`, con su ventaja —las sugerencias— dicha en el propio menú.
 */
export function defaultProfileId(platform: string): string {
  if (platform === 'win32') return 'powershell';
  return profilesFor(platform)[0]?.id ?? 'lite';
}

/**
 * Sanea el identificador que llega del renderer.
 *
 * Un perfil desconocido, o uno de otra plataforma, cae al predeterminado en vez de lanzar: el
 * identificador puede venir de una preferencia guardada por otra versión del IDE, y eso no es un
 * error, es una migración.
 */
export function coerceProfileId(value: unknown, platform: string): string {
  if (typeof value !== 'string') return defaultProfileId(platform);

  const profile = findProfile(value);
  if (!profile || !profile.platforms.includes(platform)) return defaultProfileId(platform);

  return profile.id;
}

/**
 * Nombre de una pestaña nueva.
 *
 * Se numera **por perfil** y contando las que ya hay, no con un contador global: con dos
 * PowerShell y un cmd abiertos, "PowerShell 2" dice algo y "Terminal 3" no dice nada. La primera
 * de cada clase va sin número, como en cualquier editor.
 */
export function terminalTabName(profile: TerminalProfile, existingOfSameProfile: number): string {
  return existingOfSameProfile === 0 ? profile.label : `${profile.label} ${existingOfSameProfile + 1}`;
}
