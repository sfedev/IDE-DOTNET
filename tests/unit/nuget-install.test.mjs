/**
 * Pruebas de la instalación de un paquete NuGet en varios proyectos.
 *
 * Añadir Serilog a una solución Clean Architecture son tres o cuatro instalaciones, no una, y
 * hacerlas de una en una desde un desplegable es el tipo de tarea que se hace mal: se olvida un
 * proyecto y el fallo aparece dos días después compilando en otra máquina.
 *
 * Lo que se prueba aquí es el estado, que es donde se cuela lo malo en una operación larga con
 * varios pasos: un paso que se queda en "ejecutando" para siempre porque llegó el final de otra
 * tarea, un contador que no cuadra, un fallo que cancela lo que no debía.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlan,
  describeProgress,
  isComplete,
  markFailed,
  markRunning,
  nextPending,
  noteExit,
  PackageInstallError,
  runningStep,
  summarizeInstall,
} from '../../build/ui-lib.mjs';

const DOMAIN = { path: 'C:/sln/Acme.Domain/Acme.Domain.csproj', name: 'Acme.Domain' };
const APP = { path: 'C:/sln/Acme.Application/Acme.Application.csproj', name: 'Acme.Application' };
const API = { path: 'C:/sln/Acme.Api/Acme.Api.csproj', name: 'Acme.Api' };

describe('preparar el plan', () => {
  it('un paso por proyecto, todos pendientes', () => {
    const plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP, API]);

    assert.equal(plan.steps.length, 3);
    assert.deepEqual(
      plan.steps.map((step) => step.state),
      ['pending', 'pending', 'pending'],
    );
    assert.equal(plan.packageId, 'Serilog');
    assert.equal(plan.version, '4.0.0');
  });

  it('colapsa los proyectos repetidos conservando el orden de la solución', () => {
    const plan = createPlan('Serilog', '4.0.0', [API, DOMAIN, API]);

    assert.deepEqual(
      plan.steps.map((step) => step.project.name),
      ['Acme.Api', 'Acme.Domain'],
    );
  });

  it('sin proyectos o sin paquete no hay plan', () => {
    assert.throws(() => createPlan('Serilog', '4.0.0', []), PackageInstallError);
    assert.throws(() => createPlan('   ', '4.0.0', [API]), PackageInstallError);
  });
});

describe('avanzar de proyecto en proyecto', () => {
  it('el siguiente pendiente es el primero en el orden de la solución', () => {
    const plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP]);
    assert.equal(nextPending(plan).project.name, 'Acme.Domain');
  });

  it('nunca hay dos pasos en marcha: la instalación es en serie', () => {
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP]);
    plan = markRunning(plan, DOMAIN.path, 'task-1');

    assert.equal(runningStep(plan).project.name, 'Acme.Domain');
    assert.equal(nextPending(plan).project.name, 'Acme.Application');
  });

  it('se cierra el paso de la tarea que ha terminado, no el que esté en marcha', () => {
    // Al panel inferior le llegan las salidas de todas las tareas del IDE: una compilación, un
    // `dotnet watch`, una prueba. Emparejar por "el que esté corriendo" cerraría un paso vivo.
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP]);
    plan = markRunning(plan, DOMAIN.path, 'task-1');

    const untouched = noteExit(plan, 'una-compilacion-cualquiera', 0);
    assert.equal(untouched, plan, 'una tarea ajena no debe tocar el plan');

    plan = noteExit(plan, 'task-1', 0);
    assert.equal(plan.steps[0].state, 'installed');
    assert.equal(plan.steps[0].exitCode, 0);
    assert.equal(runningStep(plan), null);
  });

  it('un código de salida distinto de cero marca el paso como fallido', () => {
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN]);
    plan = markRunning(plan, DOMAIN.path, 'task-1');
    plan = noteExit(plan, 'task-1', 1);

    assert.equal(plan.steps[0].state, 'failed');
    assert.equal(isComplete(plan), true);
  });

  it('una tarea matada (código null) también cierra el paso, como fallo', () => {
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN]);
    plan = markRunning(plan, DOMAIN.path, 'task-1');
    plan = noteExit(plan, 'task-1', null);

    assert.equal(plan.steps[0].state, 'failed');
  });

  /**
   * La regla de producto: un proyecto que no admite el paquete no dice nada de los demás. Se sigue
   * y al final se cuenta lo que ha pasado.
   */
  it('un fallo no cancela los proyectos que quedan', () => {
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP, API]);
    plan = markRunning(plan, DOMAIN.path, 'task-1');
    plan = noteExit(plan, 'task-1', 1);

    assert.equal(isComplete(plan), false);
    assert.equal(nextPending(plan).project.name, 'Acme.Application');
  });

  it('markFailed cierra un paso que ni siquiera ha podido lanzarse', () => {
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP]);
    plan = markFailed(plan, DOMAIN.path);

    assert.equal(plan.steps[0].state, 'failed');
    assert.equal(nextPending(plan).project.name, 'Acme.Application');
  });

  it('el plan está completo cuando no queda ningún paso abierto', () => {
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP]);
    assert.equal(isComplete(plan), false);

    plan = noteExit(markRunning(plan, DOMAIN.path, 't1'), 't1', 0);
    assert.equal(isComplete(plan), false);

    plan = noteExit(markRunning(plan, APP.path, 't2'), 't2', 0);
    assert.equal(isComplete(plan), true);
    assert.equal(nextPending(plan), null);
  });
});

