import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exportDialogDir } from '../src/main/exportPaths';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wavepod-export-'));
}

describe('exportDialogDir', () => {
  it('creates and returns the project export folder', () => {
    const dir = tmp();
    const out = exportDialogDir(dir, []);
    expect(out).toBe(path.join(dir, 'export'));
    expect(fs.statSync(out).isDirectory()).toBe(true);
  });

  it('keeps an existing export folder', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'export'));
    fs.writeFileSync(path.join(dir, 'export', 'a.wav'), '');
    expect(exportDialogDir(dir, [])).toBe(path.join(dir, 'export'));
    expect(fs.existsSync(path.join(dir, 'export', 'a.wav'))).toBe(true);
  });

  it('uses the project folder when export is a file', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'export'), '');
    expect(exportDialogDir(dir, [])).toBe(dir);
  });

  it('falls back to the first existing folder when the project folder is gone', () => {
    const home = tmp();
    const out = exportDialogDir(path.join(home, 'missing'), [path.join(home, 'Music'), home]);
    expect(out).toBe(home);
    expect(fs.existsSync(path.join(home, 'missing'))).toBe(false);
  });
});
