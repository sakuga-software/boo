import { BOT_LOGIN } from "./decide.js";

export type Command = "review" | "full review" | "approve" | "resolve";

export interface Bot {
  name: string;
  /** The logins of the bot on GitHub. The first one is the main login. */
  logins: readonly string[];
  /** The mention that starts a command in a comment, for example "@coderabbitai". */
  mention?: string;
  /** The reviewer that `gh pr edit --add-reviewer` takes. A bot with a mention gets a comment instead. */
  reviewer?: string;
}

export const CODERABBIT: Bot = { name: "CodeRabbit", logins: [BOT_LOGIN], mention: "@coderabbitai" };
export const GREPTILE: Bot = { name: "Greptile", logins: ["greptile-apps[bot]"], mention: "@greptileai" };
// A mention of @copilot in a comment starts the Copilot coding agent, which pushes commits. Only a review request is safe.
export const COPILOT: Bot = { name: "Copilot", logins: ["copilot-pull-request-reviewer[bot]", "Copilot"], reviewer: "@copilot" };

export interface Request {
  bot: Bot;
  command: Command;
}

export type Mode = "main" | "bots";

export interface Action {
  key: string;
  label: string;
  /** The bar that shows the action. Every key works in both bars. */
  mode: Mode;
  request?: Request;
  /** The action merges the pull request. It always asks for a confirmation. */
  merge?: true;
}

export const ACTIONS: readonly Action[] = [
  { key: "o", label: "open", mode: "main" },
  { key: "m", label: "merge", mode: "main", merge: true },
  { key: "r", label: "review", mode: "bots", request: { bot: CODERABBIT, command: "review" } },
  { key: "f", label: "full review", mode: "bots", request: { bot: CODERABBIT, command: "full review" } },
  { key: "a", label: "approve", mode: "bots", request: { bot: CODERABBIT, command: "approve" } },
  { key: "s", label: "resolve", mode: "bots", request: { bot: CODERABBIT, command: "resolve" } },
  { key: "g", label: "review", mode: "bots", request: { bot: GREPTILE, command: "review" } },
  { key: "c", label: "review", mode: "bots", request: { bot: COPILOT, command: "review" } },
];

export const BOTS: readonly Bot[] = [CODERABBIT, GREPTILE, COPILOT];

/** The width of the bot set of the action bar with its labels: each bot name, its buttons, and "← back". */
export const BOT_BAR_WIDTH =
  BOTS.reduce(
    (width, bot) =>
      width +
      bot.name.length + 2 +
      ACTIONS.filter((action) => action.request?.bot === bot).reduce((sum, action) => sum + action.key.length + action.label.length + 3, 0),
    0,
  ) + "← back".length + 2;

export const isCodeRabbit = (request: Request) => request.bot === CODERABBIT;

/** The comment that the request posts, or a description of the review request. */
export const requestText = ({ bot, command }: Request) => (bot.mention ? `${bot.mention} ${command}` : `review request to ${bot.name}`);

export const actionForKey = (input: string) => ACTIONS.find((action) => action.key === input);

export interface Target {
  left: boolean;
  dryRun: boolean;
  /** The logins of the reviewers of the pull request, if the tool read them. */
  reviewers?: readonly string[];
}

/** Returns why the action is not available on the target, or null if it is available. */
export function refusal(action: Action, target: Target): string | null {
  if (!action.request && !action.merge) return null;
  if (target.left) return "this pull request is no longer open";
  if (target.dryRun) return action.merge ? "dry run: the tool merges nothing" : "dry run: the tool posts nothing";
  // A bot that reviews through a mention answers only on a repository where it is installed.
  // GitHub adds a requested reviewer to any pull request, so a review request needs no earlier review.
  const bot = action.request?.bot;
  if (bot?.mention && target.reviewers && !bot.logins.some((login) => target.reviewers!.includes(login))) {
    return `${bot.name} does not review this pull request`;
  }
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
  return allKeys.slice(index + 1).find((key) => visible.has(key)) ?? allKeys.slice(0, index).findLast((key) => visible.has(key));
}
