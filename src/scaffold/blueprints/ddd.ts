import type { Blueprint } from './types.js';
import { makeIncludeFile } from './types.js';

/**
 * Domain-Driven Design táctico + CQRS.
 *
 * La solución más completa de las tres: SharedKernel con los bloques de construcción, un agregado
 * real con invariantes y eventos de dominio, separación explícita de comandos y consultas con un
 * despachador propio (sin MediatR), pipeline de comportamientos y despacho de eventos de dominio
 * al confirmar la unidad de trabajo.
 */
export const dddBlueprint: Blueprint = {
  templateDir: 'ddd',

  info: {
    id: 'ddd',
    title: 'Domain-Driven Design + CQRS',
    tagline: 'Agregados, objetos de valor, eventos de dominio y comandos/consultas separados.',
    description:
      'Solución DDD táctica con SharedKernel (Entity, AggregateRoot, ValueObject, IDomainEvent, ' +
      'Result), un agregado con invariantes y eventos, repositorios por agregado, unidad de ' +
      'trabajo que publica los eventos al confirmar, y CQRS con despachador propio y pipeline de ' +
      'comportamientos (logging + validación). Sin MediatR: cero fricción de licencia.',
    layers: [
      {
        name: 'SharedKernel',
        role: 'Bloques de construcción tácticos reutilizables entre contextos.',
        dependsOn: [],
      },
      {
        name: 'Domain',
        role: 'Agregados, entidades, objetos de valor, eventos de dominio y especificaciones.',
        dependsOn: ['SharedKernel'],
      },
      {
        name: 'Application',
        role: 'Comandos, consultas, handlers, despachador CQRS y comportamientos transversales.',
        dependsOn: ['Domain', 'SharedKernel'],
      },
      {
        name: 'Infrastructure',
        role: 'EF Core, repositorios del agregado, unidad de trabajo y publicación de eventos.',
        dependsOn: ['Application', 'Domain'],
      },
      {
        name: 'Presentación',
        role: 'Web API minimal y Blazor. Sólo despachan comandos y consultas.',
        dependsOn: ['Application', 'Infrastructure'],
      },
    ],
    highlights: [
      'Agregado con raíz, invariantes protegidas y eventos de dominio.',
      'Objetos de valor con igualdad estructural (Money, Sku).',
      'CQRS con IDispatcher propio y registro por reflexión, sin MediatR.',
      'Pipeline de comportamientos: logging y validación antes de cada handler.',
      'Los eventos de dominio se publican al confirmar la unidad de trabajo, no antes.',
      'Repositorio por agregado, nunca por entidad interna.',
    ],
    patterns: [
      'Aggregate Root',
      'Value Object',
      'Domain Event',
      'CQRS',
      'Mediator / Dispatcher',
      'Pipeline Behavior',
      'Repository por agregado',
      'Unit of Work',
      'Specification',
      'Result / Either',
    ],
  },

  projects: [
    {
      name: '__Solution__.SharedKernel',
      dir: 'src/__Solution__.SharedKernel',
      layer: 'SharedKernel',
      solutionFolder: '0-SharedKernel',
    },
    {
      name: '__Solution__.Domain',
      dir: 'src/__Solution__.Domain',
      layer: 'Domain',
      solutionFolder: '1-Domain',
    },
    {
      name: '__Solution__.Application',
      dir: 'src/__Solution__.Application',
      layer: 'Application',
      solutionFolder: '2-Application',
    },
    {
      name: '__Solution__.Infrastructure',
      dir: 'src/__Solution__.Infrastructure',
      layer: 'Infrastructure',
      solutionFolder: '3-Infrastructure',
    },
    {
      name: '__Solution__.WebApi',
      dir: 'src/__Solution__.WebApi',
      layer: 'Presentación',
      solutionFolder: '4-Presentation',
      when: (options) => options.hasWebApi,
    },
    {
      name: '__Solution__.Blazor',
      dir: 'src/__Solution__.Blazor',
      layer: 'Presentación',
      solutionFolder: '4-Presentation',
      when: (options) => options.hasBlazor,
    },
    {
      name: '__Solution__.UnitTests',
      dir: 'tests/__Solution__.UnitTests',
      layer: 'Tests',
      solutionFolder: '5-Tests',
      when: (options) => options.includeTests,
    },
  ],

  includeFile: makeIncludeFile([
    { prefix: 'src/__Solution__.WebApi', when: (options) => options.hasWebApi },
    { prefix: 'src/__Solution__.Blazor', when: (options) => options.hasBlazor },
    { prefix: 'tests', when: (options) => options.includeTests },
  ]),
};
