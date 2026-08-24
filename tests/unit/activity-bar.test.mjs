/**
 * Pruebas del orden de la barra de actividad.
 *
 * Lo que se guarda en las preferencias es una lista de identificadores escrita por una versión del
 * IDE y leída por otra —y editable a mano—, así que las dos operaciones tienen casos borde de
 * verdad: normalizar lo que hay guardado, y mover una herramienta de sitio.
 *
 * Hay una tercera prueba, estructural, que vigila lo que ya se ha roto dos veces: que los modos de
 * diagnóstico `--ui=` pulsen los iconos por identificador y no por posición.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVITY_TOOLS,
  DEFAULT_ACTIVITY_ORDER,
  isActivityTool,
  isDefaultActivityOrder,
  moveActivityTool,
  normalizeActivityOrder,
  PINNED_ACTIVITY_TOOL,
} from '../../build/ui-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('identificadores de herramienta', () => {
  it('el orden de fábrica contiene todas las herramientas, una vez', () => {
    assert.deepEqual([...DEFAULT_ACTIVITY_ORDER].sort(), [...ACTIVITY_TOOLS].sort());
    assert.equal(new Set(DEFAULT_ACTIVITY_ORDER).size, ACTIVITY_TOOLS.length);
  });

  it('"Ajustes" no es reordenable: vive bajo el separador', () => {
    assert.equal(PINNED_ACTIVITY_TOOL, 'settings');
    assert.equal(ACTIVITY_TOOLS.includes('settings'), false);
  });

  it('reconoce lo que es una herramienta y lo que no', () => {
    assert.equal(isActivityTool('nuget'), true);
    assert.equal(isActivityTool('settings'), false, 'ajustes no se mueve');
    assert.equal(isActivityTool('minecraft'), false);
    assert.equal(isActivityTool(3), false);
    assert.equal(isActivityTool(null), false);
  });
});

describe('normalizar lo que hay guardado', () => {
  it('sin nada guardado, el orden de fábrica', () => {
    assert.deepEqual(normalizeActivityOrder(undefined), [...DEFAULT_ACTIVITY_ORDER]);
    assert.deepEqual(normalizeActivityOrder(null), [...DEFAULT_ACTIVITY_ORDER]);
    assert.deepEqual(normalizeActivityOrder([]), [...DEFAULT_ACTIVITY_ORDER]);
  });

  it('lo que no es una lista tampoco rompe nada', () => {
    for (const value of ['git,nuget', 42, { order: ['git'] }, true]) {
      assert.deepEqual(normalizeActivityOrder(value), [...DEFAULT_ACTIVITY_ORDER]);
    }
  });

  it('respeta el orden guardado', () => {
    const saved = ['git', 'nuget', 'explorer'];
    const order = normalizeActivityOrder(saved);
    assert.deepEqual(order.slice(0, 3), saved);
  });

  /**
   * El caso que hace falta que funcione al actualizar el IDE: un orden escrito por una versión que
   * no conocía todavía "extensiones" tiene que dar una barra **completa**, con la herramienta nueva
   * al final. Una barra a la que le falta un icono porque el archivo venía de antes es un icono que
   * desaparece sin explicación.
   */
  it('completa lo que falta, al final', () => {
    const order = normalizeActivityOrder(['git', 'explorer']);

    assert.equal(order.length, ACTIVITY_TOOLS.length);
    assert.deepEqual(order.slice(0, 2), ['git', 'explorer']);
    for (const tool of ACTIVITY_TOOLS) assert.ok(order.includes(tool), `falta ${tool}`);
  });

  it('descarta identificadores desconocidos y repetidos', () => {
    const order = normalizeActivityOrder(['git', 'git', 'minecraft', null, 7, 'nuget']);

    assert.deepEqual(order.slice(0, 2), ['git', 'nuget']);
    assert.equal(order.length, ACTIVITY_TOOLS.length);
    assert.equal(order.includes('minecraft'), false);
  });

  it('un orden que incluye "settings" lo descarta: no se reordena', () => {
    assert.equal(normalizeActivityOrder(['settings', 'git']).includes('settings'), false);
  });
});

