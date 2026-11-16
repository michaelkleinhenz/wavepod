// The docked sidebar on the right of Record & Edit. Filters, transcript, sound library, script,
// cameras and remote guests each have a tab in it; one shows at a time, next to the timeline
// rather than over it. Drag its left edge to make it wider or narrower (double-click: back to the
// default width), and fold it to a thin strip for the full timeline width. Width, folded state and
// the last tab are remembered on this computer.
import { h } from './dom';

export const SIDEBAR_TABS = ['fx', 'transcript', 'library', 'script', 'video', 'guests'] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];

/** A panel that lives in a sidebar tab. */
export interface SidebarPanel {
  readonly el: HTMLElement;
  /** The panel came on screen (its tab was chosen, or the sidebar unfolded or came back). */
  enterSidebar(): void;
  /** The panel went off screen. */
  leaveSidebar(): void;
}

interface TabSpec {
  id: SidebarTab;
  label: string;
  title: string;
  panel: SidebarPanel;
  button: HTMLButtonElement;
  rail: HTMLButtonElement;
}

export const SIDEBAR_DEFAULT_WIDTH = 400;
export const SIDEBAR_MIN_WIDTH = 280;
/** Room the timeline keeps, however wide the sidebar is dragged. */
export const TIMELINE_MIN_WIDTH = 360;

const WIDTH_KEY = 'wavepod.sidebarWidth';
const FOLDED_KEY = 'wavepod.sidebarFolded';
const TAB_KEY = 'wavepod.sidebarTab';

const load = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const save = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered: fine
  }
};

/** The widest the sidebar may be in a window this wide. */
export function sidebarMaxWidth(windowWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, windowWidth - TIMELINE_MIN_WIDTH);
}

/** A width kept between the minimum and what leaves the timeline room. */
export function clampSidebarWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(sidebarMaxWidth(windowWidth), Math.max(SIDEBAR_MIN_WIDTH, width)));
}

export class Sidebar {
  readonly el = h('aside', { class: 'sidebar' });
  private tabBar = h('div', { class: 'sidebar-tabs', role: 'tablist', 'aria-label': 'Sidebar' });
  private railTabs = h('div', { class: 'sidebar-rail-tabs' });
  private body = h('div', { class: 'sidebar-body' });
  private handle = h('div', { class: 'sidebar-handle', title: 'Drag to resize the sidebar (double-click: default width)', role: 'separator', 'aria-orientation': 'vertical' });
  private tabs: TabSpec[] = [];
  private active: SidebarTab;
  private folded: boolean;
  private width: number;
  /** True outside Record & Edit: the sidebar keeps its tab but is off screen. */
  private hidden = true;
  /** The panel now on screen, if any. */
  private onScreen: TabSpec | null = null;
  /** Called whenever the tab or folded state changes (the header buttons follow). */
  onChange: () => void = () => {};

  constructor() {
    const saved = load(TAB_KEY);
    this.active = SIDEBAR_TABS.find((t) => t === saved) ?? 'fx';
    this.folded = load(FOLDED_KEY) !== '0';
    this.width = clampSidebarWidth(Number(load(WIDTH_KEY) ?? SIDEBAR_DEFAULT_WIDTH), window.innerWidth);
    const foldBtn = h('button', { class: 'sidebar-fold', title: 'Fold the sidebar away: full width for the timeline (Shift+Ctrl+D)', 'aria-label': 'Fold sidebar', onclick: () => this.fold() }, '»');
    const unfoldBtn = h('button', { class: 'sidebar-fold', title: 'Show the sidebar (Shift+Ctrl+D)', 'aria-label': 'Show sidebar', onclick: () => this.unfold() }, '«');
    this.el.append(
      this.handle,
      h('div', { class: 'sidebar-rail' }, unfoldBtn, this.railTabs),
      h('div', { class: 'sidebar-main' }, h('div', { class: 'sidebar-top' }, this.tabBar, foldBtn), this.body),
    );
    this.handle.addEventListener('pointerdown', (e) => this.startResize(e));
    this.handle.addEventListener('dblclick', () => this.setWidth(SIDEBAR_DEFAULT_WIDTH));
    window.addEventListener('resize', () => this.applyWidth());
    this.applyWidth();
    this.applyFolded();
  }

  /** Adds a panel as a tab, in the order the tabs are added. */
  add(id: SidebarTab, label: string, title: string, panel: SidebarPanel): void {
    const button = h('button', { class: 'sidebar-tab', role: 'tab', title, 'data-tab': id, onclick: () => this.show(id) }, label);
    const rail = h('button', { class: 'sidebar-rail-tab', title, 'data-tab': id, onclick: () => this.show(id) }, label);
    this.tabs.push({ id, label, title, panel, button, rail });
    this.tabBar.append(button);
    this.railTabs.append(rail);
    this.update();
  }

