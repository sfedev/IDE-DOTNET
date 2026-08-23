/**
 * Pruebas del lector de `docker-compose.yml`.
 *
 * El parser es un subconjunto de YAML escrito a mano (ADR-032), así que las pruebas son la
 * garantía de que ese subconjunto cubre lo que hay en un compose de desarrollo real: mapas
 * anidados, listas en dos formatos, puertos entrecomillados y sin comillar, variables de entorno
 * como lista o como mapa, comentarios a media línea y almohadillas dentro de una contraseña.
 *
 * El compose de ejemplo es el típico de una solución .NET: SQL Server, Redis, RabbitMQ, Seq y la
 * propia API construida desde el Dockerfile.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  composeArgs,
  containerArgs,
  isComposeFile,
  matchComposeState,
  parseCompose,
  parseComposePorts,
  parseYaml,
  scalar,
} from '../../build/ui-lib.mjs';

const COMPOSE = `# Servicios de apoyo de Acme.Shop
name: acmeshop

services:
  sqlserver:
    image: mcr.microsoft.com/mssql/server:2022-latest
    container_name: acme-sqlserver
    environment:
      - ACCEPT_EULA=Y
      - SA_PASSWORD=Str0ng#Pass!   # la almohadilla es parte de la contraseña
    ports:
      - "1433:1433"
    volumes:
      - sqldata:/var/opt/mssql

  redis:
    image: redis:7-alpine
    ports:
      - 6379:6379
    profiles: [dev, test]

  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"

  seq:
    image: datalust/seq:latest
    environment:
      ACCEPT_EULA: "Y"
    ports:
      - "5341:80"

  api:
    build:
      context: .
      dockerfile: src/Acme.Shop.WebApi/Dockerfile
    depends_on:
      - sqlserver
      - redis
    ports:
      - "127.0.0.1:8080:8080"

volumes:
  sqldata:
`;

describe('YAML mínimo', () => {
  const document = parseYaml(COMPOSE);

  it('lee las claves de primer nivel', () => {
    assert.deepEqual(Object.keys(document).sort(), ['name', 'services', 'volumes']);
    assert.equal(document.name, 'acmeshop');
  });

  it('anida los mapas por indentación', () => {
    assert.equal(document.services.sqlserver.image, 'mcr.microsoft.com/mssql/server:2022-latest');
    assert.equal(document.services.api.build.dockerfile, 'src/Acme.Shop.WebApi/Dockerfile');
  });

  it('lee las listas en bloque y en línea', () => {
    assert.deepEqual(document.services.rabbitmq.ports, ['5672:5672', '15672:15672']);
    assert.deepEqual(document.services.redis.profiles, ['dev', 'test']);
  });

  it('acepta el entorno como lista y como mapa', () => {
    assert.ok(Array.isArray(document.services.sqlserver.environment));
    assert.equal(document.services.seq.environment.ACCEPT_EULA, 'Y');
  });

  it('un comentario a media línea no se traga el valor', () => {
    assert.ok(document.services.sqlserver.environment.includes('SA_PASSWORD=Str0ng#Pass!'));
  });

  it('quita las comillas de los escalares', () => {
    assert.equal(scalar('"1433:1433"'), '1433:1433');
    assert.equal(scalar("'valor'"), 'valor');
    assert.equal(scalar('  suelto  '), 'suelto');
  });

  it('un archivo vacío devuelve un documento vacío, no un error', () => {
    assert.deepEqual(parseYaml(''), {});
    assert.deepEqual(parseYaml('# sólo comentarios\n'), {});
  });
});

describe('servicios del compose', () => {
  const file = parseCompose(COMPOSE, 'C:/src/Acme.Shop/docker-compose.yml');

  it('lee el nombre de proyecto y todos los servicios', () => {
    assert.equal(file.projectName, 'acmeshop');
    assert.deepEqual(file.services.map((service) => service.name), [
      'sqlserver',
      'redis',
      'rabbitmq',
      'seq',
      'api',
    ]);
  });

  it('reconoce los servicios de apoyo y les pone su nombre real', () => {
    const labels = Object.fromEntries(file.services.map((service) => [service.name, service.label]));
    assert.equal(labels.sqlserver, 'SQL Server');
    assert.equal(labels.redis, 'Redis');
    assert.equal(labels.rabbitmq, 'RabbitMQ');
    assert.equal(labels.seq, 'Seq');
  });

  it('un servicio que se construye no tiene imagen, y se identifica por su nombre', () => {
    const api = file.services.find((service) => service.name === 'api');
    assert.equal(api.image, null);
    assert.equal(api.build, '.');
    assert.equal(api.label, 'api');
  });

  it('lee el container_name declarado', () => {
    assert.equal(file.services[0].containerName, 'acme-sqlserver');
    assert.equal(file.services[1].containerName, null);
  });

  it('lee las dependencias y los perfiles', () => {
    const api = file.services.find((service) => service.name === 'api');
    assert.deepEqual(api.dependsOn, ['sqlserver', 'redis']);
    assert.deepEqual(file.services.find((service) => service.name === 'redis').profiles, ['dev', 'test']);
  });

  it('lee los volúmenes declarados', () => {
    assert.deepEqual(file.volumes, ['sqldata']);
  });

  it('un compose sin servicios no revienta', () => {
    assert.deepEqual(parseCompose('version: "3.9"\n', 'x.yml').services, []);
  });
});

describe('puertos del compose', () => {
  it('acepta las formas que se escriben de verdad', () => {
    assert.deepEqual(parseComposePorts(['"1433:1433"']), [{ host: 1433, container: 1433, protocol: 'tcp' }]);
    assert.deepEqual(parseComposePorts(['6379:6379']), [{ host: 6379, container: 6379, protocol: 'tcp' }]);
    assert.deepEqual(parseComposePorts(['127.0.0.1:8080:8080']), [{ host: 8080, container: 8080, protocol: 'tcp' }]);
    assert.deepEqual(parseComposePorts(['"53:53/udp"']), [{ host: 53, container: 53, protocol: 'udp' }]);
  });

  it('un puerto sin publicar no cuenta: no hay puerto de host que enseñar', () => {
    assert.deepEqual(parseComposePorts(['5341']), []);
  });

  it('el mapeo del compose se usa cuando el contenedor no está levantado', () => {
    const file = parseCompose(COMPOSE, 'x.yml');
    const seq = file.services.find((service) => service.name === 'seq');
    assert.deepEqual(seq.ports, [{ host: 5341, container: 80, protocol: 'tcp' }]);
  });
});

describe('comandos', () => {
  it('reconoce los nombres de archivo de Compose', () => {
    assert.equal(isComposeFile('docker-compose.yml'), true);
    assert.equal(isComposeFile('compose.yaml'), true);
    assert.equal(isComposeFile('Dockerfile'), false);
    assert.equal(isComposeFile('appsettings.json'), false);
  });

  it('`up` va siempre en segundo plano', () => {
    assert.deepEqual(composeArgs('up', 'C:/s/docker-compose.yml'), [
      'compose',
      '-f',
      'C:/s/docker-compose.yml',
      'up',
      '-d',
    ]);
  });

  it('una acción sobre un servicio lo añade al final', () => {
    const args = composeArgs('restart', 'C:/s/docker-compose.yml', 'redis');
    assert.equal(args[args.length - 1], 'redis');
  });

  it('el archivo se pasa siempre con -f: el directorio de trabajo lo pone el IDE', () => {
    for (const action of ['up', 'down', 'logs', 'build', 'pull', 'stop', 'start', 'restart']) {
      const args = composeArgs(action, 'C:/s/compose.yml');
      assert.equal(args[0], 'compose');
      assert.equal(args[1], '-f');
    }
  });

  it('el registro se pide acotado, no en seguimiento', () => {
    const args = composeArgs('logs', 'C:/s/compose.yml');
    assert.ok(args.includes('--tail'));
    assert.equal(args.includes('-f'), true, 'el -f del archivo sigue estando');
    assert.equal(args.filter((entry) => entry === '-f').length, 1, 'no debe seguir el log en vivo');
  });

  it('las acciones sobre un contenedor suelto son las mínimas', () => {
    assert.deepEqual(containerArgs('start', 'acme-sqlserver'), ['start', 'acme-sqlserver']);
    assert.deepEqual(containerArgs('remove', 'acme-sqlserver'), ['rm', '-f', 'acme-sqlserver']);
    assert.ok(containerArgs('logs', 'acme-sqlserver').includes('--tail'));
  });
});

describe('lo declarado frente a lo que corre', () => {
  const file = parseCompose(COMPOSE, 'C:/src/Acme.Shop/docker-compose.yml');

  const container = (options) => ({
    id: options.id ?? 'x',
    name: options.name,
    image: options.image ?? 'redis:7-alpine',
    status: options.status ?? 'Up 2 hours',
    state: options.state ?? 'running',
    ports: options.ports ?? [],
    composeProject: options.composeProject ?? null,
    composeService: options.composeService ?? null,
  });

  it('sin nada levantado, todos los servicios salen y salen "down"', () => {
    const state = matchComposeState(file, []);
    assert.equal(state.services.length, 5);
    assert.ok(state.services.every((status) => status.state === 'down'));
    assert.deepEqual(state.others, []);
  });

  it('empareja por la etiqueta de Compose y trae el estado real', () => {
    const state = matchComposeState(file, [
      container({
        name: 'acmeshop-redis-1',
        composeProject: 'acmeshop',
        composeService: 'redis',
        ports: [{ host: 6379, container: 6379, protocol: 'tcp' }],
      }),
    ]);

    const redis = state.services.find((status) => status.service.name === 'redis');
    assert.equal(redis.state, 'running');
    assert.equal(redis.container.name, 'acmeshop-redis-1');
    assert.deepEqual(state.others, []);
  });

  it('un servicio de otro proyecto con el mismo nombre no se roba los botones', () => {
    const ajeno = container({ name: 'otroproyecto-redis-1', composeProject: 'otroproyecto', composeService: 'redis' });
    const propio = container({ name: 'acmeshop-redis-1', composeProject: 'acmeshop', composeService: 'redis' });

    const state = matchComposeState(file, [ajeno, propio]);
    const redis = state.services.find((status) => status.service.name === 'redis');

    assert.equal(redis.container.name, 'acmeshop-redis-1');
    assert.deepEqual(state.others.map((entry) => entry.name), ['otroproyecto-redis-1']);
  });

  it('acepta un contenedor levantado a mano con el container_name declarado', () => {
    const state = matchComposeState(file, [
      container({ name: 'acme-sqlserver', image: 'mcr.microsoft.com/mssql/server:2022-latest' }),
    ]);

    const sql = state.services.find((status) => status.service.name === 'sqlserver');
    assert.equal(sql.container.name, 'acme-sqlserver');
  });

  it('con el servicio parado se enseñan los puertos del compose', () => {
    const state = matchComposeState(file, []);
    const seq = state.services.find((status) => status.service.name === 'seq');
    assert.deepEqual(seq.ports, [{ host: 5341, container: 80, protocol: 'tcp' }]);
    assert.equal(seq.url, null, 'sin contenedor no hay nada que abrir');
  });

  it('ofrece la URL de lo que sí se abre en un navegador', () => {
    const state = matchComposeState(file, [
      container({
        name: 'acmeshop-seq-1',
        image: 'datalust/seq:latest',
        composeProject: 'acmeshop',
        composeService: 'seq',
        ports: [{ host: 5341, container: 80, protocol: 'tcp' }],
      }),
      container({
        name: 'acmeshop-sqlserver-1',
        image: 'mcr.microsoft.com/mssql/server:2022-latest',
        composeProject: 'acmeshop',
        composeService: 'sqlserver',
        ports: [{ host: 1433, container: 1433, protocol: 'tcp' }],
      }),
    ]);

    assert.equal(state.services.find((s) => s.service.name === 'seq').url, 'http://localhost:5341');
    assert.equal(state.services.find((s) => s.service.name === 'sqlserver').url, null);
  });

  it('los contenedores ajenos se listan aparte, no se mezclan', () => {
    const state = matchComposeState(file, [container({ name: 'algo-de-otro-trabajo' })]);
    assert.equal(state.others.length, 1);
    assert.ok(state.services.every((status) => status.container === null));
  });

  it('sin compose, todo lo que corre es "otro"', () => {
    const state = matchComposeState(null, [container({ name: 'suelto' })]);
    assert.deepEqual(state.services, []);
    assert.deepEqual(state.others.map((entry) => entry.name), ['suelto']);
  });
});
