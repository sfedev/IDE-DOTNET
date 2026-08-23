/**
 * Auto-cierre de etiquetas en Razor.
 *
 * La decisión de insertar `</tag>` se extrajo a una función pura precisamente para poder probar
 * aquí los casos borde, que es donde estaba el riesgo: etiquetas void, autocerradas y cierres
 * que ya existen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { closingTagFor, razorSnippets, RAZOR_DIRECTIVES, VOID_ELEMENTS } from '../../build/razor-lang.mjs';

describe('closingTagFor', () => {
  it('cierra una etiqueta HTML normal', () => {
    assert.equal(closingTagFor('<div>', ''), '</div>');
  });

  it('cierra una etiqueta con atributos', () => {
    assert.equal(closingTagFor('  <div class="grid" id="x">', ''), '</div>');
  });

  it('cierra un componente Blazor', () => {
    assert.equal(closingTagFor('<MyComponent Value="1">', ''), '</MyComponent>');
  });

  it('cierra componentes con puntos en el nombre', () => {
    assert.equal(closingTagFor('<Shared.Layout.Card>', ''), '</Shared.Layout.Card>');
  });

  it('no cierra etiquetas void', () => {
    for (const tag of ['br', 'img', 'input', 'hr', 'meta', 'link']) {
      assert.equal(closingTagFor(`<${tag}>`, ''), null, `no debería cerrar <${tag}>`);
    }
  });

  it('reconoce las void sin importar la caja', () => {
    assert.equal(closingTagFor('<BR>', ''), null);
    assert.equal(closingTagFor('<IMG src="x">', ''), null);
  });

  it('no cierra una etiqueta autocerrada', () => {
    assert.equal(closingTagFor('<Foo />', ''), null);
    assert.equal(closingTagFor('<Foo/>', ''), null);
  });

  it('no cierra una etiqueta de cierre', () => {
    assert.equal(closingTagFor('</div>', ''), null);
  });

  it('no duplica un cierre que ya está justo detrás', () => {
    assert.equal(closingTagFor('<div>', '</div>'), null);
    assert.equal(closingTagFor('<div>', '</div> resto'), null);
  });

  it('sí cierra si lo que hay detrás es otra cosa', () => {
    assert.equal(closingTagFor('<div>', '</span>'), '</div>');
    assert.equal(closingTagFor('<div>', 'texto'), '</div>');
  });

  it('usa la última etiqueta abierta de la línea', () => {
    assert.equal(closingTagFor('<ul><li>', ''), '</li>');
  });

  it('no hace nada si la línea no termina en >', () => {
    assert.equal(closingTagFor('<div', ''), null);
    assert.equal(closingTagFor('<div class="a"', ''), null);
  });

  it('ignora un > que no cierra ninguna etiqueta', () => {
    assert.equal(closingTagFor('@if (a > b) {', ''), null);
    assert.equal(closingTagFor('=>', ''), null);
  });
});

describe('catálogo de directivas y snippets', () => {
  it('incluye las directivas esenciales de Blazor', () => {
    for (const directive of ['page', 'code', 'inject', 'rendermode', 'using', 'layout', 'typeparam']) {
      assert.ok(RAZOR_DIRECTIVES.includes(directive), `falta la directiva @${directive}`);
    }
  });

  it('los snippets tienen etiqueta, detalle y texto', () => {
    assert.ok(razorSnippets.length >= 10, `sólo hay ${razorSnippets.length} snippets`);

    for (const snippet of razorSnippets) {
      assert.ok(snippet.label.length > 0);
      assert.ok(snippet.detail.length > 0);
      assert.ok(snippet.insertText.length > 0);
    }
  });

  it('las etiquetas de snippet son únicas', () => {
    const labels = razorSnippets.map((snippet) => snippet.label);
    assert.equal(new Set(labels).size, labels.length);
  });

  it('los marcadores de posición de los snippets están bien formados', () => {
    for (const snippet of razorSnippets) {
      // Cada ${n:...} debe cerrarse; un snippet mal formado se inserta como texto literal.
      const opens = (snippet.insertText.match(/\$\{/g) ?? []).length;
      const closes = (snippet.insertText.match(/\}/g) ?? []).length;
      assert.ok(closes >= opens, `snippet "${snippet.label}" con placeholders sin cerrar`);
    }
  });
});

describe('lista de etiquetas void', () => {
  it('contiene las 14 etiquetas void de HTML', () => {
    assert.equal(VOID_ELEMENTS.size, 14);
  });

  it('no incluye etiquetas con contenido', () => {
    for (const tag of ['div', 'span', 'p', 'li', 'a']) {
      assert.equal(VOID_ELEMENTS.has(tag), false, `${tag} no es void`);
    }
  });
});
