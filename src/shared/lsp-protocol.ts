/**
 * Qué contesta el cliente cuando el **servidor** le hace una petición.
 *
 * En LSP el tráfico va en los dos sentidos, y esto es fácil de olvidar porque el 99 % de los
 * mensajes salen del editor. Una petición del servidor que no se contesta lo deja bloqueado para
 * siempre, así que DotForge contestaba a todas con `null` y a otra cosa.
 *
 * Ese `null` universal es lo que mataba a Roslyn, y de la forma más silenciosa posible: al abrir la
 * solución, el servidor pide `workspace/configuration` con **treinta y tantas** secciones de
 * opciones (`csharp|completion.dotnet_show_name_completion_suggestions` y compañía). Su handler
 * hace `Contract.ThrowIfNull` sobre la respuesta, y con `null` levanta
 * `InvalidOperationException: Unexpected null`, que su cola de mensajes traduce en
 * "Error processing queue, shutting down". El servidor se apaga **limpiamente, con código 0**,
 * sin escribir una línea en stderr, justo después de haber dicho que estaba listo.
 *
 * La respuesta correcta es un array con **una entrada por elemento pedido**. Los valores pueden ser
 * `null`: eso significa "no tengo configurado eso, usa tu valor por defecto", que es exactamente la
 * verdad —DotForge no expone esas opciones— y es lo que hace que la solución cargue, los cinco
 * proyectos entren y `textDocument/semanticTokens/full` empiece a devolver datos.
 */

/** Resultado a devolver, ya listo para meter en el campo `result` de la respuesta JSON-RPC. */
export function serverRequestResponse(method: string, params: unknown): unknown {
  if (method === 'workspace/configuration') {
    return configurationResponse(params);
  }

  /**
   * El resto se sigue contestando con `null`, que para ellas es correcto:
   * `client/registerCapability`, `client/unregisterCapability` y
   * `window/workDoneProgress/create` devuelven `null` en caso de éxito, y las propias de Roslyn
   * (`workspace/_roslyn_projectNeedsRestore`) lo aceptan.
   */
  return null;
}

/**
 * Una entrada por elemento pedido, todas `null`.
 *
 * El tamaño es lo que importa: el servidor recorre su lista de secciones y la respuesta en
 * paralelo, y una respuesta más corta le deja opciones sin emparejar.
 */
export function configurationResponse(params: unknown): null[] {
  const items = readItems(params);
  return new Array<null>(items).fill(null);
}

function readItems(params: unknown): number {
  if (typeof params !== 'object' || params === null) return 0;
  const items = (params as Record<string, unknown>)['items'];
  return Array.isArray(items) ? items.length : 0;
}
