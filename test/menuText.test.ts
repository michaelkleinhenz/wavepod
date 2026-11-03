import { describe, expect, it } from 'vitest';
import { acceleratorLabel, menuLabel } from '../src/core/menuText';

describe('menu text', () => {
  it('drops mnemonic markers and keeps literal ampersands', () => {
    expect(menuLabel('Record && Edit')).toBe('Record & Edit');
    expect(menuLabel('&File')).toBe('File');
    expect(menuLabel('Export…')).toBe('Export…');
  });

  it('shows accelerators the Linux/Windows way', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+N')).toBe('Ctrl+Shift+N');
    expect(acceleratorLabel('CommandOrControl+q')).toBe('Ctrl+Q');
    expect(acceleratorLabel('Alt+Shift+N')).toBe('Alt+Shift+N');
    expect(acceleratorLabel('F11')).toBe('F11');
    expect(acceleratorLabel(undefined)).toBeUndefined();
    expect(acceleratorLabel(null)).toBeUndefined();
  });
});
