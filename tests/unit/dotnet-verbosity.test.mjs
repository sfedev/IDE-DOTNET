/**
 * Pruebas de la inyección del nivel de salida de la CLI de .NET.
 *
 * Aquí no se comprueba "que la bandera esté": se comprueba **dónde** está. `dotnet watch` no
 * acepta `--verbosity` y se come cualquier argumento desconocido pasándoselo a la aplicación
 * hija, así que colar la bandera en el sitio equivocado no falla, no avisa y hace que la
 * aplicación reciba un argumento que no entiende. Eso sólo se caza con una aserción sobre la
 * línea de argumentos completa.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  coerceVerbosity,
  debugEnvironment,
  DEFAULT_DOTNET_VERBOSITY,
  describeVerbosity,
  DOTNET_VERBOSITY_INFO,
  DOTNET_VERBOSITY_LEVELS,
  verbosityEnvironment,
  verbosityInfo,
  verbosityPlan,
} from '../../build/main-lib.mjs';

/** Reconstruye la línea como la arma `dotnet-service.buildArgs`. */
function commandLine(kind, target, level) {
  const TASK_ARGS = {
    build: ['build', '--nologo'],
    rebuild: ['build', '--nologo', '--no-incremental'],
    clean: ['clean', '--nologo'],
    restore: ['restore'],
    test: ['test', '--nologo'],
    run: ['run', '--project'],
    watch: ['watch', '--project'],
    format: ['format'],
  };

  const [verb, ...rest] = TASK_ARGS[kind];
  const plan = verbosityPlan(kind, level);

  return ['dotnet', verb, ...plan.leading, ...rest, target, ...plan.trailing].join(' ');
}

describe('catálogo de niveles', () => {
  it('son exactamente los cuatro de la CLI que se ofrecen en Ajustes', () => {
    assert.deepEqual([...DOTNET_VERBOSITY_LEVELS], ['minimal', 'normal', 'detailed', 'diagnostic']);
  });

  it('el nivel por defecto es minimal', () => {
    assert.equal(DEFAULT_DOTNET_VERBOSITY, 'minimal');
  });

  it('cada nivel tiene etiqueta y ayuda', () => {
    assert.equal(DOTNET_VERBOSITY_INFO.length, DOTNET_VERBOSITY_LEVELS.length);
    for (const level of DOTNET_VERBOSITY_LEVELS) {
      const info = verbosityInfo(level);
      assert.equal(info.id, level);
      assert.ok(info.label.length > 0, `${level} sin etiqueta`);
      assert.ok(info.hint.length > 20, `${level} sin ayuda útil`);
    }
  });

  it('describeVerbosity dice el nivel y su etiqueta', () => {
    assert.equal(describeVerbosity('detailed'), 'Detailed (detailed)');
  });
});

describe('coerceVerbosity', () => {
  it('acepta los niveles válidos', () => {
    for (const level of DOTNET_VERBOSITY_LEVELS) {
      assert.equal(coerceVerbosity(level), level);
    }
  });

  it('cualquier otra cosa vuelve al de por defecto', () => {
    for (const raw of ['quiet', 'DETAILED', '', null, undefined, 3, {}, ['detailed']]) {
      assert.equal(coerceVerbosity(raw), 'minimal');
    }
  });
});

