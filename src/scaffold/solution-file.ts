/**
 * Emisor del archivo .sln clásico (Format Version 12.00), el que entienden `dotnet`, MSBuild,
 * Visual Studio y Rider.
 *
 * Se genera a mano en vez de invocar `dotnet sln add` por tres motivos:
 *  - no depende de que el SDK esté instalado para *generar* la solución,
 *  - es instantáneo (no arranca MSBuild una vez por proyecto),
 *  - permite crear carpetas de solución, que `dotnet sln` no expone.
 */
import type { GeneratedProject } from '../shared/scaffold-types.js';
import { deterministicGuid } from './naming.js';

/** GUID de tipo de proyecto C# SDK-style. */
const CSHARP_SDK_PROJECT_TYPE = '9A19103F-16F7-4668-BE54-9A1E7A4F7556';

/** GUID de tipo "carpeta de solución". */
const SOLUTION_FOLDER_TYPE = '2150E333-8FDC-42A3-9474-1A3956D46DE8';

const CONFIGURATIONS = ['Debug', 'Release'] as const;

export interface SolutionProjectEntry extends GeneratedProject {
  solutionFolder: string;
}

export function renderSolutionFile(solutionName: string, projects: SolutionProjectEntry[]): string {
  const lines: string[] = [];
  const folders = [...new Set(projects.map((p) => p.solutionFolder))].sort();
  const folderGuids = new Map(
    folders.map((folder) => [folder, deterministicGuid(`${solutionName}::folder::${folder}`)]),
  );

  lines.push('Microsoft Visual Studio Solution File, Format Version 12.00');
  lines.push('# Visual Studio Version 17');
  lines.push('VisualStudioVersion = 17.11.35222.181');
  lines.push('MinimumVisualStudioVersion = 10.0.40219.1');

  for (const folder of folders) {
    const guid = folderGuids.get(folder)!;
    lines.push(
      `Project("{${SOLUTION_FOLDER_TYPE}}") = "${folder}", "${folder}", "{${guid}}"`,
      'EndProject',
    );
  }

  for (const project of projects) {
    const winPath = project.path.replace(/\//g, '\\');
    lines.push(
      `Project("{${CSHARP_SDK_PROJECT_TYPE}}") = "${project.name}", "${winPath}", "{${project.guid}}"`,
      'EndProject',
    );
  }

  lines.push('Global');

  lines.push('\tGlobalSection(SolutionConfigurationPlatforms) = preSolution');
  for (const configuration of CONFIGURATIONS) {
    lines.push(`\t\t${configuration}|Any CPU = ${configuration}|Any CPU`);
  }
  lines.push('\tEndGlobalSection');

  lines.push('\tGlobalSection(ProjectConfigurationPlatforms) = postSolution');
  for (const project of projects) {
    for (const configuration of CONFIGURATIONS) {
      lines.push(
        `\t\t{${project.guid}}.${configuration}|Any CPU.ActiveCfg = ${configuration}|Any CPU`,
        `\t\t{${project.guid}}.${configuration}|Any CPU.Build.0 = ${configuration}|Any CPU`,
      );
    }
  }
  lines.push('\tEndGlobalSection');

  lines.push('\tGlobalSection(SolutionProperties) = preSolution');
  lines.push('\t\tHideSolutionNode = FALSE');
  lines.push('\tEndGlobalSection');

  if (folders.length > 0) {
    lines.push('\tGlobalSection(NestedProjects) = preSolution');
    for (const project of projects) {
      const folderGuid = folderGuids.get(project.solutionFolder)!;
      lines.push(`\t\t{${project.guid}} = {${folderGuid}}`);
    }
    lines.push('\tEndGlobalSection');
  }

  lines.push('\tGlobalSection(ExtensibilityGlobals) = postSolution');
  lines.push(`\t\tSolutionGuid = {${deterministicGuid(`${solutionName}::solution`)}}`);
  lines.push('\tEndGlobalSection');

  lines.push('EndGlobal');

  // Los .sln usan CRLF por convención; MSBuild acepta ambos pero las herramientas de Windows
  // muestran el archivo mejor con CRLF.
  return `${lines.join('\r\n')}\r\n`;
}
