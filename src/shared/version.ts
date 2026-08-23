/**
 * Versión del producto, con una única fuente de verdad: `package.json`.
 *
 * `scripts/build.mjs` la inyecta como constante en tiempo de compilación (`define` de esbuild),
 * así que ningún archivo del código fuente vuelve a escribir el número a mano. Cuando se repetía
 * en cuatro sitios —CLI, cliente LSP, generador y empaquetado— bastaba con olvidar uno para que
 * el IDE dijese una versión y el instalador otra.
 *
 * El valor de reserva sólo aparece si alguien ejecuta el código sin pasar por el build.
 */
declare const __DOTFORGE_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __DOTFORGE_VERSION__ === 'string' ? __DOTFORGE_VERSION__ : '0.0.0-dev';
