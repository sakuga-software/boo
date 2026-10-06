import { render } from 'ink';
import { setTimeout as sleep } from 'node:timers/promises';
import { isCodeRabbit } from '../src/actions.js';
import { App, type GitHub } from '../src/app.js';
import { BOT_LOGIN, REQUEST_BODY, type Comment, type Review } from '../src/decide.js';
import type { PullRequest, PullRequestSnapshot, PullRequestStatus } from '../src/github.js';
import type { Check } from '../src/reviewers.js';
import { detectBackground } from '../src/theme.js';

const start = Date.now();
const iso = (offsetMs: number) => new Date(start + offsetMs).toISOString();
const elapsed = () => Date.now() - start;

const CLAUDE = 'claude-review[bot]';
const COPILOT = 'copilot-pull-request-reviewer[bot]';
const GREPTILE = 'greptile-apps[bot]';
const VORTEX = 'mergestorm-vortex[bot]';

const comment = (login: string, body: string, at: number, updatedAt = at): Comment => ({
  user: { login },
  body,
  created_at: iso(at),
  updated_at: iso(updatedAt),
});
const review = (commit: string, at: number, state = 'APPROVED', login = BOT_LOGIN, body = 'findings'): Review => ({
  user: { login },
  commit_id: commit,
  submitted_at: iso(at),
  state,
  body,
  threadReply: false,
});
const copilotRefusal = (commit: string) =>
  review(
    commit,
    -300_000,
    'COMMENTED',
    COPILOT,
    'Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.',
  );
const progress = (commit: string, done: number, total: number) =>
  review(
    commit,
    -5_000,
    'COMMENTED',
    VORTEX,
    `Review progress \`${'█'.repeat(done)}${'░'.repeat(total - done)}\` ${done}/${total} files`,
  );

const SUMMARY = '<!-- summarize by coderabbit.ai -->';
const inProgress = (at: number) =>
  comment(BOT_LOGIN, `${SUMMARY} <!-- review in progress by coderabbit.ai -->`, -3_600_000, at);
const rateLimited = (at: number, delay: string) =>
  comment(
    BOT_LOGIN,
    `${SUMMARY} <!-- rate limited by coderabbit.ai --> **Next included review available in ${delay}.**`,
    -3_600_000,
    at,
  );

const checks = (passed: number, running = 0, failed: string[] = []): Check[] => [
  ...Array.from({ length: passed }, (_, index): Check => ({ name: `check-${index}`, state: 'success' })),
  ...Array.from({ length: running }, (_, index): Check => ({ name: `running-${index}`, state: 'pending' })),
  ...failed.map((name): Check => ({ name, state: 'failure' })),
];

const pr = (repo: string, number: number, title: string): PullRequest => ({
  repo: `acme/${repo}`,
  number,
  title,
  url: `https://github.com/acme/${repo}/pull/${number}`,
});

const prs = [
  pr('web', 517, 'feat(checkout): pay with a saved card'),
  pr('api', 912, 'fix(auth): refresh the token before it expires'),
  pr('mobile', 911, 'feat(settings): a dark theme'),
  pr('api', 910, 'fix(orders): one refund per order'),
  pr('web', 899, 'docs: document the public API'),
];
const lateArrival = pr('web', 921, 'feat(search): filter the results by date');
const CHANGE_AT = 8_000;
const DEMO_LENGTH_MS = 32_000;

let requestedAt: number | undefined;

type Facts = Pick<PullRequestSnapshot, 'head' | 'reviews' | 'comments' | 'checks'> & Partial<PullRequestSnapshot>;

const mergedByHand = new Set<number>();

function status(target: PullRequest): PullRequestStatus {
  if (mergedByHand.has(target.number)) return 'merged';
  return target.number === 910 && elapsed() >= CHANGE_AT ? 'merged' : 'open';
}

