/**
 * Proceso principal de DotForge IDE.
 *
 * Responsabilidades: crear la ventana con la configuración de seguridad correcta, registrar los
 * handlers IPC, instalar el menú y garantizar que al salir no queda ningún proceso hijo vivo.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron';

import { readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { installApplicationMenu } from './menu.js';
import {
  openWorkspaceFromCli,
  registerIpcHandlers,
  setPendingFile,
  startLanguageServerForCurrentWorkspace,
} from './ipc/register.js';
import { lspClient } from './lsp/lsp-client.js';
import * as aiService from './services/ai/ai-service.js';
import * as aiSecrets from './services/ai/secret-store.js';
import * as metricsService from './services/metrics-service.js';
import * as processRegistry from './services/process-registry.js';
import * as settingsService from './services/settings-service.js';
import * as startupService from './services/startup-service.js';
import * as updaterService from './services/updater-service.js';
import * as extensionInstaller from './services/extension-installer.js';
import { STARTUP_CHECK_DELAY_MS } from '../shared/updates.js';

const isDevelopment = process.argv.includes('--dev') || !app.isPackaged;

/**
 * Modo de prueba de humo: arranca la aplicación sin mostrarla, comprueba que el renderer se monta
 * sin errores de consola y sale con código 0 o 1. Lo usa `tests/package/electron-smoke.test.mjs`
 * para que "la app arranca" sea una aserción y no una suposición.
 */
const isSmokeTest = process.argv.includes('--smoke-test');

/**
 * Carpeta a abrir al arrancar: `dotforge-ide .` o `--open=<ruta>`, como cualquier IDE moderno.
 * Se ignora en los modos de diagnóstico, que deben partir siempre del mismo estado.
 */
const workspaceArgument = (() => {
  const explicit = process.argv.find((argument) => argument.startsWith('--open='));
  if (explicit) return explicit.slice('--open='.length);

  // El primer argumento posicional tras el ejecutable (y tras el script, en desarrollo).
  const positional = process.argv
    .slice(app.isPackaged ? 1 : 2)
    .find((argument) => !argument.startsWith('-'));

  return positional ?? null;
})();

/**
 * Comprobaciones que se ejecutan dentro del renderer.
 *
 * Incluyen la tokenización real de Razor con Monaco, que es la única forma honesta de probar la
 * gramática: fuera del navegador Monaco no se puede cargar, así que un test "unitario" del
 * tokenizador sería un test de otra cosa.
 */
