# PROJECT_DEVLOG.md — DotForge IDE

Bitácora viva de desarrollo. Se actualiza **en cada iteración** del bucle de trabajo.

- **Proyecto:** DotForge IDE — distribución de IDE para C# / .NET 9+ / Blazor
- **Inicio:** 2026-08-23
- **Estado global:** 🟢 Completado — v1.3.0 empaquetada y verificada

Leyenda: `[ ]` pendiente · `[~]` en curso · `[x]` completado y **verificado con un comando**

---

## Entorno detectado (2026-08-23)

| Herramienta | Versión |
|---|---|
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| .NET SDK | 10.0.400 |
| .NET Runtime | 10.0.11 (no hay runtime 9.0 instalado) |
| Git | 2.55.0.windows.3 |
| Python | 3.12.10 |
| SO | Windows 11 Pro 10.0.26200 |
| CPU | 12 núcleos |
| Red | NuGet / npm / GitHub accesibles (HTTP 200) |

**Implicación:** las plantillas targetean `net9.0` (build OK vía targeting pack de NuGet), pero
`dotnet run` de un `net9.0` fallaría en esta máquina por falta de runtime 9.0. La suite de tests
por tanto **compila** pero no **ejecuta** los proyectos generados. Se añade el flag
`--framework net10.0` para quien tenga el runtime alineado.

---

## Roadmap por fases

### Fase 0 — Setup y documentación
- [x] F0.1 Crear `CLAUDE.md` (comandos, layout, convenciones, trampas del entorno)
- [x] F0.2 Crear `AGENTS.md` (10 sub-agentes con rol, prompt y criterio de aceptación)
- [x] F0.3 Crear `PROJECT_DEVLOG.md` con checklist por fases
- [x] F0.4 Estructura de directorios del repositorio
- [x] F0.5 `package.json`, `tsconfig.json`, `.gitignore`, `.editorconfig`
- [x] F0.6 Materializar los sub-agentes en `.claude/agents/`
- [x] F0.7 `npm install` verde

### Fase 1 — ★ Módulo de Scaffolding (generador de arquitecturas)
- [x] F1.1 Motor de plantillas (`engine.ts`): tokens, condicionales, filtros de nombre
- [x] F1.2 Modelo de blueprint + registro de arquitecturas
- [x] F1.3 Generador: resolución de rutas, escritura, `.sln`, post-proceso
- [x] F1.4 Blueprint **Clean Architecture** (Domain / Application / Infrastructure / UI)
- [x] F1.5 Blueprint **Hexagonal** (Domain / Ports / Adapters)
- [x] F1.6 Blueprint **DDD + CQRS** (Agregados, VOs, Eventos, Dispatcher, Repos)
- [x] F1.7 CRUD de ejemplo funcional en cada blueprint (entidad real + endpoints)
- [x] F1.8 UI Blazor de ejemplo (listado + alta) enlazada al backend
- [x] F1.9 `appsettings.json`, Serilog, OpenAPI/Scalar, EF Core preconfigurados
- [x] F1.10 Proyecto de tests xUnit generado por plantilla
- [x] F1.11 CLI `dotforge` headless (`list`, `new`, flags, `--json`)
- [x] F1.12 Tests: `dotnet build` real de las 3 arquitecturas

### Fase 2 — LSP / IntelliSense C#
- [x] F2.1 Adquisición de `Microsoft.CodeAnalysis.LanguageServer` desde feed `dotnet-tools`
- [x] F2.2 Fallback a OmniSharp-Roslyn
- [x] F2.3 Transporte stdio con framing `Content-Length`
- [x] F2.4 Handshake `initialize` / `initialized` + capacidades
- [x] F2.5 Puente IPC main ↔ renderer para tráfico LSP
- [x] F2.6 Adaptadores Monaco: completion, hover, signature help, definition, references
- [x] F2.7 Diagnósticos en el editor y en el panel de problemas
- [x] F2.8 Formateo y code actions
- [x] F2.9 Indicador de estado del LSP en la barra inferior

### Fase 3 — UI, branding y lenguajes
- [x] F3.1 Shell de la aplicación (activity bar, sidebar, tabs, panel, status bar)
- [x] F3.2 Tema **DotForge Purple** (oscuro) + variante clara
- [x] F3.3 Integración de Monaco con carga local del vendor
- [x] F3.4 Gramática Razor/Blazor (Monarch) + snippets
- [x] F3.5 Auto-cierre y auto-renombrado de etiquetas Razor
- [x] F3.6 Explorador visual de soluciones `.sln` / `.csproj`
- [x] F3.7 Panel visual de NuGet (buscar, instalar, actualizar, desinstalar)
- [x] F3.8 Terminal integrada
- [x] F3.9 Panel de problemas y de salida
- [x] F3.10 Wizard visual del generador de arquitecturas
- [x] F3.11 Paleta de comandos + atajos Win/macOS
- [x] F3.12 Pantalla de bienvenida con branding

### Fase 4 — Toolchain .NET y depuración
- [x] F4.1 Parser de `.sln` (clásico) y `.slnx`
- [x] F4.2 Parser de `.csproj` SDK-style
- [x] F4.3 Runner de tareas (`build`, `run`, `test`, `clean`, `restore`)
- [x] F4.4 Parseo de la salida de MSBuild a diagnósticos
- [x] F4.5 Hot Reload con `dotnet watch`
- [x] F4.6 Adquisición de NetCoreDbg (win-x64, osx-x64, osx-arm64)
- [x] F4.7 Bridge DAP: breakpoints, stepping, variables, call stack
- [x] F4.8 Registro de procesos hijo y apagado limpio

### Fase 5 — Build multiplataforma y empaquetado
- [x] F5.1 `scripts/build.mjs` con esbuild (main, preload, renderer, cli)
- [x] F5.2 Copia del vendor de Monaco
- [x] F5.3 Generador de iconos `.ico` / `.icns` / `.png` sin herramientas nativas
- [x] F5.4 `electron-builder.yml`: NSIS, portable zip, dmg, zip macOS (arm64 + x64)
- [x] F5.5 `npm run pack` (smoke test desempaquetado)
- [x] F5.6 `npm run dist:win` → artefactos reales en `/dist`
- [ ] F5.7 `npm run dist:mac` → artefactos reales en `/dist` — **bloqueado por plataforma**:
      electron-builder no puede generar `.dmg` desde Windows. Resuelto con `scripts/dist-mac.mjs`
      (mensaje accionable + salida con código 2) y con `.github/workflows/release.yml`, que lo
      construye en un runner `macos-latest`. Se completa al ejecutarse en macOS o en CI.
- [x] F5.8 `scripts/verify-dist.mjs` valida el contenido de `/dist`

### Fase 6 — QA, cierre y documentación final
- [x] F6.1 Suite de tests unitarios del motor de plantillas
- [x] F6.2 Tests de contract IPC
- [x] F6.3 Tests de seguridad (path traversal, superficie del preload)
- [x] F6.4 Test de humo de arranque de Electron
- [x] F6.5 `npm test` verde de punta a punta
- [x] F6.6 `README.md` final
- [x] F6.7 Revisión final de `CLAUDE.md`, `AGENTS.md`, `PROJECT_DEVLOG.md`

