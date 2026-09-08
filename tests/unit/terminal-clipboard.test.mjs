/**
 * Pruebas del portapapeles de la terminal (Fase 28).
 *
 * El síntoma: `Ctrl+V` en la pestaña del símbolo del sistema pintaba `^V` y `Ctrl+C` con texto
 * seleccionado no copiaba nada. xterm manda las dos teclas al intérprete como U+0016 y U+0003 y
 * PowerShell disimulaba porque PSReadLine lee el portapapeles del sistema por su cuenta.
 *
 * Lo que se prueba es la decisión —qué gesto es cada tecla y cada clic— y no xterm ni el
 * portapapeles: las dos mitades que muerden son `Ctrl+C` con y sin selección, y que en macOS no se
 * toque nada.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keyboardGesture, managesClipboard, mouseGesture, RIGHT_BUTTON } from '../../build/ui-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function key(overrides) {
  return { type: 'keydown', key: 'c', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...overrides };
}

const windows = (hasSelection) => ({ platform: 'win32', hasSelection });
const linux = (hasSelection) => ({ platform: 'linux', hasSelection });
const mac = (hasSelection) => ({ platform: 'darwin', hasSelection });

describe('terminal-clipboard: Ctrl+C es dos cosas', () => {
  it('con selección, copia', () => {
    assert.equal(keyboardGesture(key({ key: 'c', ctrlKey: true }), windows(true)), 'copy');
  });

  it('sin selección, interrumpe: se deja pasar al intérprete', () => {
    assert.equal(keyboardGesture(key({ key: 'c', ctrlKey: true }), windows(false)), 'none');
  });

  it('Ctrl+Shift+C copia igual (convención de Linux), y sin selección tampoco hace nada', () => {
    assert.equal(keyboardGesture(key({ key: 'C', ctrlKey: true, shiftKey: true }), linux(true)), 'copy');
    assert.equal(keyboardGesture(key({ key: 'C', ctrlKey: true, shiftKey: true }), linux(false)), 'none');
  });

  it('una c sin Ctrl es una letra', () => {
    assert.equal(keyboardGesture(key({ key: 'c' }), windows(true)), 'none');
  });
});

describe('terminal-clipboard: pegar', () => {
  it('Ctrl+V pega haya o no selección', () => {
    assert.equal(keyboardGesture(key({ key: 'v', ctrlKey: true }), windows(false)), 'paste');
    assert.equal(keyboardGesture(key({ key: 'v', ctrlKey: true }), windows(true)), 'paste');
  });

  it('Ctrl+Shift+V también', () => {
    assert.equal(keyboardGesture(key({ key: 'V', ctrlKey: true, shiftKey: true }), linux(false)), 'paste');
  });

  it('Shift+Insert pega y Ctrl+Insert copia, la pareja clásica de Windows', () => {
    assert.equal(keyboardGesture(key({ key: 'Insert', shiftKey: true }), windows(false)), 'paste');
    assert.equal(keyboardGesture(key({ key: 'Insert', ctrlKey: true }), windows(true)), 'copy');
    assert.equal(keyboardGesture(key({ key: 'Insert', ctrlKey: true }), windows(false)), 'none');
    assert.equal(keyboardGesture(key({ key: 'Insert' }), windows(true)), 'none');
    assert.equal(keyboardGesture(key({ key: 'Insert', ctrlKey: true, shiftKey: true }), windows(true)), 'none');
  });
});

describe('terminal-clipboard: lo que no es un gesto', () => {
  it('sólo cuenta keydown: xterm pasa keypress y keyup por el mismo manejador y pegaría dos veces', () => {
    assert.equal(keyboardGesture(key({ type: 'keyup', key: 'v', ctrlKey: true }), windows(false)), 'none');
    assert.equal(keyboardGesture(key({ type: 'keypress', key: 'v', ctrlKey: true }), windows(false)), 'none');
  });

  it('con Alt o con la tecla de sistema no se interpreta nada', () => {
    assert.equal(keyboardGesture(key({ key: 'v', ctrlKey: true, altKey: true }), windows(false)), 'none');
    assert.equal(keyboardGesture(key({ key: 'c', ctrlKey: true, metaKey: true }), windows(true)), 'none');
  });

  it('otras letras con Ctrl llegan al intérprete: Ctrl+L, Ctrl+D, Ctrl+Z', () => {
    for (const letter of ['l', 'd', 'z', 'a', 'x']) {
      assert.equal(keyboardGesture(key({ key: letter, ctrlKey: true }), windows(true)), 'none', letter);
    }
  });
});

describe('terminal-clipboard: macOS no se toca', () => {
  it('el IDE no gestiona el portapapeles en darwin: lo hacen los role del menú con Cmd', () => {
    assert.equal(managesClipboard('darwin'), false);
    assert.equal(managesClipboard('win32'), true);
    assert.equal(managesClipboard('linux'), true);
  });

  it('Ctrl+C en un Mac es siempre interrumpir, incluso con selección', () => {
    assert.equal(keyboardGesture(key({ key: 'c', ctrlKey: true }), mac(true)), 'none');
    assert.equal(keyboardGesture(key({ key: 'v', ctrlKey: true }), mac(false)), 'none');
    assert.equal(keyboardGesture(key({ key: 'Insert', shiftKey: true }), mac(false)), 'none');
  });

  it('el botón secundario tampoco significa nada fuera de Windows', () => {
    assert.equal(mouseGesture(RIGHT_BUTTON, mac(true)), 'none');
    assert.equal(mouseGesture(RIGHT_BUTTON, linux(false)), 'none');
  });
});

describe('terminal-clipboard: botón secundario en Windows', () => {
  it('con selección copia; sin ella pega', () => {
    assert.equal(mouseGesture(RIGHT_BUTTON, windows(true)), 'copy');
    assert.equal(mouseGesture(RIGHT_BUTTON, windows(false)), 'paste');
  });

  it('los demás botones se dejan a xterm', () => {
    assert.equal(mouseGesture(0, windows(false)), 'none');
    assert.equal(mouseGesture(1, windows(false)), 'none');
  });
});

describe('terminal-clipboard: estructura', () => {
  it('las pestañas de pseudoterminal enganchan el portapapeles al crearse', () => {
    const panel = readFileSync(join(root, 'src', 'renderer', 'views', 'panel.ts'), 'utf8');
    assert.match(panel, /attachClipboard\(created\.term, host,/);
  });

  it('el gesto atendido llama a preventDefault: sin eso el role del menú pega otra vez', () => {
    const bridge = readFileSync(join(root, 'src', 'renderer', 'xterm-bridge.ts'), 'utf8');
    const handler = bridge.slice(bridge.indexOf('attachCustomKeyEventHandler((event)'));
    assert.match(handler, /event\.preventDefault\(\);\s*perform\(gesture\);\s*return false;/);
  });

  it('el portapapeles viaja por IPC y el renderer no usa navigator.clipboard: la ventana deniega ese permiso', () => {
    const preload = readFileSync(join(root, 'src', 'main', 'preload.ts'), 'utf8');
    assert.match(preload, /IPC\.clipboardReadText/);
    assert.match(preload, /IPC\.clipboardWriteText/);
    for (const file of ['xterm-bridge.ts', join('views', 'panel.ts')]) {
      const source = readFileSync(join(root, 'src', 'renderer', file), 'utf8');
      assert.doesNotMatch(source, /navigator\.clipboard/, file);
    }
  });
});
