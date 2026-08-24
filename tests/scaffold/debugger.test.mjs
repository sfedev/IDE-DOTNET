/**
 * Prueba de integración del depurador.
 *
 * Descarga NetCoreDbg (si no está cacheado), compila un programa de consola real, lanza una
 * sesión, para en un breakpoint y lee la pila y las variables locales.
 *
 * Es el criterio de aceptación que AGENTS.md exige al agente de depuración: "lanzar un
 * hola-mundo y parar en un breakpoint". Sin esto, el bridge DAP sería código no ejecutado.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { assetNameForPlatform, DebugController, resolveDebugTarget } from '../../build/toolchain.mjs';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKIP =
  process.env.DOTFORGE_SKIP_DOTNET === '1'
    ? 'DOTFORGE_SKIP_DOTNET=1'
    : assetNameForPlatform() === null
      ? `NetCoreDbg no publica binario ZIP para ${process.platform}/${process.arch}`
      : false;

/** El framework debe tener runtime instalado: depurar EJECUTA el programa, no sólo lo compila. */
const FRAMEWORK = 'net10.0';

const PROGRAM = `var contador = 0;

for (var i = 1; i <= 3; i++)
{
    contador += i;          // línea 5
    Console.WriteLine(contador);
}

Console.WriteLine($"total={contador}");
`;

const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${FRAMEWORK}</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <DebugType>portable</DebugType>
  </PropertyGroup>
