import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_COMMANDS, BOTS, mentionProblem, RESERVED_KEYS } from './actions.js';
import { parseMergePolicy, type MergePolicy } from './policy.js';

export const SETTINGS = [
  { key: 'hideMerged', label: 'Hide the merged pull requests', fallback: true },
  { key: 'hideClosed', label: 'Hide the closed pull requests', fallback: true },
  { key: 'hideDrafts', label: 'Hide the drafts', fallback: true },
  { key: 'checks', label: 'Show the checks', fallback: true },
  { key: 'counts', label: 'Show the reviewers on head and the review count', fallback: true },
  { key: 'lastReview', label: 'Show the last reviewer', fallback: true },
  { key: 'marks', label: 'Show a mark for each reviewer', fallback: true },
  { key: 'agent', label: 'Show the coding agent and the local Claude Code session', fallback: true },
  { key: 'details', label: 'Show the failing checks and the quota times of an unfolded pull request', fallback: true },
  { key: 'compact', label: 'Compact rows: no blank line between the pull requests', fallback: false },
  { key: 'stacks', label: 'Show each stacked pull request under the pull request that it merges into', fallback: true },
] as const;

export type SettingKey = (typeof SETTINGS)[number]['key'];

/** The switches of one review bot. A missing switch keeps the default of the bot. */
export interface BotSwitches {
  enabled?: boolean;
  autoRetry?: boolean;
}

/** A review bot that the user adds. Its first command asks for a review. */
export interface CustomBot {
  name: string;
  key: string;
  logins: string[];
  /** The mention that starts a command in a comment, for example "@sourcery-ai". */
  mention?: string;
  /** The reviewer that `gh pr edit --add-reviewer` takes, in place of a comment. */
  reviewer?: string;
  /** With no mention and no reviewer, the bot takes "/command". */
  commands: string[];
}

export type Settings = Record<SettingKey, boolean> & {
  /** The authors of the listed pull requests: a login, "@me", or "app/<slug>" for a GitHub App. */
  authors: string[];
  /** The repositories to watch, as "owner/name" or as "name" in the organization. Undefined: every repository. */
  repos?: string[];
  /** The switches of each review bot, by the id of the bot. */
  bots: Record<string, BotSwitches>;
  customBots: CustomBot[];
  /** The prompts that replace the default prompts of the agent commands, by the label of the command. */
  agentPrompts: Record<string, string>;
  /** A red pull request with no working session and no new commit for this time is stalled. */
  stalledAfterMinutes: number;
  /** The rules that a team adds before "ready to merge". */
  mergePolicy?: MergePolicy;
};

export const DEFAULT_AUTHORS: readonly string[] = ['@me'];

export const DEFAULT_SETTINGS: Settings = {
  ...(Object.fromEntries(SETTINGS.map(({ key, fallback }) => [key, fallback])) as Record<SettingKey, boolean>),
  authors: [...DEFAULT_AUTHORS],
  bots: {},
  customBots: [],
  agentPrompts: {},
  stalledAfterMinutes: 30,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const words = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((word): word is string => typeof word === 'string')
        .map((word) => word.trim())
        .filter(Boolean)
    : [];

function parseSwitches(value: unknown): Record<string, BotSwitches> {
  if (!isRecord(value)) return {};
  const bots: Record<string, BotSwitches> = {};
  for (const [id, stored] of Object.entries(value)) {
    if (!isRecord(stored)) continue;
    const switches: BotSwitches = {};
    if (typeof stored.enabled === 'boolean') switches.enabled = stored.enabled;
    if (typeof stored.autoRetry === 'boolean') switches.autoRetry = stored.autoRetry;
    bots[id] = switches;
  }
  return bots;
}

/** Reads one custom bot. Returns undefined if a field that the bot needs is missing, or if its key has another use. */
export function parseCustomBot(value: unknown): CustomBot | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const key = typeof value.key === 'string' ? value.key : '';
  const logins = words(value.logins);
  const commands = words(value.commands);
  if (!name || !/^[a-z0-9]$/.test(key) || RESERVED_KEYS.has(key) || logins.length === 0 || commands.length === 0)
    return undefined;
  const text = (field: unknown) => (typeof field === 'string' && field.trim()) || undefined;
  const mention = text(value.mention);
  if (mention && mentionProblem(mention)) return undefined;
  const reviewer = mention ? undefined : text(value.reviewer);
  return { name, key, logins, ...(mention && { mention }), ...(reviewer && { reviewer }), commands };
}

