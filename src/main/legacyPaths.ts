// The app was called SoundPod before it became WavePod. These helpers keep existing installs
// working: settings and the Chromium profile are copied from the old app-data folder, and an
// existing ~/Documents/SoundPod folder (episodes and templates) keeps being used in place.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const LEGACY_NAME = 'SoundPod';

/**
 * Copies the old app-data folder (settings.json, VST3 scan cache, local storage) to the new one,
 * once. Does nothing when the new folder already exists or there is nothing to migrate.
 * Returns true when it copied.
 */
export function migrateUserData(appDataDir: string, newUserDataDir: string): boolean {
  const legacy = path.join(appDataDir, LEGACY_NAME);
  if (path.resolve(legacy) === path.resolve(newUserDataDir)) return false;
  if (fs.existsSync(newUserDataDir) || !fs.existsSync(legacy)) return false;
  try {
    fs.cpSync(legacy, newUserDataDir, { recursive: true });
    return true;
  } catch (e) {
    console.error('could not migrate settings from', legacy, e);
    return false;
  }
}

/**
 * The folder for episodes and templates: ~/Documents/WavePod, unless only the old
 * ~/Documents/SoundPod exists, in which case that one keeps being used so nothing moves.
 */
export function resolveProjectsRoot(documentsDir: string, name: string): string {
  const current = path.join(documentsDir, name);
  const legacy = path.join(documentsDir, LEGACY_NAME);
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  return current;
}
