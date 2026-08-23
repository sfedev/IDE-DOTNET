/**
 * Pruebas del modelo de control de código fuente.
 *
 * Todo lo que se ejercita aquí son funciones puras que consumen salida **real** de
 * `git status --porcelain --branch`: renombrados, conflictos de fusión, rutas con espacios y
 * acentos, un repositorio sin commits todavía y una rama sin upstream. Son exactamente los casos
 * que un repositorio de pruebas "normal" no produce nunca y que sí aparecen el día que alguien
 * usa el panel de verdad.
 *
 * La construcción del diff se prueba aparte porque es la que decide qué se le pide a git: un
 * error ahí no se ve como un fallo, se ve como una comparación que enseña lo que no es.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiffRequest,
  describeCount,
  describeLetter,
  diffKey,
  isValidBranchName,
  normalizeCommitMessage,
  parseBranchLine,
  parseGitStatus,
  revisionFor,
  syncSummary,
  toRepositoryPaths,
  unquotePath,
} from '../../build/main-lib.mjs';

/** Une líneas como lo haría git: una por entrada, con salto final. */
function porcelain(...lines) {
  return `${lines.join('\n')}\n`;
}

describe('parseBranchLine', () => {
  it('rama con upstream, adelanto y retraso', () => {
    const state = parseBranchLine('## main...origin/main [ahead 2, behind 3]');

    assert.equal(state.branch, 'main');
    assert.equal(state.upstream, 'origin/main');
    assert.equal(state.ahead, 2);
    assert.equal(state.behind, 3);
    assert.equal(state.detached, false);
    assert.equal(state.hasCommits, true);
  });

  it('sólo adelanto', () => {
    const state = parseBranchLine('## feature/panel-git...origin/feature/panel-git [ahead 1]');

    assert.equal(state.branch, 'feature/panel-git');
    assert.equal(state.ahead, 1);
    assert.equal(state.behind, 0);
  });

  it('rama local sin upstream', () => {
    const state = parseBranchLine('## trabajo-local');

    assert.equal(state.branch, 'trabajo-local');
    assert.equal(state.upstream, null);
    assert.equal(state.ahead, 0);
  });

  it('upstream borrado en el remoto ([gone]) no se confunde con un contador', () => {
    const state = parseBranchLine('## main...origin/main [gone]');

    assert.equal(state.upstream, 'origin/main');
    assert.equal(state.ahead, 0);
    assert.equal(state.behind, 0);
  });

  it('HEAD desprendido', () => {
    const state = parseBranchLine('## HEAD (no branch)');

    assert.equal(state.detached, true);
    assert.equal(state.branch, null);
  });

  it('repositorio sin commits todavía', () => {
    const state = parseBranchLine('## No commits yet on main');

    assert.equal(state.branch, 'main');
    assert.equal(state.hasCommits, false);
  });
});

