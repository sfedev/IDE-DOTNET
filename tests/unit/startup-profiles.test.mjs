/**
 * Pruebas del modelo de perfiles de inicio.
 *
 * Es la lógica que decide qué arranca el botón de Play y con qué depurador, así que se prueba
 * aparte de la interfaz: un fallo aquí es "he pulsado Play y ha arrancado el proyecto que no era".
 *
 * La solución de ejemplo se genera con el propio scaffolder, no se escribe a mano: así estas
 * pruebas también verifican que lo que produce el generador se clasifica bien.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSolution } from '../../build/scaffold.mjs';
import {
  availableProfiles,
  coerceStartupConfig,
  DEFAULT_STARTUP_CONFIG,
  implicitProfile,
  isRunnableProject,
  launchPlan,
  loadSolution,
  nextProfileId,
  resolveActiveProfile,
  runnableProjects,
  shortProjectName,
  suggestProfileName,
} from '../../build/main-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = join(root, 'build');

/** Proyecto mínimo con la forma que declara ProjectInfo. */
function project(overrides) {
  return {
    kind: 'library',
    name: 'Acme.Lib',
    path: 'C:/s/Acme.Lib/Acme.Lib.csproj',
    directory: 'C:/s/Acme.Lib',
    targetFrameworks: ['net9.0'],
    sdk: 'Microsoft.NET.Sdk',
    outputType: null,
    isTestProject: false,
    isWebProject: false,
    projectReferences: [],
    packageReferences: [],
    solutionFolder: null,
    ...overrides,
  };
}

const web = project({ kind: 'webapi', name: 'Acme.WebApi', path: 'C:/s/Api/Acme.WebApi.csproj', isWebProject: true });
const blazor = project({ kind: 'blazor-server', name: 'Acme.Blazor', path: 'C:/s/Ui/Acme.Blazor.csproj', isWebProject: true });
const console_ = project({ kind: 'console', name: 'Acme.Cli', path: 'C:/s/Cli/Acme.Cli.csproj', outputType: 'Exe' });
const library = project({ name: 'Acme.Domain', path: 'C:/s/Dom/Acme.Domain.csproj' });
const tests = project({ kind: 'tests', name: 'Acme.Tests', path: 'C:/s/T/Acme.Tests.csproj', outputType: 'Exe', isTestProject: true });

const solution = {
  name: 'Acme',
  path: 'C:/s/Acme.sln',
  directory: 'C:/s',
  format: 'sln',
  projects: [library, web, blazor, console_, tests],
  generatedBy: null,
  warnings: [],
};

describe('qué proyecto es ejecutable', () => {
  it('lo son las webs y los ejecutables de consola', () => {
    assert.equal(isRunnableProject(web), true);
    assert.equal(isRunnableProject(blazor), true);
    assert.equal(isRunnableProject(console_), true);
  });

  it('no lo son las bibliotecas', () => {
    assert.equal(isRunnableProject(library), false);
  });

  it('no lo son los proyectos de pruebas, aunque su salida sea un .exe', () => {
    // Un proyecto de pruebas se ejecuta con `dotnet test`, no arrancándolo.
    assert.equal(isRunnableProject(tests), false);
  });

  it('runnableProjects conserva el orden de la solución', () => {
    assert.deepEqual(
      runnableProjects(solution).map((entry) => entry.name),
      ['Acme.WebApi', 'Acme.Blazor', 'Acme.Cli'],
    );
    assert.deepEqual(runnableProjects(null), []);
  });
});

describe('nombres', () => {
  it('quita el prefijo de la solución', () => {
    assert.equal(shortProjectName('Acme.Shop.Adapters.Web', 'Acme.Shop'), 'Adapters.Web');
  });

  it('no recorta si el nombre es exactamente el de la solución', () => {
    assert.equal(shortProjectName('Acme.Shop', 'Acme.Shop'), 'Acme.Shop');
  });

  it('sin solución, deja el nombre tal cual', () => {
    assert.equal(shortProjectName('Acme.WebApi', null), 'Acme.WebApi');
  });

  it('propone un nombre de perfil legible', () => {
    assert.equal(suggestProfileName([web, blazor], 'Acme'), 'WebApi + Blazor');
    assert.equal(suggestProfileName([], 'Acme'), 'Perfil sin proyectos');
  });
});

