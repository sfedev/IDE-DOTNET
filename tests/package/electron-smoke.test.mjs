/**
 * Prueba de humo de la aplicación Electron.
 *
 * Lanza la app de verdad con `--smoke-test`, que monta la ventana sin mostrarla y ejecuta dentro
 * del renderer un conjunto de comprobaciones: shell pintado, aislamiento intacto, Monaco cargado,
 * temas definidos y tokenización real de Razor. Sale con 0 sólo si todo pasa.
 *
 * Es la única forma honesta de probar la gramática Monarch: fuera del navegador Monaco no se
 * puede instanciar, así que un "test unitario" del tokenizador estaría probando otra cosa.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const electronBinary = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
);

/** En CI sin display, Electron necesita un servidor X virtual; se puede saltar con este flag. */
const SKIP = process.env.DOTFORGE_SKIP_ELECTRON === '1';

function runElectron(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(electronBinary, ['.', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout tras ${timeoutMs} ms]` });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}

describe('arranque de la aplicación', { skip: SKIP ? 'DOTFORGE_SKIP_ELECTRON=1' : false }, () => {
  it('el binario de Electron está instalado', () => {
    assert.ok(existsSync(electronBinary), `falta ${electronBinary} — ejecuta \`npm install\``);
  });

  it('arranca, monta el renderer y pasa las comprobaciones internas', { timeout: 180_000 }, async () => {
    const { code, stdout, stderr } = await runElectron(['--smoke-test'], 150_000);

    assert.match(
      stdout,
      /SMOKE_OK/,
      `la prueba de humo no ha pasado.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr.slice(-4000)}`,
    );
    assert.equal(code, 0, `código de salida ${code}`);
  });

  it('no emite errores de acelerador ni de carga en el arranque', { timeout: 180_000 }, async () => {
    const { stderr } = await runElectron(['--smoke-test'], 150_000);

    // Un acelerador con caracteres no ASCII se acepta en la configuración pero Electron lo
    // rechaza en tiempo de ejecución: el atajo simplemente no funciona. Debe salir en rojo.
    assert.equal(
      /accelerator string can only contain ASCII/i.test(stderr),
      false,
      `hay un acelerador inválido en el menú:\n${stderr.slice(-2000)}`,
    );
  });
});

describe('tokenización de Razor en el editor real', { skip: SKIP ? 'DOTFORGE_SKIP_ELECTRON=1' : false }, () => {
  /** Ejecuta `--tokenize=<código>` y devuelve la lista de tipos de token de la primera línea. */
  async function tokenTypes(source) {
    const { stdout, stderr } = await runElectron([`--tokenize=${source}`], 120_000);
    const match = /^TOKENS (.+)$/m.exec(stdout);
    assert.ok(match, `no se ha obtenido la tokenización.\n${stdout}\n${stderr.slice(-2000)}`);

    const lines = JSON.parse(match[1]);
    return lines.flat().map((entry) => entry.slice(entry.indexOf(':') + 1));
  }

  it('distingue directiva, ruta y componente', { timeout: 180_000 }, async () => {
    const types = await tokenTypes('@page "/productos"');
    assert.ok(types.includes('keyword.directive.razor'), types.join(', '));
    assert.ok(types.includes('string.razor'), types.join(', '));
  });

  it('trata @@ como arroba literal, no como directiva', { timeout: 180_000 }, async () => {
    const types = await tokenTypes('correo@@ejemplo.com');
    assert.equal(types.includes('keyword.directive.razor'), false, types.join(', '));
    assert.equal(types.includes('delimiter.razor'), false, types.join(', '));
  });

  it('separa las etiquetas de componente de las etiquetas HTML', { timeout: 180_000 }, async () => {
    const componente = await tokenTypes('<MyComponent Value="1" />');
    const html = await tokenTypes('<div class="x">y</div>');

    assert.ok(componente.includes('tag.component.razor'), componente.join(', '));
    assert.ok(html.includes('tag.html'), html.join(', '));
    assert.equal(html.includes('tag.component.razor'), false, html.join(', '));
  });
});
