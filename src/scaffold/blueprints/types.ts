/**
 * Modelo de blueprint: describe una arquitectura generable.
 *
 * Un blueprint NO contiene código C#. Sólo describe qué proyectos existen, en qué carpeta de la
 * solución van y qué archivos de plantilla aplican según las opciones. El código vive en
 * `src/scaffold/templates/<templateDir>/`.
 */
import type { BlueprintInfo } from '../../shared/scaffold-types.js';
import type { ResolvedOptions } from '../context.js';

export interface ProjectDescriptor {
  /** Nombre con tokens de ruta, p. ej. `__Solution__.Domain`. */
  name: string;
  /** Directorio del proyecto relativo a la raíz, p. ej. `src/__Solution__.Domain`. */
  dir: string;
  /** Capa arquitectónica (coincide con `BlueprintInfo.layers[].name`). */
  layer: string;
  /** Carpeta de solución en la que agrupar el proyecto en el .sln. */
  solutionFolder: string;
  /** Si se omite, el proyecto siempre se genera. */
  when?: (options: ResolvedOptions) => boolean;
}

export interface Blueprint {
  info: BlueprintInfo;
  /** Subcarpeta bajo `src/scaffold/templates/`. */
  templateDir: string;
  projects: ProjectDescriptor[];
  /**
   * Decide si un archivo de plantilla (ruta relativa a `templates/<templateDir>/`, con tokens
   * `__X__` aún sin resolver y sin la extensión `.tmpl`) forma parte de esta generación.
   */
  includeFile(relPath: string, options: ResolvedOptions): boolean;
}

/**
 * Filtro compartido por los tres blueprints: descarta los archivos de los proyectos de
 * presentación y de tests que el usuario no ha pedido.
 *
 * `webDirs` mapea el prefijo de ruta de cada proyecto opcional a su condición.
 */
export function makeIncludeFile(
  rules: Array<{ prefix: string; when: (options: ResolvedOptions) => boolean }>,
): Blueprint['includeFile'] {
  return (relPath, options) => {
    const normalized = relPath.replace(/\\/g, '/');
    for (const rule of rules) {
      if (normalized === rule.prefix || normalized.startsWith(`${rule.prefix}/`)) {
        return rule.when(options);
      }
    }
    return true;
  };
}