describe('perfil activo', () => {
  it('sin nada guardado, prefiere un proyecto web', () => {
    const active = resolveActiveProfile(DEFAULT_STARTUP_CONFIG, solution);
    assert.equal(active.name, 'Acme.WebApi');
    assert.equal(active.implicit, true);
  });

  it('respeta el perfil guardado', () => {
    const config = { profiles: [], activeProfileId: `project:${console_.path}`, mode: 'debug' };
    assert.equal(resolveActiveProfile(config, solution).name, 'Acme.Cli');
  });

  it('si el perfil guardado ya no existe, no deja el Play sin destino', () => {
    const config = { profiles: [], activeProfileId: 'project:C:/borrado/Fantasma.csproj', mode: 'debug' };
    const active = resolveActiveProfile(config, solution);
    assert.ok(active !== null);
    assert.equal(active.name, 'Acme.WebApi');
  });

  it('sin proyectos ejecutables, devuelve null', () => {
    const soloLibrerias = { ...solution, projects: [library, tests] };
    assert.equal(resolveActiveProfile(DEFAULT_STARTUP_CONFIG, soloLibrerias), null);
  });

  it('los perfiles del usuario se listan antes que los implícitos', () => {
    const config = {
      profiles: [{ id: 'custom:1', name: 'Backend + Web', projects: [web.path, blazor.path], implicit: false }],
      activeProfileId: 'custom:1',
      mode: 'debug',
    };

    const all = availableProfiles(config, solution);
    assert.equal(all[0].name, 'Backend + Web');
    assert.equal(all[0].implicit, false);
    assert.equal(all.length, 4, 'un perfil propio + tres proyectos ejecutables');
  });
});

describe('plan de arranque', () => {
  const perfil = {
    id: 'custom:1',
    name: 'Backend + Web',
    projects: [web.path, blazor.path, console_.path],
    implicit: false,
  };

  it('en depuración sólo el primero se engancha al depurador', () => {
    // Hay una única sesión de NetCoreDbg: los demás arrancan sin él (ADR-012).
    const plan = launchPlan(perfil, solution, 'debug');
    assert.deepEqual(
      plan.map((step) => step.action),
      ['debug', 'run', 'run'],
    );
    assert.equal(plan[0].projectName, 'Acme.WebApi');
  });

  it('sin depurador, las webs usan Hot Reload y las consolas no', () => {
    assert.deepEqual(
      launchPlan(perfil, solution, 'run').map((step) => step.action),
      ['watch', 'watch', 'run'],
    );
  });

  it('conserva el orden declarado en el perfil', () => {
    const invertido = { ...perfil, projects: [console_.path, web.path] };
    assert.deepEqual(
      launchPlan(invertido, solution, 'run').map((step) => step.projectName),
      ['Acme.Cli', 'Acme.WebApi'],
    );
  });

  it('ignora los proyectos que ya no están en la solución en vez de romper el arranque', () => {
    const conFantasma = { ...perfil, projects: ['C:/borrado/Fantasma.csproj', web.path] };
    const plan = launchPlan(conFantasma, solution, 'debug');
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, 'debug', 'el primero real es el que se depura');
  });

  it('sin perfil no hay plan', () => {
    assert.deepEqual(launchPlan(null, solution, 'debug'), []);
  });
});

describe('identificadores de perfil', () => {
  it('el implícito se deriva de la ruta del proyecto', () => {
    assert.equal(implicitProfile(web).id, `project:${web.path}`);
  });

  it('nextProfileId no reutiliza uno existente y es determinista', () => {
    assert.equal(nextProfileId([]), 'custom:1');
    assert.equal(nextProfileId([{ id: 'custom:1', name: 'x', projects: ['a'], implicit: false }]), 'custom:2');
    assert.equal(
      nextProfileId([
        { id: 'custom:1', name: 'x', projects: ['a'], implicit: false },
        { id: 'custom:2', name: 'y', projects: ['b'], implicit: false },
      ]),
      'custom:3',
    );
  });
});

