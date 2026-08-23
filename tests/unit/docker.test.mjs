/**
 * Pruebas del modelo de Docker.
 *
 * La salida que se parsea es la real de `docker ps -a --format "{{json .}}"`, con lo que trae de
 * verdad: varios puertos por contenedor, IPv4 e IPv6 apuntando al mismo, etiquetas de Compose
 * mezcladas con las de la imagen, y contenedores parados que también tienen que aparecer porque
 * el panel debe poder arrancarlos.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultPortOf,
  imageName,
  localUrlOf,
  parseContainers,
  parseImages,
  parseLabels,
  parsePorts,
  supportKindOf,
  supportLabel,
} from '../../build/ui-lib.mjs';

const PS_OUTPUT = [
  JSON.stringify({
    ID: 'a1b2c3d4e5f6',
    Names: 'acmeshop-sqlserver-1',
    Image: 'mcr.microsoft.com/mssql/server:2022-latest',
    Status: 'Up 2 hours (healthy)',
    State: 'running',
    Ports: '0.0.0.0:1433->1433/tcp, :::1433->1433/tcp',
    Labels: 'com.docker.compose.project=acmeshop,com.docker.compose.service=sqlserver,vendor=Microsoft',
  }),
  JSON.stringify({
    ID: 'f6e5d4c3b2a1',
    Names: 'acmeshop-redis-1',
    Image: 'redis:7-alpine',
    Status: 'Exited (0) 5 minutes ago',
    State: 'exited',
    Ports: '',
    Labels: 'com.docker.compose.project=acmeshop,com.docker.compose.service=redis',
  }),
  'time="2026-08-23T12:00:00" level=warning msg="algo del motor por stdout"',
].join('\n');

describe('contenedores', () => {
  const containers = parseContainers(PS_OUTPUT);

  it('lee los contenedores y descarta el ruido del motor', () => {
    assert.equal(containers.length, 2);
    assert.deepEqual(containers.map((container) => container.name), ['acmeshop-sqlserver-1', 'acmeshop-redis-1']);
  });

  it('conserva los parados: el panel tiene que poder arrancarlos', () => {
    assert.equal(containers[1].state, 'exited');
    assert.equal(containers[1].status, 'Exited (0) 5 minutes ago');
  });

  it('extrae el servicio y el proyecto de Compose de las etiquetas', () => {
    assert.equal(containers[0].composeProject, 'acmeshop');
    assert.equal(containers[0].composeService, 'sqlserver');
  });

  it('deduplica IPv4 e IPv6 del mismo puerto', () => {
    assert.deepEqual(containers[0].ports, [{ host: 1433, container: 1433, protocol: 'tcp' }]);
  });

  it('un contenedor sin puertos publicados no inventa ninguno', () => {
    assert.deepEqual(containers[1].ports, []);
  });

  it('una salida vacía no es un error', () => {
    assert.deepEqual(parseContainers(''), []);
    assert.deepEqual(parseContainers('Cannot connect to the Docker daemon'), []);
  });

  it('deduce el estado del texto cuando el motor no escribe State', () => {
    const [container] = parseContainers(
      JSON.stringify({ ID: 'x', Names: 'viejo', Image: 'redis', Status: 'Up 3 seconds', Ports: '', Labels: '' }),
    );
    assert.equal(container.state, 'running');
  });
});

describe('puertos y etiquetas', () => {
  it('sólo cuenta los puertos publicados, no los expuestos', () => {
    assert.deepEqual(parsePorts('6379/tcp'), []);
    assert.deepEqual(parsePorts('0.0.0.0:5432->5432/tcp'), [{ host: 5432, container: 5432, protocol: 'tcp' }]);
  });

  it('lee varios puertos distintos', () => {
    const ports = parsePorts('0.0.0.0:5672->5672/tcp, 0.0.0.0:15672->15672/tcp');
    assert.deepEqual(ports.map((port) => port.host), [5672, 15672]);
  });

  it('trocea las etiquetas respetando los valores con puntos', () => {
    const labels = parseLabels('com.docker.compose.project=acmeshop,vendor=Microsoft');
    assert.equal(labels.get('com.docker.compose.project'), 'acmeshop');
    assert.equal(labels.get('vendor'), 'Microsoft');
  });
});

describe('servicios de apoyo', () => {
  it('reconoce los que aparecen en cualquier compose de .NET', () => {
    assert.equal(supportKindOf('mcr.microsoft.com/mssql/server:2022-latest'), 'sqlserver');
    assert.equal(supportKindOf('postgres:16'), 'postgres');
    assert.equal(supportKindOf('redis:7-alpine'), 'redis');
    assert.equal(supportKindOf('rabbitmq:3-management'), 'rabbitmq');
    assert.equal(supportKindOf('datalust/seq:latest'), 'seq');
  });

  it('lo que no reconoce se queda en "other" con un nombre legible', () => {
    assert.equal(supportKindOf('acme/mi-api:1.0'), 'other');
    assert.equal(supportLabel('acme/mi-api:1.0'), 'mi-api');
    assert.equal(supportLabel('mcr.microsoft.com/mssql/server:2022-latest'), 'SQL Server');
  });

  it('sabe el puerto por defecto de cada uno', () => {
    assert.equal(defaultPortOf('sqlserver'), 1433);
    assert.equal(defaultPortOf('redis'), 6379);
    assert.equal(defaultPortOf('other'), null);
  });

  it('ofrece URL sólo para lo que se puede abrir en un navegador', () => {
    const [sqlserver] = parseContainers(PS_OUTPUT);
    assert.equal(localUrlOf(sqlserver), null, 'una base de datos no se abre en el navegador');

    const [seq] = parseContainers(
      JSON.stringify({
        ID: 's',
        Names: 'seq',
        Image: 'datalust/seq:latest',
        Status: 'Up',
        State: 'running',
        Ports: '0.0.0.0:5341->80/tcp',
        Labels: '',
      }),
    );
    assert.equal(localUrlOf(seq), 'http://localhost:5341');
  });
});

describe('imágenes', () => {
  const IMAGES = [
    JSON.stringify({ Repository: 'redis', Tag: '7-alpine', ID: 'abc', Size: '41.2MB' }),
    JSON.stringify({ Repository: '<none>', Tag: '<none>', ID: 'def', Size: '1.2GB' }),
  ].join('\n');

  it('descarta las imágenes huérfanas', () => {
    const images = parseImages(IMAGES);
    assert.equal(images.length, 1);
    assert.equal(imageName(images[0]), 'redis:7-alpine');
  });
});