### Fase 7 — Rediseño de UI/UX
- [x] F7.1 Sistema de iconos vectoriales propio (61 piezas, rejilla 24×24, trazo 1.75)
- [x] F7.2 Galería de iconos como modo de diagnóstico (`--icons`) para revisarlos a ojo
- [x] F7.3 Paleta suave estilo Slate/Tokyo Night, sin negros puros ni blancos brillantes
- [x] F7.4 Variante clara completa con contraste AA
- [x] F7.5 Escala tipográfica y de espaciado en tokens (`--text-*`, `--leading-*`)
- [x] F7.6 Resintonizado de la sintaxis C#/Razor a un rango de saturación estrecho
- [x] F7.7 Explorador: jerarquía real solución → carpetas → proyectos → archivos
- [x] F7.8 Anidamiento inteligente de archivos (`.razor.cs`, `.razor.css`, `appsettings.*.json`, …)
- [x] F7.9 Guías de sangría con resalte del nivel activo
- [x] F7.10 Insignias de tipo de proyecto (Blazor, Web API, Lib, Tests, RCL, CLI, Job, WASM)
- [x] F7.11 Detección del tipo de proyecto en el proceso principal (SDK + contenido)
- [x] F7.12 Iconos por carpeta con significado (Controllers, Models, Services, Pages, …)
- [x] F7.13 Filtro de archivos en el explorador y "contraer todo"
- [x] F7.14 Menú contextual de proyecto con iconos y reposicionamiento dentro de la ventana
- [x] F7.15 Barra de actividad reducida a 5 herramientas + ajustes
- [x] F7.16 Barra de estado simplificada: SDK, LSP, rama de Git, problemas
- [x] F7.17 Servicio de estado de Git (rama y archivos sucios) con caché
- [x] F7.18 Panel de ajustes en la barra lateral
- [x] F7.19 Asistente de arquitecturas con tarjetas, iconos y diagrama de capas
- [x] F7.20 Iconos en pestañas del editor, panel, paleta y bienvenida
- [x] F7.21 Modos de diagnóstico `--ui=` y `--probe=` para revisar la interfaz sin ganchos en producción
- [x] F7.22 Pruebas de las reglas visuales (anidamiento, iconos, insignias, geometría SVG)
- [x] F7.23 Compilación de prueba del rediseño: artefactos Windows, verificación y arranque real

### Fase 8 — Documentación didáctica en las soluciones generadas
- [x] F8.1 Plantilla `README.md.tmpl` propia por arquitectura (clean, hexagonal, ddd)
- [x] F8.2 Introducción a la arquitectura + diagramas **Mermaid** (dependencias y flujo de una petición)
- [x] F8.3 Mapa de carpetas proyecto a proyecto con tabla "DEBE / TIENE PROHIBIDO" por capa
- [x] F8.4 Matriz de la regla de dependencia y dependencias permitidas de cada proyecto
- [x] F8.5 Guía paso a paso "cómo añadir una funcionalidad" con código real de la arquitectura
- [x] F8.6 Explicación del CRUD de ejemplo incluido, archivo por archivo
- [x] F8.7 Sección de comandos: `restore`, `build`, `test`, `run`, `watch`, `ef`, NuGet, URLs y puertos
- [x] F8.8 Antipatrones frecuentes por arquitectura y cómo evitarlos
- [x] F8.9 Contenido condicionado a las opciones del wizard (UI, base de datos, pruebas, framework)
- [x] F8.10 Aviso del README en el resultado del wizard y en la salida de la CLI
- [x] F8.11 Pruebas: estructura de las plantillas (`tests/unit`) y READMEs generados (`tests/scaffold`)

### Fase 9 — Selector de inicio y terminal asistida
- [x] F9.1 Modelo puro de perfiles de inicio (`src/shared/startup.ts`): proyectos ejecutables, perfiles, modos
- [x] F9.2 Persistencia por workspace en `userData/startup-profiles.json`
- [x] F9.3 Selector en la barra superior: desplegable de proyecto/perfil, conmutador de modo y Play/Stop
- [x] F9.4 Modal multiproyecto: casillas, orden de arranque, guardar y editar perfiles con nombre
- [x] F9.5 Orquestación del arranque del perfil activo (depuración o sin depurar con Hot Reload)
- [x] F9.6 Un canal de salida por proceso, con nombre de proyecto, estado y puerto detectado
- [x] F9.7 Motor de sugerencias de la terminal (`src/renderer/terminal-suggest.ts`)
- [x] F9.8 Sugerencias de git con ramas reales del repositorio (`git:branches`)
- [x] F9.9 Sugerencias de la CLI de .NET, incluidos compuestos y paquetes NuGet habituales
- [x] F9.10 Texto fantasma en línea y menú, aceptables con Tab o flecha derecha
- [x] F9.11 Modos de diagnóstico `--ui=startup`, `--ui=startup-dialog`, `--ui=terminal-suggest`
- [x] F9.12 Pruebas: 22 del modelo de perfiles y 38 del motor de sugerencias

---

## Decisiones técnicas (ADR corto)

### ADR-001 — Base del IDE: Electron + Monaco (no fork de VS Code, no Theia)
**Fecha:** 2026-08-23
**Contexto:** Se necesita un IDE de escritorio empaquetable para Windows y macOS, 100% open source.
**Opciones:**
- (a) Fork de VS Code (Code-OSS): máxima funcionalidad, pero el árbol pesa GB, la build tarda
  decenas de minutos, y el marketplace y las fuentes tipográficas de Microsoft no son
  redistribuibles sin trabajo de limpieza.
- (b) Eclipse Theia: buena base, pero arrastra un stack Inversify + build compleja y su modelo
  de extensión añade una capa de indirección importante para lo que se necesita aquí.
- (c) Electron + Monaco Editor + shell propio: control total, build en segundos, superficie de
  seguridad pequeña y auditable, artefactos ligeros.
**Decisión:** (c) Electron + Monaco con shell propio.
**Consecuencias:** hay que implementar a mano el cliente LSP, el bridge DAP, el explorador y los
paneles — que es exactamente el trabajo diferencial de este producto. Se pierde compatibilidad
directa con extensiones VSIX; se mitiga apuntando el registro a Open VSX para futuras versiones.

### ADR-002 — Sin MediatR en las plantillas generadas
**Fecha:** 2026-08-23
**Contexto:** El patrón CQRS del blueprint DDD necesita un despachador de comandos/consultas.
MediatR es el estándar de facto, pero pasó a licencia comercial en versiones recientes.
**Opciones:** (a) MediatR, (b) alternativa OSS de terceros, (c) despachador propio ~120 líneas.
**Decisión:** (c) `IDispatcher` propio con registro por reflexión sobre el ensamblado de Application.
**Consecuencias:** cero fricción de licencia para quien genere una solución, menos superficie de
dependencias, y el código queda didáctico. A cambio no hay pipeline behaviors de terceros:
se incluye un pipeline de comportamientos propio (logging + validación) para cubrir el caso común.

---

## Bitácora de iteraciones

### Iteración 1 — 2026-08-23 — Bootstrap
**Objetivo:** analizar el entorno y crear los documentos maestros.
**Hecho:**
- Sondeo del entorno (Node 24.19, .NET SDK 10.0.400, red OK).
- Creados `CLAUDE.md`, `AGENTS.md`, `PROJECT_DEVLOG.md`.
- Estructura de directorios creada; repositorio git inicializado.

**Errores encontrados:**
- *Síntoma:* el heredoc de bash falló con `unexpected EOF while looking for matching quote`
  al escribir un Markdown largo con comillas y backticks anidados.
  *Causa raíz:* el contenido con comillas simples desbalanceadas respecto al parser de la shell.
  *Arreglo:* usar la herramienta de escritura de archivos para documentos largos y reservar los
  heredocs para archivos cortos y sin comillas conflictivas.

**Siguiente:** cerrar la Fase 0 (`package.json`, `tsconfig.json`, `.gitignore`, agentes en
`.claude/agents/`, `npm install`) y arrancar la Fase 1.

### ADR-003 — Framework de pruebas de las plantillas: xUnit v2 + VSTest (no xUnit v3 + MTP)
**Fecha:** 2026-08-23
**Contexto:** Las soluciones generadas incluyen un proyecto de pruebas que debe ejecutarse con
`dotnet test` sin configuración adicional, tanto en SDK 9 como en SDK 10.
**Opciones:**
- (a) xUnit v3 + Microsoft.Testing.Platform: es la dirección futura del ecosistema.
- (b) xUnit v2 + VSTest (`Microsoft.NET.Test.Sdk` + `xunit.runner.visualstudio`).
**Decisión:** (b) xUnit 2.9.3 + xunit.runner.visualstudio 3.1.5 + Microsoft.NET.Test.Sdk 18.9.0.
**Consecuencias:** `dotnet test` funciona sin `global.json` ni `dotnet.config` en el SDK 10.
Cuando xUnit v3 y el orquestador MTP del SDK converjan, migrar es cambiar tres `PackageReference`
y quitar el `NoWarn` de xUnit1051. Se documenta en el README generado.

---

### Iteración 2 — 2026-08-23 — Motor de scaffolding y Clean Architecture
**Objetivo:** construir el motor de plantillas, el generador, la CLI y validar la primera
arquitectura compilando de verdad.

