import { render } from 'ink';
import meow from 'meow';
import { homedir } from 'node:os';
import { App } from './app.js';
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
    -h, --help                Show this help
        --version             Show the version

  States of a pull request, from the first that applies
    conflicts          GitHub reports a conflict with the base branch
    changes requested  a reviewer requests changes (the last verdict of each
                       reviewer counts, as on GitHub)
    checks failing     a check of the last commit fails
    ready to merge     approved, every check passes, and GitHub can merge
    approved           approved, but a check runs or a rule blocks the merge
    reviewing          a reviewer reviews the pull request now
    reviewed           a reviewer reviewed the last commit, with no verdict
    quota              the reviewers that have not reviewed the last commit are
                       out of quota
    awaiting review    no reviewer reviewed the last commit yet
    merged, closed, draft
                       the pull request left the list; a draft comes back when
                       it is ready for review

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
    With --watch in a terminal, the list takes keys and mouse clicks. The
    selected row shows its details: failing checks, quota times.
    ↑ ↓  or  k j    select a pull request; the mouse wheel does it too
    o  or  Enter    open the pull request in the browser
    m               merge the pull request (squash, else merge, else rebase)
    h               show or hide the merged, closed and draft pull requests;
                    they are hidden by default
    ,               open the settings: the hidden pull requests, the parts of
                    a row and the authors; saved in ${settingsPath().replace(homedir(), '~')}
    →  or  space    show the list of the review bots
    ←  or  space    go back one level; Esc goes back to the main set
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
  changes, a missing approval, a failing or running check, a conflict or a
  protection rule. A click selects a row or presses a button. The mouse mode
  takes over text selection: hold Shift or Option, depending on the terminal,
  to select text.

  Examples
    $ boo --watch
    $ boo --org all
    $ boo --dry-run --since 2026-09-15
    $ boo --author @me --author app/my-agent

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

const interactive = cli.flags.watch && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
const background = process.stdout.isTTY
  ? await detectBackground(process.stdin, process.stdout, process.env)
  : 'unknown';
const settings = await loadSettings();
const { watch, dryRun } = cli.flags;
const authors = parseAuthors(cli.flags.author) ?? settings.authors;
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
