/**
 * Lectura de archivos `docker-compose.yml`.
 *
 * **Por qué un parser propio y no una librería de YAML.** El proyecto tiene una regla: cero
 * dependencias nativas y las mínimas de runtime. Un `docker-compose.yml` usa un subconjunto muy
 * pequeño de YAML —mapas, listas, escalares y poco más— y ese subconjunto cabe en un archivo
 * probado. Traerse un parser completo (con anclas, etiquetas, documentos múltiples y flujo) para
 * leer cuatro claves sería pagar un peso y una superficie que no se usan.
 *
 * Lo que **no** se soporta, a propósito y con consecuencias conocidas:
 *  - anclas y referencias (`&base`, `*base`): los servicios que las usen se leen sin heredar;
 *  - bloques literales (`|`, `>`): el valor se queda vacío;
 *  - documentos múltiples (`---`): se lee el primero.
 *
 * Ninguna de las tres aparece en un compose de desarrollo típico, y cuando aparecen el panel
 * sigue funcionando con lo que sí entiende en vez de fallar entero: lo que se pierde es detalle,
 * no la lista de servicios.
 *
 * Todo es función pura sobre el texto del archivo.
 */
import type { ContainerState, DockerContainer, PortBinding } from './docker.js';
import { localUrlOf, supportKindOf, supportLabel, type SupportKind } from './docker.js';

// ---------------------------------------------------------------------------------------------
// YAML mínimo
// ---------------------------------------------------------------------------------------------

export type YamlNode = string | YamlNode[] | { [key: string]: YamlNode };

interface Line {
  indent: number;
  text: string;
}

/** Quita comentarios y líneas vacías, y mide la indentación de cada línea. */
function readLines(text: string): Line[] {
  const lines: Line[] = [];

  for (const raw of text.split(/\r?\n/)) {
    // Los tabuladores no son YAML válido, pero aparecen: se cuentan como dos espacios.
    const expanded = raw.replace(/\t/g, '  ');
    const withoutComment = stripComment(expanded);

    if (withoutComment.trim() === '') continue;
    if (withoutComment.trim() === '---') continue;

    lines.push({ indent: withoutComment.length - withoutComment.trimStart().length, text: withoutComment.trim() });
  }

  return lines;
}

/** Quita el comentario de una línea sin tocar las almohadillas dentro de comillas. */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // Sólo cuenta como comentario si va precedida de espacio o abre la línea.
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }

  return line;
}

