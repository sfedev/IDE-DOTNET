# PROJECT_DEVLOG.md — DotForge IDE

Bitácora viva de desarrollo. Se actualiza **en cada iteración** del bucle de trabajo.

- **Proyecto:** DotForge IDE — distribución de IDE para C# / .NET 9+ / Blazor
- **Inicio:** 2026-08-23
- **Estado global:** 

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

### Fase 10 — ★ DotForge AI Assistant
- [x] F10.1 Modelo compartido del asistente (`src/shared/ai.ts`): proveedores, catálogo de modelos y preferencias
- [x] F10.2 Servicio de IA en el proceso principal (`src/main/services/ai/`) con streaming y cancelación
- [x] F10.3 Tres proveedores: Anthropic, OpenAI y local (Ollama), con endpoint configurable
- [x] F10.4 Almacén de claves cifrado con `safeStorage` (DPAPI / Keychain), sin caída a texto plano
- [x] F10.5 Contratos IPC `ai:status`, `ai:set-key`, `ai:probe`, `ai:send`, `ai:cancel` y eventos de streaming
- [x] F10.6 Sexto icono en la barra de actividad y panel de chat con respuesta token a token
- [x] F10.7 Inyección de contexto RAG: archivo activo, selección, arquitectura y diagnósticos de compilación
- [x] F10.8 Reglas de arquitectura por proyecto (Clean, Hexagonal, DDD) impuestas desde el proceso principal
- [x] F10.9 Asistente en línea `Ctrl+I` / `Cmd+I` con vista previa de diferencias y aceptar/descartar
- [x] F10.10 Acciones rápidas en el menú contextual del editor y del árbol de archivos
- [x] F10.11 Sección "Asistente de IA" en los ajustes, con "Probar conexión" y control del contexto enviado
- [x] F10.12 Modo de diagnóstico `--ui=ai` y menú nativo "IA"
- [x] F10.13 Pruebas: 113 nuevas (proveedores, contexto RAG, diferencias y streaming de punta a punta)

### Fase 11 — Control de fuentes, procesos visibles y logs de .NET
- [x] F11.1 Modelo puro del control de fuentes (`src/shared/git.ts`): parseo de `git status --porcelain --branch`
- [x] F11.2 Servicio de git en el proceso principal: preparar, quitar, descartar, commit, push, pull, sync, ramas
- [x] F11.3 Contratos IPC `git:repository`, `git:stage`, `git:unstage`, `git:discard`, `git:commit`,
      `git:push`, `git:pull`, `git:sync`, `git:checkout`, `git:create-branch`, `git:file-diff`
- [x] F11.4 Icono dedicado en la barra de actividad, con insignia del número de archivos con cambios
- [x] F11.5 Panel con secciones colapsables "Cambios preparados" y "Cambios", letras M/A/D/U y acciones al pasar el ratón
- [x] F11.6 Editor de diferencias lado a lado de Monaco, con pestaña propia y modelos `dotforge-diff:`
- [x] F11.7 Caja de mensaje multilínea con `Ctrl+Enter` / `Cmd+Enter` y enmienda del último commit
- [x] F11.8 Botones Commit / Push / Pull / Sync con indicador de adelanto y retraso
- [x] F11.9 Selector de rama en la cabecera, con creación de rama (`git checkout -b`)
- [x] F11.10 Pastillas de estado por proceso en la barra superior, con puerto y color de estado
- [x] F11.11 Clic en una pastilla enfoca el canal de salida de ese proceso
- [x] F11.12 Cabecera de canal: nombre, insignia de tipo, estado, enlace HTTPS y reinicio/parada individuales
- [x] F11.13 Ajuste "Nivel de salida de .NET CLI" (Minimal / Normal / Detailed / Diagnostic)
- [x] F11.14 Inyección de la verbosidad en `build`, `run`, `watch`, `test`, `clean`, `restore` y `format`
- [x] F11.15 Entorno extendido en niveles altos: registro de ASP.NET Core, errores detallados y traza del host
- [x] F11.16 El interruptor del asistente de IA atenúa su icono, bloquea la navegación y explica dónde encenderlo
- [x] F11.17 Modos de diagnóstico `--ui=git`, `--ui=git-diff`, `--ui=startup-play`, `--ui=ai-toggle`, `--wait=`, `--ui-wait=`
- [x] F11.18 Pruebas: 98 nuevas (parseo de git, diff de Monaco, verbosidad, conmutador de IA y servicio de git real)

### Fase 12 — Gestor de EF Core y cliente HTTP integrado
- [x] F12.1 Modelo puro de EF Core (`src/shared/efcore.ts`): bloque JSON de la CLI, migraciones, contextos y argumentos
- [x] F12.2 Esquema deducido de las migraciones (`src/shared/efcore-schema.ts`): tablas, columnas, claves e índices
- [x] F12.3 Cadenas de conexión de los `appsettings*.json`, con proveedor detectado y contraseña tapada
- [x] F12.4 Servicio `efcore-service.ts`: lectura con `execFile` y escritura transmitida por el canal de tareas
- [x] F12.5 Contratos IPC `efcore:migrations`, `efcore:contexts`, `efcore:run`, `efcore:schema`, `efcore:connections`
- [x] F12.6 Quinto icono de la barra de actividad y panel "Base de datos" con tres secciones colapsables
- [x] F12.7 Añadir migración, actualizar base de datos y quitar la última, con confirmación si ya está aplicada
- [x] F12.8 Modelo puro del formato `.http` / `.rest` (`src/shared/http-file.ts`): bloques, variables y resolución
- [x] F12.9 Gramática Monarch del lenguaje `http` y su registro en Monaco
- [x] F12.10 Lente de código "Enviar petición" sobre cada bloque de un archivo `.http`
- [x] F12.11 Cliente HTTP en el proceso principal (`http-client-service.ts`) con redirecciones y tiempos
- [x] F12.12 Pestaña "HTTP" del panel inferior: estado, tiempo, tamaño, cuerpo, cabeceras e historial
- [x] F12.13 Detección de endpoints Minimal API y de controladores (`src/shared/api-endpoints.ts`)
- [x] F12.14 Lente "Probar «verbo ruta»" sobre cada endpoint de C#, que genera la petición en el `.http` del proyecto
- [x] F12.15 Menú nativo "Datos" y comandos de paleta para EF Core y HTTP
- [x] F12.16 Pruebas: 82 nuevas (EF Core, esquema, formato `.http`, envío real contra un servidor y endpoints)

### Fase 13 — Registro estructurado, linter de arquitectura y terminal en la nube
- [x] F13.1 Parser de registro (`src/shared/log-events.ts`): Serilog, consola de .NET, NLog y CLEF
- [x] F13.2 Marcos de pila reconocidos por su forma, no por las palabras `at`/`in` (están traducidas)
- [x] F13.3 Pestaña "Registro" con pastillas por nivel, cuentas y filtro de texto
- [x] F13.4 Detalle desplegable por evento: excepción y traza completa
- [x] F13.5 Marcos clicables que abren el `.cs` en su línea exacta
- [x] F13.6 Repintado con freno de 400 ms para que una aplicación arrancando no bloquee el panel
- [x] F13.7 Modelo de reglas de arquitectura (`src/shared/architecture-rules.ts`): capas y dependencias permitidas
- [x] F13.8 Aviso `DF1001` por referencia de proyecto prohibida entre capas
- [x] F13.9 Aviso `DF1002` por `using` prohibido, con su línea exacta
- [x] F13.10 Aviso `DF1003` por paquete de infraestructura dentro del dominio o los puertos
- [x] F13.11 Los avisos van al panel de problemas y al margen del editor, con propietario propio de marcadores
- [x] F13.12 Modelo de Docker (`src/shared/docker.ts`) y servicio que lee el estado del motor
- [x] F13.13 Canal `terminal:context`: contenedores, imágenes y scripts del `package.json`
- [x] F13.14 Sugerencias de `docker` y `docker compose`, con contenedores e imágenes reales
- [x] F13.15 Sugerencias de la CLI de Azure por grupos (`webapp`, `group`, `sql`, `acr`, `containerapp`)
- [x] F13.16 Sugerencias de `npm` con los scripts reales del `package.json`, y banderas de `node`
- [x] F13.17 Corrección en las plantillas: el `outputTemplate` de Serilog escribía la hora literal
- [x] F13.18 Pruebas: 80 nuevas (registro, arquitectura, Docker y sugerencias de terminal)

### Fase 14 — Contenedores y Docker Compose
- [x] F14.1 Parser propio del subconjunto de YAML de Compose (`src/shared/compose.ts`)
- [x] F14.2 Modelo de servicio: imagen o `build`, `container_name`, puertos, dependencias y perfiles
- [x] F14.3 Cruce entre lo declarado y lo que corre (`matchComposeState`), como función pura
- [x] F14.4 Búsqueda de archivos de Compose en la raíz y un nivel por debajo
- [x] F14.5 Canales IPC `docker:state`, `docker:compose-files`, `docker:compose-read`, `docker:compose-run`, `docker:container-run`
- [x] F14.6 Validación de los canales: ruta dentro del workspace, nombre de archivo de Compose y nombres acotados
- [x] F14.7 Sexta herramienta de la barra de actividad: panel de contenedores
- [x] F14.8 Cabecera con archivo, recuento `n/m arriba` y botones Levantar / Bajar / Registro
- [x] F14.9 Fila por servicio con punto de estado, icono por tipo, nombre real y puertos
- [x] F14.10 Acciones por servicio: arrancar, parar, reiniciar y ver el registro
- [x] F14.11 Contenedores ajenos al compose en una sección aparte, con arrancar/parar/registro/eliminar
- [x] F14.12 Puerto como enlace sólo para lo que se abre en un navegador (Seq, RabbitMQ, MailHog)
- [x] F14.13 Con Docker apagado el panel sigue enseñando los servicios declarados (ADR-033)
- [x] F14.14 Modo de diagnóstico `--ui=containers` y entradas en el menú "Datos"
- [x] F14.15 Pruebas: 31 nuevas (YAML, servicios, puertos, comandos y correspondencia con el motor)
- [x] F14.16 El proceso depurado tiene canal, pastilla, puerto y parada propios (v1.8.1, ADR-034)
- [x] F14.17 El indicador de una tarea de larga duración es un punto verde, no un spinner (v1.8.1)

### Fase 15 — Explorador de pruebas, sintaxis semántica, túneles, métricas y auditoría
- [x] F15.1 Capacidad `textDocument/semanticTokens/full` declarada de verdad (las listas iban vacías)
- [x] F15.2 Modelo puro de tokens semánticos (`src/shared/semantic-tokens.ts`): descodificación relativa,
      normalización de los nombres de Roslyn y reempaquetado para Monaco
- [x] F15.3 Proveedor de tokens semánticos en el puente de Monaco, con repintado al llegar la leyenda
- [x] F15.4 Paleta de sintaxis estilo Visual Studio 2026 en los dos temas, con contraste AA verificado
- [x] F15.5 `solution/open`: Roslyn no carga nada hasta que se le abre la solución (ADR-039)
- [x] F15.6 Modelo puro del explorador de pruebas (`src/shared/test-explorer.ts`): descubrimiento por
      texto, árbol, filtros de VSTest y lectura de resultados
- [x] F15.7 Servicio de pruebas: recorrido de los proyectos de pruebas y `dotnet test` con logger TRX
- [x] F15.8 Resultados leídos del TRX, que es invariante; consola sólo como camino degradado (ADR-036)
- [x] F15.9 Panel lateral "Pruebas": árbol proyecto → clase → prueba, estados, filtro y "Ejecutar todas"
- [x] F15.10 Lentes de código "▶ Ejecutar prueba" y "Depurar" sobre cada `[Fact]` y `[Theory]`
- [x] F15.11 Los fallos van al panel de problemas con archivo, línea, mensaje del assert y traza
- [x] F15.12 Insignia de pruebas en rojo sobre el icono de la barra de actividad
- [x] F15.13 Modelo puro de túneles (`src/shared/dev-tunnel.ts`) con escáner de salida por líneas
- [x] F15.14 Botón "Crear túnel público" en la barra superior, con la URL clicable y el aviso
- [x] F15.15 Modelo puro de contadores (`src/shared/perf-counters.ts`): dos generaciones de nombres
- [x] F15.16 Pestaña "Métricas": CPU, montón, conjunto de trabajo, reserva, GC por generación y HTTP
- [x] F15.17 Sesión de `dotnet-counters collect` leyendo el CSV de forma incremental (ADR-038)
- [x] F15.18 Modelo puro de la auditoría de NuGet (`src/shared/nuget-audit.ts`): JSON y tabla degradada
- [x] F15.19 Sección "Seguridad" en el panel de NuGet: gravedad, CVE/GHSA y transitivos
- [x] F15.20 Insignia de paquetes con aviso sobre el icono de NuGet
- [x] F15.21 Modos de diagnóstico `--ui=tests`, `--ui=tests-run`, `--ui=metrics`, `--ui=audit`
- [x] F15.22 `--probe=` espera promesas: sirve para medir una llamada IPC, no sólo el DOM
- [x] F15.23 La salida de error del servidor de lenguaje llega a la consola en vez de perderse
- [x] F15.24 Pruebas: 165 nuevas (tokens semánticos, pruebas, túneles, contadores y auditoría)

### Fase 16 — Servidor de lenguaje: versión fijada, instalación verificada y respaldo automático
- [x] F16.1 Política de versiones de Roslyn (`src/shared/lsp-versions.ts`): versión fijada y
      verificada, descarte de compilaciones de prueba y orden por banda (ADR-040)
- [x] F16.2 Manifiesto de instalación con tamaño y hash por archivo (`src/shared/toolchain-manifest.ts`)
- [x] F16.3 Verificación superficial en cada arranque y profunda tras un fallo (ADR-041)
- [x] F16.4 El extractor se niega a escribir un archivo que no mide lo que declara el ZIP
- [x] F16.5 La descarga comprueba `content-length`: un `.nupkg` cortado ya no se extrae
- [x] F16.6 Detección del servidor roto por stderr y por nombre de tipo de excepción (ADR-042)
- [x] F16.7 Un cierre que nadie ha pedido es un fallo aunque el código de salida sea 0 (ADR-042)
- [x] F16.8 `workspace/configuration` se contesta con un array, no con `null` (ADR-043)
- [x] F16.9 Cuarentena de versiones por RID, con indulto si la culpa era de la copia (ADR-044)
- [x] F16.10 Conmutación automática y transparente a OmniSharp, con el motivo en la barra de estado
- [x] F16.11 Pruebas: 40 nuevas (política de versiones, detección, cuarentena, instalación y protocolo)
- [x] F16.12 Verificado sobre la aplicación real: hover, completado, símbolos y 1440 números de
      tokens semánticos con Roslyn 4.14.0-3.26423.7, y OmniSharp v1.39.15 sirviendo lo mismo
- [x] F16.13 NetCoreDbg se instala y se verifica por el mismo camino: `installArchive` + `verifyInstall`
- [x] F16.14 Su descarga comprueba `content-length` e informa del progreso, que antes iba siempre a null
- [x] F16.15 Prueba de seguridad que vigila que ningún adquisidor vuelva a declararse su marcador
- [x] F16.16 Pruebas: 6 nuevas del depurador, con el constructor de ZIP movido a un fixture compartido


### Fase 17 — Actualizaciones automáticas y explorador de extensiones de Open VSX
- [x] F17.1 Modelo puro de actualizaciones (`src/shared/updates.ts`): SemVer con prelanzamientos,
      lectura del feed de releases, elección de artefacto por plataforma y arquitectura (ADR-045)
- [x] F17.2 `updater-service.ts`: comprobación 5 s después del arranque y bajo demanda, descarga con
      verificación de `content-length` y estado en streaming hacia el renderer
