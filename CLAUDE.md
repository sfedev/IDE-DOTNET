# CLAUDE.md — DotForge IDE

> Documento maestro de instrucciones. Cualquier sesión de Claude que abra este repositorio
> debe leer este archivo **primero** para entender el entorno, los comandos y las convenciones.

---

## 1. Qué es este proyecto

**DotForge IDE** es una distribución de IDE de escritorio (Electron + Monaco) optimizada para
desarrolladores de **C# / .NET 9+ / Blazor**, con instaladores nativos para Windows y macOS.

Su módulo estrella es el **Scaffolding Wizard**: un generador de arquitecturas de software
que produce soluciones .NET **compilables y ejecutables** siguiendo Clean Architecture,
Arquitectura Hexagonal (Ports & Adapters) o Domain-Driven Design + CQRS.

Desde la v2.1.0 el IDE **se actualiza solo**: comprueba si hay una versión posterior cinco segundos
después de arrancar, lo dice en una tarjeta flotante con las notas de la publicación y aplica la
instalación **al cerrar**, sin interrumpir a nadie. Y trae un **explorador de extensiones de Open
VSX**: buscar, instalar y desinstalar `.vsix` desde el registro abierto, con la ficha diciendo qué
aporta cada extensión y qué no tiene efecto aquí.

Desde la v2.0.0 el **IntelliSense de C# funciona**: la versión del servidor de Roslyn está fijada y
verificada en vez de tomarse la última compilación del feed, cada instalación se comprueba archivo a
archivo antes de lanzarla, y si el servidor falla el IDE **conmuta solo a OmniSharp**.

Desde la v1.9.0 incluye un **explorador visual de pruebas** (árbol proyecto → clase → prueba con
lentes de código sobre cada `[Fact]` y `[Theory]`, resultados leídos del TRX y fallos en el panel de
problemas), **resaltado semántico de C# estilo Visual Studio** alimentado por la clasificación de
Roslyn, un **monitor de rendimiento** con los contadores del runtime, **túneles públicos** hacia el
puerto local para probar webhooks, y **auditoría de vulnerabilidades** de los paquetes NuGet.

Desde la v1.8.0 incluye un **panel de contenedores y Docker Compose**: los servicios de apoyo del
proyecto (SQL Server, Redis, RabbitMQ, Seq…) con su estado, sus puertos y los botones para
levantarlos, bajarlos y ver su registro sin salir del IDE.

Desde la v1.7.0 incluye un **visor de registro estructurado** (Serilog, NLog, la consola de .NET y
JSON compacto, con filtro por nivel y marcos de pila clicables), un **linter de reglas de
arquitectura** que avisa de las dependencias prohibidas entre capas, y autocompletado de
**Docker, Docker Compose, la CLI de Azure y npm** en la terminal integrada.

Desde la v1.6.0 incluye un **gestor visual de Entity Framework Core** (migraciones aplicadas y
pendientes, `Add-Migration` y `Update-Database` con interfaz, esquema deducido de las migraciones y
cadenas de conexión de los `appsettings*.json`) y un **cliente HTTP integrado**: archivos `.http` /
`.rest` con resaltado propio y una lente "Enviar petición" sobre cada bloque, y otra lente sobre
cada endpoint de Minimal API o de controlador que genera su prueba.

Desde la v1.5.0 incluye un **panel visual de control de código fuente** (secciones de preparados y
cambios, editor de diferencias lado a lado, commit/push/pull/sync y selector de rama), pastillas de
estado por proceso en la barra superior y un ajuste de **verbosidad de la CLI de .NET** que gobierna
todo lo que el IDE lanza.

Desde la v1.4.0 incluye el **DotForge AI Assistant**: un asistente que conoce la arquitectura de la
solución abierta y responde respetando sus reglas (chat con contexto, `Ctrl+I` sobre la selección
con vista previa de diferencias, y acciones en el menú contextual). Funciona con Anthropic, OpenAI
o un modelo local vía Ollama, y las claves se guardan cifradas con el llavero del sistema.

100% componentes open-source. Sin dependencias del VS Code Marketplace (se usa **Open VSX**),
sin binarios propietarios del C# Dev Kit.

---

## 2. Layout del repositorio

