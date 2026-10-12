import { BOT_LOGIN } from './decide.js';

/** A command of a bot, such as "review". A custom bot can take any command. */
export type Command = string;

export interface BotCommand {
  key: string;
  command: Command;
}

export interface Bot {
  /** A name that stays the same when the settings change. A level of the action bar finds its bot by it. */
  id: string;
  name: string;
  /** The key that opens the menu of the bot in the list of bots. */
  key: string;
  /** The logins of the bot on GitHub. The first one is the main login. */
  logins: readonly string[];
  /** The mention that starts a command in a comment, for example "@coderabbitai". A bot with no mention and no reviewer takes "/command". */
  mention?: string;
  /** The reviewer that `gh pr edit --add-reviewer` takes. A bot with a mention gets a comment instead. */
  reviewer?: string;
  /** The commands of the menu of the bot. The first one asks for a review: the automatic retry posts it. */
  commands: readonly BotCommand[];
  /** The user added the bot in the settings. */
  custom?: true;
}

export const CODERABBIT: Bot = {
  id: 'coderabbit',
  name: 'CodeRabbit',
  key: 'r',
  logins: [BOT_LOGIN],
  mention: '@coderabbitai',
  commands: [
    { key: 'r', command: 'review' },
    { key: 'f', command: 'full review' },
    { key: 'a', command: 'approve' },
    { key: 's', command: 'resolve' },
  ],
};
export const GREPTILE: Bot = {
  id: 'greptile',
  name: 'Greptile',
  key: 'g',
  logins: ['greptile-apps[bot]'],
  mention: '@greptileai',
  commands: [{ key: 'r', command: 'review' }],
};
// A mention of @copilot in a comment starts the Copilot coding agent, which pushes commits. Only a review request is safe.
export const COPILOT: Bot = {
  id: 'copilot',
  name: 'Copilot',
  key: 'c',
  logins: ['copilot-pull-request-reviewer[bot]', 'Copilot'],
  reviewer: '@copilot',
  commands: [{ key: 'r', command: 'review' }],
};
// Each PR-Agent install posts with its own login, so the reviewer carries a flag and the bot has no login.
export const PR_AGENT: Bot = {
  id: 'pr-agent',
  name: 'PR-Agent',
  key: 'p',
  logins: [],
  commands: [
    { key: 'r', command: 'review' },
    { key: 'i', command: 'improve' },
  ],
};

export interface Request {
  bot: Bot;
  command: Command;
}

/** The level of the action bar: the main set, the list of bots, or the menu of one bot. */
export type Mode = 'main' | 'bots' | Bot;

export interface Action {
  key: string;
  label: string;
  request?: Request;
  /** The action merges the pull request. It always asks for a confirmation. */
  merge?: true;
}

const MAIN_ACTIONS: readonly Action[] = [
  { key: 'o', label: 'open' },
  { key: 'm', label: 'merge', merge: true },
];

/** The bots that the tool knows. The settings can turn each one off and add more. */
export const BOTS: readonly Bot[] = [CODERABBIT, GREPTILE, COPILOT, PR_AGENT];

/**
 * The keys that a bot or a command must not take: the list, the prompt and the panel read them first,
 * the main set works at every level, and "m" ends a mouse report.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['j', 'k', 'q', 'h', ',', ' ', 'y', 'n', 'o', 'm']);

/** A mention of @copilot starts the Copilot coding agent, which pushes commits. */
export const startsCodingAgent = (mention: string) => mention.trim().toLowerCase() === '@copilot';

/** Returns the actions that the bar shows at a level. The list of bots shows bots, not actions. A key belongs to the menu of one bot. */
export function actionsOf(mode: Mode): readonly Action[] {
  if (mode === 'main') return MAIN_ACTIONS;
  if (mode === 'bots') return [];
  return mode.commands.map(({ key, command }) => ({ key, label: command, request: { bot: mode, command } }));
}

