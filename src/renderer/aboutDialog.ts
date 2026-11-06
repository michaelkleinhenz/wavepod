// Help › About WavePod: app icon, version and runtime details, links to the website and licences.
import type { AboutLink, AppInfo } from '../shared/api';
import { h } from './dom';
import { api } from './store';
import iconUrl from '../../build/icon.svg';

const PLATFORM_NAMES: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

/** The lines "Copy version info" puts on the clipboard, e.g. for a bug report. */
export function versionReport(info: AppInfo): string {
  return [
    `${info.name} ${info.version}`,
    `Electron ${info.electron}`,
    `Chromium ${info.chrome}`,
    `Node.js ${info.node}`,
    `${PLATFORM_NAMES[info.platform] ?? info.platform} ${info.arch}`,
  ].join('\n');
}

export async function showAbout(): Promise<void> {
  if (document.querySelector('.overlay.about')) return;
  const info = await api().getAppInfo();
  const overlay = h('div', { class: 'overlay about' });
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());

  const link = (which: AboutLink, label: string) =>
    h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), void api().openAboutLink(which)) }, label);
  const copyBtn = h('button', {}, 'Copy version info') as HTMLButtonElement;
  copyBtn.onclick = () => {
    void navigator.clipboard.writeText(versionReport(info)).then(() => {
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy version info'), 1500);
    });
  };
  const detail = (k: string, v: string) => [h('dt', null, k), h('dd', null, v)];

  const closeBtn = h('button', { class: 'primary', onclick: close }, 'Close') as HTMLButtonElement;
  overlay.append(
    h(
      'div',
      { class: 'dialog about-dialog', role: 'dialog', 'aria-label': `About ${info.name}` },
      h(
        'div',
        { class: 'about-hero' },
        h('img', { class: 'about-icon', src: iconUrl, alt: '' }),
        h('h2', null, info.name),
        h('div', { class: 'about-version' }, `Version ${info.version}`),
        h('p', { class: 'about-tagline' }, 'A simple multitrack DAW for podcasting'),
      ),
      h(
        'dl',
        { class: 'about-details' },
        ...detail('Electron', info.electron),
        ...detail('Chromium', info.chrome),
        ...detail('Node.js', info.node),
        ...detail('System', `${PLATFORM_NAMES[info.platform] ?? info.platform} ${info.arch}`),
      ),
      h('div', { class: 'about-links' }, link('website', 'Website'), link('source', 'Source code'), link('licenses', 'Licences')),
      h('p', { class: 'about-copyright' }, '© 2026 Michael Kleinhenz · MIT License'),
      h('div', { class: 'row end' }, copyBtn, closeBtn),
    ),
  );
  document.body.append(overlay);
  closeBtn.focus();
}