/** Desenvuelve un escalar: quita comillas y devuelve el texto tal cual en otro caso. */
export function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
    const quote = trimmed[0]!;
    if (trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Lista en línea: `[a, b]` o `["a", "b"]`. Devuelve null si no lo es. */
function inlineList(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;

  const body = trimmed.slice(1, -1).trim();
  return body === '' ? [] : body.split(',').map((entry) => scalar(entry));
}

function parseBlock(lines: readonly Line[], start: number, indent: number): { node: YamlNode; next: number } {
  // Secuencia: todas las líneas del nivel empiezan por "- ".
  if (lines[start] !== undefined && lines[start]!.indent === indent && lines[start]!.text.startsWith('- ')) {
    const items: YamlNode[] = [];
    let index = start;

    while (index < lines.length && lines[index]!.indent === indent && lines[index]!.text.startsWith('- ')) {
      const content = lines[index]!.text.slice(2).trim();

      // `- clave: valor` abre un mapa cuyo resto de claves va indentado debajo.
      //
      // La comprobación es más exigente de lo que parece necesario, y con motivo: `- "5672:5672"`
      // y `- 6379:6379` también llevan dos puntos y **no** son mapas, son los puertos. Se exige
      // que no empiece por comilla y que tras los dos puntos venga un espacio o el fin de línea,
      // que es lo que distingue una clave YAML de un mapeo de puertos.
      if (/^[^\s"'][^:]*:(\s|$)/.test(content)) {
        const inner: Line[] = [{ indent: indent + 2, text: content }];
        let scan = index + 1;
        while (scan < lines.length && lines[scan]!.indent > indent) {
          inner.push(lines[scan]!);
          scan++;
        }
        items.push(parseBlock(inner, 0, indent + 2).node);
        index = scan;
        continue;
      }

      items.push(scalar(content));
      index++;
    }

    return { node: items, next: index };
  }

  // Mapa.
  const map: { [key: string]: YamlNode } = {};
  let index = start;

  while (index < lines.length && lines[index]!.indent >= indent) {
    const line = lines[index]!;
    if (line.indent > indent) {
      // Indentación inesperada: se salta en vez de reventar.
      index++;
      continue;
    }

    const separator = line.text.indexOf(':');
    if (separator === -1) {
      index++;
      continue;
    }

    const key = scalar(line.text.slice(0, separator));
    const rest = line.text.slice(separator + 1).trim();

    if (rest !== '') {
      const list = inlineList(rest);
      map[key] = list ?? scalar(rest);
      index++;
      continue;
    }

    // Valor en bloque: lo que venga con más indentación, o una secuencia al mismo nivel.
    const childIndent = lines[index + 1]?.indent ?? -1;

    if (childIndent > line.indent || (childIndent === line.indent && lines[index + 1]!.text.startsWith('- '))) {
      const child = parseBlock(lines, index + 1, childIndent);
      map[key] = child.node;
      index = child.next;
      continue;
    }

    map[key] = '';
    index++;
  }

  return { node: map, next: index };
}

/** Documento YAML como mapa. Un archivo vacío devuelve un mapa vacío, no un error. */
export function parseYaml(text: string): Record<string, YamlNode> {
  const lines = readLines(text);
  if (lines.length === 0) return {};

  const node = parseBlock(lines, 0, lines[0]!.indent).node;
  return typeof node === 'object' && !Array.isArray(node) ? node : {};
}

// ---------------------------------------------------------------------------------------------
// Modelo de Compose
// ---------------------------------------------------------------------------------------------

export interface ComposeService {
  /** Clave del servicio en el archivo: es el nombre que entiende `docker compose`. */
  name: string;
  image: string | null;
  /** Contexto de `build:`, cuando el servicio se construye en vez de descargarse. */
  build: string | null;
  containerName: string | null;
  ports: PortBinding[];
  dependsOn: string[];
  profiles: string[];
  /** Nombre legible del servicio de apoyo (SQL Server, Redis…) o el del propio servicio. */
  label: string;
  kind: SupportKind;
}

export interface ComposeFile {
  /** Ruta absoluta del archivo, tal como la conoce el proceso principal. */
  path: string;
  /** Nombre de proyecto declarado (`name:`), si lo hay. */
  projectName: string | null;
  services: ComposeService[];
  volumes: string[];
}

/** Nombres de archivo que Docker Compose reconoce por convención. */
export const COMPOSE_FILE_NAMES: readonly string[] = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'docker-compose.override.yml',
  'docker-compose.dev.yml',
];

export function isComposeFile(fileName: string): boolean {
  return COMPOSE_FILE_NAMES.includes(fileName.toLowerCase());
}

function asArray(node: YamlNode | undefined): string[] {
  if (node === undefined) return [];
  if (typeof node === 'string') return node === '' ? [] : [node];
  if (Array.isArray(node)) return node.filter((entry): entry is string => typeof entry === 'string');
  // `depends_on:` con condiciones es un mapa: interesan las claves.
  return Object.keys(node);
}

/**
 * Puertos declarados en el compose.
 *
 * Las formas que aparecen de verdad: `"1433:1433"`, `1433:1433`, `"127.0.0.1:5432:5432"` (con
 * dirección), `"8080:80/tcp"` y `"5341"` (sólo el del contenedor, sin publicar en un puerto fijo).
 * Esta última no se cuenta: no hay puerto de host que enseñar hasta que el contenedor arranque.
 */
export function parseComposePorts(entries: readonly string[]): PortBinding[] {
  const bindings: PortBinding[] = [];

  for (const raw of entries) {
    const value = scalar(raw);
    const match = /^(?:[\d.]+:)?(\d+):(\d+)(?:\/(tcp|udp))?$/.exec(value);
    if (!match) continue;

    bindings.push({ host: Number(match[1]), container: Number(match[2]), protocol: (match[3] as 'tcp' | 'udp') ?? 'tcp' });
  }

  return bindings;
}

/** Servicios y volúmenes de un `docker-compose.yml`. */
export function parseCompose(text: string, path: string): ComposeFile {
  const document = parseYaml(text);
  const servicesNode = document['services'];

  const services: ComposeService[] = [];

  if (typeof servicesNode === 'object' && servicesNode !== null && !Array.isArray(servicesNode)) {
    for (const [name, node] of Object.entries(servicesNode)) {
      const service = typeof node === 'object' && !Array.isArray(node) ? node : {};

      const image = typeof service['image'] === 'string' && service['image'] !== '' ? service['image'] : null;
      const buildNode = service['build'];
      const build =
        typeof buildNode === 'string' && buildNode !== ''
          ? buildNode
          : typeof buildNode === 'object' && !Array.isArray(buildNode) && typeof buildNode['context'] === 'string'
            ? buildNode['context']
            : null;

      services.push({
        name,
        image,
        build,
        containerName: typeof service['container_name'] === 'string' ? service['container_name'] : null,
        ports: parseComposePorts(asArray(service['ports'])),
        dependsOn: asArray(service['depends_on']),
        profiles: asArray(service['profiles']),
        // Sin imagen (se construye), el nombre del servicio es lo mejor que se puede enseñar.
        label: image === null ? name : supportLabel(image),
        kind: image === null ? 'other' : supportKindOf(image),
      });
    }
  }

  const volumesNode = document['volumes'];
  const volumes =
    typeof volumesNode === 'object' && volumesNode !== null && !Array.isArray(volumesNode)
      ? Object.keys(volumesNode)
      : asArray(volumesNode);

  return {
    path,
    projectName: typeof document['name'] === 'string' && document['name'] !== '' ? document['name'] : null,
    services,
    volumes,
  };
}

// ---------------------------------------------------------------------------------------------
// Correspondencia entre lo declarado y lo que corre
// ---------------------------------------------------------------------------------------------

export interface ServiceStatus {
  service: ComposeService;
  /** Contenedor real, si lo hay. Null cuando el servicio está declarado pero no levantado. */
  container: DockerContainer | null;
  /** Estado del contenedor, o `down` si no existe todavía. */
  state: ContainerState | 'down';
  /** Puertos reales si está levantado; los declarados en el compose si no. */
  ports: PortBinding[];
  /** URL local abrible, sólo para lo que tiene sentido abrir en un navegador. */
  url: string | null;
}

export interface ComposeState {
  services: ServiceStatus[];
  /** Contenedores que no pertenecen a este compose: se listan aparte, sin mezclarlos. */
  others: DockerContainer[];
}

/**
 * Cruza los servicios declarados con los contenedores del motor.
 *
 * **El compose manda, el motor confirma.** La lista sale del archivo del repositorio —existe
 * aunque no haya nada levantado, que es justo cuando hace falta el panel— y el estado se le pega
 * después.
 *
 * La correspondencia se hace por la etiqueta `com.docker.compose.service`, que es la verdad, y en
 * segundo lugar por el `container_name` declarado, para los contenedores levantados a mano. **No**
 * se adivina por parecido del nombre: dos proyectos con un servicio `redis` acabarían
 * intercambiándose los botones de parar.
 */
export function matchComposeState(
  compose: ComposeFile | null,
  containers: readonly DockerContainer[],
): ComposeState {
  const services: ServiceStatus[] = [];
  const claimed = new Set<string>();

  for (const service of compose?.services ?? []) {
    const container =
      containers.find(
        (candidate) =>
          candidate.composeService === service.name &&
          (compose?.projectName == null || candidate.composeProject === compose.projectName),
      ) ??
      containers.find((candidate) => candidate.composeService === service.name) ??
      (service.containerName === null
        ? undefined
        : containers.find((candidate) => candidate.name === service.containerName));

    if (container) claimed.add(container.name);

    services.push({
      service,
      container: container ?? null,
      state: container?.state ?? 'down',
      ports: (container?.ports.length ?? 0) > 0 ? container!.ports : service.ports,
      url: container === undefined ? null : localUrlOf(container),
    });
  }

  return { services, others: containers.filter((container) => !claimed.has(container.name)) };
}

// ---------------------------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------------------------

export type ComposeAction = 'up' | 'down' | 'restart' | 'pull' | 'build' | 'logs' | 'stop' | 'start';

/**
 * Argumentos de `docker compose` para una acción.
 *
 * `-f <archivo>` va siempre, incluso con un único compose en la raíz: el directorio de trabajo del
 * proceso lo pone el IDE y no tiene por qué coincidir con el del archivo.
 *
 * `up` lleva `-d` obligatoriamente: un compose en primer plano dentro de un panel que no es un
 * terminal deja un proceso que no se puede parar con Ctrl+C.
 */
export function composeArgs(action: ComposeAction, file: string, service?: string | null): string[] {
  const target = service !== undefined && service !== null && service !== '' ? [service] : [];

  const tail: Record<ComposeAction, string[]> = {
    up: ['up', '-d', ...target],
    down: ['down', ...(target.length > 0 ? ['--remove-orphans'] : [])],
    restart: ['restart', ...target],
    pull: ['pull', ...target],
    build: ['build', ...target],
    // Sin `-f` de seguimiento: el panel pide el log y lo vuelca, no se queda escuchando.
    logs: ['logs', '--tail', '200', ...target],
    stop: ['stop', ...target],
    start: ['start', ...target],
  };

  return ['compose', '-f', file, ...tail[action]];
}

/** Acciones sobre un contenedor suelto, fuera de Compose. */
export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove' | 'logs';

export function containerArgs(action: ContainerAction, container: string): string[] {
  const args: Record<ContainerAction, string[]> = {
    start: ['start', container],
    stop: ['stop', container],
    restart: ['restart', container],
    remove: ['rm', '-f', container],
    logs: ['logs', '--tail', '200', container],
  };

  return args[action];
}
