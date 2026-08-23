/**
 * Pruebas del motor de sugerencias de la terminal.
 *
 * Es lógica pura sobre cadenas, con muchos casos borde: dónde acaba un token, cuándo hay que
 * ofrecer ramas y cuándo no, y qué texto fantasma corresponde a lo ya escrito. Justo el tipo de
 * reglas que se rompen sin que nadie se entere hasta que alguien pulsa Tab y aparece una tontería.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySuggestion,
  caretAfterApply,
  debugChannelTransition,
  detectListeningUrl,
  endsInsideQuotes,
  ghostText,
  portOf,
  splitLine,
  suggest,
  SUGGESTION_SOURCES,
} from '../../build/ui-lib.mjs';

const CONTEXT = {
  branches: ['main', 'feature/startup-bar', 'origin/main'],
  projects: ['C:/s/Api/Acme.WebApi.csproj'],
  programs: ['dotnet', 'git', 'npm', 'msbuild'],
};

const values = (list) => list.map((entry) => entry.value);

describe('troceo de la línea', () => {
  it('un espacio final empieza un token nuevo', () => {
    assert.deepEqual(splitLine('git '), { tokens: ['git'], typing: '' });
  });

  it('sin espacio final, el último token es el que se está escribiendo', () => {
    assert.deepEqual(splitLine('git st'), { tokens: ['git'], typing: 'st' });
  });

  it('la línea vacía no tiene tokens', () => {
    assert.deepEqual(splitLine(''), { tokens: [], typing: '' });
  });

  it('los espacios repetidos no crean tokens vacíos', () => {
    assert.deepEqual(splitLine('dotnet   add  package'), { tokens: ['dotnet', 'add'], typing: 'package' });
  });
});

describe('primer token: programas', () => {
  it('ofrece los programas conocidos', () => {
    const result = values(suggest('', CONTEXT));
    assert.ok(result.includes('dotnet'));
    assert.ok(result.includes('git'));
  });

  it('filtra por prefijo y mantiene el orden por frecuencia de uso', () => {
    // "do" casa con dotnet y docker; en un IDE de .NET, dotnet va primero.
    assert.deepEqual(values(suggest('do', CONTEXT)), ['dotnet', 'docker']);
    assert.deepEqual(values(suggest('gi', CONTEXT)), ['git']);
  });

  it('añade los permitidos por el proceso principal que no están en la lista base', () => {
    assert.ok(values(suggest('ms', CONTEXT)).includes('msbuild'));
  });

  it('un programa desconocido no sugiere nada', () => {
    assert.deepEqual(suggest('vim ', CONTEXT), []);
  });
});

describe('sugerencias de git', () => {
  it('"git " ofrece los subcomandos frecuentes, con status primero', () => {
    const result = values(suggest('git ', CONTEXT));
    assert.equal(result[0], 'status');
    for (const expected of ['commit -m ""', 'checkout -b', 'pull', 'push', 'switch', 'merge']) {
      assert.ok(result.includes(expected), `falta "${expected}"`);
    }
  });

  it('filtra los subcomandos por lo escrito', () => {
    assert.deepEqual(values(suggest('git pu', CONTEXT)), ['pull', 'push']);
  });

  it('"git checkout " y "git switch " ofrecen las ramas reales del repositorio', () => {
    assert.deepEqual(values(suggest('git checkout ', CONTEXT)), CONTEXT.branches);
    assert.deepEqual(values(suggest('git switch ', CONTEXT)), CONTEXT.branches);
    assert.deepEqual(values(suggest('git merge ', CONTEXT)), CONTEXT.branches);
  });

  it('distingue rama local de remota en el detalle', () => {
    const remota = suggest('git checkout origin/', CONTEXT).find((entry) => entry.value === 'origin/main');
    assert.equal(remota.detail, 'rama remota');
    assert.equal(remota.kind, 'branch');
  });

  it('filtra las ramas por prefijo', () => {
    assert.deepEqual(values(suggest('git switch fea', CONTEXT)), ['feature/startup-bar']);
  });

  it('"git checkout -b " no sugiere ramas: la rama todavía no existe', () => {
    assert.deepEqual(suggest('git checkout -b ', CONTEXT), []);
    assert.deepEqual(suggest('git switch -c ', CONTEXT), []);
  });

  it('sin repositorio no inventa ramas', () => {
    assert.deepEqual(suggest('git checkout ', { branches: [] }), []);
  });

  it('ofrece opciones útiles tras un subcomando conocido', () => {
    assert.ok(values(suggest('git push ', CONTEXT)).includes('--set-upstream origin'));
  });
});

describe('sugerencias de la CLI de .NET', () => {
  it('"dotnet " ofrece los subcomandos habituales', () => {
    const result = values(suggest('dotnet ', CONTEXT));
    for (const expected of ['build', 'run', 'test', 'watch', 'add package', 'ef migrations add']) {
      assert.ok(result.includes(expected), `falta "${expected}"`);
    }
  });

  it('filtra por prefijo, incluidos los compuestos', () => {
    assert.deepEqual(values(suggest('dotnet ef', CONTEXT)), [
      'ef migrations add',
      'ef database update',
      'ef migrations list',
    ]);
  });

  it('"dotnet add package " sugiere paquetes de uso habitual', () => {
    const result = values(suggest('dotnet add package ', CONTEXT));
    assert.ok(result.includes('Serilog.AspNetCore'));
    assert.ok(result.includes('Microsoft.EntityFrameworkCore.Design'));
  });

  it('los paquetes se filtran por prefijo sin distinguir mayúsculas', () => {
    assert.deepEqual(values(suggest('dotnet add package seri', CONTEXT)), ['Serilog.AspNetCore']);
  });

  it('"dotnet add " distingue package de reference', () => {
    assert.deepEqual(values(suggest('dotnet add ', CONTEXT)), ['package', 'reference']);
  });

  it('"dotnet run --project " sugiere los proyectos de la solución', () => {
    assert.deepEqual(values(suggest('dotnet run --project ', CONTEXT)), CONTEXT.projects);
  });

  it('"dotnet ef " ofrece los subcomandos de EF Core', () => {
    assert.ok(values(suggest('dotnet ef ', CONTEXT)).includes('migrations add'));
  });

  it('ofrece opciones tras un subcomando conocido', () => {
    assert.ok(values(suggest('dotnet test ', CONTEXT)).includes('--filter'));
  });
});

describe('texto fantasma', () => {
  it('es lo que falta por escribir de la primera sugerencia', () => {
    assert.equal(ghostText('git st', suggest('git st', CONTEXT)), 'atus');
  });

  it('con el token recién empezado, propone la sugerencia entera', () => {
    assert.equal(ghostText('git ', suggest('git ', CONTEXT)), 'status');
  });

  it('no hay fantasma si no hay sugerencias', () => {
    assert.equal(ghostText('vim ', []), null);
  });

  it('no hay fantasma si ya está escrito entero', () => {
    const sugerencia = [{ value: 'status', label: 'status', detail: '', kind: 'subcommand' }];
    assert.equal(ghostText('git status', sugerencia), null);
  });

  it('respeta las mayúsculas de lo escrito al comparar', () => {
    assert.equal(ghostText('dotnet add package Seri', suggest('dotnet add package Seri', CONTEXT)), 'log.AspNetCore');
  });
});

describe('aceptar una sugerencia', () => {
  it('sustituye el token en curso y deja un espacio para seguir', () => {
    const [primera] = suggest('git st', CONTEXT);
    assert.equal(applySuggestion('git st', primera), 'git status ');
  });

  it('completa desde un token vacío', () => {
    const [primera] = suggest('dotnet ', CONTEXT);
    assert.equal(applySuggestion('dotnet ', primera), 'dotnet build ');
  });

  it('conserva los tokens anteriores', () => {
    const sugerencia = { value: 'main', label: 'main', detail: '', kind: 'branch' };
    assert.equal(applySuggestion('git checkout ma', sugerencia), 'git checkout main ');
  });

  it('con comillas al final, el cursor se queda dentro', () => {
    const sugerencia = { value: 'commit -m ""', label: 'commit -m ""', detail: '', kind: 'subcommand' };
    const linea = applySuggestion('git co', sugerencia);

    assert.equal(linea, 'git commit -m ""');
    assert.equal(endsInsideQuotes(sugerencia.value), true);
    assert.equal(caretAfterApply(linea), linea.length - 1);
    assert.equal(linea[caretAfterApply(linea)], '"', 'el cursor queda justo antes de la comilla de cierre');
  });

  it('sin comillas, el cursor va al final', () => {
    assert.equal(caretAfterApply('git status '), 'git status '.length);
  });
});

describe('inventario de sugerencias', () => {
  it('no hay duplicados en ninguna lista', () => {
    for (const [nombre, lista] of Object.entries(SUGGESTION_SOURCES)) {
      assert.equal(new Set(lista).size, lista.length, `hay duplicados en ${nombre}`);
    }
  });

  it('los subcomandos de git y dotnet cubren lo que se usa a diario', () => {
    assert.ok(SUGGESTION_SOURCES.git.length >= 10);
    assert.ok(SUGGESTION_SOURCES.dotnet.length >= 10);
  });
});

describe('detección de la URL de la aplicación', () => {
  it('reconoce el mensaje de Kestrel', () => {
    assert.equal(detectListeningUrl('[INF] Now listening on: https://localhost:7156'), 'https://localhost:7156');
  });

  it('reconoce el mensaje traducido', () => {
    assert.equal(detectListeningUrl('Escuchando en: http://localhost:5000'), 'http://localhost:5000');
  });

  it('descarta direcciones que no se pueden abrir en un navegador', () => {
    assert.equal(detectListeningUrl('Now listening on: http://[::]:5000'), null);
    assert.equal(detectListeningUrl('Now listening on: http://0.0.0.0:5000'), null);
  });

  it('una línea normal no produce URL', () => {
    assert.equal(detectListeningUrl('Building...'), null);
    assert.equal(detectListeningUrl('Content root path: C:\\s\\Api'), null);
  });

  it('limpia la puntuación final', () => {
    assert.equal(detectListeningUrl('Now listening on: http://localhost:5001.'), 'http://localhost:5001');
  });

  it('extrae el puerto para enseñarlo compacto', () => {
    assert.equal(portOf('https://localhost:7156'), '7156');
    assert.equal(portOf('https://localhost:7156/scalar/v1'), '7156');
    assert.equal(portOf('https://example.com'), null);
  });
});

// ---------------------------------------------------------------------------------------------
// Docker, Azure y npm (v1.7.0)
// ---------------------------------------------------------------------------------------------

/** Contexto ampliado: lo que sólo puede saber el proceso principal. */
const CLOUD = {
  ...CONTEXT,
  programs: ['dotnet', 'git', 'npm', 'docker', 'az'],
  containers: ['acmeshop-sqlserver-1', 'acmeshop-redis-1'],
  images: ['redis:7-alpine', 'mcr.microsoft.com/mssql/server:2022-latest'],
  npmScripts: ['build', 'watch', 'test'],
};

