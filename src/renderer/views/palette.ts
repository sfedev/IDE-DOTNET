/**
 * Paleta de comandos.
 *
 * Todo lo que hace el IDE está aquí, buscable por teclado. Es también la documentación viva de
 * los atajos: el que no recuerde `Ctrl+Shift+B` lo encuentra escribiendo "compilar".
 */
import { byId, clear, el, fuzzyMatch } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export interface Command {
  id: string;
  title: string;
  group: string;
  keybinding?: string;
  /** Icono opcional: ayuda a reconocer los comandos frecuentes de un vistazo. */
  icon?: IconName;
  run(): void | Promise<void>;
}

/** Convierte "Ctrl+Shift+B" en chips independientes, como los muestran los IDE modernos. */
function renderKeybinding(keybinding: string): HTMLElement {
  const chips = el('span', { className: 'kbd' });
  for (const key of keybinding.split('+')) {
    chips.appendChild(el('span', { text: key }));
  }
  return chips;
}

export class CommandPalette {
  private commands: Command[] = [];
  private filtered: Command[] = [];
  private activeIndex = 0;
  private open = false;

  register(commands: Command[]): void {
    this.commands = commands;
  }

  getCommands(): Command[] {
    return this.commands;
  }

  isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.filtered = this.commands;
    this.activeIndex = 0;

    const overlay = byId('overlay');
    overlay.hidden = false;
    overlay.className = 'overlay top';
    clear(overlay);

    const input = el('input', {
      placeholder: 'Escribe un comando…',
      attrs: { 'aria-label': 'Buscar comando' },
    }) as HTMLInputElement;

    const search = el('div', { className: 'palette-search' }, icon('search', { size: 17 }), input);
    const list = el('div', { className: 'palette-list' });
    const palette = el('div', { className: 'palette', role: 'dialog' }, search, list);

    const renderList = (): void => {
      clear(list);

      if (this.filtered.length === 0) {
        list.appendChild(el('div', { className: 'empty-state', text: 'Ningún comando coincide.' }));
        return;
      }

      this.filtered.forEach((command, index) => {
        list.appendChild(
          el(
            'button',
            {
              className: `palette-item${index === this.activeIndex ? ' active' : ''}`,
              on: {
                click: () => {
                  this.hide();
                  void command.run();
                },
                mousemove: () => {
                  if (this.activeIndex !== index) {
                    this.activeIndex = index;
                    renderList();
                  }
                },
              },
            },
            icon(command.icon ?? 'chevron-right', { size: 15 }),
            el('span', { className: 'title', text: command.title }),
            el('span', { className: 'group', text: command.group }),
            command.keybinding ? renderKeybinding(command.keybinding) : null,
          ),
        );
      });

      list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('input', () => {
      const query = input.value.trim();
      this.filtered = query === ''
        ? this.commands
        : this.commands.filter(
            (command) => fuzzyMatch(query, command.title) || fuzzyMatch(query, command.group),
          );
      this.activeIndex = 0;
      renderList();
    });

    input.addEventListener('keydown', (event) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          this.activeIndex = Math.min(this.activeIndex + 1, this.filtered.length - 1);
          renderList();
          break;
        case 'ArrowUp':
          event.preventDefault();
          this.activeIndex = Math.max(this.activeIndex - 1, 0);
          renderList();
          break;
        case 'Enter': {
          event.preventDefault();
          const command = this.filtered[this.activeIndex];
          if (command) {
            this.hide();
            void command.run();
          }
          break;
        }
        case 'Escape':
          event.preventDefault();
          this.hide();
          break;
      }
    });

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) this.hide();
    });

    overlay.appendChild(palette);
    renderList();
    input.focus();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;

    const overlay = byId('overlay');
    overlay.hidden = true;
    overlay.className = 'overlay';
    clear(overlay);
  }
}
