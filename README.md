<div align="center">

<img src="resources/icons/icon-128.png" width="96" alt="DotForge IDE" />

# DotForge IDE

**Entorno de desarrollo de escritorio para C#, .NET 9+ y Blazor, con generador de arquitecturas de software.**

Windows · macOS · 100% open source

</div>

---

## Qué es

DotForge IDE es una distribución de IDE construida sobre **Electron + Monaco Editor** y pensada
específicamente para el flujo de trabajo de un desarrollador .NET: abrir una solución, entender su
estructura, escribir C# y Razor con IntelliSense, compilar, ejecutar, depurar y gestionar paquetes
NuGet sin salir de la ventana.

Su módulo diferencial es el **asistente de arquitecturas**: genera soluciones .NET completas —
Clean Architecture, Hexagonal o DDD + CQRS — que **compilan, pasan sus pruebas y se ejecutan**
desde el primer minuto, con un CRUD funcional de ejemplo. Desde la v1.4.0 lleva además un
**asistente de IA que conoce esa arquitectura** y ayuda sin romperla, y desde la v1.5.0 un
**panel visual de control de código fuente**, pastillas de estado de los procesos en marcha y un
control del nivel de detalle de la salida de la CLI de .NET. La v1.6.0 añade el **gestor visual de
Entity Framework Core** y un **cliente HTTP integrado** para probar la API que estás escribiendo, y
la v1.7.0 un **visor de registro estructurado**, un **linter de reglas de arquitectura** y
autocompletado de Docker, Azure y npm en la terminal. La v1.8.0 añade un **panel de contenedores y
Docker Compose** para levantar los servicios de apoyo sin salir del IDE, y la v1.9.0 cierra el
círculo del día a día: **explorador de pruebas** con lentes de código sobre cada `[Fact]`,
**resaltado de C# estilo Visual Studio** alimentado por el compilador, **monitor de rendimiento**,
**túneles públicos** para probar webhooks y **auditoría de vulnerabilidades** de los paquetes.
La v2.0.0 hace que todo eso descanse sobre algo que por fin funciona: el **IntelliSense de C#**.
La versión del servidor de Roslyn se fija y se verifica en vez de coger la última compilación
publicada, cada instalación se comprueba archivo a archivo antes de lanzarla, y si el servidor
falla el IDE **conmuta solo a OmniSharp** sin que tengas que enterarte.
La v2.1.0 añade lo que le faltaba a la distribución: el IDE **se actualiza solo** —te avisa en una
tarjeta y se instala al cerrar, sin interrumpirte— y trae un **explorador de extensiones de Open
VSX** para buscar, instalar y desinstalar `.vsix` desde el registro abierto.

![DotForge IDE con una solución DDD abierta](docs/screenshot-workspace.png)

---

## Índice

