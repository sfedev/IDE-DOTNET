/**
 * Pruebas de la auditoría de seguridad de NuGet.
 *
 * El camino bueno es el JSON de `dotnet list package --vulnerable --format json`, que es
 * invariante. El degradado parsea la tabla de texto, que tiene las cabeceras y la gravedad
 * traducidas al idioma del sistema — y por eso se prueba también con la tabla en español, que es
 * exactamente donde falla una implementación que busque las palabras en inglés.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  advisoryIdentifier,
  auditArgs,
  AUDIT_RESTORE_HINT,
  coerceSeverity,
  countBySeverity,
  describeAudit,
  parseVulnerableJson,
  parseVulnerableText,
  severityRank,
  SEVERITY_LABEL,
  sortPackages,
  worstSeverity,
} from '../../build/ui-lib.mjs';

const JSON_OUTPUT = `Restauración completada (0,4s)
{
  "version": 1,
  "parameters": "--vulnerable --include-transitive",
  "projects": [
    {
      "path": "C:\\\\repo\\\\src\\\\Acme.WebApi\\\\Acme.WebApi.csproj",
      "frameworks": [
        {
          "framework": "net9.0",
          "topLevelPackages": [
            {
              "id": "Newtonsoft.Json",
              "requestedVersion": "12.0.1",
              "resolvedVersion": "12.0.1",
              "vulnerabilities": [
                {
                  "severity": "High",
                  "advisoryurl": "https://github.com/advisories/GHSA-5crp-9r3c-p9vr"
                }
              ]
            }
          ],
          "transitivePackages": [
            {
              "id": "System.Text.RegularExpressions",
              "resolvedVersion": "4.3.0",
              "vulnerabilities": [
                {
                  "severity": "Critical",
                  "advisoryurl": "https://github.com/advisories/GHSA-cmhx-cq75-c4mj"
                },
                {
                  "severity": "Moderate",
                  "advisoryurl": "https://github.com/advisories/GHSA-1234-5678-9abc"
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "path": "C:\\\\repo\\\\src\\\\Acme.Domain\\\\Acme.Domain.csproj",
      "frameworks": [
        { "framework": "net9.0", "topLevelPackages": [], "transitivePackages": [] }
      ]
    }
  ]
}
`;

const TEXT_OUTPUT_ES = `El proyecto \`Acme.WebApi\` tiene los siguientes paquetes vulnerables
   [net9.0]:
   Paquete de nivel superior      Solicitado   Resuelto   Gravedad   Dirección URL del aviso
   > Newtonsoft.Json              12.0.1       12.0.1     Alta       https://github.com/advisories/GHSA-5crp-9r3c-p9vr

   Paquete transitivo             Resuelto     Gravedad   Dirección URL del aviso
   > System.Text.RegularExpressions   4.3.0    Crítica    https://github.com/advisories/GHSA-cmhx-cq75-c4mj
`;

describe('coerceSeverity', () => {
  it('lee la gravedad del JSON, que viene en inglés', () => {
    assert.equal(coerceSeverity('Critical'), 'critical');
    assert.equal(coerceSeverity('High'), 'high');
    assert.equal(coerceSeverity('Moderate'), 'moderate');
    assert.equal(coerceSeverity('Low'), 'low');
  });

  it('lee también la traducida de la tabla', () => {
    assert.equal(coerceSeverity('Crítica'), 'critical');
    assert.equal(coerceSeverity('Alta'), 'high');
    assert.equal(coerceSeverity('Media'), 'moderate');
    assert.equal(coerceSeverity('Baja'), 'low');
  });

  it('lo que no reconoce es "sin clasificar", nunca "leve"', () => {
    assert.equal(coerceSeverity('Sehr hoch'), 'unknown');
    assert.equal(coerceSeverity(null), 'unknown');
    assert.equal(coerceSeverity(3), 'unknown');
  });

  it('el orden de gravedad es el esperado', () => {
    assert.ok(severityRank('critical') > severityRank('high'));
    assert.ok(severityRank('high') > severityRank('moderate'));
    assert.ok(severityRank('moderate') > severityRank('low'));
    assert.ok(severityRank('low') > severityRank('unknown'));
  });

  it('toda gravedad tiene etiqueta en español', () => {
    for (const severity of ['critical', 'high', 'moderate', 'low', 'unknown']) {
      assert.ok(SEVERITY_LABEL[severity].length > 3, severity);
    }
  });
});

describe('advisoryIdentifier', () => {
  it('saca el GHSA de la URL del aviso', () => {
    assert.equal(
      advisoryIdentifier('https://github.com/advisories/GHSA-5crp-9r3c-p9vr'),
      'GHSA-5CRP-9R3C-P9VR',
    );
  });

  it('saca el CVE cuando la URL lo lleva', () => {
    assert.equal(advisoryIdentifier('https://nvd.nist.gov/vuln/detail/CVE-2024-21907'), 'CVE-2024-21907');
  });

  it('devuelve null si la URL no identifica nada', () => {
    assert.equal(advisoryIdentifier('https://example.com/aviso'), null);
  });
});

describe('parseVulnerableJson', () => {
  const report = parseVulnerableJson(JSON_OUTPUT);

  it('encuentra el bloque JSON aunque venga precedido de la salida del build', () => {
    assert.notEqual(report, null);
    assert.equal(report.degraded, false);
  });

  it('lista los paquetes directos y los transitivos', () => {
    assert.equal(report.packages.length, 2);

    const direct = report.packages.find((entry) => entry.id === 'Newtonsoft.Json');
    const transitive = report.packages.find((entry) => entry.id === 'System.Text.RegularExpressions');

    assert.equal(direct.transitive, false);
    assert.equal(direct.requestedVersion, '12.0.1');
    assert.equal(transitive.transitive, true);
    assert.equal(transitive.requestedVersion, null);
  });

  it('agrupa varios avisos del mismo paquete y se queda con la peor gravedad', () => {
    const transitive = report.packages.find((entry) => entry.id === 'System.Text.RegularExpressions');

    assert.equal(transitive.vulnerabilities.length, 2);
    assert.equal(transitive.worst, 'critical');
  });

  it('ordena lo peor primero', () => {
    assert.deepEqual(report.packages.map((entry) => entry.worst), ['critical', 'high']);
  });

  it('guarda el proyecto y el framework de cada paquete', () => {
    assert.match(report.packages[0].project, /Acme\.WebApi\.csproj$/);
    assert.equal(report.packages[0].projectName, 'Acme.WebApi');
    assert.equal(report.packages[0].framework, 'net9.0');
  });

  it('cuenta los dos proyectos revisados, aunque uno esté limpio', () => {
    assert.equal(report.projects.length, 2);
  });

  it('una salida sin JSON devuelve null, que es lo que activa el camino degradado', () => {
    assert.equal(parseVulnerableJson('MSBUILD : error MSB1011: hay más de un proyecto'), null);
    assert.equal(parseVulnerableJson(''), null);
  });

  it('un JSON que no es un informe tampoco cuela', () => {
    assert.equal(parseVulnerableJson('{"algo": 1}'), null);
  });
});

describe('parseVulnerableText (camino degradado)', () => {
  const report = parseVulnerableText(TEXT_OUTPUT_ES);

  it('se marca como degradado', () => {
    assert.equal(report.degraded, true);
  });

  it('lee las filas de paquete de una tabla en español', () => {
    assert.equal(report.packages.length, 2);

    const direct = report.packages.find((entry) => entry.id === 'Newtonsoft.Json');
    assert.equal(direct.worst, 'high');
    assert.equal(direct.requestedVersion, '12.0.1');
    assert.equal(direct.resolvedVersion, '12.0.1');
    assert.equal(direct.vulnerabilities[0].identifier, 'GHSA-5CRP-9R3C-P9VR');
  });

  it('reconoce la sección de transitivos', () => {
    const transitive = report.packages.find((entry) => entry.id === 'System.Text.RegularExpressions');

    assert.equal(transitive.transitive, true);
    assert.equal(transitive.worst, 'critical');
    assert.equal(transitive.requestedVersion, null);
  });

  it('saca el nombre del proyecto de los acentos graves y el framework de los corchetes', () => {
    assert.equal(report.packages[0].projectName, 'Acme.WebApi');
    assert.equal(report.packages[0].framework, 'net9.0');
  });

  it('no confunde una línea de cabecera con un paquete', () => {
    assert.equal(report.packages.some((entry) => entry.id.includes('Paquete')), false);
  });

  it('una tabla vacía no inventa paquetes', () => {
    assert.deepEqual(parseVulnerableText('No se han encontrado paquetes vulnerables.').packages, []);
  });
});

describe('presentación del informe', () => {
  const report = parseVulnerableJson(JSON_OUTPUT);

  it('cuenta por gravedad', () => {
    const counts = countBySeverity(report.packages);

    assert.equal(counts.critical, 1);
    assert.equal(counts.high, 1);
    assert.equal(counts.moderate, 0);
  });

  it('resume en una línea', () => {
    assert.match(describeAudit(report), /2 paquete\(s\) con avisos/);
  });

  it('sin avisos lo dice claramente', () => {
    assert.match(
      describeAudit({ packages: [], projects: [], degraded: false, error: null, at: 0 }),
      /Sin vulnerabilidades/,
    );
  });

  it('con error enseña el error y no un falso "todo bien"', () => {
    assert.equal(
      describeAudit({ packages: [], projects: [], degraded: true, error: 'no hay assets', at: 0 }),
      'no hay assets',
    );
  });

  it('worstSeverity de una lista vacía es "sin clasificar"', () => {
    assert.equal(worstSeverity([]), 'unknown');
  });

  it('sortPackages pone los directos antes que los transitivos a igual gravedad', () => {
    const sorted = sortPackages([
      { id: 'B', worst: 'high', transitive: true, vulnerabilities: [] },
      { id: 'A', worst: 'high', transitive: false, vulnerabilities: [] },
    ]);

    assert.deepEqual(sorted.map((entry) => entry.id), ['A', 'B']);
  });
});

describe('auditArgs', () => {
  it('pide los transitivos y el JSON en el camino bueno', () => {
    assert.deepEqual(auditArgs('Acme.sln', true), [
      'list',
      'Acme.sln',
      'package',
      '--vulnerable',
      '--include-transitive',
      '--format',
      'json',
    ]);
  });

  it('sin JSON quedan los mismos argumentos menos el formato', () => {
    assert.equal(auditArgs('Acme.sln', false).includes('--format'), false);
  });

  it('la pista de restaurar menciona el comando que hay que ejecutar', () => {
    assert.match(AUDIT_RESTORE_HINT, /dotnet restore/);
  });
});