```
IDE-DOTNET/
├── CLAUDE.md               # Este archivo (instrucciones para el modelo)
├── AGENTS.md               # Equipo virtual de sub-agentes especializados
├── PROJECT_DEVLOG.md       # Roadmap vivo + bitácora de decisiones/errores
├── README.md               # Documentación de usuario final
├── package.json            # Scripts npm + dependencias
├── electron-builder.yml    # Configuración de empaquetado multiplataforma
├── tsconfig.json           # TS estricto para todo el código fuente
├── src/
│   ├── shared/             # Tipos y contratos compartidos main <-> renderer <-> cli
│   │   ├── ai.ts               # Catálogo de proveedores/modelos y preferencias del asistente
│   │   ├── ai-context.ts       # Contexto RAG y prompt de sistema con las reglas de arquitectura
│   │   ├── ai-diff.ts          # Extracción de código y diferencias del asistente en línea
│   │   ├── git.ts              # * Modelo del control de fuentes: parseo de status y diffs (puro)
│   │   ├── efcore.ts           # * Modelo de EF Core: salida de la CLI, migraciones, conexiones (puro)
│   │   ├── efcore-schema.ts    # * Esquema deducido de los archivos de migración (puro)
│   │   ├── http-file.ts        # * Formato .http/.rest: bloques, variables y resolución (puro)
│   │   ├── api-endpoints.ts    # * Endpoints de Minimal API y controladores + generación .http (puro)
│   │   ├── log-events.ts       # * Parser del registro: Serilog, NLog, consola de .NET y CLEF (puro)
│   │   ├── architecture-rules.ts # * Linter de capas: dependencias permitidas y paquetes (puro)
│   │   ├── docker.ts           # * Modelo de Docker: contenedores, puertos y servicios de apoyo (puro)
│   │   ├── compose.ts          # * YAML mínimo de docker-compose.yml + cruce con el motor (puro)
│   │   ├── semantic-tokens.ts  # * Tokens semánticos de LSP: descodificación y ámbitos (puro)
│   │   ├── lsp-versions.ts     # * Política de versiones de Roslyn: fijada, orden y descartes (puro)
│   │   ├── lsp-health.ts       # * Servidor roto: firmas de excepción, escáner y cuarentena (puro)
│   │   ├── lsp-protocol.ts     # * Qué contesta el cliente a las peticiones del servidor (puro)
│   │   ├── toolchain-manifest.ts # * Manifiesto de instalación: tamaño y hash por archivo (puro)
│   │   ├── test-explorer.ts    # * Pruebas: descubrimiento por texto, filtros y resultados (puro)
│   │   ├── dev-tunnel.ts       # * Túneles: argumentos y reconocimiento de la URL pública (puro)
│   │   ├── perf-counters.ts    # * dotnet-counters: dos generaciones de contadores (puro)
│   │   ├── nuget-audit.ts      # * dotnet list package --vulnerable: JSON y tabla (puro)
│   │   ├── updates.ts          # * Actualizaciones: SemVer, feed de releases y artefactos (puro)
│   │   ├── open-vsx.ts         # * Registro de extensiones: URLs, respuestas y hosts (puro)
│   │   ├── vsix.ts             # * Formato .vsix: manifiesto, carpeta y contribuciones (puro)
│   │   └── dotnet-verbosity.ts # * Nivel de salida de la CLI -> argumentos y variables (puro)
│   ├── scaffold/           # * MODULO ESTRELLA: generador de arquitecturas (Node puro)
│   │   ├── engine.ts           # Micro motor de plantillas {{token}}
│   │   ├── generator.ts        # Motor de render + escritura en disco
│   │   ├── blueprints/         # Definición de cada arquitectura
│   │   └── templates/          # Archivos .tmpl por arquitectura
│   ├── cli/                # CLI `dotforge` (headless, usado por los tests)
│   ├── main/               # Proceso principal de Electron
│   │   ├── main.ts             # Bootstrap, ventana, menús, atajos, modos de diagnóstico
│   │   ├── preload.ts          # Puente contextIsolation seguro
│   │   ├── menu.ts             # Menú nativo y aceleradores
│   │   ├── toolchain.ts        # Bundle sin Electron: adquisición de LSP/depurador (fetch + tests)
│   │   ├── testable.ts         # Bundle sin Electron: rutas, .sln/.csproj, MSBuild (tests)
│   │   ├── ipc/register.ts     # ÚNICA superficie expuesta al renderer
│   │   ├── services/           # Solución, NuGet, tareas dotnet, terminal, rutas, ZIP, settings,
│   │   │                       # git-service.ts (estado y operaciones de control de fuentes),
│   │   │                       # efcore-service.ts (dotnet ef + migraciones del disco),
│   │   │                       # http-client-service.ts (envío real de las peticiones .http),
│   │   │                       # docker-service.ts (estado del motor), node-scripts.ts (package.json),
│   │   │                       # test-service.ts (descubrimiento, dotnet test y lectura del TRX),
│   │   │                       # tunnel-service.ts (devtunnel/ngrok), metrics-service.ts (contadores),
│   │   │                       # toolchain-install.ts (instalación verificada: manifiesto y reparación),
│   │   │                       # updater-service.ts (comprobar, descargar y aplicar al cerrar),
│   │   │                       # open-vsx-service.ts (búsqueda en el registro de extensiones),
│   │   │                       # extension-installer.ts (instalación de .vsix en userData)
│   │   │   └── ai/             # * Asistente de IA: proveedores, streaming y claves cifradas
│   │   │       ├── request-builder.ts  # Petición HTTP por proveedor (puro)
│   │   │       ├── stream-parser.ts    # SSE/NDJSON -> deltas (puro)
│   │   │       ├── validate.ts         # Saneado de lo que llega del renderer (puro)
│   │   │       ├── preferences.ts      # Validación de preferencias del asistente (puro)
│   │   │       ├── secret-store.ts     # Claves cifradas con safeStorage (Electron)
│   │   │       └── ai-service.ts       # Streaming, cancelación y estado
│   │   ├── lsp/                # Adquisición y cliente del servidor de lenguaje
│   │   └── debug/              # NetCoreDbg + bridge DAP + controlador de sesión
│   └── renderer/           # UI (Monaco, explorador, paneles, wizard, depuración)
│       ├── icons.ts            # Sistema de iconos: 65 piezas vectoriales propias
│       ├── ai-availability.ts  # Estado del asistente en la barra de actividad (puro)
│       ├── icon-gallery.ts     # Galería de revisión visual (modo --icons)
│       ├── file-icons.ts       # Icono/insignia por archivo, carpeta y proyecto + anidamiento
│       ├── ui-lib.ts           # Bundle sin DOM de esas reglas, para poder probarlas
│       ├── languages/          # razor.ts (config, snippets, auto-cierre) + razor-tokens.ts (Monarch)
│       │                       # http.ts (gramática Monarch de los archivos .http / .rest)
│       ├── terminal-suggest.ts # Motor de sugerencias de la terminal (git y CLI de .NET), sin DOM
│       ├── run-output.ts       # Detección de la URL en la que escucha un proceso
│       ├── views/              # explorer, editor, nuget, panel, palette, statusbar, settings,
│       │                       # welcome, wizard, debug, startup-bar, ai-chat, ai-inline, git,
│       │                       # efcore (panel de base de datos), http (cliente del panel inferior),
│       │                       # containers (contenedores y Docker Compose),
│       │                       # tests (explorador de pruebas), metrics (monitor de rendimiento),
│       │                       # extensions (panel de Open VSX), update-card (tarjeta flotante)
│       └── styles/             # theme.css (tokens), layout.css, components.css
├── resources/              # Iconos multirresolución, branding
├── scripts/                # Build, generación de iconos, fetch de toolchain, verificación
├── tests/                  # Suite de pruebas automatizadas
├── build/                  # Salida de compilación intermedia (esbuild)  [git-ignored]
└── dist/                   # * Artefactos finales de distribución        [git-ignored]
```

**Regla de oro de dependencias:** `src/scaffold/` y `src/cli/` **NO** pueden importar `electron`.
Deben ejecutarse con Node puro para que los tests corran sin display ni Electron.

---

## 3. Comandos principales

### Instalación

```bash
npm install
```

### Desarrollo

```bash
npm run build
```

- `npm run build` — compila main + preload + renderer + cli con esbuild y copia Monaco.
- `npm run watch` — compila en modo watch.
- `npm run dev` — build + lanza Electron con DevTools abiertas.
- `npm start` — lanza Electron sobre el último build.

### Módulo de scaffolding (CLI headless)

```bash
node build/cli.js new clean --name Acme.Shop --output ./out
```

- `node build/cli.js list` — lista arquitecturas disponibles.
- `node build/cli.js new <clean|hexagonal|ddd> --name <Sln> --output <dir>`
- Flags: `--ui webapi|blazor|both`, `--framework net9.0|net10.0`, `--db sqlite|inmemory`,
  `--entity Product`, `--no-tests`, `--force`, `--json`.

### Tests

```bash
npm test
```

- `npm run test:unit` — motor de plantillas, blueprints y contratos (rápido, sin dotnet).
- `npm run test:scaffold` — genera las 3 arquitecturas y ejecuta `dotnet build` real.
- `npm run test:package` — valida la configuración de empaquetado y el árbol de `/dist`.

### Empaquetado / distribución

```bash
npm run dist:win
```

- `npm run icons` — regenera `.ico` / `.icns` / `.png`; el logo se **dibuja por código**.
- `npm run pack` — empaqueta sin instalador (carpeta desempaquetada, smoke test).
- `npm run dist:win` — Windows: instalador NSIS `.exe` + portable `.zip` → `/dist`.
- `npm run dist:mac` — macOS: `.dmg` + `.zip` con `.app` (arm64 + x64) → `/dist`.
- `npm run dist:all` — ambos.
- `npm run verify:dist` — qué hay en `/dist`, tamaño y estado de firma. Acepta `--require win|mac`.
- `npm run prune:dist` — borra de `/dist` los artefactos de versiones anteriores. Lo ejecutan
  solos `pack`, `dist:win`, `dist:mac` y `dist:all` **antes** de empaquetar; acepta `--dry-run`.
