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
import * as processRegistry from './services/process-registry.js';
import * as settingsService from './services/settings-service.js';

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

/** `--screenshot=<ruta>`: guarda una captura de la ventana y sale. Sirve para el README y el QA. */
const screenshotTarget = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--screenshot='));
  return flag ? flag.slice('--screenshot='.length) : null;
})();

function captureScreenshot(window: BrowserWindow, target: string): void {
  window.webContents.once('did-finish-load', () => {
    // Margen para que Monaco termine de cargar y el shell quede pintado del todo.
    setTimeout(() => {
      void window.webContents
        .capturePage()
        .then(async (image) => {
          const { writeFile, mkdir } = await import('node:fs/promises');
          const { dirname } = await import('node:path');
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, image.toPNG());
          console.log(`SCREENSHOT_OK ${target}`);
          app.exit(0);
        })
        .catch((error: unknown) => {
          console.error(`SCREENSHOT_FAIL ${error instanceof Error ? error.message : String(error)}`);
          app.exit(1);
        });
    }, 5000);
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
  await settingsService.load();

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
  void lspClient.stop();
  processRegistry.killAll();
});

process.on('exit', () => processRegistry.killAll());
