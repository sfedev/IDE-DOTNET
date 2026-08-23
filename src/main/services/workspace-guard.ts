/**
 * Guardián de rutas.
 *
 * El renderer es territorio hostil: cualquier ruta que llegue de él puede ser un intento de
 * escapar del workspace (`../../../Windows/System32`). Todo handler IPC que toque el sistema de
 * archivos pasa por aquí antes de hacer nada.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathAccessError';
  }
}

let workspaceRoot: string | null = null;

/** Directorios adicionales permitidos (p. ej. el destino elegido en el wizard de scaffolding). */
const extraRoots = new Set<string>();

export function setWorkspaceRoot(root: string | null): void {
  workspaceRoot = root === null ? null : resolve(root);
}

export function getWorkspaceRoot(): string | null {
  return workspaceRoot;
}

/** Autoriza temporalmente un directorio fuera del workspace (destino de generación). */
export function allowRoot(root: string): void {
  extraRoots.add(resolve(root));
}

export function clearExtraRoots(): void {
  extraRoots.clear();
}

/** True si `candidate` está dentro de `root` (o es el propio root). */
export function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === '') return true;
  if (relativePath.startsWith('..')) return false;
  // En Windows, rutas en unidades distintas dan una ruta relativa absoluta.
  return !isAbsolute(relativePath);
}

/**
 * Normaliza y valida una ruta recibida del renderer.
 *
 * @throws PathAccessError si no hay workspace abierto o si la ruta se sale de los raíces permitidos.
 */
export function assertInsideWorkspace(candidate: unknown): string {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new PathAccessError('se esperaba una ruta no vacía');
  }

  // Un byte nulo trunca la ruta en llamadas de sistema: rechazo temprano.
  if (candidate.includes('\0')) {
    throw new PathAccessError('la ruta contiene caracteres no válidos');
  }

  const resolved = resolve(candidate);
  const roots = [...(workspaceRoot ? [workspaceRoot] : []), ...extraRoots];

  if (roots.length === 0) {
    throw new PathAccessError('no hay ningún workspace abierto');
  }

  if (!roots.some((root) => isInside(root, resolved))) {
    throw new PathAccessError(
      `acceso denegado: "${resolved}" está fuera del workspace (${roots.join(', ')})`,
    );
  }

  return resolved;
}

/** Ruta relativa al workspace, con separadores POSIX, para mostrar en la UI. */
export function toWorkspaceRelative(absolutePath: string): string {
  if (!workspaceRoot) return absolutePath;
  const relativePath = relative(workspaceRoot, absolutePath);
  return relativePath === '' ? '.' : relativePath.split(sep).join('/');
}