- `npm run clean` — borra `build/` y `dist/`; con `--all`, también el toolchain cacheado.

### Modos de diagnóstico de la aplicación

Existen para que "la app arranca" y "la gramática funciona" sean aserciones, no suposiciones:

```bash
npx electron . --smoke-test
```

- `--smoke-test` — monta la ventana sin mostrarla, comprueba shell, aislamiento, Monaco, temas y
  tokenización de Razor, e imprime `SMOKE_OK` o `SMOKE_FAIL` con el detalle. Sale con 0 o 1.
- `--tokenize=<código>` — imprime cómo tokeniza Monaco ese fragmento en Razor. Indispensable para
  depurar la gramática: Monarch compila sin quejarse y falla en ejecución.
- `--screenshot=<ruta>` — guarda una captura de la ventana, muestrea los píxeles del chrome y sale.
- `--icons` — sustituye la interfaz por la galería de iconos, a 16 y 24 px.
- `--ui=<vista>` — abre una vista antes de la captura pulsando los mismos controles que pulsaría
  un usuario (`wizard`, `settings`, `nuget`, `debug`, `ai`, `terminal`, `palette`, `light`,
  `nesting`, `startup`, `startup-dialog`, `terminal-suggest`, `git`, `git-diff`, `startup-play`,
  `startup-run-mode`, `ai-toggle`, `efcore`, `http`, `logs`, `startup-logs`, `containers`,
  `tests`, `tests-run`, `metrics`, `audit`, `extensions`, `update`). `update` pinta la tarjeta de
  actualización con un estado de ejemplo: publicar una versión de verdad para poder mirarla no es
  una opción, y no mirarla nunca tampoco.
- `--ui-wait=<ms>` — cuánto se espera antes de **pulsar** la acción de `--ui=`. Los 3,2 s por
  defecto no bastan si se arranca con una solución abierta: la interfaz todavía está cargando
  Monaco y el control que hay que pulsar aún no existe.
- `--wait=<ms>` — cuánto se espera antes de **medir** (`--probe=`) o de **capturar**
  (`--screenshot=`). Sin esto no se puede comprobar nada que tarde, como que `dotnet run` arranque
  y anuncie su puerto.
- `--probe=<expresión>` — evalúa una expresión en el renderer y la imprime. Es la forma de zanjar
  una duda sobre CSS: leer el valor calculado en vez de interpretar una captura. **La expresión
  puede ser asíncrona**: se envuelve en `Promise.resolve`, así que sirve igual para medir el DOM que
  para hacer una llamada IPC (`--probe="window.dotforge.lsp.legend()"`) y ver qué contesta de verdad
  el proceso principal.
- `node scripts/read-pixels.mjs <png> <x,y>…` — decodifica una captura y dice el color exacto de
  esos píxeles. Es la segunda opinión cuando `--probe=` y lo que se ve no parecen coincidir.
- `--open=<ruta>` o un argumento posicional — abre una carpeta o un archivo al arrancar.

> **Nota de plataforma:** `dist:mac` produce artefactos firmados/notarizados sólo en un host
> macOS. En Windows electron-builder empaqueta la app macOS pero **no** puede firmarla.
> `scripts/verify-dist.mjs` reporta explícitamente qué se generó y qué no.

---

## 4. Convenciones de código

### TypeScript

- `strict: true`, sin `any` implícito. Preferir `unknown` + narrowing sobre `any`.
- ESM en el código fuente (`import`/`export`). esbuild emite CJS para el main de Electron.
- Archivos: `kebab-case.ts`. Clases/tipos: `PascalCase`. Funciones/variables: `camelCase`.
- Un dominio por archivo en `src/main/services/` (`solution-service.ts`, `nuget-service.ts`, ...).
- Errores: lanzar `Error` con mensaje accionable; nunca tragar excepciones en silencio.
- Todo handler IPC se registra en `src/main/ipc/` y se declara en `src/shared/contracts.ts`.

### Seguridad de Electron (no negociable)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` sólo si un servicio del
  preload lo exige; por defecto la ventana no ejecuta Node en el renderer.
- El renderer **nunca** accede a `fs`, `child_process` ni `path`. Todo pasa por `preload.ts`,
  que expone una API tipada y de superficie mínima vía `contextBridge`.
- Validar y normalizar toda ruta recibida del renderer contra el workspace abierto
  (`assertInsideWorkspace` en `src/main/services/workspace-guard.ts`).

### Plantillas de scaffolding (`src/scaffold/templates/`)

- Extensión `.tmpl` **obligatoria**. Evita que el SDK de .NET haga glob sobre ellas y que los
  linters de TS/C# las analicen.
- Tokens: `{{Solution}}`, `{{RootNamespace}}`, `{{Framework}}`, `{{Entity}}`, `{{entity}}`,
  `{{entityPlural}}`, `{{Year}}`, `{{Db}}`.
- Condicionales: `{{#if flag}}...{{/if}}`, `{{#unless flag}}...{{/unless}}`.
- El path de destino se deriva del path de la plantilla; `__Solution__` se sustituye en el path.
- **Regla crítica:** cada plantilla debe compilar con `dotnet build`. Si añades una arquitectura,
  añade su caso a `tests/scaffold-build.test.mjs`.

### Sistema de diseño

- **Ningún componente escribe un color literal.** Todo sale de los tokens de `theme.css`. Si hace
  falta un color nuevo, se añade como token en los dos temas, no como hex suelto en un componente.
- **Nada de negro puro ni blanco puro.** El fondo más oscuro es `#1b1d27` y el texto más claro
  `#c8cee2`. El objetivo es reducir la fatiga visual en sesiones largas sin perder legibilidad.
- **Contraste AA (≥ 4.5:1) en todo el texto funcional**, incluidos los tonos `--text-faint`.
- **Un solo acento.** El violeta marca lo activo y lo que reclama atención. Si todo es violeta,
  el violeta no significa nada.
- **Iconos, no glifos de texto.** Se usa `icon(name)` de `src/renderer/icons.ts`. Añadir uno
  nuevo obliga a revisarlo con `npx electron . --icons` y pasa por las pruebas de geometría.
- **El renderer nunca inyecta marcado**: ni `innerHTML` para HTML ni para SVG. Los iconos se
  construyen con `createElementNS`.
- **Densidad:** filas de árbol de 26 px, sangría de 15 px, rejilla base de 8 px.

### Control de código fuente (`src/main/services/git-service.ts`, `src/shared/git.ts`)

- **Se invoca el `git` del sistema** (ADR-020), nunca una librería de JS: `execFile` con array de
  argumentos, jamás una línea de shell. Así, worktrees, submódulos, hooks y credential helpers se
  comportan igual que en la terminal del usuario.
- **El parseo es puro y vive en `src/shared/git.ts`.** Todo lo que entiende `git status --porcelain`
  se prueba con salidas capturadas; el servicio sólo ejecuta y delega.
- **Nada de regex sobre los mensajes de git**: están traducidos al idioma del sistema. Las
  decisiones ("no hay nada preparado") se toman mirando el estado, no la salida.