describe('docker', () => {
  it('ofrece los subcomandos, con compose arriba del todo', () => {
    const result = values(suggest('docker ', CLOUD));
    assert.equal(result[0], 'compose up -d');
    assert.ok(result.includes('ps'));
    assert.ok(result.includes('logs -f'));
  });

  it('filtra por prefijo como el resto', () => {
    assert.deepEqual(values(suggest('docker com', CLOUD)), ['compose up -d', 'compose down']);
  });

  it('los comandos sobre un contenedor ofrecen los contenedores reales', () => {
    for (const line of ['docker logs ', 'docker exec ', 'docker stop ', 'docker rm ']) {
      const result = suggest(line, CLOUD);
      assert.deepEqual(values(result), CLOUD.containers, `falla en "${line}"`);
      assert.equal(result[0].kind, 'container');
    }
  });

  it('los comandos sobre una imagen ofrecen las imágenes locales', () => {
    const result = suggest('docker run ', CLOUD);
    assert.deepEqual(values(result), CLOUD.images);
    assert.equal(result[0].kind, 'image');
  });

  it('sin contexto de Docker no se inventa nada', () => {
    assert.deepEqual(suggest('docker logs ', CONTEXT), []);
  });

  it('`docker compose` tiene sus propios subcomandos', () => {
    const result = values(suggest('docker compose ', CLOUD));
    assert.ok(result.includes('up -d'));
    assert.ok(result.includes('down'));
    assert.ok(result.includes('logs -f'));
  });

  it('`docker compose logs` ofrece los servicios levantados', () => {
    assert.deepEqual(values(suggest('docker compose logs ', CLOUD)), CLOUD.containers);
  });
});

