import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSettings, type Settings } from '@sakuga-software/boo-core/settings';

export * from '@sakuga-software/boo-core/settings';

export const settingsPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'boo', 'settings.json');

export async function loadSettings(path = settingsPath()): Promise<Settings> {
  try {
    return parseSettings(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return parseSettings(undefined);
  }
}

let saves: Promise<void> = Promise.resolve();

/**
 * Writes the settings after the earlier saves, in call order. Two writes to one file at the same time
 * can leave an old or a broken file. A failed save does not stop the next saves.
 */
export function saveSettings(settings: Settings, path = settingsPath()): Promise<void> {
  const save = saves.then(() => writeAtomically(path, `${JSON.stringify(settings, null, 2)}\n`));
  saves = save.catch(() => {});
  return save;
}

// A stop during a direct write leaves a broken file, and the next start reads the defaults. A rename replaces the file in one step.
async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
