/**
 * Panel inferior: salida, terminal, problemas y depuración.
 *
 * Dos ideas gobiernan este archivo:
 *
 * 1. **Un canal por proceso.** Arrancar una API y una UI a la vez y mezclar sus dos logs en un
 *    único buffer hace ilegibles los dos. Cada proceso lanzado desde el selector de inicio tiene
 *    su canal, con su nombre, su estado y el puerto en el que escucha.
 * 2. **La salida se añade, no se repinta.** El panel se redibujaba entero por cada trozo de
 *    salida; con un `dotnet watch` escupiendo líneas eso repintaba miles de nodos por segundo y,
 *    peor, destruía el input de la terminal mientras se escribía en él. Ahora se añade sólo la
 *    línea nueva al log visible.
 */
import type {
  BuildDiagnostic,
  DotnetTaskExit,
  DotnetTaskStarted,
  ProjectKind,
  TerminalCwd,
  TerminalProfileInfo,
} from '../../shared/contracts.js';
import { findProfile, terminalTabName } from '../../shared/terminal-profiles.js';
import type { LogEvent, LogLevel } from '../../shared/log-events.js';
import { countByLevel, filterEvents, firstNavigableFrame, LEVEL_LABEL, parseLogEvents } from '../../shared/log-events.js';
import { byId, clear, el, repaintPreservingFocus } from '../dom.js';
import { FOCUS_KEY_ATTRIBUTE } from '../focus-guard.js';
import { presentProject } from '../file-icons.js';
import { icon, type IconName } from '../icons.js';
import { detectListeningUrl, portOf } from '../run-output.js';
import { applyTheme, createTerminal, type XtermFitAddon, type XtermTerminal } from '../xterm-bridge.js';
import {
  applySuggestion,
  caretAfterApply,
  ghostText,
  suggest,
  splitLine,
  type SuggestContext,
  type Suggestion,
} from '../terminal-suggest.js';

const MAX_OUTPUT_LINES = 5000;

/**
 * Una pestaña de terminal.
 *
 * Las de tipo `lite` no tienen sesión ni emulador: son la terminal asistida de siempre, que pinta
 * su propio `<input>` y su log. Las de tipo `pty` llevan un emulador de xterm y un contenedor DOM
 * **persistente**, que se reinserta tal cual en cada repintado del panel: volver a abrir el
 * emulador sobre un nodo nuevo perdería el histórico entero de la sesión.
 */
interface TerminalTab {
  id: string;
  profileId: string;
  label: string;
  kind: 'pty' | 'lite';
  /** Identificador de la sesión en el proceso principal. `null` en la asistida y tras un `exit`. */
  terminalId: string | null;
  host: HTMLElement | null;
  term: XtermTerminal | null;
  fit: XtermFitAddon | null;
  /** `term.open()` ya se ha llamado sobre un contenedor que estaba en el documento. */
  opened?: boolean;
  /** El intérprete ha terminado. La pestaña se queda, con lo último que escribió. */
  exited: boolean;
}

/** Cuántas sugerencias se listan en el menú. Más que esto ya no se lee: se ojea. */
const MAX_SUGGESTIONS = 8;

export type PanelTab = 'output' | 'terminal' | 'problems' | 'debug' | 'http' | 'logs' | 'metrics';

export interface PanelHost {
  openDiagnostic(diagnostic: BuildDiagnostic): void;
  cancelTask(taskId: string): void;
  runCommand(line: string): void;
  renderDebug(container: HTMLElement): void;
  /** Pinta el cliente HTTP dentro del panel. Misma idea que `renderDebug`. */
  renderHttp(container: HTMLElement): void;
  /** Pinta el monitor de rendimiento. Misma idea que `renderDebug`. */
  renderMetrics(container: HTMLElement): void;
  /** Abre un archivo por su ruta y línea: lo pide un marco de pila del visor de registro. */
  openLogLocation(file: string, line: number): void;
  /** Contexto para el autocompletado: ramas de git y proyectos de la solución. */
  suggestContext(): SuggestContext;
  /** Abre una URL en el navegador del sistema. */
  openUrl(url: string): void;
  /** Vuelve a lanzar el proceso de un canal (el botón de reinicio de su pestaña). */
  restartService(service: ServiceInfo): void;
  /** Detiene la sesión de depuración: es la forma de parar un proceso depurado. */
  stopDebug(): void;
  /**
   * Algo ha cambiado en la lista de procesos: uno ha arrancado, ha muerto o acaba de anunciar su
   * URL. Lo escucha la barra superior, que pinta una pastilla por proceso vivo.
   */
  servicesChanged(): void;
  /**
   * Aviso al usuario.
   *
   * Lo pide abrir una terminal: `pwsh.exe` ofrecido y no instalado, o `node-pty` ausente, son
   * estados normales que hay que contar en una línea. Sin esto el botón `+` no haría nada visible,
   * que es la peor de las respuestas posibles.
   */
  notify(message: string, level: 'info' | 'ok' | 'warn' | 'error'): void;
}

/**
 * Un proceso arrancado desde el selector de inicio, visto desde fuera del panel.
 *
 * Lo consumen la barra superior (para pintar sus "pills" de estado) y el propio panel. Se expone
 * como dato plano y no como el canal entero para que nadie de fuera pueda tocarle el búfer.
 */
export interface ServiceInfo {
  /** Id del canal de salida. Es lo que hay que pasar a `showChannel`. */
  id: string;
  label: string;
  status: 'idle' | 'running' | 'ok' | 'failed';
  url: string | null;
  taskId: string | null;
  projectPath: string | null;
  projectKind: ProjectKind | null;
  /** true si lo gobierna el depurador: se para con `debug:stop`, no cancelando una tarea. */
  isDebug: boolean;
}

type LineKind = 'plain' | 'error' | 'ok' | 'command';

const LINE_CLASS: Record<LineKind, string> = {
  plain: '',
  error: 'line-err',
  ok: 'line-ok',
  command: 'line-cmd',
};

const SEVERITY_ICON: Record<BuildDiagnostic['severity'], IconName> = {
  error: 'alert-circle',
  warning: 'alert-triangle',
  info: 'info',
};

interface Line {
  text: string;
  kind: LineKind;
}

type ChannelStatus = 'idle' | 'running' | 'ok' | 'failed';

interface Channel {
  id: string;
  label: string;
  /** `build` es el canal por defecto; `process` es un proyecto arrancado. */
  kind: 'build' | 'process';
  lines: Line[];
  taskId: string | null;
  url: string | null;
  status: ChannelStatus;
  /** Proyecto del que salió el proceso, para la insignia de tipo y para poder reiniciarlo. */
  projectPath: string | null;
  projectKind: ProjectKind | null;
  /**
   * true si el proceso lo gobierna el depurador y no una tarea.
   *
   * Importa para los botones: un proceso depurado no tiene `taskId` que cancelar, se para con
   * `debug:stop`. Sin esta marca, su botón de detener quedaba deshabilitado para siempre.
   */
  isDebug: boolean;
}

/** Texto del estado de un proceso. Es lo que se lee en la cabecera de su canal. */
const STATUS_LABEL: Record<ChannelStatus, string> = {
  idle: 'Preparado',
  running: 'En ejecución',
  ok: 'Detenido',
  failed: 'Error',
};

const BUILD_CHANNEL = 'build';
const TERMINAL_CHANNEL = 'terminal';

export class PanelView {
  private tab: PanelTab = 'output';
  private diagnostics: BuildDiagnostic[] = [];

  /** Violaciones de las reglas de arquitectura. Sobreviven a una compilación correcta. */
  private architecture: BuildDiagnostic[] = [];

  /**
   * Pruebas en rojo de la última ejecución.
   *
   * Tienen su propia lista por el mismo motivo que las de arquitectura: una compilación correcta
   * no arregla una prueba que falla, así que no puede borrar su problema. Se van cuando se vuelve
   * a ejecutar la prueba, que es lo único que cambia el hecho.
   */
  private testFailures: BuildDiagnostic[] = [];
  private runningTasks = new Map<string, DotnetTaskStarted>();
  private collapsed = false;

  /** Canales de salida. El de build siempre existe; los de proceso se crean al arrancar. */
  private readonly channels = new Map<string, Channel>([
    [BUILD_CHANNEL, { id: BUILD_CHANNEL, label: 'Compilación', kind: 'build', lines: [], taskId: null, url: null, status: 'idle', projectPath: null, projectKind: null, isDebug: false }],
    [TERMINAL_CHANNEL, { id: TERMINAL_CHANNEL, label: 'Terminal', kind: 'build', lines: [], taskId: null, url: null, status: 'idle', projectPath: null, projectKind: null, isDebug: false }],
  ]);

