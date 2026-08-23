/**
 * Pruebas del conmutador de estado del asistente de IA.
 *
 * La regla es de producto y tiene tres estados que se confunden con facilidad: apagado en
 * Ajustes, encendido pero sin credencial, y listo. Sólo el primero bloquea la navegación, y el
 * segundo **no debe bloquearla** porque el panel del asistente es justo donde se explica qué
 * falta. Una prueba aquí es más barata que descubrir a mano que el icono no responde.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { aiActionBlockedReason, aiEntryState, AI_DISABLED_MESSAGE } from '../../build/ui-lib.mjs';
import { coerceAiSettings, DEFAULT_SETTINGS } from '../../build/main-lib.mjs';

describe('aiEntryState', () => {
  it('apagado: visible, atenuado, sin navegación y con el mensaje exacto', () => {
    const state = aiEntryState(false, false);

    assert.equal(state.disabled, true);
    assert.equal(state.navigates, false);
    assert.match(state.className, /\bdisabled\b/);
    assert.equal(
      state.title,
      'El asistente de IA está deshabilitado. Puedes activarlo desde la configuración',
    );
  });

  it('apagado con credencial guardada sigue apagado', () => {
    const state = aiEntryState(false, true);

    assert.equal(state.navigates, false);
    assert.equal(state.title, AI_DISABLED_MESSAGE);
  });

  it('encendido sin credencial navega igual: el panel es donde se arregla', () => {
    const state = aiEntryState(true, false);

    assert.equal(state.disabled, false);
    assert.equal(state.navigates, true);
    assert.match(state.title, /clave de API/);
    assert.equal(/\bdisabled\b/.test(state.className), false);
  });

  it('listo: comportamiento normal', () => {
    const state = aiEntryState(true, true);

    assert.equal(state.disabled, false);
    assert.equal(state.navigates, true);
    assert.equal(state.title, 'DotForge AI Assistant');
    assert.equal(state.className, 'activity-item');
  });
});

describe('aiActionBlockedReason', () => {
  it('apagado bloquea con el mensaje de la configuración', () => {
    assert.equal(aiActionBlockedReason(false, true), AI_DISABLED_MESSAGE);
  });

  it('sin credencial bloquea la acción, pero con otro motivo', () => {
    const reason = aiActionBlockedReason(true, false);
    assert.notEqual(reason, null);
    assert.notEqual(reason, AI_DISABLED_MESSAGE);
  });

  it('listo no bloquea nada', () => {
    assert.equal(aiActionBlockedReason(true, true), null);
  });
});

describe('la preferencia que gobierna el icono', () => {
  it('el asistente viene activado de fábrica', () => {
    assert.equal(DEFAULT_SETTINGS.ai.enabled, true);
    assert.equal(aiEntryState(DEFAULT_SETTINGS.ai.enabled, false).navigates, true);
  });

  it('un settings.json con el asistente apagado se respeta', () => {
    const settings = coerceAiSettings({ enabled: false });

    assert.equal(settings.enabled, false);
    assert.equal(aiEntryState(settings.enabled, true).disabled, true);
  });

  it('un valor corrupto no apaga el asistente por accidente', () => {
    assert.equal(coerceAiSettings({ enabled: 'no' }).enabled, true);
    assert.equal(coerceAiSettings(null).enabled, true);
  });
});