const SMOKE_SCRIPT = `(() => {
  const problems = [];

  // --- Shell -------------------------------------------------------------------------------
  if (!window.dotforge) problems.push('window.dotforge no está expuesto por el preload');
  if (!document.querySelector('.activitybar')?.children.length) problems.push('la barra de actividad está vacía');
  if (!document.querySelector('#statusbar')?.children.length) problems.push('la barra de estado está vacía');
  if (!document.querySelector('#welcome .welcome-inner')) problems.push('la pantalla de bienvenida no se ha pintado');
  if (!document.querySelector('#panel-tabs')?.children.length) problems.push('el panel inferior no tiene pestañas');

  // --- Aislamiento -------------------------------------------------------------------------
  // window.require existe: es el loader AMD de Monaco. Lo que no debe existir es el require de
  // Node, que se distingue por tener cache/resolve.
  if (window.require?.cache || window.require?.resolve) {
    problems.push('el renderer tiene acceso al require de Node: el aislamiento está roto');
  }
  if (window.process?.versions?.node) problems.push('el renderer tiene acceso a process de Node');
  if (window.module?.exports) problems.push('el renderer tiene acceso a module.exports');
  if (window.dotforge && 'ipcRenderer' in window.dotforge) problems.push('el preload expone ipcRenderer');

  // --- Monaco ------------------------------------------------------------------------------
  if (!window.monaco) {
    problems.push('Monaco no se ha cargado');
    return problems;
  }

  const languages = window.monaco.languages.getLanguages().map((language) => language.id);
  for (const expected of ['csharp', 'razor', 'xml', 'json']) {
    if (!languages.includes(expected)) problems.push('falta el lenguaje ' + expected);
  }

  for (const theme of ['dotforge-dark', 'dotforge-light']) {
    try {
      window.monaco.editor.setTheme(theme);
    } catch (error) {
      problems.push('el tema ' + theme + ' no está definido: ' + error.message);
    }
  }

  // --- Tokenización de Razor ------------------------------------------------------------------
  const tokenize = (source) => {
    const lines = window.monaco.editor.tokenize(source, 'razor');
    return lines.map((line) => line.map((token) => token.type));
  };

  const has = (types, needle) => types.some((type) => type.includes(needle));

  const directive = tokenize('@page "/productos"')[0];
  if (!has(directive, 'keyword.directive.razor')) {
    problems.push('@page no se reconoce como directiva: ' + JSON.stringify(directive));
  }
  if (!has(directive, 'string.razor')) {
    problems.push('la ruta de @page no se reconoce como cadena: ' + JSON.stringify(directive));
  }

  const component = tokenize('<MyComponent Value="1" />')[0];
  if (!has(component, 'tag.component.razor')) {
    problems.push('las etiquetas de componente no se distinguen: ' + JSON.stringify(component));
  }

  const html = tokenize('<div class="grid">texto</div>')[0];
  if (!has(html, 'tag.html')) {
    problems.push('las etiquetas HTML no se reconocen: ' + JSON.stringify(html));
  }
  if (has(html, 'tag.component.razor')) {
    problems.push('una etiqueta HTML se ha marcado como componente: ' + JSON.stringify(html));
  }

  const comment = tokenize('@* comentario *@')[0];
  if (!has(comment, 'comment.razor')) {
    problems.push('los comentarios @* *@ no se reconocen: ' + JSON.stringify(comment));
  }

  const code = tokenize('@code {\\n    private int _n = 42;\\n}');
  const flatCode = code.flat();
  if (!flatCode.some((type) => type.includes('keyword.cs') || type.includes('keyword.directive.razor'))) {
    problems.push('el bloque @code no tokeniza C#: ' + JSON.stringify(code));
  }
  if (!flatCode.some((type) => type.includes('number.cs'))) {
    problems.push('los números dentro de @code no se reconocen: ' + JSON.stringify(code));
  }

  const control = tokenize('@foreach (var p in items) { <li>@p.Name</li> }')[0];
  if (!has(control, 'keyword.control.razor')) {
    problems.push('@foreach no se reconoce como bloque de control: ' + JSON.stringify(control));
  }
  if (!has(control, 'tag.html')) {
    problems.push('el HTML dentro de un bloque de control no se tokeniza: ' + JSON.stringify(control));
  }
  if (!has(control, 'keyword.cs')) {
    problems.push('el C# dentro de la condición no se tokeniza: ' + JSON.stringify(control));
  }

  const verbatim = tokenize('@code { var s = @"C:\\\\ruta"; }')[0];
  if (!has(verbatim, 'string.cs')) {
    problems.push('las cadenas verbatim de C# no se reconocen: ' + JSON.stringify(verbatim));
  }

  const escaped = tokenize('correo@@ejemplo.com')[0];
  if (has(escaped, 'keyword.directive.razor')) {
    problems.push('@@ debería ser una arroba literal, no una directiva: ' + JSON.stringify(escaped));
  }

  return problems;
})()`;

function runSmokeTest(window: BrowserWindow): void {
  const problems: string[] = [];
  const TIMEOUT_MS = 60_000;

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // level 3 = error en la consola del renderer.
    if (level >= 3) problems.push(`[console] ${message} (${sourceId}:${line})`);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    problems.push(`[renderer] el proceso ha muerto: ${details.reason}`);
  });

  window.webContents.on('did-fail-load', (_event, code, description) => {
    problems.push(`[load] ${description} (${code})`);
  });

  const finish = (extra: string[]): void => {
    const all = [...problems, ...extra];
    for (const problem of all) console.error(problem);

    if (all.length === 0) {
      console.log('SMOKE_OK');
      app.exit(0);
    } else {
      console.error(`SMOKE_FAIL (${all.length} problema(s))`);
      app.exit(1);
    }
  };

  const timer = setTimeout(() => finish(['[timeout] el renderer no ha terminado de montarse']), TIMEOUT_MS);

  window.webContents.once('did-finish-load', () => {
    // Se da margen a que Monaco cargue y a que el shell se pinte antes de comprobar el DOM.
    setTimeout(() => {
      window.webContents.executeJavaScript(SMOKE_SCRIPT, true)
        .then((domProblems: string[]) => {
          clearTimeout(timer);
          finish(domProblems);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          finish([`[eval] ${error instanceof Error ? error.message : String(error)}`]);
        });
    }, 4000);
  });
}

