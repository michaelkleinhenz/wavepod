import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateUserData, resolveProjectsRoot } from '../src/main/legacyPaths';
import { tmpDir } from './helpers';

describe('migrateUserData', () => {
  it('copies the old SoundPod folder when the new one does not exist', () => {
    const appData = tmpDir();
    mkdirSync(join(appData, 'SoundPod', 'Local Storage'), { recursive: true });
    writeFileSync(join(appData, 'SoundPod', 'settings.json'), '{"lastProject":"/x"}');
    const target = join(appData, 'WavePod');
    expect(migrateUserData(appData, target)).toBe(true);
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe('{"lastProject":"/x"}');
    expect(existsSync(join(target, 'Local Storage'))).toBe(true);
    expect(existsSync(join(appData, 'SoundPod', 'settings.json'))).toBe(true);
  });

  it('leaves an existing WavePod folder alone', () => {
    const appData = tmpDir();
    mkdirSync(join(appData, 'SoundPod'));
    writeFileSync(join(appData, 'SoundPod', 'settings.json'), 'old');
    mkdirSync(join(appData, 'WavePod'));
    expect(migrateUserData(appData, join(appData, 'WavePod'))).toBe(false);
    expect(existsSync(join(appData, 'WavePod', 'settings.json'))).toBe(false);
  });

  it('does nothing on a fresh install', () => {
    const appData = tmpDir();
    expect(migrateUserData(appData, join(appData, 'WavePod'))).toBe(false);
    expect(existsSync(join(appData, 'WavePod'))).toBe(false);
  });
});

describe('resolveProjectsRoot', () => {
  it('uses Documents/WavePod by default', () => {
    const docs = tmpDir();
    expect(resolveProjectsRoot(docs, 'WavePod')).toBe(join(docs, 'WavePod'));
  });

  it('keeps using Documents/SoundPod when only that exists', () => {
    const docs = tmpDir();
    mkdirSync(join(docs, 'SoundPod'));
    expect(resolveProjectsRoot(docs, 'WavePod')).toBe(join(docs, 'SoundPod'));
  });

  it('prefers Documents/WavePod once it exists', () => {
    const docs = tmpDir();
    mkdirSync(join(docs, 'SoundPod'));
    mkdirSync(join(docs, 'WavePod'));
    expect(resolveProjectsRoot(docs, 'WavePod')).toBe(join(docs, 'WavePod'));
  });
});