- [x] F17.3 La instalación se aplica al cerrar (`before-quit`), con el instalador desprendido del
      proceso; lo pendiente se persiste en `updates/pending.json` y sobrevive a un cierre feo (ADR-046)
- [x] F17.4 Canales `update:state`, `update:check`, `update:download`, `update:dismiss` y
      `update:apply-on-quit`, más el evento `event:update-state`
- [x] F17.5 Tarjeta flotante (`src/renderer/views/update-card.ts`): título con la versión, notas de
      la publicación, barra de descarga y "Reiniciar y aplicar"
- [x] F17.6 "Descartar" no es "no quiero": oculta la tarjeta, sigue descargando e instala al cerrar
- [x] F17.7 Interruptor "Buscar actualizaciones automáticamente" y botón "Buscar ahora" en Ajustes,
      con el estado de la última comprobación
- [x] F17.8 Modelo puro del registro (`src/shared/open-vsx.ts`): URLs, lectura de la respuesta,
      identidad válida y lista blanca de hosts de descarga (ADR-047)
- [x] F17.9 Modelo puro del formato `.vsix` (`src/shared/vsix.ts`): manifiesto, carpeta de destino y
      reparto de las contribuciones entre las que aquí sirven y las que no (ADR-048)
- [x] F17.10 `open-vsx-service.ts`: búsqueda y ficha contra `https://open-vsx.org/api`, con caché corta
- [x] F17.11 `extension-installer.ts`: descarga verificada del `.vsix` e instalación en
      `userData/extensions/` con `installArchive` + `verifyInstall`, sin marcador propio (ADR-041)
- [x] F17.12 Panel lateral "Extensiones" con buscador, filtro por categoría, instaladas arriba y
      resultados debajo; los iconos se dibujan localmente (ADR-049)
- [x] F17.13 Cada extensión instalada dice qué aporta de verdad y qué no tiene efecto en DotForge
- [x] F17.14 Menú, paleta de comandos y modos de diagnóstico `--ui=extensions` y `--ui=update`
- [x] F17.15 Pruebas: 90 nuevas — 82 unitarias (SemVer y feed de releases 35, cliente de Open VSX 26,
      formato `.vsix` con instalación real en disco 21) y 8 de seguridad de las dos superficies de
      descarga nuevas
- [x] F17.16 Verificado sobre la aplicación real: búsqueda en Open VSX con 16 920 extensiones,
      instalación y desinstalación de un `.vsix` de verdad, y la tarjeta de actualización a la vista

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

### ADR-045 — Actualizaciones sin `electron-updater`
**Fecha:** 2026-08-24
**Contexto:** El IDE tiene que saber que hay una versión nueva y aplicarla sin que el usuario vaya a
buscar un instalador a mano.
**Opciones:** (a) `electron-updater`; (b) leer la API pública de releases y descargar el artefacto.
**Decisión:** (b).
**Consecuencias:** `electron-updater` da actualizaciones diferenciales y verificación de firma, pero
exige artefactos **firmados** y un canal de publicación (`latest.yml`, que genera el publicador de
electron-builder). Aquí no hay certificado y `electron-builder.yml` declara `publish: null`, así que
ese camino no está disponible hoy. La alternativa reutiliza exactamente el patrón que ya sostiene el
toolchain: feed público, descarga con `content-length` comprobado y artefacto guardado en `userData`.
A cambio, la actualización es completa (unos 120 MB) y la integridad depende de HTTPS, no de una
firma; cuando haya certificado, migrar es cambiar este servicio, no la interfaz.

### ADR-046 — La actualización se aplica al cerrar, y "Descartar" no significa "no"
**Fecha:** 2026-08-24
**Contexto:** Reemplazar los archivos de la aplicación mientras está abierta no se puede hacer, y
pedir "reinicia ahora" a alguien que está a mitad de un método es la forma más rápida de que las
actualizaciones se ignoren para siempre.
**Decisión:** el único camino de instalación es `app.on('before-quit')`. "Reiniciar y aplicar" cierra
el IDE para llegar ahí; "Descartar" esconde la tarjeta, **sigue descargando en segundo plano** y deja
la instalación programada para el próximo cierre.
**Consecuencias:** un solo camino que probar, y una actualización que se aplica sola sin que nadie
haya tenido que parar de trabajar. Lo pendiente se persiste en `updates/pending.json`: una promesa
que sólo vive en memoria no sobrevive a un cierre inesperado, y prometer una instalación que luego no
ocurre es peor que no prometerla. El instalador se lanza `detached`, porque el padre está
desapareciendo. En macOS no hay instalación silenciosa posible sin firma ni framework de
actualización: se abre el `.dmg` y se dice explícitamente que hay que arrastrar la app a
Aplicaciones, en vez de fingir que se ha instalado.

### ADR-047 — Extensiones de Open VSX, con el host de descarga en lista blanca
**Fecha:** 2026-08-24
**Contexto:** El marketplace de Microsoft no permite por licencia que lo consuma un producto que no
sea VS Code. Open VSX (Eclipse Foundation) sirve los mismos `.vsix` y sí lo permite; es lo que se
anticipó en la ADR-001.
**Decisión:** cliente propio contra `https://open-vsx.org/api`, con la petición hecha **desde el
proceso principal** y la URL de descarga validada contra una lista de hosts antes de pedirla.
**Consecuencias:** la CSP del renderer sigue sin permitir ningún origen remoto y el registro no ve
nada del equipo salvo la propia consulta. La validación del host no es ceremonia: la URL del `.vsix`
llega **dentro del JSON del registro**, es decir, es texto de la red que acaba siendo el origen de
algo que se escribe en el disco; sin comprobarla, quien pueda alterar esa respuesta elige de dónde se
baja el archivo. Si la respuesta trae una descarga de otro host, se descarta y se construye la
canónica. El paquete se instala con `installArchive` + `verifyInstall` (ADR-041), nunca con un
marcador propio.

### ADR-048 — Las extensiones se instalan; su código no se ejecuta, y se dice
**Fecha:** 2026-08-24
**Contexto:** DotForge no es VS Code: no tiene su host de extensiones ni su API. Un `.vsix` trae dos
cosas distintas —contribuciones declarativas (temas, fragmentos, gramáticas, lenguajes) y código de
activación— y sólo las primeras se pueden aprovechar sin implementar ese host entero.
**Opciones:** (a) no ofrecer extensiones hasta poder ejecutarlas; (b) instalarlas y callar; (c)
instalarlas y decir en cada ficha qué aporta y qué no tiene efecto aquí.
**Decisión:** (c). `describeContributions` reparte cada clave de `contributes` entre las dos listas.
**Consecuencias:** quien instale un depurador de Python ve, en la propia ficha, que su depurador no
va a funcionar aquí, en vez de deducirlo esperando a que pase algo. Un gestor que instala y calla se
percibe como roto; uno que explica su alcance se percibe como honesto. Cuando el IDE sepa consumir
gramáticas TextMate o temas de VS Code, la lista de "sirve" crece y no hay que tocar nada más.

### ADR-049 — Los iconos de las extensiones se dibujan, no se descargan
**Fecha:** 2026-08-24
**Contexto:** Cada extensión del registro publica un icono en una URL remota.
**Decisión:** se pinta una pastilla con las iniciales y un color derivado del identificador.
**Consecuencias:** es la misma decisión que ya se tomó con NuGet y por los mismos dos motivos: la CSP
del renderer declara `img-src 'self' data:` y no se va a relajar por unos iconos, y descargarlos le
contaría al registro qué extensiones está mirando el usuario. El color sale de un hash del
identificador, así que la misma extensión se ve siempre igual y la lista sigue siendo escaneable.
### ADR-050 — El token de GitHub sólo viaja a `api.github.com`
**Fecha:** 2026-08-24
**Contexto:** La adquisición de NetCoreDbg y de OmniSharp consulta la API de GitHub para saber cuál
es la última release. Sin autenticar, esa API permite 60 peticiones por hora **y por IP**; la IP de
un runner compartido las tiene agotadas casi siempre, y el resultado es un 403 que rompió la suite
en la primera ejecución del pipeline sobre un clon limpio.
**Opciones:**
- (a) dejarlo sin autenticar y convivir con un CI que falla de forma intermitente;
- (b) fijar la versión del depurador y del servidor de respaldo para no preguntar a la API;
- (c) autenticar la consulta cuando haya un token en el entorno.
**Decisión:** (c), con el alcance acotado en un módulo puro (`src/shared/github-api.ts`).
**Consecuencias:** autenticar sube el límite a 5 000 peticiones/hora, pero mete una credencial en el
proceso, así que el alcance es la parte importante de la decisión y no un detalle de implementación:

- El token se adjunta **sólo** si el host es exactamente `api.github.com` y el protocolo es HTTPS.
  La comparación es del `hostname` completo: `api.github.com.malo.dev` **contiene** el host bueno y
  no lo es, y un subdominio tampoco hereda la credencial.
- No lo llevan la descarga del artefacto (`objects.githubusercontent.com`), ni el feed de Azure donde
  se publica Roslyn, ni el registro de extensiones. Son las peticiones que más pesan y ninguna
  necesita credencial.
- Se lee de `GITHUB_TOKEN` o `GH_TOKEN` y **en un único archivo de todo `src/`**, con una prueba
  estructural que lo vigila: si el token se pudiera leer desde cualquier módulo, la garantía
  dependería de que nadie se despiste, que no es una garantía.
- Fuera de CI no suele haber ninguna de las dos variables, y ése es el camino normal: sin token, el
  comportamiento es idéntico al anterior.
- La opción (b) se descartó porque el problema no es la elección de versión —eso ya se resolvió para
  Roslyn en la ADR-040— sino la consulta en sí: incluso fijando la versión hay que resolver la URL
  del artefacto, y eso pasa por la API.
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
- *Observado en esta iteración, corregido en la siguiente:* al arrancar con un workspace reciente
  ya borrado, el proceso principal registraba un `ENOENT` en la consola. Ver iteración 12.

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


### Iteración 12 — 2026-08-23 — El historial de recientes deja de mentir
**Síntoma:** en cada arranque, el proceso principal escribía en el log
`Error occurred in handler for 'workspace:open': ENOENT: no such file or directory, stat '...'`.
La aplicación arrancaba bien, pero además la pantalla de bienvenida seguía ofreciendo carpetas
borradas como si se pudieran abrir.

**Causa raíz:** eran tres fallos encadenados, no uno.
1. El renderer reabría `recentWorkspaces[0]` a ciegas. No puede hacer otra cosa: no tiene acceso al
   disco, así que no sabía si esa carpeta seguía existiendo.
2. `workspace:open` no validaba nada. Llamaba a `setWorkspaceRoot(directory)` —moviendo la raíz del
   guardián de rutas a una carpeta inexistente— y dejaba que el ENOENT saliera de `loadSolution`
   sin traducir. Electron registra toda excepción que sale de un handler: de ahí el ruido.
3. La bienvenida pintaba el historial tal cual, sin distinguir lo que existe de lo que no.

**Hecho:**
- `src/main/services/workspace-recents.ts`: `isOpenableWorkspace` (existe **y** es directorio),
  `describeRecents` (anota disponibilidad sin borrar nada) y `firstAvailable`. Node puro y probado
  con carpetas reales.
- `openWorkspaceDirectory` valida **antes** de tocar el estado: si la ruta no sirve, ni se mueve la
  raíz del guardián ni se recarga nada, y el mensaje dice qué ha pasado y qué hacer. La ruta de
  línea de comandos (`dotforge-ide <carpeta>`) tenía el mismo agujero y usa ahora el mismo criterio.
- Canales nuevos `workspace:recents` y `workspace:open-recent`. Reabrir "lo último" pasa a ser una
  decisión del proceso principal, que es quien conoce el disco: elige el reciente más nuevo que
  **todavía exista** y devuelve `null` si no queda ninguno. Sin intentos condenados, sin ruido.
- La bienvenida marca los no disponibles como entradas apagadas y sin acción, con el texto
  "no disponible".
- 12 pruebas nuevas en `tests/unit/workspace-recents.test.mjs`, con carpetas y archivos de verdad.

**Decisión que conviene recordar:** no se borra del historial lo que no está disponible. Es
tentador —dejaría la lista siempre limpia— pero un proyecto en un USB desconectado o en una unidad
de red caída desaparecería para siempre por haber arrancado el IDE sin el disco puesto. Se enseña
apagado, que informa sin destruir.

**Verificado** con el caso real que lo destapó: las tres entradas del historial de esta máquina
apuntaban a carpetas borradas.
- Antes: `ENOENT` en el log en cada arranque.
- Ahora: ni `ENOENT` ni `Error occurred in handler` en la salida, y el probe devuelve
  `[{"texto":"Phno disponible","readonly":true,"esBoton":false}, …]` para las tres.
- Camino bueno intacto: tras abrir una solución real, arrancar sin argumentos la reabre sola
  (`{"title":"Ok.Shop","disponibles":1}`).
- `npm test` en verde (329 pruebas unitarias) y `--smoke-test` → `SMOKE_OK`.

**Versión:** el arreglo del historial de recientes es una corrección de comportamiento sobre la
1.3.0, sin funcionalidad nueva ni cambios de contrato para el usuario, así que por semver le
corresponde el tercer número: **1.3.1**. Los canales `workspace:recents` y `workspace:open-recent`
son internos —superficie IPC, no API pública— y existen sólo para poder hacer la corrección.

### ADR-016 — El prompt de sistema lo compone el proceso principal, no el renderer
**Fecha:** 2026-08-23
**Contexto:** El asistente promete algo concreto: responder respetando la arquitectura del proyecto
abierto. Esa promesa se cumple o se incumple en un sitio muy pequeño —el prompt de sistema— y
había que decidir quién lo escribe.
**Opciones:**
- (a) El renderer compone el prompt completo y lo manda por IPC. Es lo más directo: la vista ya
  tiene el archivo, la selección y los diagnósticos.
- (b) El renderer manda contexto y mensajes; el proceso principal compone el prompt.
**Decisión:** (b). El renderer envía `AiContext` y la lista de mensajes; `systemPrompt()` se ejecuta
en el proceso principal en cada petición, y `register.ts` **sobrescribe** la arquitectura y el mapa
de proyectos con los de la solución realmente abierta en vez de fiarse de lo que llegue.
**Consecuencias:** las reglas de arquitectura dejan de ser un parámetro de la interfaz y pasan a ser
parte del contrato del asistente. Un fallo del renderer —o una página comprometida, que es el
escenario contra el que existe todo el aislamiento de esta app— no puede pedir "ignora las reglas":
el validador descarta los roles que no son `user` ni `assistant`, así que un `system` inyectado
desde el renderer no llega a ninguna parte. El coste es que el renderer no puede afinar el prompt;
a cambio, lo que se le impone al modelo se lee entero en un único archivo probado.

### ADR-017 — HTTP directo para los tres proveedores, sin SDK
**Fecha:** 2026-08-23
**Contexto:** Hay tres proveedores (Anthropic, OpenAI y Ollama) y cada uno tiene su SDK oficial o
su cliente recomendado.
**Opciones:**
- (a) Un SDK por proveedor. Tipos oficiales, reintentos y helpers de streaming ya resueltos.
- (b) El SDK de Anthropic para Anthropic y `fetch` para los otros dos.
- (c) `fetch` para los tres, con un constructor de peticiones y un parser de streaming por formato.
**Decisión:** (c).
**Consecuencias:** (b) queda descartada de entrada: mezclar un SDK con llamadas HTTP crudas dentro
del mismo módulo da lo peor de las dos cosas —dos modelos de error, dos formas de cancelar y dos
sitios donde mirar cuando algo falla—. Entre (a) y (c) pesa el empaquetado: un IDE de escritorio
carga esto en el proceso principal de Electron y tres SDK son tres árboles de dependencias que hay
que auditar, actualizar y firmar. Con (c), la superficie es un archivo que construye una petición y
otro que la parsea, los dos funciones puras y por tanto probables sin red ni claves — que es
justamente lo que permite las 46 aserciones de `ai-providers.test.mjs`. El precio es real y conviene
anotarlo: cuando un proveedor cambie su formato de streaming, el aviso no llegará por un `npm
outdated`, llegará por un fallo. Por eso el parser está probado con troceado arbitrario y por eso
los errores HTTP se traducen a mensajes accionables en vez de propagarse crudos.

