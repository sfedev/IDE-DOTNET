/**
 * Diálogo de publicación.
 *
 * Un modal propio, como el de confirmación y por el mismo motivo: `window.confirm` y compañía
 * bloquean el renderer entero, y aquí además hace falta un formulario.
 *
 * La decisión de diseño que gobierna todo el cuadro: **una casilla que no se puede marcar tiene
 * que decir por qué**. `PublishSingleFile` y `PublishReadyToRun` no hacen nada sin un identificador
 * de runtime, así que en el modo portable aparecen atenuadas con el motivo escrito al lado, en vez
 * de dejarse marcar y no surtir efecto. Es la misma regla que con el asistente de IA apagado y con
 * Docker sin arrancar (ADR-023 y ADR-033): atenuar y explicar, no esconder.
 *
 * Lo que se ve se recalcula del estado en cada repintado, nunca del DOM: las opciones llegan de
 * `publish-profiles.json` —escrito por otra versión del IDE— y cambiar de modo apaga banderas.
 */
import type {
  PublishConfiguration,
  PublishMode,
  PublishOptions,
} from '../../shared/dotnet-publish.js';
import {
  coercePublishOptions,
  describePublish,
  disabledReason,
  isValidRuntimeIdentifier,
  PUBLISH_CONFIGURATIONS,
  PUBLISH_MODE_INFO,
  PUBLISH_RUNTIMES,
  publishModeInfo,
  publishOutputPath,
  supportsReadyToRun,
  supportsSingleFile,
  supportsTrimming,
} from '../../shared/dotnet-publish.js';
import { append, byId, clear, dirName, el } from '../dom.js';
import { icon } from '../icons.js';

export interface PublishDialogInput {
  projectName: string;
  projectPath: string;
  /** Marcos que declara el `.csproj`. Con más de uno, publicar exige elegir. */
  frameworks: readonly string[];
  /** Opciones con las que se publicó la última vez, ya saneadas por el proceso principal. */
  initial: PublishOptions;
}

/**
 * Abre el diálogo y resuelve con las opciones, o con `null` si se cancela.
 *
 * **Nunca rechaza**, como `askDialog`: Escape, el clic fuera y el botón de cancelar son la misma
 * respuesta, y una excepción aquí dejaría al llamante sin saber si tiene que restaurar nada.
 */
