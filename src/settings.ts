import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETTINGS = [
  { key: "hideMerged", label: "Hide the merged pull requests", fallback: true },
  { key: "hideClosed", label: "Hide the closed pull requests", fallback: true },
  { key: "hideDrafts", label: "Hide the drafts", fallback: true },
  { key: "checks", label: "Show the checks", fallback: true },
  { key: "counts", label: "Show the reviewers on head and the review count", fallback: true },
  { key: "lastReview", label: "Show the last reviewer", fallback: true },
  { key: "marks", label: "Show a mark for each reviewer", fallback: true },
  { key: "details", label: "Show the details of the selected pull request", fallback: true },
  { key: "compact", label: "Compact rows: no blank line between the pull requests", fallback: false },
] as const;

export type SettingKey = (typeof SETTINGS)[number]["key"];
export type Settings = Record<SettingKey, boolean>;

export const DEFAULT_SETTINGS = Object.fromEntries(SETTINGS.map(({ key, fallback }) => [key, fallback])) as Settings;

/** Reads the settings from any JSON value. A missing or invalid value keeps its default. */
export function parseSettings(value: unknown): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  if (typeof value !== "object" || value === null) return settings;
  for (const { key } of SETTINGS) {
    const stored = (value as Record<string, unknown>)[key];
    if (typeof stored === "boolean") settings[key] = stored;
  }
  return settings;
}

export const settingsPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "boo", "settings.json");

export async function loadSettings(path = settingsPath()): Promise<Settings> {
  try {
    return parseSettings(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
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