/** Una sola instancia: dos IDEs sobre el mismo workspace se pisarían los archivos. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function iconPath(): string | undefined {
  const candidates = [
    join(__dirname, 'icons', 'icon.png'),
    join(process.resourcesPath, 'icons', 'icon.png'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * `--wait=<ms>`: amplía la espera antes de capturar o de medir.
 *
 * Existe porque hay cosas que sólo se pueden comprobar cuando ya han pasado: las pastillas de
 * proceso de la barra superior no aparecen hasta que `dotnet run` arranca y anuncia su URL, y eso
 * tarda más que los cinco segundos que basta esperar para que se monte la interfaz.
 */
function millisecondsFlag(name: string): number | null {
  const flag = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const parsed = flag ? Number.parseInt(flag.slice(name.length + 1), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 600_000) : null;
}

const extraWaitMs = millisecondsFlag('--wait');

/**
 * `--ui-wait=<ms>`: cuánto se espera antes de **pulsar** la acción de `--ui=`.
 *
 * Los 3,2 s por defecto bastan con la pantalla de bienvenida, pero no cuando se arranca con una
 * solución abierta: cargar Monaco y leer la solución tarda más, y la acción acababa pulsando un
 * control que todavía no existía. El síntoma era el peor posible: ningún error, simplemente no
 * pasaba nada.
 */
const uiWaitMs = millisecondsFlag('--ui-wait');

/** `--screenshot=<ruta>`: guarda una captura de la ventana y sale. Sirve para el README y el QA. */
const screenshotTarget = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--screenshot='));
  return flag ? flag.slice('--screenshot='.length) : null;
})();

function captureScreenshot(window: BrowserWindow, target: string): void {
  window.webContents.once('did-finish-load', () => {
    // Margen para que Monaco termine de cargar, se ejecute la acción de UI y el shell quede
    // pintado del todo. Con `--wait=` se espera lo que haga falta.
    setTimeout(() => {
      void window.webContents
        .capturePage()
        .then(async (image) => {
          const { writeFile, mkdir } = await import('node:fs/promises');
          const { dirname } = await import('node:path');
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, image.toPNG());

          // Muestreo de píxeles de la imagen realmente capturada. Comparar el color pintado con
          // el que dice getComputedStyle es la única forma de zanjar una discrepancia entre lo
          // que el DOM cree y lo que se ve.
          // Las coordenadas se derivan del tamaño real de la imagen: la ventana no siempre mide
          // lo mismo, y muestrear un punto fuera del lienzo devuelve un color que no es de nadie.
          const { width, height } = image.getSize();
          const sample = (x: number, y: number): string => {
            const inside = {
              x: Math.min(Math.max(0, Math.round(x)), width - 1),
              y: Math.min(Math.max(0, Math.round(y)), height - 1),
            };
            const [b, g, r] = image.crop({ ...inside, width: 1, height: 1 }).toBitmap();
            return `rgb(${r}, ${g}, ${b})`;
          };

          console.log(
            `PIXELS titlebar=${sample(width / 2, 12)} activitybar=${sample(12, height / 2)} ` +
              `sidebar=${sample(width * 0.12, height / 2)} statusbar=${sample(width / 2, height - 13)}`,
          );
          console.log(`SCREENSHOT_OK ${target}`);
          app.exit(0);
        })
        .catch((error: unknown) => {
          console.error(`SCREENSHOT_FAIL ${error instanceof Error ? error.message : String(error)}`);
          app.exit(1);
        });
    }, extraWaitMs ?? 5000);
  });
}

/**
 * `--tokenize=<código>`: imprime cómo tokeniza Monaco ese fragmento en Razor y sale.
 *
 * Existe porque depurar una gramática Monarch a ciegas es carísimo: compila sin quejarse y falla
 * en tiempo de ejecución, y sólo dentro del renderer se puede ver el resultado real.
 */
