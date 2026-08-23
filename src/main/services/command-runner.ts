/**
 * Ejecutor de comandos de la terminal integrada.
 *
 * No usa un pseudoterminal (PTY): `node-pty` es una dependencia nativa y el proyecto se ha
 * comprometido a no tener ninguna, para que el empaquetado sea reproducible y no haga falta
 * recompilar nada en la máquina del usuario.
 *
 * A cambio, la terminal ejecuta comandos concretos y muestra su salida: cubre el 95% de lo que
 * se hace en un flujo .NET (`dotnet`, `git`, `npm`) y no cubre programas interactivos que
 * necesiten un TTY (un REPL, un `vim`). La UI lo dice explícitamente.
 *
 * La línea se trocea aquí en argv y se lanza con `shell: false`: no hay interpretación de
 * metacaracteres, así que no hay inyección de comandos posible.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { DotnetTaskOutput, DotnetTaskStarted } from '../../shared/contracts.js';
import * as registry from './process-registry.js';

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * Trocea una línea de comandos en argv respetando comillas simples y dobles.
 *
 * Es deliberadamente simple: no expande variables, ni globs, ni sustituye comandos. Lo que se
 * escribe es lo que se ejecuta.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started || current !== '') {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
  }

  if (quote) throw new CommandError(`falta cerrar la comilla ${quote}`);
  if (started || current !== '') tokens.push(current);

  return tokens;
}

/**
 * Programas que la terminal puede lanzar.
 *
 * Es una lista blanca a propósito: el IDE es una herramienta de desarrollo .NET, no un intérprete
 * de propósito general, y una lista corta hace que la superficie sea auditable. Ampliarla es
 * añadir una entrada aquí.
 */
export const ALLOWED_COMMANDS = new Set([
  'dotnet',
  'git',
  'npm',
  'npx',
  'node',
  'nuget',
  'msbuild',
  'pwsh',
  'powershell',
  'python',
  'docker',
]);

export interface CommandCallbacks {
  onStarted(payload: DotnetTaskStarted): void;
  onOutput(payload: DotnetTaskOutput): void;
  onExit(payload: { taskId: string; code: number | null; durationMs: number }): void;
}

export function runCommand(line: string, cwd: string, callbacks: CommandCallbacks): DotnetTaskStarted {
  const argv = tokenize(line);
  if (argv.length === 0) throw new CommandError('comando vacío');

  const program = argv[0]!;
  if (!ALLOWED_COMMANDS.has(program.toLowerCase())) {
    throw new CommandError(
      `"${program}" no está en la lista de programas permitidos: ${[...ALLOWED_COMMANDS].sort().join(', ')}`,
    );
  }

  const taskId = randomUUID();
  const started: DotnetTaskStarted = {
    taskId,
    kind: 'run',
    command: line,
    target: cwd,
  };

  const child = spawn(program, argv.slice(1), {
    cwd,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Sin shell: los metacaracteres de la línea no se interpretan.
    shell: false,
    windowsHide: true,
  });

  registry.track(taskId, line, child);
  callbacks.onStarted(started);

  const startedAt = Date.now();

  child.stdout.on('data', (chunk: Buffer) =>
    callbacks.onOutput({ taskId, stream: 'stdout', chunk: chunk.toString('utf8') }),
  );
  child.stderr.on('data', (chunk: Buffer) =>
    callbacks.onOutput({ taskId, stream: 'stderr', chunk: chunk.toString('utf8') }),
  );

  child.on('error', (error) => {
    callbacks.onOutput({
      taskId,
      stream: 'stderr',
      chunk: `No se ha podido ejecutar "${program}": ${error.message}\n`,
    });
    callbacks.onExit({ taskId, code: -1, durationMs: Date.now() - startedAt });
  });

  child.on('close', (code) => {
    callbacks.onExit({ taskId, code, durationMs: Date.now() - startedAt });
  });

  return started;
}
