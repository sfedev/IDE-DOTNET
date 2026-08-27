/**
 * Pruebas del consumo declarativo de extensiones.
 *
 * Esto es la deuda del ADR-048 y por eso conviene decir qué se está probando: hasta ahora el IDE
 * instalaba el `.vsix`, leía su manifiesto para poder contar en la ficha qué aportaba, y **no
 * consumía nada** — ni siquiera lo que esa misma ficha listaba como soportado.
 *
 * Lo que se ejercita aquí es donde está el peligro: la conversión de colores. Monaco **lanza** ante
 * un color que no sea hexadecimal de seis dígitos, y los temas de VS Code usan `#rrggbbaa` a manos
 * llenas. Sin normalizar, el primer tema de verdad que se cargue tira el editor entero, y con él la
 * ventana.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  chromeThemeFor,
  convertTheme,
  isExtensionTheme,
  monacoBaseFor,
  monacoThemeName,
  normalizeColor,
  normalizeColorWithHash,
  parseContributedSnippets,
  parseContributedThemes,
  parseSnippetFile,
  themeId,
} from '../../build/ui-lib.mjs';

describe('colores de un tema', () => {
  it('un hexadecimal de seis dígitos pasa tal cual, sin almohadilla', () => {
    assert.equal(normalizeColor('#1B1D27'), '1b1d27');
    assert.equal(normalizeColor('1b1d27'), '1b1d27');
  });

  /**
   * El caso que rompe el editor. Todo lo translúcido de un tema —selección, resaltado de la línea
   * actual, bordes, guías de indentación— se escribe con canal alfa, y Monaco no lo admite.
   */
  it('se le recorta el canal alfa a un color de ocho dígitos', () => {
    assert.equal(normalizeColor('#264F7840'), '264f78');
    assert.equal(normalizeColor('#ffffff00'), 'ffffff');
  });

  it('las formas abreviadas se expanden', () => {
    assert.equal(normalizeColor('#abc'), 'aabbcc');
    assert.equal(normalizeColor('#abcd'), 'aabbcc');
  });

  it('lo que no es un color devuelve null en vez de colarse', () => {
    for (const value of ['rgb(1,2,3)', 'red', '#12', '#1234567', '', null, 42, {}]) {
      assert.equal(normalizeColor(value), null, `${JSON.stringify(value)} no es un color`);
    }
  });

  it('el mapa de colores del tema sí lleva almohadilla', () => {
    // Monaco quiere el color **sin** almohadilla en las reglas de token y **con** ella en `colors`.
    // Es la clase de asimetría que se olvida y produce un tema que lanza al registrarse.
    assert.equal(normalizeColorWithHash('#264F7840'), '#264f78');
    assert.equal(normalizeColorWithHash('nada'), null);
  });
});

