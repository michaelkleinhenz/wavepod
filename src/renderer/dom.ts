// Tiny DOM helpers.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Runs a re-render that rebuilds `root`'s contents, keeping every scrolled area where it was. Without
 * this, emptying and rebuilding a view (or replacing its scrolling list) jumps it back to the top.
 * Scrolled elements are matched by tag and class, in document order.
 */
export function keepScroll(root: HTMLElement, rebuild: () => void): void {
  const keyOf = (el: Element) => `${el.tagName}.${el.getAttribute('class') ?? ''}`;
  const index = (els: Element[]) => {
    const seen = new Map<string, number>();
    return els.map((el) => {
      const k = keyOf(el);
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return `${k}#${n}`;
    });
  };
  const before = [root, ...root.querySelectorAll('*')];
  const keys = index(before);
  const saved = new Map<string, [number, number]>();
  before.forEach((el, i) => {
    if (el.scrollTop || el.scrollLeft) saved.set(keys[i], [el.scrollTop, el.scrollLeft]);
  });
  rebuild();
  if (!saved.size) return;
  const after = [root, ...root.querySelectorAll('*')];
  index(after).forEach((k, i) => {
    const pos = saved.get(k);
    if (!pos) return;
    after[i].scrollTop = pos[0];
    after[i].scrollLeft = pos[1];
  });
}

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  // The main process mirrors renderer console errors to the terminal.
  if (kind === 'error') console.error(`[toast] ${message}`);
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 6000 : 2500);
}

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Strip Electron's IPC prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// Which disclosures are open, kept across re-renders (views rebuild their DOM on every change).
const openDisclosures = new Set<string>();

/**
 * A collapsible "Advanced" section for technical settings. `key` identifies it across re-renders so it
 * stays open or closed as the user left it; `forceOpen` opens it regardless (e.g. when it holds the fix
 * for a visible problem).
 */
export function disclosure(key: string, summary: string, children: Child[], forceOpen = false): HTMLDetailsElement {
  const el = h('details', { class: 'disclosure', open: forceOpen || openDisclosures.has(key) });
  // Recorded on the user's click (not on 'toggle', which also fires for the initial or forced state).
  const head = h('summary', {
    onclick: () => {
      if (el.open) openDisclosures.delete(key);
      else openDisclosures.add(key);
    },
  }, summary);
  el.append(head);
  append(el, children);
  return el;
}
