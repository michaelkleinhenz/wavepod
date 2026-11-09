// Which letter a Ctrl/Cmd shortcut means. The letter printed on the key counts, not where the
// key sits: on a German (QWERTZ) keyboard Z and Y swap places, so going by e.code turned Ctrl+Z
// into Ctrl+Y (Mute Selection) and swallowed it before the menu's Undo ever saw it.

/** The shortcut letter (upper case) for a key event, or null for keys that aren't letters. */
export function shortcutLetter(e: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  // the layout's own Latin letter (QWERTY, QWERTZ, AZERTY, Dvorak…)
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase();
  // layouts without Latin letters (Cyrillic, Greek…): fall back to the key's position, as menus do
  const m = /^Key([A-Z])$/.exec(e.code);
  return m && e.key.length === 1 ? m[1] : null;
}