describe('parseGitStatus', () => {
  it('reparte los archivos entre preparados y sin preparar', () => {
    const status = parseGitStatus(
      porcelain(
        '## main...origin/main [ahead 1]',
        'M  src/Acme.WebApi/Program.cs',
        ' M src/Acme.Domain/Product.cs',
        'A  src/Acme.Domain/Sku.cs',
        ' D src/Acme.Domain/Viejo.cs',
        '?? src/Acme.Domain/Nuevo.cs',
      ),
    );

    assert.deepEqual(
      status.staged.map((change) => [change.path, change.letter]),
      [
        ['src/Acme.Domain/Sku.cs', 'A'],
        ['src/Acme.WebApi/Program.cs', 'M'],
      ],
    );

    assert.deepEqual(
      status.unstaged.map((change) => [change.path, change.letter]),
      [
        ['src/Acme.Domain/Nuevo.cs', 'U'],
        ['src/Acme.Domain/Product.cs', 'M'],
        ['src/Acme.Domain/Viejo.cs', 'D'],
      ],
    );

    assert.equal(status.dirtyFiles, 5);
    assert.equal(status.branch, 'main');
    assert.equal(status.ahead, 1);
  });

  it('un archivo preparado y vuelto a modificar sale en las dos secciones', () => {
    const status = parseGitStatus(porcelain('## main', 'MM src/Program.cs'));

    assert.equal(status.staged.length, 1);
    assert.equal(status.unstaged.length, 1);
    // Es un solo archivo, aunque aparezca dos veces: la barra de estado no debe contarlo doble.
    assert.equal(status.dirtyFiles, 1);
  });

  it('un renombrado conserva la ruta anterior', () => {
    const status = parseGitStatus(
      porcelain('## main', 'R  src/Viejo.cs -> src/Nuevo.cs'),
    );

    const change = status.staged[0];
    assert.equal(change.path, 'src/Nuevo.cs');
    assert.equal(change.from, 'src/Viejo.cs');
    assert.equal(change.letter, 'R');
    assert.match(change.description, /desde src\/Viejo\.cs/);
  });

  it('los conflictos de fusión se marcan como tales', () => {
    const status = parseGitStatus(
      porcelain('## main', 'UU src/Program.cs', 'AA src/Otro.cs', 'DU src/Tercero.cs'),
    );

    assert.equal(status.unstaged.length, 3);
    assert.equal(status.staged.length, 0, 'un conflicto no está preparado para confirmar');
    for (const change of status.unstaged) {
      assert.equal(change.conflicted, true);
      assert.equal(change.letter, '!');
      assert.equal(change.description, 'En conflicto');
    }
  });

  it('las rutas con espacios llegan enteras', () => {
    const status = parseGitStatus(porcelain('## main', ' M src/mi carpeta/Mi Archivo.cs'));

    assert.equal(status.unstaged[0].path, 'src/mi carpeta/Mi Archivo.cs');
    assert.equal(status.unstaged[0].name, 'Mi Archivo.cs');
    assert.equal(status.unstaged[0].directory, 'src/mi carpeta');
  });

  it('deshace el entrecomillado de git', () => {
    const status = parseGitStatus(porcelain('## main', ' M "src/con \\"comillas\\".cs"'));

    assert.equal(status.unstaged[0].path, 'src/con "comillas".cs');
  });

  it('los archivos ignorados no son cambios', () => {
    const status = parseGitStatus(porcelain('## main', '!! bin/Debug/App.dll', ' M src/A.cs'));

    assert.equal(status.unstaged.length, 1);
    assert.equal(status.dirtyFiles, 1);
  });

  it('un árbol limpio no produce ningún cambio', () => {
    const status = parseGitStatus(porcelain('## main...origin/main'));

    assert.deepEqual(status.staged, []);
    assert.deepEqual(status.unstaged, []);
    assert.equal(status.dirtyFiles, 0);
  });

  it('una salida vacía no revienta', () => {
    const status = parseGitStatus('');
    assert.equal(status.branch, null);
    assert.equal(status.dirtyFiles, 0);
  });

  it('un archivo en la raíz no tiene carpeta', () => {
    const status = parseGitStatus(porcelain('## main', '?? README.md'));

    assert.equal(status.unstaged[0].directory, '');
    assert.equal(status.unstaged[0].untracked, true);
  });
});

describe('unquotePath', () => {
  const cases = [
    ['src/Program.cs', 'src/Program.cs'],
    ['"src/a b.cs"', 'src/a b.cs'],
    ['"src/con \\"comillas\\".cs"', 'src/con "comillas".cs'],
    ['"src/tab\\there.cs"', 'src/tab\there.cs'],
  ];

  for (const [raw, expected] of cases) {
    it(`${raw} -> ${expected}`, () => {
      assert.equal(unquotePath(raw), expected);
    });
  }
});

describe('describeLetter', () => {
  it('cada letra tiene su texto', () => {
    assert.equal(describeLetter('M'), 'Modificado');
    assert.equal(describeLetter('A'), 'Añadido');
    assert.equal(describeLetter('D'), 'Eliminado');
    assert.equal(describeLetter('U'), 'Sin rastrear');
  });
});

describe('syncSummary', () => {
  const base = { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false, hasCommits: true };

  it('al día', () => {
    const summary = syncSummary(base);
    assert.equal(summary.label, '');
    assert.equal(summary.diverged, false);
    assert.equal(summary.canPull, true);
  });

  it('adelantado y retrasado', () => {
    const summary = syncSummary({ ...base, ahead: 2, behind: 1 });
    assert.equal(summary.label, '↑2 ↓1');
    assert.equal(summary.diverged, true);
    assert.match(summary.title, /2 commit\(s\) por publicar/);
  });

  it('sin upstream no se puede traer, pero sí publicar', () => {
    const summary = syncSummary({ ...base, upstream: null });
    assert.equal(summary.canPull, false);
    assert.equal(summary.canPush, true);
  });

  it('en HEAD desprendido no se publica', () => {
    const summary = syncSummary({ ...base, upstream: null, detached: true });
    assert.equal(summary.canPush, false);
  });
});

