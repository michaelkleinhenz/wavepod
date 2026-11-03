// Text helpers for the in-app menu bar (see src/renderer/menuBar.ts).

/** Native menu labels use "&" for mnemonics and "&&" for a literal ampersand. */
export function menuLabel(label: string): string {
  return label.replace(/&&|&/g, (m) => (m === '&&' ? '&' : ''));
}

const KEY_NAMES: Record<string, string> = {
  cmdorctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  plus: '+',
};

/** An Electron accelerator ("CmdOrCtrl+Shift+N") as Linux and Windows show it ("Ctrl+Shift+N"). */
export function acceleratorLabel(accelerator: string | null | undefined): string | undefined {
  if (!accelerator) return undefined;
  return accelerator
    .split('+')
    .map((k) => KEY_NAMES[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k))
    .join('+');
}