/** Returns the level above a level. The main set is the top. */
export const parentOf = (mode: Mode): Mode => (mode === 'main' || mode === 'bots' ? 'main' : 'bots');

const BACK_WIDTH = '← back'.length + 2;
const buttonWidth = (key: string, label: string) => key.length + label.length + 3;

/** The width of the widest bot level of the action bar with its labels: the list of bots, or the menu of one bot. */
export const botBarWidth = (bots: readonly Bot[]) =>
  BACK_WIDTH +
  Math.max(
    bots.reduce((width, bot) => width + buttonWidth(bot.key, bot.name), 0),
    ...bots.map(
      (bot) =>
        bot.name.length +
        1 +
        actionsOf(bot).reduce((width, action) => width + buttonWidth(action.key, action.label), 0),
    ),
  );

export const BOT_BAR_WIDTH = botBarWidth(BOTS);

export const isCodeRabbit = (request: Request) => request.bot.id === CODERABBIT.id;

/** The comment that the request posts, or a description of the review request. */
export function requestText({ bot, command }: Request): string {
  if (bot.reviewer) return `review request to ${bot.name}`;
  return bot.mention ? `${bot.mention} ${command}` : `/${command}`;
}

/** Returns the action of a key at a level. The keys of the main set work at every level. */
export const actionForKey = (input: string, mode: Mode = 'main') =>
  [...actionsOf(mode), ...MAIN_ACTIONS].find((action) => action.key === input);

export interface ReviewerRef {
  login: string;
  prAgent?: boolean;
}

/** Tells if a reviewer of a pull request is this bot. */
export const isReviewerOf = (bot: Bot, reviewer: ReviewerRef) =>
  bot.id === PR_AGENT.id ? Boolean(reviewer.prAgent) : bot.logins.includes(reviewer.login);

/** Tells if a bot that takes its commands in a comment is absent from the reviewers of a pull request. */
export const isAbsent = (bot: Bot, reviewers: readonly ReviewerRef[] | undefined) =>
  Boolean(!bot.reviewer && reviewers && !reviewers.some((reviewer) => isReviewerOf(bot, reviewer)));

export interface Target {
  left: boolean;
  dryRun: boolean;
  /** The reviewers of the pull request, if the tool read them. */
  reviewers?: readonly ReviewerRef[];
}

/** Returns why the action is not available on the target, or null if it is available. */
export function refusal(action: Action, target: Target): string | null {
  if (!action.request && !action.merge) return null;
  if (target.left) return 'this pull request is no longer open';
  if (target.dryRun) return action.merge ? 'dry run: the tool merges nothing' : 'dry run: the tool posts nothing';
  // A bot that reviews through a comment answers only on a repository where it is installed.
  // GitHub adds a requested reviewer to any pull request, so a review request needs no earlier review.
  const bot = action.request?.bot;
  if (bot && isAbsent(bot, target.reviewers)) return `${bot.name} does not review this pull request`;
  return null;
}

/** Moves a selection by key, so a row that the list refresh adds or moves keeps its place. */
export function moveSelection(keys: string[], selected: string | undefined, step: number): string | undefined {
  if (keys.length === 0) return undefined;
  const index = selected === undefined ? -1 : keys.indexOf(selected);
  if (index === -1) return keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, index + step))];
}

/**
 * Keeps the selection on a visible row. If the selected row is hidden, the selection goes to
 * the next visible row in the full list, or to the previous one at the end of the list.
 */
export function reselect(allKeys: string[], visibleKeys: string[], selected: string | undefined): string | undefined {
  if (visibleKeys.length === 0) return undefined;
  if (selected !== undefined && visibleKeys.includes(selected)) return selected;
  const visible = new Set(visibleKeys);
  const index = selected === undefined ? -1 : allKeys.indexOf(selected);
  if (index === -1) return visibleKeys[0];
  return (
    allKeys.slice(index + 1).find((key) => visible.has(key)) ??
    allKeys.slice(0, index).findLast((key) => visible.has(key))
  );
}