describe('temas declarados en el manifiesto', () => {
  const manifest = {
    contributes: {
      themes: [
        { label: 'Noche', uiTheme: 'vs-dark', path: './themes/noche.json' },
        { label: 'Día', uiTheme: 'vs', path: './themes/dia.json' },
      ],
    },
  };

  it('se leen con su etiqueta, su aspecto y su ruta', () => {
    const themes = parseContributedThemes(manifest, 'acme.temas');
    assert.equal(themes.length, 2);
    assert.deepEqual(themes[0], {
      id: 'ext:acme.temas:Noche',
      extensionId: 'acme.temas',
      label: 'Noche',
      uiTheme: 'vs-dark',
      path: './themes/noche.json',
    });
  });

  it('el identificador lleva la extensión y la etiqueta, pero no la versión', () => {
    // Se guarda en las preferencias: tiene que sobrevivir a una actualización de la extensión.
    assert.equal(themeId('acme.temas', 'Noche'), 'ext:acme.temas:Noche');
    assert.equal(isExtensionTheme('ext:acme.temas:Noche'), true);
    assert.equal(isExtensionTheme('dotforge-dark'), false);
  });

  it('sin ruta o sin nombre no se puede ofrecer, y se descarta sin tirar el resto', () => {
    const themes = parseContributedThemes(
      { contributes: { themes: [{ label: 'Sin ruta' }, { path: './x.json' }, ...manifest.contributes.themes] } },
      'acme.temas',
    );
    assert.deepEqual(themes.map((theme) => theme.label), ['Noche', 'Día']);
  });

  it('si falta la etiqueta se usa el id, como hace VS Code', () => {
    const [theme] = parseContributedThemes(
      { contributes: { themes: [{ id: 'noche-profunda', path: './x.json' }] } },
      'acme.temas',
    );
    assert.equal(theme.label, 'noche-profunda');
  });

  it('un uiTheme desconocido no se propaga: cae a oscuro', () => {
    const [theme] = parseContributedThemes(
      { contributes: { themes: [{ label: 'X', uiTheme: 'inventado', path: './x.json' }] } },
      'acme.temas',
    );
    assert.equal(theme.uiTheme, 'vs-dark');
  });

  it('un manifiesto sin temas, o que no es un manifiesto, da una lista vacía', () => {
    for (const raw of [null, undefined, 42, {}, { contributes: {} }, { contributes: { themes: 'no' } }]) {
      assert.deepEqual(parseContributedThemes(raw, 'acme.temas'), []);
    }
  });

  /**
   * Un tema de VS Code describe el editor, no esta ventana: no sabe nada de la barra de actividad
   * ni del panel. Se elige el tema propio que menos desentone, y el ajuste lo dice.
   */
  it('el aspecto del resto del IDE sale del uiTheme del tema', () => {
    assert.equal(chromeThemeFor('vs'), 'dotforge-light');
    assert.equal(chromeThemeFor('hc-light'), 'dotforge-light');
    assert.equal(chromeThemeFor('vs-dark'), 'dotforge-dark');
    assert.equal(chromeThemeFor('hc-black'), 'dotforge-dark');
  });

  it('la base de Monaco también', () => {
    assert.equal(monacoBaseFor('vs'), 'vs');
    assert.equal(monacoBaseFor('vs-dark'), 'vs-dark');
    assert.equal(monacoBaseFor('hc-black'), 'hc-black');
    assert.equal(monacoBaseFor('hc-light'), 'vs');
  });
});

