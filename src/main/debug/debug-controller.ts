/**
 * Controlador de depuración: adquiere NetCoreDbg, resuelve qué ensamblado lanzar y traduce el
 * Debug Adapter Protocol a un modelo que el renderer pueda pintar.
 *
 * El ensamblado objetivo se deduce del `.csproj` (TargetFramework + AssemblyName), no de una
 * convención de rutas: un proyecto con `AssemblyName` distinto del nombre del archivo es
 * perfectamente legal y adivinarlo daría un "no existe el archivo" incomprensible.
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import type {
  DebugScope,
  DebugStackFrame,
  DebugState,
  DebugVariable,
} from '../../shared/contracts.js';
import { readLaunchEnvironment } from '../services/launch-settings.js';
import { readProject, readInheritedProperties } from '../services/solution-service.js';
import { acquireDebugger, DebugSession, type DebuggerBinary } from './netcoredbg.js';

export interface DebugTarget {
  /** Ruta del ensamblado `.dll` a depurar. */
  program: string;
  /** Directorio de trabajo del proceso depurado. */
  cwd: string;
  projectName: string;
  /**
   * Entorno del perfil de `launchSettings.json`. Sin esto, una aplicación ASP.NET lanzada desde
   * `bin/Debug` arranca en Production: puerto 5000, sin static web assets y avisando de que no
   * encuentra `wwwroot`.
   */
  env: Record<string, string>;
  /** Perfil aplicado, para poder decirlo en la salida de depuración. */
  launchProfile: string | null;
  /** Aviso del lector de perfiles, si lo hubo. */
  launchWarning: string | null;
}

/**
 * Localiza el ensamblado compilado de un proyecto.
 *
 * @throws si el proyecto no se ha compilado todavía, con el comando exacto que hay que ejecutar.
 */
export async function resolveDebugTarget(projectPath: string, workspaceRoot: string): Promise<DebugTarget> {
  const inherited = await readInheritedProperties(dirname(projectPath), workspaceRoot);
  const project = await readProject(projectPath, null, inherited);

  const assemblyName = basename(projectPath, extname(projectPath));
  const frameworks = project.targetFrameworks.length > 0 ? project.targetFrameworks : ['net9.0'];
  const outputRoot = join(project.directory, 'bin', 'Debug');

  const attempted: string[] = [];

  // El perfil se lee del proyecto, no del directorio de salida: `Properties/launchSettings.json`
  // no se copia a `bin/`, y es justo lo que el depurador necesita para no arrancar en Production.
  const launch = await readLaunchEnvironment(project.directory, project.name);
  const describe = (program: string): DebugTarget => ({
    program,
    cwd: dirname(program),
    projectName: project.name,
    env: launch.env,
    launchProfile: launch.profile,
    launchWarning: launch.warning,
  });

  for (const framework of frameworks) {
    const candidate = join(outputRoot, framework, `${assemblyName}.dll`);
    attempted.push(candidate);
    if (existsSync(candidate)) return describe(candidate);
  }

  // El TargetFramework puede haber cambiado sin recompilar: se mira qué hay realmente en bin/Debug.
  if (existsSync(outputRoot)) {
    for (const entry of await readdir(outputRoot)) {
      const candidate = join(outputRoot, entry, `${assemblyName}.dll`);
      if (existsSync(candidate)) return describe(candidate);
    }
  }

  throw new Error(
    `no se encuentra el ensamblado de "${project.name}". Compila primero (Ctrl/Cmd+Shift+B).\n` +
      `Rutas probadas:\n  ${attempted.join('\n  ')}`,
  );
}

interface DapStoppedEvent {
  reason?: string;
  threadId?: number;
  description?: string;
}

export class DebugController extends EventEmitter {
  private readonly session = new DebugSession();
  private binary: DebuggerBinary | null = null;
  private state: DebugState = {
    status: 'idle',
    message: null,
    progress: null,
    threadId: null,
    version: null,
  };

  constructor() {
    super();

    this.session.on('dap-event', ({ event, body }: { event: string; body: unknown }) => {
      switch (event) {
        case 'stopped': {
          const stopped = (body ?? {}) as DapStoppedEvent;
          this.setState({
            status: 'paused',
            threadId: stopped.threadId ?? null,
            message: stopped.description ?? stopped.reason ?? 'detenido',
          });
          this.emit('stopped', { reason: stopped.reason ?? 'pause', threadId: stopped.threadId ?? null });
          break;
        }
        case 'continued':
          this.setState({ status: 'running', message: null });
          break;
        case 'output': {
          const output = (body ?? {}) as { category?: string; output?: string };
          if (output.output) {
            this.emit('output', { category: output.category ?? 'stdout', text: output.output });
          }
          break;
        }
        case 'exited':
        case 'terminated':
          this.setState({ status: 'idle', threadId: null, message: null });
          break;
      }
    });

    this.session.on('terminated', () => {
      this.setState({ status: 'idle', threadId: null, message: null });
    });

    this.session.on('log', (text: string) => this.emit('output', { category: 'stderr', text }));
  }