describe('verbosityPlan', () => {
  it('build recibe --verbosity detrás del objetivo', () => {
    assert.equal(
      commandLine('build', 'Acme.sln', 'detailed'),
      'dotnet build --nologo Acme.sln --verbosity detailed',
    );
  });

  it('rebuild conserva --no-incremental', () => {
    assert.equal(
      commandLine('rebuild', 'Acme.sln', 'normal'),
      'dotnet build --nologo --no-incremental Acme.sln --verbosity normal',
    );
  });

  for (const kind of ['clean', 'restore', 'test', 'format']) {
    it(`${kind} acepta la bandera con nivel`, () => {
      const plan = verbosityPlan(kind, 'diagnostic');
      assert.deepEqual(plan.trailing, ['--verbosity', 'diagnostic']);
      assert.deepEqual(plan.leading, []);
    });
  }

  it('run pone la bandera detrás del proyecto, no delante', () => {
    assert.equal(
      commandLine('run', 'src/Api/Api.csproj', 'detailed'),
      'dotnet run --project src/Api/Api.csproj --verbosity detailed',
    );
  });

  it('watch usa --verbose y lo pone ANTES de --project', () => {
    assert.equal(
      commandLine('watch', 'src/Api/Api.csproj', 'detailed'),
      'dotnet watch --verbose --project src/Api/Api.csproj',
    );
  });

  it('watch no recibe nunca --verbosity: se lo pasaría a la aplicación', () => {
    for (const level of DOTNET_VERBOSITY_LEVELS) {
      const plan = verbosityPlan('watch', level);
      assert.deepEqual(plan.trailing, [], level);
      assert.ok(!plan.leading.includes('--verbosity'), level);
    }
  });

  it('watch se queda callado en los niveles bajos', () => {
    assert.deepEqual(verbosityPlan('watch', 'minimal').leading, []);
    assert.deepEqual(verbosityPlan('watch', 'normal').leading, []);
    assert.deepEqual(verbosityPlan('watch', 'diagnostic').leading, ['--verbose']);
  });

  it('el nivel por defecto también se escribe: el comando dice la verdad', () => {
    assert.equal(
      commandLine('build', 'Acme.sln', 'minimal'),
      'dotnet build --nologo Acme.sln --verbosity minimal',
    );
  });

  it('un verbo que no admite la bandera no la recibe', () => {
    assert.deepEqual(verbosityPlan('add', 'detailed'), { leading: [], trailing: [] });
  });
});

describe('verbosityEnvironment', () => {
  it('los niveles bajos no tocan el entorno', () => {
    assert.deepEqual(verbosityEnvironment('minimal'), {});
    assert.deepEqual(verbosityEnvironment('normal'), {});
  });

  it('detailed recopila el registro de la aplicación y los errores detallados', () => {
    const env = verbosityEnvironment('detailed');

    assert.equal(env['Logging__LogLevel__Default'], 'Debug');
    assert.equal(env['Logging__LogLevel__Microsoft.AspNetCore'], 'Debug');
    assert.equal(env['ASPNETCORE_DETAILEDERRORS'], 'true');
    // El logger de terminal del SDK colapsa la salida: con verbosidad alta estorba.
    assert.equal(env['MSBUILDTERMINALLOGGER'], 'off');
    assert.equal(env['COREHOST_TRACE'], undefined, 'la traza del host es sólo de diagnostic');
  });

  it('diagnostic añade la traza de carga de ensamblados', () => {
    const env = verbosityEnvironment('diagnostic');

    assert.equal(env['COREHOST_TRACE'], '1');
    assert.equal(env['COREHOST_TRACE_VERBOSITY'], '3');
    assert.equal(env['Logging__LogLevel__Default'], 'Trace');
    assert.equal(env['DOTNET_CLI_CONTEXT_VERBOSE'], 'true');
  });

  it('ningún nivel toca ASPNETCORE_ENVIRONMENT: eso lo decide launchSettings.json', () => {
    for (const level of DOTNET_VERBOSITY_LEVELS) {
      assert.equal(verbosityEnvironment(level)['ASPNETCORE_ENVIRONMENT'], undefined, level);
    }
  });
});

describe('debugEnvironment', () => {
  it('el depurador no compila: la variable de MSBuild sobra', () => {
    const env = debugEnvironment('diagnostic');

    assert.equal(env['MSBUILDTERMINALLOGGER'], undefined);
    assert.equal(env['COREHOST_TRACE'], '1');
    assert.equal(env['Logging__LogLevel__Default'], 'Trace');
  });

  it('en minimal la sesión de depuración no hereda nada extra', () => {
    assert.deepEqual(debugEnvironment('minimal'), {});
  });
});