describe('progreso', () => {
  it('dice en qué proyecto va y cuántos quedan', () => {
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP, API]);
    plan = markRunning(plan, DOMAIN.path, 't1');

    const progress = describeProgress(plan);
    assert.equal(progress.done, 0);
    assert.equal(progress.total, 3);
    assert.equal(progress.current, 'Acme.Domain');
    assert.match(progress.text, /Serilog 4\.0\.0: 1 de 3 — Acme\.Domain/);
  });

  it('cuenta los terminados, hayan ido bien o mal', () => {
    let plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP, API]);
    plan = noteExit(markRunning(plan, DOMAIN.path, 't1'), 't1', 1);
    plan = noteExit(markRunning(plan, APP.path, 't2'), 't2', 0);

    assert.equal(describeProgress(plan).done, 2);
  });

  it('antes de arrancar el primero ya dice cuántos proyectos van a tocarse', () => {
    const plan = createPlan('Serilog', '4.0.0', [DOMAIN, APP]);
    assert.match(describeProgress(plan).text, /preparando 2 proyectos/);
  });
});

describe('resumen final', () => {
  const complete = (results) => {
    let plan = createPlan('Serilog', '4.0.0', results.map(([project]) => project));
    results.forEach(([project, code], index) => {
      plan = noteExit(markRunning(plan, project.path, `t${index}`), `t${index}`, code);
    });
    return plan;
  };

  it('todo bien en un solo proyecto lo nombra', () => {
    const summary = summarizeInstall(complete([[DOMAIN, 0]]));
    assert.equal(summary.level, 'ok');
    assert.match(summary.message, /instalado en Acme\.Domain/);
  });

  it('todo bien en varios da el número', () => {
    const summary = summarizeInstall(complete([[DOMAIN, 0], [APP, 0], [API, 0]]));
    assert.equal(summary.level, 'ok');
    assert.deepEqual(summary.failed, []);
    assert.match(summary.message, /instalado en 3 proyectos/);
  });

  /**
   * Los que fallan se nombran. "1 de 4 ha fallado" obliga a ir a buscar cuál al panel inferior, y
   * el panel a esas alturas tiene la salida de los cuatro.
   */
  it('un fallo parcial nombra los proyectos que han fallado', () => {
    const summary = summarizeInstall(complete([[DOMAIN, 0], [APP, 1], [API, 0]]));

    assert.equal(summary.level, 'warn');
    assert.deepEqual(summary.installed, ['Acme.Domain', 'Acme.Api']);
    assert.deepEqual(summary.failed, ['Acme.Application']);
    assert.match(summary.message, /ha fallado en Acme\.Application/);
  });

  it('si no ha entrado en ninguno, es un error y dice dónde mirar', () => {
    const summary = summarizeInstall(complete([[DOMAIN, 1], [APP, 1]]));

    assert.equal(summary.level, 'error');
    assert.match(summary.message, /Acme\.Domain, Acme\.Application/);
    assert.match(summary.message, /panel inferior/);
  });
});