### ADR-018 — Modelos de la generación actual por defecto, los anteriores como opción
**Fecha:** 2026-08-23
**Contexto:** La especificación de la fase pedía "Claude 3.7 Sonnet / Claude 3.5 Haiku" y
"GPT-4o / o3-mini". Los dos modelos de Claude citados son de la generación anterior; la actual es
la familia Claude 5 (Opus 5, Sonnet 5) más Haiku 4.5, y su API tiene diferencias que no son
cosméticas: `temperature` y `budget_tokens` están retirados —devuelven 400— y el esfuerzo se
controla con `output_config.effort` junto a razonamiento adaptativo.
**Decisión:** el catálogo ofrece las dos generaciones. El valor por defecto es `claude-opus-5`, y
`claude-3-7-sonnet-latest` y `claude-3-5-haiku-latest` quedan marcados como `legacy: true` y se
enseñan en el desplegable con el sufijo "· anterior".
**Consecuencias:** quien tenga una clave con acceso limitado, o quiera reproducir un resultado
antiguo, sigue pudiendo elegirlos; quien no toque nada arranca con lo mejor disponible. La
diferencia de API se resuelve con un flag por modelo (`supportsEffort`) en vez de con una cadena de
`if` por versión: a un modelo antiguo no se le manda `output_config` ni `thinking`, y a ninguno se
le manda nunca `temperature` ni `budget_tokens`. Hay una prueba por cada una de esas tres reglas,
porque el fallo sería un 400 en mitad de una conversación y no un error de compilación.

### ADR-019 — Sin cifrado del sistema, la clave no toca el disco
**Fecha:** 2026-08-23
**Contexto:** Las claves de API se guardan con `safeStorage`, que delega en DPAPI (Windows) y
Keychain (macOS). En algún entorno —una sesión de Linux sin llavero— `isEncryptionAvailable()`
devuelve false.
**Opciones:** (a) guardar la clave en claro en `userData` avisando en la interfaz, (b) no guardarla
y usarla sólo durante la sesión, (c) no permitir configurar el proveedor en ese caso.
**Decisión:** (b). La clave se queda en memoria, el archivo `ai-credentials.json` ni se crea, y el
handler devuelve un estado con el motivo, que la interfaz enseña.
**Consecuencias:** el usuario tiene que volver a pegar la clave en cada arranque en ese entorno
concreto, lo cual es molesto y se le dice claramente. La alternativa (a) es la que acaba, años
después, con una clave de producción en el perfil de alguien y en una copia de seguridad que nadie
recordaba. (c) sería peor que el problema: el asistente dejaría de existir en esa máquina.

---

### Iteración 13 — 2026-08-23 — Fase 10: DotForge AI Assistant
**Objetivo:** que el IDE entienda de la arquitectura del proyecto abierto y pueda ayudar sin
romperla — que es lo único que un asistente genérico no puede hacer.

**Módulo 1 — Proveedor y transporte.**
- `src/shared/ai.ts`: catálogo de proveedores y modelos, preferencias y tipos del streaming. Sin
  dependencias, así que lo comparten proceso principal, renderer y pruebas.
- `src/main/services/ai/request-builder.ts` y `stream-parser.ts`: funciones puras que construyen la
  petición de cada proveedor y parsean su respuesta (SSE con tipos en Anthropic, SSE con `[DONE]`
  en OpenAI, NDJSON en Ollama).
- `ai-service.ts`: un `AbortController` por `requestId`, temporizador de inactividad de 90 s y
  traducción de todos los fallos a mensajes accionables. La fuente de credenciales se **inyecta**
  (`setCredentialSource`), así que el cliente entero no depende de Electron y se puede ejercitar
  contra un servidor de mentira.
- `secret-store.ts`: claves cifradas con `safeStorage`, con la política del ADR-019.
- Canales nuevos: `ai:status`, `ai:set-key`, `ai:probe`, `ai:send`, `ai:cancel` y los eventos
  `event:ai-delta` / `event:ai-end`.

**Módulo 2 — Contexto RAG y reglas de arquitectura.**
- `src/shared/ai-context.ts`: detección de la arquitectura (manifiesto `dotforge.json` primero,
  forma de la solución después), mapa de proyecto a capa, recorte por ventana del archivo activo y
  composición del prompt de sistema con las reglas de Clean, Hexagonal o DDD.
- Las cuatro piezas del contexto —archivo, selección, arquitectura y diagnósticos— se pueden apagar
  por separado desde los ajustes, y hay una prueba de que apagarlas surte efecto de verdad.

**Módulo 3 — Interfaz.**
- `views/ai-chat.ts`: sexto icono en la barra de actividad y panel de chat con respuesta token a
  token, bloques de código con "Copiar" y "Aplicar", y acciones rápidas.
- `views/ai-inline.ts`: `Ctrl+I` sobre la selección, con vista previa de diferencias — el cambio se
  aplica al modelo de Monaco y se resalta, y el widget enseña lo que desaparece y el recuento.
- `views/ai-diff.ts` (en `shared/ai-diff.ts`): extracción del bloque de código, reindentación al
  hueco de la selección y diferencia por subsecuencia común más larga.
- Acciones en el menú contextual del editor y del árbol de archivos, entradas en la paleta y un
  menú nativo "IA".

**Errores encontrados:**
- *Síntoma:* un archivo de 48.000 caracteres en **una sola línea** llegaba entero al prompt pese al
  recorte.
  *Causa raíz:* `windowAround` recortaba por líneas, y una línea más larga que todo el presupuesto
  no se puede recortar por líneas.
  *Arreglo:* tope duro sobre la ventana ya calculada. Lo destapó la prueba, no un usuario.
- *Síntoma:* `coerceChatRequest` aceptaba un `requestId` de 80 caracteres recortándolo a 64.
  *Causa raíz:* recortar por costumbre. Un id truncado es válido pero ya no casa con el que espera
  el renderer, así que los deltas irían a una conversación que no los reclama.
  *Arreglo:* se valida sin recortar; un id largo se rechaza.
- *Síntoma:* la suite pasaba en verde y tardaba **cinco minutos** en salir.
  *Causa raíz:* la prueba de cancelación deja adrede una respuesta HTTP sin cerrar, y `server.close()`
  espera al `requestTimeout` del servidor, que por defecto son 300 s.
  *Arreglo:* `closeAllConnections()` antes de cerrar. De 302 s a 302 ms.
- *Síntoma (evitado a tiempo):* `Ctrl+Shift+I` para abrir el asistente chocaba con el inspector de
  Electron, y `Ctrl+I` registrado a la vez en el menú nativo y en `window` abría el widget dos veces.
  *Arreglo:* el atajo del panel es `Ctrl+Shift+A`, y `Ctrl+I` se atiende sólo desde el menú nativo,
  cuyo acelerador llega antes que el renderer.

**Verificado sobre la aplicación real**, con `--ui=` y `--probe=` en vez de mirar capturas:
- Barra de actividad: `["Explorador de soluciones","Generador de arquitecturas","Paquetes NuGet",
  "Depuración y pruebas","DotForge AI Assistant","Ajustes"]`.
- Panel de IA: título `DotForge AI`, estado `Falta la clave de API de Anthropic. [Configurar]` y
  acciones rápidas `["Explicar","Pruebas xUnit","Revisar arquitectura"]` — es decir, sin clave el
  asistente lo dice y ofrece el camino, en vez de fallar al primer mensaje.
- Ajustes: el grupo "Asistente de IA" con proveedor, modelo, endpoint, clave, longitud, esfuerzo y
  los cuatro interruptores de contexto; el desplegable lista `Claude Opus 5`, `Claude Sonnet 5`,
  `Claude Haiku 4.5`, `Claude 3.7 Sonnet · anterior` y `Claude 3.5 Haiku · anterior`.
- **Conversación real de punta a punta** contra un servidor que habla el protocolo de Ollama
  (`tests/unit/ai-streaming.test.mjs`): el texto llega en varios deltas, el cierre trae el consumo
  de tokens, el prompt de sistema que sale por el cable contiene las reglas de la arquitectura
  detectada, el contexto viaja sólo en el último turno, un 401 se traduce a "clave de API", un
  endpoint apagado a "comprueba que Ollama está en marcha" y cancelar cierra la conexión.
- `npm test` en verde de punta a punta: **596 pruebas** (442 unit, 41 security, 57 package, 56
  scaffold), de las cuales 113 son nuevas del módulo de IA. `--smoke-test` → `SMOKE_OK`.
- Empaquetado real: `npm run dist:win` → `DotForge IDE-1.4.0-Setup-x64.exe` (117,3 MB) y
  `DotForge IDE-1.4.0-win-x64.zip` (161,6 MB); la poda liberó los 278,9 MB de la 1.3.1 antes de
  empaquetar y `verify:dist` termina sin problemas (sin firmar, como corresponde sin certificado).

**Versión:** el módulo de IA es funcionalidad nueva, con contratos IPC nuevos y sin romper nada de
lo anterior, así que por semver le corresponde el segundo número: 1.3.1 → **1.4.0** (ADR-009).

---

### ADR-020 — El control de fuentes invoca `git`, no una librería de JavaScript
**Fecha:** 2026-08-23
**Contexto:** El panel necesita estado, diffs y operaciones de escritura sobre el repositorio.
**Opciones:**
- (a) `isomorphic-git`: implementación pura en JS, sin binario externo.
- (b) `nodegit`: enlaces nativos a libgit2; hay que compilarlos por plataforma.
- (c) Invocar el `git` del sistema con `execFile` y un array de argumentos.
**Decisión:** (c) el `git` del sistema.
**Consecuencias:** worktrees, submódulos, `core.autocrlf`, hooks, credential helpers, HEAD
desprendido y repositorios sin commits funcionan **igual que en la terminal del usuario**, porque
es literalmente el mismo programa. No se añade ninguna dependencia ni ningún binario al paquete, y
el servicio no importa `electron`, así que se puede probar contra un repositorio real con Node
pelado. A cambio, sin git instalado el panel dice que no hay repositorio en vez de funcionar a
medias — que es la respuesta honesta.

### ADR-021 — El editor de diferencias usa modelos propios y es de sólo lectura
**Fecha:** 2026-08-23
**Contexto:** Al pulsar un archivo del panel hay que enseñar una comparación lado a lado.
**Opciones:**
- (a) Reutilizar el modelo `file:` del archivo como lado derecho: se edita en el diff y se guarda.
- (b) Crear dos modelos nuevos con un esquema propio (`dotforge-diff:`) y bloquear la edición.
**Decisión:** (b), con una pestaña propia por comparación (`git:<sección>:<ruta>`).
**Consecuencias:** editar dentro del diff no ensucia la pestaña del archivo ni manda cambios al
servidor de lenguaje de un documento que nadie ha abierto, y el mismo archivo puede estar abierto
a la vez como "lo preparado" y como "lo que falta por preparar", que son dos comparaciones
distintas. El precio: para editar hay que abrir el archivo, a un doble clic de distancia.

### ADR-022 — La verbosidad la decide el proceso principal y se traduce por verbo
**Fecha:** 2026-08-23
**Contexto:** Un solo ajuste debe gobernar `build`, `run`, `watch`, `test`, `clean`, `restore`,
`format` y la sesión de depuración.
**Decisión:** el nivel se guarda en preferencias, lo lee **el proceso principal** al lanzar cada
tarea —el renderer no puede elegirlo, igual que con el prompt del asistente (ADR-016)— y una
función pura (`verbosityPlan`) decide qué argumento le corresponde a cada verbo y en qué posición.
**Consecuencias:** `dotnet watch` recibe `--verbose` **antes** del subcomando y nunca
`--verbosity`, porque todo lo que va después se lo pasa a la aplicación hija; el resto recibe
`--verbosity <nivel>` detrás del objetivo. El nivel se escribe siempre, incluso `minimal`, para que
el comando que aparece en la salida diga la verdad. Y "recopilar todas las excepciones" no es una
bandera de MSBuild: son variables de entorno (`Logging__LogLevel__*`, `ASPNETCORE_DETAILEDERRORS`,
`COREHOST_TRACE`), que viven en la misma función para que nivel y comportamiento no se separen.

### ADR-023 — Una herramienta desactivada se atenúa, no desaparece
**Fecha:** 2026-08-23
**Contexto:** Al apagar el asistente en Ajustes, ¿qué pasa con su icono de la barra de actividad?
**Opciones:** (a) quitarlo de la barra, (b) dejarlo igual y fallar al pulsarlo, (c) atenuarlo,
bloquear la navegación y explicar en el tooltip dónde se enciende.
**Decisión:** (c).
**Consecuencias:** quien apagó el asistente hace tres semanas puede volver a encontrarlo; quien lo
pulsa no acaba en un panel roto ni en un error. La regla vive en una función pura
(`aiEntryState`) que usan la barra, la paleta y el asistente en línea, de modo que el interruptor
significa lo mismo en los tres sitios. Se aplica igual a cualquier herramienta futura que se pueda
desactivar.

### ADR-024 — `pull --ff-only` y confirmación nombrando la consecuencia
**Fecha:** 2026-08-23
**Contexto:** Dos operaciones del panel pueden dejar el repositorio en un estado que el usuario no
esperaba: traer cambios y descartar cambios.
**Decisión:** `pull` se ejecuta siempre con `--ff-only`, y descartar pide confirmación diciendo
explícitamente qué va a pasar con **estos** archivos.
**Consecuencias:** una fusión o un rebase automáticos disparados por un botón son la forma más
rápida de dejar a alguien con un conflicto que no sabe de dónde ha salido; si no se puede avanzar,
el panel lo dice y deja la decisión en la terminal. Y como "descartar" significa restaurar un
archivo con seguimiento pero **borrar** uno sin rastrear, la confirmación distingue los dos casos
y cuenta cuántos hay de cada uno, en vez de un "¿estás seguro?" genérico.

---

### Iteración 14 — 2026-08-23 — Fase 11: Git visual, procesos visibles y logs de .NET
**Objetivo:** cerrar las tres cosas que obligaban a salir del IDE —ver qué has cambiado, ver qué
tienes corriendo y ver por qué algo no arranca— y hacer que el interruptor del asistente signifique
algo en la interfaz.

**Módulo 1 — Panel de control de código fuente.**
- `src/shared/git.ts`: modelo puro. Parseo de `git status --porcelain --branch` con renombrados,
  conflictos, rutas entrecomilladas, HEAD desprendido y "No commits yet"; resumen de
  sincronización; y la construcción de la petición de diferencias (qué lado sale de HEAD, cuál del
  índice y cuál del disco).
- `src/main/services/git-service.ts`: el servicio entero. Estado detallado con caché corta,
  preparar, quitar de preparados, descartar, commit (con enmienda), push con `--set-upstream`
  automático la primera vez, pull, sync, cambio y creación de rama, y contenido de cada lado del
  diff. Todo con `execFile` y array de argumentos, y con `GIT_TERMINAL_PROMPT=0` para que un
  remoto que pide credenciales falle en vez de colgar el IDE.
- `src/renderer/views/git.ts`: la vista. Secciones colapsables, letras `M`/`A`/`D`/`U`, acciones al
  pasar el ratón (`+`, `-`, `↩`), caja de mensaje con `Ctrl+Enter`, botones Commit/Push/Pull/Sync
  con contadores `↑n ↓m` y selector de rama con creación incluida.