describe('validación de lo que viene del disco', () => {
  it('un archivo corrupto no rompe nada', () => {
    assert.deepEqual(coerceStartupConfig(null), { profiles: [], activeProfileId: null, mode: 'debug' });
    assert.deepEqual(coerceStartupConfig('texto'), { profiles: [], activeProfileId: null, mode: 'debug' });
    assert.deepEqual(coerceStartupConfig({ profiles: 'no es una lista' }).profiles, []);
  });

  it('descarta perfiles sin nombre, sin id o sin proyectos', () => {
    const config = coerceStartupConfig({
      profiles: [
        { id: '', name: 'sin id', projects: ['a'] },
        { id: 'custom:1', name: '   ', projects: ['a'] },
        { id: 'custom:2', name: 'vacío', projects: [] },
        { id: 'custom:3', name: 'bueno', projects: ['a', 'b'] },
      ],
    });

    assert.equal(config.profiles.length, 1);
    assert.equal(config.profiles[0].name, 'bueno');
  });

  it('no admite dos perfiles con el mismo id', () => {
    const config = coerceStartupConfig({
      profiles: [
        { id: 'custom:1', name: 'primero', projects: ['a'] },
        { id: 'custom:1', name: 'duplicado', projects: ['b'] },
      ],
    });

    assert.equal(config.profiles.length, 1);
    assert.equal(config.profiles[0].name, 'primero');
  });

  it('sólo acepta modos conocidos', () => {
    assert.equal(coerceStartupConfig({ mode: 'run' }).mode, 'run');
    assert.equal(coerceStartupConfig({ mode: 'turbo' }).mode, 'debug');
  });

  it('limpia los proyectos que ya no existen y descarta el perfil que se queda vacío', () => {
    const config = coerceStartupConfig(
      {
        profiles: [
          { id: 'custom:1', name: 'mixto', projects: ['vivo.csproj', 'muerto.csproj'] },
          { id: 'custom:2', name: 'fantasma', projects: ['muerto.csproj'] },
        ],
      },
      ['vivo.csproj'],
    );

    assert.equal(config.profiles.length, 1);
    assert.deepEqual(config.profiles[0].projects, ['vivo.csproj']);
  });
});

describe('sobre una solución generada de verdad', () => {
  let workspace;
  let generated;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'dfsp-'));
    const result = await generateSolution(
      {
        architecture: 'hexagonal',
        solutionName: 'Sp',
        outputDir: workspace,
        ui: 'both',
        framework: 'net9.0',
        db: 'inmemory',
        entity: 'Product',
        includeTests: true,
        force: true,
        gitInit: false,
      },
      buildDir,
    );
    generated = await loadSolution(result.rootDir);
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('detecta exactamente los dos adaptadores conductores como ejecutables', () => {
    const names = runnableProjects(generated).map((entry) => entry.name);
    assert.deepEqual(names.sort(), ['Sp.Adapters.Blazor', 'Sp.Adapters.Web']);
  });

  it('deja fuera el proyecto de pruebas y las bibliotecas del hexágono', () => {
    const names = runnableProjects(generated).map((entry) => entry.name);
    assert.ok(!names.includes('Sp.UnitTests'));
    assert.ok(!names.includes('Sp.Domain'));
    assert.ok(!names.includes('Sp.Ports'));
  });

  it('un perfil con los dos adaptadores depura el primero y arranca el segundo', () => {
    const runnable = runnableProjects(generated);
    const perfil = {
      id: 'custom:1',
      name: 'API + UI',
      projects: runnable.map((entry) => entry.path),
      implicit: false,
    };

    const plan = launchPlan(perfil, generated, 'debug');
    assert.equal(plan.length, 2);
    assert.equal(plan[0].action, 'debug');
    assert.equal(plan[1].action, 'run');

    // Sin depurador, los dos son web: los dos con Hot Reload.
    assert.deepEqual(
      launchPlan(perfil, generated, 'run').map((step) => step.action),
      ['watch', 'watch'],
    );
  });
});