describe('mover una herramienta de sitio', () => {
  const order = ['explorer', 'git', 'wizard', 'nuget'];

  it('hacia abajo la deja donde estaba el destino', () => {
    assert.deepEqual(moveActivityTool(order, 'explorer', 'wizard'), ['git', 'wizard', 'explorer', 'nuget']);
  });

  it('hacia arriba la deja delante del destino', () => {
    assert.deepEqual(moveActivityTool(order, 'nuget', 'git'), ['explorer', 'nuget', 'git', 'wizard']);
  });

  it('al primer sitio', () => {
    assert.deepEqual(moveActivityTool(order, 'nuget', 'explorer'), ['nuget', 'explorer', 'git', 'wizard']);
  });

  it('al último', () => {
    assert.deepEqual(moveActivityTool(order, 'explorer', 'nuget'), ['git', 'wizard', 'nuget', 'explorer']);
  });

  it('nunca pierde ni duplica una herramienta', () => {
    for (const dragged of order) {
      for (const target of order) {
        const moved = moveActivityTool(order, dragged, target);
        assert.deepEqual([...moved].sort(), [...order].sort(), `${dragged} -> ${target}`);
      }
    }
  });

  /**
   * Devolver el mismo array por referencia no es un detalle: es lo que le permite al renderer
   * distinguir un arrastre que ha cambiado algo de uno que ha acabado donde empezó, y ahorrarse
   * escribir las preferencias por nada.
   */
  it('un arrastre que no mueve nada devuelve el mismo array', () => {
    assert.equal(moveActivityTool(order, 'git', 'git'), order);
    assert.equal(moveActivityTool(order, 'minecraft', 'git'), order);
    assert.equal(moveActivityTool(order, 'git', 'minecraft'), order);
    assert.equal(moveActivityTool(order, 'git', 'extensions'), order, 'el destino no está en esta barra');
  });
});

describe('reconocer el orden de fábrica', () => {
  it('lo distingue de uno personalizado', () => {
    assert.equal(isDefaultActivityOrder(DEFAULT_ACTIVITY_ORDER), true);
    assert.equal(isDefaultActivityOrder(moveActivityTool(DEFAULT_ACTIVITY_ORDER, 'git', 'explorer')), false);
    assert.equal(isDefaultActivityOrder([]), false);
    assert.equal(isDefaultActivityOrder(DEFAULT_ACTIVITY_ORDER.slice(0, -1)), false);
  });
});

/**
 * Los modos de diagnóstico ya no pueden pulsar por posición.
 *
 * Los índices posicionales sobre `.activity-item` se rompieron en silencio dos veces al añadir una
 * herramienta —Fase 15 y Fase 17, las dos anotadas en `CLAUDE.md`—, y ahora además el usuario puede
 * reordenar la barra: no hay ninguna posición que se pueda dar por buena.
 */
describe('los modos de diagnóstico pulsan por identificador', () => {
  const main = readFileSync(join(root, 'src', 'main', 'main.ts'), 'utf8');
  const renderer = readFileSync(join(root, 'src', 'renderer', 'index.ts'), 'utf8');

  it('ningún `--ui=` indexa `.activity-item` por posición', () => {
    assert.doesNotMatch(main, /querySelectorAll\('\.activity-item'\)\[\d+\]/);
  });

  it('los selectores apuntan a herramientas que existen', () => {
    const used = [...main.matchAll(/\.activity-item\[data-tool-id=(\w+)\]/g)].map((match) => match[1]);

    assert.ok(used.length >= 10, `sólo ${used.length} selectores por identificador`);
    for (const id of new Set(used)) {
      assert.ok(isActivityTool(id) || id === PINNED_ACTIVITY_TOOL, `${id} no es una herramienta de la barra`);
    }
  });

  it('el renderer pone el atributo en cada botón', () => {
    assert.match(renderer, /'data-tool-id': id/);
  });
});
