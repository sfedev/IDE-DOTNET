/**
 * Pruebas de `scripts/devlog.mjs`, la utilidad que mantiene la bitácora.
 *
 * De dónde salen: el campo "Estado global" del encabezado del devlog llevaba vacío desde algún
 * punto entre la v1.0.0 y la v2.5.0, y nadie sabía por qué. La causa era el propio script:
 * `devlog.mjs status`, **sin argumentos**, llamaba a `setStatus('')` y escribía la línea en blanco.
 * Los comandos `done`, `wip` y `todo` se protegían de la lista vacía; éste no. Un comando de
 * mantenimiento que borra el documento que mantiene, en silencio y con el nombre menos sospechoso
 * de todos, merece una prueba.
 *
 * Se ejercita el script **como proceso**, contra una copia en un directorio temporal
 * (`DEVLOG_FILE`): probar la utilidad contra el devlog de verdad sería escribir en la bitácora del
 * proyecto en cada ejecución de la suite.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'devlog.mjs');

const DOCUMENTO = [
  '# PROJECT_DEVLOG.md — Prueba',
  '',
  '- **Proyecto:** Prueba',
  '- **Estado global:** 🟢 v9.9.9 — todo en orden',
  '',
  '## Roadmap por fases',
  '',
  '### Fase 0 — Primera',
  '- [x] F0.1 hecho',
  '- [ ] F0.2 pendiente',
  '',
  '### Fase 1 — Segunda',
  '- [x] F1.1 hecho',
  '- [~] F1.2 en curso',
  '',
].join('\n');

let workspace;
let devlog;

/** Lanza el script contra la copia temporal. Nunca rechaza: un fallo es un código de salida. */
function ejecutar(...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd: root, env: { ...process.env, DEVLOG_FILE: devlog } },
      (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? (error.code ?? 1) : 0 }),
    );
  });
}

const leer = () => readFile(devlog, 'utf8');

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dfdevlog-'));
  devlog = join(workspace, 'PROJECT_DEVLOG.md');
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(devlog, DOCUMENTO, 'utf8');
});

describe('estado global', () => {
  /**
   * La prueba que existe por el fallo. Antes, esto dejaba la línea en blanco y el encabezado del
   * devlog anunciando un estado que no ponía nada.
   */
  it('sin argumentos lee, no borra', async () => {
    const { stdout, code } = await ejecutar('status');

    assert.equal(code, 0);
    assert.match(stdout, /v9\.9\.9/, 'tiene que decir lo que hay');
    assert.match(await leer(), /- \*\*Estado global:\*\* 🟢 v9\.9\.9 — todo en orden/, 'y no tocarlo');
  });

  it('con texto lo actualiza', async () => {
    await ejecutar('status', 'v1.2.3 — probando');
    assert.match(await leer(), /- \*\*Estado global:\*\* v1\.2\.3 — probando/);
  });

  it('varios argumentos se juntan en una línea', async () => {
    // Es lo que pasa cuando alguien escribe el texto sin comillas.
    await ejecutar('status', 'v1.2.3', '—', 'sin', 'comillas');
    assert.match(await leer(), /- \*\*Estado global:\*\* v1\.2\.3 — sin comillas/);
  });

  it('una cadena de espacios tampoco borra: es lo mismo que no decir nada', async () => {
    const { stdout } = await ejecutar('status', '   ');
    assert.match(stdout, /v9\.9\.9/);
    assert.match(await leer(), /🟢 v9\.9\.9/);
  });

  it('el estado se escribe en una sola línea', async () => {
    // El script reemplaza **la línea**: un texto de dos líneas dejaría la segunda huérfana debajo,
    // fuera del campo y sin que nada la lea.
    await ejecutar('status', 'primera línea');
    const lineas = (await leer()).split('\n');
    const indice = lineas.findIndex((linea) => linea.startsWith('- **Estado global:**'));

    assert.ok(indice >= 0);
    assert.equal(lineas[indice + 1], '', 'debajo del estado no puede quedar texto suelto');
  });

  it('un documento sin línea de estado lo dice en vez de fingir que la ha escrito', async () => {
    await writeFile(devlog, '# Sin encabezado\n\n### Fase 0 — Única\n- [x] F0.1 hecho\n', 'utf8');
    const { code, stderr } = await ejecutar('status', 'algo');

    assert.equal(code, 1);
    assert.match(stderr, /estado global/);
  });
});

describe('marcado de hitos', () => {
  it('marca por identificador exacto', async () => {
    await ejecutar('done', 'F0.2');
    assert.match(await leer(), /- \[x\] F0\.2 pendiente/);
  });

  it('avisa de un identificador que no existe, y sale en rojo', async () => {
    const { code, stderr } = await ejecutar('done', 'F9.9');

    assert.equal(code, 1);
    assert.match(stderr, /F9\.9/);
  });

  it('sin identificadores no toca nada', async () => {
    const antes = await leer();
    const { code } = await ejecutar('done');

    assert.equal(code, 1);
    assert.equal(await leer(), antes);
  });
});

describe('informe de progreso', () => {
  it('cuenta por fase y en total', async () => {
    const { stdout, code } = await ejecutar('report');

    assert.equal(code, 0);
    assert.match(stdout, /1\/2\s+Fase 0/);
    assert.match(stdout, /1\/2\s+Fase 1/);
    assert.match(stdout, /TOTAL: 2\/4/);
  });

  it('un devlog en CRLF cuenta igual que uno en LF', async () => {
    // Ya pasó: un editor de Windows dejó el archivo en CRLF y el informe salía a cero sin decir
    // por qué.
    await writeFile(devlog, DOCUMENTO.split('\n').join('\r\n'), 'utf8');
    const { stdout } = await ejecutar('report');

    assert.match(stdout, /TOTAL: 2\/4/);
  });

  it('un comando desconocido explica el uso y sale en rojo', async () => {
    const { code, stderr } = await ejecutar('inventado');

    assert.equal(code, 1);
    assert.match(stderr, /uso: devlog\.mjs/);
  });
});
