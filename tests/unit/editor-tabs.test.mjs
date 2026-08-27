/**
 * Pruebas de la organización visual de las pestañas.
 *
 * Lo que se vigila son los tres casos que hacen que una función así funcione en el equipo de quien
 * la escribe y falle en el de al lado:
 *
 *  - **Proyectos anidados.** `src/Acme.Api` y `src/Acme.Api/Extras` conviven más de lo que parece.
 *    Quedarse con el primer directorio que encaje mete los archivos del interior en el exterior.
 *  - **Prefijos textuales que no son prefijos de ruta.** `src/Acme.Api` es prefijo textual de
 *    `src/Acme.ApiTests/Program.cs`, que es otro proyecto.
 *  - **Mayúsculas.** En Windows la misma carpeta llega escrita de dos formas según de dónde venga,
 *    y comparando tal cual el archivo se queda sin proyecto sin que nada falle.
 *
 * Y una regla de producto que también es una regla con estado: **el color de un proyecto no puede
 * cambiar** porque se añada otro. Si cambiara, el código de colores que uno tenía memorizado
 * cambiaría entero al crear un proyecto de pruebas.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignColors,
  coerceTabPosition,
  coerceTabSettings,
  colorForProject,
  DEFAULT_TAB_POSITION,
  DEFAULT_TAB_SETTINGS,
  decorateTab,
  MAX_REMEMBERED_COLORS,
  projectForFile,
  pruneColors,
  TAB_COLOR_COUNT,
  TAB_POSITIONS,
  TAB_POSITION_INFO,
} from '../../build/ui-lib.mjs';

const PROJECTS = [
  { name: 'Acme.Domain', directory: 'C:/sln/src/Acme.Domain' },
  { name: 'Acme.Api', directory: 'C:/sln/src/Acme.Api' },
  { name: 'Acme.ApiTests', directory: 'C:/sln/src/Acme.ApiTests' },
];

describe('a qué proyecto pertenece un archivo', () => {
  it('el que contiene su carpeta', () => {
    assert.equal(projectForFile('C:/sln/src/Acme.Api/Program.cs', PROJECTS)?.name, 'Acme.Api');
    assert.equal(projectForFile('C:/sln/src/Acme.Domain/Entities/Product.cs', PROJECTS)?.name, 'Acme.Domain');
  });

  it('un prefijo textual no es un prefijo de ruta', () => {
    // `C:/sln/src/Acme.Api` es prefijo de texto de `C:/sln/src/Acme.ApiTests/...`, y no lo contiene.
    assert.equal(projectForFile('C:/sln/src/Acme.ApiTests/ProductTests.cs', PROJECTS)?.name, 'Acme.ApiTests');
  });

  it('con proyectos anidados gana el más profundo, no el primero que encaje', () => {
    const nested = [
      { name: 'Acme.Api', directory: 'C:/sln/src/Acme.Api' },
      { name: 'Acme.Api.Extras', directory: 'C:/sln/src/Acme.Api/Extras' },
    ];

    assert.equal(projectForFile('C:/sln/src/Acme.Api/Extras/Helper.cs', nested)?.name, 'Acme.Api.Extras');
    assert.equal(projectForFile('C:/sln/src/Acme.Api/Program.cs', nested)?.name, 'Acme.Api');
  });

  it('el orden en el que llegan los proyectos no cambia el resultado', () => {
    const reversed = [
      { name: 'Acme.Api.Extras', directory: 'C:/sln/src/Acme.Api/Extras' },
      { name: 'Acme.Api', directory: 'C:/sln/src/Acme.Api' },
    ];

    assert.equal(projectForFile('C:/sln/src/Acme.Api/Extras/Helper.cs', reversed)?.name, 'Acme.Api.Extras');
  });

  it('barras mezcladas y mayúsculas distintas siguen encajando', () => {
    assert.equal(projectForFile('C:\\SLN\\src\\Acme.Api\\Program.cs', PROJECTS)?.name, 'Acme.Api');
    assert.equal(projectForFile('c:/sln/src/acme.api/Program.cs', PROJECTS)?.name, 'Acme.Api');
  });

  it('una carpeta de proyecto con barra al final sigue encajando', () => {
    const trailing = [{ name: 'Acme.Api', directory: 'C:/sln/src/Acme.Api/' }];
    assert.equal(projectForFile('C:/sln/src/Acme.Api/Program.cs', trailing)?.name, 'Acme.Api');
  });

  it('un archivo fuera de todo proyecto no pertenece a ninguno', () => {
    assert.equal(projectForFile('C:/sln/README.md', PROJECTS), null);
    assert.equal(projectForFile('C:/otro/Program.cs', PROJECTS), null);
  });

  it('sin proyectos no se inventa ninguno', () => {
    assert.equal(projectForFile('C:/sln/src/Acme.Api/Program.cs', []), null);
  });

  it('un proyecto con directorio vacío se ignora en vez de tragarse todo', () => {
    assert.equal(projectForFile('C:/sln/README.md', [{ name: 'Raro', directory: '' }]), null);
  });
});

describe('asignación de colores', () => {
  it('el primer proyecto se lleva el color 0', () => {
    const result = colorForProject('Acme.Api', {});

    assert.equal(result.index, 0);
    assert.equal(result.assigned, true);
    assert.deepEqual(result.colors, { 'Acme.Api': 0 });
  });

  it('un proyecto que ya tenía color conserva el suyo y no muta nada', () => {
    const colors = { 'Acme.Api': 3 };
    const result = colorForProject('Acme.Api', colors);

    assert.equal(result.index, 3);
    assert.equal(result.assigned, false);
    assert.equal(result.colors, colors);
  });

  it('se ocupa el hueco libre más bajo, no el siguiente del contador', () => {
    // Se han cerrado los proyectos 0 y 2: los siguientes vuelven a ocuparlos.
    assert.equal(colorForProject('Nuevo', { A: 1, B: 3 }).index, 0);
    assert.equal(colorForProject('Nuevo', { A: 0, B: 1, C: 3 }).index, 2);
  });

  it('añadir un proyecto no recolorea los que ya estaban', () => {
    let colors = assignColors(['Acme.Domain', 'Acme.Api'], {});
    const before = { ...colors };

    colors = assignColors(['Acme.Domain', 'Acme.Api', 'Acme.Tests'], colors);

    assert.equal(colors['Acme.Domain'], before['Acme.Domain']);
    assert.equal(colors['Acme.Api'], before['Acme.Api']);
    assert.equal(typeof colors['Acme.Tests'], 'number');
  });

  it('una solución la reparte en el orden en el que están declarados sus proyectos', () => {
    const colors = assignColors(['A', 'B', 'C'], {});
    assert.deepEqual(colors, { A: 0, B: 1, C: 2 });
  });

  it('con los ocho colores ocupados se sigue repartiendo, no se deja sin marca', () => {
    const full = {};
    for (let index = 0; index < TAB_COLOR_COUNT; index++) full[`P${index}`] = index;

    const result = colorForProject('Extra', full);
    assert.ok(result.index >= 0 && result.index < TAB_COLOR_COUNT);
  });

  it('un color guardado fuera de rango se trata como si no estuviera', () => {
    assert.equal(colorForProject('Acme.Api', { 'Acme.Api': 99 }).assigned, true);
    assert.equal(colorForProject('Acme.Api', { 'Acme.Api': -1 }).assigned, true);
  });

  it('un nombre vacío no ocupa color', () => {
    assert.deepEqual(assignColors(['', '   '], {}), {});
  });
});

describe('poda de colores', () => {
  it('por debajo del tope no se toca nada: cerrar una solución no borra sus colores', () => {
    const colors = { A: 0, B: 1 };
    assert.equal(pruneColors(colors, []), colors);
  });

  it('por encima del tope se conserva sólo lo que se pide conservar', () => {
    const colors = {};
    for (let index = 0; index <= MAX_REMEMBERED_COLORS; index++) colors[`P${index}`] = index % TAB_COLOR_COUNT;

    const pruned = pruneColors(colors, ['P1', 'P2']);
    assert.deepEqual(Object.keys(pruned).sort(), ['P1', 'P2']);
  });
});

describe('posición de la tira', () => {
  it('los tres valores y ninguno más', () => {
    assert.deepEqual([...TAB_POSITIONS], ['top', 'left', 'right']);
    assert.deepEqual(TAB_POSITION_INFO.map((entry) => entry.id), [...TAB_POSITIONS]);
  });

  it('lo desconocido vuelve a la de siempre', () => {
    assert.equal(coerceTabPosition('bottom'), DEFAULT_TAB_POSITION);
    assert.equal(coerceTabPosition(3), DEFAULT_TAB_POSITION);
    assert.equal(coerceTabPosition(undefined), 'top');
  });

  it('lo conocido se respeta', () => {
    assert.equal(coerceTabPosition('left'), 'left');
    assert.equal(coerceTabPosition('right'), 'right');
  });
});

describe('saneado de las preferencias', () => {
  it('lo que no es un objeto devuelve los valores por defecto', () => {
    assert.deepEqual(coerceTabSettings(null), DEFAULT_TAB_SETTINGS);
    assert.deepEqual(coerceTabSettings('left'), DEFAULT_TAB_SETTINGS);
  });

  it('descarta los colores que no son índices válidos', () => {
    const settings = coerceTabSettings({
      colors: { A: 0, B: 'rojo', C: 99, D: -1, E: 1.5, F: 7 },
    });

    assert.deepEqual(settings.colors, { A: 0, F: 7 });
  });

  it('descarta las claves imposibles sin tirar el resto', () => {
    const settings = coerceTabSettings({ colors: { '': 0, '   ': 1, Bueno: 2 } });
    assert.deepEqual(settings.colors, { Bueno: 2 });
  });

  it('acota cuántos colores se leen del disco', () => {
    const colors = {};
    for (let index = 0; index < MAX_REMEMBERED_COLORS + 50; index++) colors[`P${index}`] = index % TAB_COLOR_COUNT;

    assert.ok(Object.keys(coerceTabSettings({ colors }).colors).length <= MAX_REMEMBERED_COLORS);
  });

  it('las banderas sólo se aceptan si son booleanas', () => {
    assert.equal(coerceTabSettings({ colorize: 'sí' }).colorize, DEFAULT_TAB_SETTINGS.colorize);
    assert.equal(coerceTabSettings({ colorize: false }).colorize, false);
    assert.equal(coerceTabSettings({ showProjectName: true }).showProjectName, true);
  });
});

describe('decoración de una pestaña', () => {
  const settings = { ...DEFAULT_TAB_SETTINGS, colors: { 'Acme.Api': 2, 'Acme.Domain': 0 } };

  it('la clase sale del índice guardado, empezando en 1', () => {
    const decoration = decorateTab('C:/sln/src/Acme.Api/Program.cs', 'Program.cs', PROJECTS, settings);
    assert.equal(decoration.colorClass, 'tab-project-3');
  });

  it('el tooltip nombra el proyecto y conserva la ruta entera', () => {
    const decoration = decorateTab('C:/sln/src/Acme.Api/Program.cs', 'Program.cs', PROJECTS, settings);

    assert.match(decoration.tooltip, /Program\.cs — Acme\.Api/);
    assert.match(decoration.tooltip, /C:\/sln\/src\/Acme\.Api\/Program\.cs/);
  });

  it('con el coloreado apagado no hay clase, pero el tooltip sigue diciendo el proyecto', () => {
    const off = { ...settings, colorize: false };
    const decoration = decorateTab('C:/sln/src/Acme.Api/Program.cs', 'Program.cs', PROJECTS, off);

    assert.equal(decoration.colorClass, null);
    assert.match(decoration.tooltip, /Acme\.Api/);
  });

  it('el nombre en la pestaña sólo aparece si se pide', () => {
    assert.equal(decorateTab('C:/sln/src/Acme.Api/Program.cs', 'Program.cs', PROJECTS, settings).projectLabel, null);

    const named = { ...settings, showProjectName: true };
    assert.equal(
      decorateTab('C:/sln/src/Acme.Api/Program.cs', 'Program.cs', PROJECTS, named).projectLabel,
      'Acme.Api',
    );
  });

  it('un archivo sin proyecto no lleva marca ni nombre inventado', () => {
    const decoration = decorateTab('C:/sln/README.md', 'README.md', PROJECTS, {
      ...settings,
      showProjectName: true,
    });

    assert.equal(decoration.colorClass, null);
    assert.equal(decoration.projectLabel, null);
    assert.equal(decoration.tooltip, 'C:/sln/README.md');
  });

  it('un proyecto sin color guardado recibe uno y la clase sigue siendo válida', () => {
    const decoration = decorateTab(
      'C:/sln/src/Acme.ApiTests/ProductTests.cs',
      'ProductTests.cs',
      PROJECTS,
      settings,
    );

    assert.match(decoration.colorClass, /^tab-project-[1-8]$/);
  });
});
