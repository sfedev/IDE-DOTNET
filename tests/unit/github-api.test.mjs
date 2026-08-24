/**
 * Pruebas de las cabeceras del toolchain y del alcance del token de GitHub.
 *
 * El adquisidor del depurador y el del servidor de lenguaje consultan la API de GitHub, que sin
 * autenticar permite 60 peticiones por hora **y por IP**: en un runner compartido eso es un 403
 * permanente, y es exactamente lo que rompió la suite al publicar el tag v2.1.0.
 *
 * Autenticar la consulta arregla el límite y mete una credencial en el proceso, así que lo que se
 * prueba aquí no es sólo que el token se envíe cuando toca, sino sobre todo **que no salga hacia
 * ningún otro sitio**: ni al feed de Azure de Roslyn, ni al CDN que sirve los artefactos, ni a un
 * host que sólo se parezca al bueno, ni al saltar un redirect.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  githubToken,
  GITHUB_ACCEPT,
  GITHUB_API_HOST,
  isGitHubApi,
  rateLimitHint,
  requestHeaders,
  USER_AGENT,
} from '../../build/toolchain.mjs';

const TOKEN = 'ghp_tokenDePrueba1234567890';

/** URLs reales que pide el toolchain, con lo que debe pasar con la credencial en cada una. */
const ENDPOINTS = [
  { url: 'https://api.github.com/repos/Samsung/netcoredbg/releases/latest', authenticated: true },
  { url: 'https://api.github.com/repos/OmniSharp/omnisharp-roslyn/releases/latest', authenticated: true },
  // Artefactos: los sirve el almacén de GitHub, que no es la API.
  { url: 'https://objects.githubusercontent.com/github-production-release-asset/1/netcoredbg.zip', authenticated: false },
  { url: 'https://github.com/Samsung/netcoredbg/releases/download/3.1.2/netcoredbg-win64.zip', authenticated: false },
  // Feed de Azure donde Microsoft publica el servidor de Roslyn.
  {
    url: 'https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/flat2/microsoft.codeanalysis.languageserver.win-x64/index.json',
    authenticated: false,
  },
  // Registro de extensiones y su almacén.
  { url: 'https://open-vsx.org/api/-/search?query=csharp', authenticated: false },
  { url: 'https://openvsxorg.blob.core.windows.net/resources/x.vsix', authenticated: false },
];

describe('lectura del token del entorno', () => {
  it('acepta GITHUB_TOKEN, que es el que inyecta Actions', () => {
    assert.equal(githubToken({ GITHUB_TOKEN: TOKEN }), TOKEN);
  });

  it('acepta GH_TOKEN, que es el de la CLI de GitHub', () => {
    assert.equal(githubToken({ GH_TOKEN: TOKEN }), TOKEN);
  });

  it('GITHUB_TOKEN gana si están los dos', () => {
    assert.equal(githubToken({ GITHUB_TOKEN: TOKEN, GH_TOKEN: 'otro' }), TOKEN);
  });

  it('sin token en el entorno devuelve null, que es el caso normal fuera de CI', () => {
    assert.equal(githubToken({}), null);
  });

  it('una variable vacía o con espacios no es un token', () => {
    assert.equal(githubToken({ GITHUB_TOKEN: '' }), null);
    assert.equal(githubToken({ GITHUB_TOKEN: '   ' }), null);
  });
});

describe('reconocimiento de la API de GitHub', () => {
  it('reconoce el host exacto por HTTPS', () => {
    assert.equal(isGitHubApi(`https://${GITHUB_API_HOST}/repos/x/y/releases/latest`), true);
  });

  it('no distingue mayúsculas en el host, porque el DNS tampoco', () => {
    assert.equal(isGitHubApi('https://API.GitHub.COM/repos/x/y'), true);
  });

  /** Contener el host bueno no es ser el host bueno. */
  it('rechaza un host que sólo se le parece', () => {
    for (const url of [
      'https://api.github.com.malo.dev/repos/x/y',
      'https://malo.dev/api.github.com/repos/x/y',
      'https://api.github.com.evil/repos',
      'https://notapi.github.com/repos',
    ]) {
      assert.equal(isGitHubApi(url), false, `debería rechazar ${url}`);
    }
  });

  it('rechaza un subdominio: la credencial es para el host, no para el árbol', () => {
    assert.equal(isGitHubApi('https://uploads.api.github.com/repos'), false);
  });

  it('rechaza HTTP: mandar una credencial en claro es regalarla', () => {
    assert.equal(isGitHubApi('http://api.github.com/repos/x/y'), false);
  });

  it('rechaza lo que no es una URL', () => {
    assert.equal(isGitHubApi('no es una url'), false);
    assert.equal(isGitHubApi(''), false);
  });
});

