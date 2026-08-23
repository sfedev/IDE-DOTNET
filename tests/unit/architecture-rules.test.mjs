/**
 * Pruebas del linter de reglas de arquitectura.
 *
 * Lo que se comprueba aquí no es C#: es que una capa no vea lo que no debe ver. Por eso las
 * pruebas parten de una solución de mentira con la misma forma que las que genera el IDE, y
 * comprueban las tres vías por las que se rompe una arquitectura en la práctica: una referencia
 * de proyecto, un `using` escrito a mano y un paquete NuGet en el núcleo.
 *
 * La regla más importante de todas está también probada: **ante la duda, callar**. Un proyecto sin
 * clasificar o una solución cuya arquitectura no se reconoce no producen ni un aviso, porque un
 * linter que denuncia lo que no entiende se desactiva el primer día.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkPackages,
  checkProjectReferences,
  checkSolution,
  checkUsings,
  isDependencyAllowed,
  isInfrastructurePackage,
  layerOfProject,
  projectOfFile,
  readUsings,
} from '../../build/ui-lib.mjs';

/** Proyecto mínimo con la forma que devuelve el parser de `.csproj`. */
function project(name, options = {}) {
  return {
    kind: 'library',
    name,
    path: `C:/src/Acme.Shop/src/${name}/${name}.csproj`,
    directory: `C:/src/Acme.Shop/src/${name}`,
    targetFrameworks: ['net9.0'],
    sdk: 'Microsoft.NET.Sdk',
    outputType: null,
    isTestProject: false,
    isWebProject: false,
    projectReferences: (options.references ?? []).map((reference) => ({
      name: reference,
      path: `C:/src/Acme.Shop/src/${reference}/${reference}.csproj`,
    })),
    packageReferences: (options.packages ?? []).map((id) => ({ id, version: '9.0.0', centrallyManaged: true })),
    solutionFolder: null,
  };
}

function solution(projects) {
  return {
    name: 'Acme.Shop',
    path: 'C:/src/Acme.Shop/Acme.Shop.sln',
    directory: 'C:/src/Acme.Shop',
    format: 'sln',
    projects,
    generatedBy: null,
    warnings: [],
  };
}

const CLEAN = solution([
  project('Acme.Shop.Domain'),
  project('Acme.Shop.Application', { references: ['Acme.Shop.Domain'] }),
  project('Acme.Shop.Infrastructure', { references: ['Acme.Shop.Domain', 'Acme.Shop.Application'] }),
  project('Acme.Shop.WebApi', { references: ['Acme.Shop.Application', 'Acme.Shop.Infrastructure'] }),
]);

describe('clasificación por capas', () => {
  it('reconoce las capas por el nombre del proyecto', () => {
    assert.equal(layerOfProject('Acme.Shop.Domain'), 'domain');
    assert.equal(layerOfProject('Acme.Shop.Application'), 'application');
    assert.equal(layerOfProject('Acme.Shop.Infrastructure'), 'infrastructure');
    assert.equal(layerOfProject('Acme.Shop.WebApi'), 'presentation');
    assert.equal(layerOfProject('Acme.Shop.Blazor'), 'presentation');
    assert.equal(layerOfProject('Acme.Billing.SharedKernel'), 'shared-kernel');
    assert.equal(layerOfProject('Acme.Ports'), 'ports');
    assert.equal(layerOfProject('Acme.Adapters.Persistence'), 'adapters');
  });

  it('un proyecto de pruebas es de pruebas aunque se llame como una capa', () => {
    assert.equal(layerOfProject('Acme.Shop.Domain.UnitTests'), 'tests');
    assert.equal(layerOfProject('Acme.Shop.IntegrationTests'), 'tests');
  });

  it('lo que no encaja se queda sin clasificar, no se adivina', () => {
    assert.equal(layerOfProject('Acme.Shop.Utilidades'), 'unknown');
  });
});

describe('reglas de dependencia', () => {
  it('en Clean, el dominio no ve la infraestructura ni la aplicación', () => {
    assert.equal(isDependencyAllowed('clean', 'domain', 'infrastructure'), false);
    assert.equal(isDependencyAllowed('clean', 'domain', 'application'), false);
    assert.equal(isDependencyAllowed('clean', 'domain', 'shared-kernel'), true);
  });

  it('en Clean, la aplicación no ve la infraestructura', () => {
    assert.equal(isDependencyAllowed('clean', 'application', 'infrastructure'), false);
    assert.equal(isDependencyAllowed('clean', 'application', 'domain'), true);
  });

  it('la presentación sí ve la infraestructura: es la raíz de composición', () => {
    assert.equal(isDependencyAllowed('clean', 'presentation', 'infrastructure'), true);
    assert.equal(isDependencyAllowed('ddd', 'presentation', 'infrastructure'), true);
  });

  it('en hexagonal, el núcleo no ve los adaptadores', () => {
    assert.equal(isDependencyAllowed('hexagonal', 'domain', 'adapters'), false);
    assert.equal(isDependencyAllowed('hexagonal', 'ports', 'adapters'), false);
    assert.equal(isDependencyAllowed('hexagonal', 'adapters', 'ports'), true);
  });

  it('ante la duda, se permite', () => {
    assert.equal(isDependencyAllowed('unknown', 'domain', 'infrastructure'), true);
    assert.equal(isDependencyAllowed('clean', 'unknown', 'infrastructure'), true);
    assert.equal(isDependencyAllowed('clean', 'tests', 'infrastructure'), true);
  });
});

