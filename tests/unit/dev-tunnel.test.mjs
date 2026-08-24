/**
 * Pruebas del túnel público.
 *
 * Lo que de verdad se prueba aquí es el reconocimiento de la URL, y por dos motivos:
 *
 *  1. **Llega una sola vez.** Si se pierde, el túnel está abierto y nadie sabe a dónde apuntar.
 *  2. **Llega troceada.** Los trozos de un stream no respetan los límites de línea, así que
 *     `Connect via browser: https://abc-50` es una lectura perfectamente normal — y una URL
 *     truncada dada por buena es peor que ninguna. Se prueba troceando la salida byte a byte.
 *
 * La salida de ejemplo es la real de las dos herramientas, con su ruido: la de `devtunnel` trae
 * después la URL del inspector, que **no** es el destino del webhook.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectTunnelUrl,
  isValidPort,
  missingToolMessage,
  TUNNEL_TOOLS,
  TUNNEL_WARNING,
  TunnelOutputScanner,
  tunnelArgs,
  tunnelInfo,
} from '../../build/ui-lib.mjs';

const DEVTUNNEL_OUTPUT = `Hosting port: 5183
Connect via browser: https://a1b2c3d4-5183.euw.devtunnels.ms
Inspect network activity: https://a1b2c3d4-5183-inspect.euw.devtunnels.ms

Ready to accept connections for tunnel: happy-tunnel-9k2
`;

const NGROK_OUTPUT = `t=2026-08-24T10:00:00+0200 lvl=info msg="no configuration paths supplied"
t=2026-08-24T10:00:01+0200 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:5183 url=https://1f2e-88-14-3-9.ngrok-free.app
`;

describe('catálogo de herramientas', () => {
  it('declara devtunnel y ngrok con su orden de instalación', () => {
    assert.deepEqual(TUNNEL_TOOLS.map((entry) => entry.id), ['devtunnel', 'ngrok']);

    for (const entry of TUNNEL_TOOLS) {
      assert.ok(entry.install.length > 5, entry.id);
      assert.match(entry.docs, /^https:\/\//);
    }
  });

  it('tunnelInfo devuelve la herramienta pedida', () => {
    assert.equal(tunnelInfo('ngrok').command, 'ngrok');
    assert.equal(tunnelInfo('devtunnel').command, 'devtunnel');
  });

  it('el mensaje de herramienta ausente dice cómo instalarla', () => {
    assert.match(missingToolMessage('devtunnel'), /winget install/);
  });

  it('el aviso de exposición existe y menciona internet', () => {
    assert.match(TUNNEL_WARNING, /internet/i);
  });
});

describe('isValidPort', () => {
  it('acepta un puerto real', () => {
    assert.equal(isValidPort(5183), true);
    assert.equal(isValidPort(1), true);
    assert.equal(isValidPort(65535), true);
  });

  it('rechaza lo que no es un puerto', () => {
    for (const value of [0, -1, 65536, 1.5, '5000', null, undefined, NaN]) {
      assert.equal(isValidPort(value), false, String(value));
    }
  });
});

describe('tunnelArgs', () => {
  it('devtunnel publica sin autenticación, que es lo que necesita un webhook', () => {
    assert.deepEqual(tunnelArgs('devtunnel', 5183), ['host', '-p', '5183', '--allow-anonymous']);
  });

  it('ngrok escribe a stdout: sin eso la URL nunca llega como texto', () => {
    assert.deepEqual(tunnelArgs('ngrok', 5183), ['http', '5183', '--log=stdout', '--log-format=logfmt']);
  });

  it('un puerto no válido no llega a construir argumentos', () => {
    assert.throws(() => tunnelArgs('ngrok', 0), /puerto no válido/);
  });
});

describe('detectTunnelUrl', () => {
  it('reconoce la URL de Dev Tunnels', () => {
    assert.equal(
      detectTunnelUrl('Connect via browser: https://a1b2c3d4-5183.euw.devtunnels.ms'),
      'https://a1b2c3d4-5183.euw.devtunnels.ms',
    );
  });

  it('reconoce la URL de ngrok dentro de una línea logfmt', () => {
    assert.equal(
      detectTunnelUrl('t=… msg="started tunnel" addr=http://localhost:5183 url=https://1f2e-88-14-3-9.ngrok-free.app'),
      'https://1f2e-88-14-3-9.ngrok-free.app',
    );
  });

  it('descarta la URL del inspector, que no es a donde apunta el webhook', () => {
    assert.equal(detectTunnelUrl('Inspect network activity: https://x-5183-inspect.euw.devtunnels.ms'), null);
  });

  it('no confunde localhost ni la documentación con un túnel', () => {
    assert.equal(detectTunnelUrl('Forwarding to https://localhost:5183'), null);
    assert.equal(detectTunnelUrl('Más información en https://ngrok.com/docs'), null);
    assert.equal(detectTunnelUrl('Hosting port: 5183'), null);
  });

  it('quita la puntuación final pegada a la URL', () => {
    assert.equal(
      detectTunnelUrl('Listo en https://a1b2-5183.euw.devtunnels.ms.'),
      'https://a1b2-5183.euw.devtunnels.ms',
    );
  });
});

describe('TunnelOutputScanner', () => {
  it('encuentra la URL en la salida de devtunnel', () => {
    const scanner = new TunnelOutputScanner();
    assert.equal(scanner.push(DEVTUNNEL_OUTPUT), 'https://a1b2c3d4-5183.euw.devtunnels.ms');
    assert.equal(scanner.url(), 'https://a1b2c3d4-5183.euw.devtunnels.ms');
  });

  it('encuentra la URL en la salida de ngrok', () => {
    const scanner = new TunnelOutputScanner();
    assert.equal(scanner.push(NGROK_OUTPUT), 'https://1f2e-88-14-3-9.ngrok-free.app');
  });

  it('sobrevive a que el stream llegue carácter a carácter', () => {
    const scanner = new TunnelOutputScanner();
    let found = null;

    for (const character of DEVTUNNEL_OUTPUT) {
      found = scanner.push(character) ?? found;
    }

    assert.equal(found, 'https://a1b2c3d4-5183.euw.devtunnels.ms');
  });

  it('no da por buena una URL cortada a mitad de trozo', () => {
    const scanner = new TunnelOutputScanner();
    assert.equal(scanner.push('Connect via browser: https://a1b2c3d4-51'), null);
    assert.equal(scanner.push('83.euw.devtunnels.ms\n'), 'https://a1b2c3d4-5183.euw.devtunnels.ms');
  });

  it('sólo devuelve la URL la primera vez', () => {
    const scanner = new TunnelOutputScanner();
    scanner.push(DEVTUNNEL_OUTPUT);
    assert.equal(scanner.push(DEVTUNNEL_OUTPUT), null);
  });

  it('reset lo deja como nuevo para el siguiente túnel', () => {
    const scanner = new TunnelOutputScanner();
    scanner.push(DEVTUNNEL_OUTPUT);
    scanner.reset();

    assert.equal(scanner.url(), null);
    assert.equal(scanner.push(NGROK_OUTPUT), 'https://1f2e-88-14-3-9.ngrok-free.app');
  });
});