describe('az', () => {
  it('ofrece el camino de un desarrollador .NET', () => {
    const result = values(suggest('az ', CLOUD));
    assert.equal(result[0], 'login');
    assert.ok(result.includes('webapp up'));
    assert.ok(result.includes('group create'));
  });

  it('al escribir un grupo, ofrece sus operaciones', () => {
    const result = values(suggest('az webapp ', CLOUD));
    assert.ok(result.includes('up'));
    assert.ok(result.includes('log tail'));
    assert.equal(result.includes('login'), false, 'no debe mezclar operaciones de otro grupo');
  });

  it('un grupo desconocido no sugiere nada en vez de sugerir cualquier cosa', () => {
    assert.deepEqual(suggest('az cosmosdb ', CLOUD), []);
  });

  it('filtra por prefijo dentro del grupo', () => {
    assert.deepEqual(values(suggest('az group cr', CLOUD)), ['create --name']);
  });
});

describe('npm y node', () => {
  it('ofrece los subcomandos de npm', () => {
    const result = values(suggest('npm ', CLOUD));
    assert.equal(result[0], 'run');
    assert.ok(result.includes('install'));
  });

  it('`npm run` ofrece los scripts de este package.json, no una lista inventada', () => {
    const result = suggest('npm run ', CLOUD);
    assert.deepEqual(values(result), ['build', 'watch', 'test']);
    assert.equal(result[0].kind, 'script');
  });

  it('sin package.json no hay scripts que sugerir', () => {
    assert.deepEqual(suggest('npm run ', CONTEXT), []);
  });

  it('node ofrece sus banderas de uso diario', () => {
    const result = values(suggest('node --', CLOUD));
    assert.ok(result.includes('--test'));
    assert.ok(result.includes('--watch'));
  });

  it('el fantasma y la aceptación funcionan igual con las fuentes nuevas', () => {
    // Ya escrito entero: no hay fantasma que pintar, y eso se expresa con null, no con "".
    assert.equal(ghostText('docker ps', suggest('docker ps', CLOUD)), null);
    assert.equal(ghostText('docker p', suggest('docker p', CLOUD)), 's');
    assert.equal(applySuggestion('docker logs ', suggest('docker logs ', CLOUD)[0]), 'docker logs acmeshop-sqlserver-1 ');
  });
});