describe('conversión de un tema a Monaco', () => {
  const theme = {
    colors: {
      'editor.background': '#1e1e1e',
      'editor.selectionBackground': '#264F7840',
      'editor.inventado': 'no-es-un-color',
    },
    tokenColors: [
      { settings: { foreground: '#d4d4d4', background: '#1e1e1e' } },
      { scope: 'comment', settings: { foreground: '#6A9955', fontStyle: 'italic' } },
      { scope: ['keyword.control', 'storage.type'], settings: { foreground: '#569CD6' } },
      { scope: 'invalid', settings: {} },
    ],
  };

  it('las reglas llevan el color sin almohadilla', () => {
    const { rules } = convertTheme([theme], 'vs-dark');
    const comment = rules.find((rule) => rule.token === 'comment');
    assert.deepEqual(comment, { token: 'comment', foreground: '6a9955', fontStyle: 'italic' });
  });

  it('un ámbito en lista produce una regla por ámbito', () => {
    const { rules } = convertTheme([theme], 'vs-dark');
    assert.ok(rules.some((rule) => rule.token === 'keyword.control'));
    assert.ok(rules.some((rule) => rule.token === 'storage.type'));
  });

  it('un ámbito escrito con comas también', () => {
    const { rules } = convertTheme(
      [{ tokenColors: [{ scope: 'string, string.quoted', settings: { foreground: '#ce9178' } }] }],
      'vs-dark',
    );
    assert.deepEqual(rules.map((rule) => rule.token), ['string', 'string.quoted']);
  });

  /**
   * La entrada sin `scope` no es una regla de token: lleva los colores por defecto del editor. Es
   * la primera de casi todos los `.tmTheme` y de bastantes `.json`.
   */
  it('la entrada sin ámbito fija el primer plano y el fondo del editor', () => {
    const { colors, rules } = convertTheme([theme], 'vs-dark');
    assert.equal(colors['editor.foreground'], '#d4d4d4');
    assert.equal(colors['editor.background'], '#1e1e1e');
    assert.ok(!rules.some((rule) => rule.token === ''), 'no debe salir una regla con token vacío');
  });

  it('los colores del mapa se normalizan y lo que no es un color se cae', () => {
    const { colors } = convertTheme([theme], 'vs-dark');
    assert.equal(colors['editor.selectionBackground'], '#264f78');
    assert.equal(colors['editor.inventado'], undefined);
  });

  it('una entrada sin nada que aplicar no produce regla', () => {
    const { rules } = convertTheme([theme], 'vs-dark');
    assert.ok(!rules.some((rule) => rule.token === 'invalid'));
  });

  /**
   * `dark_plus.json` es un puñado de reglas más `include: ./dark_vs.json`. Sin resolverlo sale un
   * tema casi vacío que **no falla**: simplemente se ve mal, y parece que la conversión va a medias.
   */
  it('lo del propio tema pisa lo que hereda del incluido', () => {
    const propio = { colors: { 'editor.background': '#000000' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#111111' } }] };
    const incluido = { colors: { 'editor.background': '#ffffff', 'editor.foreground': '#eeeeee' }, tokenColors: [] };

    const { colors, rules } = convertTheme([propio, incluido], 'vs-dark');
    assert.equal(colors['editor.background'], '#000000', 'debería ganar el tema que incluye');
    assert.equal(colors['editor.foreground'], '#eeeeee', 'lo que sólo está en el incluido se hereda');
    assert.equal(rules.at(-1)?.foreground, '111111', 'la última regla gana en Monaco');
  });

  it('los estilos de fuente que Monaco no entiende se filtran', () => {
    const { rules } = convertTheme(
      [{ tokenColors: [{ scope: 'a', settings: { fontStyle: 'bold italic brillante' } }] }],
      'vs-dark',
    );
    assert.equal(rules[0].fontStyle, 'bold italic');
  });

  it('un .tmTheme llama settings a lo que un .json llama tokenColors', () => {
    const { rules } = convertTheme(
      [{ settings: [{ scope: 'comment', settings: { foreground: '#6A9955' } }] }],
      'vs-dark',
    );
    assert.equal(rules[0].token, 'comment');
  });

  it('hereda de la base de Monaco: un tema sólo define lo suyo', () => {
    const { base, inherit } = convertTheme([theme], 'vs-dark');
    assert.equal(base, 'vs-dark');
    assert.equal(inherit, true);
  });

  it('un tema vacío no revienta, sólo no aporta nada', () => {
    assert.deepEqual(convertTheme([], 'vs'), { base: 'vs', inherit: true, rules: [], colors: {} });
    assert.deepEqual(convertTheme([{}], 'vs').rules, []);
  });
});

describe('fragmentos de código', () => {
  const file = {
    'Clase de prueba': {
      prefix: 'xfact',
      body: ['[Fact]', 'public void ${1:Metodo}()', '{', '    $0', '}'],
      description: 'Una prueba de xUnit',
    },
    'Sólo una línea': { prefix: 'ctor', body: 'public $1() { }' },
    'Varios disparadores': { prefix: ['log', 'logger'], body: '_logger.LogInformation("$1");' },
    'Sin cuerpo': { prefix: 'nada' },
    'Sin prefijo': { body: 'x' },
  };

  it('el cuerpo en líneas se junta con saltos, que es lo que espera Monaco', () => {
    const [snippet] = parseSnippetFile(file, 'csharp', 'acme.frag');
    assert.equal(snippet.prefix, 'xfact');
    assert.equal(snippet.body, '[Fact]\npublic void ${1:Metodo}()\n{\n    $0\n}');
    assert.equal(snippet.description, 'Una prueba de xUnit');
    assert.equal(snippet.language, 'csharp');
    assert.equal(snippet.extensionId, 'acme.frag');
  });

  it('la sintaxis de fragmento no se traduce: la de VS Code y la de Monaco son la misma', () => {
    const [snippet] = parseSnippetFile(file, 'csharp', 'acme.frag');
    assert.match(snippet.body, /\$\{1:Metodo\}/);
    assert.match(snippet.body, /\$0/);
  });

  it('un prefijo en lista produce un fragmento por disparador', () => {
    const prefixes = parseSnippetFile(file, 'csharp', 'acme.frag').map((snippet) => snippet.prefix);
    assert.ok(prefixes.includes('log'));
    assert.ok(prefixes.includes('logger'));
  });

  it('sin cuerpo o sin prefijo no se puede ofrecer nada', () => {
    const prefixes = parseSnippetFile(file, 'csharp', 'acme.frag').map((snippet) => snippet.prefix);
    assert.ok(!prefixes.includes('nada'));
    assert.equal(prefixes.filter((prefix) => prefix === undefined).length, 0);
  });

  it('si falta la descripción se usa el nombre del fragmento', () => {
    const snippet = parseSnippetFile(file, 'csharp', 'acme.frag').find((entry) => entry.prefix === 'ctor');
    assert.equal(snippet.description, 'Sólo una línea');
  });

  it('un archivo que no es un objeto da una lista vacía', () => {
    for (const raw of [null, undefined, 42, [], 'texto']) {
      assert.deepEqual(parseSnippetFile(raw, 'csharp', 'acme.frag'), []);
    }
  });

  it('los archivos declarados se leen con su lenguaje en minúsculas', () => {
    const files = parseContributedSnippets(
      { contributes: { snippets: [{ language: 'CSharp', path: './s/csharp.json' }, { path: './sin-lenguaje.json' }] } },
      'acme.frag',
    );
    assert.deepEqual(files, [{ extensionId: 'acme.frag', language: 'csharp', path: './s/csharp.json' }]);
  });
});

/**
 * El nombre con el que Monaco conoce el tema.
 *
 * Monaco **valida** el nombre del tema y lanza `Illegal theme name!` con cualquier cosa que no sean
 * letras, dígitos y guiones. El identificador que se guarda en las preferencias lleva dos puntos,
 * puntos y espacios, porque tiene que ser legible: son dos nombres distintos a propósito.
 *
 * Costó una sesión de depuración descubrirlo, porque el fallo no se ve: `defineTheme` lanza, el
 * tema no queda registrado, y `setTheme` con un nombre desconocido **no protesta** — Monaco cae a
 * su tema claro por defecto. El síntoma es "instalo un tema oscuro y el editor se pone blanco".
 */
describe('nombre del tema dentro de Monaco', () => {
  const LEGAL = /^[a-z0-9-]+$/;

  it('sólo letras, dígitos y guiones: es lo único que Monaco acepta', () => {
    for (const id of [
      'ext:acme.temas:Noche',
      'ext:Telokis.theme-dracula-at-dusk:Dracula At Dusk',
      'ext:a.b:Tema (con paréntesis) y acentuación',
      'ext:a.b:☕',
    ]) {
      assert.match(monacoThemeName(id), LEGAL, id);
    }
  });

  it('es determinista: el mismo identificador da siempre el mismo nombre', () => {
    assert.equal(monacoThemeName('ext:acme.temas:Noche'), monacoThemeName('ext:acme.temas:Noche'));
  });

  /**
   * El saneado pierde información —los dos puntos, los puntos y los espacios se aplanan al mismo
   * guion—, así que dos identificadores distintos podrían quedarse con el mismo nombre. Y dos temas
   * registrados con el mismo nombre son el mismo tema: el segundo pisa al primero.
   */
  it('dos identificadores que se aplanan igual siguen siendo temas distintos', () => {
    assert.notEqual(monacoThemeName('ext:a.b:C D'), monacoThemeName('ext:a-b:C-D'));
    assert.notEqual(monacoThemeName('ext:acme.x:Uno'), monacoThemeName('ext:acme.x:Dos'));
  });

  it('un identificador que se queda sin nada legible sigue dando un nombre válido', () => {
    assert.match(monacoThemeName('☕☕☕'), LEGAL);
    assert.match(monacoThemeName(''), LEGAL);
  });

  it('no se va de largo aunque la etiqueta lo sea', () => {
    assert.ok(monacoThemeName(`ext:a.b:${'x'.repeat(400)}`).length < 64);
  });
});
