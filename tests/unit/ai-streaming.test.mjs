/**
 * Prueba de extremo a extremo del cliente de streaming, contra un servidor de mentira.
 *
 * Cubre lo que las pruebas de las piezas sueltas no pueden cubrir: que la petición que se
 * construye se envía de verdad por HTTP, que los trozos que devuelve el servidor se convierten en
 * deltas en el orden correcto, que un error de red o un 401 terminan la conversación con un
 * mensaje accionable y que cancelar corta la conexión en lugar de limitarse a dejar de pintar.
 *
 * El servidor habla el protocolo de Ollama (NDJSON) porque es el único de los tres que no
 * necesita credenciales, así que la prueba no depende de ningún secreto ni gasta tokens. Para las
 * cabeceras de los otros dos ya están las aserciones de `ai-providers.test.mjs`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { aiChat, aiProbe, aiStatus, cancelAiRequest, coerceAiSettings, setCredentialSource } from '../../build/main-lib.mjs';

/** Lo que el próximo /api/chat debe hacer. Lo fija cada prueba antes de llamar. */
let behaviour = { mode: 'ok', chunks: [] };

let server;
let baseUrl;

/** Cabeceras y cuerpo de la última petición recibida, para poder aseverar sobre ellos. */
let lastRequest = null;

function ndjson(text, done = false, extra = {}) {
  return `${JSON.stringify({ message: { role: 'assistant', content: text }, done, ...extra })}\n`;
}

before(async () => {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);

    lastRequest = {
      url: request.url,
      headers: request.headers,
      body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    };

    if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: 'deepseek-coder:6.7b' }, { name: 'llama3.2' }] }));
      return;
    }

    if (behaviour.mode === 'unauthorized') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/x-ndjson' });

    for (const chunk of behaviour.chunks) {
      response.write(chunk);
      // Un respiro entre trozos: así llegan en lecturas distintas, como en la red real.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    if (behaviour.mode === 'hang') return; // Se deja la conexión abierta a propósito.
    response.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Ollama no usa credenciales; se inyecta una fuente vacía para dejarlo explícito.
  setCredentialSource({ get: () => null, configured: () => [] });
});

after(() => {
  // `closeAllConnections` no es opcional aquí: la prueba de cancelación deja adrede una respuesta
  // sin cerrar, y sin esto el proceso se queda esperando el `requestTimeout` del servidor, que por
  // defecto son cinco minutos. La suite pasaba en verde... y tardaba cinco minutos de más.
  server?.closeAllConnections();
  server?.close();
});

function settings(overrides = {}) {
  return coerceAiSettings({
    provider: 'ollama',
    providers: { ollama: { model: 'deepseek-coder:6.7b', baseUrl } },
    ...overrides,
  });
}

const request = (overrides = {}) => ({
  requestId: 'prueba-1',
  task: 'chat',
  messages: [{ role: 'user', content: '¿qué hace este método?' }],
  context: {
    architecture: 'hexagonal',
    solutionName: 'Acme.Shop',
    projects: [{ name: 'Acme.Shop.Domain', layer: 'Dominio' }],
    file: null,
    selection: null,
    diagnostics: [],
  },
  ...overrides,
});

/** Ejecuta una conversación completa y devuelve el texto recibido y el cierre. */
async function converse(chatRequest, chatSettings) {
  const deltas = [];
  let end = null;

  await aiChat(chatRequest, chatSettings, {
    onDelta: (payload) => deltas.push(payload),
    onEnd: (payload) => {
      end = payload;
    },
  });

  return { text: deltas.map((delta) => delta.text).join(''), deltas, end };
}

// ---------------------------------------------------------------------------------------------

describe('conversación completa contra un proveedor', () => {
  it('entrega el texto en trozos y cierra con el consumo', async () => {
    behaviour = {
      mode: 'ok',
      chunks: [
        ndjson('Este método '),
        ndjson('valida el SKU.'),
        ndjson('', true, { prompt_eval_count: 980, eval_count: 17 }),
      ],
    };

    const result = await converse(request(), settings());

    assert.equal(result.text, 'Este método valida el SKU.');
    assert.ok(result.deltas.length >= 2, 'la respuesta ha llegado de una sola pieza');
    assert.equal(result.deltas[0].requestId, 'prueba-1');
    assert.deepEqual(result.end, {
      requestId: 'prueba-1',
      reason: 'done',
      message: null,
      usage: { inputTokens: 980, outputTokens: 17 },
    });
  });

  /**
   * La invariante del módulo: las reglas de arquitectura las pone el proceso principal en cada
   * petición. Si esto deja de cumplirse, el asistente sigue respondiendo — y deja de ser un
   * asistente de arquitectura sin que nada falle.
   */
  it('el prompt de sistema lleva las reglas de la arquitectura detectada', async () => {
    behaviour = { mode: 'ok', chunks: [ndjson('ok', true)] };
    await converse(request(), settings());

    const system = lastRequest.body.messages[0];

    assert.equal(system.role, 'system');
    assert.match(system.content, /Puertos y Adaptadores/);
    assert.match(system.content, /EF Core/);
    assert.match(system.content, /Acme\.Shop\.Domain — Dominio/);
  });

  it('el contexto del IDE viaja dentro del último mensaje del usuario', async () => {
    behaviour = { mode: 'ok', chunks: [ndjson('ok', true)] };

    await converse(
      request({
        messages: [
          { role: 'user', content: 'primera' },
          { role: 'assistant', content: 'respuesta' },
          { role: 'user', content: 'y ahora esto' },
        ],
        context: {
          ...request().context,
          file: {
            path: 'C:/dev/Acme.Shop/src/Acme.Shop.Domain/Sku.cs',
            relativePath: 'src/Acme.Shop.Domain/Sku.cs',
            languageId: 'csharp',
            text: 'public sealed class Sku { }',
            truncated: false,
          },
        },
      }),
      settings(),
    );

    const messages = lastRequest.body.messages;
    const last = messages.at(-1);

    assert.equal(last.role, 'user');
    assert.match(last.content, /<contexto-del-ide>/);
    assert.match(last.content, /Sku\.cs/);
    assert.ok(last.content.trimEnd().endsWith('y ahora esto'));

    // Los turnos anteriores viajan tal cual: repetir el contexto en cada uno multiplicaría el
    // prompt sin aportar nada.
    assert.equal(messages[1].content, 'primera');
    assert.equal(/<contexto-del-ide>/.test(messages[1].content), false);
  });

  it('el modelo y el tope de tokens salen de las preferencias', async () => {
    behaviour = { mode: 'ok', chunks: [ndjson('ok', true)] };
    await converse(request(), settings({ maxTokens: 2048 }));

    assert.equal(lastRequest.body.model, 'deepseek-coder:6.7b');
    assert.equal(lastRequest.body.options.num_predict, 2048);
    assert.equal(lastRequest.url, '/api/chat');
  });
});

