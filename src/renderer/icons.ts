// Toolbar icons and their tooltips. Icons are 24×24 stroke drawings that take the button's text colour.
import { h } from './dom';

const PATHS = {
  addTrack: '<path d="M3 6h12M3 12h12M3 18h8M18 15v6M15 18h6"/>',
  import: '<path d="M12 3v12M8 11l4 4 4-4M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/>',
  split: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  rippleCut: '<path d="M2 12h6M22 12h-6M12 2v2M12 8v2M12 14v2M12 20v2M19 9l-3 3 3 3M5 15l3-3-3-3"/>',
  muteRange: '<path d="M11 5 6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6"/>',
  fade: '<path d="M2 20h20M3 18 9 6h6l6 12"/>',
  normalise: '<path d="M3 12h18M8 3v6M5.5 6.5 8 9l2.5-2.5M16 21v-6M13.5 17.5 16 15l2.5 2.5"/>',
  loudness: '<path d="M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0"/>',
  snap: '<path d="M6 15l-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15M5 8l4 4M12 15l4 4"/>',
  chapter: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  editMark: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5zM15 5l4 4"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  zoomIn: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  prepareEdit: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M5.6 5.6l12.8 12.8"/>',
  repeat: '<path d="M17 2l4 4-4 4M3 11V10a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3"/>',
  fit: '<path d="M3 5v14M21 5v14M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3"/>',
  align: '<path d="M4 7h10M8 17h12M12 3v18"/><path d="M17 4l3 3-3 3M7 14l-3 3 3 3"/>',
  region: '<path d="M3 7v10M21 7v10M3 12h18"/><rect x="7" y="9" width="10" height="6" rx="1"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  // transport: solid shapes, drawn to the same optical size as the stroke icons
  toStart: '<path d="M6 5v14" /><path d="M18 6.5v11a1 1 0 0 1-1.55.83l-8.2-5.5a1 1 0 0 1 0-1.66l8.2-5.5A1 1 0 0 1 18 6.5z" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
  play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="3.5" height="14" rx="1" fill="currentColor"/>',
  record: '<circle cx="12" cy="12" r="6.5" fill="currentColor"/>',
  zoomSel: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><rect x="8" y="9" width="8" height="6" rx="1"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}

/** Swaps the icon inside an icon button (e.g. play ↔ pause) without touching its tooltip. */
export function setIcon(btn: HTMLElement, name: IconName): void {
  if (btn.dataset.icon === name) return;
  btn.dataset.icon = name;
  btn.querySelector('svg.icon')?.replaceWith(icon(name));
}

export interface Tip {
  label: string;
  shortcut?: string;
  detail?: string;
}

const tips = new WeakMap<Element, Tip>();
let tipEl: HTMLElement | null = null;
let tipFor: Element | null = null;

/** Sets the tooltip and the accessible name of an icon button. */
export function setTip(el: HTMLElement, tip: Tip): void {
  tips.set(el, tip);
  el.setAttribute('aria-label', tip.label);
  const description = [tip.shortcut && `Shortcut: ${tip.shortcut}.`, tip.detail].filter(Boolean).join(' ');
  if (description) el.setAttribute('aria-description', description);
  else el.removeAttribute('aria-description');
  if (tipFor === el) showTip(el);
}

/** An icon-only button with a tooltip showing its label and keyboard shortcut. */
export function iconButton(name: IconName, tip: Tip, onclick: (() => void) | null, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `small icon-btn ${cls}`.trim(), type: 'button', onclick: onclick ?? undefined }, icon(name));
  setTip(b, tip);
  b.addEventListener('mouseenter', () => showTip(b));
  b.addEventListener('focus', () => {
    if (b.matches(':focus-visible')) showTip(b);
  });
  b.addEventListener('mouseleave', hideTip);
  b.addEventListener('blur', hideTip);
  b.addEventListener('mousedown', hideTip);
  return b;
}

function showTip(el: Element): void {
  const tip = tips.get(el);
  if (!tip) return;
  if (!tipEl) {
    tipEl = h('div', { class: 'tooltip', role: 'tooltip' });
    document.body.append(tipEl);
  }
  tipFor = el;
  tipEl.replaceChildren(
    h('div', { class: 'tooltip-head' }, h('span', { class: 'tooltip-label' }, tip.label), tip.shortcut ? h('kbd', null, tip.shortcut) : null),
    ...(tip.detail ? [h('div', { class: 'tooltip-detail' }, tip.detail)] : []),
  );
  tipEl.classList.add('show');
  const r = el.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${r.bottom + 6}px`;
}

function hideTip(): void {
  tipFor = null;
  tipEl?.classList.remove('show');
}
