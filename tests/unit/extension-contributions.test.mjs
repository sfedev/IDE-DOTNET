/**
 * Pruebas del servicio que lee las contribuciones de las extensiones instaladas.
 *
 * Contra el disco de verdad, con extensiones montadas en un directorio temporal: es la única forma
 * honesta de comprobar las dos cosas que no se ven en el modelo puro — que un `include` se resuelve
 * leyendo un segundo archivo, y que una ruta que apunta fuera de la extensión **no se lee**.
 *
 * Lo segundo no es paranoia teórica: `contributes` es JSON escrito por un tercero, viene dentro de
 * un `.vsix` descargado de un registro público, y su `path` acaba en un `readFile`.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extensionContributions, initializeExtensions } from '../../build/main-lib.mjs';

let userData;

/** Monta una extensión instalada: su carpeta, su manifiesto y los archivos que declare. */
async function install(folder, manifest, files = {}) {
  const directory = join(userData, 'extensions', folder);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');

  for (const [relative, contents] of Object.entries(files)) {
    const target = join(directory, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  }

  return directory;
}

before(async () => {
  userData = await mkdtemp(join(tmpdir(), 'dotforge-contrib-'));
  initializeExtensions(userData);
});

after(async () => {
  await rm(userData, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(userData, 'extensions'), { recursive: true, force: true });
});

describe('temas de una extensión instalada', () => {
  it('se lee, se convierte y se puede ofrecer', async () => {
    await install(
      'acme.temas-1.0.0',
      {
        publisher: 'acme',
        name: 'temas',
        version: '1.0.0',
        contributes: { themes: [{ label: 'Noche', uiTheme: 'vs-dark', path: './themes/noche.json' }] },
      },
      {
        'themes/noche.json': {
          colors: { 'editor.background': '#1e1e1eff' },
          tokenColors: [{ scope: 'comment', settings: { foreground: '#6A9955', fontStyle: 'italic' } }],
        },
      },
    );

    const { themes, problems } = await extensionContributions.load();

    assert.deepEqual(problems, []);
    assert.equal(themes.length, 1);
    assert.equal(themes[0].id, 'ext:acme.temas:Noche');
    assert.equal(themes[0].data.base, 'vs-dark');
    // El canal alfa se ha recortado: Monaco lanza con un color de ocho dígitos.
    assert.equal(themes[0].data.colors['editor.background'], '#1e1e1e');
    assert.deepEqual(themes[0].data.rules[0], { token: 'comment', foreground: '6a9955', fontStyle: 'italic' });
  });

  /**
   * El caso real de los temas de Microsoft: `dark_plus.json` son cuatro reglas más un `include`.
   * Sin resolverlo se obtiene un tema casi vacío que no falla — sólo se ve mal.
   */
  it('un include se resuelve, y lo del propio tema gana', async () => {
    await install(
      'acme.temas-1.0.0',
      {
        publisher: 'acme',
        name: 'temas',
        version: '1.0.0',
        contributes: { themes: [{ label: 'Plus', uiTheme: 'vs-dark', path: './themes/plus.json' }] },
      },
      {
        'themes/plus.json': {
          include: './base.json',
          colors: { 'editor.background': '#000000' },
        },
        'themes/base.json': {
          colors: { 'editor.background': '#ffffff', 'editor.foreground': '#eeeeee' },
          tokenColors: [{ scope: 'keyword', settings: { foreground: '#569CD6' } }],
        },
      },
    );

    const { themes } = await extensionContributions.load();
    const colors = themes[0].data.colors;

    assert.equal(colors['editor.background'], '#000000', 'debería ganar el que incluye');
    assert.equal(colors['editor.foreground'], '#eeeeee', 'lo heredado tiene que llegar');
    assert.ok(themes[0].data.rules.some((rule) => rule.token === 'keyword'), 'faltan las reglas del incluido');
  });

  it('un include circular no cuelga el arranque', async () => {
    await install(
      'acme.temas-1.0.0',
      {
        publisher: 'acme',
        name: 'temas',
        version: '1.0.0',
        contributes: { themes: [{ label: 'Bucle', path: './a.json' }] },
      },
      { 'a.json': { include: './b.json', colors: {} }, 'b.json': { include: './a.json', colors: {} } },
    );

    const { themes } = await extensionContributions.load();
    assert.equal(themes.length, 1);
  });

  /**
   * La ruta viene de un JSON escrito por un tercero y acaba en un `readFile`. Se valida contra la
   * carpeta de la extensión, igual que ya se valida el nombre de esa carpeta al instalarla.
   */
  it('una ruta que se sale de la extensión no se lee, y se dice', async () => {
    await install('acme.temas-1.0.0', {
      publisher: 'acme',
      name: 'temas',
      version: '1.0.0',
      contributes: {
        themes: [
          { label: 'Fuga', path: '../../../settings.json' },
          { label: 'Absoluta', path: process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd' },
        ],
      },
    });

    const { themes, problems } = await extensionContributions.load();

    assert.deepEqual(themes, []);
    assert.equal(problems.length, 2);
    for (const problem of problems) assert.match(problem, /apunta fuera de la extensión/);
  });

  it('un tema que no existe se anota y no impide cargar los demás', async () => {
    await install(
      'acme.temas-1.0.0',
      {
        publisher: 'acme',
        name: 'temas',
        version: '1.0.0',
        contributes: {
          themes: [
            { label: 'Ausente', path: './no-esta.json' },
            { label: 'Presente', path: './si.json' },
          ],
        },
      },
      { 'si.json': { colors: { 'editor.background': '#123456' } } },
    );

    const { themes, problems } = await extensionContributions.load();

    assert.deepEqual(themes.map((theme) => theme.label), ['Presente']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Ausente/);
  });

  it('un .tmTheme se traduce al mismo documento que un .json', async () => {
    const tmTheme = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>name</key>
    <string>Antiguo</string>
    <key>settings</key>
    <array>
      <dict>
        <key>settings</key>
        <dict>
          <key>background</key>
          <string>#202020</string>
          <key>foreground</key>
          <string>#d0d0d0</string>
        </dict>
      </dict>
      <dict>
        <key>scope</key>
        <string>comment</string>
        <key>settings</key>
        <dict>
          <key>foreground</key>
          <string>#808080</string>
        </dict>
      </dict>
    </array>
  </dict>
</plist>`;

    await install(
      'acme.antiguo-1.0.0',
      {
        publisher: 'acme',
        name: 'antiguo',
        version: '1.0.0',
        contributes: { themes: [{ label: 'Antiguo', path: './Antiguo.tmTheme' }] },
      },
      { 'Antiguo.tmTheme': tmTheme },
    );

    const { themes, problems } = await extensionContributions.load();

    assert.deepEqual(problems, []);
    assert.equal(themes.length, 1);
    // La entrada sin ámbito lleva los colores por defecto del editor, no los de un token.
    assert.equal(themes[0].data.colors['editor.background'], '#202020');
    assert.equal(themes[0].data.colors['editor.foreground'], '#d0d0d0');
    assert.deepEqual(
      themes[0].data.rules.find((rule) => rule.token === 'comment'),
      { token: 'comment', foreground: '808080' },
    );
  });
});

describe('fragmentos de una extensión instalada', () => {
  it('se leen y se etiquetan con su lenguaje y su extensión', async () => {
    await install(
      'acme.frag-1.0.0',
      {
        publisher: 'acme',
        name: 'frag',
        version: '1.0.0',
        contributes: { snippets: [{ language: 'csharp', path: './snippets/csharp.json' }] },
      },
      {
        'snippets/csharp.json': {
          'Prueba xUnit': { prefix: 'xfact', body: ['[Fact]', 'public void $1() { }'] },
        },
      },
    );

    const { snippets, problems } = await extensionContributions.load();

    assert.deepEqual(problems, []);
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0].prefix, 'xfact');
    assert.equal(snippets[0].language, 'csharp');
    assert.equal(snippets[0].extensionId, 'acme.frag');
    assert.equal(snippets[0].body, '[Fact]\npublic void $1() { }');
  });

  it('los fragmentos tampoco pueden apuntar fuera de la extensión', async () => {
    await install('acme.frag-1.0.0', {
      publisher: 'acme',
      name: 'frag',
      version: '1.0.0',
      contributes: { snippets: [{ language: 'csharp', path: '../../fuera.json' }] },
    });

    const { snippets, problems } = await extensionContributions.load();

    assert.deepEqual(snippets, []);
    assert.match(problems[0], /apuntan fuera de la extensión/);
  });

  it('un archivo de fragmentos ilegible se anota sin tirar el resto', async () => {
    await install(
      'acme.frag-1.0.0',
      {
        publisher: 'acme',
        name: 'frag',
        version: '1.0.0',
        contributes: {
          snippets: [
            { language: 'csharp', path: './roto.json' },
            { language: 'json', path: './bueno.json' },
          ],
        },
      },
      { 'roto.json': 'esto no es JSON {{{', 'bueno.json': { X: { prefix: 'x', body: 'y' } } },
    );

    const { snippets, problems } = await extensionContributions.load();

    assert.deepEqual(snippets.map((snippet) => snippet.language), ['json']);
    assert.equal(problems.length, 1);
  });
});

describe('sin extensiones', () => {
  it('no hay nada que cargar y no es un error', async () => {
    assert.deepEqual(await extensionContributions.load(), { themes: [], snippets: [], problems: [] });
  });

  it('una extensión sin manifiesto legible se anota y no impide cargar las demás', async () => {
    const roto = join(userData, 'extensions', 'acme.roto-1.0.0');
    await mkdir(roto, { recursive: true });
    await writeFile(join(roto, 'package.json'), 'no soy JSON', 'utf8');

    await install(
      'acme.bien-1.0.0',
      {
        publisher: 'acme',
        name: 'bien',
        version: '1.0.0',
        contributes: { themes: [{ label: 'Bien', path: './t.json' }] },
      },
      { 't.json': { colors: {} } },
    );

    const { themes } = await extensionContributions.load();
    assert.deepEqual(themes.map((theme) => theme.label), ['Bien']);
  });
});
