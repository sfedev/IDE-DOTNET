/**
 * Sonda de una sesión de pseudoterminal real.
 *
 * Se ejecuta **como proceso aparte** y no dentro de `node --test`, y no es una comodidad: al matar
 * una sesión de ConPTY, node-pty lanza un ayudante (`conpty_console_list_agent`) para enumerar los
 * procesos de la consola, y ese ayudante deja el bucle de eventos del padre vivo. El síntoma es el
 * de siempre en esta suite: todas las pruebas en verde y el proceso sin terminar, con `node --test`
 * esperando indefinidamente. Aquí se sale con `process.exit`, que es lo que un proceso de un solo
 * uso puede permitirse y un corredor de pruebas no.
 *
 * Imprime una línea `PTY_OK <json>` o `PTY_FAIL <motivo>` y sale con 0 o 1.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findProfile, ptyService } from '../../build/main-lib.mjs';

const MARCA = 'dotforge-pty-ok';
const TIMEOUT_MS = 20_000;

function fallar(motivo) {
  console.log(`PTY_FAIL ${motivo}`);
  process.exit(1);
}

async function esperar(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

const shellId = process.platform === 'win32' ? 'cmd' : 'bash';
const profile = findProfile(shellId);

const state = ptyService.availability();
if (!state.available) fallar(`node-pty no disponible: ${state.reason}`);
if (!profile || !(await ptyService.programExists(profile.file))) fallar(`${shellId} no está instalado`);

const workspace = await mkdtemp(join(tmpdir(), 'dfpty-'));
const resultado = { pid: 0, cwd: '', eco: false, salida: null, sesionesTrasCerrar: -1 };

try {
  let leido = '';
  let salida = null;

  const session = ptyService.create(
    { profileId: shellId, cwd: workspace, columns: 100, rows: 30 },
    {
      onData: ({ data }) => {
        leido += data;
      },
      onExit: (payload) => {
        salida = payload;
      },
    },
  );

  resultado.pid = session.pid;
  resultado.cwd = session.cwd;

  if (session.profileId !== shellId) fallar(`el perfil devuelto no es el pedido: ${session.profileId}`);
  if (!ptyService.list().some((entry) => entry.terminalId === session.terminalId)) {
    fallar('la sesión no aparece en la lista');
  }

  // Tamaños imposibles: llegan de verdad cuando el panel está plegado y su hueco mide 0 px.
  ptyService.resize(session.terminalId, 0, 0);
  ptyService.resize(session.terminalId, 120, 40);

  ptyService.write(session.terminalId, `echo ${MARCA}\r`);
  resultado.eco = await esperar(() => leido.includes(MARCA), TIMEOUT_MS);
  if (!resultado.eco) fallar(`el intérprete no devolvió la marca. Leído: ${JSON.stringify(leido.slice(0, 300))}`);

  // Un `exit` del usuario tiene que avisar, no dejar la pestaña muda.
  ptyService.write(session.terminalId, 'exit\r');
  if (!(await esperar(() => salida !== null, TIMEOUT_MS))) fallar('no llegó el evento de salida del intérprete');

  resultado.salida = salida.exitCode;
  if (salida.terminalId !== session.terminalId) fallar('el evento de salida trae otro identificador');

  resultado.sesionesTrasCerrar = ptyService.list().length;
  if (resultado.sesionesTrasCerrar !== 0) fallar('la sesión no se descontó al terminar el intérprete');

  ptyService.disposeAll();
  await rm(workspace, { recursive: true, force: true });

  console.log(`PTY_OK ${JSON.stringify(resultado)}`);
  process.exit(0);
} catch (error) {
  ptyService.disposeAll();
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  fallar(error instanceof Error ? error.message : String(error));
}
