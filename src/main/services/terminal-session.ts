/**
 * Directorio de trabajo de la terminal integrada.
 *
 * Antes no había ninguno: cada línea se lanzaba con el directorio de la solución como `cwd`, y `cd`
 * ni siquiera llegaba a intentarse —se buscaba un programa llamado `cd`, que no existe—. El
 * resultado era una terminal en la que no se podía navegar, y en un IDE de .NET eso duele en cuanto
 * hay que mirar otra solución, otra unidad o la carpeta de al lado.
 *
 * Este servicio lleva la cuenta de dónde está el usuario. El **parseo** de la línea y la
 * **presentación** de la ruta son puros y viven en `src/shared/terminal-cwd.ts`; aquí sólo se
 * resuelve contra el disco y se comprueba que el destino existe, que es lo único que necesita el
 * sistema de archivos.
 *
 * **Sobre el alcance**, que es la parte que hay que decidir a conciencia (ADR-055): el usuario puede
 * navegar a donde quiera, incluidas otras unidades. No se aplica `assertInsideWorkspace` al `cwd` de
 * la terminal. La frontera de seguridad de la terminal es **qué se puede ejecutar** —la lista blanca
 * de programas y `shell: false`, que no se tocan— y no **desde dónde**: encerrar el `cd` en el
 * workspace no impediría nada (`dotnet build ..\otra\App.sln` ya cruzaba esa línea) y sí impide el
 * caso legítimo para el que existe una terminal.
 *
 * No importa `electron`: el hogar y el workspace se inyectan, para poder probarlo en un directorio
 * temporal.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  classifyLine,
  resolveTarget,
  shortenPath,
  TerminalCwdError,
  type TerminalIntent,
} from '../../shared/terminal-cwd.js';

export interface TerminalCwd {
  /** Ruta absoluta y normalizada. */
  path: string;
  /** Cómo se enseña en el prompt. */
  display: string;
}

export interface SessionContext {
  /** Carpeta personal del usuario. */
  home: string;
  /** Raíz del workspace abierto, o null si no hay ninguno. */
  workspace: string | null;
  /** Nombre visible del workspace, para el prompt. */
  workspaceName: string | null;
}

let current: string | null = null;
let previous: string | null = null;
let context: SessionContext = { home: '', workspace: null, workspaceName: null };

/**
 * Fija el contexto de la sesión. Se llama al arrancar y cada vez que se abre un workspace.
 *
 * Abrir otra solución **lleva la terminal a la nueva**: seguir en la carpeta de la anterior sería
 * técnicamente defendible y prácticamente desconcertante. Si el usuario había navegado a otro sitio
 * dentro de la misma solución, se respeta.
 */
export function setContext(next: SessionContext): void {
  const changedWorkspace = next.workspace !== context.workspace;
  context = next;

  if (changedWorkspace || current === null) {
    previous = current;
    current = next.workspace ?? next.home;
  }
}

/** Directorio actual de la terminal, con su forma corta para el prompt. */
export function cwd(): TerminalCwd {
  const path = current ?? context.workspace ?? context.home;
  return {
    path,
    display: shortenPath(path, {
      home: context.home,
      workspace: context.workspace,
      workspaceName: context.workspaceName,
    }),
  };
}

/** Sólo para las pruebas: devuelve la sesión a su estado inicial. */
export function reset(): void {
  current = null;
  previous = null;
  context = { home: '', workspace: null, workspaceName: null };
}

/**
 * Cambia de directorio.
 *
 * Devuelve el nuevo `cwd`. Lanza `TerminalCwdError` si el destino no existe o no es un directorio,
 * con un mensaje que dice la ruta ya resuelta: "no existe `src`" no ayuda a nadie; "no existe
 * `C:\repos\Acme\src`" se puede comprobar de un vistazo.
 */
export async function changeDirectory(target: string | null): Promise<TerminalCwd> {
  const requested = resolveTarget(target, {
    current: cwd().path,
    home: context.home,
    previous,
    workspace: context.workspace,
  });

  const resolved = requested.absolute || isAbsolute(requested.path)
    ? resolve(requested.path)
    : resolve(cwd().path, requested.path);

  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new TerminalCwdError(`no existe la carpeta ${resolved}`);
  }

  if (!info.isDirectory()) throw new TerminalCwdError(`${resolved} no es una carpeta`);

  previous = cwd().path;
  current = resolved;
  return cwd();
}

export interface TerminalLineOutcome {
  intent: TerminalIntent['kind'];
  /** Directorio tras ejecutar la línea. */
  cwd: TerminalCwd;
  /** Líneas que la terminal imprime por su cuenta, sin lanzar ningún proceso. */
  output: string[];
}

/**
 * Atiende una línea que no lanza ningún programa (`cd`, `pwd`).
 *
 * Devuelve `null` si la línea sí es un comando, para que quien llama lo lance como siempre. Esa
 * forma —null en vez de un `kind: 'command'` que hay que volver a mirar— es lo que mantiene el
 * ejecutor con un solo camino.
 */
export async function handleBuiltin(argv: readonly string[]): Promise<TerminalLineOutcome | null> {
  const intent = classifyLine(argv);

  if (intent.kind === 'command') return null;

  if (intent.kind === 'print-directory') {
    const here = cwd();
    return { intent: intent.kind, cwd: here, output: [here.path] };
  }

  const next = await changeDirectory(intent.target);
  return { intent: intent.kind, cwd: next, output: [] };
}
