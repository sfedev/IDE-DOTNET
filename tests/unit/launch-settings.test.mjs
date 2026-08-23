/**
 * Pruebas del lector de `Properties/launchSettings.json`.
 *
 * Por qué importa: al depurar se lanza el ensamblado de `bin/Debug`, y sin aplicar el perfil la
 * aplicación arranca en Production, escucha en el 5000 y no carga los static web assets. Este
 * módulo es el que evita eso, así que sus reglas de selección y traducción se fijan aquí.
 *
 * La fixture no se escribe a mano: se genera con el propio scaffolder, de modo que la prueba
 * también verifica que el `launchSettings.json` que produce el generador es utilizable.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSolution } from '../../build/scaffold.mjs';
import {
  environmentFromProfile,
  parseLaunchSettings,
  readLaunchEnvironment,
  selectProfile,
} from '../../build/main-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = join(root, 'build');

let workspace;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dfls-'));
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('parseLaunchSettings', () => {
  it('lee nombre, commandName, variables y applicationUrl', () => {
    const profiles = parseLaunchSettings(
      JSON.stringify({
        profiles: {
          'Acme.WebApi': {
            commandName: 'Project',
            applicationUrl: 'https://localhost:7001;http://localhost:5001',
            environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
          },
        },
      }),
    );

    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, 'Acme.WebApi');
    assert.equal(profiles[0].commandName, 'Project');
    assert.equal(profiles[0].applicationUrl, 'https://localhost:7001;http://localhost:5001');
    assert.deepEqual(profiles[0].environmentVariables, { ASPNETCORE_ENVIRONMENT: 'Development' });
  });

  it('convierte a cadena los valores no textuales, que es lo único que admite un entorno', () => {
    const [profile] = parseLaunchSettings(
      JSON.stringify({
        profiles: { app: { commandName: 'Project', environmentVariables: { PORT: 8080, DEBUG: true, NADA: null } } },
      }),
    );

    assert.deepEqual(profile.environmentVariables, { PORT: '8080', DEBUG: 'true' });
  });

  it('tolera un archivo sin perfiles o con formas inesperadas', () => {
    assert.deepEqual(parseLaunchSettings('{}'), []);
    assert.deepEqual(parseLaunchSettings('{"profiles":null}'), []);
    assert.deepEqual(parseLaunchSettings('[]'), []);
    assert.deepEqual(parseLaunchSettings('{"profiles":{"x":42}}'), []);
  });

  it('propaga el error de un JSON inválido en vez de fingir que no hay perfiles', () => {
    assert.throws(() => parseLaunchSettings('{ esto no es json'), SyntaxError);
  });
});

describe('selectProfile', () => {
  const profiles = [
    { name: 'IIS Express', commandName: 'IISExpress', environmentVariables: {}, applicationUrl: null },
    { name: 'http', commandName: 'Project', environmentVariables: {}, applicationUrl: 'http://localhost:5001' },
    { name: 'Acme.WebApi', commandName: 'Project', environmentVariables: {}, applicationUrl: 'https://localhost:7001' },
  ];

  it('prefiere el perfil que se llama como el proyecto', () => {
    assert.equal(selectProfile(profiles, 'Acme.WebApi').name, 'Acme.WebApi');
  });

  it('si no hay coincidencia, usa el primer perfil de tipo Project', () => {
    assert.equal(selectProfile(profiles, 'Otro.Proyecto').name, 'http');
  });

  it('ignora los perfiles que no lanzan el proyecto', () => {
    const soloIis = [profiles[0]];
    assert.equal(selectProfile(soloIis, 'Acme.WebApi'), null);
    assert.equal(selectProfile([], 'Acme.WebApi'), null);
  });
});

describe('environmentFromProfile', () => {
  it('traduce applicationUrl a ASPNETCORE_URLS, como hace dotnet run', () => {
    const env = environmentFromProfile({
      name: 'app',
      commandName: 'Project',
      environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
      applicationUrl: 'https://localhost:7001;http://localhost:5001',
    });

    assert.equal(env.ASPNETCORE_ENVIRONMENT, 'Development');
    assert.equal(env.ASPNETCORE_URLS, 'https://localhost:7001;http://localhost:5001');
  });

  it('no pisa un ASPNETCORE_URLS declarado explícitamente', () => {
    const env = environmentFromProfile({
      name: 'app',
      commandName: 'Project',
      environmentVariables: { ASPNETCORE_URLS: 'http://localhost:1234' },
      applicationUrl: 'https://localhost:7001',
    });

    assert.equal(env.ASPNETCORE_URLS, 'http://localhost:1234');
  });

  it('sin applicationUrl no inventa URLs', () => {
    const env = environmentFromProfile({
      name: 'app',
      commandName: 'Project',
      environmentVariables: {},
      applicationUrl: null,
    });

    assert.deepEqual(env, {});
  });
});

describe('readLaunchEnvironment', () => {
  it('no falla ni avisa cuando el proyecto no tiene launchSettings.json', async () => {
    const projectDir = join(workspace, 'sin-perfiles');
    await mkdir(projectDir, { recursive: true });

    const result = await readLaunchEnvironment(projectDir, 'Lib');

    assert.deepEqual(result.env, {});
    assert.equal(result.profile, null);
    assert.equal(result.warning, null);
  });

  it('avisa, pero no rompe, si el archivo está corrupto', async () => {
    const projectDir = join(workspace, 'roto');
    await mkdir(join(projectDir, 'Properties'), { recursive: true });
    await writeFile(join(projectDir, 'Properties', 'launchSettings.json'), '{ roto', 'utf8');

    const result = await readLaunchEnvironment(projectDir, 'Roto');

    assert.deepEqual(result.env, {});
    assert.match(result.warning, /no se ha podido leer/);
  });

  it('aplica el perfil de una solución realmente generada', async () => {
    const result = await generateSolution(
      {
        architecture: 'hexagonal',
        solutionName: 'Ls',
        outputDir: join(workspace, 'generada'),
        ui: 'both',
        framework: 'net9.0',
        db: 'sqlite',
        entity: 'Product',
        includeTests: false,
        force: true,
        gitInit: false,
      },
      buildDir,
    );

    const web = result.projects.find((project) => /Adapters\.Web$/.test(project.name));
    const projectDir = join(result.rootDir, ...dirname(web.path).split('/'));

    const launch = await readLaunchEnvironment(projectDir, web.name);

    assert.equal(launch.profile, web.name, 'debe elegir el perfil homónimo del proyecto');
    assert.equal(launch.warning, null);
    assert.equal(launch.env.ASPNETCORE_ENVIRONMENT, 'Development');
    assert.match(launch.env.ASPNETCORE_URLS, /^https:\/\/localhost:\d+;http:\/\/localhost:\d+$/);

    // El puerto del perfil no puede ser el 5000 por defecto: es lo que distingue una sesión de
    // depuración bien configurada de una que arranca a ciegas.
    assert.ok(!launch.env.ASPNETCORE_URLS.includes(':5000'));
  });
});
