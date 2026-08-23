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

      const stopped = new Promise((resolve) => controller.once('stopped', resolve));

      await controller.start(target, [{ file: sourcePath, lines: [5] }], toolchainDir, false);

      const state = controller.getState();
      assert.notEqual(state.status, 'error', `la sesión no arrancó: ${state.message}`);

      await Promise.race([
        stopped,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('el programa no se detuvo en el breakpoint')), 120_000),
        ),
      ]);

      const paused = await waitForStatus(controller, ['paused'], 30_000);
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
          setTimeout(() => reject(new Error('no volvió a detenerse en la segunda iteración')), 60_000),
        ),
      ]);

      await waitForStatus(controller, ['paused'], 30_000);
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
    },
  );
});
