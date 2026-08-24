/**
 * Túneles públicos hacia el puerto local: modelo puro.
 *
 * Un webhook de Stripe, de GitHub o de un bot de Teams no puede llamar a `https://localhost:7001`.
 * La solución de siempre es publicar el puerto con un túnel; el trabajo del IDE es que eso sea un
 * botón y una URL clicable en vez de una segunda terminal y un copiar y pegar.
 *
 * Se admiten las dos herramientas que usa la gente en un flujo .NET:
 *  - **`devtunnel`**, la de Microsoft, integrada en Visual Studio y con cuenta de Microsoft;
 *  - **`ngrok`**, la clásica, con cuenta propia.
 *
 * Ninguna se descarga ni se vendorea: si no está en el PATH, el panel lo dice y da la orden de
 * instalación. Es la misma regla que con `dotnet-ef` y con Docker — una herramienta que falta es
 * un estado normal que se explica, no un error del IDE.
 *
 * Este archivo no ejecuta nada: construye los argumentos y reconoce la URL en la salida. Lo
 * segundo es lo delicado, porque la URL llega **una sola vez**, a mitad de un chorro de líneas, y
 * un trozo de stream puede partirla por la mitad.
 */

export type TunnelTool = 'devtunnel' | 'ngrok';

export interface TunnelToolInfo {
  id: TunnelTool;
  label: string;
  /** Programa que se lanza. Tiene que estar en la lista blanca de la terminal. */
  command: string;
  /** Cómo se comprueba que existe. */
  versionArgs: string[];
  /** Orden de instalación, lista para copiar. */
  install: string;
  docs: string;
}

export const TUNNEL_TOOLS: readonly TunnelToolInfo[] = [
  {
    id: 'devtunnel',
    label: 'Dev Tunnels (Microsoft)',
    command: 'devtunnel',
    versionArgs: ['--version'],
    install: 'winget install Microsoft.devtunnel',
    docs: 'https://learn.microsoft.com/azure/developer/dev-tunnels/',
  },
  {
    id: 'ngrok',
    label: 'ngrok',
    command: 'ngrok',
    versionArgs: ['--version'],
    install: 'winget install ngrok.ngrok',
    docs: 'https://ngrok.com/docs',
  },
];

export function tunnelInfo(tool: TunnelTool): TunnelToolInfo {
  return TUNNEL_TOOLS.find((entry) => entry.id === tool) ?? TUNNEL_TOOLS[0]!;
}

export type TunnelStatus = 'idle' | 'checking' | 'starting' | 'running' | 'error';

export interface TunnelState {
  status: TunnelStatus;
  tool: TunnelTool | null;
  /** Puerto local publicado. Null mientras no haya túnel. */
  port: number | null;
  /** URL pública HTTPS, en cuanto la herramienta la anuncia. */
  url: string | null;
  /** Explicación para la interfaz: qué falta o qué ha fallado. */
  message: string | null;
  /** Tarea que lo mantiene vivo, para poder pararla. */
  taskId: string | null;
  /** Herramientas encontradas en el PATH. */
  available: TunnelTool[];
}

export const IDLE_TUNNEL: TunnelState = {
  status: 'idle',
  tool: null,
  port: null,
  url: null,
  message: null,
  taskId: null,
  available: [],
};

/** Un puerto de verdad: entero en el rango sin privilegios y sin llegar al final del rango. */
export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536;
}

/**
 * Argumentos del túnel.
 *
 * `devtunnel host --allow-anonymous` publica sin exigir que quien llame se autentique: es la única
 * forma de que un webhook de un tercero pueda entrar, que es justo para lo que se abre el túnel.
 * Se dice en la interfaz, porque publicar un puerto en internet no debería pasar en silencio.
 *
 * `ngrok --log=stdout` es imprescindible: sin eso ngrok pinta una interfaz de terminal a pantalla
 * completa con códigos de control y la URL nunca llega como texto.
 */
export function tunnelArgs(tool: TunnelTool, port: number): string[] {
  if (!isValidPort(port)) throw new Error(`puerto no válido para el túnel: ${String(port)}`);

  return tool === 'devtunnel'
    ? ['host', '-p', String(port), '--allow-anonymous']
    : ['http', String(port), '--log=stdout', '--log-format=logfmt'];
}

/**
 * Hosts de túnel que se reconocen.
 *
 * Es una lista blanca y no "cualquier https": la salida de estas herramientas trae también la URL
 * de la documentación, la del panel de control y, en el caso de ngrok, la del inspector local.
 * Cogiendo la primera URL que pasara se acabaría enseñando `https://ngrok.com` como si fuera el
 * túnel.
 */
const TUNNEL_HOSTS = [
  '.devtunnels.ms',
  '.ngrok-free.app',
  '.ngrok.app',
  '.ngrok.io',
  '.ngrok-free.dev',
];

/**
 * URL pública en una línea de salida.
 *
 * Se descarta explícitamente la del inspector de red de Dev Tunnels (`-inspect`): es una página
 * de diagnóstico, no el destino al que hay que apuntar el webhook, y aparece **después** de la
 * buena, así que quedarse con la última sería quedarse con la equivocada.
 */
export function detectTunnelUrl(text: string): string | null {
  const pattern = /https:\/\/[A-Za-z0-9._-]+(?::\d+)?(?:\/[^\s"']*)?/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const url = match[0].replace(/[.,;)\]]+$/, '');
    const host = url.slice('https://'.length).split('/')[0]!.toLowerCase();

    if (!TUNNEL_HOSTS.some((suffix) => host.endsWith(suffix))) continue;
    if (host.includes('-inspect.')) continue;

    return url;
  }

  return null;
}

/**
 * Acumulador de salida que sólo procesa líneas terminadas.
 *
 * Los trozos de un stream no respetan los límites de línea: `Connect via browser: https://abc-50`
 * es una lectura perfectamente normal, y quien busque la URL en ese trozo encontrará una URL
 * truncada y la dará por buena. Esta clase guarda la cola incompleta hasta que llegue su salto de
 * línea, que es la misma regla que ya se aplica al parser de SSE del asistente.
 */
export class TunnelOutputScanner {
  private buffer = '';
  private found: string | null = null;

  /** Devuelve la URL la **primera** vez que aparece y null en las siguientes. */
  push(chunk: string): string | null {
    if (this.found !== null) return null;

    this.buffer += chunk;

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const url = detectTunnelUrl(line);
      if (url !== null) {
        this.found = url;
        return url;
      }
    }

    return null;
  }

  url(): string | null {
    return this.found;
  }

  reset(): void {
    this.buffer = '';
    this.found = null;
  }
}

/** Aviso que acompaña siempre a un túnel abierto. Publicar un puerto no es un detalle. */
export const TUNNEL_WARNING =
  'El túnel expone este puerto en internet mientras esté abierto. Ciérralo cuando termines.';

/** Mensaje cuando la herramienta no está instalada, con la orden para instalarla. */
export function missingToolMessage(tool: TunnelTool): string {
  const info = tunnelInfo(tool);
  return `${info.command} no está instalado o no está en el PATH. Instálalo con: ${info.install}`;
}