- [Características](#características)
- [Control de código fuente](#control-de-código-fuente)
- [Asistente de IA](#asistente-de-ia)
- [Base de datos y Entity Framework Core](#base-de-datos-y-entity-framework-core)
- [Cliente HTTP integrado](#cliente-http-integrado)
- [Registro estructurado](#registro-estructurado)
- [Linter de reglas de arquitectura](#linter-de-reglas-de-arquitectura)
- [Contenedores y Docker Compose](#contenedores-y-docker-compose)
- [Explorador de pruebas](#explorador-de-pruebas)
- [Monitor de rendimiento](#monitor-de-rendimiento)
- [Túnel público para webhooks](#túnel-público-para-webhooks)
- [Auditoría de seguridad de NuGet](#auditoría-de-seguridad-de-nuget)
- [Extensiones de Open VSX](#extensiones-de-open-vsx)
- [Actualizaciones automáticas](#actualizaciones-automáticas)
- [Instalación](#instalación)
- [El generador de arquitecturas](#el-generador-de-arquitecturas)
  - [Clean Architecture](#clean-architecture)
  - [Arquitectura Hexagonal](#arquitectura-hexagonal)
  - [DDD + CQRS](#ddd--cqrs)
  - [Opciones del generador](#opciones-del-generador)
  - [Uso desde la línea de comandos](#uso-desde-la-línea-de-comandos)
- [Atajos de teclado](#atajos-de-teclado)
- [Arquitectura interna del IDE](#arquitectura-interna-del-ide)
- [Compilar y empaquetar](#compilar-y-empaquetar)
- [Pruebas](#pruebas)
- [Componentes open source](#componentes-open-source)
- [Limitaciones conocidas](#limitaciones-conocidas)
- [Documentación del proyecto](#documentación-del-proyecto)

---

## Características

### Generador de arquitecturas

- Tres arquitecturas de referencia listas para producción: **Clean**, **Hexagonal** y **DDD + CQRS**.
- Asistente visual de tres pasos y CLI equivalente (`dotforge`), sobre el **mismo motor**.
- Cada solución generada incluye CRUD funcional, Web API minimal con OpenAPI, UI Blazor
  interactiva, pruebas unitarias, logging estructurado y persistencia configurada.
- Solución reproducible: los GUID del `.sln` son deterministas, así que regenerar produce el mismo
  archivo y los diffs son limpios.

### Editor

- **Monaco Editor** con IntelliSense de C# vía **Roslyn LanguageServer** (con OmniSharp de respaldo):
  completado, hover, ayuda de firma, ir a la definición, buscar referencias, renombrar, formatear
  y diagnósticos en vivo.
- **Resaltado semántico estilo Visual Studio**: el color no lo decide la gramática, lo decide el
  compilador. Los tipos se leen en verde azulado, las interfaces en verde agua, lo que se invoca en
  dorado, los miembros de datos en azul claro, las locales y los parámetros en gris claro y el flujo
  de control en púrpura. En un `Program.cs` de veinte líneas, `WebApplication` se distingue de
  `CreateBuilder` sin tener que leerlos.
- Gramática **Razor/Blazor** propia: distingue directivas (`@page`, `@code`), bloques de control
  (`@foreach`, `@if`), C# incrustado, componentes Blazor y etiquetas HTML.
- Auto-cierre de etiquetas que respeta las void (`<br>`) y las autocerradas (`<Foo />`).
- 13 snippets de Blazor (`@page`, `@code`, `EditForm`, `@bind`, `[Parameter]`, …).
- Pestañas con estado de scroll y cursor por archivo, y aviso de cambios sin guardar.

![Editor con un componente Blazor generado](docs/screenshot-editor.png)

### Soluciones .NET

- **Explorador de soluciones** que lee `.sln`, `.slnx` y `.csproj` SDK-style, con carpetas de
  solución, referencias de proyecto y de paquete, y target framework heredado de
  `Directory.Build.props`.
- Cada proyecto lleva una **insignia** con lo que realmente es —Blazor, Web API, librería, pruebas,
  worker— deducida del SDK y del contenido, no del nombre.
- **Anidamiento de archivos**: `Home.razor.cs` y `Home.razor.css` cuelgan de `Home.razor`, y
  `appsettings.Development.json` de `appsettings.json`. Agrupa, nunca oculta: si el archivo padre
  no existe, el hijo se queda a la vista.
- **Guías de sangría** que resaltan el nivel activo, para que una jerarquía Clean o DDD siga
  siendo legible siete niveles adentro.
- `bin`, `obj`, `.vs`, `.git` y `node_modules` están ocultos por defecto.
- Filtro por nombre y "contraer todo" en la cabecera del panel.
- Vista alternativa de archivos para lo que no pertenece a ningún proyecto.
- Menú contextual por proyecto: compilar, ejecutar, hot reload, pruebas, paquetes.

![Explorador de soluciones con anidamiento e insignias](docs/screenshot-tree.png)

### Compilación y ejecución

- **Selector de inicio en la barra superior**, al estilo de Visual Studio y Rider: qué proyecto se
  arranca, con qué modo y el botón de Play, siempre a la vista.
- **Perfiles multiproyecto**: marca varios proyectos, ordénalos y guarda el conjunto con nombre
  ("Backend + Web"). Se guardan por solución, fuera del repositorio.
- Dos modos claros: **Depurar** (F5), que engancha NetCoreDbg y aplica `launchSettings.json`, y
  **Sin depurar** (Ctrl+F5), que arranca las webs con Hot Reload.
- **Pastillas de estado en la barra superior**: con un perfil multiproyecto en marcha, cada
  proceso aparece con su color de estado y su puerto (`● Adapters.Web :5585`). Un clic enfoca su
  salida; un clic en el puerto abre la aplicación en el navegador.
- **Un canal de salida por proceso**, con el nombre del proyecto, su insignia de tipo (Web API,
  Blazor, CLI…), el estado (`En ejecución`, `Detenido`, `Error`), el enlace HTTPS y botones para
  **reiniciar o detener sólo ese proceso**, sin tocar los demás del perfil.
- **El proyecto que se depura es uno más.** En modo depuración sólo el primero del perfil lleva el
  depurador enganchado (hay una única sesión de NetCoreDbg), y eso se ve donde importa: su pastilla
  y su canal llevan el icono de depuración y dicen `Depurando`, y el diálogo de perfiles marca cuál
  es con la insignia `depurado`, justo al lado de las flechas que cambian el orden. Su salida y su
  puerto van a **su** canal, no al de compilación.
- **Nivel de salida de la CLI de .NET** configurable en Ajustes (`Minimal`, `Normal`, `Detailed`,
  `Diagnostic`). Se aplica a `build`, `run`, `watch`, `test`, `clean`, `restore` y a la depuración;
  en los niveles altos añade el registro de ASP.NET Core, los errores detallados y la traza de
  carga de ensamblados del host.
- Tareas de `dotnet`: `build`, `rebuild`, `clean`, `restore`, `test`, `run` y `watch`.
- La salida de MSBuild se convierte en **diagnósticos clicables** que llevan a la línea exacta, y
  se pintan como marcadores en el editor.
- **Hot Reload** con `dotnet watch`, con detección de la URL en la que queda escuchando la app.
- Terminal integrada para `dotnet`, `git`, `npm` y compañía, con historial y **autocompletado
  contextual**: subcomandos de git y de la CLI de .NET, **ramas reales del repositorio** tras
  `git checkout` o `git switch`, proyectos de la solución tras `--project` y paquetes NuGet
  habituales tras `dotnet add package`. Se acepta con `Tab` o con la flecha derecha.

### Depuración

- **NetCoreDbg** (MIT) hablando Debug Adapter Protocol.
- Breakpoints en el margen del editor, pila de llamadas, variables expandibles, evaluación de
  expresiones y controles de paso (F5 / F9 / F10 / F11).

### Control de código fuente

Un panel de git completo en la barra lateral (`Ctrl+Shift+G`), con lo que se usa a diario:

- **Dos secciones colapsables**: *Cambios preparados* y *Cambios*, con una letra por archivo —
  `M` modificado, `A` añadido, `D` eliminado, `U` sin rastrear— y los conflictos marcados aparte.
- **Acciones al pasar el ratón**: `+` prepara, `-` quita de preparados y `↩` descarta. Descartar
  pide confirmación y dice qué va a pasar: un archivo con seguimiento vuelve a su última versión,
  uno sin rastrear **se borra del disco**.
- **Editor de diferencias lado a lado**: al pulsar un archivo se abre la comparación real —
  `HEAD ↔ Índice` para lo preparado, `Índice ↔ Local` para lo que no lo está— en su propia pestaña.
  Doble clic abre el archivo para editarlo.
- **Caja de mensaje multilínea** con `Ctrl+Enter` para confirmar, y casilla para enmendar el
  último commit.
- **Commit, Push, Pull y Sync**, con el indicador de commits por delante y por detrás (`↑2 ↓1`).
  La primera publicación de una rama crea su rama de seguimiento sola; `Pull` es siempre
  `--ff-only`, para no fusionar nada a tus espaldas.
- **Selector de rama** en la cabecera, con las ramas locales y remotas y la creación de una rama
  nueva (`git checkout -b`).

Se usa el `git` del sistema, no una reimplementación: worktrees, submódulos, hooks y gestores de
credenciales se comportan exactamente igual que en tu terminal.

### Asistente de IA

El **DotForge AI Assistant** no es un chat genérico pegado a un editor: sabe qué arquitectura tiene
la solución abierta y responde respetando sus reglas. Si le pides meter un `DbContext` en el
proyecto de dominio, te dice por qué no y dónde va.

- **Panel de chat** (sexto icono de la barra de actividad, `Ctrl+Shift+A`) con respuesta en tiempo
  real, token a token. Los bloques de código traen botones de **Copiar** y **Aplicar**.
- **Contexto automático** en cada mensaje: el archivo abierto, la selección si la hay, la
  arquitectura detectada de la solución (por el manifiesto `dotforge.json` o por la forma de sus
  proyectos) y los errores de compilación activos. Cada pieza se puede desactivar en Ajustes.
- **Asistente en línea** con `Ctrl+I` sobre el código seleccionado: describes el cambio en
  castellano ("mueve esto a un Value Object", "conviértelo a LINQ", "hazlo asíncrono") y el IDE
  enseña **una vista previa de las diferencias** dentro del propio editor, con lo nuevo resaltado y
  lo que desaparece listado. `Enter` acepta, `Esc` descarta, `Ctrl+Z` deshace.
- **Acciones rápidas** en el menú contextual del editor y del árbol de archivos: *Explicar el código
  con IA*, *Generar pruebas xUnit* y *Corregir violación de arquitectura*.
- **Se puede apagar** desde Ajustes. Al hacerlo, su icono sigue en la barra de actividad pero
  atenuado y sin responder al clic, con un aviso que recuerda dónde volver a encenderlo: una
  herramienta desactivada no debería desaparecer sin dejar rastro.
- **Tres proveedores**, elegibles en Ajustes:

  | Proveedor | Modelos | Notas |
  |---|---|---|
  | Anthropic | Claude Opus 5, Sonnet 5, Haiku 4.5 (+ 3.7 Sonnet y 3.5 Haiku) | Requiere clave de API |
  | OpenAI | GPT-4o, o3-mini | Requiere clave de API |
  | Local (Ollama) | `deepseek-coder`, `llama3.2`, `qwen2.5-coder`… | Nada sale del equipo |

- **Las claves se guardan cifradas** con el llavero del sistema operativo (DPAPI en Windows,
  Keychain en macOS). Si el sistema no ofrece cifrado, la clave se queda en memoria durante la
  sesión y **no se escribe en disco**: el IDE lo avisa en vez de dejar un secreto en claro.
- El botón **Probar conexión** comprueba clave y endpoint antes de la primera pregunta, y con
  Ollama lista los modelos que tienes instalados.

> **Privacidad.** Con el proveedor local no sale nada del equipo. Con Anthropic u OpenAI, el
> contexto marcado en Ajustes viaja a su API en cada mensaje: si trabajas bajo NDA, revisa esos
> cuatro interruptores o usa Ollama.

### Base de datos y Entity Framework Core

Un panel en la barra de actividad (`Ctrl+Shift+D`) que responde a la pregunta de siempre: *¿en qué
estado está la base de datos?*

- **Migraciones**: la lista completa con su fecha, marcando cuáles están aplicadas y cuáles
  pendientes. Un clic abre el archivo de la migración en el editor.
- **Crear y aplicar**: escribe el nombre, pulsa `+` y se ejecuta `dotnet ef migrations add`; el
  botón "Actualizar la base de datos" lanza `dotnet ef database update` y lleva la cuenta de
  cuántas migraciones pendientes hay. La salida va al panel inferior, como la de un `build`, y se
  puede cancelar. Quitar la última migración avisa antes si ya estaba aplicada.
- **Esquema deducido**: tablas, columnas, tipos, nulabilidad, claves e índices, leídos de los
  archivos de migración del repositorio. El IDE **no se conecta a la base de datos**: no hace falta
  tenerla levantada ni dar credenciales, y a cambio lo que ves es el esquema según el código. Una
  migración que ejecuta SQL directo se marca como tal, porque su efecto no se puede deducir.
- **Cadenas de conexión**: las de todos los `appsettings*.json` del proyecto, con el proveedor
  detectado (SQL Server, PostgreSQL, SQLite, MySQL), el servidor y la base de datos separados, y la
  **contraseña tapada**. Un clic abre el archivo.

El proyecto con las migraciones y el proyecto de arranque se eligen arriba: el panel propone el que
referencia EF Core y la Web API, que es lo que quieres el 95% de las veces.

> Necesita las herramientas de EF Core. Si no están, el panel lo dice con la orden exacta:
> `dotnet tool install --global dotnet-ef`.

### Cliente HTTP integrado

Probar un endpoint sin salir del IDE ni abrir otra aplicación.

- **Archivos `.http` y `.rest`** con resaltado propio: separadores `###`, verbo, URL, cabeceras,
  variables y cuerpo JSON, cada uno con su color.
- **"Enviar petición"** aparece como lente de código sobre cada bloque. La respuesta se abre en la
  pestaña **HTTP** del panel inferior: estado con su color, tiempo, tamaño, cuerpo reindentado,
  cabeceras y el historial de las últimas veinte peticiones para comparar.
- **Variables**: `@host = https://localhost:7001` en la cabecera del archivo y `{{host}}` donde
  haga falta, incluidas las variables que se refieren a otras. También `{{$guid}}`, `{{$timestamp}}`
  y `{{$randomInt}}`. Una variable que no existe se deja a la vista, para que se sepa qué falta.
- **Genera las pruebas por ti**: sobre cada endpoint de C# —Minimal API con `MapGet`/`MapGroup` o
  un controlador con `[Route("api/[controller]")]`— aparece una lente `Probar GET /api/products`
  que **añade** esa petición al `.http` del proyecto, con los parámetros de ruta rellenos y un
  cuerpo de ejemplo si el verbo lo lleva. Si hay un proceso corriendo, usa su puerto real.

```http
@host = https://localhost:7001

### Listar productos
GET {{host}}/api/products
Accept: application/json

### Crear producto
POST {{host}}/api/products
Content-Type: application/json

{
  "nombre": "Teclado mecánico",
  "precio": 89.9
}
```

> El certificado de desarrollo de ASP.NET Core es autofirmado. El cliente lo acepta **sólo** cuando
> el destino es `localhost`, `127.0.0.1` o `::1`; contra un host remoto, un certificado inválido
> sigue siendo un error.

### Registro estructurado

La pestaña **Registro** del panel inferior (`Ctrl+Shift+L`) lee la salida de la aplicación y la
convierte en eventos, no en un muro de texto.

- **Reconoce lo que escribe una solución .NET real**, sin configurar nada: Serilog (con la
  plantilla corta y con marca de tiempo completa), el registro por consola de
  `Microsoft.Extensions.Logging` —el de dos líneas del arranque—, NLog y JSON compacto (CLEF). Los
  cuatro pueden convivir en la misma salida, que es justo lo que pasa al arrancar.
- **Filtro por nivel** con la cuenta de cada uno (`Todo`, `Info`, `Aviso`, `Error`, `Crítico`) y
  filtro de texto que busca también dentro de las excepciones.
- **Las excepciones no se pierden**: la traza queda pegada al evento que la provocó y se despliega
  al pulsarlo.
- **Los marcos de pila son clicables** y abren el `.cs` exacto en su línea. Funciona igual con el
  runtime en español, donde la traza dice `en … :línea 42` en vez de `at … :line 42`.

### Linter de reglas de arquitectura

El IDE conoce la arquitectura de la solución abierta y avisa cuando una dependencia la rompe. Los
avisos salen en el panel de problemas y en el margen del editor, siempre como **advertencia**:
romper una regla de arquitectura no impide compilar, y pintarlo en rojo junto a los errores del
compilador sólo enseñaría a ignorar los dos.

| Código | Qué detecta | Ejemplo |
|---|---|---|
| `DF1001` | Referencia de proyecto prohibida entre capas | `Acme.Shop.Domain` referencia a `Acme.Shop.Infrastructure` |
| `DF1002` | `using` de una capa prohibida, con su línea | `using Acme.Shop.Infrastructure.Persistence;` dentro del dominio |
| `DF1003` | Paquete de infraestructura en el núcleo | `Microsoft.EntityFrameworkCore` en `.Domain` |

Las reglas dependen de la arquitectura detectada: en Clean y en DDD el dominio sólo ve al Shared
Kernel y la aplicación no ve la infraestructura; en Hexagonal el núcleo (`.Domain` + `.Ports`) no ve
ningún adaptador. La presentación **sí** puede ver la infraestructura en las tres: es la raíz de
composición, donde se registran las implementaciones en el contenedor de dependencias.

Ante la duda, el linter calla: un proyecto con un nombre que no encaja en ninguna capa, o una
solución cuya arquitectura no se reconoce, no producen ni un aviso.

### Terminal: Docker, Azure y npm

El autocompletado de la terminal integrada ya no se limita a `git` y `dotnet`:

- **Docker y Docker Compose** — subcomandos ordenados por uso real (`compose up -d` el primero) y,
  lo que de verdad ahorra tiempo, **tus contenedores** tras `docker logs`, `exec`, `stop` o `rm`, y
  **tus imágenes locales** tras `docker run`.
- **Azure CLI** — el camino de un desarrollador .NET: `az webapp up`, `az webapp log tail`,
  `az group create`, `az sql db create`, `az containerapp up`, `az acr build`. Al escribir el grupo
  (`az webapp `) se ofrecen sus operaciones.
- **npm** — subcomandos y, tras `npm run`, **los scripts de tu `package.json`**, no una lista
  inventada.

### Contenedores y Docker Compose

Un panel en la barra de actividad (`Ctrl+Shift+K`) con los servicios de apoyo que necesita el
proyecto y el botón para levantarlos.

- **La lista sale de tu `docker-compose.yml`**, no de lo que haya corriendo. Eso significa que el
  panel sirve **con todo apagado**, que es justo cuando hace falta: te dice qué necesita esta
  solución para arrancar. Se busca en la raíz del workspace y un nivel por debajo (`deploy/`,
  `docker/`, `infra/`), y si hay varios, se elige cuál manda.
- **Estado real por servicio**: un punto verde si está arriba, el recuento `3/4 arriba` en la
  cabecera y los puertos publicados. Los servicios conocidos se enseñan con su nombre de verdad —
  SQL Server, PostgreSQL, MySQL, MongoDB, Redis, RabbitMQ, Kafka, Elasticsearch, Seq, Azurite,
  MailHog— en lugar de con el nombre de la imagen.
- **Acciones donde se necesitan**: *Levantar* y *Bajar* todo el compose, y por servicio arrancar,
  parar, reiniciar o ver su registro. Todo va al panel de salida, con su botón de cancelar, como
  cualquier compilación.
- **El puerto es un enlace** cuando lleva a algo que se abre en un navegador (la interfaz de Seq,
  la de RabbitMQ, MailHog). Para una base de datos no lo es: `http://localhost:1433` no lleva a
  ninguna parte.
- Los contenedores que **no** son de este compose se listan aparte, sin mezclarlos con los tuyos.

> Sin Docker instalado o con el motor parado, el panel no se queda en blanco: sigue enseñando los
> servicios declarados, con las acciones deshabilitadas y un aviso que dice qué pasa.

### Explorador de pruebas

Un panel en la barra de actividad (`Ctrl+Shift+Y`) con el árbol **proyecto → clase → prueba**, y una
lente de código sobre cada `[Fact]` y cada `[Theory]` del editor.

- **El árbol está lleno al abrir la solución**, sin compilar nada: las pruebas se descubren leyendo
  el código. Eso significa que la lente aparece también sobre la prueba que acabas de escribir y que
  todavía no compila. Se reconocen xUnit (`[Fact]`, `[Theory]`), NUnit (`[Test]`) y MSTest
  (`[TestMethod]`).
- **Ejecuta lo que quieras**: todas, las de un proyecto, las de una clase, las de un archivo o una
  sola desde su lente. La salida va al panel inferior como cualquier compilación, con su cancelar.
- **Estado por prueba** — 🟢 correcta, 🔴 con error, 🟡 omitida — y agregado por clase y por
  proyecto. Ejecutar una prueba suelta no borra el resultado de las demás.
- **El fallo se lee donde está**: mensaje del assert y traza completa bajo la prueba, y además en el
  panel de problemas con su archivo y su línea, para saltar al código de un clic.
- Los resultados salen del **TRX** que genera `dotnet test`, no de la consola: así el estado de una
  prueba no depende del idioma de tu Windows.

### Monitor de rendimiento

Una pestaña "Métricas" en el panel inferior que lee los contadores que el propio runtime publica.
No hay que instrumentar la aplicación ni añadirle ningún paquete.

- **CPU**, **montón administrado**, **conjunto de trabajo**, **tasa de reserva**, **colecciones de
  GC por generación**, **tiempo en GC**, **hilos del pool** y, si es una web, **peticiones en
  curso**.
- Valor, barra y una línea de tendencia del último minuto por métrica.
- Elige a qué proceso .NET engancharse: normalmente el que acabas de arrancar con F5.

> Necesita `dotnet-counters`. Si no está, el panel lo dice y te da la orden para instalarlo:
> `dotnet tool install --global dotnet-counters`.

### Túnel público para webhooks

Un botón en la barra superior que publica el puerto local en una URL HTTPS accesible desde internet,
para que Stripe, GitHub o un bot puedan llamar a la API que tienes corriendo.

- Usa `devtunnel` (Microsoft) o `ngrok`, lo que tengas instalado.
- El puerto se propone a partir del proceso que ya está en marcha, para no publicar el equivocado.
- La URL aparece en el panel de salida en cuanto la herramienta la anuncia, y el botón pasa a
  cerrarlo.

> El túnel expone ese puerto en internet mientras esté abierto. El IDE lo dice al abrirlo.

### Auditoría de seguridad de NuGet

Dentro del panel de NuGet, una sección **Seguridad** que cruza los paquetes restaurados con los
avisos de GitHub Security Advisories (`dotnet list package --vulnerable`).

- Gravedad, versión afectada y el identificador del aviso (**GHSA** o **CVE**) como enlace.
- **Incluye los transitivos**, marcados como tales y diciendo en qué proyecto entran: la
  vulnerabilidad casi nunca está en el paquete que instalaste.
- El número de paquetes con aviso aparece como insignia sobre el icono de NuGet.

### Paquetes NuGet

- Panel visual: buscar en nuget.org, ver lo instalado, elegir versión, instalar y desinstalar.
- Los iconos de los paquetes se dibujan localmente: el panel no revela a terceros qué estás mirando.

### Extensiones de Open VSX

Panel lateral para buscar, instalar y desinstalar extensiones del registro abierto
[open-vsx.org](https://open-vsx.org), que sirve los mismos `.vsix` que el marketplace de VS Code con
una licencia que sí permite consumirlos desde otro producto.

- Buscador por texto y filtro por categoría; sin término de búsqueda, las más descargadas.
- Las instaladas van arriba, con su versión y el botón de desinstalar; se guardan en
  `userData/extensions/` y se verifican archivo a archivo al instalarse.
- **Cada ficha dice qué aporta de verdad.** DotForge no ejecuta el código de activación de una
  extensión: aprovecha lo declarativo (temas de color, fragmentos, gramáticas de resaltado,
  definiciones de lenguaje) y lo dice en la propia tarjeta, junto a lo que no tendrá efecto aquí.
- La búsqueda y la descarga las hace el proceso principal, y sólo desde los hosts de Open VSX. Los
  iconos se dibujan localmente: el panel no revela a terceros qué estás mirando.

### Actualizaciones automáticas

- El IDE comprueba si hay una versión posterior **cinco segundos después de arrancar**, y también
  cuando pulsas "Buscar ahora" en Ajustes.
- Si la hay, aparece una tarjeta flotante con la versión, las notas de la publicación y dos
  opciones: **Actualizar**, que descarga con barra de progreso y deja el botón "Reiniciar y
  aplicar"; o **Descartar**, que esconde el aviso, sigue descargando en segundo plano e instala
  sola la próxima vez que cierres el IDE.
- La comprobación automática se apaga desde Ajustes → **Actualizaciones**. El botón "Buscar ahora"
  sigue funcionando con ella apagada.
- En Windows la instalación es silenciosa (instalador NSIS). En macOS se abre la imagen de disco al
  cerrar y hay que arrastrar la app a Aplicaciones: sin certificado de firma no hay forma honesta
  de hacerlo solo, y la tarjeta lo dice en vez de fingir lo contrario.

### Producto

- Tema **DotForge Purple** (oscuro) y variante clara, con contraste AA. Tonos apagados, sin negros
  ni blancos puros: el fondo más oscuro es `#1b1d27` y el texto más claro `#c8cee2`, pensado para
  sesiones largas.
- **61 iconos vectoriales propios** en una sola rejilla, incluidas las marcas del ecosistema (C#,
  Razor, solución, proyecto) y de las carpetas con significado: `Controllers`, `Models`,
  `Services`, `Pages`, `Components`, `Domain`, `Ports`, `wwwroot`…
- Barra de actividad con una herramienta por dominio y barra de estado con lo imprescindible: SDK
  activo, estado del servidor de lenguaje, rama de Git y errores.
- **Ajustes** en la barra lateral, con efecto inmediato: tema, tamaño de fuente, tabulación,
  minimapa, ajuste de línea, formateo al guardar e IntelliSense.
- Iconografía multirresolución propia: `.ico` (7 tamaños), `.icns` (11 entradas), PNG de 16 a 1024.
- Paleta de comandos con todo lo que hace el IDE, buscable por teclado.
- Atajos compatibles con Windows y macOS.

---

## Instalación

### Usuarios

Descarga el artefacto de tu plataforma desde `dist/` o desde los artefactos del workflow de CI:

| Plataforma | Artefacto | Notas |
|---|---|---|
| Windows | `DotForge IDE-1.3.1-Setup-x64.exe` | Instalador NSIS; permite elegir carpeta |
| Windows | `DotForge IDE-1.3.1-win-x64.zip` | Portable, sin instalación |
| macOS | `DotForge IDE-1.3.1-arm64.dmg` | Apple Silicon |
| macOS | `DotForge IDE-1.3.1-x64.dmg` | Intel |

> Los artefactos no están firmados: Windows mostrará el aviso de SmartScreen y macOS pedirá
> confirmación en Gatekeeper. Es lo esperado sin certificado de desarrollador.

**Requisito:** el [SDK de .NET](https://dotnet.microsoft.com/download) 9 o 10 en el `PATH`. Sin él,
DotForge funciona como editor pero no puede compilar, ejecutar ni depurar; la pantalla de
bienvenida lo indica.

La primera vez que abres una solución, DotForge descarga el servidor de lenguaje (~90 MB) y, al
depurar por primera vez, NetCoreDbg. Ambos quedan cacheados. Para pre-descargarlos:

```bash
npm run fetch:toolchain
```

### Desarrolladores

```bash
npm install
npm run build
npm start
```

Abrir una carpeta o un archivo directamente:

```bash
npx electron . /ruta/a/mi/solucion
```

---

## El generador de arquitecturas

Abre el asistente con **Ctrl/Cmd+Shift+N**, o desde la pantalla de bienvenida, o con el icono ✨ de
la barra de actividad.

### Clean Architecture

Cuatro capas concéntricas con la regla de dependencia apuntando hacia dentro.

```
Acme.Shop/
├── src/
│   ├── Acme.Shop.Domain/            # Entidades, objetos de valor, invariantes. Sin dependencias.
│   ├── Acme.Shop.Application/       # Casos de uso + puertos (repositorio, reloj, unidad de trabajo)
│   ├── Acme.Shop.Infrastructure/    # EF Core, repositorios, reloj del sistema
│   ├── Acme.Shop.WebApi/            # Minimal API + OpenAPI + Scalar
│   └── Acme.Shop.Blazor/            # Blazor interactivo en servidor
└── tests/
    └── Acme.Shop.UnitTests/         # xUnit con dobles en memoria
```

**Qué demuestra:** que el dominio no referencia infraestructura (verificado por los tests), el
patrón `Result` en lugar de excepciones para el flujo esperado, y un objeto de valor `Money`
mapeado como *owned type* de EF Core.

### Arquitectura Hexagonal

Puertos y adaptadores: el núcleo no sabe quién lo llama ni quién le responde.

```
Acme.Iot/
├── src/
│   ├── Acme.Iot.Domain/                    # Núcleo puro
│   ├── Acme.Iot.Ports/                     # Inbound/ (casos de uso) + Outbound/ (repos, avisos, reloj)
│   │                                       # + Application/ (servicios que implementan los de entrada)
│   ├── Acme.Iot.Adapters.Persistence/      # Adaptador conducido: EF Core
│   ├── Acme.Iot.Adapters.Notifications/    # Adaptador conducido no persistente
│   ├── Acme.Iot.Adapters.Web/              # Adaptador conductor: HTTP
│   └── Acme.Iot.Adapters.Blazor/           # Adaptador conductor: UI
└── tests/
    └── Acme.Iot.UnitTests/                 # Ejercita el hexágono con adaptadores dobles
```

**Qué demuestra:** que se puede probar el sistema completo sin base de datos ni servidor web, y que
cambiar de persistencia es escribir otro adaptador. El puerto de notificaciones existe para dejar
claro que un puerto de salida no es sinónimo de base de datos.

> **Nota de diseño:** los servicios de aplicación viven en el proyecto `Ports` para mantener
> exactamente los tres anillos del patrón. Si prefieres separarlos, extrae `Application/` a su
> propio proyecto: no hay que tocar ni el dominio ni los adaptadores.

### DDD + CQRS

La solución más completa: DDD táctico con comandos y consultas separados.

```
Acme.Billing/
├── src/
│   ├── Acme.Billing.SharedKernel/     # Entity, AggregateRoot, ValueObject, IDomainEvent, Result
│   ├── Acme.Billing.Domain/           # Agregado Invoice + VOs (Sku, Money) + eventos de dominio
│   ├── Acme.Billing.Application/      # Commands/, Queries/, EventHandlers/, Dispatcher, Behaviors
│   ├── Acme.Billing.Infrastructure/   # EF Core + repositorio del agregado + publicación de eventos
│   ├── Acme.Billing.WebApi/
│   └── Acme.Billing.Blazor/
└── tests/
    └── Acme.Billing.UnitTests/
```

**Qué demuestra:**

- Un **agregado** con invariantes protegidas: sin setters públicos, todo cambio pasa por métodos
  con nombre de negocio que además registran el evento correspondiente.
- **Objetos de valor** con igualdad estructural (`Sku`, `Money`).
- **Eventos de dominio** que se publican **después** de confirmar la transacción, nunca antes: si
  el guardado falla, esos hechos no ocurrieron.
- **CQRS sin MediatR**: un `IDispatcher` propio de ~150 líneas con envoltorios genéricos cacheados
  y pipeline de comportamientos (logging + validación). Cero fricción de licencia.
- Registro de handlers **por reflexión**: añadir un caso de uso es añadir una clase.

### Opciones del generador

| Opción | Valores | Por defecto | Efecto |
|---|---|---|---|
| Arquitectura | `clean`, `hexagonal`, `ddd` | — | Estructura de la solución |
| Nombre | identificador con puntos | `Acme.Shop` | Prefijo de todos los proyectos |
| Entidad | PascalCase singular | `Product` | Entidad del CRUD de ejemplo (se pluraliza sola) |
| Presentación | `webapi`, `blazor`, `both` | `both` | Qué proyectos de UI se generan |
| Framework | `net9.0`, `net10.0` | `net9.0` | Target y versiones de paquetes |
| Persistencia | `sqlite`, `inmemory` | `sqlite` | Proveedor de EF Core |
| Pruebas | sí / no | sí | Proyecto xUnit |
| Git | sí / no | no | `git init` + commit inicial |

Todo lo generado usa **Central Package Management**: las versiones se declaran una sola vez en
`Directory.Packages.props`.

### Uso desde la línea de comandos

La CLI usa el mismo motor que el asistente visual, así que sirve para CI y scripts:

```bash
node build/cli.js new clean --name Acme.Shop --output ./workspace
```

```bash
node build/cli.js list
```

```bash
node build/cli.js new ddd --name Acme.Billing --entity Invoice --ui webapi --framework net10.0
```

Flags: `--ui`, `--framework`, `--db`, `--entity`, `--no-tests`, `--git`, `--force`, `--json`.

Con `--json` emite el resultado completo (proyectos, archivos, siguientes pasos) para consumirlo
desde otra herramienta.

**Después de generar:**

```bash
cd Acme.Shop && dotnet build && dotnet test
```

---

## Atajos de teclado

En macOS, `Ctrl` es `Cmd`.

| Acción | Atajo |
|---|---|
| Nueva solución con el asistente | `Ctrl+Shift+N` |
| Abrir carpeta | `Ctrl+O` |
| Guardar / Guardar todo | `Ctrl+S` / `Ctrl+Alt+S` |
| Paleta de comandos | `Ctrl+Shift+P` |
| Explorador de soluciones | `Ctrl+Shift+E` |
| **Control de código fuente** | `Ctrl+Shift+G` |
| Confirmar el commit (con el foco en el mensaje) | `Ctrl+Enter` |
| Paquetes NuGet | `Ctrl+Shift+U` |
| **Base de datos y EF Core** | `Ctrl+Shift+D` |
| **Enviar la petición HTTP del cursor** | `Alt+Enter` |
| **Registro de la aplicación** | `Ctrl+Shift+L` |
| **Contenedores y Docker Compose** | `Ctrl+Shift+K` |
| **Explorador de pruebas** | `Ctrl+Shift+Y` |
| **Asistente de IA** | `Ctrl+Shift+A` |
| **Editar con IA la selección** | `Ctrl+I` |
| Problemas | `Ctrl+Shift+M` |
| Terminal | `Ctrl+J` |
| **Compilar solución** | `Ctrl+Shift+B` |
| Recompilar todo | `Ctrl+Alt+B` |
| Ejecutar pruebas | `Ctrl+Shift+T` |
| **Iniciar depuración** | `F5` |
| Hot Reload (`dotnet watch`) | `Ctrl+F5` |
| Detener | `Shift+F5` |
| Alternar breakpoint | `F9` |
| Paso a paso por procedimientos / instrucciones | `F10` / `F11` |
| Salir del método | `Shift+F11` |
| Ir a la definición | `F12` |
| Renombrar símbolo | `F2` |
| Buscar en el archivo | `Ctrl+F` |
| Formatear documento | `Alt+Shift+F` |

---

## Arquitectura interna del IDE

```
src/
├── shared/        Contratos IPC y tipos compartidos (sin dependencias de Node ni Electron)
│   ├── ai*.ts         Catálogo de proveedores, contexto RAG y diferencias del asistente
│   ├── git.ts         Parseo de `git status` y construcción de las comparaciones
│   └── dotnet-verbosity.ts  Nivel de salida -> argumentos y variables de entorno
├── scaffold/      ★ Generador de arquitecturas — Node puro, sin Electron
│   ├── engine.ts      Motor de plantillas estricto: {{token}}, {{#if}}, {{else}}
│   ├── generator.ts   Recorrido, render y escritura
│   ├── blueprints/    Definición de cada arquitectura
│   └── templates/     Archivos .tmpl (C#, .csproj, .razor, .json)
├── cli/           CLI `dotforge`, headless
├── main/          Proceso principal de Electron
│   ├── ipc/           Única superficie expuesta al renderer
│   ├── services/      .sln/.csproj, NuGet, tareas MSBuild, terminal, rutas, ZIP, git
│   │   └── ai/        ★ Asistente: proveedores, streaming, claves cifradas
│   ├── lsp/           Adquisición y cliente del servidor de lenguaje
│   └── debug/         Adquisición de NetCoreDbg y bridge DAP
└── renderer/      UI
    ├── languages/     Gramática Razor y auto-cierre de etiquetas
    ├── views/         Explorador, git, editor, NuGet, panel, wizard, paleta, depuración, IA
    └── styles/        Tokens de tema y componentes
```

**Decisiones que explican la forma del código:**

- **Electron + Monaco en vez de un fork de VS Code o Theia.** El árbol se compila en menos de un
  segundo, la superficie de seguridad es pequeña y auditable, y los artefactos son ligeros. El
  precio es implementar a mano el cliente LSP, el bridge DAP y los paneles — que es justo el
  trabajo diferencial del producto.
- **`src/scaffold/` no importa `electron`.** Así el generador se prueba con Node puro, sin display,
  y la CLI y el asistente comparten exactamente el mismo código.
- **Cero dependencias nativas.** No hay `node-pty` ni módulos que requieran recompilación: el
  empaquetado es reproducible y no hay paso de rebuild en la máquina del usuario. El precio es que
  la terminal no tiene pseudoterminal.
- **El asistente de IA habla HTTP, sin SDK de proveedor.** Un constructor de peticiones y un parser
  de streaming por formato, los dos funciones puras: se prueban sin red y sin claves. Y el prompt
  de sistema con las reglas de arquitectura lo compone el **proceso principal**, no el renderer, así
  que no es un parámetro de la interfaz.
- **El renderer es territorio hostil.** `contextIsolation` activado, sin `nodeIntegration`, sin
  `ipcRenderer` expuesto, CSP sin `eval` ni orígenes remotos, y toda ruta que llega del renderer se
  valida contra el workspace abierto.

---

## Compilar y empaquetar

```bash
npm run build
```

| Comando | Qué hace |
|---|---|
| `npm run build` | Compila main, preload, renderer, CLI y bundles auxiliares con esbuild |
| `npm run watch` | Igual, en modo watch |
| `npm run dev` | Build + Electron con DevTools |
| `npm start` | Electron sobre el último build |
| `npm run icons` | Regenera `.ico`, `.icns` y los PNG desde el logo dibujado por código |
| `npm run pack` | Empaqueta sin instalador (carpeta desempaquetada) |
| `npm run dist:win` | **Windows:** instalador NSIS + portable ZIP → `dist/` |
| `npm run dist:mac` | **macOS:** `.dmg` + `.app` comprimido, arm64 y x64 → `dist/` |
| `npm run verify:dist` | Comprueba qué artefactos hay en `dist/`, su tamaño y su firma |
| `npm run prune:dist` | Borra de `dist/` los artefactos de versiones anteriores (`--dry-run` sólo informa) |
| `npm run clean` | Borra `build/` y `dist/` (`--all` incluye el toolchain cacheado) |

### macOS

`npm run dist:mac` **sólo funciona en macOS o Linux**: el `.dmg` necesita herramientas que sólo
existen en macOS (`hdiutil`, `codesign`). Ejecutarlo en Windows imprime una explicación y sale con
código 2 en lugar de dejar un `dist/` a medias.

La ruta oficial para obtener los artefactos de macOS es el workflow incluido
[`.github/workflows/release.yml`](.github/workflows/release.yml), que compila en un runner
`macos-latest` y publica arm64 y x64.

### Firma

No hay certificados en el repositorio. Para firmar:

- **Windows:** define `CSC_LINK` y `CSC_KEY_PASSWORD` con tu certificado `.pfx`.
- **macOS:** define `CSC_NAME` con tu Developer ID y activa `hardenedRuntime` en
  `electron-builder.yml`; para notarizar, añade `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` y `TEAM_ID`.

---

## Pruebas

```bash
npm test
```

**596 pruebas** en cuatro grupos:

| Grupo | Qué verifica |
|---|---|
| `unit` | Motor de plantillas, nombres y pluralización, invariantes de los blueprints, emisor de `.sln`, parseo de `.sln`/`.csproj`, diagnósticos de MSBuild, auto-cierre de etiquetas, reglas del árbol (anidamiento, iconos, insignias), geometría de los iconos y el módulo de IA: petición por proveedor, parseo del streaming troceado, contexto RAG, reglas de arquitectura del prompt, diferencias, y una conversación completa contra un servidor de mentira |
| `security` | Path traversal, superficie del preload, configuración de Electron, CSP, ausencia de `shell:true`, troceado de comandos de la terminal |
| `package` | Configuración de empaquetado, árbol de `build/`, validez real de `.ico` y `.icns`, arranque de Electron y tokenización de Razor dentro del renderer |
| `scaffold` | Genera 6 combinaciones de arquitectura y opciones, ejecuta **`dotnet build` de verdad** exigiendo 0 errores y 0 advertencias, ejecuta `dotnet test`, arranca la Web API generada y ejercita el CRUD por HTTP, y depura un programa real parando en un breakpoint |

Grupos sueltos: `npm run test:unit`, `npm run test:scaffold`, `npm run test:package`.

Variables para CI: `DOTFORGE_SKIP_DOTNET=1` y `DOTFORGE_SKIP_ELECTRON=1` saltan lo que requiere SDK
o display. `DOTFORGE_KEEP_OUTPUT=1` conserva las soluciones generadas para inspeccionarlas.

**Nada se mockea donde importa:** el grupo `scaffold` invoca el SDK de .NET real. Un generador de
soluciones .NET que nunca se comprueba contra el SDK no está probado.

---

## Componentes open source

| Componente | Licencia | Uso |
|---|---|---|
| [Electron](https://electronjs.org) | MIT | Shell de escritorio |
| [Monaco Editor](https://microsoft.github.io/monaco-editor/) | MIT | Editor de código |
| [Roslyn LanguageServer](https://github.com/dotnet/roslyn) | MIT | IntelliSense de C# |
| [OmniSharp-Roslyn](https://github.com/OmniSharp/omnisharp-roslyn) | MIT | Servidor de respaldo |
| [NetCoreDbg](https://github.com/Samsung/netcoredbg) | MIT | Depurador .NET |
| [esbuild](https://esbuild.github.io) | MIT | Compilación |
| [electron-builder](https://www.electron.build) | MIT | Empaquetado |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | MIT | Parseo de `.csproj` |
| [Open VSX](https://open-vsx.org) | EPL-2.0 | Registro de extensiones de referencia |

Sin componentes del VS Code Marketplace ni binarios propietarios del C# Dev Kit.

En las soluciones **generadas**: EF Core, Serilog, Scalar y xUnit, todos con licencias permisivas.
**MediatR queda deliberadamente fuera** por su cambio a licencia comercial; el despachador CQRS es
propio.

---

## Limitaciones conocidas

Se listan explícitamente porque un README que sólo cuenta lo que funciona no sirve para decidir.

- **La terminal no es un pseudoterminal.** Ejecuta comandos y muestra su salida; los programas
  interactivos (REPL, `vim`) no funcionarán. Es la consecuencia directa de no usar `node-pty`, que
  es una dependencia nativa. Los programas admitidos están en una lista blanca corta y auditable.
- **`dist:mac` requiere macOS o Linux.** Limitación de electron-builder, no de este proyecto.
- **Artefactos sin firmar.** No hay certificados; ver [Firma](#firma).
- **NetCoreDbg en macOS Intel** depende de que la release publique `netcoredbg-osx-amd64.zip`; la
  última release sólo publica arm64. El IDE lo detecta y lo dice, en vez de fallar de forma opaca.
- **Sin extensiones VSIX.** El registro apunta a Open VSX como base para una versión futura, pero
  el host de extensiones no está implementado.
- **Las plantillas usan xUnit v2 + VSTest**, no xUnit v3 + Microsoft.Testing.Platform: el SDK 10 y
  el orquestador MTP todavía no encajan bien (ver ADR-003 en `PROJECT_DEVLOG.md`).
- **`net9.0` compila pero necesita el runtime 9 para ejecutarse.** Si sólo tienes el runtime 10,
  genera con `--framework net10.0`.
- **El servidor de lenguaje se descarga la primera vez.** Son unos 65 MB y tardan lo que tarde la
  red; mientras, el editor funciona con resaltado y snippets y la barra de estado va contando. La
  versión de Roslyn está **fijada y verificada** (v2.0.0), la instalación se comprueba archivo a
  archivo en cada arranque y, si el servidor fallara igualmente, el IDE **conmuta solo a OmniSharp**
  y explica por qué. Actualizar esa versión es un cambio deliberado, no una descarga automática.
- **Los túneles usan una herramienta externa.** `devtunnel` y `ngrok` no se incluyen ni se descargan:
  si no hay ninguna instalada, el botón lo dice y da la orden de instalación.
- **El monitor de rendimiento necesita `dotnet-counters`**, que tampoco se incluye. Misma regla: se
  explica y se da el comando.

---

## Documentación del proyecto

| Archivo | Para qué sirve |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Documento maestro: comandos, layout, convenciones y trampas del entorno |
| [`AGENTS.md`](AGENTS.md) | Equipo virtual de 10 sub-agentes especializados, con rol, prompt y criterio de aceptación |
| [`PROJECT_DEVLOG.md`](PROJECT_DEVLOG.md) | Roadmap por fases, decisiones técnicas (ADR) y bitácora de errores con su causa raíz |

---

<div align="center">

**DotForge IDE** · MIT · Hecho para gente que escribe C#

</div>
