/**
 * Barra de menú nativa y atajos de teclado.
 *
 * El **contenido** del menú no está aquí: está en `src/shared/menu-template.ts`, como dato puro y
 * con sus pruebas. Este archivo hace sólo la traducción a lo que espera Electron, más las dos cosas
 * que sí necesitan al proceso principal: abrir una solución reciente y abrir un enlace externo.
 *
 * Ese reparto tiene un motivo concreto: `electron` no se puede importar en una prueba, así que
 * mientras la plantilla viviera aquí no había forma de comprobar lo que se rompe en silencio —un
 * comando que el renderer no conoce, dos entradas peleándose por el mismo acelerador— salvo
 * abriendo los menús a mano uno por uno.
 *
 * Los aceleradores usan `CmdOrCtrl`, que Electron resuelve a Cmd en macOS y a Ctrl en el resto:
 * `Ctrl+Shift+B` en Windows y `Cmd+Shift+B` en macOS salen del mismo literal. `F5` es igual en
 * ambas plataformas, como manda la costumbre de Visual Studio.
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';

import { IPC_EVENTS, type MenuCommand, type RecentWorkspace } from '../shared/contracts.js';
import { buildMenuTemplate, type MenuEntry, type MenuSection } from '../shared/menu-template.js';

/** Máximo de recientes en el menú. Más de ocho deja de ser un atajo y pasa a ser una lista. */
const MAX_RECENT_ITEMS = 8;

export interface MenuDependencies {
  /** Soluciones recientes, ya con su disponibilidad resuelta. */
  recents(): RecentWorkspace[];
  /** Abre una carpeta reciente. Lo resuelve el proceso principal: ya sabe hacerlo. */
  openRecent(path: string): void;
}

let dependencies: MenuDependencies = { recents: () => [], openRecent: () => {} };

function send(command: MenuCommand): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) {
    window.webContents.send(IPC_EVENTS.menuCommand, command);
  }
}

/** Último segmento de una ruta, con cualquiera de los dos separadores. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  return parts.at(-1) ?? path;
}

/**
 * Submenú de soluciones recientes.
 *
 * Las que ya no están **se enseñan deshabilitadas**, no se esconden: quien busca un proyecto que
 * movió ayer necesita ver que el IDE lo recuerda y que la carpeta ya no está ahí. Esconderlas
 * dejaría un menú que cambia de contenido sin explicación (misma regla que ADR-023).
 */
function recentsSubmenu(label: string): MenuItemConstructorOptions {
  const recents = dependencies.recents().slice(0, MAX_RECENT_ITEMS);

  if (recents.length === 0) {
    return { label, submenu: [{ label: 'No hay ninguna todavía', enabled: false }] };
  }

  return {
    label,
    submenu: recents.map((entry) => ({
      label: entry.available ? folderName(entry.path) : `${folderName(entry.path)} (no disponible)`,
      // La ruta entera en el tooltip: dos soluciones pueden llamarse igual en carpetas distintas.
      toolTip: entry.path,
      enabled: entry.available,
      click: () => dependencies.openRecent(entry.path),
    })),
  };
}

function toElectronItem(entry: MenuEntry): MenuItemConstructorOptions {
  switch (entry.kind) {
    case 'separator':
      return { type: 'separator' };
    case 'role':
      return {
        role: entry.role as MenuItemConstructorOptions['role'],
        label: entry.label,
        // Un `role` trae su propio acelerador si no se le dice otra cosa, y ahí es donde se colaban
        // los choques: `togglefullscreen` se quedaba `F11` —que en un IDE es "paso a paso por
        // instrucciones"— y `close` se quedaba `Ctrl+W`, que es cerrar pestaña.
        ...(entry.accelerator ? { accelerator: entry.accelerator } : {}),
      };
    case 'link':
      return { label: entry.label, click: () => void shell.openExternal(entry.url) };
    case 'recents':
      return recentsSubmenu(entry.label);
    case 'command':
      return {
        label: entry.label,
        ...(entry.accelerator ? { accelerator: entry.accelerator } : {}),
        click: () => send(entry.command),
      };
  }
}

function toElectronSection(section: MenuSection): MenuItemConstructorOptions {
  return { label: section.label, submenu: section.items.map(toElectronItem) };
}

export function buildApplicationMenu(): Menu {
  const template = buildMenuTemplate({ platform: process.platform, appName: app.getName() });
  return Menu.buildFromTemplate(template.map(toElectronSection));
}

/**
 * Instala (o reinstala) la barra de menú.
 *
 * Se reinstala al abrir o cerrar una solución, y no sólo al arrancar: un menú de Electron es
 * estático una vez puesto, así que la lista de recientes sólo se pone al día volviendo a
 * construirlo. Es barato —son unas decenas de entradas— y es la única forma de que "Soluciones
 * recientes" no mienta.
 */
export function installApplicationMenu(deps?: MenuDependencies): void {
  if (deps) dependencies = deps;
  Menu.setApplicationMenu(buildApplicationMenu());
}
