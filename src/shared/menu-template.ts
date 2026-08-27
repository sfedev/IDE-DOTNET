/**
 * Contenido de la barra de menú superior.
 *
 * Está aquí, y no dentro de `src/main/menu.ts`, por un motivo práctico: `menu.ts` importa
 * `electron` y por tanto no se puede cargar en una prueba. Lo que hay que poder comprobar de un
 * menú no es que Electron sepa pintarlo —eso ya lo sabe— sino lo que se rompe en silencio:
 *
 *  - que un menú mande un comando que el renderer no conoce (se pulsa y no pasa nada);
 *  - que dos entradas se peleen por el mismo acelerador (gana una, y no se sabe cuál);
 *  - que al añadir una vista se olvide ponerla en el menú, que es lo que le pasa a la mitad de las
 *    funcionalidades de este IDE — hay 60 comandos en la paleta y el menú enseñaba unos 45.
 *
 * Así que aquí vive la plantilla como **dato**, y `menu.ts` se limita a traducirla a la forma que
 * espera Electron. La prueba mira el dato.
 */
import type { MenuCommand } from './contracts.js';

/**
 * Una entrada de menú.
 *
 * `role` es de Electron (deshacer, copiar, zoom…): son acciones que el sistema resuelve mejor que
 * nosotros, porque conocen el foco y el portapapeles de verdad.
 */
export type MenuEntry =
  | { kind: 'command'; label: string; command: MenuCommand; accelerator?: string }
  | { kind: 'role'; role: string; label: string; accelerator?: string }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'separator' }
  /**
   * Hueco para las soluciones recientes.
   *
   * No son comandos: cada una lleva su ruta, y el proceso principal ya sabe abrir una carpeta sin
   * pasar por el renderer. Se expande en `menu.ts` con la lista del momento.
   */
  | { kind: 'recents'; label: string };

export interface MenuSection {
  label: string;
  items: MenuEntry[];
}

export interface MenuTemplateOptions {
  platform: NodeJS.Platform;
  appName: string;
}

const separator: MenuEntry = { kind: 'separator' };

const command = (label: string, id: MenuCommand, accelerator?: string): MenuEntry => ({
  kind: 'command',
  label,
  command: id,
  ...(accelerator ? { accelerator } : {}),
});

const role = (role: string, label: string, accelerator?: string): MenuEntry => ({
  kind: 'role',
  role,
  label,
  ...(accelerator ? { accelerator } : {}),
});

/**
 * Aceleradores que Electron le pone **por su cuenta** a cada `role`.
 *
 * Están escritos aquí porque son la mitad invisible del problema: un `role` no declara acelerador
 * en la plantilla y aun así ocupa uno, así que sin esta tabla la comprobación de choques mira sólo
 * la mitad de las teclas y da un verde falso. Los dos choques que había —`F11` entre pantalla
 * completa y "paso a paso por instrucciones", y `Ctrl+W` entre cerrar pestaña y cerrar ventana— no
 * los encontró la prueba: los encontró `--menu-dump` mirando el menú ya construido.
 *
 * Sólo están los roles que se usan aquí. Añadir un `role` nuevo con acelerador propio y no
 * apuntarlo vuelve a dejar el agujero, y por eso hay una prueba que exige que todos los roles de la
 * plantilla estén en esta tabla o declaren el suyo.
 */
export const ROLE_ACCELERATORS: Readonly<Record<string, string | null>> = {
  undo: 'CmdOrCtrl+Z',
  redo: 'CmdOrCtrl+Y',
  cut: 'CmdOrCtrl+X',
  copy: 'CmdOrCtrl+C',
  paste: 'CmdOrCtrl+V',
  selectAll: 'CmdOrCtrl+A',
  resetZoom: 'CmdOrCtrl+0',
  zoomIn: 'CmdOrCtrl+Plus',
  zoomOut: 'CmdOrCtrl+-',
  togglefullscreen: 'F11',
  toggleDevTools: 'CmdOrCtrl+Shift+I',
  minimize: 'CmdOrCtrl+M',
  close: 'CmdOrCtrl+W',
  quit: 'CmdOrCtrl+Q',
  hide: 'Command+H',
  hideOthers: 'Command+Alt+H',
  unhide: null,
  services: null,
  front: null,
  zoom: null,
};

/**
 * La barra de menú entera.
 *
 * El orden de las secciones es el de cualquier IDE de escritorio, y eso no es decoración: quien
 * viene de Visual Studio busca "Compilar" a la derecha de "Ver" sin leer, y encontrarlo en otro
 * sitio cuesta más que no tener menú.
 */
