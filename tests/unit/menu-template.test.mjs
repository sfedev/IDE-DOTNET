/**
 * Pruebas de la barra de menú superior.
 *
 * Un menú tiene tres formas de estar roto y ninguna se ve mirándolo:
 *
 *  1. **Manda un comando que el renderer no conoce.** Se pulsa la entrada y no pasa
 *     absolutamente nada: `runCommandById` busca el comando en la paleta y, si no está, sale sin
 *     decir nada. Es el fallo más caro porque parece que la función no existe.
 *  2. **Dos entradas se pelean por el mismo acelerador.** Electron registra las dos, gana una, y
 *     cuál gana no está escrito en ningún sitio. Un atajo que a veces hace una cosa y a veces otra
 *     es peor que no tener atajo.
 *  3. **Falta media aplicación.** Hay unos 60 comandos en la paleta y el menú enseñaba unos 45: las
 *     funcionalidades que no están en el menú, para quien navega con menús, no existen.
 *
 * Por eso la plantilla es un dato puro (`src/shared/menu-template.ts`) en vez de vivir dentro de
 * `menu.ts`, que importa `electron` y no se puede cargar aquí.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acceleratorClashes,
  acceleratorOf,
  buildMenuTemplate,
  commandsOf,
  ROLE_ACCELERATORS,
} from '../../build/main-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const windows = buildMenuTemplate({ platform: 'win32', appName: 'DotForge IDE' });
const mac = buildMenuTemplate({ platform: 'darwin', appName: 'DotForge IDE' });

/**
 * Ids de comando que el renderer sabe ejecutar.
 *
 * Se leen del cuerpo de `registerCommands()` y no de todo el archivo: `index.ts` tiene otros
 * literales `id:` (las acciones que se registran en el editor de Monaco, por ejemplo) y contarlos
 * como comandos de la paleta convertiría esta prueba en un colador.
 *
 * Y se busca `id: '…'` en cualquier posición de la línea, no anclado al final: la mitad de los
 * comandos cortos se declaran en una sola línea (`{ id: 'view.output', title: 'Salida', … }`), y un
 * patrón anclado los daba por inexistentes.
 */
function paletteCommandIds() {
  const source = readFileSync(join(root, 'src', 'renderer', 'index.ts'), 'utf8');
  const start = source.indexOf('private registerCommands(): void {');
  assert.ok(start > 0, 'no se encuentra registerCommands() en el renderer');

  const body = source.slice(start, source.indexOf('this.palette.register(commands)', start));
  // `String.raw`, y escrito con la herramienta de edición y no por shell: un `\b` que pasa por una
  // capa que se come un nivel de escapes se convierte en un **retroceso literal**. El patrón deja
  // de casar, no se ve al leer el archivo, y la prueba pasa a afirmar que el renderer no conoce
  // ningún comando. Ha pasado escribiendo esta misma línea, dos veces seguidas.
  const pattern = new RegExp(String.raw`\bid: '([\w.-]+)'`, 'g');
  return new Set([...body.matchAll(pattern)].map((match) => match[1]));
}

/** Ids declarados en el contrato (`MenuCommand`). */
function declaredMenuCommands() {
  const source = readFileSync(join(root, 'src', 'shared', 'contracts.ts'), 'utf8');
  const union = source.slice(source.indexOf('export type MenuCommand ='));
  return new Set([...union.slice(0, union.indexOf(';')).matchAll(/'([\w.-]+)'/g)].map((match) => match[1]));
}

const labelsOf = (sections) => sections.map((section) => section.label);
const section = (sections, label) => sections.find((entry) => entry.label === label);
const entryLabels = (sections, label) =>
  (section(sections, label)?.items ?? []).filter((item) => item.kind !== 'separator').map((item) => item.label);