export function askPublishOptions(input: PublishDialogInput): Promise<PublishOptions | null> {
  const overlay = byId('overlay');
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  return new Promise<PublishOptions | null>((resolve) => {
    let answered = false;
    let options = coercePublishOptions(input.initial);

    const finish = (answer: PublishOptions | null): void => {
      if (answered) return;
      answered = true;

      overlay.hidden = true;
      overlay.className = 'overlay';
      overlay.onkeydown = null;
      overlay.onmousedown = null;
      clear(overlay);

      previous?.focus();
      resolve(answer);
    };

    const body = el('div', { className: 'dialog-body publish-body' });

    /**
     * Cambia una opción y repinta.
     *
     * Todo pasa por `coercePublishOptions`, también lo que produce esta misma interfaz: pasar de
     * autocontenido a portable tiene que **apagar** el archivo único, y hacerlo aquí es lo que
     * garantiza que lo que se ve y lo que se va a ejecutar son lo mismo.
     */
    const update = (patch: Partial<PublishOptions>): void => {
      options = coercePublishOptions({ ...options, ...patch });
      paint();
    };

    function segmented<T extends string>(
      label: string,
      entries: Array<[value: T, text: string]>,
      current: T,
      onChange: (value: T) => void,
    ): HTMLElement {
      return el(
        'div',
        { className: 'publish-row' },
        el('span', { className: 'publish-label', text: label }),
        el(
          'div',
          { className: 'segmented' },
          ...entries.map(([value, text]) =>
            el(
              'button',
              { className: value === current ? 'active' : '', on: { click: () => onChange(value) } },
              text,
            ),
          ),
        ),
      );
    }

    function select(
      label: string,
      entries: Array<[value: string, text: string]>,
      current: string,
      onChange: (value: string) => void,
    ): HTMLElement {
      const box = el('select', { className: 'settings-select' }) as HTMLSelectElement;

      for (const [value, text] of entries) {
        const option = el('option', { value, text });
        if (value === current) option.selected = true;
        box.appendChild(option);
      }

      box.addEventListener('change', () => onChange(box.value));

      return el(
        'div',
        { className: 'publish-row' },
        el('span', { className: 'publish-label', text: label }),
        box,
      );
    }

    /**
     * Casilla que puede estar atenuada, con el motivo al lado.
     *
     * `el()` no tiene opción `checked`: hay que ponerlo a mano sobre el nodo, o la casilla se
     * desmarca sola en cada repintado aunque la preferencia siga activa. Es el mismo fallo que tuvo
     * el "pre" del panel de NuGet.
     */
    function checkbox(
      label: string,
      hint: string,
      value: boolean,
      enabled: boolean,
      onChange: (value: boolean) => void,
    ): HTMLElement {
      const box = el('input', { type: 'checkbox', disabled: !enabled }) as HTMLInputElement;
      box.checked = value && enabled;
      box.addEventListener('change', () => onChange(box.checked));

      return el(
        'label',
        { className: `publish-check${enabled ? '' : ' disabled'}` },
        box,
        el(
          'span',
          {},
          el('span', { className: 'publish-check-label', text: label }),
          el('span', { className: 'publish-check-hint', text: hint }),
        ),
      );
    }

    function paint(): void {
      clear(body);

      const blocked = disabledReason(options);
      const mode = publishModeInfo(options.mode);
      const resolved = publishOutputPath(dirName(input.projectPath), options);

      // `append` es el ayudante del IDE, no el del DOM: éste sí admite `null` entre los hijos, que
      // es lo que permite escribir el aviso condicional en línea.
      append(body, [
        segmented<PublishConfiguration>(
          'Configuración',
          PUBLISH_CONFIGURATIONS.map((value): [PublishConfiguration, string] => [value, value]),
          options.configuration,
          (value) => update({ configuration: value }),
        ),

        // Con un solo marco declarado no se ofrece elegir: sería una lista de un elemento.
        input.frameworks.length > 1
          ? select(
              'Marco de destino',
              input.frameworks.map((value): [string, string] => [value, value]),
              options.framework,
              (value) => update({ framework: value }),
            )
          : el(
              'div',
              { className: 'publish-row' },
              el('span', { className: 'publish-label', text: 'Marco de destino' }),
              el('span', {
                className: 'publish-static',
                text: options.framework === '' ? 'el que declare el proyecto' : options.framework,
              }),
            ),

        select(
          'Despliegue',
          PUBLISH_MODE_INFO.map((entry): [string, string] => [entry.id, entry.label]),
          options.mode,
          (value) => update({ mode: value as PublishMode }),
        ),
        el('p', { className: 'publish-hint', text: mode.hint }),

        // El desplegable de destinos sólo aparece cuando el modo lo pide: ofrecerlo siempre y luego
        // ignorarlo es lo que hace que nadie sepa si su RID se está aplicando.
        ...(mode.needsRuntime
          ? [
              select(
                'Destino',
                [
                  ['', 'Elige un destino…'],
                  ...PUBLISH_RUNTIMES.map((entry): [string, string] => [entry.id, `${entry.label} · ${entry.id}`]),
                ],
                options.runtime,
                (value) => update({ runtime: value }),
              ),
            ]
          : []),

        outputRow(),

        el(
          'div',
          { className: 'publish-flags' },
          checkbox(
            'Archivo único',
            'Empaqueta la aplicación en un solo ejecutable.',
            options.singleFile,
            supportsSingleFile(options),
            (value) => update({ singleFile: value }),
          ),
          checkbox(
            'ReadyToRun',
            'Precompila a código nativo: arranca antes y ocupa más.',
            options.readyToRun,
            supportsReadyToRun(options),
            (value) => update({ readyToRun: value }),
          ),
          checkbox(
            'Recortar',
            'Quita del runtime lo que la aplicación no usa. Puede romper la reflexión.',
            options.trimmed,
            supportsTrimming(options),
            (value) => update({ trimmed: value }),
          ),
        ),

        blocked === null
          ? null
          : el(
              'p',
              { className: 'publish-note' },
              icon('info', { size: 14 }),
              el('span', { text: blocked }),
            ),

        el(
          'div',
          { className: 'publish-summary' },
          el('span', { className: 'publish-summary-line', text: describePublish(options) }),
          el('span', {
            className: 'publish-summary-path',
            title: resolved ?? '',
            text: resolved === null ? 'La carpeta la elige el SDK.' : `Irá a ${resolved}`,
          }),
        ),
      ]);

      confirm.disabled = mode.needsRuntime && options.runtime === '';
    }

    /**
     * Carpeta de salida.
     *
     * El campo se pinta **siempre desde el estado**, y sólo el saneado decide qué se guarda: si se
     * repintara desde el DOM, escribir una barra al final la vería desaparecer a mitad de palabra.
     * Por eso se aplica al perder el foco o con Enter, como el resto de campos de texto del IDE.
     */
    function outputRow(): HTMLElement {
      const box = el('input', {
        className: 'settings-input',
        type: 'text',
        value: options.outputDir,
        placeholder: 'bin/Release/… (lo elige el SDK)',
        attrs: { spellcheck: 'false' },
      }) as HTMLInputElement;

      box.addEventListener('change', () => update({ outputDir: box.value }));
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') box.blur();
      });

      return el(
        'div',
        { className: 'publish-row' },
        el('span', { className: 'publish-label', text: 'Carpeta de salida' }),
        box,
      );
    }

    const confirm = el('button', {
      className: 'btn primary',
      text: 'Publicar',
      on: {
        click: () => {
          // Última comprobación antes de salir: un RID escrito a mano puede no serlo.
          if (publishModeInfo(options.mode).needsRuntime && !isValidRuntimeIdentifier(options.runtime)) return;
          finish(options);
        },
      },
    }) as HTMLButtonElement;

    const cancel = el('button', {
      className: 'btn ghost',
      text: 'Cancelar',
      on: { click: () => finish(null) },
    });

    clear(overlay);
    overlay.hidden = false;
    overlay.className = 'overlay center';

    const dialog = el(
      'div',
      { className: 'dialog publish-dialog', role: 'dialog', attrs: { 'aria-modal': 'true' } },
      el(
        'div',
        { className: 'dialog-header' },
        el('span', { className: 'dialog-mark' }, icon('package', { size: 20 })),
        el(
          'div',
          { className: 'publish-head-text' },
          el('h2', { text: `Publicar ${input.projectName}` }),
          el('p', { className: 'publish-project-path', title: input.projectPath, text: input.projectPath }),
        ),
      ),
      body,
      el('div', { className: 'dialog-footer' }, el('span', { className: 'spacer' }), cancel, confirm),
    );

    overlay.onkeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(null);
    };

    // Pulsar fuera del cuadro es cancelar, nunca publicar: lo que se pierde con un clic despistado
    // tiene que ser nada.
    overlay.onmousedown = (event: MouseEvent) => {
      if (event.target === overlay) finish(null);
    };

    overlay.appendChild(dialog);
    paint();
    confirm.focus();
  });
}
