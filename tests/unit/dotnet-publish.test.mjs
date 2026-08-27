/**
 * Pruebas del modelo de publicación.
 *
 * Lo que se vigila aquí es lo que hace que una publicación salga distinta de lo que se pidió sin
 * que nada falle:
 *
 *  - `PublishSingleFile` sin RID: el SDK publica un directorio normal y quien esperaba un `.exe`
 *    único se queda mirando una carpeta con doscientos archivos. Ninguna de las dos banderas puede
 *    emitirse sin `--runtime`.
 *  - Las preferencias guardadas de la vez anterior: traen la casilla encendida con un modo que ya
 *    no la admite, y una bandera que se emite y no hace nada es peor que no ofrecerla.
 *  - La ruta de salida: `-o out/` y `-o  out` no son lo que el usuario escribió, y la carpeta que
 *    se abre al terminar tiene que ser la misma que se le pasó a `dotnet`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  coercePublishOptions,
  DEFAULT_PUBLISH_OPTIONS,
  describePublish,
  disabledReason,
  effectiveRuntime,
  isSelfContained,
  isValidFramework,
  isValidRuntimeIdentifier,
  PUBLISH_MODES,
  PUBLISH_MODE_INFO,
  PUBLISH_RUNTIMES,
  publishArgs,
  publishModeInfo,
  publishOutputPath,
  sanitizeOutputDir,
  summarizePublish,
  supportsReadyToRun,
  supportsSingleFile,
  supportsTrimming,
} from '../../build/ui-lib.mjs';

const PROJECT = 'C:/sln/Acme.Api/Acme.Api.csproj';

const options = (patch = {}) => ({ ...DEFAULT_PUBLISH_OPTIONS, ...patch });

describe('argumentos básicos', () => {
  it('publica en Release por defecto, sin RID ni salida', () => {
    assert.deepEqual(publishArgs(PROJECT, options()), [PROJECT, '-c', 'Release']);
  });

  it('la configuración viaja como -c', () => {
    assert.deepEqual(publishArgs(PROJECT, options({ configuration: 'Debug' })), [PROJECT, '-c', 'Debug']);
  });

  it('el marco de destino viaja como -f', () => {
    assert.deepEqual(publishArgs(PROJECT, options({ framework: 'net9.0' })), [
      PROJECT, '-c', 'Release', '-f', 'net9.0',
    ]);
  });

  it('un marco sin declarar no emite -f: el proyecto decide', () => {
    assert.ok(!publishArgs(PROJECT, options({ framework: '   ' })).includes('-f'));
  });

  it('un marco con forma inaceptable se descarta en vez de escaparse', () => {
    assert.ok(!publishArgs(PROJECT, options({ framework: 'net9.0; rm -rf /' })).includes('-f'));
  });
});

describe('modo de despliegue y RID', () => {
  it('el modo portable no emite --runtime aunque haya uno guardado', () => {
    const args = publishArgs(PROJECT, options({ mode: 'framework-dependent', runtime: 'win-x64' }));
    assert.ok(!args.includes('--runtime'));
    assert.ok(!args.includes('--self-contained'));
  });

  it('autocontenido emite el RID y --self-contained true', () => {
    const args = publishArgs(PROJECT, options({ mode: 'self-contained', runtime: 'linux-x64' }));
    assert.deepEqual(args, [
      PROJECT, '-c', 'Release', '--runtime', 'linux-x64', '--self-contained', 'true',
    ]);
  });

  it('dependiente del framework para un destino emite --self-contained false, no lo deja implícito', () => {
    const args = publishArgs(PROJECT, options({ mode: 'runtime-dependent', runtime: 'win-x64' }));
    assert.deepEqual(args, [
      PROJECT, '-c', 'Release', '--runtime', 'win-x64', '--self-contained', 'false',
    ]);
  });

  it('un modo que exige RID y llega sin él no se inventa ninguno', () => {
    const args = publishArgs(PROJECT, options({ mode: 'self-contained', runtime: '' }));
    assert.deepEqual(args, [PROJECT, '-c', 'Release']);
    assert.equal(effectiveRuntime(options({ mode: 'self-contained', runtime: '' })), null);
  });

  it('un RID con forma inaceptable se trata como si no estuviera', () => {
    assert.equal(effectiveRuntime(options({ mode: 'self-contained', runtime: 'win x64' })), null);
    assert.equal(effectiveRuntime(options({ mode: 'self-contained', runtime: 'WIN-X64' })), null);
  });

  it('los RID del catálogo son todos válidos', () => {
    for (const runtime of PUBLISH_RUNTIMES) {
      assert.ok(isValidRuntimeIdentifier(runtime.id), runtime.id);
    }
  });

  it('acepta los RID con versión de sistema, que son válidos y raros', () => {
    assert.ok(isValidRuntimeIdentifier('linux-musl-arm64'));
    assert.ok(isValidRuntimeIdentifier('osx.13-arm64'));
  });

  it('cada modo declarado tiene ficha, y sólo los de destino piden RID', () => {
    for (const mode of PUBLISH_MODES) {
      assert.equal(publishModeInfo(mode).id, mode);
    }
    assert.deepEqual(
      PUBLISH_MODE_INFO.filter((entry) => entry.needsRuntime).map((entry) => entry.id),
      ['runtime-dependent', 'self-contained'],
    );
    assert.ok(isSelfContained(options({ mode: 'self-contained' })));
    assert.ok(!isSelfContained(options({ mode: 'runtime-dependent' })));
  });
});

describe('archivo único, ReadyToRun y recorte sólo con RID', () => {
  it('sin RID no se emiten, aunque lleguen encendidas', () => {
    const args = publishArgs(
      PROJECT,
      options({ mode: 'framework-dependent', singleFile: true, readyToRun: true, trimmed: true }),
    );

    assert.deepEqual(args, [PROJECT, '-c', 'Release']);
  });

  it('un modo que pide RID pero se ha quedado sin él tampoco las emite', () => {
    const args = publishArgs(
      PROJECT,
      options({ mode: 'self-contained', runtime: '', singleFile: true, readyToRun: true }),
    );

    assert.ok(!args.some((argument) => argument.startsWith('-p:Publish')));
  });

  it('con RID se emiten como propiedades de MSBuild', () => {
    const args = publishArgs(
      PROJECT,
      options({ mode: 'self-contained', runtime: 'win-x64', singleFile: true, readyToRun: true }),
    );

    assert.ok(args.includes('-p:PublishSingleFile=true'));
    assert.ok(args.includes('-p:PublishReadyToRun=true'));
  });

  it('el recorte además exige autocontenido: sin runtime dentro no hay nada que recortar', () => {
    const dependent = options({ mode: 'runtime-dependent', runtime: 'win-x64', trimmed: true });
    assert.ok(!publishArgs(PROJECT, dependent).includes('-p:PublishTrimmed=true'));
    assert.ok(!supportsTrimming(dependent));

    const contained = options({ mode: 'self-contained', runtime: 'win-x64', trimmed: true });
    assert.ok(publishArgs(PROJECT, contained).includes('-p:PublishTrimmed=true'));
    assert.ok(supportsTrimming(contained));
  });

  it('lo que la interfaz atenúa es exactamente lo que el constructor descarta', () => {
    const portable = options({ mode: 'framework-dependent' });
    assert.ok(!supportsSingleFile(portable));
    assert.ok(!supportsReadyToRun(portable));
    assert.ok(disabledReason(portable) !== null);

    const targeted = options({ mode: 'runtime-dependent', runtime: 'osx-arm64' });
    assert.ok(supportsSingleFile(targeted));
    assert.ok(supportsReadyToRun(targeted));
    assert.equal(disabledReason(targeted), null);
  });

  it('el motivo distingue "elige un destino" de "este modo no lo admite"', () => {
    assert.match(disabledReason(options({ mode: 'self-contained', runtime: '' })), /Elige un destino/);
    assert.match(disabledReason(options({ mode: 'framework-dependent' })), /destino concreto/);
  });
});

describe('saneado de la ruta de salida', () => {
  it('recorta espacios de los extremos', () => {
    assert.equal(sanitizeOutputDir('  ./publicado  '), './publicado');
  });

  it('unifica las barras', () => {
    assert.equal(sanitizeOutputDir('C:\\salida\\api'), 'C:/salida/api');
    assert.equal(sanitizeOutputDir('C:\\salida/api'), 'C:/salida/api');
  });

  it('colapsa los separadores repetidos', () => {
    assert.equal(sanitizeOutputDir('out///api'), 'out/api');
  });

  it('quita el separador final: -o out/ y -o out son la misma carpeta', () => {
    assert.equal(sanitizeOutputDir('out/'), 'out');
    assert.equal(sanitizeOutputDir('C:\\salida\\'), 'C:/salida');
  });

  it('conserva la raíz de una unidad, que sí lleva barra', () => {
    assert.equal(sanitizeOutputDir('C:\\'), 'C:/');
    assert.equal(sanitizeOutputDir('/'), '/');
  });

  it('conserva el prefijo de una ruta UNC', () => {
    assert.equal(sanitizeOutputDir('\\\\servidor\\publicaciones\\api'), '//servidor/publicaciones/api');
  });

  it('una ruta con espacios dentro no se toca: es un nombre de carpeta legítimo', () => {
    assert.equal(sanitizeOutputDir('C:/Mis publicaciones/api'), 'C:/Mis publicaciones/api');
  });

  it('vacía sigue vacía: sin -o decide el SDK', () => {
    assert.equal(sanitizeOutputDir('   '), '');
    assert.ok(!publishArgs(PROJECT, options({ outputDir: '  ' })).includes('-o'));
  });

  it('la salida saneada es la que viaja como -o', () => {
    const args = publishArgs(PROJECT, options({ outputDir: ' C:\\salida\\api\\ ' }));
    assert.deepEqual(args, [PROJECT, '-c', 'Release', '-o', 'C:/salida/api']);
  });
});

describe('saneado de lo que llega del renderer o del disco', () => {
  it('un objeto vacío devuelve los valores por defecto', () => {
    assert.deepEqual(coercePublishOptions({}), DEFAULT_PUBLISH_OPTIONS);
  });

  it('lo que no es un objeto devuelve los valores por defecto', () => {
    assert.deepEqual(coercePublishOptions(null), DEFAULT_PUBLISH_OPTIONS);
    assert.deepEqual(coercePublishOptions('Release'), DEFAULT_PUBLISH_OPTIONS);
  });

  it('una configuración desconocida vuelve a Release', () => {
    assert.equal(coercePublishOptions({ configuration: 'Staging' }).configuration, 'Release');
  });

  it('un modo desconocido vuelve al portable', () => {
    assert.equal(coercePublishOptions({ mode: 'aot' }).mode, 'framework-dependent');
  });

  it('apaga las banderas que el modo resultante ya no admite', () => {
    const coerced = coercePublishOptions({
      mode: 'framework-dependent',
      runtime: 'win-x64',
      singleFile: true,
      readyToRun: true,
      trimmed: true,
    });

    assert.equal(coerced.singleFile, false);
    assert.equal(coerced.readyToRun, false);
    assert.equal(coerced.trimmed, false);
  });

  it('las conserva cuando el modo sí las admite', () => {
    const coerced = coercePublishOptions({
      mode: 'self-contained',
      runtime: 'win-x64',
      singleFile: true,
      trimmed: true,
    });

    assert.equal(coerced.singleFile, true);
    assert.equal(coerced.trimmed, true);
  });

  it('un RID inválido se descarta y arrastra las banderas que dependían de él', () => {
    const coerced = coercePublishOptions({ mode: 'self-contained', runtime: '../../bin', singleFile: true });

    assert.equal(coerced.runtime, '');
    assert.equal(coerced.singleFile, false);
  });

  it('la ruta de salida llega ya saneada', () => {
    assert.equal(coercePublishOptions({ outputDir: ' out\\api\\ ' }).outputDir, 'out/api');
  });

  it('acepta los marcos con plataforma y descarta lo demás', () => {
    assert.ok(isValidFramework('net10.0-windows'));
    assert.ok(isValidFramework('netstandard2.1'));
    assert.ok(!isValidFramework('net9.0 && whoami'));
    assert.equal(coercePublishOptions({ framework: 'net9.0 && whoami' }).framework, '');
  });
});

describe('carpeta del resultado', () => {
  it('con -o es la que se pidió', () => {
    assert.equal(
      publishOutputPath('C:/sln/Acme.Api', options({ outputDir: 'C:\\salida\\api', framework: 'net9.0' })),
      'C:/salida/api',
    );
  });

  it('sin -o reproduce la que compone el SDK', () => {
    assert.equal(
      publishOutputPath('C:/sln/Acme.Api', options({ framework: 'net9.0' })),
      'C:/sln/Acme.Api/bin/Release/net9.0/publish',
    );
  });

  it('con RID, el identificador va por medio', () => {
    assert.equal(
      publishOutputPath(
        'C:/sln/Acme.Api',
        options({ framework: 'net9.0', mode: 'self-contained', runtime: 'win-x64' }),
      ),
      'C:/sln/Acme.Api/bin/Release/net9.0/win-x64/publish',
    );
  });

  it('sin marco de destino no se inventa una carpeta', () => {
    assert.equal(publishOutputPath('C:/sln/Acme.Api', options()), null);
  });

  it('normaliza el directorio del proyecto, venga como venga', () => {
    assert.equal(
      publishOutputPath('C:\\sln\\Acme.Api\\', options({ framework: 'net9.0', configuration: 'Debug' })),
      'C:/sln/Acme.Api/bin/Debug/net9.0/publish',
    );
  });
});

describe('resumen y descripción', () => {
  it('la descripción dice el modo en palabras, no en banderas', () => {
    assert.equal(
      describePublish(options({ framework: 'net9.0', mode: 'self-contained', runtime: 'win-x64', singleFile: true })),
      'Release · net9.0 · win-x64 · autocontenido · archivo único',
    );
  });

  it('sin RID lo dice: portable', () => {
    assert.equal(describePublish(options({ framework: 'net9.0' })), 'Release · net9.0 · portable');
  });

  it('la descripción no nombra una bandera que no se va a emitir', () => {
    assert.equal(
      describePublish(options({ mode: 'framework-dependent', singleFile: true, readyToRun: true })),
      'Release · portable',
    );
  });

  it('el resumen correcto nombra la carpeta', () => {
    const summary = summarizePublish('Acme.Api', 'C:/salida/api', 0);

    assert.equal(summary.level, 'ok');
    assert.equal(summary.folder, 'C:/salida/api');
    assert.match(summary.message, /Acme\.Api publicado en C:\/salida\/api/);
  });

  it('sin carpeta deducida, el resumen no ofrece abrir nada', () => {
    const summary = summarizePublish('Acme.Api', null, 0);

    assert.equal(summary.folder, null);
    assert.equal(summary.message, 'Acme.Api publicado.');
  });

  it('un fallo no ofrece abrir la carpeta y manda al panel', () => {
    const summary = summarizePublish('Acme.Api', 'C:/salida/api', 1);

    assert.equal(summary.level, 'error');
    assert.equal(summary.folder, null);
    assert.match(summary.message, /panel inferior/);
  });
});
