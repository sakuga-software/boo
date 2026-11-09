import { readPullRequestWith, type Graphql, type PullRequest } from '@sakuga-software/boo-core/github';
import type { RelayChange } from './events.js';
import { GitHubError } from './github.js';
import type { InstallationReader } from './installations.js';
import type { StateStore, WatchConfig } from './state-store.js';

/** The calls of the tracker to GitHub, with the token of an installation. The tests give a fake. */
export interface PullReader {
  /** The open pull requests that the search gives with the token of the installation on `owner`. */
  search(owner: string, query: string): Promise<PullRequest[]>;
  /** Sends a GraphQL query with the token of the installation on `owner`. */
  graphql(owner: string): Graphql;
}

export interface TrackerOptions {
  store: StateStore;
  reader: PullReader;
  /** The accounts where the App is installed, in lower case. */
  accounts: () => Promise<string[]>;
  /** A pull request gets one read for all the webhooks of this time. */
  debounceMs?: number;
  now?: () => number;
  /** Called after each read that saved a pull request: #107 streams the changes. */
  onRead?: (pr: PullRequest) => void;
  log?: (error: unknown) => void;
}

// A pull request webhook that can add a pull request to a list: the lists of the users are read again.
const LIST_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'converted_to_draft', 'edited']);
// The search gives at most 1000 results.
const MAX_PAGES = 10;

/** The fields that a read takes: the merge policy, the events and the reports of every user read the same row. */
const EXTRA = { threads: true, files: true, lineComments: true } as const;

/**
 * The searches that list the pull requests of a user: one for each author and each account, as the
 * GitHub search has no OR between two authors. `@me` is the user.
 */
export function searchesOf(login: string, { org, settings }: WatchConfig, accounts: readonly string[]) {
  const repos = settings.repos ?? [];
  const byOwner = new Map<string, string[]>();
  for (const repo of repos) {
    const owner = (repo.split('/')[0] ?? '').toLowerCase();
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), repo]);
  }
  const scopes: { owner: string; qualifier: string }[] =
    repos.length > 0
      ? [...byOwner].map(([owner, list]) => ({ owner, qualifier: list.map((repo) => `repo:${repo}`).join(' ') }))
      : accounts
          .filter((account) => !org || account === org.toLowerCase())
          .map((account) => ({ owner: account, qualifier: `user:${account}` }));
  const draft = settings.drafts === 'show' ? '' : ' draft:false';
  return scopes
    .filter(({ owner }) => accounts.includes(owner))
    .flatMap(({ owner, qualifier }) =>
      settings.authors.map((author) => ({
        owner,
        query: `is:pr is:open archived:false${draft} author:${author === '@me' ? login : author} ${qualifier}`,
      })),
    );
}

/**
 * Keeps the last state of each pull request that a user follows. A pull request gets a first read when
 * a user starts to follow it, then one read for each burst of webhooks, shared by all its users. The
 * lists of the users are read again on a timer and after a webhook that can add a pull request.
 */
export class Tracker {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reads = new Map<string, Promise<void>>();
  private listTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly log: (error: unknown) => void;

  constructor(private readonly options: TrackerOptions) {
    this.debounceMs = options.debounceMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((error) => console.error(error));
  }

  /** Reads the list of `login` again, then reads the pull requests that have no read yet. */
  async refreshUser(login: string): Promise<void> {
    const config = this.options.store.config(login);
    if (!config) return;
    const accounts = await this.options.accounts();
    const found = new Map<string, PullRequest>();
    for (const { owner, query } of searchesOf(login, config, accounts))
      for (const pr of await this.options.reader.search(owner, query))
        found.set(`${pr.repo.toLowerCase()}#${pr.number}`, pr);
    const prs = [...found.values()];
    this.options.store.setFollows(login, prs, this.now());
    await Promise.all(prs.filter((pr) => !this.options.store.pull(pr)).map((pr) => this.read(pr)));
  }

  /** Reads the lists of every user. A failed list keeps the last one. */
  async refreshAll(): Promise<void> {
    for (const login of this.options.store.logins()) await this.refreshUser(login).catch(this.log);
  }

  /** Takes a change of a webhook: the pull requests that it names get a read after the debounce. */
  onChange(change: RelayChange): void {
    if (change.type === 'pull_request' && change.action && LIST_ACTIONS.has(change.action)) this.scheduleLists();
    const { store } = this.options;
    let prs: PullRequest[] = [];
    if (change.number !== undefined) {
      const stored = store.pull({ repo: change.repo, number: change.number });
      if (stored) prs = [stored.pr];
    } else if (change.sha) prs = store.pullsWithHead(change.repo, change.sha);
    for (const pr of prs) this.schedule(pr);
  }

  /** Stops the timers. A read that runs ends alone. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.listTimer);
  }

  /** Waits for the reads that run now. For the tests and for a stop. */
  async idle(): Promise<void> {
    await Promise.all(this.reads.values());
  }

  private scheduleLists(): void {
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => void this.refreshAll(), this.debounceMs);
  }

  private schedule(pr: PullRequest): void {
    const key = `${pr.repo.toLowerCase()}#${pr.number}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.read(pr);
      }, this.debounceMs),
    );
  }

  /** Reads a pull request once, even if a second read is asked during the first. */
  private read(pr: PullRequest): Promise<void> {
    const key = `${pr.repo.toLowerCase()}#${pr.number}`;
    const running = this.reads.get(key);
    if (running) return running;
    const read = this.readOnce(pr).finally(() => this.reads.delete(key));
    this.reads.set(key, read);
    return read;
  }

  private async readOnce(pr: PullRequest): Promise<void> {
    const owner = pr.repo.split('/')[0] ?? '';
    try {
      const { snapshot } = await readPullRequestWith(this.options.reader.graphql(owner), pr, EXTRA);
      this.options.store.savePull(pr, { snapshot }, this.now());
    } catch (error) {
      this.log(error);
      this.options.store.savePull(pr, { error: error instanceof Error ? error.message : String(error) }, this.now());
    }
    this.options.onRead?.(pr);
  }
}

interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
}

/** The reader of the relay: REST search and GraphQL, with the installation tokens of the App. */
export function pullReader(
  installations: InstallationReader,
  { fetch: fetchFn = fetch, apiUrl = 'https://api.github.com' } = {},
): PullReader {
  const call = async (owner: string, path: string, init: RequestInit = {}): Promise<unknown> => {
    const token = await installations.tokenFor(owner);
    if (!token) throw new GitHubError(`The App is not installed on ${owner}`, 404);
    const response = await fetchFn(`${apiUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'boo-relay',
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} to ${path}`, response.status);
    return response.json();
  };

  return {
    async search(owner, query) {
      const found: PullRequest[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { items } = (await call(
          owner,
          `/search/issues?q=${encodeURIComponent(query)}&sort=updated&per_page=100&page=${page}`,
        )) as { items: SearchItem[] };
        for (const item of items)
          found.push({
            repo: item.repository_url.split('/').slice(-2).join('/'),
            number: item.number,
            title: item.title,
            url: item.html_url,
          });
        if (items.length < 100) break;
      }
      return found;
    },

    graphql: (owner) => async (query, variables) => {
      const body = (await call(owner, '/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })) as { data?: unknown; errors?: { message: string }[] };
      if (body.errors?.length)
        throw new Error(`GitHub GraphQL: ${body.errors.map((error) => error.message).join('; ')}`);
      return body.data;
    },
  };
}
