import type { PushState } from '@sakuga-software/boo-core/settings';
import type { Tone } from '@sakuga-software/boo-core/theme';
import type { IconName } from '../ui/icons';
import type { WatchConfig } from './remote';

/** The value of the Organization row. */
export const orgSummary = (org: string) => org || 'every account';

/** The value of the Authors row: `@me · my-agent · dependabot`. */
export const authorsSummary = (authors: readonly string[]) => authors.join(' · ');

/** The value of the Repositories row. */
export function reposSummary(repos: readonly string[] | undefined, org: string): string {
  if (!repos || repos.length === 0) return org ? 'all of the organization' : 'all repositories';
  if (repos.length === 1) return repos[0]!;
  return `${repos.length} repositories`;
}

/** The switches of the push notifications, in the words and the order of the mockup. */
export const PUSH_ROWS: readonly { key: PushState; label: string; icon: IconName; tone: Tone }[] = [
  { key: 'ready', label: 'is ready to merge', icon: 'check', tone: 'green' },
  { key: 'changesRequested', label: 'gets changes requested', icon: 'pencil', tone: 'red' },
  { key: 'checksFailing', label: 'has failing checks', icon: 'x', tone: 'red' },
  { key: 'conflicts', label: 'has conflicts', icon: 'warn', tone: 'red' },
  { key: 'stalled', label: 'starts to stall', icon: 'zz', tone: 'yellow' },
  { key: 'merged', label: 'is merged', icon: 'merged', tone: 'magenta' },
];

/**
 * The config with the push notification of `state` turned on or off. Only the states turned off go
 * to the relay: a state that the key does not name is on.
 */
export function withPush(config: WatchConfig, state: PushState, on: boolean): WatchConfig {
  const { push, ...rest } = config.settings;
  const next = { ...push };
  if (on) delete next[state];
  else next[state] = false;
  return { org: config.org, settings: { ...rest, ...(Object.keys(next).length > 0 && { push: next }) } };
}

/** The host of a relay, for the account card: `boo-relay.sakuga.dev`. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
