/**
 * Pruebas de la detección de endpoints en C# y de la generación de pruebas `.http`.
 *
 * Es análisis de texto, no un árbol sintáctico, y eso obliga a ser explícito sobre qué se espera:
 * los grupos de Minimal API (`MapGroup`), el token `[controller]` de los controladores y las
 * rutas con restricción de tipo (`{id:int}`) son justo los sitios donde una lente de código se
 * equivoca sin que nadie lo note hasta que la petición generada da un 404.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHttpFile,
  collectGroups,
  controllerName,
  expandRouteTokens,
  fillRouteParameters,
  findControllerEndpoints,
  findEndpoints,
  findMinimalApiEndpoints,
  httpFileNameFor,
  joinRoutes,
  parseHttpFile,
  requestFor,
  sampleForParameter,
} from '../../build/ui-lib.mjs';

const MINIMAL_API = `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => Results.Ok("ok"));

var products = app.MapGroup("/api/products").WithTags("Products");

products.MapGet("/", async (IProductService service) => await service.ListAsync())
    .WithName("ListProducts");

products.MapGet("/{id:guid}", async (Guid id, IProductService service) => await service.GetAsync(id));

products.MapPost("/", async (CreateProduct command, IProductService service) => await service.CreateAsync(command));

products.MapDelete("/{id:guid}", async (Guid id, IProductService service) => await service.DeleteAsync(id));
`;

const CONTROLLER = `using Microsoft.AspNetCore.Mvc;

namespace Acme.Shop.WebApi.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List() => Ok(await _service.ListAsync());

    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetById(int id) => Ok(await _service.GetAsync(id));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateProduct command) => Created();

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id) => NoContent();
}
`;

describe('rutas', () => {
  it('une prefijo y sufijo sin duplicar ni perder la barra', () => {
    assert.equal(joinRoutes('/api/products', '/'), '/api/products');
    assert.equal(joinRoutes('/api/products', '{id}'), '/api/products/{id}');
    assert.equal(joinRoutes('', 'health'), '/health');
    assert.equal(joinRoutes('api', 'products'), '/api/products');
  });

  it('sustituye los tokens de los controladores', () => {
    assert.equal(expandRouteTokens('api/[controller]', 'Products', 'List'), 'api/Products');
    assert.equal(expandRouteTokens('[controller]/[action]', 'Products', 'List'), 'Products/List');
  });

  it('quita el sufijo Controller del nombre de la clase', () => {
    assert.equal(controllerName('ProductsController'), 'Products');
    assert.equal(controllerName('Products'), 'Products');
  });
});

describe('Minimal API', () => {
  const endpoints = findMinimalApiEndpoints(MINIMAL_API);

  it('encuentra todos los endpoints, con y sin grupo', () => {
    assert.deepEqual(
      endpoints.map((endpoint) => `${endpoint.method} ${endpoint.route}`),
      [
        'GET /health',
        'GET /api/products',
        'GET /api/products/{id:guid}',
        'POST /api/products',
        'DELETE /api/products/{id:guid}',
      ],
    );
  });

  it('resuelve el prefijo del grupo declarado con MapGroup', () => {
    const groups = collectGroups(MINIMAL_API);
    assert.equal(groups.get('products'), '/api/products');
  });

  it('lee el nombre declarado con WithName', () => {
    assert.equal(endpoints.find((endpoint) => endpoint.route === '/api/products' && endpoint.method === 'GET').name, 'ListProducts');
  });

  it('la línea apunta a la declaración: es donde se ancla la lente', () => {
    const lines = MINIMAL_API.split('\n');
    for (const endpoint of endpoints) {
      assert.match(lines[endpoint.line - 1], /Map(Get|Post|Put|Patch|Delete)/);
    }
  });

  it('un archivo sin endpoints no inventa ninguno', () => {
    assert.deepEqual(findMinimalApiEndpoints('public class Nada { }'), []);
  });
});

describe('controladores', () => {
  const endpoints = findControllerEndpoints(CONTROLLER);

  it('compone la ruta de la clase con la del método', () => {
    assert.deepEqual(
      endpoints.map((endpoint) => `${endpoint.method} ${endpoint.route}`),
      ['GET /api/Products', 'GET /api/Products/{id:int}', 'POST /api/Products', 'DELETE /api/Products/{id:int}'],
    );
  });

  it('deduce el nombre del método de acción', () => {
    assert.deepEqual(endpoints.map((endpoint) => endpoint.name), ['List', 'GetById', 'Create', 'Delete']);
  });

  it('los endpoints salen ordenados por línea al mezclar las dos formas', () => {
    const mixed = findEndpoints(`${CONTROLLER}\n${MINIMAL_API}`);
    const lines = mixed.map((endpoint) => endpoint.line);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
  });
});

describe('generación de pruebas .http', () => {
  it('rellena los parámetros de ruta según su restricción', () => {
    assert.equal(sampleForParameter('id:int'), '1');
    assert.equal(sampleForParameter('id:guid'), '00000000-0000-0000-0000-000000000000');
    assert.equal(sampleForParameter('slug'), 'valor');
    assert.equal(fillRouteParameters('/api/products/{id:int}/lines/{lineId}'), '/api/products/1/lines/1');
  });

  it('una petición generada se vuelve a parsear sin perder nada', () => {
    const [endpoint] = findControllerEndpoints(CONTROLLER);
    const [request] = parseHttpFile(`${requestFor(endpoint)}\n`).requests;

    assert.equal(request.method, 'GET');
    assert.equal(request.url, '{{host}}/api/Products');
    assert.equal(request.name, 'List');
  });

  it('los verbos con cuerpo llevan Content-Type y un JSON de ejemplo', () => {
    const post = findControllerEndpoints(CONTROLLER).find((endpoint) => endpoint.method === 'POST');
    const [request] = parseHttpFile(requestFor(post)).requests;

    assert.deepEqual(
      request.headers.map((header) => header.name).sort(),
      ['Accept', 'Content-Type'],
    );
    assert.ok(request.body.trim().startsWith('{'));
  });

  it('un GET no lleva cuerpo', () => {
    const get = findControllerEndpoints(CONTROLLER).find((endpoint) => endpoint.method === 'GET');
    assert.equal(parseHttpFile(requestFor(get)).requests[0].body, '');
  });

  it('el archivo completo saca la URL base a una variable', () => {
    const file = buildHttpFile(findEndpoints(MINIMAL_API), { baseUrl: 'http://localhost:5183' });
    const document = parseHttpFile(file);

    assert.equal(document.variables.host, 'http://localhost:5183');
    assert.equal(document.requests.length, 5);
    assert.equal(document.requests[0].url.startsWith('{{host}}'), true);
  });

  it('el nombre del archivo cuelga del proyecto', () => {
    assert.equal(httpFileNameFor('Acme.Shop.WebApi'), 'Acme.Shop.WebApi.http');
  });
});
