import { describe, expect, it } from 'vitest';
import { shortcutLetter } from '../src/renderer/shortcutKey';

describe('shortcutLetter', () => {
  it('goes by the letter on the key, not its position', () => {
    // German QWERTZ: the key labelled Z sits where QWERTY has Y
    expect(shortcutLetter({ key: 'z', code: 'KeyY' })).toBe('Z');
    expect(shortcutLetter({ key: 'y', code: 'KeyZ' })).toBe('Y');
    // French AZERTY: A where QWERTY has Q
    expect(shortcutLetter({ key: 'a', code: 'KeyQ' })).toBe('A');
    expect(shortcutLetter({ key: 'V', code: 'KeyV' })).toBe('V');
  });

  it('falls back to the key position for non-Latin layouts', () => {
    expect(shortcutLetter({ key: 'я', code: 'KeyZ' })).toBe('Z');
  });

  it('ignores keys that are not letters', () => {
    expect(shortcutLetter({ key: '1', code: 'Digit1' })).toBeNull();
    expect(shortcutLetter({ key: 'Control', code: 'ControlLeft' })).toBeNull();
    expect(shortcutLetter({ key: 'Enter', code: 'Enter' })).toBeNull();
  });
});