describe('caminos que se tuercen', () => {
  it('un 401 termina la conversación con un mensaje sobre la clave', async () => {
    behaviour = { mode: 'unauthorized', chunks: [] };
    const result = await converse(request(), settings());

    assert.equal(result.end.reason, 'error');
    assert.match(result.end.message, /clave de API/);
    assert.match(result.end.message, /invalid api key/);
  });

  it('un endpoint apagado explica qué hacer, no dice "fetch failed"', async () => {
    const dead = coerceAiSettings({
      provider: 'ollama',
      providers: { ollama: { model: 'llama3.2', baseUrl: 'http://127.0.0.1:1' } },
    });

    const result = await converse(request(), dead);

    assert.equal(result.end.reason, 'error');
    assert.match(result.end.message, /ollama serve/);
    assert.equal(/fetch failed/.test(result.end.message), false);
  });

  it('con el asistente desactivado ni se abre la conexión', async () => {
    const result = await converse(request(), settings({ enabled: false }));

    assert.equal(result.end.reason, 'error');
    assert.match(result.end.message, /desactivado/);
  });

  it('un error a mitad del stream conserva lo ya recibido y cierra en error', async () => {
    behaviour = {
      mode: 'ok',
      chunks: [ndjson('empiezo a responder'), `${JSON.stringify({ error: 'model runner crashed' })}\n`],
    };

    const result = await converse(request(), settings());

    assert.equal(result.text, 'empiezo a responder');
    assert.equal(result.end.reason, 'error');
    assert.match(result.end.message, /model runner crashed/);
  });

  /** Cancelar tiene que cortar la conexión de verdad: un stream vivo sigue costando dinero. */
  it('cancelar corta la petición y la cierra como cancelada', async () => {
    behaviour = { mode: 'hang', chunks: [ndjson('voy por aquí')] };

    const deltas = [];
    let end = null;

    const conversation = aiChat(request({ requestId: 'cancelable' }), settings(), {
      onDelta: (payload) => {
        deltas.push(payload);
        // En cuanto llega el primer trozo se cancela, como haría el botón Detener.
        cancelAiRequest('cancelable');
      },
      onEnd: (payload) => {
        end = payload;
      },
    });

    await conversation;

    assert.equal(deltas.length, 1);
    assert.equal(end.reason, 'cancelled');
    assert.equal(end.message, null);
  });
});

describe('comprobación de conexión y estado', () => {
  it('lista los modelos instalados del proveedor local', async () => {
    const result = await aiProbe(settings(), 'ollama');

    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ['deepseek-coder:6.7b', 'llama3.2']);
  });

  it('un endpoint inalcanzable devuelve un fallo explicado, no una excepción', async () => {
    const dead = coerceAiSettings({
      provider: 'ollama',
      providers: { ollama: { model: 'llama3.2', baseUrl: 'http://127.0.0.1:1' } },
    });

    const result = await aiProbe(dead, 'ollama');

    assert.equal(result.ok, false);
    assert.match(result.message, /Ollama/);
  });

  it('el estado dice si el proveedor está listo, y nunca devuelve la clave', () => {
    setCredentialSource({ get: (provider) => (provider === 'anthropic' ? 'sk-secreta' : null), configured: () => ['anthropic'] });

    const local = aiStatus(settings());
    assert.equal(local.ready, true, 'el proveedor local no necesita clave');

    const anthropic = aiStatus(coerceAiSettings({ provider: 'anthropic' }));
    assert.equal(anthropic.ready, true);
    assert.deepEqual(anthropic.configured, ['anthropic']);
    assert.equal(JSON.stringify(anthropic).includes('sk-secreta'), false, 'el estado filtra la clave');

    const openai = aiStatus(coerceAiSettings({ provider: 'openai' }));
    assert.equal(openai.ready, false);
    assert.match(openai.message, /Falta la clave/);

    setCredentialSource({ get: () => null, configured: () => [] });
  });
});
