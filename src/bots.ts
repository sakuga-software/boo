import {
  BOTS,
  CODERABBIT,
  isReviewerOf,
  RESERVED_KEYS,
  startsCodingAgent,
  type Bot,
  type BotCommand,
} from './actions.js';
import type { Reviewer } from './reviewers.js';
import type { CustomBot, Settings } from './settings.js';

// The same rule as CodeRabbit: a refusal with no readable delay waits 1 hour.
const GUESSED_QUOTA_MS = 60 * 60_000;
const KEY_CANDIDATES = [...'abcdefghijklmnopqrstuvwxyz0123456789'];

export const customId = (name: string) => `custom:${name.trim().toLowerCase()}`;

/** Gives each command the first letter of its name that is free, else the first free letter. */
export function assignKeys(commands: readonly string[]): BotCommand[] {
  const used = new Set<string>();
  return commands.map((command) => {
    const key = [...command.toLowerCase(), ...KEY_CANDIDATES].find(
      (candidate) => /^[a-z0-9]$/.test(candidate) && !used.has(candidate) && !RESERVED_KEYS.has(candidate),
    )!;
    used.add(key);
    return { key, command };
  });
}

export function toBot(custom: CustomBot): Bot {
  return {
    id: customId(custom.name),
    name: custom.name,
    key: custom.key,
    logins: custom.logins,
    ...(custom.mention && { mention: custom.mention }),
    ...(custom.reviewer && { reviewer: custom.reviewer }),
    // A review request has no command text, so its menu has one entry.
    commands: assignKeys(custom.reviewer ? ['review'] : custom.commands),
    custom: true,
  };
}

export const isEnabled = (settings: Settings, bot: Bot) => settings.bots[bot.id]?.enabled ?? true;

/** By default, only CodeRabbit gets retries: its quota clock is the only one that the tool reads well. */
export const retriesOn = (settings: Settings, bot: Bot) => settings.bots[bot.id]?.autoRetry ?? bot.id === CODERABBIT.id;

/** All the bots, on or off: the known bots, then the bots of the user. */
export const allBots = (settings: Settings): Bot[] => [...BOTS, ...settings.customBots.map(toBot)];

/** The bots that the action bar shows. */
export const activeBots = (settings: Settings): Bot[] => allBots(settings).filter((bot) => isEnabled(settings, bot));

export interface Retry {
  bot: Bot;
  /** The time when the quota of the bot comes back. */
  at: Date;
  /** One retry for each refusal: a refusal that comes after the retry gives a new retry. */
  refusal: string;
}

/**
 * Returns the retries of the bots other than CodeRabbit, which has its own clock. A bot gets a retry
 * if its retries are on and it refused the last commit for quota. The retry waits for the time of the
 * refusal notice, or for 1 hour after the refusal if the notice gives no time.
 */
export function plannedRetries(reviewers: readonly Reviewer[], bots: readonly Bot[], settings: Settings): Retry[] {
  return bots
    .filter((bot) => bot.id !== CODERABBIT.id && retriesOn(settings, bot))
    .flatMap((bot) => {
      const reviewer = reviewers.find((candidate) => candidate.status === 'quota' && isReviewerOf(bot, candidate));
      if (!reviewer?.refusedAt) return [];
      const at = reviewer.until ?? new Date(reviewer.refusedAt.getTime() + GUESSED_QUOTA_MS);
      return [{ bot, at, refusal: reviewer.refusedAt.toISOString() }];
    });
}

export const BOT_FIELDS = [
  { label: 'Name', hint: 'as the bar shows it, for example Sourcery' },
  { label: 'Key', hint: 'one letter that opens its menu' },
  { label: 'Logins', hint: 'its GitHub logins, with a comma between two, for example sourcery-ai[bot]' },
  { label: 'Request', hint: '@mention for a comment, / for a slash command, or a login for a review request' },
  { label: 'Commands', hint: 'with a comma between two; the first one asks for a review (default: review)' },
] as const;

const list = (text: string) =>
  text
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean);

/** Returns why a field of a new bot is not valid, or undefined if it is valid. */
export function checkBotField(step: number, text: string, bots: readonly Bot[]): string | undefined {
  const value = text.trim();
  switch (step) {
    case 0:
      if (!value) return 'The bot needs a name.';
      return bots.some((bot) => bot.name.toLowerCase() === value.toLowerCase() || bot.id === customId(value))
        ? `A bot named ${value} already exists.`
        : undefined;
    case 1: {
      const key = value.toLowerCase();
      if (!/^[a-z0-9]$/.test(key)) return 'The key is one letter or one digit.';
      if (RESERVED_KEYS.has(key)) return `The key ${key} has another use.`;
      const owner = bots.find((bot) => bot.key === key);
      return owner ? `${owner.name} uses the key ${key}.` : undefined;
    }
    case 2:
      return list(value).length === 0 ? 'The bot needs one login or more.' : undefined;
    case 3:
      if (!value) return 'Type @mention, / or a login.';
      if (startsCodingAgent(value)) return 'A mention of @copilot starts its coding agent: use the Copilot bot.';
      if (value.startsWith('/') && value !== '/') return 'Type / alone: the commands come in the next field.';
      return /\s/.test(value) ? 'Type one word.' : undefined;
    default:
      return undefined;
  }
}

/** Makes a custom bot from the valid fields of the form, in the order of BOT_FIELDS. */
export function customBotOf([
  name = '',
  key = '',
  logins = '',
  request = '',
  commands = '',
]: readonly string[]): CustomBot {
  const how = request.trim();
  return {
    name: name.trim(),
    key: key.trim().toLowerCase(),
    logins: list(logins),
    ...(how.startsWith('@') && { mention: how }),
    ...(!how.startsWith('@') && how !== '/' && { reviewer: how }),
    commands: list(commands).length > 0 ? list(commands) : ['review'],
  };
}