</Project>
`;

/**
 * Márgenes de espera, más anchos en integración continua.
 *
 * Un runner virtual de Windows arranca el proceso en frío, jitea, carga los PDB portables y resuelve
 * el bridge DAP con un disco compartido y sin caché de nada. Los 120 s que sobran en una máquina de
 * desarrollo se quedaron cortos en `windows-latest` con el tag v2.1.0: el fallo era un timeout, no
 * un breakpoint que no se alcanza. Fuera de CI se mantienen los valores originales, porque ahí un
 * timeout largo sólo consigue que un fallo real tarde más en verse.
 */
const IN_CI = process.env.CI === 'true' || process.env.CI === '1';

/** Captura del primer golpe del breakpoint: es la espera que se agotó en CI. */
const BREAKPOINT_TIMEOUT_MS = IN_CI ? 240_000 : 120_000;
/** Segundo golpe tras `continue`: el proceso ya está caliente, pero el runner sigue siendo lento. */
const RESUME_TIMEOUT_MS = IN_CI ? 120_000 : 60_000;
/** Confirmación del estado `paused` una vez recibido el evento. */
const STATUS_TIMEOUT_MS = IN_CI ? 60_000 : 30_000;

/**
 * Acumula la salida del proceso depurado.
 *
 * Cuando esto falla en una máquina que no es la tuya, la diferencia entre "se ha quedado colgado" y
 * "el programa reventó al arrancar" está justo aquí: en lo que escribieron el programa y el propio
 * NetCoreDbg antes de morir. Sin volcarlo, un timeout no dice absolutamente nada.
 */
function collectOutput(controller) {
  const chunks = [];
  const listener = (event) => chunks.push(`[${event.category}] ${event.text.replace(/\s+$/, '')}`);
  controller.on('output', listener);

  return {
    stop: () => controller.off('output', listener),
    /** Últimas líneas, para no volcar megas si el programa entró en un bucle escribiendo. */
    transcript: () => {
      if (chunks.length === 0) return '\n--- el proceso depurado no escribió nada ---';
      return `\n--- salida del proceso depurado (${chunks.length} eventos) ---\n${chunks.slice(-40).join('\n')}`;
    },
  };
}

/**
 * Espera al primer golpe del breakpoint.
 *
 * Vigila tres finales, no uno: que pare (bien), que la sesión termine sin haber parado (el programa
 * se ejecutó entero o murió), o que se agote el plazo. Distinguir el segundo del tercero importa:
 * un proceso que termina en dos segundos y un proceso que no responde en cuatro minutos son averías
 * distintas, y esperar el timeout completo para contar la primera es tirar cuatro minutos.
 *
 * Se crea **antes** de `controller.start()`: el breakpoint puede golpear entre que arranca y que
 * nos suscribiríamos, y ese evento no se repite.
 */
function waitForBreakpoint(controller, timeoutMs, transcript) {
  let settle;
  let running = false;

  const promise = new Promise((resolve, reject) => {
    settle = (error, value) => {
      controller.off('stopped', onStopped);
      controller.off('state', onState);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(
      () =>
        settle(
          new Error(
            `el programa no se detuvo en el breakpoint en ${timeoutMs} ms; estado: ` +
              `${JSON.stringify(controller.getState())}${transcript()}`,
          ),
        ),
      timeoutMs,
    );

    function onStopped(payload) {
      settle(null, payload);
    }

    function onState(state) {
      // Sólo cuenta como final prematuro si la sesión llegó a correr: los estados por los que pasa
      // el arranque (`acquiring`, `starting`) no son un final.
      if (state.status === 'running') {
        running = true;
        return;
      }
      if (!running) return;
      if (state.status === 'idle' || state.status === 'error') {
        settle(
          new Error(
            `la sesión terminó antes de llegar al breakpoint (estado "${state.status}"` +
              `${state.message ? `: ${state.message}` : ''})${transcript()}`,
          ),
        );
      }
    }

    controller.on('stopped', onStopped);
    controller.on('state', onState);
  });

  // Si el test falla antes de esperar a esta promesa, hay que poder soltar los oyentes y que nadie
  // se quede con un rechazo sin atender.
  promise.catch(() => undefined);

  return { promise, cancel: () => settle(null, null) };
}

/** Espera a que el controlador alcance un estado, o falla con el estado real. */
function waitForStatus(controller, statuses, timeoutMs) {
  return new Promise((resolve, reject) => {
    const wanted = new Set(statuses);

    const check = (state) => {
      if (wanted.has(state.status)) {
        controller.off('state', check);
        clearTimeout(timer);
        resolve(state);
      }
    };

    const timer = setTimeout(() => {
      controller.off('state', check);
      reject(
        new Error(
          `no se alcanzó ${[...wanted].join('/')} en ${timeoutMs} ms; estado actual: ` +
            JSON.stringify(controller.getState()),
        ),
      );
    }, timeoutMs);

    if (wanted.has(controller.getState().status)) {
      clearTimeout(timer);
      resolve(controller.getState());
      return;
    }

    controller.on('state', check);
  });
}

let workspace;
let projectPath;
let sourcePath;
let controller;

describe('depuración con NetCoreDbg', { skip: SKIP }, () => {
  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'dfdbg-'));
    const projectDir = join(workspace, 'DebugProbe');
    await mkdir(projectDir, { recursive: true });

    projectPath = join(projectDir, 'DebugProbe.csproj');
    sourcePath = join(projectDir, 'Program.cs');

    await writeFile(projectPath, PROJECT, 'utf8');
    await writeFile(sourcePath, PROGRAM, 'utf8');

    await execFileAsync('dotnet', ['build', '--nologo', '-v', 'quiet'], {
      cwd: projectDir,
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });

    controller = new DebugController();
  });

  after(async () => {
    if (controller) await controller.stop().catch(() => undefined);
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  it('resuelve el ensamblado compilado desde el .csproj', async () => {
    const target = await resolveDebugTarget(projectPath, workspace);

    assert.ok(target.program.endsWith('DebugProbe.dll'), target.program);
    assert.ok(target.program.includes(FRAMEWORK), target.program);
    assert.equal(target.projectName, 'DebugProbe');
  });

  it('explica qué hacer si el proyecto no está compilado', async () => {
    const otherDir = join(workspace, 'SinCompilar');
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, 'SinCompilar.csproj'), PROJECT, 'utf8');

    await assert.rejects(
      () => resolveDebugTarget(join(otherDir, 'SinCompilar.csproj'), workspace),
      /Compila primero/,
    );
  });

  it(
    'lanza el programa, para en el breakpoint y lee la pila y las variables',
    { timeout: 15 * 60 * 1000 },
    async () => {
      const target = await resolveDebugTarget(projectPath, workspace);
      const toolchainDir = join(root, '.toolchain-test');

      const output = collectOutput(controller);
      const breakpoint = waitForBreakpoint(controller, BREAKPOINT_TIMEOUT_MS, output.transcript);

      await controller.start(target, [{ file: sourcePath, lines: [5] }], toolchainDir, false);

      const state = controller.getState();
      if (state.status === 'error') {
        breakpoint.cancel();
        output.stop();
        assert.fail(`la sesión no arrancó: ${state.message}${output.transcript()}`);
      }

      await breakpoint.promise;

      const paused = await waitForStatus(controller, ['paused'], STATUS_TIMEOUT_MS);
      assert.equal(paused.status, 'paused');
      assert.notEqual(paused.threadId, null, 'no se ha recibido el hilo detenido');

      // --- Pila de llamadas ------------------------------------------------------------------
      const frames = await controller.stackTrace();
      assert.ok(frames.length > 0, 'la pila está vacía');

      const top = frames[0];
      assert.equal(top.line, 5, `se esperaba parar en la línea 5, no en la ${top.line}`);
      assert.ok(top.file?.endsWith('Program.cs'), `archivo inesperado: ${top.file}`);

      // --- Variables locales ------------------------------------------------------------------
      const scopes = await controller.scopes(top.id);
      assert.ok(scopes.length > 0, 'no hay ámbitos de variables');

      const locals = [];
      for (const scope of scopes) {
        locals.push(...(await controller.variables(scope.variablesReference)));
      }

      const names = locals.map((variable) => variable.name);
      assert.ok(names.includes('contador'), `no se ve "contador" entre ${names.join(', ')}`);
      assert.ok(names.includes('i'), `no se ve "i" entre ${names.join(', ')}`);

      // Primera pasada del bucle: i == 1 y contador todavía 0.
      const i = locals.find((variable) => variable.name === 'i');
      assert.equal(i.value, '1', `i vale ${i.value}`);

      // --- Evaluación de expresiones -----------------------------------------------------------
      const evaluated = await controller.evaluate('contador', top.id);
      assert.equal(evaluated, '0', `contador evaluado a "${evaluated}"`);

      // --- Continuar hasta el siguiente golpe del breakpoint -----------------------------------
      const stoppedAgain = new Promise((resolve) => controller.once('stopped', resolve));
      await controller.control('continue');
      await Promise.race([
        stoppedAgain,
        new Promise((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`no volvió a detenerse en la segunda iteración en ${RESUME_TIMEOUT_MS} ms${output.transcript()}`),
              ),
            RESUME_TIMEOUT_MS,
          ),
        ),
      ]);

      await waitForStatus(controller, ['paused'], STATUS_TIMEOUT_MS);
      const secondFrames = await controller.stackTrace();
      const secondScopes = await controller.scopes(secondFrames[0].id);

      const secondLocals = [];
      for (const scope of secondScopes) {
        secondLocals.push(...(await controller.variables(scope.variablesReference)));
      }

      const secondI = secondLocals.find((variable) => variable.name === 'i');
      assert.equal(secondI.value, '2', `en la segunda vuelta i debería valer 2, vale ${secondI.value}`);

      await controller.stop();
      assert.equal(controller.getState().status, 'idle');

      // El recolector deja de escuchar sólo al final: hasta aquí, cualquier fallo quiere el volcado.
      output.stop();
    },
  );
});