describe('secciones de la barra', () => {
  it('están las que pide un IDE de escritorio, en el orden en que se buscan', () => {
    assert.deepEqual(labelsOf(windows), [
      'Archivo',
      'Editar',
      'Ver',
      'Datos',
      'Git',
      'Compilar',
      'Depurar',
      'IA',
      'Ventana',
      'Ayuda',
    ]);
  });

  it('en macOS, el menú de la aplicación va delante', () => {
    assert.equal(labelsOf(mac)[0], 'DotForge IDE');
    assert.deepEqual(labelsOf(mac).slice(1), labelsOf(windows));
  });

  it('ninguna sección está vacía', () => {
    for (const entry of [...windows, ...mac]) {
      assert.ok(entry.items.length > 0, `la sección "${entry.label}" no tiene entradas`);
    }
  });

  it('ninguna sección empieza ni acaba en separador', () => {
    for (const entry of [...windows, ...mac]) {
      assert.notEqual(entry.items.at(0)?.kind, 'separator', entry.label);
      assert.notEqual(entry.items.at(-1)?.kind, 'separator', entry.label);
    }
  });
});

describe('lo que pide cada menú', () => {
  it('Archivo: abrir solución, abrir carpeta, recientes, guardar y salir', () => {
    const items = section(windows, 'Archivo').items;
    const labels = entryLabels(windows, 'Archivo');

    assert.ok(labels.includes('Abrir solución…'), labels.join(' | '));
    assert.ok(labels.includes('Abrir carpeta…'));
    assert.ok(labels.includes('Guardar'));
    assert.ok(items.some((item) => item.kind === 'recents'), 'falta el submenú de recientes');
    assert.ok(items.some((item) => item.kind === 'role' && item.role === 'quit'), 'falta salir');
  });

  it('en macOS, salir vive en el menú de la aplicación y no en Archivo', () => {
    const archivo = section(mac, 'Archivo').items;
    const app = section(mac, 'DotForge IDE').items;

    assert.ok(!archivo.some((item) => item.kind === 'role' && item.role === 'quit'));
    assert.ok(app.some((item) => item.kind === 'role' && item.role === 'quit'));
  });

  it('Editar: deshacer/rehacer, buscar, formatear y asistente en línea', () => {
    const items = section(windows, 'Editar').items;
    const roles = items.filter((item) => item.kind === 'role').map((item) => item.role);
    const commands = items.filter((item) => item.kind === 'command').map((item) => item.command);

    assert.ok(roles.includes('undo') && roles.includes('redo'));
    assert.ok(commands.includes('edit.find'));
    assert.ok(commands.includes('edit.find-in-files'));
    assert.ok(commands.includes('edit.format'));
    assert.ok(commands.includes('ai.inline'), 'el asistente en línea se pide desde Editar');
  });

  it('Ver: las vistas del IDE y los dos temas por separado', () => {
    const commands = section(windows, 'Ver').items.filter((item) => item.kind === 'command').map((item) => item.command);

    for (const expected of [
      'view.explorer',
      'view.source-control',
      'view.efcore',
      'view.containers',
      'ai.chat',
      'view.terminal',
      'view.metrics',
      'view.theme-dark',
      'view.theme-light',
    ]) {
      assert.ok(commands.includes(expected), `falta ${expected} en Ver`);
    }
  });

  /**
   * Dos entradas y no un "cambiar tema": en un desplegable, "cambiar tema" no dice a cuál se va, y
   * hay que abrirlo dos veces para averiguarlo.
   */
  it('los temas se ofrecen por nombre, no como conmutador', () => {
    const labels = entryLabels(windows, 'Ver');
    assert.ok(labels.includes('Tema oscuro') && labels.includes('Tema claro'));
    assert.ok(!labels.includes('Cambiar tema'));
  });

  it('Datos: EF Core, migraciones y cliente HTTP', () => {
    const commands = section(windows, 'Datos').items.filter((item) => item.kind === 'command').map((item) => item.command);

    assert.ok(commands.includes('view.efcore'));
    assert.ok(commands.includes('efcore.add-migration'));
    assert.ok(commands.includes('efcore.update-database'));
    assert.ok(commands.includes('view.http'), 'el cliente HTTP se abre desde Datos');
    assert.ok(commands.includes('http.send-request'));
  });

  it('Ayuda: actualizaciones, documentación y acerca de', () => {
    const items = section(windows, 'Ayuda').items;
    const commands = items.filter((item) => item.kind === 'command').map((item) => item.command);

    assert.ok(commands.includes('update.check'));
    assert.ok(commands.includes('help.docs'), 'falta la documentación didáctica de la solución');
    assert.ok(commands.includes('help.about'));
    assert.ok(items.some((item) => item.kind === 'link'), 'faltan los enlaces a la documentación externa');
  });

  it('todos los enlaces externos son HTTPS', () => {
    for (const entry of windows) {
      for (const item of entry.items) {
        if (item.kind === 'link') assert.ok(item.url.startsWith('https://'), item.url);
      }
    }
  });
});