function parsePrompts(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const labels = new Set(AGENT_COMMANDS.map((command) => command.label));
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        labels.has(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1].trim()),
    ),
  );
}

/** Reads a list of authors from any JSON value. Returns undefined if the value is not a list with one author or more. */
export function parseAuthors(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const authors = [
    ...new Set(
      value
        .filter((author): author is string => typeof author === 'string')
        .map((author) => author.trim())
        .filter(Boolean),
    ),
  ];
  return authors.length > 0 ? authors : undefined;
}

const REPO = /^(?:[\w.-]+\/)?[\w.-]+$/;

/** Reads a list of repositories from any JSON value. Returns undefined if the value is not a list with one repository or more. */
export function parseRepos(value: unknown): string[] | undefined {
  const repos = parseAuthors(value)?.filter((repo) => REPO.test(repo));
  return repos && repos.length > 0 ? repos : undefined;
}

/** Gives the full name of each repository. A name with no owner takes the organization. */
export function resolveRepos(repos: string[], org: string): string[] {
  return [
    ...new Set(
      repos.map((repo) => {
        if (repo.includes('/')) return repo;
        if (!org) throw new Error(`The repository "${repo}" needs an owner ("owner/${repo}"), because --org is "all".`);
        return `${org}/${repo}`;
      }),
    ),
  ];
}

/** Reads the settings from any JSON value. A missing or invalid value keeps its default. */
export function parseSettings(value: unknown): Settings {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    authors: [...DEFAULT_AUTHORS],
    bots: {},
    customBots: [],
    agentPrompts: {},
  };
  if (typeof value !== 'object' || value === null) return settings;
  const stalledAfter = (value as Record<string, unknown>).stalledAfterMinutes;
  if (typeof stalledAfter === 'number' && Number.isInteger(stalledAfter) && stalledAfter > 0)
    settings.stalledAfterMinutes = stalledAfter;
  for (const { key } of SETTINGS) {
    const stored = (value as Record<string, unknown>)[key];
    if (typeof stored === 'boolean') settings[key] = stored;
  }
  settings.authors = parseAuthors((value as Record<string, unknown>).authors) ?? settings.authors;
  const repos = parseRepos((value as Record<string, unknown>).repos);
  if (repos) settings.repos = repos;
  settings.bots = parseSwitches((value as Record<string, unknown>).bots);
  settings.agentPrompts = parsePrompts((value as Record<string, unknown>).agentPrompts);
  const mergePolicy = parseMergePolicy((value as Record<string, unknown>).mergePolicy);
  if (mergePolicy) settings.mergePolicy = mergePolicy;
  const custom = (value as Record<string, unknown>).customBots;
  // The id of a custom bot comes from its name, and the bar opens the first bot of a key.
  // Thus a bot with the name or the key of an earlier bot is dropped.
  const names = new Set(BOTS.map((bot) => bot.name.toLowerCase()));
  const keys = new Set(BOTS.map((bot) => bot.key));
  settings.customBots = (Array.isArray(custom) ? custom.map(parseCustomBot) : []).filter((bot): bot is CustomBot => {
    if (!bot || names.has(bot.name.toLowerCase()) || keys.has(bot.key)) return false;
    names.add(bot.name.toLowerCase());
    keys.add(bot.key);
    return true;
  });
  return settings;
}

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
