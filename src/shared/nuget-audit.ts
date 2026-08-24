/**
 * Auditoría de seguridad de los paquetes NuGet.
 *
 * `dotnet list package --vulnerable` cruza los paquetes restaurados con la base de avisos de
 * GitHub Security Advisories, que es la misma que alimenta a Dependabot. No hay que instalar nada
 * ni darse de alta en ningún servicio: la información ya está en el SDK.
 *
 * **Se lee el JSON, no la tabla.** Desde el SDK 9 el comando admite `--format json`, y esa es la
 * fuente: la tabla de texto tiene las cabeceras y los niveles de gravedad traducidos al idioma del
 * sistema, y decidir sobre esas palabras es la trampa que ya costó dos errores en este proyecto.
 * El parseo de la tabla existe como camino degradado —para un SDK antiguo— y se marca como tal.
 *
 * **Los transitivos cuentan.** La vulnerabilidad casi nunca está en el paquete que se instaló, sino
 * en algo que ese paquete arrastra. Ocultarlos daría una lista tranquilizadora y falsa; se enseñan
 * aparte, diciendo quién los trae.
 *
 * Todo lo de este archivo es puro.
 */

export type VulnerabilitySeverity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';

export interface PackageVulnerability {
  severity: VulnerabilitySeverity;
  /** URL del aviso en GitHub Security Advisories. */
  advisoryUrl: string;
  /** `GHSA-xxxx-xxxx-xxxx` o `CVE-2024-12345`, extraído de la URL. Null si no se reconoce. */
  identifier: string | null;
}

export interface VulnerablePackage {
  id: string;
  /** Versión pedida en el `.csproj`. Null en un transitivo, que nadie pidió. */
  requestedVersion: string | null;
  resolvedVersion: string;
  /** true si llega arrastrado por otro paquete y no está en el `.csproj`. */
  transitive: boolean;
  framework: string | null;
  /** Ruta del `.csproj` afectado. */
  project: string;
  projectName: string;
  vulnerabilities: PackageVulnerability[];
  /** La peor gravedad del paquete: es la que pinta su fila. */
  worst: VulnerabilitySeverity;
}

export interface AuditReport {
  packages: VulnerablePackage[];
  /** Proyectos que se han podido revisar. */
  projects: string[];
  /** true si los datos salen de parsear la tabla en vez del JSON. */
  degraded: boolean;
  /** Explicación cuando no se ha podido auditar (sin restaurar, sin red, SDK antiguo). */
  error: string | null;
  /** Momento de la lectura, en milisegundos desde epoch. Lo pone quien ejecuta. */
  at: number;
}

export const EMPTY_REPORT: AuditReport = {
  packages: [],
  projects: [],
  degraded: false,
  error: null,
  at: 0,
};

const SEVERITY_ORDER: Record<VulnerabilitySeverity, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
};

export const SEVERITY_LABEL: Record<VulnerabilitySeverity, string> = {
  critical: 'Crítica',
  high: 'Alta',
  moderate: 'Media',
  low: 'Baja',
  unknown: 'Sin clasificar',
};

export function severityRank(severity: VulnerabilitySeverity): number {
  return SEVERITY_ORDER[severity] ?? 0;
}

/**
 * Normaliza la gravedad que devuelve el SDK.
 *
 * Con `--format json` llega siempre en inglés (`Critical`, `High`, `Moderate`, `Low`) porque es el
 * valor del aviso, no un mensaje de la CLI. En el camino degradado puede venir traducida: se
 * reconocen también las formas en español y, si no encaja ninguna, se marca `unknown` en vez de
 * suponer que es leve.
 */
export function coerceSeverity(raw: unknown): VulnerabilitySeverity {
  if (typeof raw !== 'string') return 'unknown';

  const value = raw.trim().toLowerCase();
  if (value === 'critical' || value === 'crítica' || value === 'critica') return 'critical';
  if (value === 'high' || value === 'alta') return 'high';
  if (value === 'moderate' || value === 'medium' || value === 'media') return 'moderate';
  if (value === 'low' || value === 'baja') return 'low';
  return 'unknown';
}

/** `GHSA-…` o `CVE-…` dentro de la URL del aviso. */
export function advisoryIdentifier(url: string): string | null {
  const cve = /CVE-\d{4}-\d{4,7}/i.exec(url);
  if (cve) return cve[0].toUpperCase();

  const ghsa = /GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}/i.exec(url);
  return ghsa ? ghsa[0].toUpperCase() : null;
}

