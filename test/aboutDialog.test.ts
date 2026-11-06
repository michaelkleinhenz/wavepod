import { describe, expect, it } from 'vitest';
import { versionReport } from '../src/renderer/aboutDialog';

describe('About dialog', () => {
  it('copies the version and runtime details as plain lines', () => {
    const text = versionReport({ name: 'WavePod', version: '0.1.0', electron: '45.2.1', chrome: '142.0.1', node: '22.20.0', platform: 'linux', arch: 'x64' });
    expect(text.split('\n')).toEqual(['WavePod 0.1.0', 'Electron 45.2.1', 'Chromium 142.0.1', 'Node.js 22.20.0', 'Linux x64']);
  });
});
