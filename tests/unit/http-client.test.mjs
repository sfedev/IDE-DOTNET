/**
 * Pruebas del cliente HTTP integrado.
 *
 * Tres capas, de fuera adentro:
 *
 *  1. **El formato `.http`**, que es donde están los casos borde de verdad: un cuerpo JSON con
 *     llaves y almohadillas dentro, una petición sin separador delante, comentarios mezclados con
 *     la directiva `# @name`, y variables que se refieren a otras variables.
 *  2. **La validación** de lo que sale hacia el proceso principal: sin URL, con un protocolo que
 *     no es HTTP, o con un salto de línea metido en una cabecera.
 *  3. **El envío de verdad** contra un servidor levantado en el propio test. Es la única forma de
 *     comprobar que el cuerpo llega, que el JSON se reindenta y que un puerto cerrado se traduce
 *     a un mensaje legible en vez de a una excepción.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  isHttpFile,
  languageForContentType,
  parseHttpFile,
  prettyBody,
  requestAtLine,
  resolveRequest,
  resolveVariables,
  statusTone,
} from '../../build/ui-lib.mjs';
import { coerceRequest, isLocalHost, sendRequest } from '../../build/main-lib.mjs';

const FILE = `# Peticiones de la API
@host = https://localhost:7001
@api = {{host}}/api

### Listar productos
GET {{api}}/products
Accept: application/json

### Crear producto
# @name crear
POST {{api}}/products
Content-Type: application/json

{
  "name": "Teclado ###",
  "price": 49.9
}

###
DELETE {{api}}/products/1
`;

describe('parseo de archivos .http', () => {
  const document = parseHttpFile(FILE);

  it('reconoce la extensión', () => {
    assert.equal(isHttpFile('C:/s/Api/Acme.http'), true);
    assert.equal(isHttpFile('peticiones.REST'), true);
    assert.equal(isHttpFile('Program.cs'), false);
  });

  it('recoge las variables de la cabecera', () => {
    assert.equal(document.variables.host, 'https://localhost:7001');
    assert.equal(document.variables.api, '{{host}}/api');
  });

  it('trocea el archivo en peticiones', () => {
    assert.deepEqual(document.requests.map((request) => request.method), ['GET', 'POST', 'DELETE']);
  });

  it('toma el nombre del separador y, si no lo hay, de la directiva @name', () => {
    assert.equal(document.requests[0].name, 'Listar productos');
    assert.equal(document.requests[1].name, 'Crear producto');
    // El tercer bloque no tiene título ni directiva: se describe solo.
    assert.equal(document.requests[2].name, 'DELETE {{api}}/products/1');
  });

  it('separa cabeceras de cuerpo por la primera línea en blanco', () => {
    const crear = document.requests[1];
    assert.deepEqual(crear.headers, [{ name: 'Content-Type', value: 'application/json' }]);
    assert.ok(crear.body.startsWith('{'));
    assert.ok(crear.body.endsWith('}'));
  });

  it('una almohadilla dentro del cuerpo no parte la petición', () => {
    assert.ok(document.requests[1].body.includes('Teclado ###'));
    assert.equal(document.requests.length, 3);
  });

  it('la línea de la petición es la que necesita la lente de código', () => {
    const lines = FILE.split('\n');
    for (const request of document.requests) {
      assert.match(lines[request.requestLine - 1], new RegExp(`^${request.method}\\b`));
    }
  });

  it('encuentra la petición que contiene el cursor', () => {
    const crear = document.requests[1];
    assert.equal(requestAtLine(document, crear.requestLine + 1).name, 'Crear producto');
  });

  it('una primera petición sin separador delante también cuenta', () => {
    const document = parseHttpFile('GET https://acme.test/health\n');
    assert.equal(document.requests.length, 1);
    assert.equal(document.requests[0].url, 'https://acme.test/health');
  });

  it('una URL suelta es un GET', () => {
    assert.equal(parseHttpFile('https://acme.test/health').requests[0].method, 'GET');
  });

  it('un archivo vacío o a medio escribir no revienta', () => {
    assert.deepEqual(parseHttpFile('').requests, []);
    assert.deepEqual(parseHttpFile('### \n# todavía nada\n').requests, []);
  });
});

describe('resolución de variables', () => {
  const document = parseHttpFile(FILE);

  it('resuelve variables que se refieren a otras', () => {
    const resolved = resolveRequest(document.requests[0], document.variables);
    assert.equal(resolved.url, 'https://localhost:7001/api/products');
  });

  it('deja intacta una variable que no existe, para que se vea qué falta', () => {
    assert.equal(resolveVariables('{{token}}/x', {}), '{{token}}/x');
  });

  it('un ciclo entre variables no cuelga la interfaz', () => {
    const value = resolveVariables('{{a}}', { a: '{{b}}', b: '{{a}}' });
    assert.equal(typeof value, 'string');
  });

  it('resuelve las variables dinámicas con los valores que se le pasan', () => {
    const [request] = parseHttpFile('GET https://acme.test/{{$guid}}?t={{$timestamp}}').requests;
    const resolved = resolveRequest(request, {}, { uuid: 'abc', nowMs: 1_700_000_000_000 });
    assert.equal(resolved.url, 'https://acme.test/abc?t=1700000000');
  });

  it('resuelve también cabeceras y cuerpo', () => {
    const [request] = parseHttpFile(
      'POST {{host}}/x\nAuthorization: Bearer {{token}}\n\n{ "id": "{{id}}" }',
    ).requests;
    const resolved = resolveRequest(request, { host: 'https://acme.test', token: 't0k3n', id: '42' });

    assert.equal(resolved.headers[0].value, 'Bearer t0k3n');
    assert.ok(resolved.body.includes('"42"'));
  });

  it('un cuerpo vacío es null, no una cadena vacía', () => {
    const [request] = parseHttpFile('GET https://acme.test/x\n').requests;
    assert.equal(resolveRequest(request, {}).body, null);
  });
});

describe('presentación de la respuesta', () => {
  it('elige el lenguaje por el content-type', () => {
    assert.equal(languageForContentType('application/json; charset=utf-8'), 'json');
    assert.equal(languageForContentType('text/html'), 'html');
    assert.equal(languageForContentType(null), 'plaintext');
  });

  it('reindenta el JSON y deja el resto tal cual', () => {
    assert.equal(prettyBody('{"a":1}', 'json'), '{\n  "a": 1\n}');
    assert.equal(prettyBody('no soy json', 'json'), 'no soy json');
  });

  it('el tono del estado sigue las familias de códigos', () => {
    assert.equal(statusTone(200), 'ok');
    assert.equal(statusTone(302), 'info');
    assert.equal(statusTone(404), 'warn');
    assert.equal(statusTone(500), 'error');
  });
});

describe('validación de la petición', () => {
  it('exige una URL absoluta y un protocolo HTTP', () => {
    assert.throws(() => coerceRequest({ method: 'GET', url: '/api/products' }));
    assert.throws(() => coerceRequest({ method: 'GET', url: 'file:///C:/Windows/System32' }));
    assert.throws(() => coerceRequest({ method: 'GET' }));
  });

  it('normaliza el método y descarta cabeceras sin nombre', () => {
    const request = coerceRequest({
      method: 'post',
      url: 'https://acme.test/x',
      headers: [{ name: ' Accept ', value: 'application/json' }, { name: '', value: 'x' }],
    });

    assert.equal(request.method, 'POST');
    assert.deepEqual(request.headers, [{ name: 'Accept', value: 'application/json' }]);
  });

  it('un salto de línea en una cabecera no puede partir la petición', () => {
    const request = coerceRequest({
      url: 'https://acme.test/x',
      headers: [{ name: 'X-Test', value: 'a\r\nX-Inyectada: 1' }],
    });

    assert.equal(request.headers[0].value.includes('\n'), false);
  });

  it('sólo se acepta certificado autofirmado en la máquina local', () => {
    assert.equal(isLocalHost('localhost'), true);
    assert.equal(isLocalHost('127.0.0.1'), true);
    assert.equal(isLocalHost('api.acme.test'), false);
  });
});

describe('envío contra un servidor real', () => {
  /**
   * Servidor de usar y tirar.
   *
   * `closeAllConnections()` antes de `close()` no es opcional: sin él, el servidor espera al
   * `requestTimeout` (300 s por defecto) y la suite tarda cinco minutos en salir aunque esté
   * toda en verde.
   */
  async function withServer(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      return await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('devuelve estado, cabeceras y cuerpo reindentado', async () => {
    const response = await withServer(
      (request, reply) => {
        reply.writeHead(200, { 'Content-Type': 'application/json' });
        reply.end('{"ok":true}');
      },
      (base) => sendRequest({ method: 'GET', url: `${base}/api/products` }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.languageId, 'json');
    assert.equal(response.body, '{\n  "ok": true\n}');
    assert.ok(response.headers.some((header) => header.name.toLowerCase() === 'content-type'));
    assert.equal(response.error, null);
  });

  it('envía el cuerpo y las cabeceras que se le dan', async () => {
    const received = await withServer(
      (request, reply) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          reply.writeHead(201, { 'Content-Type': 'application/json' });
          reply.end(
            JSON.stringify({
              method: request.method,
              contentType: request.headers['content-type'],
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        });
      },
      (base) =>
        sendRequest({
          method: 'POST',
          url: `${base}/api/products`,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          body: '{"name":"Teclado"}',
        }),
    );

    const echo = JSON.parse(received.body);
    assert.equal(received.status, 201);
    assert.equal(echo.method, 'POST');
    assert.equal(echo.contentType, 'application/json');
    assert.equal(echo.body, '{"name":"Teclado"}');
  });

  it('sigue el redireccionamiento e informa de la URL final', async () => {
    const response = await withServer(
      (request, reply) => {
        if (request.url === '/vieja') {
          reply.writeHead(301, { Location: '/nueva' });
          reply.end();
          return;
        }
        reply.writeHead(200, { 'Content-Type': 'text/plain' });
        reply.end('destino');
      },
      (base) => sendRequest({ method: 'GET', url: `${base}/vieja` }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.body, 'destino');
    assert.ok(response.finalUrl.endsWith('/nueva'));
  });

  it('un 404 es una respuesta, no un error del IDE', async () => {
    const response = await withServer(
      (_request, reply) => {
        reply.writeHead(404, { 'Content-Type': 'text/plain' });
        reply.end('no está');
      },
      (base) => sendRequest({ method: 'GET', url: `${base}/nada` }),
    );

    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
    assert.equal(response.error, null);
  });

  it('un puerto cerrado se traduce a un mensaje legible', async () => {
    // Puerto efímero ya liberado: nadie escucha ahí.
    const port = await withServer(
      (_request, reply) => reply.end(),
      (base) => Number(new URL(base).port),
    );

    const response = await sendRequest({ method: 'GET', url: `http://127.0.0.1:${port}/x` });

    assert.equal(response.status, 0);
    assert.ok(response.error);
    assert.equal(response.error.includes('rechazada') || response.error.includes('ECONNREFUSED'), true);
  });
});