/**
 * Canal del proceso depurado (v1.8.1).
 *
 * El fallo que arregla esta regla se veía así: al lanzar un perfil de dos proyectos en modo
 * depuración, el canal de salida se llamaba "Compilación" y anunciaba el puerto de la aplicación
 * depurada —"Compilación :5013"—, mientras que el segundo proyecto sí tenía su canal con su
 * nombre. La causa no era el nombre del canal: era que `debug:start` **empieza parando** la sesión
 * anterior, ese `stop` emite `idle` antes de arrancar nada, y el canal recién abierto se cerraba
 * ahí mismo. A partir de ese momento la salida caía otra vez en el canal de compilación.
 */
describe('canal del proceso depurado', () => {
  it('el idle que emite el stop previo no cierra un canal recién abierto', () => {
    assert.deepEqual(debugChannelTransition(false, 'idle'), { active: false, close: 'none' });
  });

  it('la descarga de NetCoreDbg no cambia nada todavía', () => {
    assert.deepEqual(debugChannelTransition(false, 'acquiring'), { active: false, close: 'none' });
  });

  it('arrancar marca la sesión como viva', () => {
    for (const status of ['starting', 'running', 'paused']) {
      assert.deepEqual(debugChannelTransition(false, status), { active: true, close: 'none' }, status);
    }
  });

  it('el idle de después de una sesión sí la cierra, y en verde', () => {
    assert.deepEqual(debugChannelTransition(true, 'idle'), { active: false, close: 'ok' });
  });

  it('un error cierra el canal siempre: el canal se abre antes de arrancar', () => {
    assert.deepEqual(debugChannelTransition(false, 'error'), { active: false, close: 'failed' });
    assert.deepEqual(debugChannelTransition(true, 'error'), { active: false, close: 'failed' });
  });

  it('la secuencia real de un arranque deja el canal abierto hasta que se para', () => {
    let active = false;
    const closes = [];

    for (const status of ['idle', 'acquiring', 'starting', 'running', 'paused', 'running', 'idle']) {
      const transition = debugChannelTransition(active, status);
      active = transition.active;
      if (transition.close !== 'none') closes.push(transition.close);
    }

    // Un único cierre, y al final: el canal sobrevive a todo el arranque.
    assert.deepEqual(closes, ['ok']);
  });
});