**Hecho:**
- Motor de plantillas estricto (`engine.ts`) con tokens, condicionales anidados y `{{else}}`.
  Un token o flag desconocido lanza error con número de línea: los typos rompen el test, no el
  `dotnet build`.
- Utilidades de nombres (`naming.ts`): validación de identificadores C#, pluralización inglesa,
  GUIDs deterministas por SHA-256 para que el `.sln` sea reproducible.
- Contexto de generación (`context.ts`) con matriz de versiones NuGet por framework.
- Emisor de `.sln` propio (`solution-file.ts`) con carpetas de solución, algo que `dotnet sln`
  no permite crear.
- Generador (`generator.ts`) y CLI `dotforge` completa.
- Blueprint **Clean Architecture** con 47 plantillas: Domain, Application, Infrastructure,
  WebApi (minimal API + OpenAPI + Scalar), Blazor interactivo y pruebas unitarias.
- Build con esbuild (`scripts/build.mjs`) y utilidad de devlog (`scripts/devlog.mjs`).

**Verificado con comandos reales:**
- `dotnet build` sobre la solución generada (net9.0): **0 errores, 0 advertencias**.
- `dotnet test` sobre la solución generada (net10.0): **14/14 pruebas correctas**.

**Errores encontrados y solucionados:**
1. *Síntoma:* `build/cli.js` fallaba con `SyntaxError: Invalid or unexpected token` en la línea 2.
   *Causa raíz:* el shebang estaba a la vez en el banner de esbuild y en el fuente TypeScript,
   así que quedaba uno en la línea 2, donde ya no es válido.
   *Arreglo:* el shebang lo pone sólo el banner de la build; se eliminó del fuente.
2. *Síntoma:* `error CS1061: WebApplication no contiene MapScalarApiReference`.
   *Causa raíz:* faltaba `using Scalar.AspNetCore;` en la plantilla de `Program.cs`.
   *Arreglo:* añadido. Cubierto por el test de build de la arquitectura.
3. *Síntoma:* `error CS0103: El nombre 'InteractiveServer' no existe en el contexto actual`
   al compilar `Products.razor`.
   *Causa raíz:* `@rendermode InteractiveServer` necesita
   `@using static Microsoft.AspNetCore.Components.Web.RenderMode` en `_Imports.razor`.
   *Arreglo:* añadido al `_Imports.razor` generado.
4. *Síntoma:* `dotnet test` fallaba con "Testing with VSTest target is no longer supported by
   Microsoft.Testing.Platform on .NET 10 SDK".
   *Causa raíz:* xUnit v3 arrastra Microsoft.Testing.Platform, y el SDK 10 exige un opt-in
   explícito. Ni `dotnet.config` ni `TestingPlatformDotnetTestSupport` lo resolvieron; con
   `global.json` sí arrancaba el runner pero descubría 0 pruebas, aunque el ejecutable de test
   lanzado a mano sí ejecutaba las 14.
   *Arreglo:* ADR-003, volver a xUnit v2 + VSTest. Verificado: 14/14 con `dotnet test`.
5. *Síntoma:* comandos de shell largos fallaban con `unexpected EOF while looking for matching
   quote` al escribir plantillas con heredocs.
   *Causa raíz:* el comando se trunca por encima de ~10 KB, dejando el heredoc sin cerrar.
   *Arreglo:* escribir las plantillas en lotes de menos de ~8 KB. Regla añadida a `CLAUDE.md`.

**Siguiente:** blueprints Hexagonal y DDD + CQRS, y la suite de tests automatizada que compila
las tres arquitecturas.

---

### Iteración 3 — 2026-08-23 — Hexagonal, DDD+CQRS y suite de pruebas
**Objetivo:** completar las tres arquitecturas y montar la suite automatizada que las verifica.

**Hecho:**
- Blueprint **Hexagonal**: Domain (núcleo puro), Ports (puertos de entrada/salida + servicios de
  aplicación) y Adapters (persistencia EF Core, notificaciones, Web API y Blazor).
- Blueprint **DDD + CQRS**: SharedKernel (Entity, AggregateRoot, ValueObject, IDomainEvent,
  Result), agregado con invariantes y eventos, despachador CQRS propio con envoltorios genéricos
  cacheados, pipeline de comportamientos (logging + validación), publicación de eventos de dominio
  al confirmar la unidad de trabajo.
- Suite de pruebas con el runner nativo de Node (`node --test`), sin dependencias añadidas:
  `tests/unit/` (motor, nombres, blueprints, .sln) y `tests/scaffold/` (build real + runtime).
- `scripts/run-tests.mjs` con grupos y `--filter`.

**Verificado con comandos reales:**
- `node --test tests/unit/*` → **106 pruebas, 0 fallos**.
- Matriz de scaffolding (6 combinaciones × 3 arquitecturas) → `dotnet build`
  **0 errores y 0 advertencias en las 6**.
- `dotnet test` sobre las 3 arquitecturas generadas en net10.0 → **todas correctas**.
- Prueba de humo en runtime: la Web API generada arranca y responde 201/409/400/404/204,
  filtra por búsqueda y publica su documento OpenAPI.

**Errores encontrados y solucionados:**
6. *Síntoma:* `toCamelCase('URLBuilder')` devolvía `urLBuilder`.
   *Causa raíz:* el cálculo `run.length - 1` sobraba: el lookahead del regex ya excluye del
   acrónimo la mayúscula que abre la siguiente palabra.
   *Arreglo:* minusculizar el run completo. Test de regresión en `tests/unit/naming.test.mjs`.
7. *Síntoma:* con `--db inmemory` fallaba el build con `CS1061: EntityTypeBuilder<T> no contiene
   ToTable / HasColumnName` en las tres arquitecturas.
   *Causa raíz:* `ToTable` y `HasColumnName` son API relacional; el paquete
   `Microsoft.EntityFrameworkCore.InMemory` no arrastra `Microsoft.EntityFrameworkCore.Relational`,
   que sí llega de forma transitiva con el proveedor SQLite.
   *Arreglo:* referenciar `Microsoft.EntityFrameworkCore.Relational` explícitamente en el proyecto
   de persistencia de las tres arquitecturas, para que el mapeo sea idéntico con ambos proveedores.
   Verificado además en runtime: la app con InMemory arranca y sirve el CRUD.
   *Cómo se detectó:* la matriz de la suite incluye combinaciones con `inmemory`. Sin esa
   combinación el fallo habría llegado al usuario final.
8. *Síntoma:* `_Imports.razor` del adaptador Blazor hexagonal emitía `warning CS0105` (using
   duplicado).
   *Causa raíz:* dos namespaces distintos de la plantilla Clean colapsaron al mismo namespace al
   adaptarla a Hexagonal.
   *Arreglo:* deduplicación del archivo. El test de build exige **0 advertencias**, no sólo 0 errores.
9. *Síntoma:* la prueba de humo fallaba con `Body is unusable: Body has already been read`.
   *Causa raíz:* leer el cuerpo de la respuesta con `.text()` en el mensaje de aserción y luego
   con `.json()`; el stream de `fetch` sólo se puede consumir una vez.
   *Arreglo:* leer una vez como texto y parsear a mano.

**Nota:** un 500 durante una prueba manual con `curl` resultó ser culpa del propio `curl`, que
enviaba el acento de "Periféricos" en Latin-1 en lugar de UTF-8, no del código generado.

**Siguiente:** el IDE en sí — shell de Electron, Monaco, cliente LSP, explorador de soluciones,
panel NuGet, wizard visual y empaquetado multiplataforma.

---

### ADR-004 — Terminal sin pseudoterminal, y lista blanca de programas
**Fecha:** 2026-08-23
**Contexto:** El IDE necesita una terminal integrada, pero un PTY real requiere `node-pty`, una
dependencia nativa.
**Opciones:**
- (a) `node-pty`: terminal completa, pero obliga a un paso de rebuild por plataforma y arquitectura,
  rompe la reproducibilidad del empaquetado y añade una dependencia binaria al instalador.