- Editor de diferencias lado a lado en el hueco del editor, con pestaña propia y cierre.

**Módulo 2 — Procesos visibles.**
- La barra superior pinta una pastilla por proceso arrancado, con su color de estado y su puerto;
  un clic enfoca su canal y un clic en el puerto abre la aplicación en el navegador.
- Cada canal de salida gana una cabecera con el nombre del proyecto, su insignia de tipo (Web API,
  Blazor, CLI…), el estado, el enlace HTTPS y botones para reiniciar o detener **sólo ese** proceso.

**Módulo 3 — Verbosidad de la CLI de .NET.**
- Ajuste nuevo con los cuatro niveles y su traducción a argumentos y variables de entorno
  (ADR-022), aplicada también al entorno del proceso que lanza el depurador.

**Módulo 4 — Estado del asistente de IA.**
- `src/renderer/ai-availability.ts` y ADR-023: icono atenuado, sin navegación y con el mensaje
  "El asistente de IA está deshabilitado. Puedes activarlo desde la configuración".

**Errores encontrados y solucionados:**
1. *Síntoma:* `commit` con el índice vacío devolvía "El commit ha fallado" en vez de "no hay nada
   preparado".
   *Causa raíz:* la detección buscaba `nothing to commit` en la salida de git, y en un Windows en
   español git responde en español. Una regex sobre mensajes traducidos es una bomba de relojería.
   *Arreglo:* se decide mirando el índice **antes** de llamar a git. Lo destapó la prueba contra un
   repositorio real (`tests/unit/git-service.test.mjs`), no un usuario.
2. *Síntoma:* la acción de diagnóstico `--ui=` no hacía nada al arrancar con una solución abierta.
   *Causa raíz:* pulsaba a los 3,2 s fijos, y con un workspace abierto la interfaz todavía está
   cargando Monaco y leyendo la solución: el control aún no existía. Sin error, sin aviso y sin
   efecto — el peor tipo de fallo.
   *Arreglo:* `--ui-wait=<ms>` para la pulsación y `--wait=<ms>` para la medida o la captura.
3. *Síntoma (evitado):* la fila de archivo llamaba a `openFile` con la ruta **relativa** al
   repositorio.
   *Causa raíz:* la raíz del repositorio no tiene por qué ser la carpeta abierta (un monorepo, o
   abrir una subcarpeta).
   *Arreglo:* la raíz viaja dentro del estado (`GitRepositoryStatus.root`) y la vista compone la
   ruta absoluta con ella.
4. *Síntoma:* añadir el icono de control de fuentes rompió `--ui=settings`, `--ui=ai` y compañía.
   *Causa raíz:* esas acciones pulsan por índice posicional dentro de `.activity-item`.
   *Arreglo:* índices actualizados y el orden de la barra escrito en un comentario justo encima,
   para que la próxima herramienta que se añada no vuelva a romperlos en silencio.
5. *Aviso del entorno:* en Windows, `core.autocrlf` devuelve el archivo restaurado con CRLF aunque
   el blob esté en LF. Comparar byte a byte en la prueba comprobaba la configuración de git del
   equipo, no el servicio: se normaliza antes de comparar.

**Verificado sobre la aplicación real** (con `--ui=`, `--probe=` y una solución generada de verdad):
- Panel de git sobre este mismo repositorio: `{"title":"Control de código fuente","branch":"master",
  "sections":["Cambios preparados","Cambios"],"counts":["0","27"]}`, con la letra correcta por
  archivo.
- Comparación abierta desde el panel: `diffVisible: true`, pestaña
  `debug-controller.ts (Índice ↔ Local)` y dos modelos `dotforge-diff:` de 313 y 333 líneas — el
  lado izquierdo sale del índice y el derecho del disco.
- Perfil multiproyecto de una solución hexagonal generada al vuelo (net10.0, Web + Blazor):
  pastillas `Adapters.Web:5585` y `Adapters.Blazor:5587` en verde y cabecera de canal
  `Adapters.Blazor · Blazor · En ejecución · https://localhost:5587`.
- Verbosidad en `detailed`: el comando que aparece en la salida es
  `❯ dotnet watch --verbose --project …`, no `--verbosity detailed` — que es justo lo que exige la
  CLI de watch.
- Asistente apagado desde Ajustes: `class="activity-item disabled"`, `aria-disabled="true"`,
  `opacity: 0.38`, el tooltip exacto y el clic sin efecto (`blocked: true`); al volver a
  encenderlo, el icono recupera su comportamiento normal.
- `npm test` en verde de punta a punta: **694 pruebas** (540 unit, 41 security, 57 package, 56
  scaffold), de las cuales 98 son nuevas de esta fase. `--smoke-test` → `SMOKE_OK`.
- Empaquetado real: `npm run dist:win` → `DotForge IDE-1.5.0-Setup-x64.exe` (117,3 MB) y
  `DotForge IDE-1.5.0-win-x64.zip` (161,6 MB); la poda liberó los 279,0 MB de la 1.4.0 antes de
  empaquetar y `verify:dist --require win` termina sin problemas (sin firmar, como corresponde sin
  certificado).

**Versión:** funcionalidad nueva, con contratos IPC nuevos y sin romper nada de lo anterior:
1.4.0 → **1.5.0** (ADR-009).

---

### ADR-025 — El esquema se deduce de las migraciones; el IDE no se conecta a la base de datos
**Fecha:** 2026-08-23
**Contexto:** El panel de datos tiene que enseñar tablas y columnas. La forma obvia es conectarse
a la base de datos y leer su catálogo.
**Opciones:** (a) conectar de verdad, con un driver por motor (SQL Server, PostgreSQL, MySQL,
SQLite); (b) pedírselo a `dotnet ef dbcontext info`, que sólo da el proveedor y la cadena;
(c) leer los archivos de migración del repositorio y aplicar sus operaciones en orden.
**Decisión:** (c), y decirlo en el propio panel: el rótulo es "Esquema deducido".
**Consecuencias:** cero dependencias nativas (la regla del proyecto), cero credenciales pedidas al
usuario y funciona con la base de datos apagada, que es el estado normal a media mañana. A cambio,
lo que se ve es el esquema **según el repositorio**, no según el servidor, y una migración que
ejecuta `migrationBuilder.Sql(...)` es opaca: se cuenta aparte y el panel avisa de cuántas hay.
Es un análisis de texto de C# generado por herramientas, no de C# escrito a mano, así que la
gramática que hay que cubrir es pequeña y estable.

### ADR-026 — El cliente HTTP usa `node:http`, y el certificado autofirmado sólo vale en localhost
**Fecha:** 2026-08-23
**Contexto:** Enviar la petición de un archivo `.http` contra una API en desarrollo. `fetch` está
disponible en el proceso principal y sería lo natural.
**Decisión:** `node:http` / `node:https`, con `rejectUnauthorized: false` **únicamente** cuando el
host es `localhost`, `127.0.0.1` o `::1`.
**Consecuencias:** el certificado de desarrollo de ASP.NET Core es autofirmado y `fetch` lo rechaza
sin que el usuario pueda hacer nada desde el IDE; probar la propia API acabaría siendo imposible.
Al acotar la excepción a la máquina local, un certificado inválido en un host remoto sigue siendo
un error —que es lo correcto— y la excepción no se puede ampliar desde el renderer, porque la
decisión se toma en el proceso principal a partir de la URL ya parseada. De propina se ganan los
redireccionamientos seguidos a mano con tope y aviso de la URL final, y un tiempo medido que
distingue "no ha respondido" de "ha respondido un 500".

### ADR-027 — Las lentes de código de endpoints se calculan por texto, no por el LSP
**Fecha:** 2026-08-23
**Contexto:** Para pintar "Probar GET /api/products" sobre un endpoint hay que saber dónde están
los endpoints. Roslyn lo sabe con exactitud.
**Decisión:** análisis de texto acotado (`src/shared/api-endpoints.ts`), no una consulta al LSP.
**Consecuencias:** la lente aparece mientras se escribe, con el servidor de lenguaje arrancando,
degradado o apagado, y en archivos que todavía no compilan — que es justo cuando se está
escribiendo un endpoint. El precio es equivocarse de vez en cuando, y se elige equivocarse **de la
forma barata**: ofrecer una prueba de más nunca rompe nada, mientras que no ofrecer ninguna hace
invisible la funcionalidad. Se cubren las dos formas que existen hoy (Minimal API con `MapGroup` y
controladores con `[Route("api/[controller]")]`), y cada una tiene sus pruebas.

---

### Iteración 15 — 2026-08-23 — Fase 12: EF Core visual y cliente HTTP
**Objetivo:** quitar las dos razones que quedaban para abrir una terminal o un Postman: gestionar
migraciones y probar un endpoint.

**Módulo 1 — Gestor de Entity Framework Core.**
- `src/shared/efcore.ts`: modelo puro. Extracción del bloque `//BEGIN … //END` que las herramientas
  de EF envuelven alrededor de su JSON, migraciones con su estado y su fecha, contextos,
  construcción de argumentos por operación y lectura de cadenas de conexión de un `appsettings.json`
  con comentarios y comas colgantes (que los tiene, siempre).
- `src/shared/efcore-schema.ts`: tablas y columnas deducidas de las migraciones (ADR-025), con un
  lector de paréntesis equilibrados que respeta las cadenas de C#, claves primarias simples y
  compuestas, índices, y `AddColumn`/`DropColumn`/`RenameTable` aplicados en orden.
- `src/main/services/efcore-service.ts`: lectura con `execFile` (el panel necesita el resultado) y
  escritura con `spawn` por el canal de tareas (el panel necesita ver qué pasa durante dos minutos).
- `src/renderer/views/efcore.ts`: panel con selector de proyecto y de proyecto de arranque, lista de
  migraciones aplicadas/pendientes, esquema navegable y cadenas de conexión con la contraseña tapada.

**Módulo 2 — Cliente HTTP integrado.**
- `src/shared/http-file.ts`: parser del formato `.http`/`.rest` con separadores `###`, variables
  `@nombre = valor`, variables dinámicas y resolución con dobles llaves.
- `src/renderer/languages/http.ts`: gramática Monarch del lenguaje `http`.
- Lente "Enviar petición" sobre cada bloque y pestaña "HTTP" en el panel inferior con estado,
  tiempo, tamaño, cuerpo reindentado, cabeceras e historial de las últimas 20.
- `src/shared/api-endpoints.ts` + lente sobre cada endpoint de C# que genera —**añadiendo**, nunca
  sobrescribiendo— la petición en el `.http` del proyecto, con la URL base tomada del proceso que
  esté corriendo si lo hay.

**Errores encontrados y solucionados:**
1. *Síntoma (evitado a tiempo):* la primera versión de la gramática entraba en un estado `url` tras
   el verbo y lo cerraba con una regla de fin de línea.
   *Causa raíz:* los estados de Monarch **sobreviven al salto de línea**; una regla de longitud cero
   al final de la línea no llega a evaluarse, así que el estado no se cerraba nunca y todas las
   cabeceras siguientes se pintaban como URL.
   *Arreglo:* una sola regla por línea de petición, con grupos de captura. Sin estados, sin fuga.
2. *Síntoma:* el panel enseñaba "Could not execute because the specified command or file was not
   found." sin decir qué hacer.
   *Causa raíz:* es el mensaje de `dotnet` cuando la herramienta `dotnet-ef` no está instalada, y se
   estaba propagando tal cual.
   *Arreglo:* si la CLI falla **y no ha llegado a emitir su bloque JSON**, se añade la orden de
   instalación. Es una decisión de estado, no una regex sobre un mensaje traducido (misma lección
   que el `nothing to commit` de la iteración anterior).
3. *Síntoma:* `el bundle del renderer no incrusta Monaco` se puso en rojo al añadir dos vistas.
   *Causa raíz:* la prueba usaba un tope absoluto de 400 KB como proxy de "Monaco no está dentro";
   el renderer creció legítimamente hasta 415 KB.
   *Arreglo:* la prueba ahora comprueba lo que dice comprobar — que el bundle es un orden de
   magnitud más pequeño que la carpeta `vendor/monaco` que dice no incrustar — y deja un tope
   absoluto de cordura muy por encima.
4. *Síntoma:* los botones del panel enseñaban "Actualizar ...", "Quitar la ú...".
   *Causa raíz:* la barra lateral mide 240 px y tres botones con rótulo no caben.
   *Arreglo:* un botón con rótulo corto y dos de icono con la frase entera en el `title`.

**Verificado sobre la aplicación real** (solución `Acme.Shop` generada al vuelo con `--db sqlite`):
- `--ui=efcore`: el panel elige solo `Acme.Shop.Infrastructure` como proyecto con migraciones y
  `Acme.Shop.WebApi` como proyecto de arranque, y lista las tres secciones. Sin `dotnet-ef`
  instalado en esta máquina, el aviso incluye la orden de instalación, que es el comportamiento
  buscado.
- `--ui=http` sobre un `.http` real: resaltado correcto de separador, verbo, URL, cabeceras y cuerpo
  JSON; lente "Enviar petición" sobre cada bloque; pestaña HTTP en el panel; el archivo aparece en
  el explorador con su icono propio y la barra de estado dice `http`.
- El envío de verdad se comprueba en la suite: cinco pruebas contra un servidor levantado en el
  propio test (cuerpo, cabeceras, redirección 301, 404 y puerto cerrado).
- `npm test` en verde de punta a punta: **776 pruebas** (622 unit, 41 security, 57 package, 56
  scaffold), de las cuales 82 son nuevas de esta fase. `prune:dist` liberó los 279,0 MB de la 1.5.0
  y `verify:dist` termina sin problemas.

**Versión:** funcionalidad nueva con contratos IPC nuevos, sin romper nada anterior:
1.5.0 → **1.6.0** (ADR-009).

---

### ADR-028 — El registro se parsea por formato, no por regex sobre palabras traducidas
**Fecha:** 2026-08-23
**Contexto:** El visor de registro tiene que entender la salida de una aplicación .NET real, que
mezcla en el mismo flujo la consola de `Microsoft.Extensions.Logging` (arranque del host), Serilog
(cuando toma el control) y, si alguien lo configuró, NLog o JSON compacto.
**Decisión:** un parser por formato, todos probados con capturas reales, y **ninguna decisión
basada en una palabra traducible**. En particular, un marco de pila se reconoce por su forma
—firma de método, ruta que acaba en `.cs` y número al final— y no por las palabras `at` y `line`,
que en un Windows en español son `en` y `línea`.
**Consecuencias:** el visor funciona en cualquier idioma del sistema y con los cuatro formatos
mezclados en la misma salida. Lo que no encaja con ningún formato **sigue apareciendo** como
evento de nivel informativo: un visor que se come la mitad de la salida es peor que no tener
visor. Es la tercera vez que este proyecto tropieza con lo mismo (los mensajes de git, el de
`dotnet ef`), y por eso está escrito como decisión y no como comentario.

### ADR-029 — El linter de arquitectura calla ante la duda
**Fecha:** 2026-08-23
**Contexto:** El linter clasifica cada proyecto en una capa por su nombre. ¿Qué hace con
`Acme.Shop.Utilidades`, que no encaja en ninguna?
**Opciones:** (a) asignarle la capa más parecida; (b) tratarlo como parte del núcleo y ser
estricto; (c) dejarlo sin clasificar y no decir nada sobre él.
**Decisión:** (c). Y lo mismo con una solución cuya arquitectura no se reconoce: cero avisos.
**Consecuencias:** el linter nunca denuncia lo que no entiende, que es la única forma de que la
gente no lo apague el primer día. El precio es que un proyecto con un nombre poco convencional se
queda sin vigilar; se prefiere ese fallo al contrario. Los avisos son **siempre `warning`**, nunca
`error`: una violación de arquitectura no impide compilar, y pintarla en rojo junto a los errores
reales del compilador enseñaría a ignorar los dos. Y viven en su propio propietario de marcadores
de Monaco, para que una compilación correcta no los borre: el código compila y sigue rompiendo la
regla.

