/**
 * Lectura de `Properties/launchSettings.json`.
 *
 * Por qué existe: al depurar se lanza el ensamblado compilado directamente, y entonces el
 * directorio de trabajo es `bin/Debug/<tfm>` y no hay ninguna variable de entorno puesta. Una
 * aplicación ASP.NET arrancada así cree que está en **Production**: escucha en el puerto 5000 en
 * vez de en el suyo, no carga los *static web assets* (que sólo se activan solos en Development)
 * y avisa en cada petición de que no encuentra `wwwroot`. `dotnet run` no tiene ese problema
 * porque aplica el perfil de `launchSettings.json`; aquí se aplica a mano.
 *
 * El módulo es Node puro y sin estado: se puede probar sin Electron y sin tocar el disco (las
 * funciones de parseo trabajan sobre cadenas).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LaunchProfile {
  name: string;
  /** `Project`, `Executable`, `IISExpress`... Sólo interesa `Project`. */
  commandName: string;
  environmentVariables: Record<string, string>;
  /** Lista separada por `;` de URLs, tal cual la escribe el SDK. */
  applicationUrl: string | null;
}

export interface LaunchEnvironment {
  /** Variables a inyectar en el proceso depurado. Vacío si no hay perfil aplicable. */
  env: Record<string, string>;
  /** Nombre del perfil aplicado, o `null` si no se aplicó ninguno. */
  profile: string | null;
  /** Motivo por el que no se aplicó nada, cuando conviene contárselo al usuario. */
  warning: string | null;
}

const EMPTY: LaunchEnvironment = { env: {}, profile: null, warning: null };

/**
 * Convierte el contenido de un `launchSettings.json` en la lista de perfiles.
 *
 * @throws SyntaxError si el JSON está mal formado. El llamante decide si eso es fatal.
 */
export function parseLaunchSettings(source: string): LaunchProfile[] {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== 'object' || parsed === null) return [];

  const profiles = (parsed as { profiles?: unknown }).profiles;
  if (typeof profiles !== 'object' || profiles === null) return [];

  const result: LaunchProfile[] = [];

  for (const [name, raw] of Object.entries(profiles as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const profile = raw as Record<string, unknown>;

    const variables: Record<string, string> = {};
    const declared = profile['environmentVariables'];
    if (typeof declared === 'object' && declared !== null) {
      for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
        // El SDK admite números y booleanos aquí; el entorno de un proceso sólo admite cadenas.
        if (value !== null && value !== undefined && typeof value !== 'object') {
          variables[key] = String(value);
        }
      }
    }

    const applicationUrl = profile['applicationUrl'];

    result.push({
      name,
      commandName: typeof profile['commandName'] === 'string' ? profile['commandName'] : '',
      environmentVariables: variables,
      applicationUrl: typeof applicationUrl === 'string' && applicationUrl.length > 0 ? applicationUrl : null,
    });
  }

  return result;
}

/**
 * Elige qué perfil aplicar.
 *
 * Mismo criterio que Visual Studio: sólo perfiles `Project` —`IISExpress` necesita IIS y
 * `Executable` lanza otro programa— y, entre ellos, el que se llama como el proyecto; si no
 * existe, el primero declarado, que es el que el SDK considera por defecto.
 */
export function selectProfile(profiles: LaunchProfile[], projectName: string): LaunchProfile | null {
  const runnable = profiles.filter((profile) => profile.commandName === 'Project');
  if (runnable.length === 0) return null;

  return runnable.find((profile) => profile.name === projectName) ?? runnable[0] ?? null;
}

/**
 * Traduce un perfil a variables de entorno.
 *
 * `applicationUrl` se traduce a `ASPNETCORE_URLS`, que es lo que hace `dotnet run`. Si el perfil
 * ya declara `ASPNETCORE_URLS` explícitamente, manda la declaración: es más específica.
 */
export function environmentFromProfile(profile: LaunchProfile): Record<string, string> {
  const env = { ...profile.environmentVariables };

  if (profile.applicationUrl !== null && env['ASPNETCORE_URLS'] === undefined) {
    env['ASPNETCORE_URLS'] = profile.applicationUrl;
  }

  return env;
}

/**
 * Lee el perfil de arranque de un proyecto y devuelve el entorno que hay que inyectarle.
 *
 * Nunca lanza: un `launchSettings.json` ausente o roto no puede impedir depurar. Cuando hay algo
 * que contar —JSON inválido, ningún perfil aplicable— se devuelve en `warning` para que la
 * sesión de depuración lo escriba en su salida en vez de tragárselo.
 */
export async function readLaunchEnvironment(
  projectDirectory: string,
  projectName: string,
): Promise<LaunchEnvironment> {
  const path = join(projectDirectory, 'Properties', 'launchSettings.json');

  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    // Lo normal en una biblioteca de clases o en una consola sin perfiles: no hay nada que aplicar.
    return EMPTY;
  }

  let profiles: LaunchProfile[];
  try {
    profiles = parseLaunchSettings(source);
  } catch (error) {
    return {
      ...EMPTY,
      warning:
        `no se ha podido leer ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Se depura sin aplicar ningún perfil.',
    };
  }

  const profile = selectProfile(profiles, projectName);
  if (!profile) {
    return {
      ...EMPTY,
      warning:
        profiles.length > 0
          ? `${path} no declara ningún perfil con "commandName": "Project". Se depura sin perfil.`
          : null,
    };
  }

  return { env: environmentFromProfile(profile), profile: profile.name, warning: null };
}