- (b) Ejecutor de comandos con `spawn` y `shell: false`: sin PTY, pero sin dependencias nativas.
**Decisión:** (b), con troceado propio de la línea en argv y lista blanca de programas
(`dotnet`, `git`, `npm`, …).
**Consecuencias:** cubre el flujo .NET real (compilar, `git status`, `npm ci`) y es inmune a la
inyección de comandos, porque los metacaracteres nunca llegan a un shell. No sirve para programas
interactivos; se dice explícitamente en la propia terminal y en el README.

### ADR-005 — F5 depura; ejecutar sin depurar es un comando aparte
**Fecha:** 2026-08-23
**Contexto:** F5 estaba mapeado a `dotnet run`. Al implementar NetCoreDbg había que decidir qué
hace F5.
**Decisión:** F5 inicia la depuración (como en Visual Studio y VS Code), `Ctrl+F5` inicia con Hot
Reload y "Ejecutar sin depurar" queda como comando de la paleta.
**Consecuencias:** el atajo hace lo que espera cualquiera que venga de Visual Studio. Depurar exige
haber compilado antes; si no, el error dice exactamente qué comando ejecutar.

---

### Iteración 4 — 2026-08-23 — El IDE: shell, LSP, herramientas .NET y depuración
**Objetivo:** construir el IDE completo alrededor del generador.

**Hecho:**
- Shell de Electron con la configuración de seguridad completa (aislamiento de contexto, sin
  integración de Node, CSP sin `eval` ni orígenes remotos, permisos denegados, navegación externa
  bloqueada) y apagado que no deja procesos huérfanos.
- Contrato IPC único y auditable en `src/shared/contracts.ts`; el preload no expone `ipcRenderer`.
- Cliente LSP con framing `Content-Length`, handshake completo y 10 proveedores de Monaco.
  Adquisición automática de `Microsoft.CodeAnalysis.LanguageServer` desde el feed `dotnet-tools`,
  con OmniSharp de respaldo.
- Decodificador ZIP propio en Node puro (directorio central, ZIP64, protección zip-slip) para no
  añadir dependencias al descargar el toolchain.
- Gramática Razor/Blazor, auto-cierre de etiquetas y 13 snippets.
- Explorador de soluciones (`.sln`, `.slnx`, `.csproj`, `Directory.Build.props`), panel NuGet,
  runner de tareas con diagnósticos clicables, terminal integrada y asistente visual.
- Depuración completa con NetCoreDbg: breakpoints en el margen, pila, variables, evaluación y pasos.
- Iconos multirresolución generados por código (codificador PNG, ICO e ICNS propios).
- Empaquetado con electron-builder y workflow de CI para los artefactos de macOS.

**Verificado con comandos reales:**
- `npm test` → **298 pruebas, 0 fallos** en los cuatro grupos.
- `npx electron . --smoke-test` → SMOKE_OK, incluida la tokenización real de Razor en el renderer.
- `npm run dist:win` → instalador NSIS de 117,2 MB y portable de 161,5 MB, verificados.
- La app **empaquetada** pasa el smoke test y sus plantillas generan una solución hexagonal que
  compila con 0 errores y 0 advertencias.
- Depuración real: breakpoint alcanzado, `i == 1`, `contador == 0`, continuar → `i == 2`.
- Descarga real del toolchain: Roslyn LanguageServer y NetCoreDbg extraídos con el ZIP propio.

**Errores encontrados y solucionados:**
10. *Síntoma:* toda la gramática Razor devolvía `text` — ninguna directiva se reconocía.
    *Causa raíz:* en Monarch, `@@` dentro de una expresión regular es el **escape de una sola
    arroba**. La regla `[/@@/, 'text']`, pensada para la arroba literal de Razor (`a@@b`), compilaba
    a `/^(?:@)/` y se comía el `@` de toda directiva antes de que se evaluara su regla.
    *Cómo se encontró:* volcando las reglas compiladas con el compilador Monarch invocado desde
    Node, tras comprobar que la gramática compilaba pero no casaba.
    *Arreglo:* `[/@@@@/, 'text']`. Cubierto por el smoke test, que tokeniza `correo@@ejemplo.com`.
11. *Síntoma:* `{ cases: ... }` dentro de la acción de un grupo compilaba pero no resolvía en
    ejecución.
    *Arreglo:* alternación generada desde un atributo **string** (`directivesPattern`). Monarch
    exige que una referencia `@atributo` dentro de un regex apunte a una cadena, no a un array;
    el compilador lo dice con un mensaje claro que sólo se ve invocándolo directamente.
12. *Síntoma:* al abrir una solución, la barra lateral mostraba el panel NuGet aunque el icono
    activo fuera el del explorador.
    *Causa raíz:* ambas vistas escribían en el mismo contenedor al recibir la solución y ganaba la
    última.
    *Arreglo:* cada vista tiene un flag `visible` y sólo pinta si está activa.
13. *Síntoma:* abrir un archivo por línea de comandos no lo abría en el editor.
    *Causa raíz:* el evento se emitía en `did-finish-load`, antes de que el renderer terminara de
    arrancar (Monaco tarda), así que no había nadie escuchando.
    *Arreglo:* sustituir el evento por una consulta (`workspace:pending-file`) que el renderer hace
    cuando ya está listo. Además, la raíz del workspace pasa a ser la carpeta de la solución más
    cercana, no la del archivo.
14. *Síntoma:* el explorador mostraba todos los proyectos sin target framework.
    *Causa raíz:* las soluciones generadas declaran `TargetFramework` en `Directory.Build.props`,
    no en cada `.csproj`.
    *Arreglo:* `readInheritedProperties` sube buscando el `Directory.Build.props` más cercano.
    Lo detectó una prueba unitaria que parsea una solución generada por el propio scaffolder.
15. *Síntoma:* la adquisición del servidor de lenguaje bajaba una versión antigua (4.8.0 en vez de
    5.4.0).
    *Causa raíz:* el feed devuelve las versiones en orden descendente y el código cogía la última.
    *Arreglo:* `pickLatestVersion`, que compara segmentos numéricos. Con casos de prueba.
16. *Síntoma:* un acelerador de menú con un carácter no ASCII se aceptaba en la configuración pero
    Electron lo rechazaba en ejecución, dejando el atajo muerto.
    *Arreglo:* `Ctrl+J` para la terminal, y una aserción en el smoke test que falla si Electron
    vuelve a quejarse de un acelerador.

**Estado final:** 60/63 tareas del roadmap. La única pendiente real es F5.7 (artefactos de macOS),
bloqueada por plataforma y resuelta mediante el workflow de CI incluido.

---

