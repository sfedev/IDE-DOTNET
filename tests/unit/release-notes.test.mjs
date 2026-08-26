/**
 * Pruebas de las notas de una release.
 *
 * Lo que se ejercita aquí no es "sale un Markdown bonito": es que el texto que compone la CI y el
 * lector que lo pinta dentro del IDE siguen entendiéndose. Son dos módulos que no se importan el
 * uno al otro, viven en carpetas distintas y sólo se encuentran en producción, con una release
 * publicada de por medio. Es exactamente el sitio donde un cambio inocente rompe algo que nadie
 * mira hasta la siguiente versión.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReleaseNotes,
  compareUrl,
  MAX_COMMITS,
  parseCommitSubjects,
  releaseTagFor,
  versionFromTag,
} from '../../scripts/lib/release-notes.mjs';

import { releaseNotesLines } from '../../build/ui-lib.mjs';

const COMMITS = [
  'Empaquetado: electron-builder recompilaba node-pty y moría sin Visual Studio',
  'devlog.mjs: `status` sin argumentos leía escribiendo',
  'Terminal: varias pestañas y un intérprete de verdad detrás',
];

describe('tags y versiones', () => {
  it('pone la v que espera el tag y no la duplica', () => {
    assert.equal(releaseTagFor('2.5.0'), 'v2.5.0');
    assert.equal(releaseTagFor('v2.5.0'), 'v2.5.0');
    assert.equal(releaseTagFor('  2.5.0  '), 'v2.5.0');
  });

  it('extrae la versión del tag, con prelanzamiento incluido', () => {
    assert.equal(versionFromTag('v2.5.0'), '2.5.0');
    assert.equal(versionFromTag('2.5.0'), '2.5.0');
    assert.equal(versionFromTag('v2.6.0-rc.1'), '2.6.0-rc.1');
  });

  /**
   * Un repositorio real acumula tags que no son versiones. Convertir `nightly` en una versión
   * inventada es peor que no publicar: el actualizador la compararía con la instalada.
   */
  it('un tag que no es una versión no se convierte en una', () => {
    for (const tag of ['nightly', 'latest', 'v2.5', 'release-2', '']) {
      assert.equal(versionFromTag(tag), null, `"${tag}" no debería parsearse`);
    }
  });

  it('sin tag anterior no hay comparación que enseñar', () => {
    assert.equal(compareUrl(null, 'v2.5.0'), null);
    assert.equal(compareUrl('   ', 'v2.5.0'), null);
    assert.match(compareUrl('v2.4.0', 'v2.5.0'), /compare\/v2\.4\.0\.\.\.v2\.5\.0$/);
  });
});

describe('lectura del historial', () => {
  it('trocea la salida de git y descarta lo vacío', () => {
    assert.deepEqual(parseCommitSubjects('uno\n\n  dos  \n'), ['uno', 'dos']);
    assert.deepEqual(parseCommitSubjects(''), []);
    assert.deepEqual(parseCommitSubjects(undefined), []);
  });

  it('acepta finales de línea de Windows', () => {
    // El repositorio está en LF, pero `git log` lo lanza un runner y una consola de Windows.
    assert.deepEqual(parseCommitSubjects('uno\r\ndos\r\n'), ['uno', 'dos']);
  });

  it('los merges no son un cambio que contarle a nadie', () => {
    const raw = ['Merge branch main', 'Arreglo de verdad', 'Merge pull request #3 de x'].join('\n');
    assert.deepEqual(parseCommitSubjects(raw), ['Arreglo de verdad']);
  });

  /**
   * Sólo al principio del asunto. Un commit que *habla* de un merge sí es un cambio, y filtrarlo
   * dejaría la release sin explicar justo lo que trae.
   */
  it('un commit que menciona un merge en mitad de la frase se conserva', () => {
    assert.deepEqual(
      parseCommitSubjects('Git: el panel avisa cuando hay un merge a medias'),
      ['Git: el panel avisa cuando hay un merge a medias'],
    );
  });

  it('los duplicados consecutivos se colapsan', () => {
    assert.deepEqual(parseCommitSubjects('mismo\nmismo\notro\nmismo'), ['mismo', 'otro', 'mismo']);
  });
});