describe('los comandos del menú existen de verdad', () => {
  const used = commandsOf(windows);

  it('el menú manda un número razonable de comandos', () => {
    assert.ok(used.length >= 45, `sólo ${used.length} comandos en el menú`);
  });

  /**
   * El fallo más caro: una entrada que manda un comando que el renderer no registra se pulsa y no
   * hace nada, sin error ni traza. `runCommandById` busca en la paleta y sale en silencio.
   */
  it('cada comando del menú está registrado en la paleta del renderer', () => {
    const palette = paletteCommandIds();
    const missing = used.filter((command) => !palette.has(command));

    assert.deepEqual(missing, [], `el menú manda comandos que el renderer no conoce: ${missing.join(', ')}`);
  });

  it('cada comando del menú está declarado en el contrato', () => {
    const declared = declaredMenuCommands();
    const missing = used.filter((command) => !declared.has(command));

    assert.deepEqual(missing, [], `comandos fuera de MenuCommand: ${missing.join(', ')}`);
  });

  it('macOS manda los mismos comandos que Windows, más los suyos', () => {
    const onMac = new Set(commandsOf(mac));
    for (const command of used) assert.ok(onMac.has(command), `falta ${command} en macOS`);
  });
});

describe('aceleradores', () => {
  /**
   * Electron no avisa de un atajo repetido: registra los dos y gana uno. Un mismo comando puede
   * aparecer en dos menús a propósito —"Contenedores" está en Ver y en Datos— pero sólo uno de los
   * dos puede llevar el acelerador.
   */
  it('ninguno está repetido', () => {
    for (const sections of [windows, mac]) {
      const clashes = acceleratorClashes(sections);
      assert.deepEqual(
        clashes,
        [],
        clashes.map((clash) => `${clash.accelerator}: ${clash.labels.join(' / ')}`).join(' ;; '),
      );
    }
  });

  it('los de plataforma se escriben con CmdOrCtrl, no con Ctrl a pelo', () => {
    for (const entry of windows) {
      for (const item of entry.items) {
        if (item.kind !== 'command' || !item.accelerator) continue;
        assert.ok(
          !/^Ctrl\+/.test(item.accelerator),
          `${item.label} usa "${item.accelerator}": en macOS debería ser Cmd`,
        );
      }
    }
  });

  /**
   * `Ctrl+Shift+I` se lo queda el inspector de Electron: un atajo propio con ese literal no llega
   * nunca. Está anotado en `CLAUDE.md` desde la Fase 10.
   */
  /**
   * La mitad invisible del problema: un `role` no declara acelerador en la plantilla y **aun así
   * ocupa uno**, porque Electron se lo pone. Sin esta tabla, la comprobación de choques mira sólo
   * la mitad de las teclas y da un verde falso — que es justo lo que hizo: los tres choques que
   * había los encontró `--menu-dump` mirando el menú ya construido, no esta prueba.
   */
  it('todos los roles usados tienen su acelerador heredado anotado', () => {
    const roles = [windows, mac]
      .flat()
      .flatMap((entry) => entry.items)
      .filter((item) => item.kind === 'role');

    for (const item of roles) {
      const known = Object.hasOwn(ROLE_ACCELERATORS, item.role) || item.accelerator !== undefined;
      assert.ok(known, `el role "${item.role}" no declara acelerador ni está en ROLE_ACCELERATORS`);
    }
  });

  it('el acelerador declarado gana al heredado del role', () => {
    const fullscreen = section(windows, 'Ver').items.find((item) => item.role === 'togglefullscreen');

    assert.equal(ROLE_ACCELERATORS['togglefullscreen'], 'F11', 'Electron le pone F11 por su cuenta');
    assert.equal(acceleratorOf(fullscreen), 'Alt+Shift+Enter', 'y F11 es "paso a paso" en un IDE');
  });

  it('no se pisa el atajo del inspector de Electron', () => {
    const all = windows.flatMap((entry) => entry.items).filter((item) => item.kind === 'command');
    assert.ok(!all.some((item) => item.accelerator === 'CmdOrCtrl+Shift+I'));
  });
});