### ADR-006 — Sistema de iconos propio en vez de una librería
**Fecha:** 2026-08-23
**Contexto:** La interfaz usaba glifos de texto (`⬡`, `🗀`, `C#`, `@`) como iconos. Se renderizan
distinto en cada sistema, no heredan el color, no se alinean con el texto y algunos son emoji a
todo color que rompen la coherencia visual.
**Opciones:**
- (a) Lucide / Phosphor como dependencia: cientos de iconos, licencia permisiva, cero trabajo.
- (b) Un set propio dibujado sobre la misma rejilla y con el mismo lenguaje visual.
**Decisión:** (b), 61 iconos en `src/renderer/icons.ts`, rejilla 24×24, trazo 1.75, extremos
redondeados, todo heredando `currentColor`.
**Consecuencias:** cero dependencias nuevas y control total sobre las piezas que no existen en
ningún set genérico (la almohadilla de C#, la arroba de Razor, la caja de proyecto .csproj). A
cambio, hay que dibujarlos y revisarlos: por eso existe el modo `--icons`, que los pinta todos a
varios tamaños, y las pruebas que validan la geometría de cada ruta.

### ADR-007 — Barra de estado neutra en vez de una banda de acento
**Fecha:** 2026-08-23
**Contexto:** La barra de estado era una banda violeta saturada a todo lo ancho de la ventana.
**Decisión:** superficie neutra (`--bg-deep`) con el color reservado para lo que reclama atención:
errores en rojo, tarea en curso en ámbar, servidor de lenguaje listo en verde.
**Consecuencias:** el acento vuelve a significar algo. Cuando todo va bien, la barra desaparece
del campo de visión, que es exactamente lo que debe hacer.

### ADR-008 — Anidamiento de archivos que agrupa, nunca oculta
**Fecha:** 2026-08-23
**Contexto:** Una solución Blazor genera tres archivos por componente (`Home.razor`,
`Home.razor.cs`, `Home.razor.css`) y varios `appsettings.<Entorno>.json`. El árbol se llena de
filas que nadie busca.
**Decisión:** los archivos satélite se agrupan bajo su archivo principal, con una regla explícita
por patrón (`nestingParentsOf`).
**Consecuencias:** el árbol de un proyecto Blazor pierde alrededor de un tercio de sus filas. La
regla dura es que **si el padre no existe, el hijo se queda como raíz**: agrupar nunca puede
hacer que un archivo desaparezca. Hay un test dedicado a esa invariante y otro que comprueba que
la suma de nodos raíz e hijos es siempre igual al número de archivos de entrada.

---

### Iteración 5 — 2026-08-23 — Rediseño integral de UI/UX
**Objetivo:** hacer la interfaz sencilla, limpia y amable a la vista, con un árbol de soluciones
.NET realmente comprensible.

**Hecho:**
- **Iconografía.** 61 iconos vectoriales propios sustituyen a los glifos de texto. Incluyen marcas
  específicas del ecosistema (C#, Razor, solución, proyecto) y de carpetas con significado
  (Controllers, Models, Services, Pages, Components, wwwroot, Domain, Ports, Commands, Events…).
- **Color y tipografía.** Paleta suave: el fondo más oscuro es `#1b1d27` y el texto más claro
  `#c8cee2`; el violeta de .NET se lleva a un pastel `#a58cf5` y el `#512BD4` original queda sólo
  para el logotipo. Escala tipográfica y de espaciado en tokens. Sintaxis resintonizada dentro de
  un rango de saturación estrecho para que ningún color salte por encima del resto.
- **Explorador.** Jerarquía real de la solución, insignias de tipo de proyecto, guías de sangría
  con resalte del nivel activo, anidamiento de archivos satélite, filtro por nombre, "contraer
  todo", menú contextual con iconos, y el proyecto de aplicación abierto por defecto para que
  abrir una solución no cueste tres clics antes de ver código.
- **Declutter.** Barra de actividad reducida a cinco herramientas más ajustes; barra de estado con
  sólo SDK, LSP, rama de Git y problemas; el `.csproj` ya no se repite dentro de su propio
  proyecto; el target framework sólo se muestra cuando la solución mezcla varios.
- **Ajustes** como vista de la barra lateral, con efecto inmediato.
- **Asistente de arquitecturas** con tarjetas, icono por arquitectura y diagrama de capas con
  flechas, que comunica la forma de cada arquitectura mejor que cualquier párrafo.

**Verificado con comandos reales:**
- `npm test` → **359 pruebas, 0 fallos** (61 nuevas para las reglas visuales).
- `npx electron . --icons` → las 61 piezas revisadas a 16 y 24 px.
- Tema oscuro: chrome en `rgb(23, 25, 34)`. Tema claro: `rgb(232, 234, 240)`. Medido dos veces:
  con `--probe=` sobre `getComputedStyle` y leyendo los bytes del PNG capturado.

**Errores encontrados y solucionados:**
17. *Síntoma:* los nombres de proyecto salían truncados (`Acme.Shop.Sh…`).
    *Causa raíz:* la insignia y el target framework competían por el ancho con el nombre, que es
    justo lo que el usuario está leyendo.
    *Arreglo:* insignias cortas (`Lib`, `CLI`, `Job`) y el framework sólo cuando la solución
    mezcla varios; el dato completo vive en el tooltip.
18. *Síntoma:* el explorador y el panel NuGet se pintaban los dos sobre el mismo contenedor al
    cargar una solución, y ganaba el último: la barra mostraba NuGet con el icono del explorador
    activo.
    *Arreglo:* cada vista de la barra lateral tiene un flag `visible` y sólo pinta si está activa.
19. *Síntoma:* al abrir un workspace, la salida registraba dos veces "N proyectos".
    *Causa raíz:* la solución llegaba por dos caminos, la llamada directa y el evento difundido
    por el proceso principal.
    *Arreglo:* `applySolution` detecta la segunda vuelta sobre la misma solución y no repite el
    aviso ni recarga el árbol.
20. *Síntoma:* el indicador del SDK no aparecía en la barra de estado.
    *Causa raíz:* un heredoc de shell se comió los backslashes de una expresión regular y
    `/^(\d+\.\d+)/` quedó como `/^(d+.d+)/`.
    *Arreglo:* corregida con edición directa del archivo. Es la tercera vez que un heredoc largo
    corrompe escapes; la regla ya está en `CLAUDE.md`.
21. *Síntoma:* el diagrama de capas del asistente dejaba una flecha suelta al final de línea
    cuando las capas se envolvían.
    *Arreglo:* cada capa viaja en el mismo grupo que su flecha.
22. *Síntoma:* dos iconos dibujados a mano (`hammer` y `tool`) eran ilegibles a 16 px.
    *Cómo se encontró:* la galería `--icons`, que es justamente para esto.
    *Arreglo:* rediseñados; el martillo pasó a cabeza inclinada y mango, y la llave inglesa a una
    silueta cerrada.

**Nota sobre el método:** varias capturas del tema claro parecían mostrar el chrome oscuro sobre
contenido claro, lo que apuntaba a un fallo del tema. Dos medidas independientes dicen lo
contrario: `--probe=` devuelve `rgb(232, 234, 240)` para la barra de título y la de estado, y
`scripts/read-pixels.mjs`, que decodifica el PNG y lee los bytes, devuelve exactamente el mismo
valor en esas coordenadas. El archivo es correcto; lo que engañaba era el visor. De ahí salieron
`--probe=`, `--ui=` y el lector de píxeles: un color se mide, no se mira.

**Cierre de la iteración — hallazgos de la compilación de prueba:**
23. *Síntoma:* la lista de recientes mostraba dos entradas idénticas, `Acme.Shop` con la ruta
    `C:\Users\Sergio\AppData\Local\Te…` repetida.
    *Causa raíz:* no era un duplicado. Eran dos soluciones distintas con el mismo nombre en
    carpetas distintas, y el recorte por el final borraba justo la parte que las distingue.
    *Arreglo:* la entrada muestra ahora las dos carpetas contenedoras (`…\scratchpad\final` frente
    a `…\Temp\dfdemo`) y la ruta completa vive en el tooltip. La función vive en
    `src/renderer/paths.ts`, fuera del DOM, y tiene sus propias pruebas.
24. *Síntoma:* el muestreo de píxeles de `--screenshot=` informaba de un color de barra de estado
    que no correspondía a ningún token.
    *Causa raíz:* las coordenadas de muestreo estaban fijas en el código y caían fuera del lienzo
    capturado; el recorte devolvía un píxel que no era de nadie.
    *Arreglo:* las coordenadas se derivan del tamaño real de la imagen. Confirmado contra
    `getComputedStyle`: las cuatro zonas coinciden ahora con sus tokens.

**Compilación de prueba final:** `npm run icons`, `npm run dist:win`, `verify-dist.mjs --require win`
y arranque real del ejecutable empaquetado (`SMOKE_OK`). Capturas regeneradas desde el binario y
desde el código con el mismo resultado.

### ADR-009 — La versión se declara una sola vez, en `package.json`
**Fecha:** 2026-08-23
**Contexto:** El número `1.0.0` estaba escrito a mano en cuatro sitios: el CLI, el `clientInfo` que
el cliente LSP envía en el handshake, el manifiesto `dotforge.json` de cada solución generada y el
propio `package.json`. Al subir a 1.1.0 se vio el problema: basta olvidar uno para que el IDE diga
una versión, el instalador otra y el manifiesto una tercera.
**Decisión:** `package.json` es la única fuente. `scripts/build.mjs` inyecta el valor como constante
de compilación (`define` de esbuild) y `src/shared/version.ts` lo expone como `APP_VERSION`, con un
`0.0.0-dev` de reserva por si alguien ejecuta el código sin pasar por el build.
**Consecuencias:** `npm version` ya basta para cambiarla en todas partes. El coste es que la versión
sólo es correcta en el código compilado, no leyendo el fuente, que es un intercambio razonable
porque el producto siempre se ejecuta compilado.

---

### Iteración 6 — 2026-08-23 — v1.1.0
El rediseño de UI/UX añade funcionalidad —vista de ajustes, anidamiento de archivos, sistema de
iconos, estado de Git en la barra inferior, modos de diagnóstico `--icons`, `--ui=` y `--probe=`—,
así que por semver le corresponde subir el segundo número, no el tercero: 1.0.0 → **1.1.0**.

**Hecho:**
- Versión centralizada (ADR-009) y `1.1.0` en `package.json`.
- Artefactos regenerados: los nombres los compone electron-builder con `${version}`, así que pasan
  a `DotForge IDE-1.1.0-*` sin tocar `electron-builder.yml`.
- Referencias actualizadas en `README.md` y en la cabecera de esta bitácora.

**Verificado:** `node build/cli.js --version` → `1.1.0`; los tres bundles (`cli`, `scaffold`, `main`)
contienen el literal inyectado; `npm test` en verde; `verify-dist` reconoce los artefactos nuevos.

### ADR-010 — El README didáctico es una plantilla por arquitectura, no texto generado en código
**Fecha:** 2026-08-23
**Contexto:** Cada solución generada debe llevar un `README.md` extenso que enseñe la arquitectura
elegida. Había tres formas de producirlo.
**Opciones:**
- (a) Componerlo en TypeScript a partir de `BlueprintInfo` (capas, patrones, highlights): una sola
  implementación, pero el texto queda troceado en literales dentro del código y las tres
  arquitecturas acaban compartiendo una prosa genérica que no enseña nada concreto.
- (b) Un `README.md.tmpl` común en `_common/` con condicionales por `isClean` / `isHexagonal` /
  `isDdd`: un único archivo de 2.000 líneas donde el 80% del contenido está dentro de un
  condicional. Ilegible y muy fácil de romper.
- (c) Un `README.md.tmpl` por arquitectura, junto a las plantillas de código que documenta.
**Decisión:** (c). El README vive en `src/scaffold/templates/<arquitectura>/README.md.tmpl`.
**Consecuencias:** el documento puede hablar de archivos, clases y namespaces reales de esa
arquitectura —`IManage{{EntityPlural}}` en hexagonal, `IDispatcher` en DDD, `I{{Entity}}Service` en
clean—, que es justo lo que lo hace didáctico. A cambio hay contenido repetido entre los tres
(sección de comandos, gestión de paquetes), que se acepta: son tres documentos independientes y
cada uno debe poder leerse solo. La coherencia entre ellos la vigilan las pruebas de
`tests/unit/blueprints.test.mjs`, que exigen las mismas seis secciones en los tres.

### ADR-011 — Los diagramas se escriben en Mermaid, no en ASCII ni como imagen
**Fecha:** 2026-08-23
**Contexto:** El README necesita un diagrama de dependencias entre capas y otro del recorrido de
una petición.
**Opciones:** (a) ASCII art, (b) una imagen SVG/PNG generada, (c) Mermaid embebido en el Markdown.
**Decisión:** (c) Mermaid. Lo renderizan GitHub, GitLab, Azure DevOps y los previsualizadores de
Markdown más habituales; sigue siendo legible como texto plano si no hay renderizador; y viaja
dentro del propio archivo, sin binarios que versionar.
**Consecuencias:** hay una trampa que documentar (ver la bitácora de la iteración 7): la forma
hexagonal de Mermaid se escribe con dobles llaves, que es exactamente la sintaxis de token del
motor de plantillas. Las plantillas no pueden usar esa forma de nodo, y hay una prueba que lo
comprueba.

---

### Iteración 7 — 2026-08-23 — README didáctico por arquitectura
**Objetivo:** que toda solución generada por el wizard lleve en su raíz un `README.md` que enseñe
la arquitectura elegida: qué es, qué código va en cada capa, qué código tiene prohibido estar ahí,
cómo añadir una funcionalidad paso a paso, qué trae el ejemplo incluido y con qué comandos se
compila, se prueba y se ejecuta.

**Hecho:**
- Tres plantillas nuevas: `templates/clean/README.md.tmpl` (780 líneas),
  `templates/hexagonal/README.md.tmpl` (734) y `templates/ddd/README.md.tmpl` (863). Se emiten como
  cualquier otra plantilla, así que el filtro `includeFile` y el motor de condicionales funcionan
  sin tocar el generador.
- Seis secciones fijas en las tres: introducción y diagramas, estructura y responsabilidades, guía
  paso a paso, ejemplo incluido, comandos, y antipatrones.
- Dos diagramas Mermaid por arquitectura: uno de dependencias entre proyectos (con los proyectos de
  presentación condicionados a lo que el usuario haya pedido) y una secuencia del recorrido de una
  petición de alta, desde el cliente hasta la base de datos.
- Tabla "✅ DEBE estar aquí / ❌ TIENE PROHIBIDO estar aquí" por cada proyecto, más la matriz
  completa de la regla de dependencia y las dependencias permitidas de cada uno.
- Guía paso a paso con un caso de uso real y distinto en cada arquitectura, con el código C# que
  hay que escribir en cada paso: descatalogar la entidad de ejemplo (clean y DDD, este último con evento de
  dominio) y reservar unidades (hexagonal, con puerto de salida nuevo). Termina en una checklist.
- Todo el contenido está condicionado a las opciones del wizard: presentación (`hasWebApi`,
  `hasBlazor`, `hasBoth`), pruebas (`hasTests`), base de datos (`useSqlite`, `useInMemory`) y
  framework. Una solución sólo API no documenta Blazor, y una sin pruebas no habla de `dotnet test`.
- Los puertos reales de la solución (`ApiHttpsPort`, `BlazorHttpsPort`) aparecen en las URLs, así
  que las direcciones del README son las que de verdad abre `dotnet run`.
- El resultado del wizard (`src/renderer/views/wizard.ts`) y la salida de la CLI
  (`src/cli/index.ts`) avisan de que el README existe y qué contiene.
- Pruebas nuevas: 15 en `tests/unit/blueprints.test.mjs` (secciones obligatorias, diagramas,
  reglas de dependencia, pasos de la guía, comandos) y una por cada caso de la matriz en
  `tests/scaffold/scaffold-build.test.mjs`, que valida el README **generado**: dos diagramas
  Mermaid, secciones, coherencia con las opciones y que no documente un proyecto que no existe.

**Errores encontrados:**
- *Síntoma:* el árbol de carpetas del README salía descuadrado: los comentarios estaban alineados
  en columna y, al sustituir `{{Solution}}` por `Ac.Shop` y `{{Entity}}` por `Product`, cada línea
  cambiaba de ancho.
  *Causa raíz:* alinear con espacios asume un ancho que sólo se conoce en tiempo de render.
  *Arreglo:* el comentario se separa con ` — ` en vez de con una columna de espacios. Nunca se
  descuadra, sea cual sea el nombre de la solución.
- *Síntoma:* líneas en blanco sueltas dentro del árbol, justo antes de cada proyecto opcional.
  *Causa raíz:* una línea que sólo contiene `{{#if}}` deja su salto de línea al desaparecer, y las
  líneas de relleno `│   │` del árbol se sumaban a ese hueco.
  *Arreglo:* las líneas de relleno se dejan vacías y `normalizeOutput` colapsa los saltos
  sobrantes; el hueco pasa a ser un separador visual coherente entre proyectos.
- *Síntoma:* la herramienta de escritura guardó las tres plantillas en CRLF, contra la convención
  del repositorio (LF). *Arreglo:* normalizadas con `tr -d '\r'` y verificadas leyendo los bytes,
  no confiando en `grep`. Es la trampa ya documentada en `CLAUDE.md`; ha vuelto a aparecer.
- *Síntoma:* con `--ui blazor`, el encabezado del README anunciaba la ruta `/api/products` y el
  diagrama de secuencia empezaba con un `POST` HTTP, en una solución sin Web API.
  *Causa raíz:* dos frases sueltas fuera de los condicionales de presentación.
  *Arreglo:* condicionadas; ahora esa variante habla de la página `/products`. La prueba de la
  matriz comprueba que el README no mencione ningún proyecto que no se haya generado.
- *Trampa nueva (anotada en `CLAUDE.md`):* en Mermaid, `A{{Texto}}` es un nodo hexagonal, y el
  motor de plantillas lo interpretaría como un token. Las plantillas no pueden usar esa forma de
  nodo; hay una prueba que lo verifica.

**Verificado:** `npm run build` (157 plantillas), `npm test` en verde de punta a punta, y
generación real de las tres arquitecturas más las variantes `--ui webapi --no-tests --db inmemory`
y `--ui blazor`, revisando el Markdown resultante.

### Iteración 8 — 2026-08-23 — v1.2.0
El README didáctico es funcionalidad nueva de las soluciones generadas y no rompe nada de lo
anterior, así que por semver le corresponde el segundo número: 1.1.0 → **1.2.0**.

**Hecho:**
- `1.2.0` en `package.json`, que por ADR-009 es la única fuente: los bundles reciben el valor por
  `define` de esbuild y el manifiesto `dotforge.json` de cada solución lo hereda.
- Nombres de artefacto actualizados en `README.md` (electron-builder los compone con `${version}`,
  así que `electron-builder.yml` no se toca).

**Verificado:** `node build/cli.js --version` → `1.2.0`; el literal inyectado aparece en los
bundles `cli`, `scaffold` y `main`; `npm test` en verde.

### Iteración 9 — 2026-08-23 — `dist/` se poda sola entre versiones
**Síntoma:** tras `npm run dist:win` con la 1.2.0, `/dist` contenía los artefactos de la 1.1.0 y
los de la 1.2.0 a la vez: 279 MB de instaladores viejos y dos `.exe` parecidos donde es fácil
subir el que no era.

**Causa raíz:** `artifactName` incluye `${version}`, así que cada release escribe archivos con
nombre nuevo, y electron-builder no limpia su directorio de salida: sólo reescribe lo que vuelve
a generar con el mismo nombre (`win-unpacked`, `builder-*.yml`).

**Opciones consideradas:**
- (a) Borrar `/dist` entera antes de empaquetar. Se descarta: `dist:win` y `dist:mac` se ejecutan
  por separado —y en máquinas distintas—, así que el segundo se llevaría por delante lo del
  primero. Y `dist:all` tendría el mismo problema entre sus dos mitades.
- (b) Quitar `${version}` del nombre de artefacto. Se descarta: se pierde la trazabilidad de qué
  instalador es cuál, que es justo lo que evita subir el equivocado.
- (c) Podar sólo lo que lleve un sello de versión distinto del actual. **Elegida.**

**Hecho:**
- `scripts/lib/dist-artifacts.mjs`: la regla, como función pura y probable sin tocar disco.
- `scripts/prune-dist.mjs`: recorre `dist/`, informa de tamaño y borra. Acepta `--dry-run`.
- `pack`, `dist:win`, `dist:mac` y `dist:all` lo ejecutan **antes** de empaquetar; hay una prueba
  que verifica ese orden, porque al revés borraría lo que se acaba de construir.
- Expuesto también como `npm run prune:dist`, documentado en `CLAUDE.md` y en `README.md`.
- 7 pruebas nuevas en `tests/package/packaging.test.mjs`.

**Decisión que conviene recordar:** la regla es deliberadamente conservadora. Un archivo cuyo
nombre contiene el sello de la versión actual **nunca** se borra, aunque sea una preliberación
(`1.2.0-beta.1` estando en la `1.2.0` sobrevive). Distinguir ese caso exigiría mantener una lista
de sufijos de destino (`win`, `mac`, `arm64`, `Setup`, …) y acertar siempre: equivocarse borraría
el instalador recién compilado. Dejar basura es recuperable; borrar el artefacto bueno, no.

**Verificado:** `node scripts/prune-dist.mjs --dry-run` sobre el `dist/` real listó exactamente los
tres archivos de la 1.1.0; la ejecución liberó 278.8 MB y dejó intactos los de la 1.2.0,
`win-unpacked` y los `builder-*.yml`. `npm run test:package` en verde (57 pruebas).

### Iteración 10 — 2026-08-23 — Depurar aplicaba Production: el perfil de arranque se ignoraba
**Síntoma:** al depurar (F5) una solución hexagonal con UI Blazor, el log decía
`Hosting environment: Production`, `Now listening on: http://localhost:5000`, `The WebRootPath was
not found: ...\bin\Debug\net10.0\wwwroot` y repetía en cada petición `Static Web Assets are not
enabled`. Con `Ejecutar` (que es `dotnet run --project`) no pasaba.

**Causa raíz:** dos problemas distintos que se manifestaban juntos.
1. `dotnet run` aplica el perfil de `Properties/launchSettings.json`; el depurador no. El
   controlador lanzaba el `.dll` con `cwd = bin/Debug/<tfm>` y **sin ninguna variable de entorno**,
   así que ASP.NET asumía Production: puerto 5000 en vez de los del perfil, y sin los static web
   assets, que sólo se activan solos en Development. `DebugSession` ya aceptaba `env` en la
   petición `launch` de DAP; simplemente nadie lo rellenaba.
2. La plantilla Blazor no traía favicon, así que cada carga de página dejaba un `404 /favicon.ico`
   en el log. Eso no dependía del entorno.

**Hecho:**
- `src/main/services/launch-settings.ts`: lee el perfil, elige cuál aplicar con el mismo criterio
  que Visual Studio (sólo `commandName: "Project"`; el homónimo del proyecto y si no el primero) y
  traduce `applicationUrl` a `ASPNETCORE_URLS`, que es lo que hace `dotnet run`. No lanza nunca: un
  `launchSettings.json` ausente es lo normal en una biblioteca, y uno corrupto no puede impedir
  depurar, así que se devuelve un aviso que la sesión escribe en su salida.
- `DebugTarget` lleva ahora `env`, `launchProfile` y `launchWarning`; el controlador los pasa al
  `launch` de DAP y anuncia en la consola qué perfil ha aplicado.
- Exportado por `src/main/testable.ts` para poder probarlo con Node puro.
- Plantillas Blazor (las tres arquitecturas): `favicon.svg` propio de cada arquitectura —capas
  concéntricas, hexágono, frontera de agregado— enlazado desde `App.razor`, y
  `builder.WebHost.UseStaticWebAssets()` en `Program.cs`, para que la aplicación encuentre
  `wwwroot` también cuando la lanza un depurador desde `bin/`. En una app publicada no hace nada.
- 17 pruebas nuevas en `tests/unit/launch-settings.test.mjs`, con la fixture generada por el propio
  scaffolder: así también se verifica que el `launchSettings.json` que produce es utilizable.

**Verificado sobre una solución real** (`Hx`, hexagonal + Blazor, net10.0), lanzando el binario de
`bin/Debug` igual que hace el depurador:
- Sin perfil, ya sólo con `UseStaticWebAssets()`: desaparecen los avisos de `WebRootPath` y de
  `Static Web Assets` (0 apariciones en el log), y `/favicon.svg` responde 200.
- Con el entorno del perfil (`ASPNETCORE_ENVIRONMENT=Development` + `ASPNETCORE_URLS`):
  `Hosting environment: Development`, escucha en 5355/5354 en vez de en el 5000, y desaparece
  también `Failed to determine the https port for redirect`. `/`, `/products` y `/favicon.svg`
  responden 200.
- Queda un único aviso, ajeno al IDE: el certificado de desarrollo no está confiado en la máquina.
  Se resuelve con `dotnet dev-certs https --trust`.

**Nota de método:** el `404 /favicon.ico` que aparece al pedirlo con `curl` es esperado y no se
corrige: un navegador con `<link rel="icon">` en el documento no pide `/favicon.ico`.


### ADR-012 — Una sola sesión de depuración, aunque el perfil arranque varios proyectos
**Fecha:** 2026-08-23
**Contexto:** El selector de inicio permite arrancar varios proyectos a la vez (API + UI). La
pregunta inmediata es qué significa "depurar" un perfil de tres proyectos.
**Opciones:**
- (a) Una sesión de NetCoreDbg por proyecto. Es lo que hacen Visual Studio y Rider. Obliga a un
  gestor de sesiones, a enrutar cada breakpoint a la sesión que corresponde, a decidir qué pila y
  qué variables se enseñan cuando hay dos procesos detenidos y a una UI para cambiar de sesión.
- (b) Depurar el primer proyecto del perfil y arrancar el resto sin depurador.
- (c) No permitir depuración en perfiles multiproyecto.
**Decisión:** (b). El primer proyecto del perfil se engancha al depurador; los demás arrancan con
`dotnet run`. El modal lo dice explícitamente antes de guardar el perfil, con el nombre del
proyecto que se va a depurar.
**Consecuencias:** el caso real más común —depurar la API mientras la UI corre al lado— queda
cubierto con una arquitectura que ya existe (`DebugController` tiene una `DebugSession`). A cambio,
poner un breakpoint en el segundo proyecto no detiene nada, y por eso se avisa en la interfaz en
vez de dejar que el usuario lo descubra. (a) queda como trabajo futuro: implica un
`DebugSessionManager` y un selector de sesión activa, que es una fase entera.

### ADR-013 — "Sin depurar" usa Hot Reload en las webs y `dotnet run` en el resto
**Fecha:** 2026-08-23
**Contexto:** El conmutador de la barra superior tiene dos posiciones, no tres, pero por debajo hay
tres formas de arrancar: con depurador, con `dotnet run` y con `dotnet watch`.
**Decisión:** el modo "Sin depurar" arranca los proyectos web con `dotnet watch` (Hot Reload) y los
ejecutables de consola con `dotnet run`.
**Consecuencias:** el conmutador sigue teniendo dos posiciones, que es lo que un usuario espera, y
aun así se obtiene recarga en caliente donde de verdad sirve. Recargar en caliente una aplicación
de consola reinicia el proceso a cada cambio y ensucia la salida sin aportar nada. La regla vive en
`launchPlan`, que es una función pura y está probada caso a caso.

### ADR-014 — Sugerencias por prefijo, sin fuzzy matching
**Fecha:** 2026-08-23
**Contexto:** El autocompletado de la terminal podía imitar al del editor (coincidencia difusa,
puntuación por relevancia) o comportarse como una shell.
**Decisión:** coincidencia por prefijo, con las listas ordenadas por frecuencia real de uso y sin
reordenar por puntuación.
**Consecuencias:** escribir `git st` y pulsar Tab da `git status` siempre, hoy y dentro de un mes.
Ese determinismo es lo que permite escribir sin mirar. El coste es que `gst` no encuentra
`git status`; en una terminal, donde el usuario ya sabe lo que quiere teclear, es un intercambio
razonable, y el menú sigue estando ahí para explorar.

### ADR-015 — Los perfiles se guardan en userData, no en el repositorio del usuario
**Fecha:** 2026-08-23
**Contexto:** Un perfil "Backend + Web" es configuración de solución. Podría vivir en un archivo
dentro del repositorio (como hace `.vs/` o `.idea/`) o fuera.
**Decisión:** `userData/startup-profiles.json`, con la ruta del workspace como clave.
**Consecuencias:** el IDE no crea archivos dentro del proyecto de nadie, que es la clase de cosa que
acaba en un commit ajeno o en una discusión sobre el `.gitignore`. A cambio, los perfiles no se
comparten con el equipo: para eso ya existe `launchSettings.json`, que es el mecanismo del
ecosistema y que el IDE ya lee (iteración 10). Los perfiles que apuntan a un `.csproj` que ya no
existe se limpian al cargar, así que renombrar un proyecto no deja un botón de Play roto.

---

### Iteración 11 — 2026-08-23 — Fase 9: selector de inicio y terminal asistida
**Objetivo:** cerrar la distancia con Visual Studio y Rider en las dos cosas que más se usan y que
faltaban: decidir qué se arranca desde la barra superior, y una terminal que ayude a escribir.

**Módulo 1 — Selector de inicio.**
- `src/shared/startup.ts`: modelo puro (proyecto ejecutable, perfil, modo) y las reglas que deciden
  qué se arranca y cómo. Sin dependencias, así que lo comparten el proceso principal, el renderer y
  las pruebas.
- `src/main/services/startup-service.ts`: persistencia por workspace, tolerante a archivos
  corruptos y con limpieza de proyectos desaparecidos.
- `src/renderer/views/startup-bar.ts`: el control de la barra superior —desplegable de proyectos y
  perfiles, conmutador Depurar / Sin depurar, Play y Stop— y el modal multiproyecto con casillas,
  reordenación y perfiles con nombre.
- Canales de salida por proceso en `panel.ts`: cada proyecto arrancado tiene su pestaña con su
  nombre, un punto de estado y el puerto en el que escucha, clicable para abrirlo.
- Contratos nuevos: `startup:get`, `startup:save`, `git:branches` y `label` en
  `DotnetTaskRequest`/`DotnetTaskStarted`.

**Módulo 2 — Terminal asistida.**
- `src/renderer/terminal-suggest.ts`: motor puro de sugerencias para git y la CLI de .NET, con
  ramas y proyectos reales inyectados como contexto.
- `git-service.listBranches()`: ramas locales y remotas ordenadas por fecha de commit, con caché de
  15 s porque el autocompletado consulta en cada pulsación.
- Texto fantasma en línea con indicador de `Tab`, menú navegable con las flechas y aceptación con
  Tab o flecha derecha. Con el menú abierto las flechas navegan sugerencias; con él cerrado siguen
  siendo el historial.

**Errores encontrados:**
- *Síntoma:* el heredoc volvió a comerse las contrabarras y `output.split(/\r?\n/)` llegó a
  `git-service.ts` como un CR y un LF literales dentro del regex.
  *Causa raíz:* la trampa ya documentada en `CLAUDE.md`, esta vez con dos capas (bash y node -e).
  *Arreglo:* todos los parches de esta iteración se escribieron como archivos `.mjs` y se
  ejecutaron con node, sin pasar el código por la shell. El regex quedó con `String.raw`.
- *Síntoma:* el menú de sugerencias aparecía cortado por arriba: con el panel bajo de altura, las
  primeras entradas —justo la que acepta el tabulador— quedaban fuera de la vista.
  *Causa raíz:* `max-height` fija en CSS, sin relación con el hueco real sobre el prompt.
  *Arreglo:* la altura se calcula al pintar, a partir de la distancia entre el prompt y el borde
  superior del panel. Verificado con `--probe=`: el menú empieza 10 px por debajo del panel.
- *Síntoma:* el canal de un proyecto enseñaba el puerto HTTP y no el del perfil (HTTPS).
  *Causa raíz:* Kestrel anuncia las dos URLs y el código se quedaba con la última.
  *Arreglo:* se conserva la primera, que es la del perfil de `launchSettings.json`, la misma que
  abre `dotnet run`.
- *Observado, no corregido:* al arrancar con un workspace reciente ya borrado, el proceso principal
  registra un `ENOENT` en la consola. El renderer ya lo ignora y la aplicación arranca bien; el
  aviso es sólo ruido en el log. Queda anotado como candidato a limpieza.

**Verificado sobre la aplicación real** (solución hexagonal `Ph` con Web API + Blazor, net10.0),
midiendo con `--ui=` y `--probe=` en vez de mirar capturas:
- Barra superior: `{"picker":"Adapters.Blazor","modes":["Depurar*","Sin depurar"],"play":true}`.
- Desplegable: lista los dos adaptadores conductores y la entrada "Configurar varios proyectos…".
- Modal: las dos casillas, el orden y los botones de guardar.
- **Arranque multiproyecto real**: tras marcar los dos proyectos y pulsar Play en modo "Sin
  depurar", el panel mostró `["Compilación","Adapters.Blazor","Adapters.Web"]`, la pestaña Salida
  con la insignia `2` y dos botones "Detener Adapters.Blazor" / "Detener Adapters.Web".
- **Puertos**: con los servidores ya levantados,
  `Adapters.Blazor:5587` y `Adapters.Web:5585`, enlazando a `https://localhost:5587` y
  `https://localhost:5585` — exactamente los del `launchSettings.json` generado.
- Terminal: escribiendo `git `, el fantasma dice `git status` con la tecla `Tab` y el menú lista
  los subcomandos con su descripción.
- `npm test` en verde de punta a punta y `--smoke-test` → `SMOKE_OK`.