const tokenizeProbe = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--tokenize='));
  return flag ? flag.slice('--tokenize='.length) : null;
})();

function runTokenizeProbe(window: BrowserWindow, source: string): void {
  window.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void window.webContents
        .executeJavaScript(
          `JSON.stringify(
             window.monaco.editor.tokenize(${JSON.stringify(source)}, 'razor')
               .map((line) => line.map((token) => token.offset + ':' + token.type)),
           )`,
          true,
        )
        .then((result: string) => {
          console.log(`TOKENS ${result}`);
          app.exit(0);
        })
        .catch((error: unknown) => {
          console.error(`TOKENS_FAIL ${error instanceof Error ? error.message : String(error)}`);
          app.exit(1);
        });
    }, 4000);
  });
}

/**
 * Sube desde un directorio buscando el .sln/.slnx más cercano.
 * Si no encuentra ninguno, se queda con el directorio de partida.
 */
function findSolutionRoot(startDir: string): string {
  let current = startDir;

  for (let depth = 0; depth < 8; depth++) {
    try {
      if (readdirSync(current).some((entry) => /.slnx?$/i.test(entry))) return current;
    } catch {
      return startDir;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return startDir;
}

/**
 * `--icons`: sustituye la interfaz por una galería con todos los iconos a varios tamaños.
 *
 * Un set de iconos dibujado a mano necesita revisarse a ojo: una ruta mal cerrada compila,
 * renderiza y sólo se nota mirándola. Esto hace esa revisión posible en un segundo.
 */
const showIconGallery = process.argv.includes('--icons');

function renderIconGallery(window: BrowserWindow): void {
  window.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void window.webContents.executeJavaScript('window.__dotforgeIconGallery && window.__dotforgeIconGallery()');
    }, 1500);
  });
}

/**
 * `--ui=<vista>`: abre una vista antes de la captura, pulsando los mismos controles que pulsaría
 * un usuario. Sirve para revisar en imagen el asistente, los ajustes o la paleta sin tener que
 * exponer ganchos de prueba en el código de producción.
 */
const uiAction = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--ui='));
  return flag ? flag.slice('--ui='.length) : null;
})();

