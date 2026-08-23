/** Pruebas del emisor de .sln. Un .sln mal formado rompe Visual Studio y Rider en silencio. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deterministicGuid, renderSolutionFile } from '../../build/scaffold.mjs';

const projects = [
  {
    name: 'Acme.Shop.Domain',
    path: 'src/Acme.Shop.Domain/Acme.Shop.Domain.csproj',
    layer: 'Domain',
    solutionFolder: '1-Domain',
    guid: deterministicGuid('Acme.Shop::Acme.Shop.Domain'),
  },
  {
    name: 'Acme.Shop.WebApi',
    path: 'src/Acme.Shop.WebApi/Acme.Shop.WebApi.csproj',
    layer: 'Presentación',
    solutionFolder: '4-Presentation',
    guid: deterministicGuid('Acme.Shop::Acme.Shop.WebApi'),
  },
];

const sln = renderSolutionFile('Acme.Shop', projects);

describe('renderSolutionFile', () => {
  it('emite la cabecera de formato 12.00', () => {
    assert.ok(sln.startsWith('Microsoft Visual Studio Solution File, Format Version 12.00'));
  });

  it('usa CRLF, como esperan las herramientas de Windows', () => {
    assert.ok(sln.includes('\r\n'));
    assert.equal(/[^\r]\n/.test(sln), false, 'hay saltos LF sueltos');
  });

  it('declara cada proyecto con el GUID de tipo C# SDK-style', () => {
    for (const project of projects) {
      assert.ok(
        sln.includes(`Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "${project.name}"`),
        `falta el proyecto ${project.name}`,
      );
    }
  });

  it('convierte las rutas a separador de Windows', () => {
    assert.ok(sln.includes('src\\Acme.Shop.Domain\\Acme.Shop.Domain.csproj'));
    assert.equal(sln.includes('src/Acme.Shop.Domain'), false);
  });

  it('crea una carpeta de solución por cada grupo declarado', () => {
    assert.ok(sln.includes('") = "1-Domain", "1-Domain"'));
    assert.ok(sln.includes('") = "4-Presentation", "4-Presentation"'));
  });

  it('anida cada proyecto en su carpeta', () => {
    const nested = sln.slice(sln.indexOf('GlobalSection(NestedProjects)'));
    for (const project of projects) {
      assert.ok(nested.includes(`{${project.guid}} = {`), `${project.name} no está anidado`);
    }
  });

  it('declara Debug y Release para cada proyecto, con ActiveCfg y Build', () => {
    for (const project of projects) {
      for (const configuration of ['Debug', 'Release']) {
        assert.ok(sln.includes(`{${project.guid}}.${configuration}|Any CPU.ActiveCfg`));
        assert.ok(sln.includes(`{${project.guid}}.${configuration}|Any CPU.Build.0`));
      }
    }
  });

  it('abre y cierra Global correctamente', () => {
    assert.ok(sln.includes('\r\nGlobal\r\n'));
    assert.ok(sln.trimEnd().endsWith('EndGlobal'));
    const abiertas = (sln.match(/GlobalSection\(/g) ?? []).length;
    const cerradas = (sln.match(/EndGlobalSection/g) ?? []).length;
    assert.equal(abiertas, cerradas);
  });

  it('empareja cada Project con su EndProject', () => {
    const abiertos = (sln.match(/^Project\(/gm) ?? []).length;
    const cerrados = (sln.match(/^EndProject$/gm) ?? []).length;
    assert.equal(abiertos, cerrados);
    assert.equal(abiertos, projects.length + 2); // 2 carpetas de solución
  });

  it('es reproducible: dos generaciones idénticas dan el mismo archivo', () => {
    assert.equal(renderSolutionFile('Acme.Shop', projects), sln);
  });

  it('omite la sección de anidamiento si no hay carpetas', () => {
    const plano = renderSolutionFile('X', []);
    assert.equal(plano.includes('NestedProjects'), false);
    assert.ok(plano.includes('EndGlobal'));
  });
});
