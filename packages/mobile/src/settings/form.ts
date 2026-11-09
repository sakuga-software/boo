import { parseAuthors, PUSH_STATES, pushOn, resolveRepos, type PushState } from '@sakuga-software/boo-core/settings';
import type { WatchConfig } from './remote';

/** The text fields of the settings screen. A list has one entry per line, or entries split by commas or spaces. */
export interface SettingsForm {
  org: string;
  authors: string;
  repos: string;
  /** The switches of the push notifications, by state. */
  push: Record<PushState, boolean>;
}

// The login rule of GitHub, as the relay checks it.
const ORG = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const REPO = /^(?:[\w.-]+\/)?[\w.-]+$/;

const entries = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** The fields of the screen for a config of the relay. */
export function formOf({ org, settings }: WatchConfig): SettingsForm {
  return {
    org,
    authors: settings.authors.join('\n'),
    repos: (settings.repos ?? []).join('\n'),
    push: Object.fromEntries(PUSH_STATES.map(({ key }) => [key, pushOn(settings, key)])) as Record<PushState, boolean>,
  };
}

/**
 * The config to write from the fields of the screen, or the first problem. The other settings (the bots,
 * the merge policy, the switches) stay as the relay gave them. An empty list of repositories removes
 * `repos`: the relay then follows every repository of the organization.
 */
export function configOf(
  form: SettingsForm,
  current: WatchConfig,
): { config: WatchConfig; error?: undefined } | { error: string } {
  const org = form.org.trim().replace(/^@/, '');
  if (org && !ORG.test(org)) return { error: `"${org}" is not the login of an organization or an account.` };
  const authors = parseAuthors(entries(form.authors));
  if (!authors) return { error: 'Add one author or more, for example @me.' };
  const repos = [...new Set(entries(form.repos))];
  const wrong = repos.find((repo) => !REPO.test(repo) || repo.split('/').some((part) => part === '.' || part === '..'));
  if (wrong) return { error: `"${wrong}" is not a repository: write "owner/name", or "name" with an organization.` };
  let resolved: string[];
  try {
    resolved = resolveRepos(repos, org);
  } catch {
    const bare = repos.find((repo) => !repo.includes('/'));
    return { error: `"${bare}" needs an owner: write "owner/${bare}", or set the organization.` };
  }
  const { repos: _repos, push: _push, ...rest } = current.settings;
  // Only the states turned off go to the relay: a state that the key does not name is on.
  const off = PUSH_STATES.filter(({ key }) => !form.push[key]).map(({ key }) => [key, false] as const);
  return {
    config: {
      org,
      settings: {
        ...rest,
        authors,
        ...(resolved.length > 0 && { repos: resolved }),
        ...(off.length > 0 && { push: Object.fromEntries(off) }),
      },
    },
  };
}

/** True when the fields give the same config as the one of the relay. */
export function unchanged(form: SettingsForm, current: WatchConfig): boolean {
  const next = configOf(form, current);
  if (next.error !== undefined) return false;
  return JSON.stringify(formOf(next.config)) === JSON.stringify(formOf(current));
}