const UI_ACTIONS: Record<string, string> = {
  // La barra de actividad se pulsa por `data-tool-id`, no por posición.
  //
  // Los índices posicionales sobre `.activity-item` se rompieron en silencio dos veces al añadir
  // una herramienta (la Fase 15 metió "pruebas" en el 6; la Fase 17, "extensiones" en el 9, que
  // desplazó "ajustes" al 10), y desde que el usuario puede reordenar la barra arrastrando ya no
  // hay ninguna posición que se pueda dar por buena.
  git: "document.querySelector('.activity-item[data-tool-id=git]')?.click()",
  wizard: "document.querySelector('.activity-item[data-tool-id=wizard]')?.click()",
  nuget: "document.querySelector('.activity-item[data-tool-id=nuget]')?.click()",
  efcore: "document.querySelector('.activity-item[data-tool-id=efcore]')?.click()",
  containers: "document.querySelector('.activity-item[data-tool-id=containers]')?.click()",
  tests: "document.querySelector('.activity-item[data-tool-id=tests]')?.click()",
  debug: "document.querySelector('.activity-item[data-tool-id=debug]')?.click()",
  ai: "document.querySelector('.activity-item[data-tool-id=ai]')?.click()",
  extensions: "document.querySelector('.activity-item[data-tool-id=extensions]')?.click()",
  settings: "document.querySelector('.activity-item[data-tool-id=settings]')?.click()",
  // La tarjeta de actualización con un estado de ejemplo: publicar una versión de verdad en
  // GitHub para poder mirarla no es una opción, y no mirarla nunca tampoco.
  update: 'window.__dotforgeUpdatePreview && window.__dotforgeUpdatePreview()',
  // Cliente HTTP y visor de registro: pestañas del panel inferior.
  http: "[...document.querySelectorAll('.panel-tab')].find((tab) => tab.textContent?.includes('HTTP'))?.click()",
  logs: "[...document.querySelectorAll('.panel-tab')].find((tab) => tab.textContent?.includes('Registro'))?.click()",
  // Abre la pestaña y **arranca la sesión**: un panel de métricas parado no enseña nada que
  // revisar, y esperar a que alguien pulse a mano no es una comprobación reproducible.
  metrics:
    "[...document.querySelectorAll('.panel-tab')].find((tab) => tab.textContent?.includes('Métricas'))?.click();" +
    'setTimeout(() => [...document.querySelectorAll(".metrics-head .btn")]' +
    ".find((button) => button.textContent?.includes('Monitorizar'))?.click(), 3000)",
  // Fase 15: el explorador de pruebas con el árbol ya descubierto, y la auditoría de NuGet.
  'tests-run':
    "document.querySelector('.activity-item[data-tool-id=tests]')?.click();" +
    'setTimeout(() => document.querySelector(".tests-run-all")?.click(), 4000)',
  audit:
    "document.querySelector('.activity-item[data-tool-id=nuget]')?.click();" +
    'setTimeout(() => [...document.querySelectorAll(".nuget-audit-head button")]' +
    ".find((button) => button.textContent?.includes('Analizar'))?.click(), 900)",
  palette: "document.querySelector('#statusbar button:last-of-type')?.click()",
  terminal: "[...document.querySelectorAll('.panel-tab')].find((tab) => tab.textContent?.includes('Terminal'))?.click()",
  // Dos pasos: abrir ajustes y pulsar "Claro". Se encadenan con un retardo porque la vista se
  // repinta entre uno y otro.
  light:
    "document.querySelector('.activity-item[data-tool-id=settings]')?.click();" +
    "setTimeout(() => [...document.querySelectorAll('.segmented button')]" +
    ".find((button) => button.textContent?.includes('Claro'))?.click(), 400)",
  // Despliega el grupo de archivos satélite de appsettings.json.
  'probe-theme':
    "document.querySelector('.activity-item[data-tool-id=settings]')?.click();" +
    "setTimeout(() => {" +
    "  [...document.querySelectorAll('.segmented button')].find((b) => b.textContent?.includes('Claro'))?.click();" +
    "  setTimeout(() => {" +
    "    const root = getComputedStyle(document.documentElement);" +
    "    const bar = document.querySelector('.titlebar');" +
    "    console.error('PROBE html data-theme=' + document.documentElement.dataset.theme" +
    "      + ' app data-theme=' + document.getElementById('app').dataset.theme" +
    "      + ' --bg-deep=' + root.getPropertyValue('--bg-deep').trim()" +
    "      + ' titlebar bg=' + getComputedStyle(bar).backgroundColor);" +
    "  }, 500);" +
    "}, 400)",
  // Fase 9: el selector de inicio de la barra superior y la terminal asistida.
  startup: "document.querySelector('.startup-picker')?.click()",
  'startup-dialog':
    "document.querySelector('.startup-picker')?.click();" +
    "setTimeout(() => [...document.querySelectorAll('.startup-menu-item')]" +
    ".find((item) => item.textContent?.includes('Configurar'))?.click(), 300)",
  // Escribe en la terminal como lo haría un usuario y deja el fantasma a la vista.
  'terminal-suggest':
    "[...document.querySelectorAll('.panel-tab')].find((tab) => tab.textContent?.includes('Terminal'))?.click();" +
    "setTimeout(() => {" +
    "  const input = document.querySelector('.terminal-input-wrap input');" +
    "  if (!input) return;" +
    "  input.focus();" +
    "  input.value = 'git ';" +
    "  input.dispatchEvent(new Event('input', { bubbles: true }));" +
    "}, 300)",
  // Fase 11: arranca el perfil activo, para revisar las pastillas de proceso de la barra superior.
  'startup-play': "document.querySelector('.startup-play')?.click()",
  // Fase 12: arranca el perfil y abre el visor de registro cuando la aplicación ya está escupiendo
  // líneas. Los 12 s son el arranque real de una Web API con restauración caliente.
  'startup-logs':
    "document.querySelector('.startup-play')?.click();" +
    'setTimeout(() => [...document.querySelectorAll(".panel-tab")]' +
    ".find((tab) => tab.textContent?.includes('Registro'))?.click(), 12000)",
  'startup-run-mode':
    "[...document.querySelectorAll('.startup-mode-btn')].find((b) => b.textContent?.includes('Sin depurar'))?.click();" +
    "setTimeout(() => document.querySelector('.startup-play')?.click(), 400)",
  // Fase 11: conmuta "Activar el asistente" en Ajustes. Sirve para revisar a ojo el icono
  // atenuado de la barra de actividad; ejecutarlo dos veces deja la preferencia como estaba.
  'ai-toggle':
    "document.querySelector('.activity-item[data-tool-id=settings]')?.click();" +
    'setTimeout(() => {' +
    "  const row = [...document.querySelectorAll('.settings-toggle')]" +
    "    .find((label) => label.textContent?.includes('Activar el asistente'));" +
    "  row?.querySelector('input')?.click();" +
    '}, 500)',
  // Fase 11: el panel de control de fuentes con una comparación abierta.
  'git-diff':
    "document.querySelector('.activity-item[data-tool-id=git]')?.click();" +
    "setTimeout(() => document.querySelector('.git-row')?.click(), 700)",
  nesting:
    "[...document.querySelectorAll('.tree-row')]" +
    ".find((row) => row.textContent?.includes('appsettings.json'))" +
    "?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))",
};

