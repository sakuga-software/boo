import { render } from 'ink';
import meow from 'meow';
import { homedir } from 'node:os';
import { App } from './app.js';
import { fetchPullRequest, listPullRequests, viewerLogin } from './github.js';
import { extraFields } from './policy.js';
import { buildReport, type ReportInput } from './report.js';
import { LinkIndex, readOwners } from './sessions.js';
import { loadSettings, parseAuthors, saveSettings, settingsPath } from './settings.js';
import { detectBackground } from './theme.js';

const DEFAULT_ORG = 'sakuga-software';

const cli = meow(
  `
  Watches your open pull requests: the approval, the reviewers, the checks.
  Retries CodeRabbit by itself after its quota comes back.

  Usage
    $ boo [options]

  Options
    -s, --since <YYYY-MM-DD>  Only the pull requests created on or after this date
    -o, --org <org>           GitHub organization, or "all"   (default: ${DEFAULT_ORG})
    -a, --author <login>      Pull request author; repeat it for more authors, and
                              write app/<slug> for a GitHub App
                              (default: "authors" in the settings file, else @me)
    -w, --watch               Stay open until Ctrl+C, and refresh the list once a minute
    -n, --dry-run             Show the state, but post and merge nothing
        --json                Print the state as JSON, one object for each pull
                              request, and post nothing; see the README for the keys
    -h, --help                Show this help
        --version             Show the version

  States of a pull request, from the first that applies
    conflicts          GitHub reports a conflict with the base branch
    changes requested  a reviewer requests changes (the last verdict of each
                       reviewer counts, as on GitHub)
    checks failing     a check of the last commit fails
    ready to merge     approved, every check passes, GitHub can merge, and the
                       "mergePolicy" of the settings file passes (see the README)
    approved           approved, but a check runs or a rule blocks the merge
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
    grouping off.

  Agents
    The line of a pull request shows its coding agent: ✻ for Claude Code,
    ◇ for Copilot, Codex, Cursor or Devin, read from the author, the branch,
    the last commit and the description. A Claude Code session on this
    machine that linked the pull request shows its name; the session with
    the last link wins. A spinner means that it works, and ? that it waits
    for an answer. These records are internal to Claude Code: a new version
    can change them.

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
    $ boo --json | jq '.[] | select(.state == "checks failing") | .url'

  Requires an authenticated gh (gh auth status).
`,
  {
    importMeta: import.meta,
    description: false,
    allowUnknownFlags: false,
    flags: {
      since: { type: 'string', shortFlag: 's' },
      org: { type: 'string', shortFlag: 'o', default: DEFAULT_ORG },
      author: { type: 'string', shortFlag: 'a', isMultiple: true },
      watch: { type: 'boolean', shortFlag: 'w', default: false },
      dryRun: { type: 'boolean', shortFlag: 'n', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', shortFlag: 'h' },
    },
  },
);

const { since } = cli.flags;
if (since !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since)))) {
  console.error(`--since expects a YYYY-MM-DD date, got "${since}".`);
  process.exit(2);
}
const org = cli.flags.org === 'all' ? '' : cli.flags.org;

const settings = await loadSettings();
const authors = parseAuthors(cli.flags.author) ?? settings.authors;

if (cli.flags.json) {
  if (cli.flags.watch) {
    console.error('--json prints the state once: it does not work with --watch.');
    process.exit(2);
  }
  const prs = await listPullRequests({ org, authors, ...(since && { since }) });
  const inputs = await Promise.all(
    prs.map(async (pr): Promise<ReportInput> => {
      try {
        return { pr, snapshot: await fetchPullRequest(pr, extraFields(settings.mergePolicy)) };
      } catch (error) {
        return { pr, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  // The session records are internal to Claude Code. If they are unreadable, the output shows no session.
  const owners = await readOwners(new LinkIndex()).catch(() => new Map());
  const viewer = settings.mergePolicy?.ownerOnly ? await viewerLogin() : undefined;
  const text = `${JSON.stringify(buildReport(inputs, owners, settings, new Date(), viewer), null, 2)}\n`;
  // A pipe takes the output in the background. An exit before the end of the write cuts it.
  await new Promise((resolve) => process.stdout.write(text, resolve));
  process.exit(0);
}

const interactive = cli.flags.watch && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
const background = process.stdout.isTTY
  ? await detectBackground(process.stdin, process.stdout, process.env)
  : 'unknown';
const { watch, dryRun } = cli.flags;
const app = render(
  <App
    options={{ watch, dryRun, org, authors, ...(since && { since }), interactive, background }}
    settings={settings}
    saveSettings={saveSettings}
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