- **`GIT_TERMINAL_PROMPT=0` en todas las llamadas.** Sin eso, un `push` contra un remoto que pide
  credenciales deja el IDE colgado esperando un terminal que no existe.
- Las rutas que llegan del renderer se normalizan contra la raíz del repositorio
  (`toRepositoryPaths`) **y** contra el workspace (`assertInsideWorkspace`).
- El editor de diferencias usa modelos `dotforge-diff:` de sólo lectura (ADR-021): nunca el modelo
  `file:` del archivo abierto.

### Entity Framework Core (`src/main/services/efcore-service.ts`, `src/shared/efcore*.ts`)

- **Se lee el bloque JSON, no el texto.** Las herramientas de EF envuelven su salida `--json` entre
  `//BEGIN` y `//END` para separarla de la del build. Cualquier decisión tomada sobre el texto plano
  (`(Pending)`) es un parche que se romperá: existe como camino de respaldo y se marca `degraded`.
- **El IDE no se conecta a la base de datos** (ADR-025). Las tablas y columnas salen de los archivos
  de migración del repositorio, aplicando sus operaciones en orden. El panel lo dice: "Esquema
  deducido". Una migración con `migrationBuilder.Sql(...)` es opaca y se cuenta aparte.
- **Lo que se lee usa `execFile`; lo que escribe usa el canal de tareas.** `database update` puede
  tardar minutos, y su salida tiene que ir al panel inferior como la de cualquier `dotnet build`.
- El nombre de una migración se valida como identificador de C# **antes** de construir los
  argumentos, y el `--context` sólo admite un identificador: los dos llegan del renderer.

### Contenedores y Compose (`src/shared/compose.ts`, `src/main/services/docker-service.ts`)

- **El compose manda, el motor confirma** (ADR-031). La lista de servicios sale del archivo del
  repositorio; el estado se le pega después. Así el panel sirve con todo apagado, que es cuando
  hace falta.
- **La correspondencia servicio ↔ contenedor es por etiqueta** (`com.docker.compose.service`) y, en
  segundo lugar, por `container_name`. Nunca por parecido del nombre: dos proyectos con un servicio
  `redis` se intercambiarían los botones de parar.
- **Parser propio de YAML** (ADR-032), acotado a lo que usa Compose. Cuidado con el caso que ya
  falló una vez: `- "5672:5672"` lleva dos puntos y **no** es un mapa. Una clave exige espacio o
  fin de línea tras los dos puntos.
- **Docker apagado no vacía el panel** (ADR-033): se atenúan las acciones y se explica, como con el
  asistente de IA.
- `docker compose up` se lanza **siempre con `-d`**: un compose en primer plano dentro de un panel
  que no es un terminal deja un proceso que no se puede parar con Ctrl+C.

### Explorador de pruebas (`src/main/services/test-service.ts`, `src/shared/test-explorer.ts`)

- **Se descubre leyendo el código, no compilando** (ADR-037). `dotnet test --list-tests` exige un
  build completo; el árbol tiene que estar lleno al abrir la solución y la lente tiene que aparecer
  sobre el `[Fact]` que se está escribiendo. Se reconocen xUnit, NUnit y MSTest.
- **Los resultados salen del TRX** (ADR-036), nunca de la consola: los estados de la consola están
  traducidos al idioma del sistema. El nombre bueno está en `TestDefinitions`, no en `testName` —en
  una `[Theory]` ese campo trae los argumentos del caso—, y hay que descodificar las referencias
  numéricas (`&#xD;&#xA;`) o la traza sale con ellas incrustadas.
- El filtro de VSTest lo **reconstruye el proceso principal** a partir de identificadores validados
  contra la forma de un nombre cualificado de C#: la cadena del renderer no entra en un `argv`.
- Los fallos van al panel de problemas con su propia lista: una compilación correcta no arregla una
  prueba que falla, así que no puede borrar su problema.

### Actualizaciones automáticas (`src/main/services/updater-service.ts`, `src/shared/updates.ts`)

- **Sin `electron-updater`** (ADR-045): exige artefactos firmados y un canal de publicación, y aquí
  no hay certificado (`publish: null`). Se lee la API pública de releases con el mismo patrón que el
  toolchain: HTTPS, `content-length` comprobado y artefacto en `userData/updates/`.
- **La comparación es SemVer, no de cadenas.** `2.10.0` es posterior a `2.9.0`, y `2.1.0-rc.1` es
  *anterior* a `2.1.0`. Una versión que no se entiende **no** es más nueva: como mucho no se ofrece
  una actualización que existía; al revés se ofrecería una que no existe.
- **El artefacto se elige por plataforma y arquitectura.** El `.zip` lo publican las tres
  plataformas y sólo se distinguen por el `-win-` / `-mac-` del nombre, así que las marcas de las
  *otras* plataformas se comprueban siempre, no sólo cuando la extensión es ambigua.
- **El único camino de instalación es `before-quit`** (ADR-046). "Reiniciar y aplicar" cierra el IDE
  para llegar ahí; "Descartar" esconde la tarjeta, sigue descargando y deja la instalación
  programada. Lo pendiente se persiste: una promesa que sólo vive en memoria no es una promesa.
- El instalador se lanza `detached` y con `stdio: 'ignore'`: el padre está desapareciendo, y un hijo
  que hereda sus descriptores muere con él a mitad de la instalación. Por lo mismo no se usa
  `shell.openPath`, que devuelve una promesa que nadie va a poder esperar.
- El servicio **no importa `electron`**: `userData`, la versión y el cierre se le inyectan.

### Extensiones de Open VSX (`src/main/services/extension-installer.ts`, `src/shared/open-vsx.ts`)

- **La URL del `.vsix` llega dentro del JSON del registro** (ADR-047), o sea, es texto de la red que
  acaba siendo el origen de algo que se escribe en el disco: se valida el host contra una lista
  cerrada, comparando el hostname **entero**. `open-vsx.org.malo.dev` contiene el host bueno y no es
  el host bueno. Si la respuesta trae otra descarga, se descarta y se construye la canónica.
- **Se instala con `installArchive` + `verifyInstall`**, como el resto del toolchain (ADR-041). Nada
  de marcadores propios: eso ya costó nueve versiones de IntelliSense roto.
- Sólo se escribe el subárbol `extension/` del paquete, sin su primer nivel: `[Content_Types].xml` y
  `extension.vsixmanifest` son envoltorio del canal de distribución.
- `publisher` y `name` salen de un JSON descargado y acaban formando un **nombre de carpeta**: se
  validan como identificadores al parsear el manifiesto y se vuelve a comprobar la ruta resultante
  contra la raíz de extensiones antes de escribir o de borrar.
- **Se instalan, no se ejecutan** (ADR-048). Lo aprovechable es lo declarativo —temas, fragmentos,
  gramáticas, lenguajes— y la ficha reparte cada `contributes` entre lo que sirve aquí y lo que no.
  Un gestor que instala y calla se percibe como roto.
- Los iconos se dibujan localmente (ADR-049), como en NuGet: la CSP no admite imágenes remotas y
  descargarlas le contaría al registro qué está mirando el usuario.