function runUiAction(window: BrowserWindow, action: string): void {
  const script = UI_ACTIONS[action];
  if (!script) {
    console.error(`acción de UI desconocida: ${action}. Disponibles: ${Object.keys(UI_ACTIONS).join(', ')}`);
    return;
  }

  window.webContents.once('did-finish-load', () => {
    // Se espera a que el renderer termine de montarse (Monaco tarda) antes de pulsar nada.
    setTimeout(() => void window.webContents.executeJavaScript(script, true), uiWaitMs ?? 3200);
  });
}

/**
 * `--probe=<expresión>`: evalúa una expresión en el renderer y la imprime.
 *
 * Complementa a `--ui=`: primero se pulsa lo que haya que pulsar y luego se mide el resultado.
 * Depurar CSS a base de capturas es lento y engañoso; leer el valor calculado no lo es.
 */
const probeExpression = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--probe='));
  return flag ? flag.slice('--probe='.length) : null;
})();

function runProbe(window: BrowserWindow, expression: string): void {
  window.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      // La expresión se envuelve en `Promise.resolve`: así `--probe=` sirve también para medir
      // algo asíncrono —una llamada al proceso principal, una petición al servidor de lenguaje—
      // en vez de imprimir `{}`, que es lo que sale al serializar una promesa.
      void window.webContents
        .executeJavaScript(`Promise.resolve(${expression}).then((value) => JSON.stringify(value))`, true)
        .then((result: string) => {
          console.log(`PROBE ${result}`);
          app.exit(0);
        })
        .catch((error: unknown) => {
          console.error(`PROBE_FAIL ${error instanceof Error ? error.message : String(error)}`);
          app.exit(1);
        });
    }, extraWaitMs ?? (uiAction ? 6000 : 4500));
  });
}

function createWindow(): BrowserWindow {
  const icon = iconPath();

  const options: BrowserWindowConstructorOptions = {
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#14121c',
    title: 'DotForge IDE',
    autoHideMenuBar: false,
    ...(icon ? { icon } : {}),
    // En macOS la barra de título integrada da un aspecto de app nativa moderna.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // Los tres pilares del aislamiento. No se relajan por comodidad.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // El preload necesita `require` de módulos de Electron.
      webviewTag: false,
      spellcheck: false,
      // Sin esto, un `fetch` del renderer podría saltarse la CSP en algunos escenarios.
      webSecurity: true,
    },
  };

  const window = new BrowserWindow(options);

  window.once('ready-to-show', () => {
    if (!isSmokeTest) window.show();
    if (isDevelopment && !isSmokeTest) window.webContents.openDevTools({ mode: 'detach' });
  });

  if (isSmokeTest) runSmokeTest(window);
  if (screenshotTarget) captureScreenshot(window, screenshotTarget);
  if (tokenizeProbe !== null) runTokenizeProbe(window, tokenizeProbe);
  if (showIconGallery) renderIconGallery(window);
  if (uiAction) runUiAction(window, uiAction);
  if (probeExpression) runProbe(window, probeExpression);

  // Toda navegación fuera de la app se abre en el navegador del sistema, nunca dentro.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url);
      }
    }
  });

  // Ningún permiso del navegador tiene sentido en un IDE local: se deniegan todos.
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  void window.loadFile(join(__dirname, 'index.html'));

  return window;
}

