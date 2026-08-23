/**
 * Pruebas de las reglas visuales del explorador: anidamiento de archivos, iconos e insignias.
 *
 * Son reglas con muchos casos borde (¿qué cuelga de qué?, ¿qué pasa si el padre no existe?) y
 * revisarlas a ojo en una captura no es revisarlas. Aquí sí pueden fallar.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  containerOf,
  ICON_NAMES,
  ICON_SHAPES,
  iconForFile,
  iconForFolder,
  nestFiles,
  nestingParentsOf,
  presentProject,
} from '../../build/ui-lib.mjs';

/** Construye un FileNode mínimo con la forma que espera el explorador. */
function file(name) {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `C:/w/${name}`,
    kind: 'file',
    extension: dot > 0 ? name.slice(dot).toLowerCase() : '',
  };
}

function directory(name) {
  return { name, path: `C:/w/${name}`, kind: 'directory', extension: '', loaded: false, children: [] };
}

describe('nestingParentsOf', () => {
  const cases = [
    ['Home.razor.cs', ['Home.razor']],
    ['Home.razor.css', ['Home.razor']],
    ['Home.razor.js', ['Home.razor']],
    ['Index.cshtml.cs', ['Index.cshtml']],
    ['appsettings.Development.json', ['appsettings.json']],
    ['appsettings.Production.json', ['appsettings.json']],
    ['web.Release.config', ['web.config']],
    ['Form.Designer.cs', ['Form.cs', 'Form.resx']],
    ['Model.g.cs', ['Model.cs', 'Model.resx']],
    ['App.csproj.user', ['App.csproj']],
    ['Directory.Build.targets', ['Directory.Build.props']],
    ['Directory.Packages.props', ['Directory.Build.props']],
    ['package-lock.json', ['package.json']],
    ['app.min.css', ['app.css']],
    ['main.js', ['main.ts']],
  ];

  for (const [child, parents] of cases) {
    it(`${child} → ${parents.join(' | ')}`, () => {
      assert.deepEqual(nestingParentsOf(child), parents);
    });
  }

  it('no anida un archivo normal', () => {
    for (const name of ['Program.cs', 'Home.razor', 'appsettings.json', 'README.md']) {
      assert.deepEqual(nestingParentsOf(name), [], name);
    }
  });

  it('appsettings.json no cuelga de sí mismo', () => {
    assert.deepEqual(nestingParentsOf('appsettings.json'), []);
  });
});

describe('nestFiles', () => {
  it('agrupa los satélites de un componente Blazor', () => {
    const nested = nestFiles([file('Home.razor'), file('Home.razor.cs'), file('Home.razor.css')]);

    assert.equal(nested.length, 1);
    assert.equal(nested[0].node.name, 'Home.razor');
    assert.deepEqual(
      nested[0].children.map((child) => child.name),
      ['Home.razor.cs', 'Home.razor.css'],
    );
  });

  it('agrupa los entornos bajo appsettings.json', () => {
    const nested = nestFiles([
      file('appsettings.json'),
      file('appsettings.Development.json'),
      file('appsettings.Production.json'),
    ]);

    assert.equal(nested.length, 1);
    assert.equal(nested[0].children.length, 2);
  });

  it('si el padre no existe, el archivo NO desaparece del árbol', () => {
    // Regla dura: el anidamiento agrupa, nunca oculta.
    const nested = nestFiles([file('Home.razor.cs')]);

    assert.equal(nested.length, 1);
    assert.equal(nested[0].node.name, 'Home.razor.cs');
    assert.deepEqual(nested[0].children, []);
  });

  it('nunca anida directorios', () => {
    const nested = nestFiles([directory('Components'), file('Home.razor'), file('Home.razor.cs')]);

    assert.equal(nested.length, 2);
    assert.equal(nested[0].node.kind, 'directory');
    assert.deepEqual(nested[0].children, []);
  });

  it('conserva el orden de entrada de los nodos raíz', () => {
    const nested = nestFiles([directory('A'), file('b.cs'), file('c.cs')]);
    assert.deepEqual(
      nested.map((entry) => entry.node.name),
      ['A', 'b.cs', 'c.cs'],
    );
  });

  it('ordena los hijos alfabéticamente', () => {
    const nested = nestFiles([file('Home.razor'), file('Home.razor.css'), file('Home.razor.cs')]);
    assert.deepEqual(
      nested[0].children.map((child) => child.name),
      ['Home.razor.cs', 'Home.razor.css'],
    );
  });

  it('no encadena: un satélite no puede ser padre de otro', () => {
    // Directory.Packages.props cuelga de Directory.Build.props; Directory.Build.targets también.
    // Ninguno debe colgar del otro.
    const nested = nestFiles([
      file('Directory.Build.props'),
      file('Directory.Packages.props'),
      file('Directory.Build.targets'),
    ]);

    assert.equal(nested.length, 1);
    assert.equal(nested[0].node.name, 'Directory.Build.props');
    assert.equal(nested[0].children.length, 2);
  });

  it('no pierde ningún archivo: todo nodo aparece una vez, como raíz o como hijo', () => {
    const input = [
      directory('src'),
      file('Home.razor'),
      file('Home.razor.cs'),
      file('appsettings.json'),
      file('appsettings.Development.json'),
      file('Program.cs'),
      file('huerfano.razor.cs'),
    ];

    const nested = nestFiles(input);
    const seen = nested.flatMap((entry) => [entry.node.name, ...entry.children.map((child) => child.name)]);

    assert.equal(seen.length, input.length);
    assert.deepEqual([...seen].sort(), input.map((node) => node.name).sort());
  });
});