  /**
   * Metadatos del proyecto de cada canal, registrados **antes** de lanzar la tarea.
   *
   * La tarea sólo trae una etiqueta; el tipo de proyecto y su ruta los conoce quien orquesta el
   * arranque. Sin esto, la pestaña del canal podría decir el nombre pero no si eso es una Web API,
   * un Blazor o una consola, que es justo lo que se quiere distinguir de un vistazo.
   */
  private readonly serviceMeta = new Map<string, { projectPath: string; projectKind: ProjectKind }>();

  private activeChannel = BUILD_CHANNEL;

  /** Canal del proceso que gobierna el depurador, mientras haya sesión. */
  private debugChannel: string | null = null;

  /** Ruta de cada tarea a su canal. Se rellena al arrancar la tarea. */
  private readonly taskChannel = new Map<string, string>();

  /** Elemento del log visible, para poder añadir líneas sin repintar el panel entero. */
  private logElement: HTMLElement | null = null;

  /** Estado del visor de registro estructurado: nivel mínimo, texto y detalles desplegados. */
  private logLevel: LogLevel = 'trace';
  private logQuery = '';
  private readonly expandedLogs = new Set<number>();
  private logCache: LogEvent[] | null = null;
  private logTimer: number | undefined;
  private logChannelId: string | null = null;

  /** Historial de la terminal, navegable con las flechas. */
  private readonly history: string[] = [];
  private historyIndex = -1;
  private allowedCommands: string[] = [];

  /** Estado del autocompletado de la terminal. */
  private suggestions: Suggestion[] = [];
  private suggestionIndex = 0;
  private suggestMenuOpen = false;
  private terminalInput: HTMLInputElement | null = null;
  /** Ruta del prompt, para poder repintarla sin reconstruir la terminal. */
  private promptPath: HTMLElement | null = null;
  private terminalCwd: TerminalCwd | null = null;

  /**
   * Pestañas de terminal abiertas (Fase 21).
   *
   * La primera es la asistida y existe desde el arranque: es la que funciona siempre, incluso sin
   * `node-pty`, y dejar el panel vacío con un botón `+` como única pista sería un callejón sin
   * salida. Las de pseudoterminal se añaden desde el selector.
   */
  private readonly terminals: TerminalTab[] = [
    {
      id: 'term-0',
      profileId: 'lite',
      label: 'Terminal asistida',
      kind: 'lite',
      terminalId: null,
      host: null,
      term: null,
      fit: null,
      exited: false,
    },
  ];

  private activeTerminal = 'term-0';
  private terminalCounter = 0;
  /** Restaurando la disposición guardada: no se vuelve a anotar lo que se está reabriendo. */
  private restoring = false;
  private terminalProfiles: TerminalProfileInfo[] = [];
  private profileMenuOpen = false;

  /** Tipografía del emulador. La reenvía el shell con los ajustes; es la del editor. */
  private monospaceFont = 'Cascadia Code, Consolas, monospace';
  private monospaceSize = 13;

  constructor(private readonly host: PanelHost) {}

  // --- Estado -------------------------------------------------------------------------------

