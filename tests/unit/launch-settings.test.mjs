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
  BOM,
  dotnetTaskArgs,
  environmentFromProfile,
  launchProfileArgs,
  parseLaunchSettings,
  readLaunchEnvironment,
  selectProfile,
  servesHttps,
  stripBom,
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

  /**
   * Sin coincidencia de nombre manda HTTPS, y no el orden del archivo.
   *
   * Las plantillas del SDK declaran `http` **antes** que `https`, así que "el primero declarado"
   * era justo el perfil sin TLS: el proyecto arrancaba en claro, el certificado de desarrollo no
   * se usaba nunca y cualquier cliente apuntando al puerto seguro fallaba a conectar.
   */
  it('si no hay coincidencia, prefiere un perfil que escuche en HTTPS', () => {
    assert.equal(selectProfile(profiles, 'Otro.Proyecto').name, 'Acme.WebApi');
  });

  it('entre varios HTTPS gana el primero declarado, que es el criterio del SDK', () => {
    const dos = [
      { name: 'seguro-1', commandName: 'Project', environmentVariables: {}, applicationUrl: 'https://localhost:7001' },
      { name: 'seguro-2', commandName: 'Project', environmentVariables: {}, applicationUrl: 'https://localhost:7002' },
    ];
    assert.equal(selectProfile(dos, 'Nadie').name, 'seguro-1');
  });

  it('sin ningún HTTPS se conserva el comportamiento de siempre: el primero', () => {
    const soloHttp = [
      { name: 'http', commandName: 'Project', environmentVariables: {}, applicationUrl: 'http://localhost:5001' },
      { name: 'otro', commandName: 'Project', environmentVariables: {}, applicationUrl: null },
    ];
    assert.equal(selectProfile(soloHttp, 'Nadie').name, 'http');
  });

  it('el nombre del proyecto sigue mandando sobre el esquema', () => {
    // Quien llama a su perfil como el proyecto está diciendo cuál quiere. HTTPS es el desempate,
    // no una preferencia que pise una decisión explícita.
    const conNombre = [
      { name: 'seguro', commandName: 'Project', environmentVariables: {}, applicationUrl: 'https://localhost:7001' },
      { name: 'Acme.WebApi', commandName: 'Project', environmentVariables: {}, applicationUrl: 'http://localhost:5001' },
    ];
    assert.equal(selectProfile(conNombre, 'Acme.WebApi').name, 'Acme.WebApi');
  });

  it('servesHttps mira la lista entera de URLs, no sólo la primera', () => {
    const perfil = (url) => ({ name: 'x', commandName: 'Project', environmentVariables: {}, applicationUrl: url });
    assert.equal(servesHttps(perfil('http://localhost:5001;https://localhost:7001')), true);
    assert.equal(servesHttps(perfil('HTTPS://localhost:7001')), true, 'el esquema no distingue mayúsculas');
    assert.equal(servesHttps(perfil('http://localhost:5001')), false);
    assert.equal(servesHttps(perfil(null)), false);
    // Un host que se llama "https-algo" no es HTTPS: se compara el esquema, no una subcadena.
    assert.equal(servesHttps(perfil('http://https-proxy:5001')), false);
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

/**
 * Marca de orden de bytes (ADR-058).
 *
 * El síntoma real: un `launchSettings.json` guardado por Visual Studio empieza por `EF BB BF`.
 * `JSON.parse` lo rechaza en la posición 0, `readLaunchEnvironment` devolvía un aviso y cero
 * variables, y la aplicación arrancaba en Production escuchando en el 5000 por HTTP. La causa está
 * en el primer carácter del archivo y el síntoma aparece tres pantallas más allá.
 */
describe('archivos con marca de orden de bytes', () => {
  it('BOM es exactamente U+FEFF', () => {
    assert.equal(BOM.length, 1);
    assert.equal(BOM.charCodeAt(0), 0xfeff);
  });

  it('stripBom quita la marca del principio y no toca nada más', () => {
    assert.equal(stripBom(`${BOM}{}`), '{}');
    assert.equal(stripBom('{}'), '{}');
    assert.equal(stripBom(''), '');
  });

  it('un U+FEFF que no está al principio es contenido y se conserva', () => {
    // En mitad de una cadena es un espacio de ancho cero: borrarlo cambiaría el valor leído.
    const dentro = `{"a":"x${BOM}y"}`;
    assert.equal(stripBom(dentro), dentro);
  });

  it('parseLaunchSettings lee un archivo con BOM', () => {
    const source = `${BOM}${JSON.stringify({
      profiles: {
        https: {
          commandName: 'Project',
          applicationUrl: 'https://localhost:7233;http://localhost:5233',
          environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
        },
      },
    })}`;

    const [profile] = parseLaunchSettings(source);
    assert.equal(profile.name, 'https');
    assert.equal(profile.environmentVariables.ASPNETCORE_ENVIRONMENT, 'Development');
  });

  it('readLaunchEnvironment aplica el perfil de un archivo con BOM, sin avisos', async () => {
    const projectDir = join(workspace, 'con-bom');
    await mkdir(join(projectDir, 'Properties'), { recursive: true });
    await writeFile(
      join(projectDir, 'Properties', 'launchSettings.json'),
      `${BOM}${JSON.stringify({
        profiles: {
          http: { commandName: 'Project', applicationUrl: 'http://localhost:5233' },
          https: {
            commandName: 'Project',
            applicationUrl: 'https://localhost:7233;http://localhost:5233',
            environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
          },
        },
      })}`,
      'utf8',
    );

    const launch = await readLaunchEnvironment(projectDir, 'ConBom');

    assert.equal(launch.warning, null, 'un BOM no es un archivo roto');
    assert.equal(launch.profile, 'https', 'sin coincidencia de nombre gana el perfil seguro');
    assert.equal(launch.env.ASPNETCORE_ENVIRONMENT, 'Development');
    assert.equal(launch.env.ASPNETCORE_URLS, 'https://localhost:7233;http://localhost:5233');
    assert.ok(!launch.env.ASPNETCORE_URLS.includes(':5000'), 'el puerto por defecto es la señal del fallo');
  });
});

/**
 * `--launch-profile` en la línea de `dotnet run` (ADR-058).
 *
 * Sin la bandera, `dotnet run --project X` aplica el primer perfil del archivo —el de HTTP en las
 * plantillas del SDK— mientras el IDE decía estar arrancando el de HTTPS. La aplicación escuchaba
 * en un puerto distinto del que se anunciaba, que es de los fallos más caros de diagnosticar
 * porque todo lo demás parece correcto.
 */
describe('perfil de arranque en la línea de comandos', () => {
  it('sólo `run` y `watch` lo aceptan', () => {
    assert.deepEqual(launchProfileArgs('run', 'https'), ['--launch-profile', 'https']);
    assert.deepEqual(launchProfileArgs('watch', 'https'), ['--launch-profile', 'https']);
    for (const kind of ['build', 'rebuild', 'clean', 'restore', 'test', 'format']) {
      assert.deepEqual(launchProfileArgs(kind, 'https'), [], kind);
    }
  });

  it('sin perfil no se inventa la bandera', () => {
    assert.deepEqual(launchProfileArgs('run', undefined), []);
    assert.deepEqual(launchProfileArgs('run', ''), []);
    assert.deepEqual(launchProfileArgs('run', '   '), []);
  });

  it('el nombre viaja como argumento suelto: un perfil puede llamarse "IIS Express"', () => {
    assert.deepEqual(launchProfileArgs('run', 'IIS Express'), ['--launch-profile', 'IIS Express']);
  });

  it('en `dotnet run` el perfil va detrás del proyecto', () => {
    assert.deepEqual(
      dotnetTaskArgs({ kind: 'run', target: 'C:\repos\Acme\Acme.WebApi.csproj', launchProfile: 'https' }, 'minimal'),
      ['run', '--project', 'C:\repos\Acme\Acme.WebApi.csproj', '--launch-profile', 'https', '--verbosity', 'minimal'],
    );
  });

  it('en `dotnet watch` la verbosidad sigue yendo delante del subcomando', () => {
    // `dotnet watch` pasa a la aplicación hija todo lo que va después del subcomando: si
    // `--verbose` cayera detrás, llegaría como argumento de la aplicación en vez de fallar.
    const args = dotnetTaskArgs(
      { kind: 'watch', target: 'C:\repos\Acme\Acme.Blazor.csproj', launchProfile: 'https' },
      'detailed',
    );

    assert.equal(args[0], 'watch');
    assert.ok(args.indexOf('--verbose') < args.indexOf('--project'), '--verbose va antes del subcomando');
    assert.deepEqual(args.slice(-2), ['--launch-profile', 'https']);
    assert.ok(!args.includes('--verbosity'), 'dotnet watch no tiene --verbosity');
  });

  it('sin perfil, la línea es exactamente la de antes', () => {
    assert.deepEqual(
      dotnetTaskArgs({ kind: 'run', target: 'App.csproj' }, 'minimal'),
      ['run', '--project', 'App.csproj', '--verbosity', 'minimal'],
    );
  });

  it('los argumentos extra siguen siendo los últimos', () => {
    // Si alguno abre la sección de argumentos de la aplicación (`--`), lo nuestro ya ha quedado
    // del lado de la CLI.
    assert.deepEqual(
      dotnetTaskArgs({ kind: 'run', target: 'App.csproj', launchProfile: 'https', extraArgs: ['--', '--flag'] }, 'minimal'),
      ['run', '--project', 'App.csproj', '--launch-profile', 'https', '--verbosity', 'minimal', '--', '--flag'],
    );
  });
});