describe('iconForFile', () => {
  const cases = [
    ['Program.cs', 'csharp', 'csharp'],
    ['Home.razor', 'razor', 'razor'],
    ['Index.cshtml', 'razor', 'razor'],
    ['Acme.sln', 'solution', 'project'],
    ['Acme.csproj', 'project', 'project'],
    ['appsettings.json', 'sliders', 'config'],
    ['appsettings.Development.json', 'sliders', 'config'],
    ['Directory.Packages.props', 'package', 'project'],
    ['data.json', 'braces', 'config'],
    ['README.md', 'markdown', 'docs'],
    ['app.css', 'hash', 'style'],
    ['ci.yml', 'list', 'config'],
    ['logo.png', 'image', 'asset'],
    ['.gitignore', 'git-branch', 'muted'],
    ['dotforge.json', 'wand', 'project'],
    ['algo.desconocido', 'file', 'muted'],
  ];

  for (const [name, iconName, tone] of cases) {
    it(`${name} → ${iconName}/${tone}`, () => {
      assert.deepEqual(iconForFile(name), { name: iconName, tone });
    });
  }

  it('no distingue mayúsculas', () => {
    assert.deepEqual(iconForFile('PROGRAM.CS'), iconForFile('program.cs'));
    assert.deepEqual(iconForFile('AppSettings.json'), iconForFile('appsettings.json'));
  });

  it('todos los iconos referenciados existen en el set', () => {
    for (const [name] of cases) {
      assert.ok(ICON_NAMES.includes(iconForFile(name).name), `${name} apunta a un icono inexistente`);
    }
  });
});

describe('iconForFolder', () => {
  it('reconoce las carpetas con significado en .NET', () => {
    const cases = [
      ['Controllers', 'route'],
      ['Models', 'database'],
      ['Services', 'tool'],
      ['Pages', 'pages'],
      ['Components', 'puzzle'],
      ['wwwroot', 'globe'],
      ['Properties', 'sliders'],
      ['Migrations', 'history'],
      ['Domain', 'hexagon'],
      ['Ports', 'plug'],
      ['Commands', 'exchange'],
      ['Events', 'zap'],
    ];

    for (const [folder, expected] of cases) {
      assert.equal(iconForFolder(folder, false).name, expected, folder);
    }
  });

  it('una carpeta con significado conserva su icono al abrirse', () => {
    assert.equal(iconForFolder('Controllers', true).name, 'route');
    assert.equal(iconForFolder('Controllers', false).name, 'route');
  });

  it('una carpeta cualquiera alterna entre carpeta abierta y cerrada', () => {
    assert.equal(iconForFolder('Cualquiera', false).name, 'folder');
    assert.equal(iconForFolder('Cualquiera', true).name, 'folder-open');
  });

  it('no distingue mayúsculas', () => {
    assert.equal(iconForFolder('CONTROLLERS', false).name, 'route');
    assert.equal(iconForFolder('wwwROOT', false).name, 'globe');
  });

  it('todos los iconos de carpeta existen en el set', () => {
    for (const folder of ['Controllers', 'Models', 'Services', 'Pages', 'Cualquiera']) {
      for (const open of [true, false]) {
        assert.ok(ICON_NAMES.includes(iconForFolder(folder, open).name));
      }
    }
  });
});

