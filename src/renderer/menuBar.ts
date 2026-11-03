// In-app menu bar for Linux and Windows. The native one there follows the desktop theme
// (often light) and font size rather than the app's; this draws the same menu, styled like
// the app. The native menu stays attached but hidden, so its accelerators keep working.
import type { MenuModelItem, MenuModelTop } from '../shared/api';
import { h } from './dom';
import { api } from './store';

export class MenuBar {
  readonly el = h('div', { class: 'menubar', role: 'menubar' });
  private model: MenuModelTop[] = [];
  private tops: HTMLButtonElement[] = [];
  private dropdown: HTMLDivElement | null = null;
  /** Index of the open menu, or of the highlighted title in keyboard mode, or -1. */
  private active = -1;
  /** Highlighted entry in the open menu (keyboard navigation), or -1. */
  private hover = -1;
  private open = false;
  /** Alt went down with no other key since: releasing it focuses the bar, as native menus do. */
  private altAlone = false;

  constructor() {
    // Keep focus and text selection where they are, so Copy and Paste act on them.
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    window.addEventListener('mousedown', (e) => {
      const t = e.target as Node;
      if (this.active >= 0 && !this.el.contains(t) && !this.dropdown?.contains(t)) this.close();
    }, true);
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
    window.addEventListener('keydown', (e) => this.onKeyDown(e), true);
    window.addEventListener('keyup', (e) => this.onKeyUp(e), true);
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.model = await api().getMenu();
    this.tops = this.model.map((m, i) =>
      h(
        'button',
        {
          class: 'menubar-title',
          role: 'menuitem',
          onclick: () => (this.open && this.active === i ? this.close() : this.show(i)),
          onmouseenter: () => this.open && this.active !== i && this.show(i),
        },
        m.label,
      ),
    );
    this.el.replaceChildren(...this.tops);
    this.el.hidden = this.model.length === 0;
    if (this.open && this.active >= 0) this.show(this.active, this.hover);
    else this.highlight();
  }

  private show(i: number, hover = -1): void {
    this.dropdown?.remove();
    this.active = i;
    this.hover = hover;
    this.open = true;
    const menu = this.model[i];
    const title = this.tops[i];
    const box = title.getBoundingClientRect();
    this.dropdown = h('div', { class: 'menubar-dropdown', role: 'menu', style: { left: `${box.left}px`, top: `${box.bottom}px` } });
    this.dropdown.addEventListener('mousedown', (e) => e.preventDefault());
    menu.items.forEach((item, n) => this.dropdown!.append(this.renderItem(item, n)));
    document.body.append(this.dropdown);
    this.highlight();
  }

  private renderItem(item: MenuModelItem, n: number): HTMLElement {
    if (item.type === 'separator') return h('div', { class: 'menubar-separator', role: 'separator' });
    return h(
      'div',
      {
        class: `menubar-item${item.enabled ? '' : ' disabled'}`,
        role: item.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': item.type === 'checkbox' ? String(!!item.checked) : undefined,
        onmouseenter: () => {
          this.hover = n;
          this.highlight();
        },
        onclick: () => this.choose(item),
      },
      h('span', { class: 'menubar-check' }, item.checked ? '✓' : ''),
      h('span', { class: 'menubar-label' }, item.label),
      h('span', { class: 'menubar-accel' }, item.accelerator ?? ''),
    );
  }

  private choose(item: MenuModelItem): void {
    if (!item.enabled || item.type === 'separator') return;
    this.close();
    void api()
      .menuClick(item.id)
      .then(() => this.refresh());
  }

  private close(): void {
    this.dropdown?.remove();
    this.dropdown = null;
    this.open = false;
    this.active = -1;
    this.hover = -1;
    this.highlight();
  }

  private highlight(): void {
    this.tops.forEach((t, i) => t.classList.toggle('active', i === this.active));
    this.el.classList.toggle('keyboard', this.active >= 0 && !this.open);
    if (!this.dropdown) return;
    [...this.dropdown.children].forEach((c, n) => c.classList.toggle('hover', n === this.hover));
  }

  /** Next selectable entry in the open menu from `from`, stepping by `dir`. */
  private step(from: number, dir: 1 | -1): number {
    const items = this.model[this.active]?.items ?? [];
    for (let k = 1; k <= items.length; k++) {
      const n = (((from + dir * k) % items.length) + items.length) % items.length;
      if (items[n].type !== 'separator' && items[n].enabled) return n;
    }
    return -1;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.model.length === 0) return;
    this.altAlone = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
    if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      if (this.active >= 0) this.close();
      else this.show(0, this.step(-1, 1));
      return;
    }
    if (this.active < 0 || e.key === 'Alt') return;
    const keys = ['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Enter', ' '];
    if (!keys.includes(e.key)) {
      // Another key with only the title highlighted hands the keyboard back to the app.
      if (!this.open) return this.close();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // While the bar has the keyboard, keys don't reach the app's shortcuts.
    e.preventDefault();
    e.stopPropagation();
    const count = this.model.length;
    const down = e.key === 'ArrowDown';
    switch (e.key) {
      case 'Escape':
        return this.close();
      case 'ArrowLeft':
      case 'ArrowRight': {
        const i = (this.active + (e.key === 'ArrowLeft' ? count - 1 : 1)) % count;
        if (this.open) {
          this.show(i);
          this.hover = this.step(-1, 1);
        } else this.active = i;
        return this.highlight();
      }
      case 'ArrowDown':
      case 'ArrowUp':
        if (!this.open) return this.show(this.active, this.step(-1, 1));
        this.hover = this.step(this.hover < 0 ? (down ? -1 : 0) : this.hover, down ? 1 : -1);
        return this.highlight();
      default: {
        if (!this.open) return this.show(this.active, this.step(-1, 1));
        const item = this.model[this.active].items[this.hover];
        if (item) this.choose(item);
      }
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key !== 'Alt' || !this.altAlone) return;
    this.altAlone = false;
    if (this.model.length === 0 || document.querySelector('.overlay')) return;
    e.preventDefault();
    if (this.active >= 0) this.close();
    else {
      this.active = 0;
      this.highlight();
    }
  }
}