describe('buildDiffRequest', () => {
  const change = (overrides) => ({
    path: 'src/Program.cs',
    name: 'Program.cs',
    directory: 'src',
    area: 'unstaged',
    letter: 'M',
    code: ' M',
    untracked: false,
    conflicted: false,
    from: null,
    description: 'Modificado',
    ...overrides,
  });

  it('un archivo modificado sin preparar compara el índice con el disco', () => {
    const request = buildDiffRequest(change());

    assert.equal(request.original, 'index');
    assert.equal(request.modified, 'worktree');
    assert.equal(request.title, 'Program.cs (Índice ↔ Local)');
    assert.equal(request.readOnly, true);
  });

  it('un archivo preparado compara HEAD con el índice', () => {
    const request = buildDiffRequest(change({ area: 'staged', code: 'M ' }));

    assert.equal(request.original, 'head');
    assert.equal(request.modified, 'index');
    assert.equal(request.title, 'Program.cs (HEAD ↔ Índice)');
  });

  it('un archivo añadido no existe en HEAD: el lado izquierdo va vacío', () => {
    const request = buildDiffRequest(change({ area: 'staged', letter: 'A', code: 'A ' }));

    assert.equal(request.original, 'empty');
    assert.equal(request.modified, 'index');
  });

  it('un archivo eliminado no existe en el lado derecho', () => {
    const request = buildDiffRequest(change({ letter: 'D', code: ' D' }));

    assert.equal(request.original, 'index');
    assert.equal(request.modified, 'empty');
  });

  it('un archivo sin rastrear se compara contra la nada', () => {
    const request = buildDiffRequest(change({ letter: 'U', code: '??', untracked: true }));

    assert.equal(request.original, 'empty');
    assert.equal(request.modified, 'worktree');
  });

  it('un renombrado pide el lado izquierdo por su ruta anterior', () => {
    const request = buildDiffRequest(
      change({ area: 'staged', letter: 'R', code: 'R ', from: 'src/Viejo.cs', path: 'src/Nuevo.cs' }),
    );

    assert.equal(request.originalPath, 'src/Viejo.cs');
    assert.equal(request.path, 'src/Nuevo.cs');
    assert.equal(request.original, 'head');
  });

  it('la clave distingue las dos comparaciones del mismo archivo', () => {
    const staged = diffKey(buildDiffRequest(change({ area: 'staged', code: 'M ' })));
    const unstaged = diffKey(buildDiffRequest(change()));

    assert.notEqual(staged, unstaged);
    assert.equal(staged, 'git:staged:src/Program.cs');
  });
});

describe('revisionFor', () => {
  it('HEAD y el índice tienen sintaxis distinta en git show', () => {
    assert.equal(revisionFor('head', 'src/A.cs'), 'HEAD:src/A.cs');
    assert.equal(revisionFor('index', 'src/A.cs'), ':src/A.cs');
  });

  it('el disco y el vacío no salen de git', () => {
    assert.equal(revisionFor('worktree', 'src/A.cs'), null);
    assert.equal(revisionFor('empty', 'src/A.cs'), null);
  });
});

describe('isValidBranchName', () => {
  it('acepta los nombres habituales', () => {
    for (const name of ['main', 'feature/panel-git', 'fix_123', 'release/1.5.0']) {
      assert.ok(isValidBranchName(name), name);
    }
  });

  it('rechaza lo que git rechazaría', () => {
    for (const name of ['', '   ', 'con espacio', 'a..b', 'rama~1', 'rama^', 'rama:otra', '-inicial', 'final/', 'x?', 'a[b']) {
      assert.equal(isValidBranchName(name), false, name);
    }
  });
});

describe('normalizeCommitMessage', () => {
  it('recorta y normaliza los saltos de línea', () => {
    assert.equal(normalizeCommitMessage('  Arregla el panel\r\n\r\nCon cuerpo  '), 'Arregla el panel\n\nCon cuerpo');
  });

  it('un mensaje vacío no vale', () => {
    assert.equal(normalizeCommitMessage('   \n  '), null);
  });

  it('un mensaje descomunal no vale', () => {
    assert.equal(normalizeCommitMessage('x'.repeat(20_001)), null);
  });
});

describe('toRepositoryPaths', () => {
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const inside = process.platform === 'win32' ? 'C:\\repo\\src\\A.cs' : '/repo/src/A.cs';
  const outside = process.platform === 'win32' ? 'C:\\otro\\B.cs' : '/otro/B.cs';

  it('convierte una ruta absoluta del explorador en relativa al repositorio', () => {
    assert.deepEqual(toRepositoryPaths(root, [inside]), ['src/A.cs']);
  });

  it('deja pasar una relativa tal cual', () => {
    assert.deepEqual(toRepositoryPaths(root, ['src/A.cs']), ['src/A.cs']);
  });

  it('descarta lo que se sale del repositorio', () => {
    assert.deepEqual(toRepositoryPaths(root, [outside, '../fuera.cs', '', 42, null]), []);
  });
});

describe('describeCount', () => {
  it('concuerda el singular y el plural', () => {
    assert.equal(describeCount(1, 'archivo preparado', 'archivos preparados'), '1 archivo preparado');
    assert.equal(describeCount(3, 'archivo preparado', 'archivos preparados'), '3 archivos preparados');
  });
});