  getState(): DebugState {
    return this.state;
  }

  private setState(patch: Partial<DebugState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** Arranca una sesión: adquiere el depurador si hace falta, lanza y aplica los breakpoints. */
  async start(
    target: DebugTarget,
    breakpoints: Array<{ file: string; lines: number[] }>,
    toolchainDir: string,
    stopAtEntry: boolean,
  ): Promise<DebugState> {
    await this.stop();

    try {
      if (!this.binary) {
        this.setState({ status: 'acquiring', message: 'preparando NetCoreDbg', progress: 0 });
        this.binary = await acquireDebugger(toolchainDir, (detail, ratio) => {
          this.setState({ status: 'acquiring', message: detail, progress: ratio });
        });
      }

      this.setState({
        status: 'starting',
        message: `lanzando ${target.projectName}`,
        version: this.binary.version,
        progress: null,
      });

      if (target.launchWarning) {
        this.emit('output', { category: 'stderr', text: `${target.launchWarning}\n` });
      }
      if (target.launchProfile) {
        const variables = Object.keys(target.env).sort().join(', ');
        this.emit('output', {
          category: 'console',
          text: `Perfil de arranque "${target.launchProfile}": ${variables || 'sin variables'}\n`,
        });
      }

      await this.session.start(this.binary, {
        program: target.program,
        cwd: target.cwd,
        env: target.env,
        stopAtEntry,
      });

      // Los breakpoints se envían antes de configurationDone: es lo que exige DAP para que el
      // programa no arranque sin ellos.
      for (const entry of breakpoints) {
        if (entry.lines.length > 0) {
          await this.session.setBreakpoints(entry.file, entry.lines);
        }
      }

      await this.session.configurationDone();

      this.setState({ status: 'running', message: null });
    } catch (error) {
      this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        progress: null,
      });
    }

    return this.state;
  }

  async stop(): Promise<void> {
    await this.session.stop();
    this.setState({ status: 'idle', message: null, threadId: null, progress: null });
  }

  async setBreakpoints(file: string, lines: number[]): Promise<void> {
    if (!this.session.running) return;
    await this.session.setBreakpoints(file, lines);
  }

  async control(action: 'continue' | 'stepOver' | 'stepIn' | 'stepOut' | 'pause'): Promise<void> {
    const threadId = this.state.threadId;
    if (!this.session.running || threadId === null) return;

    switch (action) {
      case 'continue':
        this.setState({ status: 'running' });
        await this.session.continue(threadId);
        break;
      case 'stepOver':
        await this.session.next(threadId);
        break;
      case 'stepIn':
        await this.session.stepIn(threadId);
        break;
      case 'stepOut':
        await this.session.stepOut(threadId);
        break;
      case 'pause':
        await this.session.pause(threadId);
        break;
    }
  }

  async stackTrace(): Promise<DebugStackFrame[]> {
    const threadId = this.state.threadId;
    if (!this.session.running || threadId === null) return [];

    const body = (await this.session.stackTrace(threadId)) as {
      stackFrames?: Array<{
        id: number;
        name: string;
        line: number;
        column: number;
        source?: { path?: string };
      }>;
    };

    return (body?.stackFrames ?? []).map((frame) => ({
      id: frame.id,
      name: frame.name,
      file: frame.source?.path ?? null,
      line: frame.line,
      column: frame.column,
    }));
  }

  async scopes(frameId: number): Promise<DebugScope[]> {
    if (!this.session.running) return [];

    const body = (await this.session.scopes(frameId)) as {
      scopes?: Array<{ name: string; variablesReference: number; expensive?: boolean }>;
    };

    return (body?.scopes ?? []).map((scope) => ({
      name: scope.name,
      variablesReference: scope.variablesReference,
      expensive: scope.expensive === true,
    }));
  }

  async variables(variablesReference: number): Promise<DebugVariable[]> {
    if (!this.session.running) return [];

    const body = (await this.session.variables(variablesReference)) as {
      variables?: Array<{ name: string; value: string; type?: string; variablesReference: number }>;
    };

    return (body?.variables ?? []).map((variable) => ({
      name: variable.name,
      value: variable.value,
      type: variable.type ?? null,
      variablesReference: variable.variablesReference,
    }));
  }

  async evaluate(expression: string, frameId: number | undefined): Promise<string> {
    if (!this.session.running) return '';

    const body = (await this.session.evaluate(expression, frameId)) as { result?: string };
    return body?.result ?? '';
  }
}

export const debugController = new DebugController();
