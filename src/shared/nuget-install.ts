/**
 * Instalar un paquete NuGet en varios proyectos a la vez.
 *
 * Añadir Serilog a una solución Clean Architecture no es "una instalación": son tres o cuatro, una
 * por proyecto, y hacerlas de una en una desde el desplegable es el tipo de tarea que se hace mal
 * porque es aburrida —se olvida un proyecto y el fallo aparece dos días después, al compilar en
 * otra máquina—.
 *
 * Tres decisiones, y las tres tienen motivo:
 *
 *  - **En serie, no en paralelo.** `dotnet add package` restaura, y varias restauraciones
 *    simultáneas se pelean por la caché de NuGet y por el mismo `Directory.Packages.props`. Además,
 *    en serie el panel inferior se lee: una salida por proyecto, en orden.
 *  - **Un fallo no cancela el resto.** Que un proyecto no admita el paquete (marco de destino
 *    incompatible, por ejemplo) no dice nada de los demás. Se sigue, y al final se dice qué entró y
 *    qué no.
 *  - **El modelo es puro y vive aquí.** El progreso de una operación larga con varios pasos es
 *    justo el sitio donde se cuelan los errores de estado —un paso que se queda en "ejecutando"
 *    para siempre, un contador que no cuadra—, así que se prueba sin interfaz.
 */

export type PackageInstallState = 'pending' | 'running' | 'installed' | 'failed';

export interface PackageInstallTarget {
  /** Ruta del `.csproj`. Es la identidad del paso. */
  path: string;
  name: string;
}

export interface PackageInstallStep {
  project: PackageInstallTarget;
  state: PackageInstallState;
  /** Tarea de `dotnet` que lo está ejecutando. Null mientras no ha empezado. */
  taskId: string | null;
  /** Código de salida de `dotnet add package`. Null mientras no ha terminado. */
  exitCode: number | null;
}

export interface PackageInstallPlan {
  packageId: string;
  version: string;
  steps: PackageInstallStep[];
}

export class PackageInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageInstallError';
  }
}

/**
 * Prepara la instalación.
 *
 * Los proyectos repetidos se colapsan —la misma ruta dos veces sería lanzar `dotnet add package`
 * dos veces sobre el mismo `.csproj`— conservando el orden en el que llegaron, que es el de la
 * solución y por tanto el que el usuario está viendo.
 */
export function createPlan(packageId: string, version: string, projects: readonly PackageInstallTarget[]): PackageInstallPlan {
  if (packageId.trim() === '') throw new PackageInstallError('no se ha indicado ningún paquete');
  if (projects.length === 0) throw new PackageInstallError('no se ha seleccionado ningún proyecto');

  const seen = new Set<string>();
  const steps: PackageInstallStep[] = [];

  for (const project of projects) {
    if (seen.has(project.path)) continue;
    seen.add(project.path);
    steps.push({ project, state: 'pending', taskId: null, exitCode: null });
  }

  return { packageId, version, steps };
}

/** Siguiente proyecto por instalar, o `null` si no queda ninguno. */
export function nextPending(plan: PackageInstallPlan): PackageInstallStep | null {
  return plan.steps.find((step) => step.state === 'pending') ?? null;
}

/** Paso en ejecución, si lo hay. Nunca hay más de uno: la instalación es en serie. */
export function runningStep(plan: PackageInstallPlan): PackageInstallStep | null {
  return plan.steps.find((step) => step.state === 'running') ?? null;
}

/** Anota que un proyecto ya tiene su tarea de `dotnet` en marcha. */
export function markRunning(plan: PackageInstallPlan, projectPath: string, taskId: string): PackageInstallPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.project.path === projectPath && step.state === 'pending'
        ? { ...step, state: 'running', taskId }
        : step,
    ),
  };
}

/**
 * Cierra el paso que corresponde a una tarea terminada.
 *
 * Se busca **por `taskId`**, no por el paso que esté en ejecución: al panel inferior le llegan las
 * salidas de todas las tareas del IDE —una compilación, un `dotnet watch`, una prueba— y confundir
 * la que termina cerraría un paso que sigue vivo. Una tarea que no es de este plan se ignora.
 */
export function noteExit(plan: PackageInstallPlan, taskId: string, exitCode: number | null): PackageInstallPlan {
  if (!plan.steps.some((step) => step.taskId === taskId && step.state === 'running')) return plan;

  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.taskId === taskId && step.state === 'running'
        ? { ...step, state: exitCode === 0 ? 'installed' : 'failed', exitCode }
        : step,
    ),
  };
}

/** Marca como fallido el paso en ejecución cuando la tarea ni siquiera ha podido lanzarse. */
export function markFailed(plan: PackageInstallPlan, projectPath: string): PackageInstallPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.project.path === projectPath && step.state !== 'installed'
        ? { ...step, state: 'failed', exitCode: step.exitCode }
        : step,
    ),
  };
}

export function isComplete(plan: PackageInstallPlan): boolean {
  return plan.steps.every((step) => step.state === 'installed' || step.state === 'failed');
}

export interface PackageInstallProgress {
  /** Pasos terminados, con o sin éxito. */
  done: number;
  total: number;
  /** Nombre del proyecto en curso, o `null` si no hay ninguno en marcha. */
  current: string | null;
  text: string;
}

/** Progreso global, tal y como se enseña sobre la lista de resultados. */
export function describeProgress(plan: PackageInstallPlan): PackageInstallProgress {
  const done = plan.steps.filter((step) => step.state === 'installed' || step.state === 'failed').length;
  const running = runningStep(plan);
  const total = plan.steps.length;
  const what = `${plan.packageId} ${plan.version}`.trim();

  if (isComplete(plan)) {
    return { done, total, current: null, text: `${what}: ${done} de ${total} proyectos procesados` };
  }

  return {
    done,
    total,
    current: running?.project.name ?? null,
    text:
      running === null
        ? `${what}: preparando ${total} proyecto${total === 1 ? '' : 's'}…`
        : `${what}: ${done + 1} de ${total} — ${running.project.name}`,
  };
}

export interface PackageInstallSummary {
  installed: string[];
  failed: string[];
  message: string;
  level: 'ok' | 'warn' | 'error';
}

/**
 * Resumen final.
 *
 * Nombra los proyectos que han fallado en vez de dar sólo un número: "1 de 4 ha fallado" obliga a
 * ir a buscar cuál al panel inferior, y el panel a esas alturas tiene la salida de los cuatro.
 */
export function summarizeInstall(plan: PackageInstallPlan): PackageInstallSummary {
  const installed = plan.steps.filter((step) => step.state === 'installed').map((step) => step.project.name);
  const failed = plan.steps.filter((step) => step.state === 'failed').map((step) => step.project.name);
  const what = `${plan.packageId} ${plan.version}`.trim();

  if (failed.length === 0) {
    return {
      installed,
      failed,
      message:
        installed.length === 1
          ? `${what} instalado en ${installed[0]}.`
          : `${what} instalado en ${installed.length} proyectos.`,
      level: 'ok',
    };
  }

  if (installed.length === 0) {
    return {
      installed,
      failed,
      message: `No se ha podido instalar ${what} en ${failed.join(', ')}. La salida está en el panel inferior.`,
      level: 'error',
    };
  }

  return {
    installed,
    failed,
    message: `${what}: instalado en ${installed.length} proyecto${installed.length === 1 ? '' : 's'}; ha fallado en ${failed.join(', ')}.`,
    level: 'warn',
  };
}