### Servidor de lenguaje (`src/main/lsp/`, `src/shared/lsp-*.ts`)

- **La versión de Roslyn se fija, no se elige sola** (ADR-040). El feed publica 763 compilaciones y
  ninguna es estable en SemVer: "la más alta" es la de anoche de la rama principal. Manda
  `ROSLYN_PINNED_VERSION`, verificada a mano —descargada, extraída y arrancada—. Subirla es un
  cambio de código deliberado, y hay que comprobar su `runtimeconfig.json`: la banda 4.14 declara
  `net9.0` con `rollForward: Major` y arranca con el runtime 9 o el 10; las bandas 5.x exigen el 10.
- **Una instalación se verifica archivo a archivo** (ADR-041), contra el manifiesto que se escribe al
  extraerla. Barata (`stat`) en cada arranque; profunda (hash) sólo después de un fallo, que es lo
  único que distingue "esta copia está corrupta" de "esta compilación está mal". Un marcador que
  guarda el hash del `.nupkg` no verifica nada: verifica un archivo que ya no está en el disco.
  Vale para **todo** lo que se descarga: el servidor de lenguaje y NetCoreDbg pasan por
  `installArchive` / `verifyInstall` de `src/main/services/toolchain-install.ts`, y una prueba de
  seguridad vigila que ninguno de los dos vuelva a declararse su propio marcador de "listo".
- **El manifiesto se escribe el último.** Una extracción interrumpida tiene que dejar un directorio
  sin manifiesto, porque eso se reinstala; un marcador escrito antes de tiempo es una mentira
  permanente.
- **Un servidor roto se detecta por stderr y por nombre de tipo de excepción** (ADR-042), nunca por
  el mensaje: viene traducido al idioma del sistema. Y sólo cuenta dentro de un bloque `fail:` o
  `crit:`. El escáner lleva búfer de líneas: los trozos del stream no respetan los saltos.
- **Un cierre que nadie ha pedido es un fallo aunque el código de salida sea 0.** El cliente marca
  sus propias paradas para poder distinguirlas.
- **Contestar algo no es contestar bien.** A `workspace/configuration` hay que devolverle un array
  con una entrada por sección pedida (ADR-043); con `null`, Roslyn rompe su cola de mensajes y se
  apaga limpiamente. Lo decide `src/shared/lsp-protocol.ts`, que es puro.
- Una versión que falla queda en cuarentena **por RID**, salvo que la auditoría demuestre que la
  culpa era de la copia: entonces se borra la copia y se le levanta el veto (ADR-044).

### Peticiones del toolchain y token de GitHub (`src/shared/github-api.ts`)

- **Todas las cabeceras se piden al mismo sitio.** Ningún adquisidor las escribe a mano:
  `requestHeaders(url, …)` decide qué lleva cada petición. Hay una prueba estructural que cuenta los
  `fetch(` de cada adquisidor y exige que todos deleguen; es fácil colar una credencial en la
  descarga del artefacto, que va a otro host.
- **El token sólo viaja a `api.github.com`** (ADR-050), por HTTPS y comparando el `hostname` entero.
  Ni al CDN de artefactos, ni al feed de Azure de Roslyn, ni a Open VSX. Se lee de `GITHUB_TOKEN` o
  `GH_TOKEN` **en un único archivo de todo `src/`**, y una prueba lo vigila.
- **Una redirección no arrastra la credencial**, y eso está probado con dos servidores locales en
  puertos distintos, no supuesto: la descarga de un artefacto de GitHub siempre salta de host.
- Un 403 de esa API casi nunca es un permiso: es el límite de 60 peticiones por hora **y por IP**.
  `rateLimitHint` lo dice con esas palabras en vez de dejar el número suelto.

### Tokens semánticos (`src/shared/semantic-tokens.ts`)

- **Las listas de capacidades no pueden ir vacías.** Para LSP, `tokenTypes: []` significa "no
  entiendo ningún tipo de token", y un servidor correcto no manda ninguno.
- **Se descodifica con la leyenda del servidor, no con la nuestra.** Los datos son índices dentro de
  la leyenda que publica él, y Roslyn manda la suya con nombres propios (`class name`,
  `keyword - control`, `xml doc comment - text`). Se normalizan por forma, no enumerando variantes.
- **Un tipo que no se reconoce devuelve `null` y conserva el color de la gramática.** Apagar un
  trozo del editor por una clasificación exótica es peor que no colorearla.
- Monaco pide los tokens **una vez por versión del documento**: el proveedor expone `onDidChange` y
  se dispara al llegar la leyenda y al recibir `workspace/projectInitializationComplete`.
- A Roslyn hay que **abrirle la solución** con `solution/open` (ADR-039). Sin eso responde `null` a
  todo con el estado en "listo".

### Monitor de rendimiento (`src/shared/perf-counters.ts`)

- **`collect --format csv`, no `monitor`** (ADR-038): `monitor` necesita una consola de verdad y
  revienta con la salida redirigida. El CSV se lee de forma incremental, hasta el último salto de
  línea: media fila es un número partido por la mitad.
- **Dos generaciones de nombres.** Los EventCounters clásicos (`CPU Usage`, `GC Heap Size`) y las
  métricas del `Meter` de `System.Runtime` que los sustituyen desde .NET 9
  (`dotnet.process.cpu.time`, `dotnet.gc.collections[gc.heap.generation=gen0]`). Con sólo las
  primeras el panel se queda vacío en net9.0 y net10.0.
- El intervalo se lee de la unidad (`By / 2 sec`), que es lo que permite convertir un acumulado en
  una tasa sin saber con qué frecuencia se pidió la sesión.

### Auditoría de NuGet (`src/shared/nuget-audit.ts`)

- **Se lee `--format json`**, y la tabla sólo como camino degradado y marcado como tal: sus
  cabeceras y sus niveles de gravedad están traducidos.
- En la tabla, "transitivo" se decide **contando columnas** (un directo trae versión pedida y
  resuelta; un transitivo sólo la resuelta), no buscando la palabra en la cabecera.
- Los transitivos se enseñan: la vulnerabilidad casi nunca está en el paquete que se instaló.

### Visor de registro (`src/shared/log-events.ts`)

- **Un parser por formato.** En la misma salida conviven la consola de `Microsoft.Extensions.Logging`
  (arranque del host), Serilog, y a veces NLog o CLEF. Se reconocen los cuatro; lo que no encaja
  sigue apareciendo como evento informativo, nunca se descarta.
- **Ni `at` ni `in` ni `line`.** Un marco de pila se reconoce por su forma —firma con paréntesis,
  ruta terminada en extensión de código y número al final—, porque esas palabras están traducidas
  al idioma del sistema (ADR-028).
- El panel **reparsea el buffer** en cada pintado en vez de mantener estado incremental: el buffer
  está acotado y así no hay dos verdades que puedan divergir cuando una excepción llega partida.

### Linter de arquitectura (`src/shared/architecture-rules.ts`)

- **Ante la duda, callar** (ADR-029): capa sin clasificar, arquitectura no reconocida o proyecto de
  pruebas ⇒ ningún aviso. Se declara lo permitido, no lo prohibido.
