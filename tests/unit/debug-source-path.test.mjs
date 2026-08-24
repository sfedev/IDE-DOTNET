/**
 * Pruebas de la ruta que se le da a NetCoreDbg al poner un breakpoint.
 *
 * NetCoreDbg liga un breakpoint comparando **como texto** la ruta que se le pide con la que trae el
 * PDB. El compilador guarda la forma canónica del sistema, así que un nombre equivalente pero
 * distinto no casa, el breakpoint se queda "pendiente" y el programa se ejecuta entero. No hay
 * excepción, ni aviso, ni error: simplemente no para en ningún sitio.
 *
 * Así se cayó la suite en `windows-latest` con el tag v2.1.0. En los runners de Windows de GitHub
 * el usuario es `runneradmin`, que no cabe en 8.3, y `%TEMP%` llega como
 * `C:\\Users\\RUNNER~1\\AppData\\Local\\Temp`. `os.tmpdir()` lo devuelve tal cual, la prueba de
 * integración compila y depura ahí, y el breakpoint nunca se resolvía. Se tomó por lentitud del
 * runner —el síntoma era un timeout— y no lo era.
 *
 * Cuidado con el detalle que hace falta para arreglarlo: el `realpath` de JavaScript **no** expande
 * los alias 8.3, sólo el nativo. Comprobado en las dos formas antes de escribir el arreglo.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { debuggerSourcePath } from '../../build/toolchain.mjs';

/**
 * Alias 8.3 de una carpeta, o null si el volumen no los genera.
 *
 * Se puede desactivar por volumen (`fsutil 8dot3name`), así que la prueba que lo necesita se
 * declara no concluyente en vez de fallar en una máquina configurada de otra forma.
 */
function shortPathOf(path) {
  if (process.platform !== 'win32') return null;

  try {
    const script = `$f = New-Object -ComObject Scripting.FileSystemObject; $f.GetFolder("${path}").ShortPath`;
    const short = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 30_000,
    })
      .toString()
      .trim();

    return short && short !== path ? short : null;
  } catch {
    return null;
  }
}

describe('ruta de origen para el depurador', () => {
  it('expande el alias 8.3 de Windows a la forma que guarda el PDB', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('los alias 8.3 son cosa de Windows');
      return;
    }

    // El nombre tiene que pasarse de 8 caracteres para que el sistema genere alias.
    const root = await mkdtemp(join(tmpdir(), 'dotforge-nombre-larguisimo-'));
    const short = shortPathOf(root);

    if (short === null) {
      await rm(root, { recursive: true, force: true });
      t.skip('este volumen no genera nombres 8.3');
      return;
    }

    assert.match(short, /~\d/, `se esperaba un alias 8.3 y ha salido ${short}`);

    const file = join(root, 'Program.cs');
    await writeFile(file, 'var x = 1;\n', 'utf8');

    const resolved = await debuggerSourcePath(join(short, 'Program.cs'));

    assert.equal(resolved, file, 'la ruta no se ha llevado a su forma larga');
    assert.ok(!/~\d/.test(resolved), `sigue habiendo un alias 8.3 en ${resolved}`);

    await rm(root, { recursive: true, force: true });
  });

  it('deja la ruta canónica intacta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dotforge-canonica-'));
    const file = join(root, 'Program.cs');
    await writeFile(file, 'var x = 1;\n', 'utf8');

    // En macOS esto además comprueba lo suyo: /var es un enlace a /private/var, y el PDB guarda la
    // segunda forma, así que la canónica de un archivo bajo el temporal ya viene resuelta.
    const once = await debuggerSourcePath(file);
    const twice = await debuggerSourcePath(once);

    assert.equal(twice, once, 'la resolución no es idempotente');

    await rm(root, { recursive: true, force: true });
  });

  it('un archivo que no existe se devuelve tal cual, sin lanzar', async () => {
    // Un breakpoint puede quedar apuntando a un archivo borrado, o a un búfer sin guardar. Eso no
    // puede tumbar el arranque de la sesión: se manda la ruta como venga y que decida el adaptador.
    const fantasma = join(tmpdir(), 'dotforge-no-existe-jamas', 'Program.cs');

    assert.equal(await debuggerSourcePath(fantasma), fantasma);
  });
});
