import { render } from 'ink';
import meow from 'meow';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { App } from './app.js';
import {
  fetchPullRequest,
  listPullRequests,
  openInBrowser,
  parsePullRequestRef,
  probePullRequests,
  uniqueRefs,
  viewerLogin,
} from './github.js';
import { parseWatchState, readReport, watchEvents, writeWatchState, type WatchSources } from './events.js';
import { extraFields } from '@sakuga-software/boo-core/policy';
import { LinkIndex, readOwners } from './sessions.js';
import { loadSettings, parseAuthors, parseRepos, resolveRepos, saveSettings, settingsPath } from './settings.js';
import { detectBackground } from './theme.js';
import { relayStream } from '@sakuga-software/boo-core/stream';
import { DEFAULT_RELAY, loadRelay, relayPath, removeWebhooks, setupWebhooks } from './webhooks.js';

const DEFAULT_ORG = 'sakuga-software';

const cli = meow(
  `
  Watches your open pull requests: the approval, the reviewers, the checks.
  Retries CodeRabbit by itself after its quota comes back.

  Usage
    $ boo [options]
    $ boo setup-webhooks [relay-url] [--remove]

  Commands
    setup-webhooks [relay-url]
                              Connect this machine to a webhook relay
                              (default: ${DEFAULT_RELAY}): sign in on
                              GitHub with a code, install the GitHub App of
                              the relay, and save the session in
                              ${relayPath().replace(homedir(), '~')}
    setup-webhooks --remove   Delete the session on the relay and on this machine

  Options
    -s, --since <YYYY-MM-DD>  Only the pull requests created on or after this date
    -o, --org <org>           GitHub organization, or "all"   (default: ${DEFAULT_ORG})
    -r, --repo <repo>         Only this repository: owner/name, or name in the
                              organization; repeat it for more repositories
                              (default: "repos" in the settings file, else all)
    -a, --author <login>      Pull request author; repeat it for more authors, and
                              write app/<slug> for a GitHub App
                              (default: "authors" in the settings file, else @me)
    -w, --watch               Stay open until Ctrl+C, and refresh the list once a minute
    -n, --dry-run             Show the state, but post and merge nothing
        --json                Print the state as JSON, one object for each pull
                              request, and post nothing; the docs give the keys
        --pr <repo#number>    With --json: read only this pull request, as
                              owner/repo#123, repo#123 or its URL, with no list;
                              repeat it for more
        --events              With --watch: print each change as one JSON line
                              (NDJSON), and post nothing; see the docs
        --drafts              With --json or --events: keep the drafts, with the
                              state "draft" and their checks, reviews and policy
                              ("drafts": "show" in the settings file)
        --state <file>        With --events: keep the last state in this file, and
                              print at the start only the changes since that state
        --snapshot            With --state: also print one snapshot line for each
                              pull request at the start
    -h, --help                Show this help
    -v, --version             Show the version

  States of a pull request, from the first that applies
    conflicts          GitHub reports a conflict with the base branch
    changes requested  a reviewer requests changes (the last verdict of each
                       reviewer counts, as on GitHub)
    checks failing     a check of the last commit fails; a check of a run that
                       a newer run of the same workflow replaces does not count
    reviewer error     only a check of a review bot fails ("reviewerChecks"
                       in the settings): the bot failed, not the change
    ready to merge     approved, every check passes, GitHub can merge, and the
                       "mergePolicy" of the settings file passes (see the docs)
    approved           approved, but a check runs or a rule blocks the merge; a
                       workflow run that is queued or between two jobs runs too
    reviewing          a reviewer reviews the pull request now
    reviewed           a reviewer reviewed the last commit, with no verdict
    quota              the reviewers that have not reviewed the last commit are
                       out of quota
    awaiting review    no reviewer reviewed the last commit yet
    merged, closed, draft
                       the pull request left the list; a draft comes back when
                       it is ready for review

  Stacks
    A pull request that merges into the head branch of another listed pull
    request shows after it, under the bottom of the stack, with one indent and
    a line: "on #921 · 2/3" is its place in the stack. A pull request on
    another base shows that base ("on feat/x"). The settings can turn the
    grouping off. "parent merged · rebase" marks a pull request that GitHub
    moved to a new base after its parent merged, with no commit since.

  Stalled
    zZ marks a pull request that is conflicts, changes requested or checks
    failing, with no local session that works on it, and no new commit for
    "stalledAfterMinutes" in the settings file (30 by default).

  Agents
    The line of a pull request shows its coding agent: ✻ for Claude Code,
    ◇ for Copilot, Codex, Cursor or Devin, read from the author, the branch,
    the last commit and the description. A Claude Code session on this
    machine that linked the pull request shows its name; the session with
    the last link wins. A spinner means that it works, and ? that it waits
    for an answer. If a sub-agent of the session opened or changed the pull
    request with gh pr, its task follows the name of the session, and the
    spinner means that the sub-agent works; ✖ marks a sub-agent that failed.
    These records are internal to Claude Code: a new version can change them.

  Reviewers
    A reviewer is a person or a bot that submitted a review, that GitHub asks
    for a review, CodeRabbit if it commented, or PR-Agent if it posted its
    review comment. The tool knows no list of bots. The mark of PR-Agent is its
    merge recommendation; it never counts as a GitHub approval.
    The author is not a reviewer. Each reviewer shows one mark:
    ✔ approved  ✎ changes requested  ● commented   on the last commit
    ⟳ reviewing (with "2/3" if the bot shows its progress)
    ◷ quota (with the return time if the notice gives one)
    ↻ CodeRabbit to retry   ○ requested   ◌ an older commit only
    ⊘ skipped   ‖ paused
    A review that says "quota", "rate limit" or "usage limit" in its first
    paragraph is a refusal, not a review. A red check of a refused reviewer
    does not count as a failing check.

  CodeRabbit retries
    The CodeRabbit quota belongs to the developer, so the tool reads one clock
    from all the listed pull requests (per repository on the CodeRabbit Open
    source plan). The time comes from the newest notice with a delay
    ("available in …", counted from the last edit of that comment, plus 30 s
    because CodeRabbit rounds its delays). A refused command with no delay only
    dates the refusal. "N remain after this review" on a later review means the
    quota is back. If a refusal came after the time that the newest notice
    gave, the tool assumes 1 hour. After the quota comes back, the tool posts a
    bare "@coderabbitai review", one request at a time, and polls for the reply
    for about 90 s.

  Keys and mouse
    With --watch in a terminal, the list takes keys and mouse clicks. Each
    pull request takes one line; e unfolds it.
    ↑ ↓  or  k j    select a pull request; the mouse wheel does it too
    Enter  or  o    open the pull request in the browser
    e               unfold or fold the selected pull request: the size of
                    the change, its agent, its reviewers with their
                    confidence, its checks and notes; a click on the
                    selected row does it too; only in the main set
    →  ←            unfold, fold the selected pull request; in another
                    level, ← goes back one level
    m               merge the pull request (squash, else merge, else rebase)
    r               read the list and every pull request again now; only in
                    the main set, because the bots use r
    h               show or hide the merged, closed and draft pull requests;
                    they are hidden by default
    a               show the commands for the agent, in the main set only:
                    b rebase, r review, f fix, t test; each one sends a
                    prompt to the local session of the pull request, which
                    reads it after its current turn; "agentPrompts" in the
                    settings file changes a prompt ({url}, {branch}, {base});
                    w opens the cloud session that the description links
    ,               open the settings: the hidden pull requests, the parts of
                    a row, the authors and the review bots (on or off,
                    automatic retry, bots of your own); saved in
                    ${settingsPath().replace(homedir(), '~')}
    b  or  space    show the list of the review bots
    space           go back one level; Esc goes back to the main set
    In the list of the review bots, a key opens the menu of a bot:
    r  CodeRabbit   r "@coderabbitai review", f "@coderabbitai full review",
                    a "@coderabbitai approve": resolve the threads, then approve,
                    s "@coderabbitai resolve": resolve the threads
    g  Greptile     r "@greptileai review"
    c  Copilot      r request a review (needs gh 2.88 or later)
    p  PR-Agent     r "/review", i "/improve"
    q               quit
  A key of a bot or of a command works only at its level. A narrow terminal hides some parts of a row.
  Each post and each merge asks for a confirmation: y or Enter confirms, n or
  Esc cancels. Before a merge, the confirmation warns about a request for
  changes, a missing approval, a failing or running check, a conflict, a
  protection rule, or a base that is not the default branch. A click selects a row or presses a button. The mouse mode
  takes over text selection: hold Shift or Option, depending on the terminal,
  to select text.

  Examples
    $ boo --watch
    $ boo --org all
    $ boo --dry-run --since 2026-09-15
    $ boo --author @me --author app/my-agent
    $ boo --repo boo --repo acme/web
    $ boo --json | jq '.[] | select(.state == "checks failing") | .url'
    $ boo --watch --events | jq -c 'select(.event == "state")'

  Requires an authenticated gh (gh auth status).
  Docs: https://sakuga-software.github.io/boo/
`,
  {
    importMeta: import.meta,
    description: false,
    allowUnknownFlags: false,
    flags: {
      since: { type: 'string', shortFlag: 's' },
      org: { type: 'string', shortFlag: 'o', default: DEFAULT_ORG },
      author: { type: 'string', shortFlag: 'a', isMultiple: true },
      repo: { type: 'string', shortFlag: 'r', isMultiple: true },
      watch: { type: 'boolean', shortFlag: 'w', default: false },
      dryRun: { type: 'boolean', shortFlag: 'n', default: false },
      json: { type: 'boolean', default: false },
      events: { type: 'boolean', default: false },
      pr: { type: 'string', isMultiple: true },
      state: { type: 'string' },
      drafts: { type: 'boolean', default: false },
      snapshot: { type: 'boolean', default: false },
      help: { type: 'boolean', shortFlag: 'h' },
      version: { type: 'boolean', shortFlag: 'v' },
      remove: { type: 'boolean', default: false },
    },
  },
);