- Los avisos son **siempre `warning`** y usan su propio propietario de marcadores
  (`dotforge-architecture`): una compilación correcta no puede borrarlos, porque el código compila
  y sigue rompiendo la regla.
- La presentación **sí** puede ver la infraestructura en las tres arquitecturas: es la raíz de
  composición. Prohibírselo obligaría a inventar un proyecto de arranque extra.

### Cliente HTTP (`src/main/services/http-client-service.ts`, `src/shared/http-file.ts`)

- **`node:http` / `node:https`, no `fetch`** (ADR-026), y `rejectUnauthorized: false` **sólo** para
  `localhost`, `127.0.0.1` y `::1`: es la única forma de probar una API con el certificado de
  desarrollo de ASP.NET Core sin abrir la puerta a un certificado inválido en un host remoto.
- **Las variables se resuelven en el renderer**, con el modelo puro. Lo que cruza el IPC es una
  petición concreta; el proceso principal no conoce el formato `.http`.
- Un fallo de red **no lanza**: se devuelve como resultado con `error`, igual que en git. Que la API
  no esté levantada todavía es el estado normal de un desarrollo.
- Una variable que no existe se deja tal cual (`{{baseUrl}}`) en vez de sustituirse por vacío: una
  URL a medias no dice qué falta.

### Salida de la CLI de .NET (`src/shared/dotnet-verbosity.ts`)

- Un solo ajuste (`dotnetVerbosity`) gobierna `build`, `run`, `watch`, `test`, `clean`, `restore`,
  `format` y el entorno del proceso depurado. Lo lee el **proceso principal**, no el renderer.
- La bandera **no es la misma para todos los verbos**: `dotnet watch` quiere `--verbose` antes del
  subcomando; el resto, `--verbosity <nivel>` detrás del objetivo. Lo decide `verbosityPlan`, que
  es pura y está probada verbo a verbo.
- Los niveles altos añaden variables de entorno (`Logging__LogLevel__*`, `ASPNETCORE_DETAILEDERRORS`,
  `COREHOST_TRACE`), que es lo que de verdad recopila excepciones y trazas de arranque. Ninguno toca
  `ASPNETCORE_ENVIRONMENT`: eso lo decide `launchSettings.json`.

### Asistente de IA (`src/main/services/ai/`, `src/shared/ai*.ts`)

- **El prompt de sistema lo compone el proceso principal**, no el renderer (ADR-016). El renderer
  manda contexto y mensajes; la arquitectura y el mapa de proyectos se **rederivan** en
  `register.ts` a partir de la solución realmente abierta. Añadir una regla de arquitectura es
  tocar `ARCHITECTURE_RULES` en `src/shared/ai-context.ts`, y hay una prueba por regla.
- **Nada de SDK de proveedor** (ADR-017): `request-builder.ts` construye la petición y
  `stream-parser.ts` la parsea. Los dos son funciones puras y se prueban sin red ni claves.
- **Un flag por modelo, no un `if` por versión.** Lo que un modelo admite se declara en el catálogo
  (`supportsEffort`). A un modelo que no lo admite no se le manda `output_config` ni `thinking`, y
  a **ninguno** se le manda `temperature` ni `budget_tokens`: la generación actual los rechaza con
  un 400.
- **La clave nunca cruza al renderer.** Hay canal para escribirla y para borrarla; no hay canal
  para leerla. `AiStatus` sólo dice qué proveedores tienen credencial.
- Toda petición nueva pasa por `validate.ts`: roles, tamaños y tope de turnos. Un `system` enviado
  desde el renderer se descarta.

### C# generado

- .NET 9+ (`net9.0` por defecto), `ImplicitUsings` y `Nullable` habilitados.
- `Program.cs` de estilo minimal API moderno, sin `Startup.cs`.
- Serilog para logging estructurado, OpenAPI + Scalar para documentación, EF Core para persistencia.
- **Sin MediatR** (cambió a licencia comercial): se usa un despachador CQRS propio y ligero
  (`IDispatcher`) registrado por reflexión. Decisión registrada en `PROJECT_DEVLOG.md`.

---

## 5. Toolchain externo (adquisición en runtime)

DotForge **no** vendorea binarios pesados en el repositorio. Se descargan bajo demanda a
`userData/toolchain/` y quedan cacheados:

| Componente | Origen | Uso |
|---|---|---|
| `Microsoft.CodeAnalysis.LanguageServer` | feed NuGet `dotnet-tools` | LSP C# principal (Roslyn, MIT) |
| OmniSharp-Roslyn | GitHub Releases | LSP de respaldo |
| NetCoreDbg | GitHub Releases (Samsung, MIT) | Depuración en Windows y macOS |
| Extensiones Open VSX | open-vsx.org | Registro de extensiones |

Pre-descarga opcional para builds offline:

```bash
npm run fetch:toolchain -- --platform win32 --arch x64
```

---

## 6. Flujo de trabajo obligatorio para futuras sesiones

1. Leer `PROJECT_DEVLOG.md` para conocer el estado actual y las decisiones ya tomadas.
2. Consultar `AGENTS.md` si la tarea encaja con un sub-agente especializado.
3. Implementar → `npm run build` → `npm test` → corregir → refactorizar.
4. **Actualizar `PROJECT_DEVLOG.md` en cada iteración**: marcar `[x]`, registrar decisiones
   técnicas, errores encontrados y su solución.
5. Nunca dar por terminada una tarea sin que `npm run build` y `npm test` pasen en verde.

---

## 7. Trampas conocidas del entorno

- **Windows + rutas largas:** `dotnet build` sobre rutas >260 chars falla. Los tests generan en
  un directorio temporal corto (`%TEMP%\dotforge-tests`), no dentro del repo.
- **SDK 10 compilando `net9.0`:** funciona (el targeting pack llega vía NuGet), pero *ejecutar*
  el binario requiere el runtime 9.0 instalado. Los tests sólo hacen `build`, no `run`.
- **Monaco + esbuild:** Monaco no se bundlea; se copia `monaco-editor/min/vs` a
  `build/vendor/monaco` y se carga con el loader AMD desde `file://`. Ver `scripts/build.mjs`.
- **asar:** el toolchain descargado vive fuera del asar (userData). Nunca asumir `__dirname`
  escribible en producción.
- **electron-builder en Windows apuntando a macOS:** genera `.dmg`/`.zip` sin firmar; es esperado
  y `verify-dist.mjs` lo marca como `unsigned`.
- **`dotnet build` y NuGet:** el primer build de cada plantilla restaura paquetes; en CI conviene
  cachear `~/.nuget/packages` o el test tarda varios minutos.
- **Escritura de plantillas por shell:** un comando de shell por encima de ~10 KB se trunca y el
  heredoc queda sin cerrar (`unexpected EOF`). Escribe las plantillas en lotes de menos de ~8 KB
  o usa la herramienta de escritura de archivos.
- **Nunca escribas contrabarras a través del shell.** Un heredoc se come un nivel de escapes, y
  `/^(\d+\.\d+)/` llega al archivo como `/^(d+.d+)/`: compila, no avisa y deja de casar. Ha pasado
  tres veces (los regex de Razor, el indicador del SDK, las pruebas de rutas). Cualquier archivo
  con `\d`, `\r`, `\b` o rutas de Windows se escribe con la herramienta de edición, y en el código
  se prefiere `new RegExp(String.raw\`…\`)`.
