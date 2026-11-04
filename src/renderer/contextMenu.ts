// Right-click menus, drawn like the in-app menu bar's dropdowns (same classes and colours).
import { h } from './dom';

export type ContextMenuEntry =
  | { kind?: 'item'; label: string; accel?: string; enabled?: boolean; checked?: boolean; title?: string; run: () => void }
  | { kind: 'separator' }
  | { kind: 'header'; label: string }
  /** Any element (e.g. a row of colour swatches); clicks inside it are its own business. */
  | { kind: 'custom'; el: HTMLElement };

let current: ContextMenu | null = null;

export function closeContextMenu(): void {
  current?.close();
}

export function contextMenuOpen(): boolean {
  return !!current;
}

/** Opens a menu at the page position (kept on screen). Opening another closes this one. */
export function showContextMenu(entries: ContextMenuEntry[], pageX: number, pageY: number): void {
  current?.close();
  current = new ContextMenu(entries, pageX, pageY);
}

class ContextMenu {
  readonly el = h('div', { class: 'menubar-dropdown context-menu', role: 'menu' });
  private rows: Array<{ el: HTMLElement; entry: Extract<ContextMenuEntry, { run: () => void }> }> = [];
  private hover = -1;
  private readonly onDown = (e: MouseEvent) => {
    if (!this.el.contains(e.target as Node)) this.close();
  };
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly onAway = () => this.close();

  constructor(entries: ContextMenuEntry[], x: number, y: number) {
    for (const entry of entries) {
      if (entry.kind === 'separator') this.el.append(h('div', { class: 'menubar-separator', role: 'separator' }));
      else if (entry.kind === 'header') this.el.append(h('div', { class: 'context-menu-header' }, entry.label));
      else if (entry.kind === 'custom') this.el.append(entry.el);
      else {
        const n = this.rows.length;
        const enabled = entry.enabled !== false;
        const el = h(
          'div',
          {
            class: `menubar-item${enabled ? '' : ' disabled'}`,
            role: entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
            'aria-checked': entry.checked === undefined ? undefined : String(entry.checked),
            'aria-disabled': enabled ? undefined : 'true',
            title: entry.title,
            onmouseenter: () => this.highlight(n),
            onclick: () => this.choose(n),
          },
          h('span', { class: 'menubar-check' }, entry.checked ? '✓' : ''),
          h('span', { class: 'menubar-label' }, entry.label),
          h('span', { class: 'menubar-accel' }, entry.accel ?? ''),
        );
        this.rows.push({ el, entry });
        this.el.append(el);
      }
    }
    // keep the timeline's selection and focus as they are while the menu is used
    this.el.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(this.el);
    const box = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`;
    this.el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`;
    window.addEventListener('mousedown', this.onDown, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('blur', this.onAway);
    window.addEventListener('resize', this.onAway);
    window.addEventListener('wheel', this.onAway, { capture: true, passive: true });
  }

  close(): void {
    this.el.remove();
    window.removeEventListener('mousedown', this.onDown, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('blur', this.onAway);
    window.removeEventListener('resize', this.onAway);
    window.removeEventListener('wheel', this.onAway, { capture: true });
    if (current === this) current = null;
  }

  private highlight(n: number): void {
    this.hover = n;
    this.rows.forEach((r, i) => r.el.classList.toggle('hover', i === n));
  }

  private choose(n: number): void {
    const row = this.rows[n];
    if (!row || row.entry.enabled === false) return;
    this.close();
    row.entry.run();
  }

  private step(dir: 1 | -1): void {
    const len = this.rows.length;
    for (let k = 1; k <= len; k++) {
      const n = (((this.hover < 0 && dir < 0 ? 0 : this.hover) + dir * k) % len + len) % len;
      if (this.rows[n].entry.enabled !== false) return this.highlight(n);
    }
  }

  private key(e: KeyboardEvent): void {
    // typing in a field of a custom row stays with the field
    if ((e.target as HTMLElement | null)?.closest?.('.context-menu input, .context-menu textarea')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowDown') this.step(1);
    else if (e.key === 'ArrowUp') this.step(-1);
    else if (e.key === 'Enter' || e.key === ' ') this.choose(this.hover);
  }
}