export function buildMenuTemplate(options: MenuTemplateOptions): MenuSection[] {
  const isMac = options.platform === 'darwin';
  const sections: MenuSection[] = [];

  if (isMac) {
    sections.push({
      label: options.appName,
      items: [
        command('Acerca de DotForge IDE', 'help.about'),
        separator,
        command('Buscar actualizaciones…', 'update.check'),
        separator,
        role('services', 'Servicios'),
        separator,
        role('hide', 'Ocultar DotForge IDE'),
        role('hideOthers', 'Ocultar otros'),
        role('unhide', 'Mostrar todo'),
        separator,
        role('quit', 'Salir de DotForge IDE'),
      ],
    });
  }

  sections.push(
    {
      label: 'Archivo',
      items: [
        command('Nueva solución con el asistente…', 'scaffold.wizard', 'CmdOrCtrl+Shift+N'),
        command('Nuevo archivo', 'file.new', 'CmdOrCtrl+N'),
        separator,
        command('Abrir solución…', 'file.open-solution', 'CmdOrCtrl+Shift+O'),
        command('Abrir carpeta…', 'file.open-folder', 'CmdOrCtrl+O'),
        { kind: 'recents', label: 'Soluciones recientes' },
        separator,
        command('Guardar', 'file.save', 'CmdOrCtrl+S'),
        command('Guardar todo', 'file.save-all', 'CmdOrCtrl+Alt+S'),
        command('Cerrar pestaña', 'file.close-tab', 'CmdOrCtrl+W'),
        separator,
        command('Cerrar la solución', 'file.close-workspace'),
        separator,
        // En macOS "salir" vive en el menú de la aplicación, como manda la plataforma; en su lugar
        // va "cerrar ventana", con `Cmd+Shift+W` porque `Cmd+W` ya es cerrar pestaña. Este choque
        // no se veía: el role hereda `CmdOrCtrl+W` sin declararlo, y lo encontró la comprobación al
        // empezar a mirar también los aceleradores heredados.
        isMac ? role('close', 'Cerrar la ventana', 'CmdOrCtrl+Shift+W') : role('quit', 'Salir'),
      ],
    },
    {
      label: 'Editar',
      items: [
        role('undo', 'Deshacer'),
        role('redo', 'Rehacer'),
        separator,
        role('cut', 'Cortar'),
        role('copy', 'Copiar'),
        role('paste', 'Pegar'),
        role('selectAll', 'Seleccionar todo'),
        separator,
        command('Buscar en el archivo', 'edit.find', 'CmdOrCtrl+F'),
        // Dos entradas porque son dos cosas distintas, y confundirlas es lo que se quería evitar
        // cuando aquí sólo estaba la segunda: una busca **dentro** de los archivos y abre el
        // resultado en su línea y su columna; la otra filtra el árbol del explorador por nombre.
        // `Ctrl+Shift+F` es la primera, que es donde la busca quien viene de cualquier otro editor.
        command('Buscar en los archivos…', 'search.findInFiles', 'CmdOrCtrl+Shift+F'),
        command('Buscar archivos por nombre…', 'edit.find-in-files', 'CmdOrCtrl+P'),
        separator,
        command('Formatear documento', 'edit.format', 'Alt+Shift+F'),
        command('Ir a la definición', 'edit.go-to-definition', 'F12'),
        command('Renombrar el símbolo', 'edit.rename', 'F2'),
        separator,
        command('Editar con el asistente en línea…', 'ai.inline', 'CmdOrCtrl+I'),
      ],
    },
    {
      label: 'Ver',
      items: [
        command('Paleta de comandos', 'view.command-palette', 'CmdOrCtrl+Shift+P'),
        separator,
        // `Ctrl+B` es donde lo busca todo el mundo, y aquí estaba libre. La entrada dice
        // "Barra lateral" y no "Ocultar la barra lateral": el menú es estático en Electron una vez
        // puesto, así que una etiqueta que dependa del estado mentiría la mitad del tiempo.
        command('Barra lateral', 'view.toggle-sidebar', 'CmdOrCtrl+B'),
        separator,
        command('Explorador de soluciones', 'view.explorer', 'CmdOrCtrl+Shift+E'),
        command('Buscar en los archivos', 'search.findInFiles'),
        command('Control de código fuente', 'view.source-control', 'CmdOrCtrl+Shift+G'),
        command('Base de datos y EF Core', 'view.efcore', 'CmdOrCtrl+Shift+D'),
        command('Contenedores y Docker Compose', 'view.containers', 'CmdOrCtrl+Shift+K'),
        command('DotForge AI Assistant', 'ai.chat', 'CmdOrCtrl+Shift+A'),
        command('Paquetes NuGet', 'view.nuget', 'CmdOrCtrl+Shift+U'),
        command('Explorador de pruebas', 'view.tests', 'CmdOrCtrl+Shift+Y'),
        command('Extensiones', 'view.extensions'),
        command('Ajustes', 'view.settings', 'CmdOrCtrl+,'),
        separator,
        command('Terminal integrada', 'view.terminal', 'CmdOrCtrl+J'),
        command('Nueva terminal', 'terminal.new'),
        command('Salida', 'view.output'),
        command('Problemas', 'view.problems', 'CmdOrCtrl+Shift+M'),
        command('Registro de la aplicación', 'view.logs', 'CmdOrCtrl+Shift+L'),
        command('Monitor de rendimiento', 'view.metrics'),
        separator,
        command('Tema oscuro', 'view.theme-dark'),
        command('Tema claro', 'view.theme-light'),
        separator,
        role('resetZoom', 'Zoom normal'),
        role('zoomIn', 'Acercar'),
        role('zoomOut', 'Alejar'),
        separator,
        // `Alt+Shift+Enter` y no `F11`: F11 es "paso a paso por instrucciones" desde Visual Studio, y
        // en un IDE eso pesa más que la pantalla completa. Es además el atajo que usa el propio
        // Visual Studio para pantalla completa, así que no se inventa nada.
        role('togglefullscreen', 'Pantalla completa', 'Alt+Shift+Enter'),
        role('toggleDevTools', 'Herramientas de desarrollo'),
      ],
    },
    {
      label: 'Datos',
      items: [
        command('Migraciones y esquema de EF Core', 'view.efcore'),
        command('Añadir migración…', 'efcore.add-migration'),
        command('Actualizar la base de datos', 'efcore.update-database'),
        separator,
        command('Cliente HTTP (.http / .rest)', 'view.http'),
        command('Enviar la petición del cursor', 'http.send-request', 'Alt+Enter'),
        command('Generar pruebas HTTP del archivo', 'http.generate-file'),
        separator,
        command('Contenedores y Docker Compose', 'view.containers'),
        command('Levantar los servicios del compose', 'docker.compose-up'),
        command('Bajar los servicios del compose', 'docker.compose-down'),
      ],
    },
    {
      label: 'Git',
      items: [
        command('Abrir el control de código fuente', 'view.source-control'),
        separator,
        command('Confirmar los cambios preparados', 'git.commit'),
        command('Publicar (push)', 'git.push'),
        command('Traer del remoto (pull)', 'git.pull'),
        command('Sincronizar', 'git.sync'),
      ],
    },
    {
      label: 'Compilar',
      items: [
        command('Compilar solución', 'build.build', 'CmdOrCtrl+Shift+B'),
        command('Recompilar todo', 'build.rebuild', 'CmdOrCtrl+Alt+B'),
        command('Limpiar', 'build.clean'),
        command('Restaurar paquetes', 'build.restore'),
        separator,
        command('Ejecutar pruebas', 'build.test', 'CmdOrCtrl+Shift+T'),
        command('Ejecutar todas las pruebas del explorador', 'tests.run-all'),
        command('Ejecutar las pruebas del archivo actual', 'tests.run-file'),
        separator,
        command('Revisar las reglas de arquitectura', 'architecture.check'),
        command('Buscar vulnerabilidades en los paquetes', 'nuget.audit'),
        command('Reiniciar el servidor de lenguaje de C#', 'lsp.restart'),
      ],
    },
    {
      label: 'Depurar',
      items: [
        command('Iniciar depuración', 'run.start', 'F5'),
        command('Ejecutar sin depurar', 'run.without-debug'),
        command('Iniciar con Hot Reload (dotnet watch)', 'run.watch', 'CmdOrCtrl+F5'),
        command('Detener', 'run.stop', 'Shift+F5'),
        separator,
        command('Alternar breakpoint', 'debug.toggle-breakpoint', 'F9'),
        command('Continuar', 'debug.continue'),
        command('Paso a paso por procedimientos', 'debug.step-over', 'F10'),
        command('Paso a paso por instrucciones', 'debug.step-in', 'F11'),
        command('Salir del método', 'debug.step-out', 'Shift+F11'),
        separator,
        command('Crear túnel público…', 'tunnel.create'),
        command('Cerrar el túnel público', 'tunnel.stop'),
        command('Monitor de rendimiento', 'view.metrics'),
      ],
    },
    {
      label: 'IA',
      items: [
        command('Abrir DotForge AI Assistant', 'ai.chat'),
        command('Editar el código seleccionado…', 'ai.inline'),
        separator,
        command('Explicar el código', 'ai.explain'),
        command('Generar pruebas xUnit', 'ai.tests'),
        command('Corregir la violación de arquitectura', 'ai.fix'),
        separator,
        // Claude Code no es una extensión aquí: es un intérprete más del catálogo de la terminal
        // (ADR-062). Va en este menú porque es donde lo busca quien lo quiere usar, no en Ver.
        command('Abrir Claude Code en Terminal', 'ai.openClaudeTerminal', 'CmdOrCtrl+Shift+C'),
        separator,
        command('Empezar una conversación nueva', 'ai.reset'),
      ],
    },
    {
      label: 'Ventana',
      items: isMac
        ? [role('minimize', 'Minimizar'), role('zoom', 'Zoom'), separator, role('front', 'Traer todo al frente')]
        : [
            role('minimize', 'Minimizar'),
            // `Ctrl+Shift+W` para cerrar la ventana: `Ctrl+W` cierra la pestaña, como en cualquier
            // editor. Electron le pone `Ctrl+W` a este role por su cuenta si no se le dice otra cosa.
            role('close', 'Cerrar la ventana', 'CmdOrCtrl+Shift+W'),
          ],
    },
    {
      label: 'Ayuda',
      items: [
        command('Buscar actualizaciones…', 'update.check'),
        separator,
        // La documentación didáctica es la que genera el propio asistente: cada arquitectura sale
        // con un README que explica sus capas y por qué. Abrirla desde el menú es lo que convierte
        // el generador en algo que se puede aprender en vez de sólo ejecutar.
        command('Documentación de la solución abierta', 'help.docs'),
        { kind: 'link', label: 'Documentación de .NET', url: 'https://learn.microsoft.com/dotnet/' },
        {
          kind: 'link',
          label: 'Documentación de Blazor',
          url: 'https://learn.microsoft.com/aspnet/core/blazor/',
        },
        { kind: 'link', label: 'Open VSX Registry', url: 'https://open-vsx.org/' },
        separator,
        command('Acerca de DotForge IDE', 'help.about'),
      ],
    },
  );

  return sections;
}