### ADR-030 — El contexto del autocompletado se pide entero y de una vez
**Fecha:** 2026-08-23
**Contexto:** Sugerir contenedores de Docker, imágenes y scripts de `package.json` obliga a salir
del renderer, que no puede ejecutar nada.
**Decisión:** un único canal (`terminal:context`) que devuelve todo resuelto, invocado al abrir una
solución y al mostrar la terminal — **nunca por pulsación de tecla**.
**Consecuencias:** el motor de sugerencias sigue siendo una función pura sin E/S, que es lo que
permite probarlo entero con Node pelado. Cada llamada lanza un `docker ps`, así que atarlo a las
pulsaciones habría significado un proceso por tecla. A cambio, la lista puede quedar unos segundos
desactualizada si se levanta un contenedor desde fuera del IDE; se resuelve volviendo a abrir la
terminal, y es un precio bajo comparado con la alternativa.

---

### Iteración 16 — 2026-08-23 — Fase 13: registro, linter de arquitectura y terminal en la nube
**Objetivo:** que las tres preguntas que obligan a salir del IDE —"¿qué ha pasado?", "¿esto rompe
la arquitectura?" y "¿cómo se llamaba ese comando?"— se respondan dentro.

**Módulo 1 — Visor de registro estructurado.**
- `src/shared/log-events.ts`: parser de los cinco formatos que salen de una solución .NET sin
  configurar nada (Serilog con plantilla corta y con marca completa, la consola de
  `Microsoft.Extensions.Logging` a dos líneas, NLog y CLEF), con las trazas pegadas al evento que
  las provocó y los marcos reconocidos por su forma (ADR-028).
- Pestaña **Registro** en el panel inferior: pastillas por nivel con su cuenta, filtro de texto,
  detalle desplegable por evento y marcos de pila **clicables** que abren el `.cs` en su línea.
- El repintado va con freno de 400 ms: una aplicación arrancando escupe cientos de líneas por
  segundo y repintar por cada una haría imposible pulsar en un marco.

**Módulo 2 — Linter de reglas de arquitectura.**
- `src/shared/architecture-rules.ts`: las reglas que el asistente sabe explicar en prosa, ahora
  comprobables. Tres vías: referencias entre proyectos (`DF1001`), `using` prohibidos con su línea
  (`DF1002`) y paquetes de infraestructura dentro del núcleo (`DF1003`).
- Se ejecuta al abrir o recargar la solución y al guardar un `.cs`. Los avisos van al panel de
  problemas y al margen del editor, en su propio propietario de marcadores (ADR-029).

**Módulo 3 — Terminal: Docker, Azure y npm.**
- `src/shared/docker.ts` + `docker-service.ts`: estado del motor leído con `--format "{{json .}}"`,
  con puertos publicados deduplicados (IPv4 e IPv6 son el mismo puerto) y las etiquetas de Compose
  ya interpretadas.
- Sugerencias nuevas: subcomandos de `docker` y `docker compose`, **contenedores reales** tras
  `docker logs`/`exec`/`stop`, **imágenes locales** tras `docker run`, los grupos de `az` que usa
  un desarrollador .NET (`webapp`, `group`, `sql`, `acr`, `containerapp`) y los **scripts del
  `package.json` de este repositorio** tras `npm run`.
- `az` entra en la lista blanca de la terminal: publicar la API que se acaba de escribir es parte
  del mismo flujo.

**Errores encontrados y solucionados:**
1. *Síntoma:* el visor de registro enseñaba `[HH:mm:ss INF] Application started` — con la hora
   literal — en una solución recién generada.
   *Causa raíz:* **la plantilla de scaffolding estaba mal desde la v1.1**: el `outputTemplate` de
   Serilog escribía `[HH:mm:ss {Level:u3}]` en vez de `[{Timestamp:HH:mm:ss} {Level:u3}]`, así que
   todas las soluciones generadas registraban la misma hora falsa en cada línea. Nadie lo había
   visto porque el resto de la línea era correcto.
   *Arreglo:* corregido en las seis plantillas y añadida una prueba que lo vigila
   (`tests/unit/blueprints.test.mjs`). Es exactamente el tipo de fallo que sólo aparece cuando una
   herramienta nueva mira de verdad lo que produce la anterior.