describe('presentProject', () => {
  const kinds = ['blazor-server', 'blazor-wasm', 'razor-library', 'webapi', 'worker', 'console', 'library', 'tests'];

  it('cubre todos los tipos de proyecto', () => {
    for (const kind of kinds) {
      const presentation = presentProject(kind);
      assert.ok(presentation.badge.length > 0, kind);
      assert.ok(presentation.description.length > 0, kind);
      assert.ok(ICON_NAMES.includes(presentation.icon), `${kind} apunta a un icono inexistente`);
    }
  });

  it('las insignias son cortas: compiten por espacio con el nombre del proyecto', () => {
    for (const kind of kinds) {
      assert.ok(presentProject(kind).badge.length <= 8, `${kind}: "${presentProject(kind).badge}"`);
    }
  });

  it('las insignias son distinguibles entre sí', () => {
    const badges = kinds.map((kind) => presentProject(kind).badge);
    assert.equal(new Set(badges).size, badges.length, badges.join(', '));
  });
});

describe('set de iconos', () => {
  it('tiene un tamaño razonable y sin nombres duplicados', () => {
    assert.ok(ICON_NAMES.length >= 50, `sólo hay ${ICON_NAMES.length} iconos`);
    assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
  });

  it('los nombres son kebab-case', () => {
    for (const name of ICON_NAMES) {
      assert.match(name, /^[a-z][a-z0-9-]*$/, name);
    }
  });
});

describe('geometría de los iconos', () => {
  /**
   * Comandos válidos de una ruta SVG. Un backslash perdido o un carácter de escape mal resuelto
   * mete letras que no están aquí, y el navegador dibuja la nada sin quejarse.
   */
  const PATH_COMMANDS = /^[MmLlHhVvCcSsQqTtAaZz0-9\s.,+-]+$/;

  it('todo icono tiene al menos una figura', () => {
    for (const name of ICON_NAMES) {
      assert.ok(ICON_SHAPES[name].length > 0, `${name} no dibuja nada`);
    }
  });

  it('las rutas sólo contienen comandos SVG válidos', () => {
    for (const name of ICON_NAMES) {
      for (const shape of ICON_SHAPES[name]) {
        const data = shape.p ?? shape.fp;
        if (data === undefined) continue;

        assert.match(data, PATH_COMMANDS, `${name}: ruta con caracteres inválidos -> ${data}`);
        assert.match(data, /^[Mm]/, `${name}: la ruta no empieza con un moveto -> ${data}`);
      }
    }
  });

  it('las coordenadas caben en la rejilla de 24×24 con un margen razonable', () => {
    for (const name of ICON_NAMES) {
      for (const shape of ICON_SHAPES[name]) {
        // Sólo se comprueban las figuras con coordenadas absolutas declaradas.
        if (shape.c) {
          const [cx, cy, r] = shape.c;
          assert.ok(cx - r >= -1 && cx + r <= 25, `${name}: círculo fuera de la rejilla en x`);
          assert.ok(cy - r >= -1 && cy + r <= 25, `${name}: círculo fuera de la rejilla en y`);
        }
        if (shape.r) {
          const [x, y, w, h] = shape.r;
          assert.ok(x >= -1 && x + w <= 25, `${name}: rectángulo fuera de la rejilla en x`);
          assert.ok(y >= -1 && y + h <= 25, `${name}: rectángulo fuera de la rejilla en y`);
        }
      }
    }
  });
});

describe('containerOf', () => {
  it('muestra las dos carpetas contenedoras, recortando el principio', () => {
    assert.equal(containerOf(String.raw`C:\Users\ana\dev\proyectos\Acme.Shop`), String.raw`…\dev\proyectos`);
    assert.equal(containerOf('/home/ana/dev/proyectos/Acme.Shop'), '…/dev/proyectos');
  });

  it('distingue dos soluciones con el mismo nombre en sitios distintos', () => {
    const uno = containerOf(String.raw`C:\Users\ana\AppData\Local\Temp\scratchpad\Acme.Shop`);
    const otro = containerOf(String.raw`C:\Users\ana\AppData\Local\Temp\dfdemo\Acme.Shop`);
    assert.notEqual(uno, otro);
  });

  it('no recorta lo que ya cabe entero', () => {
    assert.equal(containerOf(String.raw`C:\dev\Acme.Shop`), String.raw`C:\dev`);
    assert.equal(containerOf('/dev/Acme.Shop'), 'dev');
  });

  it('devuelve la ruta tal cual cuando no hay carpeta contenedora', () => {
    assert.equal(containerOf('Acme.Shop'), 'Acme.Shop');
  });

  it('tolera separadores repetidos', () => {
    assert.equal(containerOf(String.raw`C:\Users\ana\dev\\proyectos\Acme.Shop`), String.raw`…\dev\proyectos`);
  });
});