- **Finales de línea:** el repositorio está en LF. Una herramienta que reescriba un archivo en CRLF
  rompe los scripts que buscan patrones a final de línea —`devlog.mjs` llegó a informar 0/0 por
  eso— así que normaliza antes de guardar (`tr -d '\r'`).
- **`{{` en C# interpolado:** el motor de plantillas interpreta `{{Nombre}}` como token, así que
  una plantilla **no puede** usar `{{` como escape de llave literal en un string interpolado de C#.
  Si necesitas una llave literal, sácala a una constante.
- **Mermaid dentro de una plantilla:** por el mismo motivo, la forma hexagonal de nodo de Mermaid
  —`A{{Texto}}`— es sintaxis de token para el motor y no se puede usar en los `README.md.tmpl`.
  Usa `[ ]`, `([ ])` o `[( )]`. Hay una prueba en `tests/unit/blueprints.test.mjs` que lo vigila.
- **Alinear en columna dentro de una plantilla no funciona:** el ancho real de cada línea depende
  del valor de los tokens (`{{Solution}}`, `{{Entity}}`), así que un árbol de carpetas con los
  comentarios alineados por espacios se descuadra al generarse. Separa con ` — `, no con columnas.
- **Monarch y la arroba:** dentro de una expresión regular de Monarch, `@@` es el escape de **una**
  arroba literal y `@nombre` es una referencia a un atributo del lenguaje. Para casar dos arrobas
  (la arroba literal de Razor) hay que escribir `@@@@`. Y una referencia `@atributo` usada dentro de
  un regex debe apuntar a una **cadena**, no a un array: los arrays sólo valen en las guardas de
  `cases`. Los dos errores compilan y fallan en ejecución; se depuran con `--tokenize=`.
- **Vistas de la barra lateral:** explorador y NuGet comparten el contenedor `#sidebar-content`.
  Cada una tiene un flag `visible` y sólo pinta si está activa; sin eso, un cambio de solución hace
  que ambas se pinten y gane la última.
- **`TargetFramework` heredado:** las soluciones modernas lo declaran en `Directory.Build.props`,
  no en cada `.csproj`. El parser sube buscándolo (`readInheritedProperties`).
- **No juzgues un color mirando una captura.** El visor puede aplicar su propio perfil o su propio
  tema y enseñar oscuro lo que en el archivo es claro. Hay dos formas de medirlo de verdad:
  `--probe=` para leer `getComputedStyle` en el renderer, y `scripts/read-pixels.mjs` para leer los
  bytes del PNG. Las dos coincidieron en el tema claro; la captura vista a ojo, no.
- **Los trozos de un stream no respetan los límites de línea.** `data: {"type":"content_bl` es una
  lectura perfectamente normal. Cualquier parser de SSE o NDJSON tiene que guardar su propio búfer
  y procesar sólo líneas terminadas; si no, se come tokens de forma intermitente y el fallo no se
  reproduce. Se prueba troceando la respuesta de uno en uno.
- **Un servidor HTTP de prueba con una respuesta sin cerrar bloquea `node --test` cinco minutos.**
  `server.close()` espera al `requestTimeout` (300 s por defecto). Hay que llamar antes a
  `server.closeAllConnections()`. La suite pasaba en verde y tardaba 302 s en salir.
- **Los aceleradores del menú nativo llegan antes que el renderer.** Registrar el mismo atajo en el
  menú y en `window` ejecuta la acción dos veces; y `Ctrl+Shift+I` está cogido por el inspector de
  Electron, así que no se puede usar para nada propio.
- **Recortar un archivo por líneas no recorta nada si el archivo es una sola línea.** Un `.razor`
  minificado o un JSON en una línea se cuelan enteros en el prompt: hace falta un tope duro sobre
  el resultado, no sólo una ventana por líneas.
- **Eventos hacia un renderer que aún no existe:** el renderer tarda en estar listo (carga Monaco),
  así que un evento emitido en `did-finish-load` se pierde. Para esos casos se usa una **consulta**
  desde el renderer (`workspace:pending-file`), no un evento.
- **Los mensajes de git están traducidos.** `nothing to commit` sale en español en un Windows en
  español, así que cualquier decisión basada en una regex sobre la salida de git funciona en la
  máquina de quien la escribió y falla en la del usuario. Se mira el estado del índice, no el texto.
- **`core.autocrlf` en Windows** devuelve el archivo restaurado con CRLF aunque el blob esté en LF:
  comparar byte a byte en una prueba comprueba la configuración de git del equipo, no el código.
- **Las acciones `--ui=` pulsan por índice posicional** dentro de `.activity-item`. Añadir una
  herramienta a la barra de actividad las rompe todas en silencio: hay que actualizar los índices
  de `UI_ACTIONS` en `src/main/main.ts`, donde el orden está escrito en un comentario.
- **`--ui=` pulsa a los 3,2 s**, que no bastan si se arranca con una solución abierta (Monaco y el
  parseo de la solución tardan más). El síntoma es que la acción "no hace nada", sin ningún error:
  se resuelve con `--ui-wait=<ms>`.
- **Los estados de Monarch sobreviven al salto de línea.** Un estado al que se entra a mitad de
  línea (por ejemplo, "esto es una URL" tras el verbo de un `.http`) **no** se cierra solo al
  terminar la línea: una regla de longitud cero al final ni siquiera llega a evaluarse. El estado
  se cuela en la línea siguiente y tiñe lo que venga. Cuando la regla es "de aquí al final de la
  línea", se escribe una sola regla con grupos de captura, no un estado.
- **`dotnet ef` no está instalado por defecto.** El mensaje de `dotnet` en ese caso es "Could not
  execute because the specified command or file was not found", que no dice qué hacer. Se detecta
  por la **ausencia del bloque JSON**, no buscando esa frase (está traducida), y se añade la orden
  `dotnet tool install --global dotnet-ef`.
- **El proceso depurado no lanza ninguna tarea.** Su salida llega por `debug:output`, sin
  `taskId`, así que cualquier camino que use `taskId` para decidir el canal lo manda al de
  compilación — y con él, el puerto que anuncia. Tiene canal propio (`startDebugChannel`) y se
  para con `debug:stop`, no cancelando una tarea.
- **`debug:start` empieza parando la sesión anterior**, y ese `stop` emite `idle` **antes** de
  arrancar. Reaccionar a cualquier `idle` cierra lo que se acaba de abrir. La regla vive en
  `debugChannelTransition` y está probada.
- **Un spinner promete que algo va a terminar.** Junto a "Detener WebApi" mentía: una Web API
  arrancada no termina. Las tareas largas (`run`, `watch`) llevan punto verde; el spinner queda
  para `build`, `restore` y `test`.
- **`[HH:mm:ss {Level:u3}]` no es la plantilla de Serilog.** La hora tiene que ir como marcador
  (`{Timestamp:HH:mm:ss}`); escrita a pelo se imprime literalmente en cada línea y nadie lo nota,
  porque el resto de la línea es correcto. Estuvo así en las seis plantillas desde la v1.1 hasta
  que el visor de registro lo enseñó. Hay una prueba que lo vigila.
