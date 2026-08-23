/**
 * Menú nativo y atajos de teclado.
 *
 * Los aceleradores usan `CmdOrCtrl`, que Electron resuelve a Cmd en macOS y a Ctrl en el resto:
 * `Ctrl+Shift+B` en Windows y `Cmd+Shift+B` en macOS salen del mismo literal. `F5` es igual en
 * ambas plataformas, como manda la costumbre de Visual Studio.
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';

import { IPC_EVENTS, type MenuCommand } from '../shared/contracts.js';

function send(command: MenuCommand): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) {
    window.webContents.send(IPC_EVENTS.menuCommand, command);
  }
}

function item(label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions {
  return { label, ...(accelerator ? { accelerator } : {}), click: () => send(command) };
}

export function buildApplicationMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const macAppMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.getName(),
          submenu: [
            { role: 'about', label: 'Acerca de DotForge IDE' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide', label: 'Ocultar DotForge IDE' },
            { role: 'hideOthers', label: 'Ocultar otros' },
            { role: 'unhide', label: 'Mostrar todo' },
            { type: 'separator' },
            { role: 'quit', label: 'Salir de DotForge IDE' },
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...macAppMenu,
    {
      label: 'Archivo',
      submenu: [
        item('Nueva solución con el asistente…', 'scaffold.wizard', 'CmdOrCtrl+Shift+N'),
        item('Nuevo archivo', 'file.new', 'CmdOrCtrl+N'),
        { type: 'separator' },
        item('Abrir carpeta…', 'file.open-folder', 'CmdOrCtrl+O'),
        { type: 'separator' },
        item('Guardar', 'file.save', 'CmdOrCtrl+S'),
        item('Guardar todo', 'file.save-all', 'CmdOrCtrl+Alt+S'),
        item('Cerrar pestaña', 'file.close-tab', 'CmdOrCtrl+W'),
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Cerrar ventana' } : { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' },
        { type: 'separator' },
        item('Buscar', 'edit.find', 'CmdOrCtrl+F'),
        item('Formatear documento', 'edit.format', 'Alt+Shift+F'),
      ],
    },
    {
      label: 'Ver',
      submenu: [
        item('Paleta de comandos', 'view.command-palette', 'CmdOrCtrl+Shift+P'),
        { type: 'separator' },
        item('Explorador de soluciones', 'view.explorer', 'CmdOrCtrl+Shift+E'),
        item('Control de código fuente', 'view.source-control', 'CmdOrCtrl+Shift+G'),
        item('Paquetes NuGet', 'view.nuget', 'CmdOrCtrl+Shift+U'),
        item('Problemas', 'view.problems', 'CmdOrCtrl+Shift+M'),
        item('Salida y terminal', 'view.terminal', 'CmdOrCtrl+J'),
        { type: 'separator' },
        item('Cambiar tema', 'view.toggle-theme'),
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      ],
    },
    {
      label: 'IA',
      submenu: [
        item('Abrir DotForge AI Assistant', 'ai.chat', 'CmdOrCtrl+Shift+A'),
        item('Editar el código seleccionado…', 'ai.inline', 'CmdOrCtrl+I'),
        { type: 'separator' },
        item('Explicar el código', 'ai.explain'),
        item('Generar pruebas xUnit', 'ai.tests'),
      ],
    },
    {
      label: 'Git',
      submenu: [
        item('Abrir el control de código fuente', 'view.source-control', 'CmdOrCtrl+Shift+G'),
        { type: 'separator' },
        item('Confirmar los cambios preparados', 'git.commit'),
        item('Publicar (push)', 'git.push'),
        item('Traer del remoto (pull)', 'git.pull'),
        item('Sincronizar', 'git.sync'),
      ],
    },
    {
      label: 'Compilar',
      submenu: [
        item('Compilar solución', 'build.build', 'CmdOrCtrl+Shift+B'),
        item('Recompilar todo', 'build.rebuild', 'CmdOrCtrl+Alt+B'),
        item('Limpiar', 'build.clean'),
        item('Restaurar paquetes', 'build.restore'),
        { type: 'separator' },
        item('Ejecutar pruebas', 'build.test', 'CmdOrCtrl+Shift+T'),
      ],
    },
    {
      label: 'Depurar',
      submenu: [
        item('Iniciar depuración', 'run.start', 'F5'),
        item('Ejecutar sin depurar', 'run.without-debug'),
        item('Iniciar con Hot Reload (dotnet watch)', 'run.watch', 'CmdOrCtrl+F5'),
        item('Detener', 'run.stop', 'Shift+F5'),
        { type: 'separator' },
        item('Alternar breakpoint', 'debug.toggle-breakpoint', 'F9'),
        item('Continuar', 'debug.continue'),
        item('Paso a paso por procedimientos', 'debug.step-over', 'F10'),
        item('Paso a paso por instrucciones', 'debug.step-in', 'F11'),
        item('Salir del método', 'debug.step-out', 'Shift+F11'),
      ],
    },
    {
      label: 'Ventana',
      submenu: isMac
        ? [
            { role: 'minimize', label: 'Minimizar' },
            { role: 'zoom', label: 'Zoom' },
            { type: 'separator' },
            { role: 'front', label: 'Traer todo al frente' },
          ]
        : [
            { role: 'minimize', label: 'Minimizar' },
            { role: 'close', label: 'Cerrar' },
          ],
    },
    {
      label: 'Ayuda',
      submenu: [
        item('Acerca de DotForge IDE', 'help.about'),
        {
          label: 'Documentación de .NET',
          click: () => void shell.openExternal('https://learn.microsoft.com/dotnet/'),
        },
        {
          label: 'Documentación de Blazor',
          click: () => void shell.openExternal('https://learn.microsoft.com/aspnet/core/blazor/'),
        },
        {
          label: 'Open VSX Registry',
          click: () => void shell.openExternal('https://open-vsx.org/'),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(buildApplicationMenu());
}