// ---------------------------------------------------------------------------------------------
// Comprobaciones sobre la plantilla
// ---------------------------------------------------------------------------------------------

/** Todos los comandos que manda la barra de menú, sin repetir. */
export function commandsOf(sections: readonly MenuSection[]): MenuCommand[] {
  const found = new Set<MenuCommand>();
  for (const section of sections) {
    for (const item of section.items) {
      if (item.kind === 'command') found.add(item.command);
    }
  }
  return [...found];
}

/**
 * Acelerador que ocupa una entrada, declarado o heredado del `role`.
 *
 * Normaliza `CommandOrControl` a `CmdOrCtrl` porque Electron acepta los dos literales para la misma
 * tecla: compararlos como texto haría que un choque real pasara desapercibido.
 */
export function acceleratorOf(item: MenuEntry): string | null {
  if (item.kind === 'command') return normalizeAccelerator(item.accelerator ?? null);
  if (item.kind !== 'role') return null;

  return normalizeAccelerator(item.accelerator ?? ROLE_ACCELERATORS[item.role] ?? null);
}

export function normalizeAccelerator(accelerator: string | null): string | null {
  return accelerator === null ? null : accelerator.replace(/^CommandOrControl\+/, 'CmdOrCtrl+');
}

export interface AcceleratorClash {
  accelerator: string;
  labels: string[];
}

/**
 * Aceleradores repetidos.
 *
 * Electron no avisa: registra los dos y gana uno, y cuál gana no está escrito en ningún sitio. Un
 * atajo que a veces hace una cosa y a veces otra es peor que no tener atajo, así que esto lo vigila
 * una prueba.
 *
 * Un mismo comando puede aparecer en dos menús a propósito —"Contenedores" está en Ver y en Datos—
 * pero **sólo uno de los dos puede llevar el acelerador**; el otro se pone sin él.
 */
export function acceleratorClashes(sections: readonly MenuSection[]): AcceleratorClash[] {
  const byAccelerator = new Map<string, string[]>();

  for (const section of sections) {
    for (const item of section.items) {
      const accelerator = acceleratorOf(item);
      if (accelerator === null || item.kind === 'separator') continue;

      const labels = byAccelerator.get(accelerator) ?? [];
      labels.push(`${section.label} > ${item.label}`);
      byAccelerator.set(accelerator, labels);
    }
  }

  return [...byAccelerator.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([accelerator, labels]) => ({ accelerator, labels }));
}
