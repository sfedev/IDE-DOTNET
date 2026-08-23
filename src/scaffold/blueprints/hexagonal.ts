import type { Blueprint } from './types.js';
import { makeIncludeFile } from './types.js';

/**
 * Arquitectura Hexagonal (Ports & Adapters, Alistair Cockburn).
 *
 * Tres anillos:
 *  - Domain: el modelo puro. No conoce absolutamente nada del exterior.
 *  - Ports: la frontera del hexágono. Declara los puertos de entrada (casos de uso) y de salida
 *    (persistencia, notificaciones, reloj) y contiene los servicios de aplicación que implementan
 *    los puertos de entrada apoyándose únicamente en los de salida.
 *  - Adapters: el mundo exterior. Adaptadores conductores (Web, Blazor) que invocan puertos de
 *    entrada, y adaptadores conducidos (persistencia, notificaciones) que implementan los de salida.
 *
 * Nota de diseño: los servicios de aplicación viven en el proyecto Ports para mantener exactamente
 * los tres anillos que define el patrón. Si prefieres separarlos, extrae `Application/` a su propio
 * proyecto: no hay que tocar ni Domain ni los adaptadores.
 */
export const hexagonalBlueprint: Blueprint = {
  templateDir: 'hexagonal',

  info: {
    id: 'hexagonal',
    title: 'Arquitectura Hexagonal',
    tagline: 'Puertos y adaptadores: el núcleo no sabe quién lo llama ni quién le responde.',
    description:
      'Solución en Domain (núcleo), Ports (puertos de entrada y salida + servicios de aplicación) ' +
      'y Adapters (persistencia, notificaciones, Web y Blazor). Cambiar de base de datos o de ' +
      'interfaz de usuario es sustituir un adaptador, sin tocar el hexágono.',
    layers: [
      { name: 'Domain', role: 'Núcleo: modelo, invariantes y reglas puras.', dependsOn: [] },
      {
        name: 'Ports',
        role: 'Puertos de entrada (casos de uso) y de salida (repositorio, notificación, reloj).',
        dependsOn: ['Domain'],
      },
      {
        name: 'Adapters',
        role: 'Adaptadores conducidos (EF Core, notificaciones) y conductores (Web API, Blazor).',
        dependsOn: ['Ports', 'Domain'],
      },
    ],
    highlights: [
      'Puertos de entrada y de salida separados en carpetas explícitas.',
      'Adaptador de persistencia con EF Core intercambiable por uno en memoria.',
      'Adaptador de notificaciones que demuestra un puerto de salida no persistente.',
      'Los adaptadores conductores (Web/Blazor) sólo conocen puertos de entrada.',
      'Pruebas que ejercitan el hexágono con adaptadores dobles, sin infraestructura.',
    ],
    patterns: [
      'Ports & Adapters',
      'Inversión de dependencias',
      'Driving / Driven adapters',
      'Repository',
      'Value Object',
      'Result / Either',
    ],
  },

  projects: [
    {
      name: '__Solution__.Domain',
      dir: 'src/__Solution__.Domain',
      layer: 'Domain',
      solutionFolder: '1-Domain',
    },
    {
      name: '__Solution__.Ports',
      dir: 'src/__Solution__.Ports',
      layer: 'Ports',
      solutionFolder: '2-Ports',
    },
    {
      name: '__Solution__.Adapters.Persistence',
      dir: 'src/__Solution__.Adapters.Persistence',
      layer: 'Adapters',
      solutionFolder: '3-Adapters',
    },
    {
      name: '__Solution__.Adapters.Notifications',
      dir: 'src/__Solution__.Adapters.Notifications',
      layer: 'Adapters',
      solutionFolder: '3-Adapters',
    },
    {
      name: '__Solution__.Adapters.Web',
      dir: 'src/__Solution__.Adapters.Web',
      layer: 'Adapters',
      solutionFolder: '3-Adapters',
      when: (options) => options.hasWebApi,
    },
    {
      name: '__Solution__.Adapters.Blazor',
      dir: 'src/__Solution__.Adapters.Blazor',
      layer: 'Adapters',
      solutionFolder: '3-Adapters',
      when: (options) => options.hasBlazor,
    },
    {
      name: '__Solution__.UnitTests',
      dir: 'tests/__Solution__.UnitTests',
      layer: 'Tests',
      solutionFolder: '4-Tests',
      when: (options) => options.includeTests,
    },
  ],

  includeFile: makeIncludeFile([
    { prefix: 'src/__Solution__.Adapters.Web', when: (options) => options.hasWebApi },
    { prefix: 'src/__Solution__.Adapters.Blazor', when: (options) => options.hasBlazor },
    { prefix: 'tests', when: (options) => options.includeTests },
  ]),
};