app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.whenReady().then(async () => {
  settingsService.initialize(app.getPath('userData'));
  startupService.initialize(app.getPath('userData'));
  aiSecrets.initialize(app.getPath('userData'));
  await settingsService.load();
  await aiSecrets.load();

  // El cliente de IA no conoce el llavero: se le dice de dónde salen las claves.
  aiService.setCredentialSource({
    get: (provider) => aiSecrets.get(provider),
    configured: () => aiSecrets.configuredProviders(),
  });

  extensionInstaller.initialize(app.getPath('userData'));

  // El actualizador recupera aquí lo que quedó descargado en una sesión anterior: si el usuario
  // pulsó "Descartar" y el IDE se fue abajo, la promesa de instalar al cerrar sigue en pie.
  await updaterService.initialize({
    userDataPath: app.getPath('userData'),
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    quit: () => app.quit(),
  });

  registerIpcHandlers();
  installApplicationMenu();

  // El workspace se abre ANTES de crear la ventana: así el renderer ya lo encuentra al pedir
  // `workspace:current` y no hay un parpadeo de pantalla de bienvenida.
  if (workspaceArgument && !isSmokeTest) {
    // Se admite tanto una carpeta como un archivo suelto, igual que `code <ruta>`: si es un
    // archivo, el workspace es su carpeta y además se abre el archivo en el editor.
    let target = workspaceArgument;
    try {
      if (statSync(workspaceArgument).isFile()) {
        setPendingFile(workspaceArgument);
        // La raíz del workspace es la carpeta de la solución, no la del archivo: abrir
        // Products.razor debe dar acceso a toda la solución, no sólo a su carpeta Pages.
        target = findSolutionRoot(dirname(workspaceArgument));
      }
    } catch {
      // Ruta inexistente: openWorkspaceFromCli lo reportará.
    }

    const solution = await openWorkspaceFromCli(target);
    if (solution) startLanguageServerForCurrentWorkspace();
  }

  createWindow();

  /**
   * Comprobación automática, cinco segundos después de arrancar.
   *
   * No es en el momento del arranque a propósito: los primeros segundos se los llevan Monaco, la
   * lectura de la solución y el servidor de lenguaje, y una consulta de red compitiendo con eso
   * sólo consigue que el IDE tarde más en estar utilizable. Se omite en los modos de diagnóstico,
   * que deben partir siempre del mismo estado y no depender de la red.
   */
  if (!isSmokeTest && !uiAction && screenshotTarget === null && settingsService.current().autoUpdateCheck) {
    setTimeout(() => void updaterService.check(), STARTUP_CHECK_DELAY_MS);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Apagado limpio: ningún `dotnet run`, `dotnet watch` ni servidor de lenguaje puede sobrevivir
 * al cierre del IDE ocupando puertos o bloqueando archivos del workspace.
 */
app.on('before-quit', () => {
  /**
   * Actualización pendiente: éste es el único momento en el que se puede aplicar.
   *
   * Va lo primero, antes de parar nada: si algo de lo que viene detrás lanzase una excepción, el
   * instalador ya se habría lanzado. Y se lanza desprendido del proceso, porque el padre está a
   * punto de desaparecer.
   */
  if (updaterService.hasPendingInstall()) {
    const detail = updaterService.runPendingInstaller();
    if (detail !== null) console.log(`[updater] ${detail}`);
  }

  void lspClient.stop();
  // Una petición en streaming sigue consumiendo tokens aunque nadie mire la respuesta.
  aiService.cancelAll();
  // El monitor de rendimiento no pasa por el registro de tareas: tiene su propio proceso y su
  // propia parada. Sin esto, `dotnet-counters` sobrevive al IDE enganchado a la aplicación.
  metricsService.stop();
  processRegistry.killAll();
});

process.on('exit', () => processRegistry.killAll());
