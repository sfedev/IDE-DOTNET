/**
 * Pruebas del servicio de git contra un repositorio de verdad.
 *
 * El parser tiene sus propias pruebas con salidas capturadas; esto es lo otro: comprobar que
 * preparar, quitar de preparados, confirmar y descartar **hacen lo que dicen** sobre un
 * repositorio real. Es barato —git tarda milisegundos— y cubre justo lo que una prueba con
 * dobles no cubriría: que los argumentos que se le pasan a git son los correctos.
 *
 * El servicio no importa `electron`, así que se puede ejercitar con Node pelado desde el bundle
 * `main-lib.mjs`. El repositorio vive en un directorio temporal corto, nunca dentro del repo.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitService } from '../../build/main-lib.mjs';

/** Normaliza los finales de línea: en Windows, `core.autocrlf` reescribe a CRLF al restaurar. */
const normalize = (text) => text.replace(new RegExp(String.raw`\r\n`, 'g'), '\n');

/** Sin git instalado no hay nada que probar aquí, pero tampoco hay nada roto. */
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('servicio de git sobre un repositorio real', { skip: gitAvailable ? false : 'git no está instalado' }, () => {
  let repo;

  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  const write = (name, content) => writeFile(join(repo, name), content, 'utf8');

  /**
   * Lee un archivo del repositorio normalizando los finales de línea.
   *
   * En Windows, `core.autocrlf` convierte a CRLF al restaurar desde el índice: el contenido es el
   * mismo, los bytes no. Comparar byte a byte aquí sería comprobar la configuración de git del
   * equipo, no el servicio.
   */
  const read = async (name) => normalize(await readFile(join(repo, name), 'utf8'));

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'dotforge-git-'));

    git('init', '--initial-branch=main');
    git('config', 'user.email', 'pruebas@dotforge.local');
    git('config', 'user.name', 'DotForge Tests');
    // Sin firma: en una máquina con `commit.gpgsign=true` global, todos los commits fallarían.
    git('config', 'commit.gpgsign', 'false');
  });

  after(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Cada aserción lee el estado recién escrito: la caché de 1,5 s mentiría entre pasos.
    gitService.invalidate();
  });

  it('reconoce la raíz del repositorio', async () => {
    const root = await gitService.repositoryRoot(repo);
    assert.ok(root !== null);
    // En macOS, /var es un enlace a /private/var: se compara por el último segmento.
    assert.equal(root.split(/[\\/]/).pop(), repo.split(/[\\/]/).pop());
  });

  it('una carpeta que no es repositorio devuelve null', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dotforge-nogit-'));
    try {
      gitService.invalidate();
      assert.equal(await gitService.repositoryRoot(outside), null);
      assert.equal(await gitService.readRepository(outside), null);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('un archivo nuevo aparece como sin rastrear', async () => {
    await write('Program.cs', 'class Program {}\n');
    gitService.invalidate();

    const status = await gitService.readRepository(repo);
    assert.equal(status.unstaged.length, 1);
    assert.equal(status.unstaged[0].path, 'Program.cs');
    assert.equal(status.unstaged[0].letter, 'U');
    assert.equal(status.hasCommits, false, 'todavía no hay ningún commit');
  });

  it('prepararlo lo mueve a la sección de preparados', async () => {
    const result = await gitService.stage(repo, ['Program.cs']);

    assert.equal(result.ok, true);
    assert.match(result.message, /1 archivo preparado/);
    assert.equal(result.status.staged.length, 1);
    assert.equal(result.status.staged[0].letter, 'A');
    assert.equal(result.status.unstaged.length, 0);
  });

  it('quitarlo de preparados funciona aunque no haya HEAD todavía', async () => {
    const result = await gitService.unstage(repo, ['Program.cs']);

    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status.staged.length, 0);
    assert.equal(result.status.unstaged.length, 1);
  });

  it('confirmar sin nada preparado no crea un commit', async () => {
    const result = await gitService.commit(repo, 'no debería existir');

    assert.equal(result.ok, false);
    assert.match(result.message, /nada preparado/i);
    assert.equal(result.detail, '', 'ni siquiera se llega a llamar a git');
  });

  it('un mensaje vacío se rechaza antes de llamar a git', async () => {
    const result = await gitService.commit(repo, '   ');

    assert.equal(result.ok, false);
    assert.match(result.message, /mensaje de commit/i);
  });

  it('preparar y confirmar deja el árbol limpio', async () => {
    await gitService.stage(repo, ['Program.cs']);
    const result = await gitService.commit(repo, 'Primer commit');

    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status.staged.length, 0);
    assert.equal(result.status.unstaged.length, 0);
    assert.equal(result.status.hasCommits, true);
    assert.equal(result.status.branch, 'main');
    assert.equal(result.status.dirtyFiles, 0);
  });

  it('modificar un archivo con seguimiento lo marca como M', async () => {
    await write('Program.cs', 'class Program { int x; }\n');
    gitService.invalidate();

    const status = await gitService.readRepository(repo);
    assert.equal(status.unstaged[0].letter, 'M');
    assert.equal(status.unstaged[0].untracked, false);
  });

  it('descartar un archivo con seguimiento lo devuelve a su versión anterior', async () => {
    const result = await gitService.discard(repo, ['Program.cs']);

    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status.unstaged.length, 0);
    assert.equal(await read('Program.cs'), 'class Program {}\n');
  });

  it('descartar un archivo SIN rastrear lo borra del disco', async () => {
    await write('Basura.cs', 'temporal\n');
    gitService.invalidate();

    const result = await gitService.discard(repo, ['Basura.cs']);

    assert.equal(result.ok, true, result.detail);
    assert.equal(existsSync(join(repo, 'Basura.cs')), false);
  });

  it('descartar no toca nada fuera del repositorio', async () => {
    const outsideFile = join(tmpdir(), 'dotforge-no-tocar.txt');
    await writeFile(outsideFile, 'intacto', 'utf8');

    try {
      const result = await gitService.discard(repo, [outsideFile, '../fuera.txt']);

      assert.equal(result.ok, false, 'no había ninguna ruta válida que descartar');
      assert.equal(await readFile(outsideFile, 'utf8'), 'intacto');
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('crear una rama la deja activa', async () => {
    const result = await gitService.createBranch(repo, 'feature/panel-git');

    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status.branch, 'feature/panel-git');
    assert.match(result.message, /feature\/panel-git/);
  });

  it('un nombre de rama inválido se rechaza sin llamar a git', async () => {
    const result = await gitService.createBranch(repo, 'con espacios');

    assert.equal(result.ok, false);
    assert.match(result.message, /no es válido/);
  });

  it('cambiar de rama vuelve a la anterior', async () => {
    const result = await gitService.checkout(repo, 'main');

    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status.branch, 'main');
  });

  it('listBranches devuelve las ramas locales', async () => {
    gitService.invalidate();
    const branches = await gitService.listBranches(repo);

    assert.ok(branches.includes('main'), branches.join(', '));
    assert.ok(branches.includes('feature/panel-git'), branches.join(', '));
  });

  it('showFile devuelve el contenido de una revisión', async () => {
    const content = await gitService.showFile(repo, 'HEAD:Program.cs');
    assert.equal(normalize(content), 'class Program {}\n');
  });

  it('showFile de un archivo inexistente devuelve vacío, no un error', async () => {
    assert.equal(await gitService.showFile(repo, 'HEAD:NoExiste.cs'), '');
  });

  it('los dos lados de una comparación salen de donde deben', async () => {
    await write('Program.cs', 'class Program { int y; }\n');
    gitService.invalidate();

    const status = await gitService.readRepository(repo);
    const change = status.unstaged.find((entry) => entry.path === 'Program.cs');
    const request = {
      path: 'Program.cs',
      originalPath: 'Program.cs',
      area: change.area,
      original: 'index',
      modified: 'worktree',
      title: 'Program.cs',
      originalLabel: 'Índice',
      modifiedLabel: 'Local',
      readOnly: true,
    };

    const side = async (which, overrides = {}) =>
      normalize(await gitService.diffSideContent(repo, { ...request, ...overrides }, which));

    assert.equal(await side('original'), 'class Program {}\n');
    assert.equal(await side('modified'), 'class Program { int y; }\n');

    // Un lado vacío es exactamente eso: ni error, ni el contenido del otro lado.
    assert.equal(await side('original', { original: 'empty' }), '');

    await gitService.discard(repo, ['Program.cs']);
  });

  it('publicar sin remoto falla con un mensaje legible, no con una excepción', async () => {
    gitService.invalidate();
    const result = await gitService.push(repo);

    assert.equal(result.ok, false);
    assert.match(result.message, /No se ha podido publicar/);
    assert.ok(result.detail.length > 0, 'la salida de git debe llegar para poder enseñarla');
  });

  it('las rutas con espacios y acentos sobreviven al viaje de ida y vuelta', async () => {
    await write('Programa Español.cs', '// hola\n');
    gitService.invalidate();

    const staged = await gitService.stage(repo, ['Programa Español.cs']);
    assert.equal(staged.ok, true, staged.detail);
    assert.equal(staged.status.staged[0].path, 'Programa Español.cs');

    const undone = await gitService.unstage(repo, ['Programa Español.cs']);
    assert.equal(undone.ok, true, undone.detail);
    assert.equal(undone.status.unstaged[0].path, 'Programa Español.cs');

    await gitService.discard(repo, ['Programa Español.cs']);
  });
});
