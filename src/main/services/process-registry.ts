/**
 * Registro central de procesos hijo.
 *
 * Regla del producto: al cerrar DotForge no puede quedar ni un `dotnet` huérfano ocupando un
 * puerto o bloqueando archivos. Todo proceso lanzado por el IDE se registra aquí y se mata
 * en el apagado.
 */
import type { ChildProcess } from 'node:child_process';

export interface TrackedProcess {
  id: string;
  label: string;
  child: ChildProcess;
  startedAt: number;
}

const processes = new Map<string, TrackedProcess>();

export function track(id: string, label: string, child: ChildProcess): TrackedProcess {
  const tracked: TrackedProcess = { id, label, child, startedAt: Date.now() };
  processes.set(id, tracked);
  child.once('close', () => processes.delete(id));
  return tracked;
}

export function get(id: string): TrackedProcess | undefined {
  return processes.get(id);
}

export function list(): TrackedProcess[] {
  return [...processes.values()];
}

/**
 * Termina un proceso. En Windows no hay señales reales, así que se usa `taskkill /T` para
 * llevarse también el árbol de hijos: `dotnet run` lanza el ejecutable de la app como nieto y
 * matar sólo al padre dejaría el servidor web escuchando.
 */
export function kill(id: string): boolean {
  const tracked = processes.get(id);
  if (!tracked) return false;

  const { child } = tracked;
  if (child.exitCode !== null || child.signalCode !== null) {
    processes.delete(id);
    return true;
  }

  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      // Import diferido: sólo hace falta en Windows y sólo al matar.
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGTERM');
    // Red de seguridad: si en 3 s sigue vivo, se fuerza.
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  }

  processes.delete(id);
  return true;
}

export function killAll(): void {
  for (const id of [...processes.keys()]) {
    kill(id);
  }
}