function state(target: PullRequest): Facts {
  const t = elapsed();
  switch (target.number) {
    case 517:
      return t < 7_000
        ? {
            head: 'a1',
            reviews: [review('a1', -60_000, 'APPROVED', CLAUDE)],
            comments: [inProgress(-20_000)],
            checks: checks(9, 3),
          }
        : {
            head: 'a1',
            reviews: [review('a1', -60_000, 'APPROVED', CLAUDE), review('a1', 6_500)],
            comments: [],
            checks: checks(12),
          };
    case 912:
      return {
        head: 'b1',
        reviews: [
          review('b1', -600_000, 'CHANGES_REQUESTED'),
          review('b1', -500_000, 'COMMENTED', GREPTILE, ''),
          copilotRefusal('b1'),
        ],
        comments: [],
        checks: checks(8),
        mergeState: 'blocked',
      };
    case 911: {
      const vortex = progress('c1', Math.min(4, 1 + Math.floor(t / 5_000)), 4);
      const base = { head: 'c1', checks: checks(10, 0, ['e2e']) };
      if (requestedAt === undefined)
        return { ...base, reviews: [vortex], comments: [rateLimited(-70_000, '50 seconds')] };
      const request = comment('octocat', REQUEST_BODY, requestedAt);
      if (t < requestedAt + 2_500)
        return { ...base, reviews: [vortex], comments: [rateLimited(-70_000, '50 seconds'), request] };
      if (t < requestedAt + 6_000) {
        const triggered = comment(BOT_LOGIN, 'Action performed: Review triggered.', requestedAt + 2_000);
        return { ...base, reviews: [vortex], comments: [inProgress(requestedAt + 2_000), request, triggered] };
      }
      return { ...base, reviews: [vortex, review('c1', requestedAt + 6_000, 'COMMENTED')], comments: [] };
    }
    case 910:
      return { head: 'd2', reviews: [review('d1', -900_000)], comments: [], checks: checks(6) };
    case 921:
      return t < 16_000
        ? { head: 'f1', reviews: [], comments: [inProgress(CHANGE_AT)], checks: checks(4, 6), requested: [GREPTILE] }
        : {
            head: 'f1',
            reviews: [review('f1', 15_500), review('f1', 15_000, 'APPROVED', GREPTILE, '')],
            comments: [],
            checks: checks(10),
          };
    default:
      return {
        head: 'e1',
        reviews: [review('e1', -1_200_000, 'COMMENTED'), review('e0', -2_400_000, 'COMMENTED', CLAUDE)],
        comments: [],
        checks: checks(5),
      };
  }
}

const fakeGitHub: GitHub = {
  async listPullRequests() {
    await sleep(900);
    return elapsed() < CHANGE_AT ? prs : [...prs.filter((item) => item.number !== 910), lateArrival];
  },
  async fetchPullRequest(target) {
    await sleep(300 + Math.random() * 700);
    return { author: 'octocat', mergeState: 'clean', requested: [], status: status(target), ...state(target) };
  },
  async requestReview(target, request) {
    await sleep(900);
    if (isCodeRabbit(request) && request.command === 'review') requestedAt = elapsed();
    return `${target.url}#issuecomment-${1234567890 + target.number}`;
  },
  async openInBrowser() {},
  async mergePullRequest(target) {
    await sleep(900);
    mergedByHand.add(target.number);
  },
};

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const background = interactive ? await detectBackground(process.stdin, process.stdout, process.env) : 'unknown';
const app = render(
  <App
    options={{ org: 'acme', authors: ['@me'], watch: true, dryRun: false, interactive, background }}
    gitHub={fakeGitHub}
    timing={{ replyPollMs: 1_500, replyTimeoutMs: 30_000, watchPollMs: 3_000, listRefreshMs: 4_000 }}
  />,
  { alternateScreen: interactive },
);
setTimeout(() => app.unmount(), DEMO_LENGTH_MS);
await app.waitUntilExit();