  get tab(): SidebarTab {
    return this.active;
  }

  get isFolded(): boolean {
    return this.folded;
  }

  /** The tab is chosen and the sidebar unfolded (it may be off screen in another view). */
  isOpen(id: SidebarTab): boolean {
    return !this.folded && this.active === id;
  }

  /** The tab's panel is on screen right now. */
  isVisible(id: SidebarTab): boolean {
    return this.onScreen?.id === id;
  }

  /** Shows a tab as working (a spinner on its name), e.g. the transcript while transcribing. */
  setBusy(id: SidebarTab, busy: boolean, busyTitle: string): void {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
    for (const b of [t.button, t.rail]) {
      b.classList.toggle('busy', busy);
      b.title = busy ? busyTitle : t.title;
    }
  }

  /** Chooses a tab and unfolds the sidebar. */
  show(id: SidebarTab): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.active = id;
    this.folded = false;
    save(TAB_KEY, id);
    save(FOLDED_KEY, '0');
    this.update();
  }

  /** Shows the tab, or folds the sidebar if the tab is already showing (the panel shortcuts). */
  toggle(id: SidebarTab): void {
    if (this.isOpen(id)) this.fold();
    else this.show(id);
  }

  /** Folds the sidebar when this tab is the one showing (a panel's own close). */
  close(id: SidebarTab): void {
    if (this.isOpen(id)) this.fold();
  }

  fold(): void {
    if (this.folded) return;
    this.folded = true;
    save(FOLDED_KEY, '1');
    this.update();
  }

  unfold(): void {
    if (!this.folded) return;
    this.folded = false;
    save(FOLDED_KEY, '0');
    this.update();
  }

  toggleFolded(): void {
    if (this.folded) this.unfold();
    else this.fold();
  }

  /** Off screen outside Record & Edit; back as it was on return. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.update();
  }

  get currentWidth(): number {
    return this.width;
  }

  setWidth(width: number): void {
    this.width = clampSidebarWidth(width, window.innerWidth);
    save(WIDTH_KEY, String(this.width));
    this.applyWidth();
  }

  private applyWidth(): void {
    // a smaller window narrows the sidebar for now, without forgetting the chosen width
    const w = clampSidebarWidth(this.width, window.innerWidth);
    this.el.style.setProperty('--sidebar-width', `${w}px`);
  }

  private applyFolded(): void {
    this.el.classList.toggle('folded', this.folded);
    document.body.classList.toggle('sidebar-folded', this.folded);
  }

  /** Puts the right panel on screen and tells the panels what changed. */
  private update(): void {
    this.applyFolded();
    for (const t of this.tabs) {
      const on = t.id === this.active;
      t.button.classList.toggle('active', on);
      t.button.setAttribute('aria-selected', String(on));
      t.rail.classList.toggle('active', on);
    }
    const want = this.hidden || this.folded ? null : this.tabs.find((t) => t.id === this.active) ?? null;
    if (want !== this.onScreen) {
      const was = this.onScreen;
      this.onScreen = want;
      if (was) {
        was.panel.el.remove();
        document.body.classList.remove(`${was.id}-open`);
        was.panel.leaveSidebar();
      }
      if (want) {
        this.body.replaceChildren(want.panel.el);
        document.body.classList.add(`${want.id}-open`);
        want.panel.enterSidebar();
      }
    }
    this.onChange();
  }

  private startResize(e: PointerEvent): void {
    if (e.button !== 0 || this.folded) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = clampSidebarWidth(this.width, window.innerWidth);
    this.handle.setPointerCapture(e.pointerId);
    document.body.classList.add('sidebar-resizing');
    const move = (ev: PointerEvent) => {
      this.width = clampSidebarWidth(startW + (startX - ev.clientX), window.innerWidth);
      this.applyWidth();
    };
    const up = () => {
      this.handle.removeEventListener('pointermove', move);
      this.handle.removeEventListener('pointerup', up);
      this.handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('sidebar-resizing');
      save(WIDTH_KEY, String(this.width));
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
    this.handle.addEventListener('pointercancel', up);
  }
}

let instance: Sidebar | null = null;

/** The app's one sidebar (made on first use, so tests can import the width helpers). */
export function sidebar(): Sidebar {
  return (instance ??= new Sidebar());
}