- **Un marco de pila no se parte por espacios.** `at Servicio.Create(CreateProduct command) in
  C:\ruta\S.cs:line 42` tiene espacios en los argumentos y dos puntos en la unidad de Windows: hay
  que anclar al último paréntesis de la firma y exigir que la ruta acabe en extensión de código.
- **Una prueba de tamaño no es una prueba de contenido.** El tope de 400 KB del bundle del renderer
  quería decir "Monaco no está dentro" y lo que decía era "el renderer no ha crecido": se puso en
  rojo al añadir dos vistas legítimas. Ahora compara el bundle con la carpeta `vendor/monaco` que
  dice no incrustar, que es la propiedad de verdad.
- **Un servidor que dice "listo" no dice que sepa nada.** `Microsoft.CodeAnalysis.LanguageServer`
  completa el handshake y luego devuelve `null` a hover, completado, símbolos y tokens si no se le
  ha mandado `solution/open`. Y si su gráfico MEF falla, muere **después** de contestar a
  `initialize`. Su stderr va ahora a la consola del proceso principal: un proveedor que devuelve
  siempre vacío es indistinguible de uno que funciona si nadie mira el error.
- **Monaco pide los tokens semánticos una sola vez** por versión del documento. Si la primera
  respuesta llega vacía —el servidor todavía está cargando la solución—, el archivo se queda con los
  colores de la gramática hasta que se escriba en él. Hace falta `onDidChange` en el proveedor.
- **`semanticHighlighting.enabled` hay que encenderlo.** Su valor por defecto es
  `configuredByTheme`, y un tema definido con `defineTheme` no lo activa: el proveedor se registra,
  el servidor responde y no se ve absolutamente nada.
- **`dotnet-counters monitor` revienta con la salida redirigida** (`NullReferenceException` antes
  del primer valor). Para leerlo desde un programa hay que usar `collect --format csv`.
- **Los contadores cambiaron de nombre en .NET 9.** Buscar `CPU Usage` en una aplicación net9.0 o
  net10.0 no encuentra nada: ahora es `dotnet.process.cpu.time`, en segundos por intervalo y con el
  número de núcleos en su propio contador.
- **El TRX escribe los saltos de línea como `&#xD;&#xA;`.** El parser de XML traduce las entidades
  con nombre, no las referencias numéricas, así que la traza de un fallo sale con ellas dentro.
- **`dotnet watch` no tiene `--verbosity`.** Tiene `--verbose`, y va antes del subcomando; todo lo
  que va detrás se lo pasa a la aplicación hija, así que la bandera equivocada llega como argumento
  de la aplicación en vez de fallar.
- **La expresión de `--probe=` tiene que ir en una sola línea.** Con saltos de línea el modo de
  diagnóstico contesta `PROBE_FAIL` sin más detalle, y parece un error de la expresión —un
  `try/catch` alrededor tampoco atrapa nada, porque no llega a ejecutarse—. Se escribe todo seguido
  con `;`, aunque quede largo.
- **Un servidor de lenguaje puede apagarse limpiamente por una respuesta tuya.**
  `workspace/configuration` contestada con `null` hace que Roslyn rompa su cola de mensajes y salga
  **con código 0 y sin nada en stderr**, segundos después de decir que está listo. La regla general:
  contestar algo no es contestar bien, y las peticiones del **servidor al cliente** existen aunque
  el 99 % del tráfico vaya al revés (ADR-043).
- **Un paquete correcto puede quedar mal instalado.** Del servidor de Roslyn, un archivo de 462
  quedó truncado en disco a 5 MiB exactos con el `.nupkg` íntegro y su SHA-256 coincidiendo. Un
  marcador que guarda el hash de lo descargado verifica un archivo que ya no está en el disco: hay
  que verificar lo extraído, archivo a archivo (ADR-041). Una cifra redonda —5.242.880— en el tamaño
  de un binario no la produce un compilador; la produce un archivo cortado.
- **Un `.zip` de release no dice de qué plataforma es por su extensión.** electron-builder publica
  `…-win-x64.zip` y `…-mac-arm64.zip`, y el filtro por extensión los acepta los dos. Elegir el
  artefacto de una actualización exige descartar las marcas de las *otras* plataformas, no sólo
  quedarse con la extensión correcta; si no, un Linux se baja el portable de Windows.
- **`GET /releases` de un repositorio sin publicar responde 404, no `[]`.** Un repositorio público
  con cero releases devuelve una lista vacía; uno privado o inexistente, un 404. Enseñar
  "404 Not Found" a quien pulsa "Buscar ahora" convierte un estado normal en un error incomprensible.
- **Añadir una herramienta a la barra de actividad desplaza los índices de `--ui=`** (otra vez). La
  Fase 17 metió "Extensiones" en el 9 y "Ajustes" pasó al 10, lo que habría roto en silencio
  `settings`, `light`, `probe-theme` y `ai-toggle`.
- **Un modelo de texto que ya trae su marca no se pinta dentro de una `<ul>`.** Las notas de una
  release convierten `- ` en `· ` a propósito —los encabezados no llevan marca y las viñetas sí—, y
  meterlas en una lista de verdad pinta dos viñetas en unas líneas y ninguna en otras.
- **Un clon limpio no es tu árbol de trabajo.** La suite pasaba en local y falló en CI en la primera
  ejecución del pipeline sobre un checkout nuevo, por dos motivos a la vez: las plantillas llegaron
  con CRLF (Git para Windows y los runners traen `core.autocrlf` activado) y el binario de Electron
  no estaba. Lo que pruebes en una carpeta que lleva meses instalada no prueba lo que verá el
  siguiente. Hay `.gitattributes` con `eol=lf` desde la v2.1.0, pero la regla de fondo sigue: las
  comparaciones sobre archivos del repositorio se normalizan al leer.
- **`electron` ya no se instala solo.** Desde la 43 el paquete **no declara script de instalación**:
  el binario lo baja su propio bin (`node node_modules/electron/install.js`, idempotente). Y npm 11
  además bloquea los scripts de instalación pendientes de aprobación —lo avisa con
  `packages have install scripts not yet covered by allowScripts`—, así que ni siquiera los paquetes
  que sí los declaran los ejecutan. En CI hay que instalarlo en un paso explícito.
- **La API de GitHub sin autenticar da 403 en CI, no 429.** Son 60 peticiones por hora **y por IP**,
  y la IP de un runner compartido está agotada casi siempre. El mensaje no menciona el límite, así
  que parece un problema de permisos o de red. Con `GITHUB_TOKEN` en el entorno son 5 000/hora.
- **Una caché de paquetes puede estar restaurada y a medias.** En macOS, la Web API generada compiló
  en 7 s —imposible en frío— y murió al arrancar con `Could not load file or assembly
  'Microsoft.EntityFrameworkCore'`: el `project.assets.json` daba el paquete por restaurado y el DLL
  no estaba en la caché. Un build rápido de más es una señal, no una suerte; la clave de la caché
  lleva versión (`-v2-`) para poder descartarla entera.