2. *Síntoma:* el marco de pila `at Servicio.CreateAsync(CreateProduct command) in C:\…\S.cs:line 42`
   devolvía como archivo `command) in C:\…\S.cs`.
   *Causa raíz:* el patrón buscaba "algo, espacio, algo, espacio, ruta", y los argumentos del
   método tienen espacios. Además una ruta de Windows trae sus propios dos puntos (`C:\`), que un
   patrón poco anclado confunde con el separador `:line`.
   *Arreglo:* se ancla al **último paréntesis** de la firma, que es lo único estable, y la ruta se
   exige terminada en una extensión de código.
3. *Síntoma:* `SuggestionKind` creció y la etiqueta del menú de sugerencias dejó de compilar.
   *Causa raíz:* `Record<SuggestionKind, string>` es exhaustivo a propósito.
   *Arreglo:* añadidas las tres etiquetas nuevas. El tipo hizo su trabajo: el fallo apareció al
   compilar y no en la interfaz.

**Verificado sobre la aplicación real** (solución `Acme.Logs` generada y ejecutada de verdad):
- `--ui=startup-logs`: la aplicación arranca y el visor enseña **93 eventos** con la hora real
  (`23:39:46`), 33 de nivel informativo y el resto de depuración, con las pastillas de nivel
  contando cada una.
- Violación de arquitectura introducida a mano en el `.csproj` del dominio y leída con `--probe=`:
  `DF1001 Acme.Logs.Domain referencia a Acme.Logs.Infrastructure: Dominio no puede depender de
  Infraestructura en una arquitectura Clean. — Acme.Logs.Domain.csproj:1:1`, con la insignia `1` en
  la pestaña de problemas.
- `npm test` en verde de punta a punta: **856 pruebas** (702 unit, 41 security, 57 package, 56
  scaffold), de las cuales 80 son nuevas de esta fase.

**Versión:** funcionalidad nueva, un canal IPC nuevo y una corrección en las plantillas generadas:
1.6.0 → **1.7.0** (ADR-009).

---

### ADR-031 — El compose manda, el motor confirma
**Fecha:** 2026-08-23
**Contexto:** El panel de contenedores puede construirse de dos formas: listando lo que el motor
tiene corriendo, o listando lo que el proyecto declara y pegándole el estado real.
**Decisión:** la lista sale del `docker-compose.yml` del repositorio; el motor sólo aporta el
estado de cada servicio.
**Consecuencias:** el panel **sirve con todo apagado**, que es justo cuando hace falta: enseña qué
necesita este proyecto para arrancar y da el botón para levantarlo. Al revés estaría vacío
precisamente en ese momento. La correspondencia entre servicio y contenedor se hace por la
etiqueta `com.docker.compose.service` y, en segundo lugar, por el `container_name` declarado;
**nunca por parecido del nombre**, porque dos proyectos con un servicio `redis` acabarían
intercambiándose los botones de parar. Los contenedores que no pertenecen al compose se listan
aparte, sin mezclarlos: son de otro trabajo. La regla entera vive en una función pura
(`matchComposeState`) y está probada con los casos que importan.

### ADR-032 — Parser propio de YAML para el subconjunto de Compose
**Fecha:** 2026-08-23
**Contexto:** Leer un `docker-compose.yml` exige un parser de YAML.
**Opciones:** (a) añadir `js-yaml` o `yaml` como dependencia de runtime; (b) escribir el
subconjunto que usa Compose.
**Decisión:** (b), con los límites escritos en la cabecera del archivo.
**Consecuencias:** el proyecto mantiene su regla de dependencias mínimas y auditables, y el
subconjunto —mapas anidados, listas en bloque y en línea, escalares con comillas y comentarios—
cabe en un archivo con 31 pruebas. Lo que no se soporta (anclas, bloques literales, documentos
múltiples) se degrada perdiendo detalle, nunca fallando entero: sin esas piezas la lista de
servicios sigue saliendo. El caso borde que más costó no es exótico: `- "5672:5672"` lleva dos
puntos y **no** es un mapa, es un puerto; distinguirlo exige mirar qué viene después de los dos
puntos, no si los hay.

### ADR-033 — Docker apagado no vacía el panel
**Fecha:** 2026-08-23
**Contexto:** Sin Docker instalado o con el motor parado, ¿qué enseña el panel de contenedores?
**Decisión:** los servicios declarados, con sus acciones deshabilitadas y un aviso arriba que dice
qué pasa y qué hacer.
**Consecuencias:** es la misma regla que con el asistente de IA apagado (ADR-023): una herramienta
que no está disponible se atenúa y se explica, no desaparece. Quien abre el panel con el motor
parado descubre igualmente qué necesita el proyecto —SQL Server, Redis, RabbitMQ y sus puertos—,
que es la mitad del valor de la vista.

---

### Iteración 17 — 2026-08-23 — Fase 14: contenedores y Docker Compose
**Objetivo:** que "levantar la base de datos antes de pulsar F5" sea un botón y no un viaje a otra
ventana.

**Módulo único — Panel de contenedores.**
- `src/shared/compose.ts`: parser propio del subconjunto de YAML que usa Compose (ADR-032),
  modelo de servicio (imagen o `build`, `container_name`, puertos, dependencias, perfiles) y
  construcción de los comandos de `docker compose` y de contenedor.
- `matchComposeState`: el cruce entre lo declarado y lo que corre (ADR-031), como función pura.
- `docker-service.ts`: búsqueda de archivos de Compose en la raíz y un nivel por debajo, lectura
  del archivo y ejecución transmitida por el canal de tareas, igual que EF Core.
- `src/renderer/views/containers.ts`: sexta herramienta de la barra de actividad. Cabecera con el
  archivo, el recuento `n/m arriba` y los botones Levantar / Bajar / Registro; una fila por
  servicio con su punto de estado, su icono, su nombre real ("SQL Server", no la imagen), sus
  puertos y las acciones al pasar el ratón (arrancar, parar, reiniciar, registro). Los contenedores
  ajenos al compose, en una sección aparte.
- Los puertos de lo que se abre en un navegador (Seq, RabbitMQ, MailHog) son un enlace; los de una
  base de datos, no: abrir `http://localhost:1433` no lleva a ninguna parte.

**Seguridad.** Los tres canales nuevos validan lo que llega del renderer: la ruta del compose pasa
por el guardián del workspace **y** tiene que llamarse como un archivo de Compose —sin lo segundo
sería un lector de archivos arbitrarios disfrazado—, y los nombres de servicio y de contenedor se
acotan a lo que Docker admite antes de entrar en un `argv`.

**Errores encontrados y solucionados:**
1. *Síntoma:* los puertos de un servicio salían como `[{ '"5672': '5672"' }]`.
   *Causa raíz:* el parser trataba `- "5672:5672"` como un mapa porque contenía dos puntos.
   *Arreglo:* una clave de YAML exige que tras los dos puntos venga un espacio o el fin de línea, y
   que el elemento no empiece por comilla. Con eso, un puerto vuelve a ser un puerto.
2. *Síntoma (evitado):* el panel se vaciaba entero al no encontrar Docker.
   *Causa raíz:* el estado del motor gobernaba todo el pintado.
   *Arreglo:* ADR-033. El compose se pinta igual; lo que se apaga son los botones.
3. *Decisión de diseño revisada:* la lógica de correspondencia entre servicios y contenedores
   estaba dentro de la vista, donde no se podía probar sin un Docker delante. Se sacó a
   `matchComposeState`, que es pura y tiene ocho pruebas propias — incluida la de los dos proyectos
   con un servicio `redis` cada uno.

**Verificado sobre la aplicación real:**
- `--ui=containers` con un `docker-compose.yml` de cuatro servicios y **sin Docker instalado**: el
  panel enseña el aviso "Docker no está instalado o no está en el PATH", el archivo,
  `0/4 arriba`, los botones atenuados y las cuatro filas con su nombre real y sus puertos
  (`sqlserver 1433`, `redis 6379`, `rabbitmq 5672, 15672`, `seq 5341`).
- En la misma captura siguen funcionando las dos funcionalidades de la iteración anterior: la
  barra de estado marca `⚠ 1` y la pestaña de problemas la insignia `1` del aviso de arquitectura.
- `npm test` en verde de punta a punta: **887 pruebas** (733 unit, 41 security, 57 package, 56
  scaffold), de las cuales 31 son nuevas de esta fase. `prune:dist` y `verify:dist` terminan sin
  problemas sobre la 1.8.0.

**Versión:** funcionalidad nueva con cinco canales IPC nuevos, sin romper nada anterior:
1.7.0 → **1.8.0** (ADR-009).

---

### ADR-034 — El proceso depurado es un proceso más
**Fecha:** 2026-08-24
**Contexto:** Un perfil multiproyecto en modo depuración arranca el primero con el depurador y el
resto como tareas. Los segundos tenían canal propio, pastilla, puerto y botón de parada; el
primero no tenía nada de eso, porque su salida no venía de una tarea sino de eventos del depurador
y llegaba sin `taskId`.
**Decisión:** el proceso depurado abre su canal **antes** de arrancar, como cualquier otro, y su
salida se dirige explícitamente a él (`appendDebugOutput`). El canal se marca `isDebug`, lo que le
da su propio botón de parada —que llama a `debug:stop` en vez de cancelar una tarea— y su estado
propio ("Depurando" en vez de "En ejecución").
**Consecuencias:** desaparece el canal "Compilación :5013", que era el síntoma más confuso: el
canal de compilación anunciaba el puerto de una aplicación. Además el proceso depurado gana lo que
ya tenían los demás: pastilla en la barra superior (con icono de bug), enlace a su URL, reinicio
—que vuelve a **depurar**, no a ejecutar sin depurador— y parada individual.

---

### Iteración 18 — 2026-08-24 — v1.8.1: el proceso depurado deja de esconderse en "Compilación"

**Reportado por el usuario**, con dos capturas: al lanzar un perfil `Blazor + WebApi` en modo
depuración, la barra de canales enseñaba `Compilación :5013` y `WebApi :5011`, y a la derecha un
botón `Detener WebApi` con un spinner girando para siempre. Invirtiendo el orden del perfil, los
papeles se intercambiaban — que es exactamente la pista que confirmó el diagnóstico: **el que se
descolocaba era siempre el primero, que es el que se depura** (ADR-012: una sola sesión).

**Causa raíz (1).** `onDebugOutput` llamaba a `panel.append(text, stream)` sin `taskId`, y ese
camino termina en el canal de compilación. Con él se colaba también la detección de la URL, así que
el puerto de la aplicación depurada acababa pegado al canal "Compilación".

**Causa raíz (2), descubierta al verificar el arreglo.** Abrir el canal del depurado no bastaba:
`debug:start` **empieza parando** la sesión anterior, y ese `stop` emite `idle` **antes** de
arrancar. El manejador cerraba el canal en cualquier `idle`, así que lo mataba recién abierto y la
salida volvía a "Compilación". La regla correcta —un `idle` sólo cierra si antes hubo sesión, un
`error` cierra siempre— vive ahora en `debugChannelTransition`, que es pura y tiene seis pruebas.

**Causa raíz (3).** El spinner permanente. La barra de pestañas pintaba un spinner junto a
"Detener X" para toda tarea viva. Un spinner promete que algo va a terminar; una Web API arrancada
no va a terminar. Ahora las tareas de larga duración (`run`, `watch`) llevan un punto verde —"esto
está en marcha"— y el spinner se reserva para lo que sí acaba: compilar, restaurar, probar.

**Cambios:**
- `Channel.isDebug` y `ServiceInfo.isDebug`: el canal sabe si lo gobierna el depurador.
- `startDebugChannel` / `appendDebugOutput` / `finishDebugChannel(ok)` en el panel.
- El paso `debug` del plan de arranque también llama a `registerService`, así que el proceso
  depurado tiene insignia de tipo y ruta de proyecto desde la primera línea.
- Botón de parada del canal habilitado para el depurado (llama a `debug:stop`), y botón propio en
  la barra de pestañas mientras la sesión viva.
- Reiniciar un proceso depurado vuelve a depurarlo en vez de relanzarlo como tarea suelta.
- **Por qué uno es distinto, dicho donde se ve:** icono de bug en su pastilla, estado "Depurando"
  en la cabecera de su canal, e insignia `depurado` sobre el primer proyecto del diálogo de
  perfiles cuando el modo es depuración — que es donde se decide el orden.

**Verificado sobre la aplicación real** (solución generada con `--ui both`, perfil
`Blazor + WebApi` en modo depuración):
- Barra superior: `● 🐞 Blazor` y `● WebApi`.
- Canales: `Compilación` (limpia, sin puerto), `● Blazor`, `● WebApi`.
- Cabecera del canal depurado: `Blazor · Blazor · ● 🐞 Depurando · https://localhost:5013`.
- Barra de pestañas: `● Detener WebApi` y `● Detener Blazor`, los dos con punto verde; ni un
  spinner. Comprobado además leyendo el píxel del indicador: `rgb(28, 122, 79)`.
- `npm test` en verde: **893 pruebas**, seis de ellas nuevas para la regla del canal depurado.

**Versión:** corrección de comportamiento visible, sin contratos nuevos: 1.8.0 → **1.8.1**.

### ADR-035 — La sintaxis es un código de colores, no una armonía
**Fecha:** 2026-08-24
**Contexto:** Desde la Fase 7 los colores de código se elegían dentro de un rango de saturación
estrecho, con el criterio de que ninguno "saltara" por encima del resto. El resultado era agradable
y decía poco: un tipo, un método y una variable local se distinguían por matices de azul.
**Opciones:**
- (a) mantener la paleta armónica y confiar en la forma del código para orientarse;
- (b) adoptar la jerarquía cromática de Visual Studio: verde azulado para los tipos, verde agua para
  las interfaces, dorado para lo que se invoca, azul claro para los miembros de datos, gris claro
  para lo local y púrpura para el flujo de control.
**Decisión:** (b), en los dos temas.
**Consecuencias:** el color deja de ser decoración y pasa a ser **información**: en veinte líneas de
configuración de un `Program.cs`, `WebApplication` se lee como tipo y `CreateBuilder` como llamada
sin tener que leerlas. A cambio la pantalla tiene más colores, y por eso cada uno se ha verificado
contra el fondo: el peor sobre `#1b1d27` es el comentario, con 4,93:1, por encima del mínimo AA. El
tema claro **no** usa los mismos hexadecimales: el azul de Visual Studio sobre blanco se queda en
3:1, así que cada familia tiene ahí su versión oscurecida.

### ADR-036 — Los resultados de las pruebas salen del TRX, no de la consola
**Fecha:** 2026-08-24
**Contexto:** `dotnet test` escribe por consola una línea por prueba con su estado, y es lo más fácil
de parsear. En un Windows en español esa línea dice `Con error` donde la documentación dice `Failed`.
**Decisión:** se ejecuta siempre con `--logger "trx;LogFileName=…"` y los resultados se leen del XML,
donde el estado es el nombre de una enumeración (`Passed`, `Failed`, `NotExecuted`) y no cambia con el
idioma del sistema. El parseo de la consola existe, se usa sólo si el TRX no está —el runner ha
reventado antes de escribirlo— y el resumen sale marcado como `degraded` para que la interfaz lo diga.
**Consecuencias:** es la misma decisión que con el bloque JSON de EF Core (ADR-025) y por el mismo
motivo. Además el TRX trae lo que la consola no da estructurado: la duración por prueba, el mensaje
del assert y la traza completa, que es lo que alimenta el panel de problemas. Dos detalles que
costaron una vuelta cada uno: el nombre bueno está en `TestDefinitions` y no en `testName` —en una
`[Theory]` ese campo trae los argumentos del caso—, y el TRX escribe los saltos de línea del mensaje
como `&#xD;&#xA;`, que hay que descodificar o aparecen incrustados en cada línea de la traza.

### ADR-037 — Las pruebas se descubren leyendo el código, no compilando
**Fecha:** 2026-08-24
**Contexto:** `dotnet test --list-tests` da la lista exacta, y para darla compila la solución entera.
**Decisión:** el árbol y las lentes salen de un análisis de texto de los `.cs` de los proyectos de
pruebas, igual que las lentes de endpoints (ADR-027).
**Consecuencias:** el árbol está lleno al abrir la solución y la lente aparece sobre el `[Fact]` que
se está escribiendo, en un archivo que todavía no compila. El precio es que una prueba generada por
un `[TestCaseSource]` exótico puede no aparecer hasta que se ejecute, y que se puede ofrecer ejecutar
algo que `dotnet test` dirá que no existe: el error barato. Se reconocen xUnit (`[Fact]`, `[Theory]`),
NUnit (`[Test]`, `[TestCase]`) y MSTest (`[TestMethod]`).

### ADR-038 — El monitor de contadores usa `collect`, no `monitor`
**Fecha:** 2026-08-24
**Contexto:** `dotnet-counters monitor` pinta una tabla en directo y parece la opción evidente para
un panel de métricas. Con la salida redirigida —que es la única forma de leerla desde el IDE—
revienta con una `NullReferenceException` antes de emitir un solo valor: necesita una consola de
verdad para calcular el ancho y mover el cursor.
**Decisión:** `dotnet-counters collect --format csv --output <archivo>`, y el servicio lee el archivo
de forma incremental, guardando el desplazamiento y procesando sólo hasta el último salto de línea.
**Consecuencias:** funciona sin terminal, sobrevive a que la herramienta esté escribiendo una fila
justo cuando se lee, y el CSV es un formato estable que además sirve para pegar una captura en una
prueba. El archivo vive en el directorio temporal y se borra al parar la sesión. De paso apareció lo
que de verdad importaba: **desde .NET 9 los contadores tienen otros nombres**. Los EventCounters
clásicos (`CPU Usage`, `GC Heap Size`) dan paso a las métricas del `Meter` de `System.Runtime`
(`dotnet.process.cpu.time`, `dotnet.gc.collections[gc.heap.generation=gen0]`), con unidad declarada y
etiquetas. Se soportan las dos familias: con sólo la primera el panel se quedaba vacío justo en el
framework que este IDE targetea.

### ADR-039 — A Roslyn hay que abrirle la solución
**Fecha:** 2026-08-24
**Contexto:** Al conectar el proveedor de tokens semánticos apareció que el servidor devolvía `null`.
Al comprobarlo, devolvía `null` **a todo**: hover, completado, símbolos. Y sin embargo el handshake
terminaba bien y la barra de estado decía "Roslyn LanguageServer listo".
**Causa:** `initialize` le dice al servidor dónde está la carpeta, pero no qué proyectos cargar. Su
espacio de trabajo se llena con dos notificaciones que **no son parte de LSP**: `solution/open` y
`project/open`. Sin ellas el servidor arranca, contesta al handshake y no sabe nada de ningún archivo.
**Decisión:** en cuanto termina el handshake se le abre la solución (o la lista de proyectos si no hay
`.sln`), y su stderr deja de tragarse: va a la consola del proceso principal.
**Consecuencias:** es el fallo más difícil de ver de este proyecto, porque por fuera parecía que
funcionaba. La regla que queda escrita es más general que el arreglo: **un servidor que responde
"listo" no está diciendo que sepa nada**, y un proveedor que devuelve siempre vacío es indistinguible
de uno que funciona si nadie mira el error. Por eso ahora se registra.

### ADR-040 — La versión del servidor de Roslyn se fija; no se elige sola
**Fecha:** 2026-08-24
**Contexto:** El feed `vs-impl` publica **763 versiones** de `Microsoft.CodeAnalysis.LanguageServer`
para `win-x64`, y **ninguna es estable en el sentido de SemVer**: todas llevan sufijo de
prelanzamiento, porque son las compilaciones internas con las que se sirven Visual Studio y la
extensión de C# de VS Code. Conviven bandas ya publicadas (`4.14.0-3.*`), la rama principal sin
publicar (`5.4.0-2.*`) y hasta compilaciones declaradas de prueba (`5.3.0-2-test.*`). Coger "la más
alta" —que es lo que hacía `pickLatestVersion`— significa coger cada día la compilación de anoche
de la rama principal de Roslyn, sin que nadie la haya ejecutado nunca contra este IDE.
**Decisión:** manda `ROSLYN_PINNED_VERSION`, hoy `4.14.0-3.26423.7`. "Verificada" significa que se ha
descargado, extraído y arrancado a mano, y que ha compuesto su gráfico MEF y contestado por stdio.
Si el feed dejara de publicarla, se coge la más alta que no declare marcadores de inestabilidad
(`test`, `preview`, `alpha`, `beta`, `rc`…), y sólo si no queda ninguna se acepta una de ésas antes
que dejar al usuario sin servidor. La selección devuelve también **por qué** eligió lo que eligió.
**Consecuencias:** el desempate no lo ganó el número más alto sino el `runtimeconfig.json`:
`4.14.0-3.26423.7` declara `net9.0` con `rollForward: Major`, así que arranca con el runtime 9 **o**
con el 10; las bandas 5.x declaran `net10.0` y dejarían sin servidor a quien tenga instalado justo
el .NET 9 que este IDE pide como mínimo. La versión fijada existe para los seis RID soportados,
comprobado contra el feed. El precio es que actualizarla es un cambio de código deliberado, con su
verificación a mano —que es exactamente lo que se quería—.

### ADR-041 — Una instalación se verifica archivo a archivo, no con un marcador
**Fecha:** 2026-08-24
**Contexto:** Este ADR nace de encontrar la causa real del fallo que la v1.9 dio por diagnosticado.
El IntelliSense de C# **nunca** funcionó en la máquina de desarrollo: Roslyn moría componiendo su
gráfico MEF con un `PartDiscoveryException` sobre `Microsoft.CodeAnalysis.CSharp.Features.dll`, y se
concluyó que el paquete del feed estaba roto. No lo estaba. El `.nupkg` es correcto, su SHA-256
coincide con el del feed y nuestro propio extractor lo descomprime bien cuando se le vuelve a pedir.
Lo que estaba mal era **un archivo de los 462 extraídos**, truncado en disco a 5.242.880 bytes
exactos —5 MiB clavados— cuando el ZIP declara 6.396.176. Extraído de nuevo, el mismo paquete y la
misma versión arrancan sin un solo `fail:`.
**Causa de que durase nueve versiones:** lo único que se guardaba tras extraer era un `.dotforge-ok`
con la versión y el SHA-256 **del `.nupkg` descargado**. Eso verifica el archivo que ya no está en
el disco y no dice una palabra de los 462 que sí están. Como el marcador decía "ok", nadie volvió a
mirar aquel directorio jamás.
**Decisión:** al extraer se escribe un manifiesto con **tamaño y hash de cada archivo**, y siempre
**el último**, para que una extracción interrumpida deje un directorio sin manifiesto —y un
directorio sin manifiesto se reinstala entero—. Hay dos comprobaciones con costes muy distintos: la
superficial (un `stat` por archivo, milisegundos) se hace en **cada arranque**; la profunda (releer y
hashear los ~250 MB) sólo cuando el servidor ya ha fallado. Además, el extractor se niega a escribir
un archivo cuyo inflate no mida lo que declara el directorio central, y la descarga comprueba
`content-length`.
**Consecuencias:** la comprobación barata es la que habría cazado esto el primer día. Las cachés de
la v1.9 y anteriores no tienen manifiesto, así que cuentan como no verificadas y se reinstalan solas
la primera vez que se abre la v2.0: el usuario no tiene que borrar nada a mano. Los archivos **de
más** no son un problema —el servidor escribe sus registros y cachés dentro de su directorio—.
**Aplica a todo el toolchain, no sólo al servidor de lenguaje.** NetCoreDbg se instalaba con el mismo
marcador, y ahí el fallo se manifestaría peor: un ensamblado de Roslyn truncado al menos deja un
`PartDiscoveryException` en el registro, mientras que un `netcoredbg.exe` cortado no da ningún error
legible —da una sesión de depuración que no arranca—. Los dos adquisidores pasan ahora por
`installArchive` / `verifyInstall`, y una prueba de seguridad comprueba que ninguno vuelva a
declararse un `MARKER` propio.

### ADR-042 — Un servidor roto se detecta por stderr y por nombre de tipo, nunca por el mensaje
**Fecha:** 2026-08-24
**Contexto:** Hacía falta decidir cuándo dar por muerto a Roslyn. El caso real es traicionero: el
servidor **no se cae** cuando MEF no compone. Escribe el error por stderr, sigue vivo, contesta al
handshake y anuncia "Language server initialized" por stdout. Lo que queda es un servidor que
responde `null` a todo con la barra de estado diciendo "listo".
**Decisión:** tres reglas. **(1)** Se mira stderr, no el código de salida —el proceso termina con 0—.
**(2)** Se buscan **nombres de tipo de excepción** (`PartDiscoveryException`, `TypeLoadException`,
`BadImageFormatException`…), nunca mensajes: el mensaje de este mismo fallo sale en español en un
Windows en español —"No se pudo cargar el ensamblado […] para su análisis"—, y el paquete trae trece
culturas. **(3)** El nombre sólo cuenta dentro de un bloque de nivel `fail:` o `crit:`, porque el
servidor registra por stderr cosas informativas que mencionan rutas que no existen. A eso se suma
que **un cierre que nadie ha pedido es un fallo aunque el código sea 0**, para el caso de la ADR-043.
**Consecuencias:** el escáner lleva búfer de líneas porque los trozos de un stream no respetan los
saltos: `PartDiscoveryEx` + `ception:` es una lectura perfectamente normal, y sin búfer el fallo se
detecta de forma intermitente, que es la peor forma de no detectarlo. Se prueba troceándolo carácter
a carácter. `OutOfMemoryException` queda deliberadamente fuera: habla de la máquina, no del paquete,
y vetar una versión por un pico de memoria dejaría ese equipo sin Roslyn para siempre.

### ADR-043 — A `workspace/configuration` se le contesta con un array, no con `null`
**Fecha:** 2026-08-24
**Contexto:** Con la instalación ya sana y la versión fijada, Roslyn seguía sin servir: cargaba, decía
"listo" y a los pocos segundos se apagaba con código 0, sin una línea en stderr. Reproducido con un
cliente LSP mínimo fuera del IDE, el diálogo es claro: al abrir la solución el servidor pide
`workspace/configuration` con treinta y tantas secciones de opciones
(`csharp|completion.dotnet_show_name_completion_suggestions` y compañía), su handler hace
`Contract.ThrowIfNull` sobre la respuesta, levanta `InvalidOperationException: Unexpected null`,
escribe "Error processing queue, shutting down" y se despide.
**Causa:** en LSP el tráfico va en los dos sentidos, y esto se olvida porque el 99 % de los mensajes
salen del editor. DotForge contestaba `null` a **toda** petición del servidor, con el razonamiento
correcto —no dejarlo bloqueado— y una respuesta que para ésta es inválida.
**Decisión:** lo que se contesta lo decide `src/shared/lsp-protocol.ts`, que es puro. A
`workspace/configuration` se le devuelve un array con **una entrada por elemento pedido**, con valor
`null` en cada una: significa "no tengo configurado eso, usa tu valor por defecto", que es
exactamente la verdad. El resto de peticiones siguen con `null`, que para ellas es su respuesta
correcta (`client/registerCapability`, `window/workDoneProgress/create`,
`workspace/_roslyn_projectNeedsRestore`).
**Consecuencias:** con esto la solución carga sus cinco proyectos, llega
`workspace/projectInitializationComplete` y `textDocument/semanticTokens/full` empieza a devolver
datos. Lo que importa del array es el **tamaño**: el servidor empareja secciones y respuestas por
posición. Y la lección general, que es la tercera de la misma familia en este proyecto: **contestar
algo no es contestar bien**, y un servidor que se apaga limpiamente puede estar diciendo que se le ha
contestado mal.

### ADR-044 — Cuarentena por versión y RID, con indulto si la culpa era de la copia
**Fecha:** 2026-08-24
**Contexto:** Cuando Roslyn falla en marcha hay que hacer dos cosas: dar servicio ya —OmniSharp— y
no repetir mañana el mismo intento. Pero "no repetir" exige saber **de quién era la culpa**, y las
dos causas se ven igual desde fuera (el mismo `PartDiscoveryException`) y se arreglan al revés: una
copia corrupta se borra y se vuelve a bajar; una compilación mala se veta. Vetar una versión buena
por un archivo que se truncó al escribirlo dejaría ese equipo sin Roslyn para siempre —que es justo
lo que la v1.9 estuvo a punto de dejar escrito en el código—.
**Decisión:** ante un fallo se audita la instalación entera, hash a hash (ADR-041). Si sale corrupta,
se **borra** la copia y se le **levanta el veto** a la versión. Si sale íntegra, la culpa es de la
compilación y la versión entra en cuarentena, anotada por RID: que esté rota para `win-x64` no dice
nada de `osx-arm64`, y el archivo viaja si el usuario sincroniza su perfil. En los dos casos se
conmuta a OmniSharp en el momento y el motivo aparece en la barra de estado.
**Consecuencias:** la cuarentena tiene tope de 50 entradas, porque es una lista de fallos y no un
historial. El selector de la ADR-040 la lee como lista de vetados, así que un equipo con una
compilación rota baja solo a la siguiente candidata en el arranque siguiente, sin intervención.

---

### Iteración 19 — 2026-08-24 — Fase 15: pruebas, color, túneles, métricas y seguridad

**Objetivo:** cerrar el hueco entre "el IDE compila y ejecuta" y "el IDE me dice cómo va": qué
pruebas fallan, qué es cada símbolo del código, cuánto está gastando la aplicación, qué paquetes
tienen avisos y cómo abrir el puerto local a un webhook.

**Cinco módulos, todos con su modelo puro aparte:**

- `src/shared/semantic-tokens.ts` — la codificación relativa de LSP y la normalización de los
  nombres de clasificación de Roslyn (`class name`, `keyword - control`, `xml doc comment - text`)
  a un conjunto pequeño de ámbitos con significado visual.
- `src/shared/test-explorer.ts` — descubrimiento de pruebas por texto, árbol, filtros de VSTest y
  lectura de resultados; `src/main/services/test-service.ts` recorre el disco y lanza `dotnet test`.
- `src/shared/dev-tunnel.ts` — argumentos de `devtunnel` y `ngrok`, y el escáner que reconoce la URL
  pública con búfer de líneas.
- `src/shared/perf-counters.ts` — las dos generaciones de nombres de contador, las transformaciones
  (bytes a MB, segundos de CPU a por ciento) y la geometría del gráfico.
- `src/shared/nuget-audit.ts` — el JSON de `dotnet list package --vulnerable` y la tabla degradada.

**Errores encontrados y solucionados:**

1. *Síntoma:* el resaltado semántico no pintaba nada aunque el servidor dijera "listo".
   *Causa raíz (1):* las listas `tokenTypes` y `tokenModifiers` de las capacidades del cliente iban
   **vacías** desde la Fase 2. Para LSP eso significa "no entiendo ningún tipo de token", así que un
   servidor correcto no manda ninguno.
   *Causa raíz (2):* aun con las capacidades bien, Roslyn seguía devolviendo `null` — y no sólo a los
   tokens: a hover, a completado y a símbolos. Le faltaba la notificación `solution/open` (ADR-039).
   *Arreglo:* las dos cosas, más registrar el stderr del servidor para que un fallo así no vuelva a
   ser invisible.
2. *Síntoma:* con el proveedor registrado, un archivo abierto se quedaba con los colores de la
   gramática aunque el servidor cargara después.
   *Causa raíz:* Monaco pide los tokens **una vez** por versión del documento; si la respuesta llega
   vacía no vuelve a preguntar hasta que se escriba en el archivo.
   *Arreglo:* el proveedor expone `onDidChange` y se dispara al llegar la leyenda y al recibir
   `workspace/projectInitializationComplete`.
3. *Síntoma:* el panel de métricas no enseñaba nada con una sesión en marcha.
   *Causa raíz:* `dotnet-counters monitor` revienta con la salida redirigida (ADR-038).
   *Arreglo:* `collect --format csv` leyendo el archivo de forma incremental.
4. *Síntoma:* con eso arreglado, el panel seguía vacío contra una Web API en net10.0.
   *Causa raíz:* .NET 9 sustituyó los EventCounters por el `Meter` de `System.Runtime`, con nombres
   nuevos, unidades declaradas y etiquetas.
   *Arreglo:* la tabla de contadores reconoce las dos familias y declara qué transformación necesita
   cada una. Las generaciones del GC se distinguen por su etiqueta, no por el nombre.
5. *Síntoma:* la traza de una prueba fallida aparecía con `&#xD;` incrustado en cada línea.
   *Causa raíz:* el parser de XML traduce las entidades con nombre, no las referencias numéricas, y
   el TRX escribe los saltos de línea como `&#xD;&#xA;`.
   *Arreglo:* descodificación explícita, con su prueba.
6. *Síntoma:* la primera visita a la pestaña de métricas decía "sin procesos .NET" con tres
   corriendo.
   *Causa raíz:* el panel se pinta al pulsar su pestaña, y ahí todavía no se había preguntado nada.
   *Arreglo:* la primera pintada dispara la consulta.
7. *Decisión de herramienta:* `--probe=` envuelve ahora la expresión en `Promise.resolve`. Sin eso no
   se puede medir nada asíncrono —una llamada IPC, una petición al servidor de lenguaje— porque
   serializar una promesa imprime `{}`. Es lo que permitió diagnosticar el punto 1.

**Verificado sobre la aplicación real** (solución `Acme.Lab` generada con el propio scaffolding,
net10.0, con su Web API arrancada):

- Explorador de pruebas: **13 pruebas descubiertas** en dos clases sin compilar nada; `Ejecutar
  todas` deja `12 correctas · 1 con error · 0 omitidas`, la prueba rota en rojo con
  `Assert.Equal() Failure: Strings differ / Expected: "Teclado roto" / Actual: "Teclado mecánico"`,
  su traza con `ProductTests.cs:line 15`, insignia `1` sobre el icono de pruebas y `1` en la pestaña
  de problemas.
- Colores: con datos de clasificación, `WebApplication` se pinta `rgb(78, 201, 176)` (#4EC9B0) y
  `CreateBuilder` `rgb(220, 220, 170)` (#DCDCAA), leídos del estilo calculado, no de una captura.
- Métricas: `Monitorizando Acme.Lab.WebApi`, grupos Proceso / Memoria / Recolección de basura y —con
  tráfico— HTTP; `Montón administrado 26 MB`, `Conjunto de trabajo 130 MB`, `Reserva 0,9 MB/s` y diez
  gráficos de tendencia.
- Auditoría: sobre la solución limpia, "Sin vulnerabilidades conocidas"; tras añadir
  `Newtonsoft.Json 12.0.1`, cinco filas `Alta` con `GHSA-5CRP-9R3C-P9VR`, marcando cuál es directa y
  cuáles transitivas, e insignia `5` sobre el icono de NuGet.
- Túnel: sin herramienta instalada, `▲ No hay ninguna herramienta de túnel instalada. Instala una:
  winget install Microsoft.devtunnel · winget install ngrok.ngrok`.
- `npm test` en verde de punta a punta: **1058 pruebas** (904 unit, 41 security, 57 package, 56
  scaffold), de las cuales 165 son nuevas de esta fase. `prune:dist` liberó los artefactos de la
  1.8.0 y `verify:dist` confirma el instalador y el ZIP de la 1.9.0.

**Limitación conocida, con diagnóstico.** En esta máquina el servidor de Roslyn arranca, contesta al
handshake y muere al componer su gráfico MEF:
`PartDiscoveryException: Could not find assembly Microsoft.CodeAnalysis.CSharp.Features, Version=5.4.0.0 … in any extension context`.
Se reproduce lanzando el ejecutable a mano, fuera del IDE, y no depende de la ruta ni de la caché de
composición. Es un fallo del paquete `microsoft.codeanalysis.languageserver.win-x64 5.4.0-2.26179.14`
del feed `dotnet-tools`, anterior a esta fase, y por eso el IntelliSense de C# nunca ha devuelto
datos en este equipo. Todo lo que depende del IDE está hecho y verificado —capacidades, leyenda,
descodificación, proveedor y colores— y el resaltado semántico se enciende solo el día que el
servidor conteste. Fijar una versión conocida buena del servidor queda anotado para la Fase 16.

**Versión:** funcionalidad nueva con once canales IPC nuevos y una corrección de comportamiento
visible en el resaltado: 1.8.1 → **1.9.0** (ADR-009).

---

### Iteración 20 — 2026-08-24 — Fase 16: el IntelliSense de C# funciona

**Objetivo:** cerrar la "limitación conocida" que arrastraba la v1.9 —el servidor de Roslyn arranca
y no sirve para nada— fijando una versión estable verificada y garantizando el respaldo automático
a OmniSharp cuando el servidor falle.

**Lo primero fue descubrir que el diagnóstico anterior era falso.** La v1.9 cerró con esta frase:
*"Es un fallo del paquete `microsoft.codeanalysis.languageserver.win-x64 5.4.0-2.26179.14` del feed
`dotnet-tools`"*. No lo era, y comprobarlo costó cuatro medidas:

1. Se reprodujo el `PartDiscoveryException` lanzando el ejecutable a mano. Se confirma.
2. Se leyó el tamaño del ensamblado señalado: **5.242.880 bytes**. Cinco mebibytes clavados es una
   cifra que no sale de un compilador; sale de un archivo cortado.
3. Se descargó el `.nupkg` del feed y se leyó su directorio central: esa entrada declara
   **6.396.176 bytes**. Y el SHA-256 del paquete recién bajado coincide **exactamente** con el que
   el marcador `.dotforge-ok` guardó el día que se instaló. El paquete siempre estuvo bien.
4. Se volvió a extraer y se lanzó el servidor: compone su gráfico MEF y contesta **sin un solo
   `fail:`**. Misma versión, mismo paquete, otra copia en disco.

De los 462 archivos extraídos, exactamente **uno** había quedado truncado, y el marcador de
instalación —que sólo guardaba el hash del `.nupkg`, un archivo que ya no está en el disco— decía
"ok" desde entonces. Ése es el fallo que dejó el IntelliSense de C# muerto desde la Fase 2.

**Y con eso arreglado, el servidor seguía sin servir.** Cargaba, decía "listo" y a los pocos
segundos se apagaba **con código 0 y sin una línea en stderr**. Reproducido con un cliente LSP
mínimo de 120 líneas escrito para esto, apareció la segunda causa: Roslyn pide
`workspace/configuration` al abrir la solución, DotForge contestaba `null` a toda petición del
servidor, y su handler responde a ese `null` rompiendo su cola de mensajes y despidiéndose
(ADR-043).

**Cinco decisiones, cinco ADR:**

- **ADR-040** — la versión se fija (`4.14.0-3.26423.7`) en vez de coger la más alta de las 763 del
  feed, que es la compilación de anoche de la rama principal de Roslyn.
- **ADR-041** — la instalación se verifica archivo a archivo contra un manifiesto con tamaño y hash,
  barata en cada arranque y profunda tras un fallo.
- **ADR-042** — un servidor roto se detecta por stderr y por nombre de tipo de excepción, nunca por
  el mensaje, que viene traducido.
- **ADR-043** — a `workspace/configuration` se le contesta con un array del tamaño pedido.
- **ADR-044** — una versión que falla queda en cuarentena por RID, salvo que la auditoría demuestre
  que la culpa era de la copia y no de la compilación.

**Errores encontrados y solucionados:**

1. *Síntoma:* el IntelliSense de C# nunca devolvió nada en este equipo.
   *Causa raíz:* un DLL truncado en disco que ninguna comprobación volvía a mirar (ADR-041).
   *Arreglo:* manifiesto por archivo, verificación en cada arranque y reinstalación automática. Las
   cachés de versiones anteriores no tienen manifiesto, así que se reinstalan solas.
2. *Síntoma:* con la copia sana, el servidor se apagaba con código 0 a los pocos segundos de decir
   que estaba listo.
   *Causa raíz:* `workspace/configuration` contestada con `null` (ADR-043).
   *Arreglo:* un array con una entrada por sección pedida.
3. *Síntoma:* ese cierre no disparaba ningún respaldo.
   *Causa raíz:* la detección miraba stderr, y ese fallo no escribe en stderr; y el código de salida
   era 0, indistinguible de una parada ordenada.
   *Arreglo:* el cliente marca las paradas que pide él, y un cierre que nadie ha pedido cuenta como
   fallo (ADR-042).
4. *Síntoma:* al elegir versión, el feed devuelve 763 candidatas y ninguna es estable en SemVer.
   *Arreglo:* versión fijada y verificada a mano, con descarte de las declaradas de prueba como
   camino de reserva (ADR-040). El desempate lo ganó el `runtimeconfig.json`: la banda 4.14 declara
   `net9.0` con `rollForward: Major` y arranca con el runtime 9 o el 10; las bandas 5.x exigen 10.
5. *Trampa nueva del entorno:* el argumento de `--probe=` **no puede llevar saltos de línea**. Con
   ellos el modo de diagnóstico responde `PROBE_FAIL` sin decir qué pasó, y el fallo se confunde con
   un error de la expresión. Se escriben en una sola línea.

**Verificado sobre la aplicación real** (solución `Acme.Lab` generada con el propio scaffolding,
abierta en el IDE, midiendo con `--probe=`, no mirando capturas):

- Adquisición: `[lsp] Roslyn LanguageServer 4.14.0-3.26423.7 (versión fijada por DotForge)`.
- Estado `ready`, leyenda con **82 tipos de token**, `textDocument/semanticTokens/full` devolviendo
  **1440 números**, `documentSymbol` respondiendo y completado con resultados.
- Hover real, en español y con su análisis de nulabilidad: ``(variable local) ?? builder`` y
  `"builder" no es NULL aquí`. Es la primera vez en la vida del proyecto que hay IntelliSense de C#.
- Respaldo: `acquireLanguageServer(..., { prefer: 'omnisharp' })` resuelve, instala y verifica
  **OmniSharp v1.39.15**, y contra la misma solución carga los cinco proyectos y devuelve también
  **1440 números** de tokens semánticos. La decisión de conmutar está cubierta por pruebas con el
  stderr real capturado; lo que no se ha podido montar es un Roslyn que falle **con la instalación
  íntegra**, así que ese tramo concreto está verificado por pruebas y no sobre la aplicación.
- `npm test` en verde de punta a punta: **1106 pruebas** (950 unit, 43 security, 57 package, 56
  scaffold), de las cuales 48 son nuevas de esta fase. La que estaba en rojo era del grupo de
  seguridad y tenía razón: comprobaba por grep que `acquire.ts` calculase el hash de lo descargado,
  y ese cálculo se ha mudado al instalador. Se ha reescrito para comprobar la propiedad donde ahora
  vive —y de paso la verificación de `content-length` y la de la instalación—, no para ablandarla.
  Ahora exige las tres cosas a **los dos** adquisidores, y que ninguno vuelva a declarar un `MARKER`.

- `npx electron . --smoke-test` → `SMOKE_OK`, con la línea de adquisición encima.
- Depurador: la prueba de integración descarga NetCoreDbg por el camino nuevo —su caché no tenía
  manifiesto, así que se reinstaló sola—, deja un manifiesto de **7 archivos** con el prefijo
  `netcoredbg/` descartado y `netcoredbg.exe` midiendo 2.115.072 bytes tanto en el manifiesto como
  en el disco, y con esa instalación **para en el breakpoint y lee la pila y las variables**.
- `prune:dist` liberó los 279,2 MB de artefactos de la 1.9.0 y `verify:dist` confirma el instalador
  NSIS (117,4 MB) y el ZIP portable (161,7 MB) de la 2.0.0, sin firmar como es esperado sin
  certificado.

**Versión:** el marcador de instalación cambia de formato **para todo el toolchain** —servidor de
lenguaje y depurador—, `pickLatestVersion` deja de gobernar la elección y el contrato de lo que el
cliente contesta al servidor cambia. Son cambios de comportamiento en la adquisición, y la
funcionalidad estrella del IDE pasa de no funcionar a funcionar: 1.9.0 → **2.0.0** (ADR-009).
---

### Iteración 21 — 2026-08-24 — Fase 17: actualizaciones automáticas y extensiones de Open VSX

**Objetivo:** que el IDE sepa actualizarse solo sin interrumpir a nadie, y que se puedan instalar
extensiones del registro abierto sin salir de la aplicación.

**Hecho:**

- **Actualizaciones.** Modelo puro (`src/shared/updates.ts`) con SemVer de verdad, lectura del feed
  de releases y elección del artefacto por plataforma y arquitectura; servicio
  (`updater-service.ts`) que comprueba cinco segundos después del arranque y bajo demanda, descarga
  con verificación de `content-length` y persiste lo que queda pendiente; tarjeta flotante con las
  notas de la publicación, barra de descarga y "Reiniciar y aplicar"; interruptor "Buscar
  actualizaciones automáticamente" y botón "Buscar ahora" en Ajustes.
- **Extensiones.** Cliente de Open VSX (búsqueda, categorías y ficha), instalador de `.vsix` montado
  sobre el instalador verificable del toolchain, y panel lateral con las instaladas arriba y los
  resultados del registro debajo.
- 90 pruebas nuevas: 82 unitarias y 8 de seguridad sobre las dos superficies de descarga nuevas.

**Decisiones registradas:** ADR-045 (sin `electron-updater`), ADR-046 (se aplica al cerrar, y
"Descartar" es "ahora no"), ADR-047 (host de descarga en lista blanca), ADR-048 (se instalan pero no
se ejecutan, y se dice), ADR-049 (los iconos se dibujan).

**Errores encontrados y solucionados:**

1. *Síntoma:* en Linux, la elección de artefacto se quedaba con el portable de **Windows**.
   *Causa raíz:* el filtro por extensión acepta `.zip` en las tres plataformas, y las exclusiones por
   nombre sólo estaban escritas para Windows y macOS. Un `DotForge IDE-2.2.0-win-x64.zip` pasa el
   filtro de un Linux perfectamente.
   *Arreglo:* tabla `FOREIGN_MARKERS` con las marcas de las **otras** plataformas, comprobada siempre
   y no sólo cuando la extensión es ambigua. Lo cazó la prueba antes que ningún usuario.
2. *Síntoma:* las notas de la versión salían con dos viñetas por línea.
   *Causa raíz:* `releaseNotesLines` ya convierte `- ` en `· ` —lo necesita, porque los encabezados
   no llevan marca y las viñetas sí— y encima se pintaban dentro de una `<ul>`.
   *Arreglo:* la tarjeta pinta líneas, no una lista: el modelo ya trae la marca que corresponde.
3. *Síntoma:* "Buscar ahora" contestaba `404 Not Found`.
   *Causa raíz:* el repositorio todavía no publica releases, y GitHub responde 404 a `/releases` de
   un repositorio privado o sin publicar. No es un fallo de red: es el estado normal de un producto
   que aún no ha publicado su primera versión.
   *Arreglo:* el 404 se traduce a lo que significa. El resto de códigos siguen saliendo tal cual.
4. *Trampa conocida que volvió a morder:* los índices de `--ui=` son posicionales sobre
   `.activity-item`. Añadir "Extensiones" desplazó "Ajustes" del 9 al 10 y habría roto en silencio
   `settings`, `light`, `probe-theme` y `ai-toggle`. Se actualizaron los cuatro y el comentario que
   lleva el orden escrito.

**Verificado sobre la aplicación real** (no mirando capturas: midiendo con `--probe=`):

- Búsqueda contra Open VSX de verdad: **16 920 extensiones**, con sus descargas, valoraciones y
  descripciones, pintadas en el panel.
- Instalación de un `.vsix` real de punta a punta:
  `{"id":"Shuzzy.dracula-shuzzyos","version":"1.2.1","contrib":{"supported":["temas de color"]}}`,
  descargado del registro, extraído sin el envoltorio de OPC, verificado archivo a archivo y listado
  en "Instaladas"; y desinstalado después (`removed: true`), sin dejar rastro en
  `userData/extensions/`.
- Comprobación contra el feed real: `{"status":"error","current":"2.1.0","version":null,...}` con el
  mensaje ya traducido —el repositorio no publica releases todavía—, que es la respuesta honesta y la
  que verá cualquiera que pulse "Buscar ahora" hoy.
- `--ui=update` pinta la tarjeta con un estado de ejemplo y `--ui=extensions` el panel; Ajustes sigue
  enseñando sus grupos, ahora con "Actualizaciones" entre "Lenguaje" y el asistente.
- `npx electron . --smoke-test` → `SMOKE_OK`.
- `npm test` en verde de punta a punta.
- `prune:dist` liberó los 279,2 MB de artefactos de la 2.0.0, y `verify:dist` confirma los de la
  2.1.0: instalador NSIS (117,4 MB) y ZIP portable (161,8 MB), sin firmar como es esperado sin
  certificado.

**Versión:** dos funcionalidades nuevas, compatibles hacia atrás y sin cambios de comportamiento en
lo existente: 2.0.0 → **2.1.0** (ADR-009).
---

### Iteración 22 — 2026-08-24 — Hotfix del pipeline: la suite se pone en verde en un clon limpio

**Objetivo:** que `npm test` pase en Windows y en macOS dentro de GitHub Actions. La publicación del
tag `v2.1.0` fue la primera ejecución del workflow sobre un **clon limpio**, y destapó cuatro
problemas de entorno que llevaban tiempo latentes. Ninguno venía de la Fase 17: sus 90 pruebas
pasaron en los dos runners, incluida la instalación real de un `.vsix` en disco.

Consecuencia práctica del fallo: `build-windows` y `build-macos` declaran `needs: test`, así que no
se generó ningún artefacto de la 2.1.0.

**Hecho:**

1. **CRLF (`unit`, sólo Windows).** Las plantillas se comparan con expresiones regulares que llevan
   un salto de línea dentro (la valla de código de Mermaid seguida de `flowchart`). En un clon de
   Windows, `core.autocrlf` —el valor por defecto de Git para Windows y el de los runners— entrega
   el `.tmpl` con CRLF y el patrón deja de casar. Se añade `.gitattributes` con `* text=auto eol=lf`
   y se normaliza al leer en `tests/unit/blueprints.test.mjs`, con `readTemplate()`. Las dos cosas:
   el atributo elimina la causa y la normalización hace que la prueba no dependa de la configuración
   de git de quien la ejecute.
2. **Binario de Electron (`package`, los dos runners).** `electron@43.4.1` **ya no declara script de
   instalación** —se comprobó en el paquete instalado: `scripts` es `undefined` y el descargador se
   expone como bin `install-electron`— y además npm 11 bloquea los scripts pendientes de aprobación
   (`2 packages have install scripts not yet covered by allowScripts`). El resultado es que
   `node_modules/electron/dist` no existe y la prueba de humo no tiene nada que arrancar. Se añade un
   paso explícito `node node_modules/electron/install.js` en los tres jobs, que es idempotente.
3. **Límite de la API de GitHub (`scaffold`).** `no se ha podido consultar las releases de NetCoreDbg
   (403)`. Las consultas iban sin autenticar, y ese límite es de 60 peticiones por hora **y por IP**:
   la de un runner compartido está agotada casi siempre. Se añade `src/shared/github-api.ts`, que
   decide qué cabeceras lleva cada URL y adjunta el token **sólo** a `api.github.com` (ADR-050), y se
   inyecta `GITHUB_TOKEN` en el paso `npm test`. De paso, un 403 ya no es un número suelto: dice que
   es el límite por IP y cómo salir de él.
4. **Caché de NuGet (`scaffold`, sólo macOS).** La Web API generada arrancaba y moría con
   `Could not load file or assembly 'Microsoft.EntityFrameworkCore, Version=10.0.11.0'`. El build
   tardó 7 s, que no da para una restauración fría: venía de una caché de una ejecución anterior con
   el paquete a medias —el `project.assets.json` lo daba por restaurado y el DLL no estaba—. Se sube
   la clave a `nuget-${{ runner.os }}-v2-…` y se quita `restore-keys`, porque recuperar una caché
   anterior es justamente lo que hay que evitar aquí.

**Decisión registrada:** ADR-050 — el token de GitHub sólo viaja a `api.github.com`.

**Errores encontrados y solucionados:**

1. *Síntoma:* al escribir el helper `readTemplate` por shell, el archivo quedó con saltos de línea
   **reales** dentro de la expresión regular en vez de con `\r\n`.
   *Causa raíz:* la trampa que `CLAUDE.md` ya documenta: un heredoc se come un nivel de escapes.
   *Arreglo:* reescrito con la herramienta de edición y con `new RegExp(String.raw…)`, que es la
   forma que la propia guía recomienda para no volver a pisarla. Ha vuelto a pasar; el recordatorio
   sigue siendo necesario.

**Verificado con comandos reales:**

- **El caso de Windows, reproducido y arreglado en local:** con los tres `README.md.tmpl` convertidos
  a CRLF a propósito, `node --test tests/unit/blueprints.test.mjs` pasa 49/49. Antes del cambio, el
  mismo patrón devolvía `false` sobre el texto con CRLF y `true` sobre el mismo texto normalizado.
- **El paso de Electron, ejercitado de verdad:** se apartó `node_modules/electron/dist`, se ejecutó
  `node node_modules/electron/install.js` (salida 0) y el binario volvió a estar en su sitio.
- **El alcance del token, probado:** 21 pruebas nuevas en `tests/unit/github-api.test.mjs`, entre
  ellas la lista de URLs reales del toolchain (API, CDN de artefactos, feed de Azure, Open VSX) con
  lo que debe pasar en cada una, y **una redirección real entre dos servidores locales en puertos
  distintos** que comprueba que el segundo salto no recibe `Authorization`. Más 4 pruebas
  estructurales en el grupo de seguridad: ningún adquisidor escribe cabeceras a mano y el token se
  lee en un único archivo de todo `src/`.
- `npm test` en verde de punta a punta: **1221 pruebas** (1053 unit, 55 security, 57 package,
  56 scaffold), con 25 nuevas en este hotfix.
- El YAML del workflow se valida y quedan los tres jobs con sus pasos en orden.

**Lo que este hotfix no arregla:** el workflow sube artefactos pero **no publica la release**. El tag
`v2.1.0` no creará la publicación con sus notas; eso sigue siendo manual mientras no se añada un paso
de publicación.

---

### Iteración 23 — 2026-08-24 — El test del depurador tolera un runner de CI

**Objetivo:** que la única prueba que seguía en rojo en `windows-latest` deje de serlo. Tras el
hotfix de la iteración 22 (CRLF, Electron, API de GitHub, caché de NuGet), la ejecución sobre
Windows Server 2025 falló en un solo punto, y por timeout:

```text
Error: el programa no se detuvo en el breakpoint
    at Timeout._onTimeout (tests/scaffold/debugger.test.mjs:158:35)
```

El mensaje no distingue las dos averías que puede estar tapando: que el runner sea lento, o que el
programa se muriera al arrancar y nadie llegara nunca al breakpoint. Los dos cambios de esta
iteración atacan una cada uno, y ninguno toca código de producción.

**Hecho:**

1. **Márgenes de espera más anchos sólo en CI.** `IN_CI` mira `process.env.CI`, y de ahí salen
   `BREAKPOINT_TIMEOUT_MS` (120 s → **240 s**), `RESUME_TIMEOUT_MS` (60 s → 120 s) y
   `STATUS_TIMEOUT_MS` (30 s → 60 s). Un runner virtual arranca en frío, jitea, carga los PDB
   portables y resuelve el bridge DAP sobre un disco compartido y sin caché de nada. **Fuera de CI
   se mantienen los valores originales**: en una máquina de desarrollo un timeout largo sólo
   consigue que un fallo real tarde más en verse.
2. **Volcado de la salida del proceso depurado.** `collectOutput()` se suscribe a `output` del
   controlador —que trae tanto el stdout/stderr del programa (eventos DAP) como el stderr del propio
   NetCoreDbg (evento `log`)— y adjunta las últimas 40 líneas a *todos* los mensajes de fallo:
   timeout, arranque fallido y segunda parada. Acotado a 40 para no volcar megas si el programa
   entra en un bucle escribiendo.
3. **Un final prematuro deja de esperar el timeout entero.** `waitForBreakpoint()` vigila tres
   finales en vez de uno: que pare (bien), que la sesión pase a `idle`/`error` **después** de haber
   llegado a `running` (el programa se ejecutó entero o murió), o que se agote el plazo. Los estados
   de arranque (`acquiring`, `starting`) no cuentan como final. El oyente se registra **antes** de
   `controller.start()`: el breakpoint puede golpear entre el arranque y la suscripción, y ese
   evento no se repite.

**Errores encontrados y solucionados:**

1. *Síntoma:* con el diseño anterior, un programa que termina en dos segundos sin parar y un
   programa que no responde en cuatro minutos daban **el mismo** mensaje, cuatro minutos después.
   *Causa raíz:* la espera era un `Promise.race` entre el evento `stopped` y un `setTimeout`; nadie
   miraba el estado de la sesión.
   *Arreglo:* la vigilancia del evento `state` descrita arriba. En CI esto ahorra hasta 240 s por
   ejecución cuando la avería es real, que es justo cuando interesa ver el log cuanto antes.

**Verificado con comandos reales:**

- `npm run build` en verde, y `npm test` completo: **56 pruebas de scaffold, 0 fallos**; la suite
  entera OK (unit, security, package, scaffold).
- `node --test tests/scaffold/debugger.test.mjs` pasa 3/3 y para en el breakpoint en **1,4 s** en
  local: los 240 s de CI son margen, no una espera que se vaya a consumir.
- La misma prueba con `CI=1`, para ejercitar la rama de los márgenes anchos: 3/3.
- **El volcado, ejercitado de verdad:** con una copia de la prueba apuntando el breakpoint a una
  línea inexistente (999), el fallo llega en **1,0 s** en vez de a los 240 s, y con el diagnóstico
  dentro: `la sesión terminó antes de llegar al breakpoint (estado "idle")` seguido de los tres
  eventos de stdout del programa (`1`, `3`, `6`, `total=6`). Es exactamente la traza que faltaba en
  el fallo de Windows Server 2025.