  currentTab(): PanelTab {
    return this.tab;
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  setTab(tab: PanelTab): void {
    this.tab = tab;
    this.collapsed = false;
    this.render();
  }

  show(tab: PanelTab): void {
    this.collapsed = false;
    byId('app').querySelector('.main')?.classList.remove('panel-collapsed');
    this.setTab(tab);
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    byId('app').querySelector('.main')?.classList.toggle('panel-collapsed', this.collapsed);
    this.render();
  }

  setAllowedCommands(commands: string[]): void {
    this.allowedCommands = commands;
  }

  /** Canal visible en la pestaña de salida. */
  showChannel(channelId: string): void {
    if (!this.channels.has(channelId)) return;
    this.activeChannel = channelId;
    this.show('output');
  }

  // --- Canales -------------------------------------------------------------------------------

  private channel(id: string): Channel {
    const found = this.channels.get(id);
    if (found) return found;

    const created: Channel = {
      id,
      label: id,
      kind: 'process',
      lines: [],
      taskId: null,
      url: null,
      status: 'idle',
      projectPath: null,
      projectKind: null,
      isDebug: false,
    };
    this.channels.set(id, created);
    return created;
  }

  /** Canales que la barra de la pestaña de salida debe ofrecer. */
  private visibleChannels(): Channel[] {
    return [...this.channels.values()].filter(
      (channel) => channel.id !== TERMINAL_CHANNEL && (channel.id === BUILD_CHANNEL || channel.lines.length > 0),
    );
  }

  /**
   * Declara de qué proyecto va a salir el canal de una etiqueta.
   *
   * Se llama justo antes de lanzar la tarea. La tarea sólo lleva una etiqueta legible; el tipo de
   * proyecto y su ruta —lo que hace falta para la insignia y para el botón de reinicio— los sabe
   * quien orquesta el arranque, no el proceso principal.
   */
  registerService(label: string, meta: { projectPath: string; projectKind: ProjectKind }): void {
    const channel = this.channel(`task:${label}`);
    channel.label = label;
    channel.kind = 'process';
    channel.projectPath = meta.projectPath;
    channel.projectKind = meta.projectKind;
    this.serviceMeta.set(label, meta);
  }

  /**
   * Abre el canal del proceso que va a depurarse.
   *
   * Se llama **antes** de arrancar la sesión, igual que `registerService` con una tarea: así la
   * pestaña ya sabe de qué proyecto habla desde la primera línea. El canal no tiene `taskId`
   * —no hay tarea que cancelar— y se marca `isDebug` para que su botón de parada sepa que lo que
   * hay que detener es la sesión de depuración.
   */
  startDebugChannel(label: string, command: string): void {
    const channel = this.channel(`task:${label}`);
    const meta = this.serviceMeta.get(label);

    channel.label = label;
    channel.kind = 'process';
    channel.taskId = null;
    channel.isDebug = true;
    channel.status = 'running';
    channel.url = null;
    channel.lines = [];
    if (meta) {
      channel.projectPath = meta.projectPath;
      channel.projectKind = meta.projectKind;
    }

    this.debugChannel = channel.id;
    this.activeChannel = channel.id;
    this.push(channel.id, `❯ ${command}`, 'command');
    this.host.servicesChanged();
    this.render();
  }

  /** Cierra el canal del depurador cuando la sesión termina. */
  finishDebugChannel(ok = true): void {
    if (this.debugChannel === null) return;

    const channel = this.channel(this.debugChannel);
    channel.status = ok ? 'ok' : 'failed';
    channel.isDebug = false;
    this.debugChannel = null;

    this.push(
      channel.id,
      ok ? '✓ Sesión de depuración terminada' : '✗ La sesión de depuración ha fallado',
      ok ? 'ok' : 'error',
    );
    this.host.servicesChanged();
    this.render();
  }

  /** Procesos con canal propio, para las pastillas de la barra superior. */
  services(): ServiceInfo[] {
    return [...this.channels.values()]
      .filter((channel) => channel.kind === 'process')
      .map((channel) => ({
        id: channel.id,
        label: channel.label,
        status: channel.status,
        url: channel.url,
        taskId: channel.taskId,
        projectPath: channel.projectPath,
        projectKind: channel.projectKind,
        isDebug: channel.isDebug,
      }));
  }

  /** Sólo los que están vivos: es lo que la barra superior enseña en verde. */
  runningServices(): ServiceInfo[] {
    return this.services().filter((service) => service.status === 'running');
  }

  /** Cierra los canales de procesos que ya han terminado. */
  clearFinishedChannels(): void {
    for (const channel of [...this.channels.values()]) {
      if (channel.kind === 'process' && channel.status !== 'running') this.channels.delete(channel.id);
    }
    if (!this.channels.has(this.activeChannel)) this.activeChannel = BUILD_CHANNEL;
    this.render();
  }

  // --- Salida --------------------------------------------------------------------------------

  clearOutput(): void {
    const channel = this.channels.get(this.tab === 'terminal' ? TERMINAL_CHANNEL : this.activeChannel);
    if (channel) channel.lines = [];
    this.render();
  }

  appendCommand(text: string): void {
    this.push(BUILD_CHANNEL, text, 'command');
  }

  /**
   * Salida de una tarea. `taskId` decide el canal: sin él —mensajes del propio IDE— va al canal
   * de compilación, que es el que se ve por defecto.
   */
  append(text: string, stream: 'stdout' | 'stderr', taskId?: string): void {
    this.appendTo((taskId ? this.taskChannel.get(taskId) : null) ?? BUILD_CHANNEL, text, stream);
  }

  /**
   * Salida del proceso que gobierna el depurador.
   *
   * Va a **su** canal, no al de compilación. Antes acababa ahí porque el depurador no lanza una
   * tarea y su salida llegaba sin `taskId`: el resultado era que el canal "Compilación" anunciaba
   * el puerto de la aplicación depurada —"Compilación :5013"— y el proyecto que estabas depurando
   * no aparecía como proceso por ninguna parte.
   */
  appendDebugOutput(text: string, stream: 'stdout' | 'stderr'): void {
    this.appendTo(this.debugChannel ?? BUILD_CHANNEL, text, stream);
  }

  private appendTo(channelId: string, text: string, stream: 'stdout' | 'stderr'): void {
    for (const line of text.split(/\r?\n/)) {
      if (line === '') continue;

      // Se conserva la **primera** URL anunciada: Kestrel escribe primero la del perfil (https) y
      // después la de respaldo (http), y quedarse con la última enseñaría un puerto que no es el
      // que abre `dotnet run`. Al rearrancar la tarea, el canal vuelve a empezar con url = null.
      const url = detectListeningUrl(line);
      if (url) {
        const channel = this.channel(channelId);
        if (channel.url === null) {
          channel.url = url;
          this.renderChannelBar();
          this.host.servicesChanged();
        }
      }

      this.push(channelId, line, stream === 'stderr' ? 'error' : this.classify(line));
    }
  }

  private classify(line: string): LineKind {
    if (/\b(error|Error)\b/.test(line)) return 'error';
    if (/(Build succeeded|Compilación correcta|Passed!|Correctas!)/.test(line)) return 'ok';
    return 'plain';
  }

  private push(channelId: string, text: string, kind: LineKind): void {
    const channel = this.channel(channelId);
    const line: Line = { text, kind };

    channel.lines.push(line);
    if (channel.lines.length > MAX_OUTPUT_LINES) {
      channel.lines.splice(0, channel.lines.length - MAX_OUTPUT_LINES);
      // Se ha recortado por arriba: el DOM ya no coincide con el buffer y hay que repintarlo.
      if (this.isVisibleChannel(channelId)) this.render();
      return;
    }

    // El visor de registro se repinta con freno: reparsea el buffer y no puede ir por línea.
    if (this.tab === 'logs' && channelId === this.activeChannel) this.scheduleLogRefresh();

    // Camino rápido: añadir sólo el nodo nuevo al log que ya está en pantalla.
    if (this.isVisibleChannel(channelId) && this.logElement) {
      this.logElement.appendChild(el('div', { className: LINE_CLASS[kind], text }));
      this.logElement.scrollTop = this.logElement.scrollHeight;
    }
  }

  private isVisibleChannel(channelId: string): boolean {
    if (this.collapsed) return false;
    if (this.tab === 'terminal') return channelId === TERMINAL_CHANNEL && this.logChannelId === TERMINAL_CHANNEL;
    if (this.tab === 'output') return channelId === this.activeChannel && this.logChannelId === channelId;
    return false;
  }

  // --- Tareas --------------------------------------------------------------------------------

  /** Marca una tarea como propia de la terminal, para que su salida vaya a ese canal. */
  attachTerminalTask(taskId: string): void {
    this.taskChannel.set(taskId, TERMINAL_CHANNEL);
  }

  /**
   * Directorio de trabajo de la terminal.
   *
   * Se guarda entero (ruta y forma corta) y no sólo la forma corta: el `title` del prompt enseña la
   * ruta completa al pasar el ratón, y una forma corta no se puede volver a expandir.
   */
  setTerminalCwd(cwd: TerminalCwd): void {
    this.terminalCwd = cwd;
    this.paintPrompt();
  }

  /** Escribe una línea en el canal de la terminal, sin que la haya producido ningún proceso. */
  appendTerminalLine(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.push(TERMINAL_CHANNEL, text, stream === 'stderr' ? 'error' : 'plain');
  }

  /**
   * Repinta sólo la ruta del prompt.
   *
   * En sitio, sin volver a construir la terminal: repintar la pestaña entera destruiría el `<input>`
   * enfocado a mitad de escritura, que es exactamente el fallo que costó caro en los paneles de
   * búsqueda (ADR-052). Aquí ni siquiera hace falta conservar el foco: no se toca el campo.
   */
  private paintPrompt(): void {
    if (!this.promptPath) return;
    this.promptPath.textContent = this.terminalCwd?.display ?? '';
    this.promptPath.title = this.terminalCwd?.path ?? '';
  }

  taskStarted(task: DotnetTaskStarted): void {
    this.runningTasks.set(task.taskId, task);

    // Una tarea etiquetada es un proyecto arrancado desde el selector de inicio: canal propio.
    if (task.label) {
      const channel = this.channel(`task:${task.label}`);
      const meta = this.serviceMeta.get(task.label);

      channel.label = task.label;
      channel.kind = 'process';
      channel.taskId = task.taskId;
      channel.isDebug = false;
      channel.status = 'running';
      channel.url = null;
      channel.lines = [];
      if (meta) {
        channel.projectPath = meta.projectPath;
        channel.projectKind = meta.projectKind;
      }
      this.taskChannel.set(task.taskId, channel.id);
      this.activeChannel = channel.id;
      this.push(channel.id, `❯ ${task.command}`, 'command');
    } else if (!this.taskChannel.has(task.taskId)) {
      this.taskChannel.set(task.taskId, BUILD_CHANNEL);
      this.appendCommand(`❯ ${task.command}`);
    } else {
      this.push(this.taskChannel.get(task.taskId) ?? BUILD_CHANNEL, `❯ ${task.command}`, 'command');
    }

    this.host.servicesChanged();
    this.render();
  }

  taskFinished(exit: DotnetTaskExit): void {
    this.runningTasks.delete(exit.taskId);

    const channelId = this.taskChannel.get(exit.taskId) ?? BUILD_CHANNEL;
    const channel = this.channel(channelId);
    if (channel.kind === 'process') channel.status = exit.code === 0 ? 'ok' : 'failed';

    // Los diagnósticos sólo tienen sentido si la tarea los produjo; una tarea de terminal no.
    if (exit.diagnostics.length > 0 || channelId === BUILD_CHANNEL) this.diagnostics = exit.diagnostics;

    const seconds = (exit.durationMs / 1000).toFixed(1);
    this.push(
      channelId,
      exit.code === 0 ? `✓ Terminado en ${seconds} s` : `✗ Terminado con código ${exit.code} en ${seconds} s`,
      exit.code === 0 ? 'ok' : 'error',
    );

    this.taskChannel.delete(exit.taskId);
    this.host.servicesChanged();
    this.render();
  }

  setDiagnostics(diagnostics: BuildDiagnostic[]): void {
    this.diagnostics = diagnostics;
    this.render();
  }

  /**
   * Avisos del linter de arquitectura.
   *
   * Van en una lista aparte de los del compilador a propósito: una compilación correcta borra sus
   * propios diagnósticos, y una violación de arquitectura **no desaparece porque el código
   * compile** — precisamente por eso hace falta el linter.
   */
  setArchitectureDiagnostics(diagnostics: BuildDiagnostic[]): void {
    this.architecture = diagnostics;
    this.render();
  }

  /** Fallos de la última ejecución de pruebas, con su mensaje y su traza. */
  setTestDiagnostics(diagnostics: BuildDiagnostic[]): void {
    this.testFailures = diagnostics;
    this.render();
  }

  /** Problemas del compilador, de la arquitectura y de las pruebas, en ese orden. */
  getDiagnostics(): BuildDiagnostic[] {
    return [...this.diagnostics, ...this.architecture, ...this.testFailures];
  }

  hasRunningTasks(): boolean {
    return this.runningTasks.size > 0;
  }

  runningTaskList(): DotnetTaskStarted[] {
    return [...this.runningTasks.values()];
  }

  // --- Render ---------------------------------------------------------------------------------

  /**
   * Repinta el panel.
   *
   * Va envuelto en `repaintPreservingFocus` (ADR-052) por un motivo muy concreto: `taskStarted` y
   * `taskFinished` llaman aquí, y con la terminal a la vista eso reconstruye el `<input>` en el que
   * se está escribiendo. Se notaba justo cuando más molesta — al lanzar un comando, que es cuando
   * uno se dispone a escribir el siguiente — y también con cualquier tarea de fondo que terminara
   * mientras se tecleaba.
   */
  render(): void {
    repaintPreservingFocus(byId('panel-content'), () => this.paint());
  }

  private paint(): void {
    this.renderTabs();

    const content = byId('panel-content');
    clear(content);
    this.logElement = null;
    this.logChannelId = null;

    if (this.collapsed) return;

    switch (this.tab) {
      case 'debug': {
        const host = el('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } });
        this.host.renderDebug(host);
        content.appendChild(host);
        return;
      }

      case 'http': {
        const host = el('div', { className: 'http-panel' });
        this.host.renderHttp(host);
        content.appendChild(host);
        return;
      }

      case 'terminal':
        content.appendChild(this.renderTerminal());
        return;

      case 'output':
        content.appendChild(this.renderOutput());
        return;

      case 'problems':
        content.appendChild(this.renderProblems());
        return;

      case 'logs':
        content.appendChild(this.renderLogs());
        return;

      case 'metrics': {
        const host = el('div', { className: 'metrics-panel' });
        this.host.renderMetrics(host);
        content.appendChild(host);
        return;
      }
    }
  }

  /**
   * Repinta sólo la cabecera de la salida: se llama al detectar una URL, sin tocar el log.
   *
   * Repintar el panel entero aquí sería un error caro: la URL aparece a mitad del arranque, justo
   * cuando el proceso está escupiendo líneas, y un repintado completo por cada una destruiría el
   * log que se está leyendo.
   */
  private renderChannelBar(): void {
    if (this.tab !== 'output') return;

    const bar = document.getElementById('channel-bar');
    if (bar) bar.replaceWith(this.buildChannelBar());

    const head = document.getElementById('service-head');
    if (head) {
      const fresh = this.buildServiceHead(this.channel(this.activeChannel));
      if (fresh) head.replaceWith(fresh);
    }
  }

  private buildChannelBar(): HTMLElement {
    const bar = el('div', { className: 'channel-bar', id: 'channel-bar' });
    const channels = this.visibleChannels();

    for (const channel of channels) {
      const chip = el(
        'button',
        {
          className: `channel-chip${channel.id === this.activeChannel ? ' active' : ''}`,
          title: channel.url ? `${channel.label} · ${channel.url}` : channel.label,
          on: {
            click: () => {
              this.activeChannel = channel.id;
              this.render();
            },
          },
        },
        channel.kind === 'process'
          ? el('span', {
              className: `channel-dot${channel.status === 'running' ? ' running' : channel.status === 'failed' ? ' failed' : ''}`,
            })
          : icon('hammer', { size: 12 }),
        el('span', { text: channel.label }),
      );

      if (channel.url) {
        const port = portOf(channel.url);
        chip.appendChild(
          el('span', {
            className: 'channel-url',
            text: port ? `:${port}` : 'abrir',
            title: `Abrir ${channel.url}`,
            on: {
              click: (event) => {
                event.stopPropagation();
                if (channel.url) this.host.openUrl(channel.url);
              },
            },
          }),
        );
      }

      bar.appendChild(chip);
    }

    return bar;
  }

  /**
   * Cabecera del canal de un proceso.
   *
   * Responde de un vistazo a las cuatro preguntas que uno se hace mirando una consola: qué es
   * esto (nombre + insignia de tipo), si está vivo, en qué URL escucha y cómo pararlo o
   * reiniciarlo **sin tocar los demás procesos del perfil**.
   */
  private buildServiceHead(channel: Channel): HTMLElement | null {
    if (channel.kind !== 'process') return null;

    const presentation = presentProject(channel.projectKind ?? 'console');
    const head = el('div', { className: 'service-head', id: 'service-head' });

    head.append(
      icon(presentation.icon, { size: 15, className: `tone-${presentation.tone}` }),
      el('span', { className: 'service-name', text: channel.label }),
      el('span', {
        className: 'service-badge',
        text: presentation.badge,
        title: presentation.description,
      }),
      el(
        'span',
        { className: `service-status ${channel.status}` },
        el('span', {
          className: `channel-dot${channel.status === 'running' ? ' running' : channel.status === 'failed' ? ' failed' : ''}`,
        }),
        // Un proceso depurado dice que lo está: es la única diferencia real entre los dos
        // procesos de un perfil, y hasta ahora había que deducirla.
        channel.isDebug && channel.status === 'running' ? icon('bug', { size: 12 }) : null,
        el('span', {
          text: channel.isDebug && channel.status === 'running' ? 'Depurando' : STATUS_LABEL[channel.status],
        }),
      ),
    );

    if (channel.url) {
      const url = channel.url;
      head.appendChild(
        el(
          'button',
          {
            className: 'service-link',
            title: `Abrir ${url} en el navegador`,
            on: { click: () => this.host.openUrl(url) },
          },
          icon('globe', { size: 13 }),
          el('span', { text: url }),
          icon('external-link', { size: 11 }),
        ),
      );
    }

    head.appendChild(el('span', { className: 'spacer', style: { flex: '1' } }));

    head.append(
      el(
        'button',
        {
          className: 'icon-btn small',
          title: channel.status === 'running' ? `Reiniciar ${channel.label}` : `Volver a arrancar ${channel.label}`,
          disabled: channel.projectPath === null,
          on: {
            click: () =>
              this.host.restartService({
                id: channel.id,
                label: channel.label,
                status: channel.status,
                url: channel.url,
                taskId: channel.taskId,
                projectPath: channel.projectPath,
                projectKind: channel.projectKind,
                isDebug: channel.isDebug,
              }),
          },
        },
        icon('refresh', { size: 13 }),
      ),
      el(
        'button',
        {
          className: 'icon-btn small',
          title: channel.isDebug ? `Detener la depuración de ${channel.label}` : `Detener sólo ${channel.label}`,
          // Un proceso depurado no tiene tarea que cancelar: se para la sesión del depurador.
          disabled: channel.status !== 'running' || (channel.taskId === null && !channel.isDebug),
          on: {
            click: () => {
              if (channel.isDebug) this.host.stopDebug();
              else if (channel.taskId) this.host.cancelTask(channel.taskId);
            },
          },
        },
        icon('stop', { size: 13 }),
      ),
    );

    return head;
  }

  private renderOutput(): HTMLElement {
    const container = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });

    if (this.visibleChannels().length > 1) container.appendChild(this.buildChannelBar());

    const channel = this.channel(this.activeChannel);

    const head = this.buildServiceHead(channel);
    if (head) container.appendChild(head);

    if (channel.lines.length === 0) {
      container.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          icon('panel-bottom', { size: 30, className: 'empty-state-icon' }),
          el('p', { text: 'Sin salida todavía' }),
          el('p', { className: 'empty-state-hint', text: 'Compila o ejecuta un proyecto para ver aquí su salida.' }),
        ),
      );
      return container;
    }

    const pre = el('pre', { className: 'output', style: { flex: '1', margin: '0', overflow: 'auto' } });
    for (const line of channel.lines) {
      pre.appendChild(el('div', { className: LINE_CLASS[line.kind], text: line.text }));
    }

    container.appendChild(pre);
    this.logElement = pre;
    this.logChannelId = channel.id;

    setTimeout(() => {
      pre.scrollTop = pre.scrollHeight;
    }, 0);

    return container;
  }

  private renderProblems(): HTMLElement {
    const problems = this.getDiagnostics();

    if (problems.length === 0) {
      return el(
        'div',
        { className: 'empty-state' },
        icon('check', { size: 30, className: 'empty-state-icon' }),
        el('p', { text: 'Ningún problema detectado' }),
        el('p', {
          className: 'empty-state-hint',
          text: 'Los errores y advertencias de la compilación aparecerán aquí.',
        }),
      );
    }

    const container = el('div');

    for (const diagnostic of problems) {
      const where = diagnostic.file
        ? `${diagnostic.file.split(/[\\/]/).pop()}:${diagnostic.line}:${diagnostic.column}`
        : 'solución';

      container.appendChild(
        el(
          'button',
          {
            className: 'problem',
            title: diagnostic.file ?? '',
            on: { click: () => this.host.openDiagnostic(diagnostic) },
          },
          icon(SEVERITY_ICON[diagnostic.severity], { size: 14, className: `sev ${diagnostic.severity}` }),
          el('span', {}, el('span', { className: 'code', text: `${diagnostic.code} ` }), diagnostic.message),
          el('span', { className: 'where', text: where }),
        ),
      );
    }

    return container;
  }

  // --- Registro estructurado ---------------------------------------------------------------------

  /**
   * Eventos del canal activo.
   *
   * Se **reparsea el buffer** en cada pintado en vez de mantener un estado incremental. Suena caro
   * y no lo es: el buffer está acotado a 5000 líneas y parsearlas cuesta pocos milisegundos, sólo
   * ocurre cuando la pestaña está a la vista, y a cambio no hay dos verdades que puedan divergir.
   * Un parser incremental se habría equivocado el día que una excepción llega partida en dos
   * trozos de `stdout`.
   */
  private logEvents(): LogEvent[] {
    const channel = this.channel(this.activeChannel);
    return parseLogEvents(channel.lines.map((line) => line.text).join('\n'));
  }

  /** Errores y críticos del canal activo: es la insignia de la pestaña. */
  private errorEventCount(): number {
    if (this.logCache === null) return 0;
    return this.logCache.filter((event) => event.level === 'error' || event.level === 'critical').length;
  }

  /**
   * Repintado del registro con freno.
   *
   * Una aplicación arrancando escupe cientos de líneas por segundo; repintar la lista entera por
   * cada una la dejaría inservible (y haría imposible pulsar en un marco de pila). Se agrupa en
   * ventanas de 400 ms, que es más rápido de lo que se lee.
   */
  private scheduleLogRefresh(): void {
    if (this.logTimer !== undefined) return;

    this.logTimer = window.setTimeout(() => {
      this.logTimer = undefined;
      if (this.tab === 'logs' && !this.collapsed) this.render();
    }, 400);
  }

  private renderLogs(): HTMLElement {
    const events = this.logEvents();
    this.logCache = events;

    const container = el('div', { className: 'log-panel' });
    container.appendChild(this.buildChannelBar());
    container.appendChild(this.buildLogToolbar(events));

    const visible = filterEvents(events, { minimum: this.logLevel, query: this.logQuery });

    if (visible.length === 0) {
      container.appendChild(
        el(
          'div',
          { className: 'empty-state' },
          icon('history', { size: 28, className: 'empty-state-icon' }),
          el('p', {
            text:
              events.length === 0
                ? 'Sin registro todavía: ejecuta la aplicación para ver aquí sus eventos.'
                : 'Ningún evento con este filtro.',
          }),
          el('p', {
            className: 'empty-state-hint',
            text: 'Se reconocen Serilog, NLog, el registro por consola de .NET y JSON compacto (CLEF).',
          }),
        ),
      );
      return container;
    }

    const list = el('div', { className: 'log-list' });
    for (const event of visible) list.appendChild(this.buildLogRow(event));
    container.appendChild(list);

    // La lista se lee de abajo arriba, como cualquier log: se baja del todo al pintar.
    setTimeout(() => {
      list.scrollTop = list.scrollHeight;
    }, 0);

    return container;
  }

  private buildLogToolbar(events: readonly LogEvent[]): HTMLElement {
    const counts = countByLevel(events);

    /** Un nivel mínimo. "Aviso" enseña avisos, errores y críticos: es como se filtra un log. */
    const level = (value: LogLevel, label: string, count: number): HTMLElement =>
      el(
        'button',
        {
          className: `chip log-chip ${value}${this.logLevel === value ? ' active' : ''}`,
          title: `${label} y por encima`,
          on: {
            click: () => {
              this.logLevel = value;
              this.render();
            },
          },
        },
        el('span', { text: label }),
        count > 0 ? el('span', { className: 'log-chip-count', text: String(count) }) : null,
      );

    const search = el('input', {
      className: 'input log-search',
      placeholder: 'Filtrar por texto…',
      value: this.logQuery,
      attrs: { 'aria-label': 'Filtrar el registro' },
      on: {
        input: (event) => {
          this.logQuery = (event.currentTarget as HTMLInputElement).value;
          this.renderLogListOnly();
        },
      },
    });

    return el(
      'div',
      { className: 'log-toolbar' },
      level('trace', 'Todo', events.length),
      level('information', 'Info', counts.information),
      level('warning', 'Aviso', counts.warning),
      level('error', 'Error', counts.error),
      level('critical', 'Crítico', counts.critical),
      search,
    );
  }

  /**
   * Repinta sólo la lista, conservando el foco del buscador.
   *
   * Repintar el panel entero mientras se escribe en el filtro destruiría el `input` y con él el
   * cursor: es exactamente el fallo que ya costó caro en la terminal.
   */
  private renderLogListOnly(): void {
    const list = document.querySelector('.log-list');
    if (!list) {
      this.render();
      return;
    }

    const visible = filterEvents(this.logCache ?? [], { minimum: this.logLevel, query: this.logQuery });
    clear(list);
    for (const event of visible) list.appendChild(this.buildLogRow(event));
  }

  private buildLogRow(event: LogEvent): HTMLElement {
    const frame = firstNavigableFrame(event);
    const expanded = this.expandedLogs.has(event.index);
    const hasDetail = event.exception.length > 0 || event.frames.length > 0;

    const head = el(
      'button',
      {
        className: `log-row ${event.level}`,
        title: event.category ?? '',
        on: {
          click: () => {
            if (!hasDetail) return;
            if (expanded) this.expandedLogs.delete(event.index);
            else this.expandedLogs.add(event.index);
            this.renderLogListOnly();
          },
        },
      },
      el('span', { className: `log-level ${event.level}`, text: LEVEL_LABEL[event.level].slice(0, 4).toUpperCase() }),
      event.timestamp === null ? null : el('span', { className: 'log-time', text: event.timestamp }),
      event.category === null ? null : el('span', { className: 'log-category', text: shortCategory(event.category) }),
      el('span', { className: 'log-message', text: event.message }),
      hasDetail ? icon(expanded ? 'chevron-down' : 'chevron-right', { size: 13 }) : null,
    );

    if (!expanded) return head;

    const detail = el('div', { className: 'log-detail' });

    for (const line of event.exception) detail.appendChild(el('div', { className: 'log-exception', text: line }));

    for (const stackFrame of event.frames) {
      const navigable = stackFrame.file !== null && stackFrame.line > 0;

      detail.appendChild(
        el(
          navigable ? 'button' : 'div',
          {
            className: `log-frame${navigable ? ' navigable' : ''}`,
            title: navigable ? `${stackFrame.file}:${stackFrame.line}` : '',
            ...(navigable
              ? { on: { click: () => this.host.openLogLocation(stackFrame.file!, stackFrame.line) } }
              : {}),
          },
          el('span', { className: 'log-frame-method', text: stackFrame.method }),
          navigable
            ? el('span', {
                className: 'log-frame-file',
                text: `${stackFrame.file!.split(/[\\/]/).pop()}:${stackFrame.line}`,
              })
            : null,
        ),
      );
    }

    // Marco navegable: se ofrece el salto directo sin tener que buscarlo en la lista.
    if (frame !== null) {
      detail.appendChild(
        el(
          'button',
          {
            className: 'link-btn log-jump',
            on: { click: () => this.host.openLogLocation(frame.file!, frame.line) },
          },
          icon('external-link', { size: 13 }),
          el('span', { text: `Abrir ${frame.file!.split(/[\\/]/).pop()}:${frame.line}` }),
        ),
      );
    }

    return el('div', { className: 'log-entry' }, head, detail);
  }

  // --- Terminal asistida -------------------------------------------------------------------------

  /**
   * Terminal integrada con autocompletado.
   *
   * Sin pseudoterminal: se ejecutan comandos concretos y se muestra su salida. A cambio, se
   * conoce la línea entera mientras se escribe, que es justo lo que hace posible sugerir
   * subcomandos y ramas sin ambigüedad.
   *
   * Desde la Fase 21 convive con las pestañas de pseudoterminal y ya no es la única: es una más
   * del selector del botón `+`, y sigue siendo la única que sugiere.
   */
  private renderLiteTerminal(): HTMLElement {
    const container = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } });
    const channel = this.channel(TERMINAL_CHANNEL);

    const log = el('pre', { className: 'output', style: { flex: '1', margin: '0', overflow: 'auto' } });

    if (channel.lines.length === 0) {
      log.append(
        el('div', { text: `Programas disponibles: ${this.allowedCommands.join(', ') || 'dotnet, git, npm'}` }),
        el('div', { text: 'Escribe "git " o "dotnet " y pulsa Tab o → para completar la sugerencia.' }),
        el('div', { text: 'Navega con "cd", vuelve a la solución con "cd" a secas y mira dónde estás con "pwd".' }),
        el('div', {
          text: 'Sin pseudoterminal: los programas interactivos (REPL, editores de consola) no funcionarán.',
        }),
      );
    } else {
      for (const line of channel.lines) {
        log.appendChild(el('div', { className: LINE_CLASS[line.kind], text: line.text }));
      }
    }

    this.logElement = log;
    this.logChannelId = TERMINAL_CHANNEL;

    const input = el('input', {
      className: 'input',
      placeholder: 'cd src   ·   dotnet build   ·   git status   ·   ↑↓ historial   ·   Tab completa',
      attrs: {
        'aria-label': 'Comando',
        autocomplete: 'off',
        spellcheck: 'false',
        // Sobrevive a los repintados del panel: ver la nota de `render()`.
        [FOCUS_KEY_ATTRIBUTE]: 'terminal-input',
      },
    }) as HTMLInputElement;

    this.terminalInput = input;

    const wrap = el('div', { className: 'terminal-input-wrap' });
    const ghost = el('div', { className: 'terminal-ghost' });
    wrap.append(ghost, input);

    const suggestMenu = el('div', { className: 'suggest-menu', hidden: true });
    wrap.appendChild(suggestMenu);

    const refreshSuggestions = (): void => {
      const line = input.value;
      this.suggestions = line.trim() === '' && line === '' ? [] : suggest(line, this.host.suggestContext());
      this.suggestionIndex = 0;
      this.paintGhost(ghost, input.value);
      this.paintSuggestMenu(suggestMenu, input);
    };

    const accept = (): boolean => {
      const suggestion = this.suggestions[this.suggestionIndex];
      if (!suggestion) return false;

      const applied = applySuggestion(input.value, suggestion);
      input.value = applied;
      const caret = caretAfterApply(applied);
      input.setSelectionRange(caret, caret);

      this.suggestMenuOpen = false;
      refreshSuggestions();
      return true;
    };

    input.addEventListener('input', () => {
      this.suggestMenuOpen = true;
      refreshSuggestions();
    });

    input.addEventListener('keydown', (event) => {
      // Tab y flecha derecha (con el cursor al final) aceptan la sugerencia.
      if (event.key === 'Tab') {
        if (accept()) event.preventDefault();
        return;
      }

      if (event.key === 'ArrowRight') {
        const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        if (atEnd && this.suggestions.length > 0 && ghostText(input.value, this.suggestions)) {
          if (accept()) event.preventDefault();
        }
        return;
      }

      if (event.key === 'Escape') {
        if (this.suggestMenuOpen) {
          event.preventDefault();
          this.suggestMenuOpen = false;
          this.paintSuggestMenu(suggestMenu, input);
        }
        return;
      }

      if (event.key === 'Enter') {
        const line = input.value.trim();
        if (line === '') return;

        this.history.push(line);
        this.historyIndex = this.history.length;
        input.value = '';
        this.suggestMenuOpen = false;
        refreshSuggestions();
        this.host.runCommand(line);
        return;
      }

      // Con el menú abierto, las flechas navegan las sugerencias; con él cerrado, el historial.
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();

        if (this.suggestMenuOpen && this.suggestions.length > 0) {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const total = Math.min(this.suggestions.length, MAX_SUGGESTIONS);
          this.suggestionIndex = (this.suggestionIndex + delta + total) % total;
          this.paintGhost(ghost, input.value);
          this.paintSuggestMenu(suggestMenu, input);
          return;
        }

        if (event.key === 'ArrowUp') {
          if (this.historyIndex > 0) {
            this.historyIndex--;
            input.value = this.history[this.historyIndex] ?? '';
          }
        } else if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          input.value = this.history[this.historyIndex] ?? '';
        } else {
          this.historyIndex = this.history.length;
          input.value = '';
        }

        refreshSuggestions();
      }
    });

    // El prompt lleva la ruta delante, como cualquier terminal del sistema: sin ella no hay forma
    // de saber dónde acaba de dejarte un `cd`, y navegar a ciegas no es navegar.
    const promptPath = el('span', {
      className: 'terminal-cwd',
      text: this.terminalCwd?.display ?? '',
      title: this.terminalCwd?.path ?? '',
    });
    this.promptPath = promptPath;

    container.append(
      log,
      el(
        'div',
        { className: 'terminal-prompt' },
        promptPath,
        el('span', { className: 'caret', text: '❯' }),
        wrap,
      ),
    );

    setTimeout(() => {
      input.focus();
      log.scrollTop = log.scrollHeight;
    }, 0);

    return container;
  }

  /** Pinta el texto fantasma alineado con lo ya escrito. */
  private paintGhost(ghost: HTMLElement, line: string): void {
    clear(ghost);

    const remainder = ghostText(line, this.suggestions.slice(this.suggestionIndex));
    if (!remainder) return;

    ghost.append(
      el('span', { className: 'typed', text: line }),
      el('span', { className: 'hint', text: remainder }),
      el('span', { className: 'kbd', text: 'Tab' }),
    );
  }

  private paintSuggestMenu(menu: HTMLElement, input: HTMLInputElement): void {
    clear(menu);

    const visible = this.suggestions.slice(0, MAX_SUGGESTIONS);
    // El menú sólo aparece cuando aporta algo: con una única sugerencia basta el fantasma.
    menu.hidden = !this.suggestMenuOpen || visible.length < 2;
    if (menu.hidden) return;

    // El panel puede estar bajo de altura: el menú se acota al hueco real que hay por encima del
    // prompt. Sin esto, las primeras sugerencias quedan cortadas por el borde del panel y el
    // usuario no ve justamente la que va a aceptar con Tab.
    const panelTop = byId('panel').getBoundingClientRect().top;
    const promptTop = input.getBoundingClientRect().top;
    menu.style.maxHeight = `${Math.max(96, promptTop - panelTop - 16)}px`;

    visible.forEach((suggestion, index) => {
      menu.appendChild(
        el(
          'button',
          {
            className: `suggest-item${index === this.suggestionIndex ? ' active' : ''}`,
            on: {
              // `mousedown` en vez de `click`: el click quitaría el foco del input antes de aplicar.
              mousedown: (event) => {
                event.preventDefault();
                const applied = applySuggestion(input.value, suggestion);
                input.value = applied;
                const caret = caretAfterApply(applied);
                input.setSelectionRange(caret, caret);
                this.suggestMenuOpen = false;
                menu.hidden = true;
                input.focus();
              },
            },
          },
          el('span', { className: 'suggest-value', text: suggestion.label }),
          el('span', { className: 'suggest-detail', text: suggestion.detail }),
          el('span', { className: 'suggest-kind', text: KIND_LABEL[suggestion.kind] ?? '' }),
        ),
      );
    });
  }

  // --- Pestañas de terminal (Fase 21) --------------------------------------------------------

  /**
   * Cabecera de la terminal: una pestaña por sesión y el botón de abrir otra.
   *
   * Va arriba y no abajo porque compite visualmente con el prompt, que ya vive en la parte
   * inferior; y las pestañas llevan el nombre del perfil, no "Terminal 1", porque con un
   * PowerShell y una asistida abiertos lo que hay que distinguir es **qué** son.
   */
  private renderTerminalStrip(): HTMLElement {
    const strip = el('div', { className: 'terminal-strip' });

    for (const terminal of this.terminals) {
      const isActive = terminal.id === this.activeTerminal;

      strip.appendChild(
        el(
          'div',
          {
            className: `terminal-chip${isActive ? ' active' : ''}${terminal.exited ? ' exited' : ''}`,
            title: terminal.exited ? `${terminal.label} — el intérprete ha terminado` : terminal.label,
            on: { click: () => this.showTerminal(terminal.id) },
          },
          icon(terminal.kind === 'lite' ? 'zap' : 'terminal', { size: 13 }),
          el('span', { className: 'terminal-chip-label', text: terminal.label }),
          // La asistida no se puede cerrar cuando es la única: dejar el panel sin ninguna terminal
          // y con un botón `+` como única pista sería un callejón sin salida.
          this.terminals.length > 1
            ? el(
                'button',
                {
                  className: 'terminal-chip-close',
                  title: 'Cerrar esta terminal',
                  attrs: { 'aria-label': `Cerrar ${terminal.label}` },
                  on: {
                    click: (event) => {
                      event.stopPropagation();
                      void this.closeTerminal(terminal.id);
                    },
                  },
                },
                icon('x', { size: 11 }),
              )
            : null,
        ),
      );
    }

    strip.append(
      el('span', { className: 'spacer' }),
      el(
        'button',
        {
          className: 'terminal-new',
          title: 'Abrir otra terminal (elige el intérprete)',
          attrs: { 'aria-label': 'Abrir otra terminal' },
          on: {
            click: () => {
              this.profileMenuOpen = !this.profileMenuOpen;
              if (this.profileMenuOpen) void this.loadTerminalProfiles();
              else this.render();
            },
          },
        },
        icon('plus', { size: 13 }),
        icon('chevron-down', { size: 11 }),
      ),
    );

    if (this.profileMenuOpen) strip.appendChild(this.renderProfileMenu());

    return strip;
  }

  /**
   * Menú del botón `+`.
   *
   * Los perfiles no disponibles se enseñan **atenuados y con el motivo**, no escondidos: la misma
   * regla que las acciones de Docker con el motor parado (ADR-033). Un menú que oculta lo que no
   * puede hacer deja al usuario sin saber que existía.
   */
  private renderProfileMenu(): HTMLElement {
    const menu = el('div', { className: 'terminal-profile-menu' });

    if (this.terminalProfiles.length === 0) {
      menu.appendChild(el('div', { className: 'empty-hint', text: 'Cargando intérpretes…' }));
      return menu;
    }

    for (const profile of this.terminalProfiles) {
      menu.appendChild(
        el(
          'button',
          {
            className: `terminal-profile${profile.available ? '' : ' unavailable'}`,
            disabled: !profile.available,
            title: profile.available ? profile.hint : (profile.reason ?? 'no disponible'),
            on: {
              click: () => {
                this.profileMenuOpen = false;
                void this.openTerminal(profile.id);
              },
            },
          },
          icon(profile.kind === 'lite' ? 'zap' : 'terminal', { size: 14 }),
          el(
            'span',
            { className: 'terminal-profile-text' },
            el('span', { className: 'terminal-profile-label', text: profile.label }),
            el('span', { className: 'terminal-profile-hint', text: profile.available ? profile.hint : (profile.reason ?? '') }),
          ),
        ),
      );
    }

    return menu;
  }

  /** Pide los perfiles al proceso principal y repinta. */
  private async loadTerminalProfiles(): Promise<void> {
    try {
      this.terminalProfiles = await window.dotforge.terminal.profiles();
    } catch {
      this.terminalProfiles = [];
    }
    this.render();
  }

  /**
   * Abre una pestaña nueva.
   *
   * La asistida no llama a nadie: es local y no tiene sesión detrás. Una de pseudoterminal pide la
   * sesión al proceso principal **antes** de crear la pestaña, para que un `pwsh.exe` que no está
   * instalado no deje una pestaña muerta con un mensaje dentro.
   */
  async openTerminal(profileId: string): Promise<void> {
    const profile = findProfile(profileId);
    if (!profile) return;

    const sameProfile = this.terminals.filter((terminal) => terminal.profileId === profileId).length;
    const label = terminalTabName(profile, sameProfile);
    const id = `term-${++this.terminalCounter}`;

    if (profile.kind === 'lite') {
      this.terminals.push({ id, profileId, label, kind: 'lite', terminalId: null, host: null, term: null, fit: null, exited: false });
      this.showTerminal(id);
      this.saveTerminalLayout();
      return;
    }

    const created = createTerminal(this.terminalFont());
    if (!created) {
      this.host.notify('No se ha cargado el emulador de terminal (xterm).', 'error');
      return;
    }

    let session;
    try {
      const proposed = created.fit?.proposeDimensions();
      session = await window.dotforge.terminal.create(
        profileId,
        proposed ? { columns: proposed.cols, rows: proposed.rows } : undefined,
      );
    } catch (error) {
      created.term.dispose();
      this.host.notify(error instanceof Error ? error.message : String(error), 'error');
      return;
    }

    // El contenedor sobrevive a los repintados del panel y se vuelve a insertar tal cual: volver a
    // abrir el emulador sobre un nodo nuevo perdería el histórico entero de la sesión.
    const host = el('div', { className: 'terminal-xterm' });

    const terminal: TerminalTab = {
      id,
      profileId,
      label,
      kind: 'pty',
      terminalId: session.terminalId,
      host,
      term: created.term,
      fit: created.fit,
      exited: false,
    };

    created.term.onData((data) => void window.dotforge.terminal.write(session.terminalId, data));
    created.term.onResize(({ cols, rows }) => void window.dotforge.terminal.resize(session.terminalId, cols, rows));

    this.terminals.push(terminal);
    this.showTerminal(id);
    this.saveTerminalLayout();
  }

  /**
   * Vuelve a abrir las pestañas que tenía esta solución.
   *
   * Se llama al abrir una solución. Lo que llega ya viene filtrado por el proceso principal: si el
   * ajuste está apagado, si no hay nada guardado o si lo guardado era ya lo que hay por defecto, la
   * lista viene vacía y aquí no pasa nada.
   *
   * Restaurar es reabrir un intérprete **vacío** en el mismo directorio: no vuelve el histórico ni
   * lo que estuviera corriendo.
   *
   * La pestaña asistida con la que arranca el panel se **retira antes** de reabrir nada, no
   * después. Dejarla puesta y quitarla al final sólo si la disposición no la incluía sale mal en el
   * caso más normal de todos: una disposición que sí incluye una asistida acaba con dos, la del
   * arranque y la reabierta. Y como la disposición se vuelve a anotar al terminar, esa de más queda
   * guardada y crece una por cada vez que se abre la solución. Si no entra ninguna —sin `node-pty`
   * no se abre una pestaña de intérprete—, se devuelve: un panel de terminal sin ninguna pestaña no
   * es un estado que el IDE sepa enseñar.
   */
  async restoreTerminals(): Promise<void> {
    // Sólo sobre un panel intacto. Cambiar de solución con terminales ya abiertas no las cierra:
    // dentro de una puede haber un `dotnet watch` corriendo, y llevárselo por delante para reabrir
    // una pestaña vacía es un intercambio malísimo. Las que se abran a partir de ahí se anotan ya
    // en la solución nueva, que es lo que hace falta para la próxima vez.
    //
    // `restoring` cierra además la puerta a entrar dos veces a la vez: abrir una solución llega por
    // dos caminos (la llamada directa y el evento del proceso principal) y las dos pasarían este
    // guardia mientras la primera está esperando a su primera pestaña.
    if (this.restoring) return;
    if (this.terminals.length > 1 || this.terminals[0]?.kind !== 'lite') return;

    this.restoring = true;

    let plan;
    try {
      plan = await window.dotforge.terminal.restoreLayout();
    } catch {
      this.restoring = false;
      return;
    }

    if (plan.tabs.length === 0) {
      this.restoring = false;
      return;
    }

    const bootstrap = this.terminals.splice(0, 1);

    try {
      for (const profileId of plan.tabs) await this.openTerminal(profileId);
    } finally {
      // Si no ha entrado ninguna, la del arranque vuelve a su sitio.
      if (this.terminals.length === 0) this.terminals.push(...bootstrap);
      this.restoring = false;
    }

    const active = this.terminals[Math.min(plan.activeIndex, this.terminals.length - 1)];
    if (active) this.activeTerminal = active.id;

    if (plan.skipped > 0) {
      this.host.notify(
        `${plan.skipped} ${plan.skipped === 1 ? 'terminal guardada' : 'terminales guardadas'} no se ${plan.skipped === 1 ? 'ha' : 'han'} podido reabrir: no hay pseudoterminales disponibles.`,
        'warn',
      );
    }

    this.saveTerminalLayout();
    this.render();
  }

  /**
   * Anota qué pestañas hay abiertas.
   *
   * En cada cambio, no al cerrar: abrir otra solución cambia la clave con la que se guarda, y
   * capturar el estado justo antes de ese cambio es una carrera. Guardando en el momento, la
   * anotación siempre está al día. No se espera al resultado: es estado de comodidad, y un fallo
   * al escribirlo no puede interrumpir lo que el usuario estaba haciendo.
   */
  private saveTerminalLayout(): void {
    if (this.restoring) return;

    void window.dotforge.terminal
      .saveLayout({
        tabs: this.terminals.map((terminal) => terminal.profileId),
        activeIndex: Math.max(
          0,
          this.terminals.findIndex((terminal) => terminal.id === this.activeTerminal),
        ),
      })
      .catch(() => undefined);
  }

  /** Activa una pestaña de terminal. */
  showTerminal(id: string): void {
    if (!this.terminals.some((terminal) => terminal.id === id)) return;

    this.activeTerminal = id;
    this.profileMenuOpen = false;
    this.saveTerminalLayout();
    this.render();
    this.focusTerminal();
  }

  /**
   * Cierra una pestaña y, con ella, el árbol de procesos de su intérprete.
   *
   * Cerrar la pestaña **es** cerrar la sesión: una terminal invisible que sigue viva con un
   * `dotnet watch` dentro ocupando un puerto es exactamente lo que nadie espera.
   */
  async closeTerminal(id: string): Promise<void> {
    const index = this.terminals.findIndex((terminal) => terminal.id === id);
    if (index === -1 || this.terminals.length === 1) return;

    const [terminal] = this.terminals.splice(index, 1);
    if (!terminal) return;

    if (terminal.terminalId) await window.dotforge.terminal.dispose(terminal.terminalId).catch(() => undefined);
    terminal.term?.dispose();

    if (this.activeTerminal === id) {
      this.activeTerminal = this.terminals[Math.min(index, this.terminals.length - 1)]?.id ?? '';
    }

    this.saveTerminalLayout();
    this.render();
  }

  /** Trozo de salida de una sesión. Llega por evento porque un intérprete habla cuando quiere. */
  writeTerminal(terminalId: string, data: string): void {
    this.terminals.find((terminal) => terminal.terminalId === terminalId)?.term?.write(data);
  }

  /**
   * El intérprete ha terminado.
   *
   * La pestaña **no se cierra sola**: si `exit` fue un error, lo último que escribió es lo único
   * que explica por qué, y cerrarla se lo lleva por delante. Se marca como terminada y se deja.
   */
  noteTerminalExit(terminalId: string, exitCode: number): void {
    const terminal = this.terminals.find((entry) => entry.terminalId === terminalId);
    if (!terminal) return;

    terminal.exited = true;
    terminal.terminalId = null;
    terminal.term?.writeln(`\r\n\u001b[90m[el intérprete ha terminado con código ${exitCode}]\u001b[0m`);

    if (this.tab === 'terminal') this.render();
  }

  /** Cierra todas las sesiones. La llama el shell al descargarse la ventana. */
  disposeTerminals(): void {
    for (const terminal of this.terminals) {
      if (terminal.terminalId) void window.dotforge.terminal.dispose(terminal.terminalId).catch(() => undefined);
    }
  }

  /** Tipografía del emulador: la del editor, para que el código pegado se lea igual. */
  private terminalFont(): { fontFamily: string; fontSize: number } {
    return { fontFamily: this.monospaceFont, fontSize: this.monospaceSize };
  }

  /** El shell reenvía los ajustes: la terminal usa la misma tipografía que el editor. */
  applyTerminalSettings(fontFamily: string, fontSize: number): void {
    this.monospaceFont = fontFamily;
    this.monospaceSize = fontSize;

    for (const terminal of this.terminals) {
      if (terminal.term) applyTheme(terminal.term, this.terminalFont());
    }
  }

  private activeTerminalTab(): TerminalTab | null {
    return this.terminals.find((terminal) => terminal.id === this.activeTerminal) ?? this.terminals[0] ?? null;
  }

  /**
   * Cuerpo de la pestaña de terminal: la cabecera y, debajo, la sesión activa.
   *
   * Las de pseudoterminal reinsertan su contenedor **ya existente**; volver a abrir el emulador
   * sobre un nodo nuevo en cada repintado perdería el histórico y el estado del intérprete.
   */
  private renderTerminal(): HTMLElement {
    const container = el('div', { className: 'terminal-panel' });
    container.appendChild(this.renderTerminalStrip());

    const active = this.activeTerminalTab();

    if (!active) {
      container.appendChild(el('div', { className: 'empty-hint', text: 'No hay ninguna terminal abierta.' }));
      return container;
    }

    if (active.kind === 'lite') {
      container.appendChild(this.renderLiteTerminal());
      return container;
    }

    const body = el('div', { className: 'terminal-body' });
    if (active.host) body.appendChild(active.host);
    container.appendChild(body);

    // `open()` sólo la primera vez que el contenedor está dentro del documento: xterm mide el
    // hueco al abrirse, y hacerlo sobre un nodo desconectado da un tamaño de cero.
    setTimeout(() => {
      if (!active.host || !active.term) return;

      if (!active.opened) {
        active.term.open(active.host);
        active.opened = true;
      }

      try {
        active.fit?.fit();
      } catch {
        // El panel puede estar plegado y medir 0 px: no hay nada que ajustar todavía.
      }

      // El foco sólo se toma si no lo tenía nadie fuera del panel. El panel se repinta entero cada
      // vez que una tarea arranca o termina, y una compilación de fondo no puede llevarse el cursor
      // del editor a la terminal a mitad de una línea.
      const focused = document.activeElement;
      const outside = focused instanceof HTMLElement && !byId('panel').contains(focused);
      if (!outside) active.term.focus();
    }, 0);

    return container;
  }

  /** La terminal recibe el foco cuando se abre desde la paleta o el menú. */
  focusTerminal(): void {
    const active = this.activeTerminalTab();
    if (active?.kind === 'pty') {
      active.term?.focus();
      return;
    }

    this.terminalInput?.focus();
  }

  /**
   * Reajusta el tamaño de la sesión visible.
   *
   * Lo llama el redimensionado del panel: sin esto el intérprete sigue creyendo que la ventana
   * mide lo que medía y parte las líneas donde no toca, que es el defecto que delata a una
   * terminal que no reenvía su tamaño.
   */
  fitTerminal(): void {
    const active = this.activeTerminalTab();
    if (active?.kind !== 'pty') return;

    try {
      active.fit?.fit();
    } catch {
      // Hueco de cero: el panel está plegado.
    }
  }

  /** Texto actual de la terminal. Sólo lo usan las pruebas de humo de la interfaz. */
  terminalValue(): string {
    return this.terminalInput?.value ?? '';
  }

  private renderTabs(): void {
    const tabs = byId('panel-tabs');
    clear(tabs);

    const problems = this.getDiagnostics();
    const errors = problems.filter((diagnostic) => diagnostic.severity === 'error').length;
    const warnings = problems.filter((diagnostic) => diagnostic.severity === 'warning').length;

    const makeTab = (id: PanelTab, iconName: IconName, label: string, badge?: HTMLElement | null): HTMLElement =>
      el(
        'button',
        {
          className: `panel-tab${this.tab === id && !this.collapsed ? ' active' : ''}`,
          role: 'tab',
          on: { click: () => this.show(id) },
        },
        icon(iconName, { size: 14 }),
        label,
        badge ?? null,
      );

    const running = [...this.channels.values()].filter((channel) => channel.status === 'running').length;

    tabs.append(
      makeTab(
        'output',
        'list',
        'Salida',
        running > 0 ? el('span', { className: 'count', text: String(running) }) : null,
      ),
      makeTab('terminal', 'terminal', 'Terminal'),
      makeTab(
        'problems',
        'alert-circle',
        'Problemas',
        errors + warnings > 0
          ? el('span', {
              className: `count ${errors > 0 ? 'danger' : 'warning'}`,
              text: String(errors + warnings),
            })
          : null,
      ),
      makeTab('debug', 'bug', 'Depuración'),
      makeTab(
        'logs',
        'history',
        'Registro',
        this.errorEventCount() > 0
          ? el('span', { className: 'count danger', text: String(this.errorEventCount()) })
          : null,
      ),
      makeTab('http', 'send', 'HTTP'),
      makeTab('metrics', 'gauge', 'Métricas'),
      el('span', { className: 'spacer', style: { flex: '1' } }),
    );

    /**
     * Botones de parada de lo que está vivo.
     *
     * El indicador **no** es un spinner cuando el proceso es de larga duración. Un spinner dice
     * "espera, estoy trabajando en algo que va a terminar", y una Web API arrancada no va a
     * terminar: girar para siempre junto a "Detener WebApi" hacía pensar que seguía arrancando.
     * Un punto verde dice lo correcto —"esto está en marcha"— y deja el spinner para las tareas
     * que sí acaban: compilar, restaurar, probar.
     */
    for (const task of this.runningTasks.values()) {
      const longRunning = task.kind === 'run' || task.kind === 'watch';

      tabs.appendChild(
        el(
          'button',
          {
            className: 'btn ghost small',
            title: `${task.command}\n${longRunning ? 'En ejecución' : 'Trabajando'} — clic para detener`,
            on: { click: () => this.host.cancelTask(task.taskId) },
          },
          longRunning ? el('span', { className: 'channel-dot running' }) : el('span', { className: 'spinner' }),
          task.label ? `Detener ${task.label}` : 'Detener',
        ),
      );
    }

    // La sesión de depuración no es una tarea, pero también hay que poder pararla desde aquí.
    if (this.debugChannel !== null) {
      const channel = this.channel(this.debugChannel);

      tabs.appendChild(
        el(
          'button',
          {
            className: 'btn ghost small',
            title: `Depurando ${channel.label} — clic para detener la sesión`,
            on: { click: () => this.host.stopDebug() },
          },
          el('span', { className: 'channel-dot running' }),
          `Detener ${channel.label}`,
        ),
      );
    }

    tabs.append(
      el(
        'button',
        { className: 'icon-btn', title: 'Limpiar la salida visible', on: { click: () => this.clearOutput() } },
        icon('trash', { size: 14 }),
      ),
      el(
        'button',
        {
          className: 'icon-btn',
          title: this.collapsed ? 'Mostrar el panel' : 'Ocultar el panel',
          on: { click: () => this.toggleCollapsed() },
        },
        icon(this.collapsed ? 'chevron-up' : 'chevron-down', { size: 14 }),
      ),
    );
  }
}

/** `Microsoft.Hosting.Lifetime` -> `Lifetime`: la fila no tiene sitio para el espacio entero. */
function shortCategory(category: string): string {
  return category.split('.').pop() ?? category;
}

const KIND_LABEL: Record<Suggestion['kind'], string> = {
  program: 'programa',
  subcommand: 'comando',
  flag: 'opción',
  branch: 'rama',
  package: 'paquete',
  project: 'proyecto',
  container: 'contenedor',
  image: 'imagen',
  script: 'script',
};

/** Reexportado para que las pruebas de la interfaz puedan comprobar el troceo sin DOM. */
export { splitLine };