/** La peor gravedad de una lista. Vacía significa `unknown`. */
export function worstSeverity(vulnerabilities: readonly PackageVulnerability[]): VulnerabilitySeverity {
  return vulnerabilities.reduce<VulnerabilitySeverity>(
    (worst, entry) => (severityRank(entry.severity) > severityRank(worst) ? entry.severity : worst),
    'unknown',
  );
}

/** Nombre del proyecto a partir de la ruta de su `.csproj`. */
function projectNameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return (parts[parts.length - 1] ?? path).replace(/\.csproj$/i, '');
}

// ---------------------------------------------------------------------------------------------
// Camino principal: `--format json`
// ---------------------------------------------------------------------------------------------

interface JsonVulnerability {
  severity?: unknown;
  advisoryurl?: unknown;
  advisoryUrl?: unknown;
}

interface JsonPackage {
  id?: unknown;
  requestedVersion?: unknown;
  resolvedVersion?: unknown;
  vulnerabilities?: unknown;
}

interface JsonFramework {
  framework?: unknown;
  topLevelPackages?: unknown;
  transitivePackages?: unknown;
}

interface JsonProject {
  path?: unknown;
  frameworks?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readVulnerabilities(raw: unknown): PackageVulnerability[] {
  return asArray(raw)
    .map((entry) => {
      const record = entry as JsonVulnerability;
      const url = typeof record.advisoryurl === 'string' ? record.advisoryurl
        : typeof record.advisoryUrl === 'string' ? record.advisoryUrl
        : '';

      return {
        severity: coerceSeverity(record.severity),
        advisoryUrl: url,
        identifier: advisoryIdentifier(url),
      };
    })
    .filter((entry) => entry.advisoryUrl !== '' || entry.severity !== 'unknown');
}

function readPackages(
  raw: unknown,
  project: string,
  framework: string | null,
  transitive: boolean,
): VulnerablePackage[] {
  const packages: VulnerablePackage[] = [];

  for (const entry of asArray(raw)) {
    const record = entry as JsonPackage;
    if (typeof record.id !== 'string' || record.id === '') continue;

    const vulnerabilities = readVulnerabilities(record.vulnerabilities);
    if (vulnerabilities.length === 0) continue;

    packages.push({
      id: record.id,
      requestedVersion: typeof record.requestedVersion === 'string' ? record.requestedVersion : null,
      resolvedVersion: typeof record.resolvedVersion === 'string' ? record.resolvedVersion : '',
      transitive,
      framework,
      project,
      projectName: projectNameOf(project),
      vulnerabilities,
      worst: worstSeverity(vulnerabilities),
    });
  }

  return packages;
}

/**
 * Informe a partir de la salida JSON de `dotnet list package --vulnerable`.
 *
 * Devuelve null si el texto no contiene un JSON con la forma esperada: eso es lo que hace que el
 * llamador decida caer al camino degradado, sin tener que buscar ninguna frase de error.
 */
export function parseVulnerableJson(stdout: string): AuditReport | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) return null;

  const projects = asArray((payload as { projects?: unknown }).projects);
  if (projects.length === 0 && !('projects' in (payload as Record<string, unknown>))) return null;

  const packages: VulnerablePackage[] = [];
  const paths: string[] = [];

  for (const entry of projects) {
    const project = entry as JsonProject;
    const path = typeof project.path === 'string' ? project.path : '';
    if (path === '') continue;

    paths.push(path);

    for (const frameworkEntry of asArray(project.frameworks)) {
      const framework = frameworkEntry as JsonFramework;
      const name = typeof framework.framework === 'string' ? framework.framework : null;

      packages.push(...readPackages(framework.topLevelPackages, path, name, false));
      packages.push(...readPackages(framework.transitivePackages, path, name, true));
    }
  }

  return { packages: sortPackages(packages), projects: paths, degraded: false, error: null, at: 0 };
}

// ---------------------------------------------------------------------------------------------
// Camino degradado: la tabla de texto
// ---------------------------------------------------------------------------------------------

/**
 * Informe a partir de la tabla de texto.
 *
 * Se parsea por **forma**, no por palabras: una fila de paquete empieza por `>` y termina en una
 * URL, y el proyecto se reconoce por el nombre entre acentos graves. La única palabra que se mira
 * es la gravedad, y para eso está `coerceSeverity`, que admite las dos formas y no se inventa nada
 * si no reconoce ninguna. Lo mismo con "transitivo": se cuenta el número de columnas, que no está
 * traducido, en vez de buscar la palabra en la cabecera de la sección.
 */