const [command, ...rest] = cli.input;
if (command === 'setup-webhooks') {
  const path = relayPath();
  try {
    if (cli.flags.remove) {
      const removed = await removeWebhooks({ fetch, log: console.log, path });
      console.log(removed ? 'Webhooks removed from this machine.' : 'This machine has no webhook relay.');
    } else {
      const connection = await setupWebhooks(rest[0], {
        fetch,
        open: openInBrowser,
        log: console.log,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
        path,
      });
      console.log(`Webhooks set up with ${connection.url}, saved in ${path.replace(homedir(), '~')}.`);
    }
    process.exit(0);
  } catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
if (command !== undefined) {
  console.error(`Unknown command "${command}". See boo --help.`);
  process.exit(2);
}
if (cli.flags.remove) {
  console.error('--remove goes with setup-webhooks.');
  process.exit(2);
}

const { since } = cli.flags;
if (since !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since)))) {
  console.error(`--since expects a YYYY-MM-DD date, got "${since}".`);
  process.exit(2);
}
const org = cli.flags.org === 'all' ? '' : cli.flags.org;

const settings = await loadSettings();
// The terminal list has its own setting for the drafts, and it saves the settings: --drafts is only for one run of a script.
if (cli.flags.drafts && !cli.flags.json && !cli.flags.events) {
  console.error('--drafts keeps the drafts in the output of a script: it needs --json or --events.');
  process.exit(2);
}
if (cli.flags.drafts) settings.drafts = 'show';
const authors = parseAuthors(cli.flags.author) ?? settings.authors;
const repoFlags = cli.flags.repo ?? [];
const badRepo = repoFlags.find((repo) => !parseRepos([repo]));
if (badRepo !== undefined) {
  console.error(`--repo expects owner/name or name, got "${badRepo}".`);
  process.exit(2);
}
let repos: string[];
try {
  repos = resolveRepos(repoFlags.length > 0 ? repoFlags : (settings.repos ?? []), org);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const sources: WatchSources = {
  listPullRequests: () =>
    listPullRequests({
      org,
      authors,
      repos,
      ...(since && { since }),
      ...(settings.drafts === 'show' && { drafts: true }),
    }),
  // Only the events read the text of the line comments: the other modes do not need the bytes.
  fetchPullRequest: (pr) =>
    fetchPullRequest(pr, {
      extra: {
        ...extraFields(settings.mergePolicy),
        reviewerChecks: settings.reviewerChecks,
        ...(cli.flags.events && { lineComments: true }),
      },
    }),
  probePullRequests,
  readOwners: () => readOwners(new LinkIndex()),
  viewerLogin,
};
// A pipe takes the output in the background. An exit before the end of the write cuts it.
const write = (text: string) => new Promise((resolve) => process.stdout.write(text, resolve));

if ((cli.flags.pr ?? []).length > 0 && !cli.flags.json) {
  console.error('--pr reads one pull request for a script: it needs --json.');
  process.exit(2);
}

if (cli.flags.events) {
  if (!cli.flags.watch) {
    console.error('--events streams the changes: it needs --watch.');
    process.exit(2);
  }
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  if (cli.flags.snapshot && !cli.flags.state) {
    console.error('--snapshot adds snapshot lines to a start from a saved state: it needs --state <file>.');
    process.exit(2);
  }
  const statePath = cli.flags.state;
  // A missing file is a first run. Another error, such as a right that is missing, must not start from nothing.
  const text = statePath
    ? await readFile(statePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        console.error(`✖ cannot read the state in ${statePath}: ${error.message}`);
        process.exit(2);
      })
    : undefined;
  const initial = parseWatchState(text);
  await watchEvents(
    sources,
    settings,
    {
      intervalMs: 60_000,
      signal: abort.signal,
      initial,
      snapshots: cli.flags.snapshot,
      // A rename replaces the file in one step: a stop during the write leaves the old state, not a broken file.
      ...(statePath && {
        onState: (state) => writeWatchState(statePath, state),
        onStateError: (error: unknown) =>
          console.error(
            `✖ cannot write the state to ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }),
    },
    async (event) => void (await write(`${JSON.stringify(event)}\n`)),
    (error) => console.error(`✖ ${error instanceof Error ? error.message : String(error)}`),
  );
  process.exit(0);
}

if (cli.flags.json) {
  if (cli.flags.watch) {
    console.error('--json prints the state once: --watch --events streams the changes.');
    process.exit(2);
  }
  const named = cli.flags.pr ?? [];
  const refs = named.map((text) => parsePullRequestRef(text, org));
  const wrong = named.filter((_, index) => !refs[index]);
  if (wrong.length > 0) {
    console.error(`--pr takes owner/repo#123, repo#123 or the URL of a pull request: ${wrong.join(', ')}`);
    process.exit(2);
  }
  // A named pull request skips the search: the read uses the shared cache, as each row of the list does.
  const prs = named.length > 0 ? uniqueRefs(refs.filter((ref) => ref !== undefined)) : await sources.listPullRequests();
  const reports = await readReport(prs, sources, settings, new Date());
  await write(`${JSON.stringify(reports, null, 2)}\n`);
  process.exit(0);
}

const interactive = cli.flags.watch && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
const background = process.stdout.isTTY
  ? await detectBackground(process.stdin, process.stdout, process.env)
  : 'unknown';
const { watch, dryRun } = cli.flags;
// Without `boo setup-webhooks`, the watch polls GitHub as before.
const connection = watch ? await loadRelay() : undefined;
const relay = connection
  ? relayStream(connection, {
      fetch,
      sleep: (ms, signal) => wait(ms, undefined, { signal }),
    })
  : undefined;
const app = render(
  <App
    options={{ watch, dryRun, org, authors, repos, ...(since && { since }), interactive, background }}
    settings={settings}
    saveSettings={saveSettings}
    relay={relay}
  />,
  { alternateScreen: interactive },
);
process.once('SIGTERM', () => app.unmount());
try {
  await app.waitUntilExit();
} catch (error) {
  process.exitCode = 1;
  // The alternate screen drops its last frame on exit, and the error with it.
  if (interactive) console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
}
