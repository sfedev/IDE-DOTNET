/** Registro de arquitecturas generables. Añadir una nueva es añadir una entrada aquí. */
import type { ArchitectureId, BlueprintInfo } from '../../shared/scaffold-types.js';
import { cleanBlueprint } from './clean.js';
import { dddBlueprint } from './ddd.js';
import { hexagonalBlueprint } from './hexagonal.js';
import type { Blueprint } from './types.js';

export const BLUEPRINTS: Record<ArchitectureId, Blueprint> = {
  clean: cleanBlueprint,
  hexagonal: hexagonalBlueprint,
  ddd: dddBlueprint,
};

export const ARCHITECTURE_IDS = Object.keys(BLUEPRINTS) as ArchitectureId[];

export function getBlueprint(id: ArchitectureId): Blueprint {
  const blueprint = BLUEPRINTS[id];
  if (!blueprint) {
    throw new Error(`arquitectura desconocida: "${id}". Disponibles: ${ARCHITECTURE_IDS.join(', ')}`);
  }
  return blueprint;
}

export function isArchitectureId(value: string): value is ArchitectureId {
  return Object.prototype.hasOwnProperty.call(BLUEPRINTS, value);
}

/** Metadatos de todas las arquitecturas, para la CLI (`list`) y el wizard visual. */
export function listBlueprints(): BlueprintInfo[] {
  return ARCHITECTURE_IDS.map((id) => BLUEPRINTS[id].info);
}

export type { Blueprint } from './types.js';