export function parseVulnerableText(stdout: string): AuditReport {
  const packages: VulnerablePackage[] = [];
  const projects: string[] = [];

  let project = '';
  let framework: string | null = null;

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;

    const projectLine = /`([^`]+)`/.exec(line);
    if (projectLine && !line.startsWith('>')) {
      project = projectLine[1]!;
      if (!projects.includes(project)) projects.push(project);
      continue;
    }

    const frameworkLine = /^\[([^\]]+)\]:?$/.exec(line);
    if (frameworkLine) {
      framework = frameworkLine[1]!;
      continue;
    }

    if (!line.startsWith('>')) continue;

    const columns = line.slice(1).trim().split(/\s{2,}/).filter((column) => column !== '');
    if (columns.length < 3) continue;

    const advisoryUrl = columns[columns.length - 1]!;
    if (!/^https?:\/\//.test(advisoryUrl)) continue;

    const severity = coerceSeverity(columns[columns.length - 2]);
    const id = columns[0]!;
    const versions = columns.slice(1, columns.length - 2);
    const resolvedVersion = versions[versions.length - 1] ?? '';
    const requestedVersion = versions.length > 1 ? versions[0]! : null;

    /**
     * Transitivo se decide **contando columnas**, no leyendo la cabecera de la sección.
     *
     * Un paquete directo trae versión pedida y versión resuelta; uno transitivo sólo la resuelta,
     * porque nadie lo pidió. La cabecera dice "Paquete transitivo" en español y "Transitive
     * Package" en inglés, y decidir sobre esa palabra es la trampa de siempre.
     */
    const transitive = requestedVersion === null;

    const vulnerability: PackageVulnerability = {
      severity,
      advisoryUrl,
      identifier: advisoryIdentifier(advisoryUrl),
    };

    // Un mismo paquete puede traer varios avisos, uno por línea: se agrupan en la misma fila.
    const existing = packages.find((entry) => entry.id === id && entry.project === project);
    if (existing) {
      existing.vulnerabilities.push(vulnerability);
      existing.worst = worstSeverity(existing.vulnerabilities);
      continue;
    }

    packages.push({
      id,
      requestedVersion,
      resolvedVersion,
      transitive,
      framework,
      project,
      projectName: projectNameOf(project),
      vulnerabilities: [vulnerability],
      worst: severity,
    });
  }

  return { packages: sortPackages(packages), projects, degraded: true, error: null, at: 0 };
}

/** Lo peor primero, y a igualdad de gravedad por nombre: la lista se lee de arriba abajo. */
export function sortPackages(packages: readonly VulnerablePackage[]): VulnerablePackage[] {
  return [...packages].sort((a, b) => {
    const bySeverity = severityRank(b.worst) - severityRank(a.worst);
    if (bySeverity !== 0) return bySeverity;
    if (a.transitive !== b.transitive) return a.transitive ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

/** Cuántos paquetes hay de cada gravedad, para las pastillas de la cabecera. */
export function countBySeverity(packages: readonly VulnerablePackage[]): Record<VulnerabilitySeverity, number> {
  const counts: Record<VulnerabilitySeverity, number> = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    unknown: 0,
  };

  for (const entry of packages) counts[entry.worst]++;
  return counts;
}

/** Resumen de una línea para la barra de avisos y la insignia de la barra de actividad. */
export function describeAudit(report: AuditReport): string {
  if (report.error !== null) return report.error;
  if (report.packages.length === 0) return 'Sin vulnerabilidades conocidas en los paquetes restaurados.';

  const counts = countBySeverity(report.packages);
  const parts = (['critical', 'high', 'moderate', 'low'] as VulnerabilitySeverity[])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${SEVERITY_LABEL[severity].toLowerCase()}`);

  return `${report.packages.length} paquete(s) con avisos: ${parts.join(', ')}`;
}

/** Argumentos del comando. El JSON es el camino bueno; sin `--format` se cae a la tabla. */
export function auditArgs(target: string, json: boolean): string[] {
  const args = ['list', target, 'package', '--vulnerable', '--include-transitive'];
  if (json) args.push('--format', 'json');
  return args;
}

/**
 * Aviso cuando el proyecto no está restaurado.
 *
 * Es el fallo más frecuente y el más fácil de arreglar: el comando necesita el grafo de
 * dependencias resuelto, que sólo existe después de un `restore`.
 */
export const AUDIT_RESTORE_HINT =
  'La auditoría necesita los paquetes restaurados. Ejecuta `dotnet restore` sobre la solución y vuelve a intentarlo.';