describe('composición del cuerpo', () => {
  it('encabeza con la versión y lista los cambios', () => {
    const notes = buildReleaseNotes({ version: '2.5.0', commits: COMMITS, previousTag: 'v2.4.0' });

    assert.match(notes, /^## DotForge IDE v2\.5\.0\n/);
    for (const commit of COMMITS) assert.ok(notes.includes(`- ${commit}`), `falta: ${commit}`);
    assert.match(notes, /compare\/v2\.4\.0\.\.\.v2\.5\.0/);
    assert.ok(notes.endsWith('\n'), 'el cuerpo debe terminar en un solo salto de línea');
  });

  it('sin cambios lo dice en vez de dejar el cuerpo en blanco', () => {
    const notes = buildReleaseNotes({ version: '2.5.0', commits: [] });
    assert.match(notes, /Sin cambios registrados/);
  });

  /**
   * "No silent caps": si se recorta la lista, se dice cuántos quedan fuera. Un tope callado se lee
   * como "esto es todo lo que hay".
   */
  it('el recorte de la lista se anuncia con el número exacto', () => {
    const many = Array.from({ length: MAX_COMMITS + 7 }, (_, index) => `cambio ${index}`);
    const notes = buildReleaseNotes({ version: '3.0.0', commits: many });

    assert.match(notes, /…y 7 cambios más/);
    assert.ok(notes.includes(`- cambio ${MAX_COMMITS - 1}`), 'debería listar hasta el tope');
    assert.ok(!notes.includes(`- cambio ${MAX_COMMITS}`), 'no debería pasarse del tope');
  });

  it('con un único cambio de más, la frase va en singular', () => {
    const many = Array.from({ length: MAX_COMMITS + 1 }, (_, index) => `cambio ${index}`);
    assert.match(buildReleaseNotes({ version: '3.0.0', commits: many }), /…y 1 cambio más/);
  });

  it('describe qué es cada artefacto, y no inventa nada de lo que no reconoce', () => {
    const notes = buildReleaseNotes({
      version: '2.5.0',
      commits: COMMITS,
      artifacts: ['DotForge IDE-2.5.0-Setup-x64.exe', 'DotForge IDE-2.5.0-win-x64.zip', 'notas.txt'],
    });

    assert.match(notes, /Setup-x64\.exe — instalador para Windows\./);
    assert.match(notes, /win-x64\.zip — portable para Windows, sin instalar\./);
    assert.match(notes, /- notas\.txt$/m, 'lo no reconocido se lista sin descripción inventada');
  });

  it('sin artefactos no se pinta una sección de descargas vacía', () => {
    assert.ok(!buildReleaseNotes({ version: '2.5.0', commits: COMMITS }).includes('### Descargas'));
  });

  it('una versión ausente es un error, no una release sin nombre', () => {
    assert.throws(() => buildReleaseNotes({ commits: COMMITS }), TypeError);
    assert.throws(() => buildReleaseNotes({ version: '  ' }), TypeError);
  });
});

/**
 * El contrato con la tarjeta del IDE.
 *
 * `releaseNotesLines` vive en `src/shared/updates.ts` y limpia el Markdown para poder pintarlo sin
 * inyectar marcado. Lo que se comprueba aquí es que lo que compone la CI sobrevive a esa limpieza:
 * que llega texto, que llega **el texto que importa** y que no llega ni una marca de Markdown.
 */
describe('lo que acaba viendo el usuario en la tarjeta', () => {
  const notes = buildReleaseNotes({
    version: '2.5.0',
    commits: COMMITS,
    previousTag: 'v2.4.0',
    artifacts: ['DotForge IDE-2.5.0-Setup-x64.exe'],
  });

  const lines = releaseNotesLines(notes);

  it('la tarjeta no se queda vacía', () => {
    assert.ok(lines.length > 0, 'la limpieza se ha comido el cuerpo entero');
  });

  it('lo primero que se lee es la versión', () => {
    assert.equal(lines[0], 'DotForge IDE v2.5.0');
  });

  /**
   * La tarjeta enseña doce líneas. Si el cuerpo empezara por la plantilla de instalación, el
   * usuario miraría instrucciones en vez de qué ha cambiado.
   */
  it('los cambios entran dentro de las doce líneas que caben', () => {
    const visible = releaseNotesLines(notes, 12);
    for (const commit of COMMITS) {
      assert.ok(
        visible.some((line) => line.includes(commit.replace(/`/g, ''))),
        `el cambio "${commit}" se queda fuera de la tarjeta`,
      );
    }
  });

  it('no sobrevive ninguna marca de Markdown', () => {
    for (const line of lines) {
      assert.doesNotMatch(line, /^#{1,6}\s/, `encabezado sin limpiar: ${line}`);
      assert.doesNotMatch(line, /^[-*+]\s/, `viñeta sin limpiar: ${line}`);
      assert.doesNotMatch(line, /\*\*/, `negrita sin limpiar: ${line}`);
      assert.doesNotMatch(line, /`/, `código en línea sin limpiar: ${line}`);
    }
  });

  /**
   * Ninguna línea puede quedar en nada al limpiarla: se vería entera en GitHub y desaparecería en
   * el IDE, que es la clase de divergencia que sólo se descubre con la release ya publicada.
   */
  it('ninguna línea del cuerpo se evapora al limpiarla', () => {
    for (const raw of notes.split('\n')) {
      if (raw.trim() === '') continue;
      assert.equal(
        releaseNotesLines(raw).length,
        1,
        `esta línea desaparece en la tarjeta: ${JSON.stringify(raw)}`,
      );
    }
  });

  it('el cuerpo entero se ve en la tarjeta si se le deja sitio', () => {
    const todas = releaseNotesLines(notes, 200);
    assert.equal(todas.length, notes.split('\n').filter((line) => line.trim() !== '').length);
  });
});
