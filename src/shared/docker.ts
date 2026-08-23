/**
 * Modelo compartido de Docker.
 *
 * Se invoca la CLI de `docker` y se parsea su salida en JSON por línea (`--format "{{json .}}"`),
 * que es la única forma estable de leerla: la salida en tabla cambia de anchura con los nombres y
 * se rompe en cuanto un contenedor se llama `acme_shop_sqlserver_1`.
 *
 * Todo lo de este archivo es **función pura**. Lo consumen el proceso principal (que ejecuta
 * `docker`), el renderer (que pinta el panel de contenedores y sugiere nombres en la terminal) y
 * las pruebas, que trabajan con salidas capturadas de verdad.
 */

// ---------------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------------

/** Estado de un contenedor tal como lo devuelve el motor. */
export type ContainerState = 'running' | 'exited' | 'created' | 'paused' | 'restarting' | 'dead' | 'unknown';

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  /** Texto del estado (`Up 3 hours`, `Exited (0) 2 minutes ago`), tal cual lo escribe Docker. */
  status: string;
  state: ContainerState;
  /** Puertos publicados, ya extraídos: `[{ host: 1433, container: 1433 }]`. */
  ports: PortBinding[];
  /** Proyecto de Compose al que pertenece, si lo levantó Compose. */
  composeProject: string | null;
  /** Servicio de Compose (`sqlserver`, `redis`). Es el nombre que se usa en `docker compose`. */
  composeService: string | null;
}

export interface PortBinding {
  host: number;
  container: number;
  protocol: 'tcp' | 'udp';
}

export interface DockerImage {
  repository: string;
  tag: string;
  id: string;
  /** Tamaño legible tal cual lo da Docker (`1.32GB`). */
  size: string;
}

/** Nombre completo de la imagen, como se escribe en la terminal. */
export function imageName(image: DockerImage): string {
  return image.tag === '' || image.tag === '<none>' ? image.repository : `${image.repository}:${image.tag}`;
}

// ---------------------------------------------------------------------------------------------
// Servicios de apoyo reconocidos
// ---------------------------------------------------------------------------------------------

export type SupportKind =
  | 'sqlserver'
  | 'postgres'
  | 'mysql'
  | 'mongo'
  | 'redis'
  | 'rabbitmq'
  | 'kafka'
  | 'elasticsearch'
  | 'seq'
  | 'azurite'
  | 'mailhog'
  | 'other';

interface SupportSpec {
  kind: SupportKind;
  label: string;
  /** Fragmentos que identifican la imagen. Se comparan en minúsculas. */
  images: readonly string[];
  /** Puerto por defecto, para poder decir "escucha en el 1433" sin preguntar. */
  defaultPort: number | null;
}

/**
 * Servicios de apoyo que aparecen una y otra vez en un `docker-compose.yml` de .NET.
 *
 * Sirve para dos cosas: pintar cada contenedor con su nombre real ("SQL Server", no
 * "mcr.microsoft.com/mssql/server:2022-latest") y saber qué puerto mirar.
 */
const SUPPORT_SERVICES: readonly SupportSpec[] = [
  { kind: 'sqlserver', label: 'SQL Server', images: ['mssql/server', 'azure-sql-edge'], defaultPort: 1433 },
  { kind: 'postgres', label: 'PostgreSQL', images: ['postgres', 'postgis'], defaultPort: 5432 },
  { kind: 'mysql', label: 'MySQL', images: ['mysql', 'mariadb'], defaultPort: 3306 },
  { kind: 'mongo', label: 'MongoDB', images: ['mongo'], defaultPort: 27017 },
  { kind: 'redis', label: 'Redis', images: ['redis', 'valkey'], defaultPort: 6379 },
  { kind: 'rabbitmq', label: 'RabbitMQ', images: ['rabbitmq'], defaultPort: 5672 },
  { kind: 'kafka', label: 'Kafka', images: ['kafka', 'redpanda'], defaultPort: 9092 },
  { kind: 'elasticsearch', label: 'Elasticsearch', images: ['elasticsearch', 'opensearch'], defaultPort: 9200 },
  { kind: 'seq', label: 'Seq', images: ['datalust/seq'], defaultPort: 5341 },
  { kind: 'azurite', label: 'Azurite', images: ['azure-storage/azurite'], defaultPort: 10000 },
  { kind: 'mailhog', label: 'MailHog', images: ['mailhog', 'mailpit'], defaultPort: 8025 },
];

/** Tipo de servicio de apoyo a partir del nombre de la imagen. */
export function supportKindOf(image: string): SupportKind {
  const name = image.toLowerCase();
  return SUPPORT_SERVICES.find((service) => service.images.some((fragment) => name.includes(fragment)))?.kind ?? 'other';
}