describe('referencias de proyecto', () => {
  it('una solución correcta no produce avisos', () => {
    assert.deepEqual(checkProjectReferences(CLEAN), []);
  });

  it('detecta el dominio referenciando la infraestructura', () => {
    const broken = solution([
      project('Acme.Shop.Domain', { references: ['Acme.Shop.Infrastructure'] }),
      project('Acme.Shop.Application', { references: ['Acme.Shop.Domain'] }),
      project('Acme.Shop.Infrastructure', { references: ['Acme.Shop.Domain'] }),
    ]);

    const [violation] = checkProjectReferences(broken);
    assert.equal(violation.code, 'DF1001');
    assert.equal(violation.project, 'Acme.Shop.Domain');
    assert.equal(violation.severity, 'warning');
    assert.ok(violation.message.includes('Acme.Shop.Infrastructure'));
    assert.ok(violation.file.endsWith('Acme.Shop.Domain.csproj'));
  });

  it('detecta la aplicación referenciando la infraestructura', () => {
    const broken = solution([
      project('Acme.Shop.Domain'),
      project('Acme.Shop.Application', { references: ['Acme.Shop.Domain', 'Acme.Shop.Infrastructure'] }),
      project('Acme.Shop.Infrastructure', { references: ['Acme.Shop.Domain'] }),
    ]);

    assert.equal(checkProjectReferences(broken).length, 1);
  });

  it('sin arquitectura reconocible no se dice nada', () => {
    const vague = solution([
      project('Acme.Utilidades', { references: ['Acme.Cosas'] }),
      project('Acme.Cosas'),
    ]);

    assert.deepEqual(checkProjectReferences(vague), []);
    assert.deepEqual(checkSolution(null), []);
  });
});

describe('paquetes del núcleo', () => {
  it('reconoce los paquetes de infraestructura por prefijo', () => {
    assert.equal(isInfrastructurePackage('Microsoft.EntityFrameworkCore.SqlServer'), true);
    assert.equal(isInfrastructurePackage('Microsoft.AspNetCore.Authentication.JwtBearer'), true);
    assert.equal(isInfrastructurePackage('FluentValidation'), false);
    assert.equal(isInfrastructurePackage('Acme.EntityFrameworkCore.Utilidades'), false);
  });

  it('avisa de EF Core dentro del dominio', () => {
    const broken = solution([
      project('Acme.Shop.Domain', { packages: ['Microsoft.EntityFrameworkCore'] }),
      project('Acme.Shop.Application', { references: ['Acme.Shop.Domain'] }),
      project('Acme.Shop.Infrastructure', { references: ['Acme.Shop.Domain'] }),
    ]);

    const [violation] = checkPackages(broken);
    assert.equal(violation.code, 'DF1003');
    assert.ok(violation.message.includes('Microsoft.EntityFrameworkCore'));
  });

  it('el mismo paquete en la infraestructura es correcto', () => {
    const fine = solution([
      project('Acme.Shop.Domain'),
      project('Acme.Shop.Application', { references: ['Acme.Shop.Domain'] }),
      project('Acme.Shop.Infrastructure', {
        references: ['Acme.Shop.Domain'],
        packages: ['Microsoft.EntityFrameworkCore.Sqlite'],
      }),
    ]);

    assert.deepEqual(checkPackages(fine), []);
  });
});

describe('using dentro de un archivo', () => {
  it('lee todas las formas de using con su línea', () => {
    const usings = readUsings(
      ['using System;', 'global using Acme.Shop.Domain;', 'using static System.Math;', 'using Alias = Acme.Shop.Application.Products;', 'namespace Acme.Shop.Domain;'].join('\n'),
    );

    assert.deepEqual(usings.map((entry) => entry.namespace), [
      'System',
      'Acme.Shop.Domain',
      'System.Math',
      'Acme.Shop.Application.Products',
    ]);
    assert.equal(usings[1].line, 2);
  });

  it('detecta un using prohibido y apunta a su línea', () => {
    const file = 'C:/src/Acme.Shop/src/Acme.Shop.Domain/Products/Product.cs';
    const source = ['using System;', 'using Acme.Shop.Infrastructure.Persistence;', '', 'public class Product { }'].join('\n');

    const [violation] = checkUsings(CLEAN, file, source);
    assert.equal(violation.code, 'DF1002');
    assert.equal(violation.line, 2);
    assert.equal(violation.project, 'Acme.Shop.Domain');
  });

  it('un using de la propia capa o del sistema no molesta', () => {
    const file = 'C:/src/Acme.Shop/src/Acme.Shop.Application/Products/ProductService.cs';
    const source = ['using System.Linq;', 'using Acme.Shop.Domain.Products;', 'using Acme.Shop.Application.Common;'].join('\n');

    assert.deepEqual(checkUsings(CLEAN, file, source), []);
  });

  it('un archivo fuera de todo proyecto no produce avisos', () => {
    assert.deepEqual(checkUsings(CLEAN, 'C:/otro/sitio/Program.cs', 'using Acme.Shop.Infrastructure;'), []);
  });

  it('atribuye el archivo al proyecto de directorio más largo', () => {
    const owner = projectOfFile(CLEAN, 'C:/src/Acme.Shop/src/Acme.Shop.WebApi/Program.cs');
    assert.equal(owner.name, 'Acme.Shop.WebApi');
  });
});