describe('cabeceras de las peticiones', () => {
  it('toda petición se identifica y declara qué formato espera', () => {
    const headers = requestHeaders('https://ejemplo.dev/x', { token: null });
    assert.equal(headers['User-Agent'], USER_AGENT);
    assert.equal(headers['Accept'], GITHUB_ACCEPT);
  });

  it('el tipo de medio se puede fijar por petición', () => {
    const headers = requestHeaders('https://ejemplo.dev/x.zip', {
      accept: 'application/octet-stream',
      token: null,
    });
    assert.equal(headers['Accept'], 'application/octet-stream');
  });

  it('con token, la API de GitHub lleva Authorization', () => {
    const headers = requestHeaders('https://api.github.com/repos/x/y/releases/latest', { token: TOKEN });
    assert.equal(headers['Authorization'], `Bearer ${TOKEN}`);
  });

  it('sin token no hay Authorization, y todo lo demás sigue igual', () => {
    const headers = requestHeaders('https://api.github.com/repos/x/y/releases/latest', { token: null });
    assert.equal('Authorization' in headers, false);
    assert.equal(headers['User-Agent'], USER_AGENT);
  });

  /**
   * El corazón de la medida: el token viaja a la API y **a ningún otro sitio**. Se comprueba sobre
   * las URLs reales que pide el toolchain, no sobre ejemplos inventados.
   */
  it('el token sólo se adjunta a la API de GitHub, nunca a un tercero', () => {
    for (const { url, authenticated } of ENDPOINTS) {
      const headers = requestHeaders(url, { token: TOKEN, accept: 'application/octet-stream' });
      assert.equal(
        'Authorization' in headers,
        authenticated,
        `${url}: se esperaba ${authenticated ? 'con' : 'SIN'} credencial`,
      );
    }
  });

  it('ninguna cabecera lleva el token cuando el destino no es la API', () => {
    for (const { url, authenticated } of ENDPOINTS) {
      if (authenticated) continue;
      const serialized = JSON.stringify(requestHeaders(url, { token: TOKEN }));
      assert.equal(serialized.includes(TOKEN), false, `${url} filtra el token: ${serialized}`);
    }
  });
});

describe('explicación del límite de peticiones', () => {
  it('un 403 sin token dice que es el límite por IP y cómo salir de él', () => {
    assert.match(rateLimitHint(403, false), /GITHUB_TOKEN/);
  });

  it('un 403 con token no propone poner un token que ya está puesto', () => {
    assert.doesNotMatch(rateLimitHint(403, true), /GITHUB_TOKEN/);
  });

  it('un 404 no es un límite y no se disfraza de uno', () => {
    assert.equal(rateLimitHint(404, false), null);
    assert.equal(rateLimitHint(200, false), null);
  });
});

/**
 * Redirecciones.
 *
 * La descarga de un artefacto de GitHub **siempre** salta de un host a otro, así que la garantía de
 * que una credencial no cruza ese salto no puede quedarse en una revisión a ojo. Se levantan dos
 * servidores en puertos distintos —dos orígenes distintos— y se comprueba qué llega al segundo.
 */
describe('una redirección no arrastra la credencial', () => {
  const servers = [];

  after(async () => {
    for (const server of servers) {
      // Sin esto, `close()` espera al requestTimeout (300 s por defecto) y la suite tarda cinco
      // minutos en salir aunque esté en verde.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  function listen(handler) {
    const server = createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
  }

  it('el segundo salto no recibe Authorization', async () => {
    const received = [];

    const destino = await listen((request, response) => {
      received.push(request.headers.authorization ?? null);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });

    const origen = await listen((request, response) => {
      received.push(request.headers.authorization ?? null);
      response.writeHead(302, { location: `${destino}/artefacto.zip` });
      response.end();
    });

    const response = await fetch(`${origen}/redirige`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');

    assert.equal(received.length, 2, 'no se han registrado los dos saltos');
    assert.equal(received[0], `Bearer ${TOKEN}`, 'el primer salto sí debía llevarla');
    assert.equal(received[1], null, 'la credencial ha cruzado a otro origen en la redirección');
  });
});