/** Nombre legible del servicio, o la imagen sin registro ni etiqueta si no se reconoce. */
export function supportLabel(image: string): string {
  const kind = supportKindOf(image);
  if (kind !== 'other') return SUPPORT_SERVICES.find((service) => service.kind === kind)!.label;

  const withoutRegistry = image.split('/').pop() ?? image;
  return withoutRegistry.split(':')[0] ?? image;
}

export function defaultPortOf(kind: SupportKind): number | null {
  return SUPPORT_SERVICES.find((service) => service.kind === kind)?.defaultPort ?? null;
}

// ---------------------------------------------------------------------------------------------
// Parseo de la salida de la CLI
// ---------------------------------------------------------------------------------------------

/** Etiquetas de un contenedor: `clave=valor,clave=valor`. */
export function parseLabels(raw: string): Map<string, string> {
  const labels = new Map<string, string>();

  for (const entry of raw.split(',')) {
    const index = entry.indexOf('=');
    if (index === -1) continue;
    labels.set(entry.slice(0, index).trim(), entry.slice(index + 1).trim());
  }

  return labels;
}

/**
 * Puertos publicados, tal como los escribe `docker ps`.
 *
 * El formato tiene varias formas en la misma línea: `0.0.0.0:1433->1433/tcp`, `:::1433->1433/tcp`
 * (IPv6) y `6379/tcp` (expuesto pero no publicado). Sólo interesan los publicados, que son los
 * que se pueden abrir desde la máquina, y se deduplican: IPv4 e IPv6 son el mismo puerto.
 */
export function parsePorts(raw: string): PortBinding[] {
  const bindings = new Map<string, PortBinding>();

  for (const entry of raw.split(',')) {
    const match = /:(\d+)->(\d+)\/(tcp|udp)/.exec(entry.trim());
    if (!match) continue;

    const binding: PortBinding = {
      host: Number(match[1]),
      container: Number(match[2]),
      protocol: match[3] as 'tcp' | 'udp',
    };
    bindings.set(`${binding.host}/${binding.protocol}`, binding);
  }

  return [...bindings.values()];
}

function toState(value: string): ContainerState {
  const state = value.trim().toLowerCase();
  const known: ContainerState[] = ['running', 'exited', 'created', 'paused', 'restarting', 'dead'];
  return known.find((candidate) => candidate === state) ?? 'unknown';
}

/**
 * Contenedores a partir de `docker ps -a --format "{{json .}}"`.
 *
 * Cada línea es un objeto JSON independiente (NDJSON). Una línea que no parsea se salta: un aviso
 * del motor colado en stdout no puede dejar el panel vacío.
 */
export function parseContainers(stdout: string): DockerContainer[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return [];
      }

      const text = (key: string): string => (typeof entry[key] === 'string' ? (entry[key] as string) : '');
      const labels = parseLabels(text('Labels'));

      // `Names` puede traer varios nombres separados por coma; el primero es el principal.
      const name = text('Names').split(',')[0]?.trim() ?? '';
      if (name === '') return [];

      return [
        {
          id: text('ID') || text('Id'),
          name,
          image: text('Image'),
          status: text('Status'),
          // Docker antiguo no escribe `State`; se deduce del texto del estado, que empieza por "Up".
          state: entry['State'] === undefined ? (text('Status').startsWith('Up') ? 'running' : 'exited') : toState(text('State')),
          ports: parsePorts(text('Ports')),
          composeProject: labels.get('com.docker.compose.project') ?? null,
          composeService: labels.get('com.docker.compose.service') ?? null,
        } satisfies DockerContainer,
      ];
    });
}

/** Imágenes a partir de `docker images --format "{{json .}}"`. */
export function parseImages(stdout: string): DockerImage[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return [];
      }

      const text = (key: string): string => (typeof entry[key] === 'string' ? (entry[key] as string) : '');
      const repository = text('Repository');
      if (repository === '' || repository === '<none>') return [];

      return [{ repository, tag: text('Tag'), id: text('ID'), size: text('Size') } satisfies DockerImage];
    });
}

/** URL local de un contenedor con puerto publicado, para poder abrirlo desde el panel. */
export function localUrlOf(container: DockerContainer): string | null {
  const port = container.ports[0];
  if (!port || container.state !== 'running') return null;

  // Sólo se ofrece para lo que se puede abrir en un navegador: una base de datos no lo es.
  const kind = supportKindOf(container.image);
  const browsable: SupportKind[] = ['seq', 'rabbitmq', 'elasticsearch', 'mailhog', 'other'];

  return browsable.includes(kind) ? `http://localhost:${port.host}` : null;
}
