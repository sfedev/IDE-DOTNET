/** Pruebas de validación de nombres, pluralización y GUIDs deterministas. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deterministicGuid,
  NamingError,
  pluralize,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  validateEntityName,
  validateSolutionName,
} from '../../build/scaffold.mjs';

describe('validateSolutionName', () => {
  it('acepta un nombre simple', () => {
    assert.equal(validateSolutionName('Shop'), 'Shop');
  });

  it('acepta segmentos separados por punto', () => {
    assert.equal(validateSolutionName('Acme.Shop.Api'), 'Acme.Shop.Api');
  });

  it('recorta espacios sobrantes', () => {
    assert.equal(validateSolutionName('  Acme.Shop  '), 'Acme.Shop');
  });

  it('rechaza el nombre vacío', () => {
    assert.throws(() => validateSolutionName('   '), NamingError);
  });

  it('rechaza un segmento que empieza por dígito', () => {
    assert.throws(() => validateSolutionName('Acme.1Shop'), /segmento inválido/);
  });

  it('rechaza guiones y espacios', () => {
    assert.throws(() => validateSolutionName('Acme-Shop'), /segmento inválido/);
    assert.throws(() => validateSolutionName('Acme Shop'), /segmento inválido/);
  });

  it('rechaza palabras reservadas de C#', () => {
    assert.throws(() => validateSolutionName('Acme.class'), /palabra reservada/);
    assert.throws(() => validateSolutionName('Acme.Class'), /palabra reservada/);
  });

  it('rechaza nombres reservados de Windows', () => {
    assert.throws(() => validateSolutionName('Acme.CON'), /reservado en Windows/);
    assert.throws(() => validateSolutionName('Acme.lpt1'), /reservado en Windows/);
  });

  it('rechaza nombres demasiado largos', () => {
    assert.throws(() => validateSolutionName('A'.repeat(101)), /100 caracteres/);
  });
});

describe('validateEntityName', () => {
  it('normaliza a PascalCase', () => {
    assert.equal(validateEntityName('product'), 'Product');
  });

  it('acepta dígitos después de la primera letra', () => {
    assert.equal(validateEntityName('Order2'), 'Order2');
  });

  it('rechaza puntos y guiones', () => {
    assert.throws(() => validateEntityName('Order.Line'), /entidad inválida/);
    assert.throws(() => validateEntityName('order-line'), /entidad inválida/);
  });

  it('rechaza palabras reservadas', () => {
    assert.throws(() => validateEntityName('string'), /palabra reservada/);
  });

  it('rechaza el nombre vacío', () => {
    assert.throws(() => validateEntityName(''), NamingError);
  });
});

describe('pluralize', () => {
  const cases = [
    ['Product', 'Products'],
    ['Invoice', 'Invoices'],
    ['Category', 'Categories'],
    ['Company', 'Companies'],
    ['Day', 'Days'],          // vocal + y no cambia a -ies
    ['Box', 'Boxes'],
    ['Address', 'Addresses'],
    ['Batch', 'Batches'],
    ['Dish', 'Dishes'],
    ['Shelf', 'Shelves'],
    ['Knife', 'Knives'],
    ['Person', 'People'],
    ['Child', 'Children'],
    ['Series', 'Series'],
    ['Order', 'Orders'],
  ];

  for (const [singular, plural] of cases) {
    it(`${singular} -> ${plural}`, () => {
      assert.equal(pluralize(singular), plural);
    });
  }

  it('conserva la caja de la palabra irregular', () => {
    assert.equal(pluralize('person'), 'people');
    assert.equal(pluralize('Person'), 'People');
  });
});

describe('conversores de caja', () => {
  it('toPascalCase', () => {
    assert.equal(toPascalCase('product'), 'Product');
    assert.equal(toPascalCase('Product'), 'Product');
  });

  it('toCamelCase', () => {
    assert.equal(toCamelCase('Product'), 'product');
    assert.equal(toCamelCase('OrderLine'), 'orderLine');
  });

  it('toCamelCase respeta los acrónimos iniciales', () => {
    assert.equal(toCamelCase('URLBuilder'), 'urlBuilder');
    assert.equal(toCamelCase('API'), 'api');
  });

  it('toKebabCase', () => {
    assert.equal(toKebabCase('OrderLines'), 'order-lines');
    assert.equal(toKebabCase('Acme.Shop'), 'acme-shop');
    assert.equal(toKebabCase('Products'), 'products');
  });
});

describe('deterministicGuid', () => {
  it('es estable entre llamadas', () => {
    assert.equal(deterministicGuid('Acme.Shop::Domain'), deterministicGuid('Acme.Shop::Domain'));
  });

  it('cambia con la semilla', () => {
    assert.notEqual(deterministicGuid('a'), deterministicGuid('b'));
  });

  it('tiene formato de GUID en mayúsculas', () => {
    assert.match(deterministicGuid('x'), /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  });

  it('fija la versión 4 y la variante RFC 4122', () => {
    const guid = deterministicGuid('cualquiera');
    assert.equal(guid[14], '4');
    assert.ok(['8', '9', 'A', 'B'].includes(guid[19]), `variante inesperada: ${guid[19]}`);
  });
});
