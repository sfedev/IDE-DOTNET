import type { Blueprint } from './types.js';
import { makeIncludeFile } from './types.js';

/**
 * Clean Architecture (Robert C. Martin).
 *
 * La regla de dependencia manda: el código fuente sólo puede apuntar hacia dentro.
 * Domain no conoce a nadie; Application conoce Domain; Infrastructure implementa los puertos de
 * Application; la presentación es la raíz de composición y es la única que ve Infrastructure.
 */
export const cleanBlueprint: Blueprint = {
  templateDir: 'clean',

  info: {
    id: 'clean',
    title: 'Clean Architecture',
    tagline: 'Cuatro capas concéntricas con la regla de dependencia hacia dentro.',
    description:
      'Solución en capas Domain / Application / Infrastructure / Presentación. El dominio no ' +
      'depende de nada, la aplicación define los puertos y la infraestructura los implementa. ' +
      'Incluye CRUD completo con Result explícito, Web API minimal y UI Blazor interactiva.',
    layers: [
      { name: 'Domain', role: 'Entidades, objetos de valor e invariantes de negocio.', dependsOn: [] },
      { name: 'Application', role: 'Casos de uso y puertos (repositorios, reloj, unidad de trabajo).', dependsOn: ['Domain'] },
      {
        name: 'Infrastructure',
        role: 'EF Core, repositorios, reloj del sistema y demás detalles reemplazables.',
        dependsOn: ['Application', 'Domain'],
      },
      {
        name: 'Presentación',
        role: 'Web API minimal y Blazor interactivo. Raíz de composición.',
        dependsOn: ['Application', 'Infrastructure'],
      },
    ],
    highlights: [
      'Regla de dependencia verificable: Domain no referencia ningún proyecto.',
      'Patrón Result en lugar de excepciones para el flujo esperado.',
      'Objeto de valor Money mapeado como owned type de EF Core.',
      'Web API minimal con OpenAPI + Scalar y ProblemDetails.',
      'Blazor interactivo consumiendo los casos de uso sin HttpClient intermedio.',
      'Pruebas xUnit del dominio y de la aplicación con dobles en memoria.',
    ],
    patterns: [
      'Regla de dependencia',
      'Puertos y adaptadores (parcial)',
      'Repository + Unit of Work',
      'Result / Either',
      'Value Object',
      'Inyección de dependencias por constructor',
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
