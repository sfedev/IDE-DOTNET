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

export interface TerminalProfile {
  id: string;
  label: string;
  kind: TerminalKind;
  /** Programa del intérprete. `null` en la terminal asistida, que no lanza ninguno. */
  file: string | null;
  /** Argumentos del intérprete, ya troceados: nunca una línea de shell. */
  args: readonly string[];
  /** Plataformas en las que se ofrece (`process.platform`). */
  platforms: readonly string[];
  /** Una línea diciendo qué aporta y qué no. Se enseña en el menú del botón `+`. */
  hint: string;
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
