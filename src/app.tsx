import { Box, Text, useApp, useInput, useStdin, useStdout, useWindowSize, type DOMElement } from 'ink';
import Spinner from 'ink-spinner';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  actionForKey,
  actionsOf,
  botBarWidth,
  CODERABBIT,
  fillPrompt,
  isAbsent,
  isCodeRabbit,
  moveSelection,
  parentOf,
  refusal,
  requestText,
  reselect,
  type Action,
  type Bot,
  type Mode,
  type Request,
  type ReviewerRef,
} from './actions.js';
import { botReplied, type Comment, type Decision, type QuotaSource } from './decide.js';
import {
  activeBots,
  allBots,
  BOT_FIELDS,
  checkBotField,
  customBotOf,
  isEnabled,
  plannedRetries,
  retriesOn,
  RetryLedger,
  type Retry,
} from './bots.js';
import * as github from './github.js';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import { ICON_WIDTH, layoutFor, LABEL_WIDTH, rowHeight, SELECTION_WIDTH, type Layout } from './layout.js';
import { createMouseParser, DISABLE_MOUSE, ENABLE_MOUSE, isMouseFragment } from './mouse.js';
import {
  confidenceOf,
  type Confidence,
  type Overall,
  type Reviewer,
  type ReviewerStatus,
  type Summary,
} from './reviewers.js';
import { DEFAULT_SETTINGS, parseAuthors, SETTINGS, type SettingKey, type Settings } from './settings.js';
import { parentFinder, placeStacks, type Placement, type StackItem } from './stacks.js';
import { assess, keyOf, MERGE_STATE_WARNINGS, stallOf } from './report.js';
import { planSync, type LeftStatus } from './sync.js';
import { createReplyFilter, GHOST_PALETTES, type Background } from './theme.js';
import { visibleRange } from './viewport.js';
import { LinkIndex, readOwners, sendToSession, type LocalSession, type Owner } from './sessions.js';

export interface Options {
  org: string;
  authors: string[];
  since?: string;
  watch: boolean;
  dryRun: boolean;
  interactive: boolean;
  /** The background of the terminal. It picks the colors of the ghost. */
  background?: Background;
}

interface Row {
  pr: PullRequest;
  /** The CodeRabbit decision, which drives the automatic retries. */
  decision?: Decision;
  summary?: Summary;
  activity?: 'loading' | { posting: Request };
  posted?: { request: Request; url: string };
  error?: string;
  left?: LeftStatus;
  fetched?: Omit<PullRequestSnapshot, 'status'>;
}

export type GitHub = Pick<
  typeof github,
  'listPullRequests' | 'fetchPullRequest' | 'requestReview' | 'openInBrowser' | 'mergePullRequest'
>;

/** The Claude Code sessions of this machine. */
export interface Sessions {
  /** Returns the local session that works on each pull request, by "owner/repo#number". */
  readOwners(): Promise<Map<string, Owner>>;
  send(session: LocalSession, text: string): Promise<void>;
}

function localSessions(): Sessions {
  const index = new LinkIndex();
  return { readOwners: () => readOwners(index), send: (session, text) => sendToSession(session, text) };
}

export interface Timing {
  replyPollMs: number;
  replyTimeoutMs: number;
  watchPollMs: number;
  listRefreshMs: number;
  sessionsPollMs: number;
}

const DEFAULT_TIMING: Timing = {
  replyPollMs: 5_000,
  replyTimeoutMs: 90_000,
  watchPollMs: 30_000,
  listRefreshMs: 60_000,
  sessionsPollMs: 5_000,
};
const REPOST_GUARD_MS = 15 * 60_000;
const BRAND = '#8B5CF6';
// The color of Claude Code in its own terminal theme.
const CLAUDE = '#D77757';
const isReviewRequest = (request: Request) => request.command === 'review' || request.command === 'full review';
const HIDING_SETTING: Record<LeftStatus, SettingKey> = {
  merged: 'hideMerged',
  closed: 'hideClosed',
  draft: 'hideDrafts',
};
/** The height of the header: the crown and the three lines of the head. */
export const HEADER_LINES = 4;
// Lines outside the list in interactive mode: the header, the margin, the scroll hints and the footer.
const CHROME_LINES = HEADER_LINES + 8;

const alone = (key: string): Placement => ({ key, depth: 0, lead: '', trail: ' '.repeat(ICON_WIDTH), size: 1 });

/** Puts the rows in the order of the list. With grouping, each stacked pull request follows the one that it merges into. */
function arrange(rows: Row[], grouped: boolean): { rows: Row[]; places: Map<string, Placement> } {
  const byKey = new Map(rows.map((row) => [keyOf(row.pr), row]));
  const placed = grouped ? placeStacks(rows.map(stackItemOf)) : [...byKey.keys()].map(alone);
  return { rows: placed.map(({ key }) => byKey.get(key)!), places: new Map(placed.map((place) => [place.key, place])) };
}

const stackItemOf = (row: Row): StackItem => ({
  key: keyOf(row.pr),
  repo: row.pr.repo,
  branch: row.fetched?.branch,
  fork: row.fetched?.fork,
  base: row.fetched?.base,
  defaultBranch: row.fetched?.defaultBranch,
  left: Boolean(row.left),
});

/** Returns the listed pull request that this one merges into, with the rule of the tree. */
function stackParent(row: Row, rows: Iterable<Row>): Row | undefined {
  const byKey = new Map([...rows].map((other) => [keyOf(other.pr), other]));
  const parent = parentFinder([...byKey.values()].map(stackItemOf))(stackItemOf(row));
  return parent && byKey.get(parent.key);
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isHidden = (row: Row, settings: Settings, revealed: boolean) =>
  Boolean(row.left) && !revealed && settings[HIDING_SETTING[row.left!]];

// A review or a check in progress changes soon. The watch reads such a row at each poll, even during a CodeRabbit quota wait.
const inProgress = (row: Row) =>
  Boolean(row.summary?.checks.pending) ||
  Boolean(row.summary?.reviewers.some((reviewer) => reviewer.status === 'reviewing'));

/** `autoPost`: the tool can post a CodeRabbit retry. */
function needsWatch(row: Row, autoPost: boolean): boolean {
  if (row.left) return false;
  if (row.error || inProgress(row)) return true;
  switch (row.decision?.kind) {
    case 'busy':
    case 'pending':
    case 'wait':
      return true;
    case 'trigger':
      return autoPost;
    default:
      return false;
  }
}

function absoluteRect(node: DOMElement) {
  let x = 0;
  let y = 0;
  for (let current: DOMElement | undefined = node; current?.yogaNode; current = current.parentNode) {
    x += current.yogaNode.getComputedLeft();
    y += current.yogaNode.getComputedTop();
  }
  return { x, y, width: node.yogaNode?.getComputedWidth() ?? 0, height: node.yogaNode?.getComputedHeight() ?? 0 };
}

function hitTest(nodes: Map<string, DOMElement>, x: number, y: number): string | undefined {
  for (const [id, node] of nodes) {
    const rect = absoluteRect(node);
    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) return id;
  }
  return undefined;
}

interface Confirmation {
  key: string;
  action: Action;
  warning?: string;
  /** The head commit that the warnings describe. A merge fails if the head changes after it. */
  head?: string;
  /** The session that gets the message of an agent command, and the message. */
  session?: LocalSession;
  prompt?: string;
}

interface PostControls {
  post(pr: PullRequest, request: Request): Promise<void>;
  refresh(pr: PullRequest): Promise<unknown>;
  /** Stops the wait of the watch loop, and reads the list and every pull request again. */
  refreshAll(): void;
}

interface AppProps {
  options: Options;
  gitHub?: GitHub;
  sessions?: Sessions;
  timing?: Timing;
  settings?: Settings;
  /** Stores the settings after a change in the settings panel. */
  saveSettings?: (settings: Settings) => Promise<void>;
}

export function App(props: AppProps) {
  // The workflow posts comments. If a new prop restarts it, it posts again and loses its repost guard.
  // Thus the component keeps the props of its first render.
  const [{ options, gitHub, sessions, timing, saveSettings }] = useState(() => ({
    options: props.options,
    gitHub: props.gitHub ?? github,
    sessions: props.sessions ?? localSessions(),
    timing: props.timing ?? DEFAULT_TIMING,
    saveSettings: props.saveSettings,
  }));
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const { rows: screenRows, columns } = useWindowSize();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [fatal, setFatal] = useState<string>();
  const [done, setDone] = useState(false);
  const [triggered, setTriggered] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [nextCheckAt, setNextCheckAt] = useState<Date>();
  const [listError, setListError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [flash, setFlash] = useState<{ text: string; color: string }>();
  const [settings, setSettings] = useState<Settings>(() => props.settings ?? DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  // h shows the rows that the settings hide, until the next h.
  const [revealed, setRevealed] = useState(false);
  const revealedRef = useRef(false);
  const [mode, setMode] = useState<Mode>('main');
  const modeRef = useRef<Mode>('main');
  // The line of the settings panel under the cursor. Undefined: the panel is closed.
  const [panel, setPanel] = useState<number>();
  const panelRef = useRef<number>(undefined);
  // The list of authors that the search uses. --author sets it for the start, the settings panel changes it.
  const [authors, setAuthors] = useState(options.authors);
  const authorsRef = useRef(authors);
  // The text of the authors line while the user changes it. Undefined: no change in progress.
  const [authorsDraft, setAuthorsDraft] = useState<string>();
  const authorsDraftRef = useRef<string>(undefined);
  const checkingAuthors = useRef(false);
  // The form that adds a review bot: the fields typed so far, and the text of the current field.
  const [botDraft, setBotDraft] = useState<BotDraft>();
  const botDraftRef = useRef<BotDraft>(undefined);
  // The retries of the other bots. It outlives a new list of authors.
  const retried = useRef(new RetryLedger());
  // These two outlive a new list of authors, which starts the workflow again: the repost guard and the
  // queue of the CodeRabbit posts must still hold for a post that the earlier workflow sent.
  const lastPosts = useRef(new Map<string, { at: number; before: Comment[] }>());
  const postLock = useRef<Promise<void>>(Promise.resolve());
  const pendingEscape = useRef<NodeJS.Timeout>(undefined);
  const isLateReply = useRef(createReplyFilter());
  const merging = useRef(new Set<string>());
  const selectedRef = useRef<string>(undefined);
  const confirmationRef = useRef<Confirmation>(undefined);
  const rowsRef = useRef(new Map<string, Row>());
  const controls = useRef<PostControls>(null);
  const rowNodes = useRef(new Map<string, DOMElement>());
  const buttonNodes = useRef(new Map<string, DOMElement>());
  const scrollStart = useRef(0);
  const [owners, setOwners] = useState<Map<string, Owner>>(() => new Map());
  // The rows that show their details: the agent, the reviewers, the checks that fail.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const unfoldedRef = useRef(unfolded);
  const ownersRef = useRef(owners);

  const coderabbitRetries = () =>
    isEnabled(settingsRef.current, CODERABBIT) && retriesOn(settingsRef.current, CODERABBIT);
  // A row whose last fetch failed shows old data, so it gets no retry until a fetch works.
  const retriesOf = (row: Row): Retry[] =>
    !row.summary || row.left || row.error || options.dryRun
      ? []
      : retried.current.pending(
          keyOf(row.pr),
          plannedRetries(row.summary.reviewers, activeBots(settingsRef.current), settingsRef.current),
        );

  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    let refreshAsked = false;
    let wake = new AbortController();

    // A stopped workflow can still end a fetch or a post. Its result must not reach the rows of the next one.
    const update = (pr: PullRequest, patch: Partial<Row>) => {
      const key = keyOf(pr);
      const row = rowsRef.current.get(key);
      if (!row || signal.aborted) return;
      rowsRef.current.set(key, { ...row, ...patch });
      setRows([...rowsRef.current.values()]);
    };
    const rowOf = (pr: PullRequest) => rowsRef.current.get(keyOf(pr))!;

    // The CodeRabbit quota belongs to the developer. Posts go one at a time. Each post waits until
    // reply polling finishes or times out. A new rate limit blocks the developer's other pull requests too.
    function exclusive(task: () => Promise<void>): Promise<void> {
      const run = postLock.current.then(() => {
        signal.throwIfAborted();
        return task();
      });
      postLock.current = run.catch(() => {});
      return run;
    }

    // A new fetch on one row can change the CodeRabbit decision of the others, with no API call (see assess).
    function redecide() {
      const fetched = new Map(
        [...rowsRef.current].flatMap(([key, row]) =>
          row.fetched ? [[key, { repo: row.pr.repo, fetched: row.fetched, left: Boolean(row.left) }] as const] : [],
        ),
      );
      for (const [key, result] of assess(fetched, new Date()))
        rowsRef.current.set(key, { ...rowsRef.current.get(key)!, ...result });
      setRows([...rowsRef.current.values()]);
    }

    async function refresh(pr: PullRequest): Promise<Decision | undefined> {
      update(pr, { activity: 'loading' });
      try {
        const { status, ...state } = await gitHub.fetchPullRequest(pr);
        if (status !== 'open') {
          update(pr, { left: status, activity: undefined, error: undefined });
          return undefined;
        }
        update(pr, { fetched: state, left: undefined, activity: undefined, error: undefined });
        redecide();
        return rowsRef.current.get(keyOf(pr))?.decision;
      } catch (error) {
        update(pr, { activity: undefined, error: message(error) });
        return undefined;
      }
    }

    async function waitForReply(pr: PullRequest): Promise<Decision | undefined> {
      const deadline = Date.now() + timing.replyTimeoutMs;
      let decision: Decision | undefined;
      do {
        await sleep(Math.min(timing.replyPollMs, Math.max(0, deadline - Date.now())), undefined, { signal });
        decision = await refresh(pr);
      } while (decision?.kind === 'pending' && Date.now() < deadline);
      return decision;
    }

    async function send(pr: PullRequest, request: Request): Promise<boolean> {
      const commentsBefore = rowOf(pr).fetched?.comments ?? [];
      update(pr, { activity: { posting: request } });
      try {
        const url = await gitHub.requestReview(pr, request);
        if (isCodeRabbit(request) && isReviewRequest(request))
          lastPosts.current.set(keyOf(pr), { at: Date.now(), before: commentsBefore });
        update(pr, { activity: undefined, posted: { request, url } });
        return true;
      } catch (error) {
        update(pr, { activity: undefined, error: message(error) });
        return false;
      }
    }

    async function post(pr: PullRequest, request: Request): Promise<boolean> {
      if (!(await send(pr, request))) return false;
      // The reply of CodeRabbit lands in the comments. The next redecide() applies it to every row.
      await waitForReply(pr);
      return true;
    }

    async function postOnce(pr: PullRequest, request: Request) {
      // The post can wait in the queue for minutes. The pull request can close in that time.
      if (rowOf(pr).left) {
        setFlash({ text: `Cannot post on ${keyOf(pr)}: this pull request is no longer open.`, color: 'yellow' });
        return;
      }
      // Only CodeRabbit shares the quota clock of the queue. Another bot does not wait for a CodeRabbit retry.
      const sent = isCodeRabbit(request) ? await post(pr, request) : await send(pr, request);
      if (sent && !isCodeRabbit(request)) void refresh(pr);
      setFlash(
        sent
          ? { text: `Sent "${requestText(request)}" on ${keyOf(pr)}.`, color: 'green' }
          : { text: `Could not send "${requestText(request)}" on ${keyOf(pr)}.`, color: 'red' },
      );
    }

    controls.current = {
      refresh,
      refreshAll: () => {
        refreshAsked = true;
        wake.abort();
      },
      post: (pr, request) =>
        (isCodeRabbit(request) ? exclusive(() => postOnce(pr, request)) : postOnce(pr, request)).catch((error) => {
          if (!signal.aborted) setFlash({ text: `Could not post on ${keyOf(pr)}: ${message(error)}`, color: 'red' });
        }),
    };

    // A request of this session with no reply from CodeRabbit yet blocks a new one on the same pull request.
    // A reply, such as a refusal, ends the block: a later signal can then free the quota again.
    function unanswered(row: Row, last: { at: number; before: Comment[] } | undefined): boolean {
      if (!last || Date.now() - last.at >= REPOST_GUARD_MS) return false;
      return !botReplied(last.before, row.fetched?.comments ?? []);
    }

    async function triggerReady(prs: PullRequest[]) {
      if (options.dryRun || !coderabbitRetries()) return;
      for (const pr of prs) {
        await exclusive(async () => {
          const row = rowOf(pr);
          // A row whose last fetch failed shows old data: its head and its status are not checked.
          if (row.left || row.error || row.decision?.kind !== 'trigger') return;
          if (unanswered(row, lastPosts.current.get(keyOf(pr)))) return;
          if (await post(pr, { bot: CODERABBIT, command: 'review' })) setTriggered((count) => count + 1);
        });
      }
    }

    // The other bots do not share the CodeRabbit quota, so their retries skip its queue.
    async function retryOthers(prs: PullRequest[]) {
      await Promise.all(
        prs.map(async (pr) => {
          for (const retry of retriesOf(rowOf(pr)).filter(({ at }) => at.getTime() <= Date.now())) {
            retried.current.start(keyOf(pr), retry);
            if (await send(pr, { bot: retry.bot, command: retry.bot.commands[0]!.command })) {
              setTriggered((count) => count + 1);
              void refresh(pr);
            } else {
              const next = retried.current.fail(keyOf(pr), retry);
              // The next fetch clears the error of the row, so the flash keeps the failure visible.
              if (!signal.aborted)
                setFlash({
                  text: `Could not retry ${retry.bot.name} on ${keyOf(pr)}: ${rowOf(pr).error ?? 'unknown error'}. Next try at ${formatTime(next)}.`,
                  color: 'red',
                });
            }
          }
        }),
      );
    }

    // A retry of another bot needs no new fetch: the loop only wakes up at its time.
    function nextDelay(watched: PullRequest[]): number {
      const waits = watched
        .map((pr) => rowOf(pr).decision)
        .filter((decision) => decision?.kind === 'wait')
        .map((decision) => decision.availableAt.getTime());
      const retries = tracked().flatMap((pr) => retriesOf(rowOf(pr)).map(({ at }) => at.getTime()));
      const ends = [...waits, ...retries].map((end) => end + 2_000 - Date.now());
      return Math.max(1_000, Math.min(timing.watchPollMs, ...ends));
    }

    const tracked = () => [...rowsRef.current.values()].map((row) => row.pr);

    async function syncList() {
      const listed = new Map((await gitHub.listPullRequests({ ...options, authors })).map((pr) => [keyOf(pr), pr]));
      signal.throwIfAborted();
      const plan = planSync(
        [...rowsRef.current].map(([key, row]) => ({ key, left: row.left })),
        [...listed.keys()],
      );
      const added = plan.added.map((key) => listed.get(key)!);
      for (const pr of added) rowsRef.current.set(keyOf(pr), { pr, activity: 'loading' });
      setRows([...rowsRef.current.values()]);
      selectedRef.current ??= [...rowsRef.current.keys()][0];
      setSelected(selectedRef.current);
      await Promise.all([...added, ...plan.recheck.map((key) => rowsRef.current.get(key)!.pr)].map(refresh));
    }

    async function run() {
      await syncList();
      await triggerReady(tracked());
      await retryOthers(tracked());
      if (!options.watch) return;

      let listedAt = Date.now();
      while (true) {
        const autoPost = !options.dryRun && coderabbitRetries();
        const watched = tracked().filter((pr) => needsWatch(rowOf(pr), autoPost));
        const delay = nextDelay(watched);
        setNextCheckAt(new Date(Date.now() + delay));
        await sleep(delay, undefined, { signal: AbortSignal.any([signal, wake.signal]) }).catch((error) => {
          if (signal.aborted) throw error;
        });
        wake = new AbortController();
        setNextCheckAt(undefined);

        if (refreshAsked || Date.now() - listedAt >= timing.listRefreshMs) {
          refreshAsked = false;
          listedAt = Date.now();
          try {
            await syncList();
            setListError(undefined);
          } catch (error) {
            setListError(message(error));
          }
          // A settled or waiting row can change by itself: a first review starts or ends, a push lands,
          // or someone approves a pull request that waits for the quota. The loop below refreshes the others.
          const quiet = tracked().filter((pr) => {
            const row = rowOf(pr);
            return !row.left && !inProgress(row) && (!needsWatch(row, autoPost) || row.decision?.kind === 'wait');
          });
          await Promise.all(quiet.map(refresh));
        }

        const due = watched.filter((pr) => {
          const row = rowOf(pr);
          if (row.left) return false;
          return inProgress(row) || row.decision?.kind !== 'wait' || row.decision.availableAt.getTime() <= Date.now();
        });
        await Promise.all(due.map(refresh));
        await triggerReady(tracked());
        await retryOthers(tracked());
      }
    }

    run()
      .then(() => setDone(true))
      .catch((error) => {
        if (signal.aborted) return;
        setFatal(message(error));
        setDone(true);
      });
    return () => abort.abort();
  }, [authors]);

  useEffect(() => {
    let stopped = false;
    let reading = false;
    const read = async () => {
      // A read of a large transcript can outlast the poll interval. Two reads must not share an index.
      if (reading) return;
      reading = true;
      try {
        const next = await sessions.readOwners();
        if (stopped) return;
        ownersRef.current = next;
        setOwners(next);
      } catch {
        // The session records are internal to Claude Code. If they are unreadable, the rows show no session.
        if (stopped) return;
        ownersRef.current = new Map();
        setOwners(ownersRef.current);
      } finally {
        reading = false;
      }
    };
    void read();
    if (!options.watch) return () => void (stopped = true);
    const timer = setInterval(read, timing.sessionsPollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!options.watch) return;
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (done) exit(fatal ? new Error(fatal) : undefined);
  }, [done]);

  const allKeys = rows?.map((row) => keyOf(row.pr)) ?? [];
  const { rows: shownRows, places } = arrange(
    (rows ?? []).filter((row) => !isHidden(row, settings, revealed)),
    settings.stacks,
  );
  const keys = shownRows.map((row) => keyOf(row.pr));
  const selection = reselect(allKeys, keys, selected);
  const hiddenCount = allKeys.length - keys.length;

  // Several keys can arrive in one input chunk and run with the closure of one render.
  // The handlers below read and write these refs, so each key sees what the previous key did.
  function live() {
    const all = [...rowsRef.current.values()];
    const everyKey = all.map((row) => keyOf(row.pr));
    const shown = all.filter((row) => !isHidden(row, settingsRef.current, revealedRef.current));
    const shownKeys = arrange(shown, settingsRef.current.stacks).rows.map((row) => keyOf(row.pr));
    return { shownKeys, key: reselect(everyKey, shownKeys, selectedRef.current) };
  }

  function select(key: string | undefined) {
    selectedRef.current = key;
    setSelected(key);
  }

  function confirm(next: Confirmation | undefined) {
    confirmationRef.current = next;
    setConfirmation(next);
  }

  // Hiding a row, by h or by a refresh that closes it, moves the selection. Keep the move after the rows show again.
  useEffect(() => {
    const { key } = live();
    if (key !== selectedRef.current) select(key);
  }, [rows, settings, revealed]);

  function toggleHidden() {
    const reveal = !revealedRef.current;
    const hideable = [...rowsRef.current.values()].filter((row) => isHidden(row, settingsRef.current, false)).length;
    revealedRef.current = reveal;
    setRevealed(reveal);
    select(live().key);
    setFlash(
      reveal
        ? { text: 'Showing all the pull requests.', color: 'gray' }
        : {
            text: `Hiding ${hideable} merged, closed or draft pull request${hideable === 1 ? '' : 's'}.`,
            color: 'gray',
          },
    );
  }

  function switchMode(next: Mode) {
    modeRef.current = next;
    setMode(next);
  }

  function openPanel(line: number | undefined) {
    panelRef.current = line;
    setPanel(line);
  }

  function store(next: Settings) {
    settingsRef.current = next;
    setSettings(next);
    // The menu of a bot that the change turns off or deletes closes. Another menu takes the new version of its bot.
    const mode = modeRef.current;
    if (typeof mode !== 'string') {
      const bot = activeBots(next).find((candidate) => candidate.id === mode.id);
      switchMode(bot ?? 'bots');
    }
    saveSettings?.(next).catch((error) =>
      setFlash({ text: `Could not save the settings: ${message(error)}`, color: 'red' }),
    );
  }

  function toggleSetting(key: SettingKey) {
    store({ ...settingsRef.current, [key]: !settingsRef.current[key] });
    select(live().key);
  }

  function draftAuthors(text: string | undefined) {
    authorsDraftRef.current = text;
    setAuthorsDraft(text);
  }

  async function saveAuthors(text: string) {
    const next = parseAuthors(text.split(','));
    if (!next) return setFlash({ text: 'The list needs one author or more.', color: 'yellow' });
    const live = next.join() === authorsRef.current.join();
    if (!live) {
      // A search with an unknown author fails. A saved list that fails stops each later start.
      checkingAuthors.current = true;
      setFlash({ text: 'Checking the authors…', color: 'blue' });
      try {
        await gitHub.listPullRequests({ ...options, authors: next });
      } catch (error) {
        return setFlash({ text: `Could not list these authors: ${message(error).split('\n')[0]}`, color: 'red' });
      } finally {
        checkingAuthors.current = false;
      }
      setFlash({ text: `Listing the pull requests of ${next.join(', ')}.`, color: 'green' });
    }
    draftAuthors(undefined);
    store({ ...settingsRef.current, authors: next });
    if (live) return;
    // The pull requests of the earlier authors leave the list: the workflow starts again with an empty one.
    rowsRef.current.clear();
    setRows(null);
    setListError(undefined);
    select(undefined);
    authorsRef.current = next;
    setAuthors(next);
  }

  const typing = () => authorsDraftRef.current !== undefined || botDraftRef.current !== undefined;

  function draftBot(next: BotDraft | undefined) {
    botDraftRef.current = next;
    setBotDraft(next);
  }

  function typeBotKey(char: string) {
    const draft = botDraftRef.current!;
    if (char === '\u001B') {
      draftBot(undefined);
      return setFlash({ text: 'Cancelled.', color: 'gray' });
    }
    if (char === BACKSPACE) return draftBot({ ...draft, text: draft.text.slice(0, -1) });
    if (char !== '\r') return char >= ' ' ? draftBot({ ...draft, text: draft.text + char }) : undefined;
    const error = checkBotField(draft.values.length, draft.text, allBots(settingsRef.current));
    if (error) return setFlash({ text: error, color: 'yellow' });
    const values = [...draft.values, draft.text];
    // A review request has no command text, so the form skips the commands.
    const request = values[3]?.trim();
    const complete =
      values.length === BOT_FIELDS.length || (values.length === 4 && !request!.startsWith('@') && request !== '/');
    if (!complete) {
      setFlash(undefined);
      return draftBot({ values, text: '' });
    }
    const bot = customBotOf(values);
    draftBot(undefined);
    store({ ...settingsRef.current, customBots: [...settingsRef.current.customBots, bot] });
    setFlash({ text: `Added ${bot.name}: → then ${bot.key} opens its menu.`, color: 'green' });
  }

  function switchBot(bot: Bot, change: 'enabled' | 'autoRetry') {
    const current = settingsRef.current;
    const value = change === 'enabled' ? isEnabled(current, bot) : retriesOn(current, bot);
    store({ ...current, bots: { ...current.bots, [bot.id]: { ...current.bots[bot.id], [change]: !value } } });
  }

  function deleteBot(bot: Bot) {
    if (!bot.custom) return setFlash({ text: `${bot.name} is a known bot: space turns it off.`, color: 'yellow' });
    const current = settingsRef.current;
    const { [bot.id]: _removed, ...bots } = current.bots;
    store({
      ...current,
      bots,
      customBots: current.customBots.filter((custom) => custom.name !== bot.name),
    });
    openPanel(Math.min(panelRef.current ?? 0, lastPanelLine(settingsRef.current)));
    setFlash({ text: `Deleted ${bot.name}.`, color: 'gray' });
  }

  function typeAuthorsKey(char: string) {
    if (checkingAuthors.current) return;
    const draft = authorsDraftRef.current ?? '';
    if (char === '\r') void saveAuthors(draft);
    else if (char === '\u001B') draftAuthors(undefined);
    else if (char === BACKSPACE) draftAuthors(draft.slice(0, -1));
    else if (char >= ' ') draftAuthors(draft + char);
  }

  function typePanelKey(char: string) {
    if (authorsDraftRef.current !== undefined) return typeAuthorsKey(char);
    if (botDraftRef.current !== undefined) return typeBotKey(char);
    const line = panelRef.current ?? 0;
    const bot = allBots(settingsRef.current)[line - FIRST_BOT_LINE];
    const change = char === ' ' || char === '\r';
    if (char === 'k') openPanel(Math.max(0, line - 1));
    else if (char === 'j') openPanel(Math.min(lastPanelLine(settingsRef.current), line + 1));
    else if (change && line === AUTHORS_LINE) draftAuthors(settingsRef.current.authors.join(', '));
    else if (change && line === lastPanelLine(settingsRef.current)) draftBot({ values: [], text: '' });
    else if (bot && change) switchBot(bot, 'enabled');
    else if (bot && char === 'a') switchBot(bot, 'autoRetry');
    else if (bot && char === 'd') deleteBot(bot);
    else if (change) toggleSetting(SETTINGS[line]!.key);
    else if (char === ',' || char === 'q' || char === '\u001B') openPanel(undefined);
  }

  // An arrow or the mouse wheel moves the selection. In the authors line, it must not type a letter.
  function step(direction: 'k' | 'j') {
    if (confirmationRef.current || typing()) return;
    typeKey(direction);
  }

  function mergeWarning(row: Row): string | undefined {
    const warnings: string[] = [];
    const reviewers = row.summary?.reviewers ?? [];
    const requesting = reviewers
      .filter((reviewer) => reviewer.verdict === 'changes requested')
      .map((reviewer) => reviewer.name);
    if (requesting.length > 0)
      warnings.push(`${requesting.join(', ')} ${requesting.length === 1 ? 'requests' : 'request'} changes`);
    else if (!reviewers.some((reviewer) => reviewer.verdict === 'approved')) warnings.push('no reviewer approves');
    const failed = row.summary?.checks.failed ?? [];
    if (failed.length > 0) warnings.push(`${failed.length} failing check${failed.length === 1 ? '' : 's'}`);
    if (row.summary?.checks.pending)
      warnings.push(`${row.summary.checks.pending} running check${row.summary.checks.pending === 1 ? '' : 's'}`);
    const state = MERGE_STATE_WARNINGS[row.fetched?.mergeState ?? 'unknown'];
    if (state) warnings.push(state);
    const base = row.fetched?.base;
    if (base && base !== row.fetched?.defaultBranch) {
      const parent = stackParent(row, rowsRef.current.values());
      warnings.push(
        parent && !parent.left
          ? `stacked on ${keyOf(parent.pr)}, which is still open: the merge lands in ${base}`
          : `the merge lands in ${base}, not in ${row.fetched!.defaultBranch}`,
      );
    }
    return warnings.length > 0 ? `Warning: ${warnings.join(', ')}.` : undefined;
  }

  function targetOf(row: Row) {
    const reviewers = row.summary?.reviewers;
    return {
      left: row.left !== undefined,
      dryRun: options.dryRun,
      local: ownersRef.current.has(keyOf(row.pr)),
      cloudSession: Boolean(row.fetched?.agent?.cloudSession),
      ...(reviewers && { reviewers }),
    };
  }

  function quotaWarning(row: Row, request: Request): string | undefined {
    if (!isReviewRequest(request)) return undefined;
    if (isCodeRabbit(request)) {
      return row.decision?.kind === 'wait'
        ? `The CodeRabbit quota comes back at ${formatTime(row.decision.availableAt)}: CodeRabbit will likely refuse.`
        : undefined;
    }
    const reviewer = row.summary?.reviewers.find((candidate) => request.bot.logins.includes(candidate.login));
    if (reviewer?.status !== 'quota') return undefined;
    const back = reviewer.until ? `comes back at ${formatTime(reviewer.until)}` : 'has no known return time';
    return `The ${request.bot.name} quota ${back}: ${request.bot.name} will likely refuse.`;
  }

  function request(action: Action, key = live().key) {
    const row = key ? rowsRef.current.get(key) : undefined;
    if (!row || !key) return;
    const refused = refusal(action, targetOf(row));
    if (refused) {
      setFlash({ text: `Cannot ${action.label} ${key}: ${refused}.`, color: 'yellow' });
      return;
    }
    if (action.merge) {
      const head = row.fetched?.head;
      if (!head) {
        setFlash({ text: `Cannot merge ${key}: its state is not fetched yet.`, color: 'yellow' });
        return;
      }
      if (merging.current.has(key)) {
        setFlash({ text: `${key} is already merging.`, color: 'yellow' });
        return;
      }
      setFlash(undefined);
      confirm({ key, action, warning: mergeWarning(row), head });
      return;
    }
    if (action.openSession) {
      const url = row.fetched!.agent!.cloudSession!;
      gitHub.openInBrowser(url).then(
        () => setFlash({ text: `Opened the cloud session of ${key} in the browser.`, color: 'green' }),
        (error) => setFlash({ text: `Could not open the cloud session of ${key}: ${message(error)}`, color: 'red' }),
      );
      return;
    }
    if (action.agent) {
      const session = ownersRef.current.get(key)!.session;
      if (!row.fetched) {
        setFlash({ text: `Cannot ${action.label} ${key}: its state is not fetched yet.`, color: 'yellow' });
        return;
      }
      const prompt = fillPrompt(settingsRef.current.agentPrompts[action.agent.label] ?? action.agent.prompt, {
        url: row.pr.url,
        branch: row.fetched.branch,
        base: row.fetched.base,
      });
      setFlash(undefined);
      const warning = sessionWarning(session);
      confirm({ key, action, session, prompt, ...(warning && { warning }) });
      return;
    }
    if (!action.request) {
      gitHub.openInBrowser(row.pr.url).then(
        () => setFlash({ text: `Opened ${key} in the browser.`, color: 'green' }),
        (error) => setFlash({ text: `Could not open ${key}: ${message(error)}`, color: 'red' }),
      );
      return;
    }
    setFlash(undefined);
    confirm({ key, action, warning: quotaWarning(row, action.request) });
  }

  function answer(yes: boolean) {
    const pending = confirmationRef.current;
    confirm(undefined);
    if (!pending?.action.request && !pending?.action.merge && !pending?.action.agent) return;
    const row = rowsRef.current.get(pending.key);
    if (!yes || !row) {
      setFlash({ text: 'Cancelled.', color: 'gray' });
      return;
    }
    // A list refresh can close the pull request while the prompt waits.
    const refused = refusal(pending.action, targetOf(row));
    if (refused) {
      setFlash({ text: `Cannot ${pending.action.label} ${pending.key}: ${refused}.`, color: 'yellow' });
      return;
    }
    if (pending.action.agent) {
      const { session, prompt, action } = pending;
      if (!session || !prompt) return;
      setFlash({ text: `Sending "${action.label}" to ${session.name}…`, color: 'blue' });
      sessions.send(session, prompt).then(
        () => setFlash({ text: `Sent "${action.label}" to ${session.name} for ${pending.key}.`, color: 'green' }),
        (error) => setFlash({ text: `Could not send to ${session.name}: ${message(error)}`, color: 'red' }),
      );
      return;
    }
    if (pending.action.merge) {
      const head = pending.head;
      if (!head || merging.current.has(pending.key)) return;
      merging.current.add(pending.key);
      setFlash({ text: `Merging ${pending.key}…`, color: 'blue' });
      gitHub
        .mergePullRequest(row.pr, head)
        .then(
          async () => {
            // With a merge queue or auto-merge, gh succeeds but the pull request stays open for a while.
            // A queue can also use another method than the one requested, so the messages name none.
            await controls.current?.refresh(row.pr);
            const after = rowsRef.current.get(pending.key);
            if (after?.left === 'merged') setFlash({ text: `Merged ${pending.key}.`, color: 'green' });
            else if (after?.error) {
              setFlash({
                text: `GitHub accepted the merge of ${pending.key}, but its new status could not be read: ${after.error}`,
                color: 'yellow',
              });
            } else
              setFlash({
                text: `Merge of ${pending.key} requested: GitHub queued it or enabled auto-merge.`,
                color: 'blue',
              });
          },
          (error) => setFlash({ text: `Could not merge ${pending.key}: ${message(error)}`, color: 'red' }),
        )
        .finally(() => merging.current.delete(pending.key));
      return;
    }
    setFlash({ text: `Sending "${requestText(pending.action.request!)}" on ${pending.key}…`, color: 'blue' });
    void controls.current?.post(row.pr, pending.action.request!);
  }

  function press(id: string) {
    if (id === 'yes' || id === 'no') return answer(id === 'yes');
    if (confirmationRef.current) return;
    if (id === 'setting:authors') {
      if (botDraftRef.current !== undefined) return;
      openPanel(AUTHORS_LINE);
      if (authorsDraftRef.current === undefined) draftAuthors(settingsRef.current.authors.join(', '));
      return;
    }
    if (id === 'bot:add') {
      if (typing()) return;
      openPanel(lastPanelLine(settingsRef.current));
      return draftBot({ values: [], text: '' });
    }
    if (id.startsWith('bot:') || id.startsWith('retry:')) {
      if (typing()) return;
      const bots = allBots(settingsRef.current);
      const bot = bots.find((candidate) => id === `bot:${candidate.id}` || id === `retry:${candidate.id}`);
      if (!bot) return;
      openPanel(FIRST_BOT_LINE + bots.indexOf(bot));
      return switchBot(bot, id.startsWith('bot:') ? 'enabled' : 'autoRetry');
    }
    if (id.startsWith('setting:')) {
      if (typing()) return;
      const key = id.slice('setting:'.length) as SettingKey;
      openPanel(SETTINGS.findIndex((setting) => setting.key === key));
      return toggleSetting(key);
    }
    if (panelRef.current !== undefined) return;
    if (id === 'h') return toggleHidden();
    if (id === 'unfold' || (id === 'e' && modeRef.current === 'main')) return unfold();
    if (id === 'r' && modeRef.current === 'main') return refreshAll();
    if (id === ',') return openPanel(0);
    if (id === 'bots' || (id === 'b' && modeRef.current === 'main')) return switchMode('bots');
    if (id === 'agent' || (id === 'a' && modeRef.current === 'main')) return switchMode('agent');
    if (id === 'back') return switchMode(parentOf(modeRef.current));
    const bot =
      modeRef.current === 'bots'
        ? activeBots(settingsRef.current).find((candidate) => candidate.key === id)
        : undefined;
    if (bot) return switchMode(bot);
    const action = actionForKey(id, modeRef.current);
    if (action) request(action);
  }

  /** Shows or hides the details of a row. Without a value, the row switches. */
  function unfold(key = live().key, value?: boolean) {
    if (!key) return;
    const next = new Set(unfoldedRef.current);
    if (value ?? !next.has(key)) next.add(key);
    else next.delete(key);
    unfoldedRef.current = next;
    setUnfolded(next);
  }

  function refreshAll() {
    if (!options.watch) return;
    setFlash({ text: 'Refreshing the list…', color: 'blue' });
    controls.current?.refreshAll();
  }

  function move(step: number) {
    const { shownKeys, key } = live();
    select(moveSelection(shownKeys, key, step));
  }

  function typeKey(char: string) {
    if (confirmationRef.current) {
      if (char === 'y' || char === '\r') answer(true);
      else if (char === 'n' || char === '\u001B') answer(false);
      return;
    }
    if (panelRef.current !== undefined) return typePanelKey(char);
    if (char === 'k') move(-1);
    else if (char === 'j') move(1);
    else if (char === '\r') press('o');
    else if (char === 'q') exit();
    else if (char === ' ') switchMode(modeRef.current === 'main' ? 'bots' : parentOf(modeRef.current));
    else if (char === '\u001B') switchMode('main');
    else press(char);
  }

  useInput(
    (input, key) => {
      if (isMouseFragment(input) || isLateReply.current(input)) return;
      // The raw stdin listener handles a lone "m": only the mouse parser knows if it ends a split report.
      if (input === 'm') return;
      if (key.upArrow) return step('k');
      if (key.downArrow) return step('j');
      if (typing()) {
        if (key.backspace || key.delete) return typeKey(BACKSPACE);
        if (key.ctrl || key.meta || key.tab) return;
      }
      // → shows the details of the selected row. ← hides them, or goes back one level in a menu.
      const free = !confirmationRef.current && panelRef.current === undefined;
      if (key.rightArrow) return free ? unfold(undefined, true) : undefined;
      if (key.leftArrow) {
        if (!free) return undefined;
        return modeRef.current === 'main' ? unfold(undefined, false) : switchMode(parentOf(modeRef.current));
      }
      if (key.return) return typeKey('\r');
      // A terminal can split a mouse report after its Escape byte, and Ink then reports a lone Escape.
      // Wait a moment: if the rest of a mouse report follows, the Escape was part of it.
      if (key.escape) {
        clearTimeout(pendingEscape.current);
        const prompt = confirmationRef.current;
        pendingEscape.current = setTimeout(() => {
          if (!prompt || confirmationRef.current === prompt) typeKey('\u001B');
        }, 60);
        return;
      }
      // A paste must answer at most one prompt, and never a prompt that it opened itself.
      // The rest of the chunk stops when a key opens or closes a prompt.
      for (const char of input) {
        const hadPrompt = confirmationRef.current !== undefined;
        const hadDraft = typing();
        typeKey(char);
        if (hadPrompt !== (confirmationRef.current !== undefined)) break;
        // The rest of a paste that saved the authors must not run as keys of the panel.
        if (hadDraft && !typing()) break;
      }
    },
    { isActive: options.interactive },
  );

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [flash]);

  // A click selects a row. A click on the selected row shows or hides its details.
  function click(key: string) {
    if (confirmationRef.current || panelRef.current !== undefined) return;
    if (key === live().key) unfold(key);
    else select(key);
  }

  const handlers = useRef({ press, move, select, typeKey, step, click });
  handlers.current = { press, move, select, typeKey, step, click };

  useEffect(() => {
    if (!options.interactive) return;
    const disable = () => stdout.write(DISABLE_MOUSE);
    stdout.write(ENABLE_MOUSE);
    process.once('exit', disable);
    const feed = createMouseParser((event) => {
      if (event.kind === 'wheel') return handlers.current.step(event.direction === 'up' ? 'k' : 'j');
      const button = hitTest(buttonNodes.current, event.x, event.y);
      if (button) return handlers.current.press(button);
      const row = hitTest(rowNodes.current, event.x, event.y);
      if (row) handlers.current.click(row);
    });
    const onData = (data: Buffer | string) => {
      const text = data.toString();
      if (text.startsWith('[<')) clearTimeout(pendingEscape.current);
      const endedSplitReport = feed(text);
      if (text === 'm' && !endedSplitReport) handlers.current.typeKey('m');
    };
    stdin.on('data', onData);
    return () => {
      clearTimeout(pendingEscape.current);
      stdin.off('data', onData);
      process.off('exit', disable);
      disable();
    };
  }, []);

  const clock = options.watch ? now : new Date();
  const selectedIndex = selection ? keys.indexOf(selection) : 0;
  const stackNote = (row: Row) => {
    const parent = stackParent(row, rowsRef.current.values());
    return parent && stackDetail(row, parent, describe(parent, { now: clock, options }), options);
  };
  const stallOfRow = (row: Row) => {
    const session = owners.get(keyOf(row.pr))?.session;
    return stallOf({
      overall: row.left || row.error ? undefined : row.summary?.overall,
      headAt: row.fetched?.headAt,
      working: Boolean(session && isWorking(session)),
      afterMinutes: settings.stalledAfterMinutes,
      now: clock,
    }).stalled;
  };
  const views = new Map(
    shownRows.map((row) => [
      row,
      describe(row, {
        now: clock,
        options,
        stack: stackNote(row),
        stalled: stallOfRow(row),
        coderabbitRetry: coderabbitRetries(),
        // Without --watch, the tool stops before a retry that is due later.
        retries: options.watch ? retriesOf(row) : [],
      }),
    ]),
  );
  const bots = activeBots(settings);
  // In a terminal, a row shows its details after Enter. A piped run shows them all.
  const expanded = (row: Row) => !options.interactive || unfolded.has(keyOf(row.pr));
  const layout = layoutFor(columns, settings, options.interactive);
  const lines = new Map(
    shownRows.map((row) => [row, detailLines(row, views.get(row)!, agentOf(row, owners), layout, clock)]),
  );
  const heightOf = (row: Row) =>
    rowHeight({ details: expanded(row) ? lines.get(row)!.length : 0, posted: Boolean(row.posted) }, layout);
  const range = options.interactive
    ? visibleRange(
        shownRows.map(heightOf),
        selectedIndex,
        Math.max(3, screenRows - CHROME_LINES - promptLines(confirmation, columns)),
        scrollStart.current,
      )
    : { start: 0, end: shownRows.length };
  const selectedRow = selection ? rowsRef.current.get(selection) : undefined;
  scrollStart.current = range.start;

  const registerRow = (key: string) => (node: DOMElement | null) => {
    if (node) rowNodes.current.set(key, node);
    else rowNodes.current.delete(key);
  };
  const registerButton = (id: string) => (node: DOMElement | null) => {
    if (node) buttonNodes.current.set(id, node);
    else buttonNodes.current.delete(id);
  };

  return (
    <Box flexDirection="column" paddingX={1} {...(options.interactive && { height: screenRows })}>
      <Header
        options={{ ...options, authors }}
        mood={moodOf({ fatal: Boolean(fatal), done, sleeping: Boolean(nextCheckAt) })}
        now={clock}
        nextCheckAt={nextCheckAt}
      />
      {rows === null && !fatal && (
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>{' '}
          Searching pull requests…
        </Text>
      )}
      {rows?.length === 0 && (
        <Text dimColor>
          No open pull request by {authors.join(' or ')}
          {options.org ? ` in ${options.org}` : ''}
          {options.since ? ` since ${formatDay(options.since)}` : ''}.
        </Text>
      )}
      {panel !== undefined && (
        <SettingsPanel
          settings={settings}
          cursor={panel}
          authorsDraft={authorsDraft}
          botDraft={botDraft}
          registerButton={registerButton}
        />
      )}
      {rows && rows.length > 0 && panel === undefined && (
        <Box flexDirection="column" marginTop={1}>
          {options.interactive && <Text dimColor>{range.start > 0 ? `  ↑ ${range.start} more` : ' '}</Text>}
          {shownRows.length === 0 && (
            <Text dimColor>
              All {rows.length} pull requests are hidden. Press h to show them, or , to change the settings.
            </Text>
          )}
          {shownRows.slice(range.start, range.end).map((row) => (
            <RowView
              key={keyOf(row.pr)}
              ref={registerRow(keyOf(row.pr))}
              row={row}
              view={views.get(row)!}
              options={options}
              layout={layout}
              place={places.get(keyOf(row.pr))!}
              hint={stackHint(row, places.get(keyOf(row.pr))!, rowsRef.current)}
              agent={agentOf(row, owners)}
              stalled={stallOfRow(row)}
              lines={lines.get(row)!}
              expanded={expanded(row)}
              selected={options.interactive && keyOf(row.pr) === selection}
            />
          ))}
          {options.interactive && (
            <Text dimColor>{range.end < shownRows.length ? `  ↓ ${shownRows.length - range.end} more` : ' '}</Text>
          )}
        </Box>
      )}
      {fatal && <Text color="red">✖ {fatal}</Text>}
      {options.interactive && <Box flexGrow={1} />}
      {rows && rows.length > 0 && (
        <Footer rows={rows} triggered={triggered} done={done} listError={listError} options={options} />
      )}
      {options.interactive && (
        <Controls
          confirmation={confirmation}
          flash={flash}
          registerButton={registerButton}
          disabledCommands={options.dryRun}
          revealed={revealed}
          hiddenCount={hiddenCount}
          mode={mode}
          panelOpen={panel !== undefined}
          editing={editingHint(authorsDraft, botDraft)}
          short={layout.shortBar}
          shortBots={layout.shortBar || columns - 2 < botBarWidth(bots)}
          bots={bots}
          reviewers={selectedRow?.summary?.reviewers}
          session={selection ? owners.get(selection)?.session : undefined}
          cloudSession={selectedRow?.fetched?.agent?.cloudSession}
        />
      )}
    </Box>
  );
}

export type Mood = 'checking' | 'sleeping' | 'done' | 'failed';

function moodOf({ fatal, done, sleeping }: { fatal: boolean; done: boolean; sleeping: boolean }): Mood {
  if (fatal) return 'failed';
  if (done) return 'done';
  return sleeping ? 'sleeping' : 'checking';
}

const FACES: Record<Mood, { eyes: [string, string]; mouth: string }> = {
  checking: { eyes: ['ò', 'ó'], mouth: 'v' },
  sleeping: { eyes: ['-', '-'], mouth: 'ᴗ' },
  done: { eyes: ['^', '^'], mouth: 'v' },
  failed: { eyes: ['x', 'x'], mouth: '~' },
};
interface HeaderProps {
  options: Options;
  mood: Mood;
  now: Date;
  nextCheckAt?: Date;
}

export function Ghost({ mood, background = 'unknown' }: { mood: Mood; background?: Background | undefined }) {
  const {
    eyes: [left, right],
    mouth,
  } = FACES[mood];
  const palette = GHOST_PALETTES[background];
  return (
    <Box flexDirection="column" width={10} flexShrink={0}>
      <Text color={palette.crown} bold>
        {'   wWw'}
      </Text>
      <Text color={palette.line}> ╭─────╮</Text>
      <Text color={palette.line}>
        (
        <Text color={palette.face} bold>
          {` ${left} ${mouth} ${right} `}
        </Text>
        )
      </Text>
      <Text color={palette.line}> ╰─────╯</Text>
    </Box>
  );
}

export function Header({ options, mood, now, nextCheckAt }: HeaderProps) {
  const status =
    !options.watch || mood === 'done' || mood === 'failed'
      ? ' '
      : `${nextCheckAt ? `next check in ${formatDuration(nextCheckAt.getTime() - now.getTime(), true)}` : 'checking…'}${options.interactive ? '' : ' · Ctrl+C to quit'}`;
  const scope = [
    options.authors.join(' + '),
    options.org || 'all organizations',
    options.since && `since ${formatDay(options.since)}`,
  ].filter(Boolean);
  return (
    <Box>
      <Ghost mood={mood} background={options.background} />
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="truncate-end">
          <Text color={BRAND} bold>
            boo
          </Text>
          <Text dimColor> · open pull requests</Text>
          {options.watch && <Text color="cyan"> watch</Text>}
          {options.dryRun && <Text color="yellow"> dry run</Text>}
        </Text>
        <Text dimColor wrap="truncate-end">
          {scope.join(' · ')}
        </Text>
        <Text dimColor wrap="truncate-end">
          {status}
        </Text>
      </Box>
    </Box>
  );
}

interface View {
  icon: ReactNode;
  label: string;
  color: string;
  /** The lines of the notes section of an unfolded row. */
  notes?: string[];
}

const spinner = (color: string) => (
  <Text color={color}>
    <Spinner type="dots" />
  </Text>
);

const OVERALL_VIEWS: Record<Overall, Omit<View, 'icon'> & { icon: () => ReactNode }> = {
  ready: { icon: () => <Text color="green">✔</Text>, label: 'ready to merge', color: 'green' },
  approved: { icon: () => <Text color="green">✔</Text>, label: 'approved', color: 'green' },
  'changes requested': { icon: () => <Text color="red">✎</Text>, label: 'changes requested', color: 'red' },
  'checks failing': { icon: () => <Text color="red">✖</Text>, label: 'checks failing', color: 'red' },
  conflicts: { icon: () => <Text color="red">⚠</Text>, label: 'conflicts', color: 'red' },
  reviewing: { icon: () => spinner('cyan'), label: 'reviewing', color: 'cyan' },
  reviewed: { icon: () => <Text color="cyan">●</Text>, label: 'reviewed', color: 'cyan' },
  quota: { icon: () => <Text color="yellow">◷</Text>, label: 'quota', color: 'yellow' },
  'awaiting review': { icon: () => <Text color="gray">○</Text>, label: 'awaiting review', color: 'gray' },
};

const LEFT_VIEWS: Record<LeftStatus, View> = {
  merged: { icon: <Text color="magenta">◆</Text>, label: 'merged', color: 'magenta' },
  closed: { icon: <Text color="red">○</Text>, label: 'closed', color: 'red' },
  draft: {
    icon: <Text color="gray">◌</Text>,
    label: 'draft',
    color: 'gray',
    notes: ['watched again when it is ready for review'],
  },
};

interface DescribeContext {
  now: Date;
  options: Options;
  /** The state of the pull request under this one in its stack. */
  stack?: string | undefined;
  /** The tool posts the CodeRabbit retries by itself. */
  coderabbitRetry?: boolean;
  /** The retries of the other bots that the tool plans. */
  retries?: readonly Retry[];
  /** The pull request needs work, and nobody works on it. */
  stalled?: boolean;
}

function coderabbitDetail(decision: Decision | undefined, { now, options, coderabbitRetry }: DescribeContext) {
  switch (decision?.kind) {
    case 'wait': {
      const remaining = decision.availableAt.getTime() - now.getTime();
      const guess = decision.delayGuessed ? ' · unreadable delay, 1 h assumed' : '';
      const when = remaining > 0 ? `in ${formatDuration(remaining, options.watch)}` : 'now, checking…';
      return `CodeRabbit quota back ${when} (at ${formatTime(decision.availableAt)})${guess}${sourceNote(decision.source, options)}`;
    }
    case 'trigger': {
      const since = formatDuration(now.getTime() - decision.availableAt.getTime(), false);
      return `CodeRabbit quota back for ${since}${sourceNote(decision.source, options)}${retryNote(options, coderabbitRetry)}`;
    }
    case 'pending':
      return `CodeRabbit asked at ${formatTime(decision.requestedAt)}, no reply yet`;
    case 'skipped':
      return `CodeRabbit skipped the review: ${decision.reason}${options.interactive ? ' · r requests one' : ''}`;
    case 'paused':
      return `CodeRabbit reviews are paused${options.interactive ? ' · r reviews it once' : ''}`;
    case 'idle':
      return `CodeRabbit: ${decision.limitLifted ? 'rate limit lifted' : 'no rate limit'}, but the last commit has no review`;
    default:
      return undefined;
  }
}

function retryNote(options: Options, retry: boolean | undefined): string {
  if (options.dryRun) return ' · dry run, nothing posted';
  return retry ? ', retry queued' : ', automatic retry off';
}

/** The notes of a row. The sections of the reviewers and of the checks show the rest. */
function notesOf(row: Row, context: DescribeContext): string[] {
  const headAt = row.fetched?.headAt;
  const parts = [
    context.stalled &&
      headAt &&
      `stalled: no session works on it, and the last commit is ${formatAgo(context.now, new Date(headAt))}`,
    context.stack,
    row.summary && MERGE_STATE_WARNINGS[row.fetched?.mergeState ?? 'unknown'],
    ...(context.retries ?? []).map(({ bot, at }) => `${bot.name} retry at ${formatTime(at)}`),
    row.summary && coderabbitDetail(row.decision, context),
  ];
  return parts.filter((part): part is string => Boolean(part));
}

function describe(row: Row, context: DescribeContext): View {
  const { stack } = context;
  if (typeof row.activity === 'object') {
    const request = row.activity.posting;
    return {
      icon: spinner('blue'),
      label: isCodeRabbit(request) && request.command === 'review' ? 'retrying' : 'posting',
      color: 'blue',
      notes: [`"${requestText(request)}"…`],
    };
  }
  if (row.left) return LEFT_VIEWS[row.left];
  if (row.error) return { icon: <Text color="red">✖</Text>, label: 'error', color: 'red', notes: [row.error] };
  if (!row.summary)
    return { icon: spinner('gray'), label: 'checking', color: 'gray', ...(stack && { notes: [stack] }) };
  const { icon, ...view } = OVERALL_VIEWS[row.summary.overall];
  return { ...view, icon: icon(), notes: notesOf(row, context) };
}

const shortName = (pr: PullRequest, options: Options) =>
  options.org && pr.repo.startsWith(`${options.org}/`) ? pr.repo.slice(options.org.length + 1) : pr.repo;

function stackDetail(row: Row, parent: Row, parentView: View, options: Options): string {
  const name = `${shortName(parent.pr, options)}#${parent.pr.number}`;
  if (parent.left) return `stacked on ${name}, ${parent.left}: the base is still ${row.fetched!.base}`;
  return `stacked on ${name} (${parentView.label}): merge it first`;
}

/** The place of the pull request in its stack, or the base branch if it is not the default branch. */
function stackHint(row: Row, place: Placement, rows: Map<string, Row>): string | undefined {
  if (place.parent) {
    const parent = rows.get(place.parent)!;
    return `on #${parent.pr.number}${place.position ? ` · ${place.position}/${place.size}` : ''}`;
  }
  if (place.size > 1) return `stack of ${place.size}`;
  const fetched = row.fetched;
  return fetched && fetched.base !== fetched.defaultBranch ? `on ${fetched.base}` : undefined;
}

/** The agent of a row: the agent that the pull request names, and the local session that works on it. */
interface AgentInfo {
  name: string;
  claude: boolean;
  session?: LocalSession;
  cloudSession?: string;
}

function agentOf(row: Row, owners: Map<string, Owner>): AgentInfo | undefined {
  const session = owners.get(keyOf(row.pr))?.session;
  const agent = row.fetched?.agent;
  // A local session is always Claude Code, whatever agent wrote the pull request.
  if (session) return { name: 'Claude Code', claude: true, session };
  if (!agent) return undefined;
  return {
    name: agent.name,
    claude: agent.id === 'claude',
    ...(agent.cloudSession && { cloudSession: agent.cloudSession }),
  };
}

// "shell" means that the session runs a command now.
const isWorking = (session: LocalSession) => session.status === 'busy' || session.status === 'shell';

function sessionState(session: LocalSession): string {
  if (isWorking(session)) return 'working';
  if (session.status === 'waiting') return `waiting: ${session.waitingFor ?? 'an answer'}`;
  return session.status;
}

const agentMark = (agent: AgentInfo) => (agent.claude ? '✻' : '◇');

function badgeName(agent: AgentInfo): string {
  if (agent.session) return agent.session.name;
  if (agent.cloudSession) return 'cloud';
  return agent.claude ? 'Claude' : agent.name;
}

/** The agent on the line of the pull request: a mark, and the session name if the row has the width. */
function AgentBadge({ agent, named }: { agent: AgentInfo; named: boolean }) {
  const { session } = agent;
  const color = agent.claude ? CLAUDE : 'gray';
  return (
    <Text color={color} dimColor={!session && !agent.claude}>
      {session && isWorking(session) ? <Spinner type="dots" /> : agentMark(agent)}
      {named && ` ${badgeName(agent)}`}
      {session?.status === 'waiting' && <Text color="yellow"> ?</Text>}
    </Text>
  );
}

/** One line of an unfolded row. The first line of a section carries the name of the section. */
interface DetailLine {
  key: string;
  label?: string;
  content: ReactNode;
}

const SECTION_WIDTH = 11;

function stateColor(session: LocalSession): string | undefined {
  if (isWorking(session)) return CLAUDE;
  return session.status === 'waiting' ? 'yellow' : undefined;
}

function agentLines(agent: AgentInfo): ReactNode[] {
  const color = agent.claude ? CLAUDE : 'gray';
  const name = (
    <Text color={color} bold>
      {agentMark(agent)} {agent.name}
    </Text>
  );
  const { session } = agent;
  if (session)
    return [
      <Text wrap="truncate-end">
        {name}
        <Text dimColor> · session </Text>
        <Text color={CLAUDE}>{session.name}</Text>
        <Text dimColor> · </Text>
        <Text color={stateColor(session)} dimColor={!stateColor(session)}>
          {sessionState(session)}
        </Text>
      </Text>,
      <Text dimColor wrap="truncate-end">
        {session.cwd.replace(homedir(), '~')} · a sends rebase, review, fix or test
      </Text>,
    ];
  if (agent.cloudSession)
    return [
      <Text wrap="truncate-end">
        {name}
        <Text dimColor> · cloud session</Text>
      </Text>,
      <Text dimColor wrap="truncate-end">
        {agent.cloudSession} · a, then w, opens it online
      </Text>,
    ];
  return [
    <Text wrap="truncate-end">
      {name}
      <Text dimColor> · no session on this machine</Text>
    </Text>,
  ];
}

function reviewerState(reviewer: Reviewer): string {
  switch (reviewer.status) {
    case 'reviewing':
      return reviewer.progress ? `reviewing ${reviewer.progress.done}/${reviewer.progress.total}` : 'reviewing';
    case 'quota':
      return reviewer.until ? `out of quota, back at ${formatTime(reviewer.until)}` : 'out of quota, no return time';
    case 'stale':
      return reviewer.verdict && reviewer.verdict !== 'commented'
        ? `an older commit only, ${reviewer.verdict} still stands`
        : 'an older commit only';
    default:
      return reviewer.status;
  }
}

function confidenceColor({ score, total }: Confidence): string {
  if (score / total >= 0.8) return 'green';
  return score / total >= 0.6 ? 'yellow' : 'red';
}

function reviewerLines(summary: Summary, confidence: Map<string, Confidence>, layout: Layout, now: Date): ReactNode[] {
  const header = [
    layout.counts &&
      `${summary.reviewers.length > 0 ? `${summary.onHead}/${summary.reviewers.length} on head · ` : ''}${summary.reviews} review${summary.reviews === 1 ? '' : 's'}`,
    layout.lastReview && lastReviewText(summary, now),
  ].filter(Boolean);
  const lines: ReactNode[] = header.length > 0 ? [<Text dimColor>{header.join(' · ')}</Text>] : [];
  if (!layout.marks) return lines;
  const width = Math.min(24, Math.max(0, ...summary.reviewers.map((reviewer) => reviewer.name.length)));
  for (const reviewer of summary.reviewers) {
    const chip = CHIPS[reviewer.status];
    const score = confidence.get(reviewer.login);
    lines.push(
      <Text wrap="truncate-end">
        <Text color={chip.color}>{chip.icon}</Text> {reviewer.name.padEnd(width)}
        {'  '}
        <Text color={chip.color}>{reviewerState(reviewer)}</Text>
        {score && (
          <>
            <Text dimColor> · confidence </Text>
            <Text color={confidenceColor(score)}>
              {score.score}/{score.total}
            </Text>
          </>
        )}
        {reviewer.lastReviewAt && <Text dimColor> · {formatAgo(now, reviewer.lastReviewAt)}</Text>}
      </Text>,
    );
  }
  return lines;
}

/** The counts of the checks, then one line for each check that fails or that a newer run replaces, with its cause. */
function checkLines(checks: Summary['checks'], base: string | undefined): ReactNode[] {
  const parts: [string, string][] = [];
  if (checks.passed > 0) parts.push([`✔ ${checks.passed} passed`, 'green']);
  if (checks.failed.length > 0) parts.push([`✖ ${checks.failed.length} failing`, 'red']);
  if (checks.pending > 0) parts.push([`◌ ${checks.pending} running`, 'yellow']);
  if (checks.skipped > 0) parts.push([`⊘ ${checks.skipped} skipped`, 'gray']);
  if (checks.quota > 0) parts.push([`◷ ${checks.quota} quota only`, 'gray']);
  if (parts.length === 0 && checks.cancelled.length === 0) return [<Text dimColor>no checks</Text>];
  const counts = parts.length > 0 && (
    <Text wrap="truncate-end">
      {parts.map(([text, color], index) => (
        <Text key={text} color={color} dimColor={color === 'gray'}>
          {index > 0 && '   '}
          {text}
        </Text>
      ))}
    </Text>
  );
  const failing = checks.failed.map((name) => (
    <Text wrap="truncate-end">
      <Text color="red">✖ {name}</Text>
      <Text dimColor>
        {' '}
        · {checks.failedOnBase.includes(name) ? `fails on ${base ?? 'the base branch'} too` : 'fails here only'}
      </Text>
    </Text>
  ));
  const cancelled = checks.cancelled.map((name) => (
    <Text dimColor wrap="truncate-end">
      ⊘ {name} · cancelled by a newer run
    </Text>
  ));
  return [...(counts ? [counts] : []), ...failing, ...cancelled];
}

/** The lines of an unfolded row, by section: the agent, the reviewers, the checks, then the notes. */
function detailLines(row: Row, view: View, agent: AgentInfo | undefined, layout: Layout, now: Date): DetailLine[] {
  const lines: DetailLine[] = [];
  // A blank line separates two sections.
  const section = (label: string, contents: ReactNode[]) => {
    if (contents.length === 0) return;
    if (lines.length > 0) lines.push({ key: `${label}:gap`, content: <Text> </Text> });
    contents.forEach((content, index) =>
      lines.push({ key: `${label}:${index}`, ...(index === 0 && { label }), content }),
    );
  };
  const changes = row.fetched?.changes;
  const headAt = row.fetched?.headAt;
  if (changes)
    section('changes', [
      <Text>
        <Text color="green">+{changes.additions}</Text> <Text color="red">−{changes.deletions}</Text>
        <Text dimColor>
          {' '}
          · {changes.files} file{changes.files === 1 ? '' : 's'}
          {headAt && ` · last commit ${formatAgo(now, new Date(headAt))}`}
        </Text>
      </Text>,
    ]);
  if (layout.agent && agent) section('agent', agentLines(agent));
  if (row.summary && !row.left) {
    const confidence = confidenceOf(row.fetched?.reviews ?? [], row.fetched?.comments ?? []);
    section('reviewers', reviewerLines(row.summary, confidence, layout, now));
    if (layout.checks) section('checks', checkLines(row.summary.checks, row.fetched?.base));
  }
  if (layout.details && view.notes)
    section(
      'notes',
      view.notes.map((note) => (
        <Text dimColor wrap="truncate-end">
          {note}
        </Text>
      )),
    );
  return lines;
}

function sessionWarning(session: LocalSession): string | undefined {
  if (isWorking(session)) return `${session.name} is working: it reads the message after its current turn.`;
  if (session.status === 'waiting')
    return `${session.name} waits for ${session.waitingFor ?? 'an answer'}: it reads the message after that.`;
  return undefined;
}

const CHIPS: Record<ReviewerStatus, { icon: string; color: string }> = {
  approved: { icon: '✔', color: 'green' },
  'changes requested': { icon: '✎', color: 'red' },
  commented: { icon: '●', color: 'cyan' },
  reviewing: { icon: '⟳', color: 'cyan' },
  quota: { icon: '◷', color: 'yellow' },
  'to retry': { icon: '↻', color: 'blue' },
  requested: { icon: '○', color: 'magenta' },
  stale: { icon: '◌', color: 'gray' },
  skipped: { icon: '⊘', color: 'gray' },
  paused: { icon: '‖', color: 'gray' },
};

function ChecksBadge({ summary, short }: { summary: Summary; short: boolean }) {
  const { checks } = summary;
  const counted = checks.passed + checks.failed.length + checks.pending;
  const word = (text: string) => (short ? '' : ` ${text}`);
  if (checks.failed.length > 0)
    return (
      <Text color="red">
        ✖ {checks.failed.length}/{counted}
        {word('failing')}
      </Text>
    );
  if (checks.pending > 0)
    return (
      <Text color="yellow">
        ◌ {checks.pending}/{counted}
        {word('running')}
      </Text>
    );
  if (counted === 0) {
    if (checks.skipped > 0)
      return (
        <Text dimColor>
          ⊘ {checks.skipped}
          {word('skipped')}
        </Text>
      );
    if (checks.quota > 0)
      return (
        <Text dimColor>
          ◷ {checks.quota}
          {word('quota only')}
        </Text>
      );
    return <Text dimColor>{short ? '–' : 'no checks'}</Text>;
  }
  return (
    <Text color="green">
      ✔ {checks.passed}/{counted}
      {word('checks')}
    </Text>
  );
}

/** The lines that the prompt of a confirmation adds under the question. The chrome counts one line already. */
function promptLines(confirmation: Confirmation | undefined, columns: number): number {
  if (!confirmation?.prompt) return 0;
  const lines = Math.ceil(confirmation.prompt.length / Math.max(1, columns - 2));
  return confirmation.warning ? lines : lines - 1;
}

const selectionMark = (unfolded: boolean, selected: boolean) => `${selected ? '❯' : ' '}${unfolded ? '▾' : ' '}`;

interface RowViewProps {
  ref: (node: DOMElement | null) => void;
  row: Row;
  view: View;
  options: Options;
  layout: Layout;
  place: Placement;
  hint: string | undefined;
  agent: AgentInfo | undefined;
  stalled: boolean;
  lines: DetailLine[];
  expanded: boolean;
  selected: boolean;
}

function lastReviewText(summary: Summary, now: Date): string {
  if (summary.lastReview) return `last ${summary.lastReview.name} ${formatAgo(now, summary.lastReview.at)}`;
  return summary.reviewers.length === 0 ? 'no reviewer yet' : 'no review yet';
}

// The lines under a row draw the tree of the stack under the icon, then start at the column of the state name.
function Under({
  before,
  trail,
  rest,
  children,
}: {
  before: number;
  trail: string;
  rest: number;
  children: ReactNode;
}) {
  return (
    <Box>
      <Box width={before} flexShrink={0} />
      <Box flexShrink={0}>
        <Text dimColor>{trail}</Text>
      </Box>
      <Box paddingLeft={rest} flexShrink={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}

function RowView({
  ref,
  row,
  view,
  options,
  layout,
  place,
  hint,
  agent,
  stalled,
  lines,
  expanded,
  selected,
}: RowViewProps) {
  const name = shortName(row.pr, options);
  const before = options.interactive ? SELECTION_WIDTH : 0;
  const rest = layout.indent - before - ICON_WIDTH;
  const under = (children: ReactNode) => (
    <Under before={before} trail={place.trail} rest={rest}>
      {children}
    </Under>
  );
  const gap = `${' '.repeat(before)}${place.trail.trimEnd()}` || ' ';
  const summary = row.summary;
  return (
    <Box ref={ref} flexDirection="column">
      <Box>
        {options.interactive && (
          <Box width={SELECTION_WIDTH} flexShrink={0}>
            <Text color={BRAND} bold dimColor={!selected}>
              {selectionMark(expanded, selected)}
            </Text>
          </Box>
        )}
        {place.lead && (
          <Box flexShrink={0}>
            <Text dimColor>{place.lead}</Text>
          </Box>
        )}
        <Box width={ICON_WIDTH} flexShrink={0}>
          {view.icon}
        </Box>
        {layout.label && (
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text color={view.color} bold>
              {view.label}
            </Text>
          </Box>
        )}
        <Box flexShrink={0} marginRight={2}>
          <Text bold inverse={selected}>
            {name}#{row.pr.number}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{row.pr.title}</Text>
        </Box>
        {layout.stack && hint && (
          <Box flexShrink={0} marginLeft={2}>
            <Text color="magenta" dimColor>
              {hint}
            </Text>
          </Box>
        )}
        {layout.agent && agent && (
          <Box flexShrink={0} marginLeft={2}>
            <AgentBadge agent={agent} named={layout.agentName} />
          </Box>
        )}
        {stalled && (
          <Box flexShrink={0} marginLeft={2}>
            <Text color="yellow">zZ{layout.agentName && ' stalled'}</Text>
          </Box>
        )}
        {summary && !row.left && layout.checks && (
          <Box flexShrink={0} marginLeft={2}>
            <ChecksBadge summary={summary} short={layout.shortChecks} />
          </Box>
        )}
      </Box>
      {expanded &&
        lines.map((line) => (
          <Fragment key={line.key}>
            {under(
              <>
                <Box width={SECTION_WIDTH} flexShrink={0}>
                  <Text dimColor>{line.label ?? ''}</Text>
                </Box>
                <Box flexShrink={1} overflow="hidden">
                  {line.content}
                </Box>
              </>,
            )}
          </Fragment>
        ))}
      {row.posted &&
        under(
          <Text color="green" wrap="truncate-end">
            ↻ {requestText(row.posted.request)} → {row.posted.url}
          </Text>,
        )}
      {Array.from({ length: layout.gap }, (_, line) => (
        <Text key={line} dimColor>
          {gap}
        </Text>
      ))}
    </Box>
  );
}

interface FooterProps {
  rows: Row[];
  triggered: number;
  done: boolean;
  listError?: string;
  options: Options;
}

const FOOTER_ORDER: Overall[] = [
  'ready',
  'approved',
  'changes requested',
  'checks failing',
  'conflicts',
  'reviewing',
  'reviewed',
  'quota',
  'awaiting review',
];

function Footer({ rows, triggered, done, listError, options }: FooterProps) {
  const active = rows.filter((row) => !row.left);
  const countLeft = (status: LeftStatus) => rows.filter((row) => row.left === status).length;
  const waiting = active.filter((row) => row.decision?.kind === 'wait').length;
  const parts: [number, string, string][] = [
    ...FOOTER_ORDER.map((overall): [number, string, string] => [
      active.filter((row) => row.summary?.overall === overall).length,
      OVERALL_VIEWS[overall].label,
      OVERALL_VIEWS[overall].color,
    ]),
    [triggered, 'retried', 'blue'],
    [countLeft('merged'), 'merged', 'magenta'],
    [countLeft('closed'), 'closed', 'red'],
    [countLeft('draft'), 'draft', 'gray'],
  ];
  const shown = parts.filter(([amount]) => amount > 0);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {shown.length === 0
          ? 'Nothing to show.'
          : shown.map(([amount, label, color], index) => (
              <Text key={label}>
                {index > 0 && <Text dimColor> · </Text>}
                <Text color={color} bold>
                  {amount}
                </Text>{' '}
                {label}
              </Text>
            ))}
      </Text>
      {listError && (
        <Text color="red" wrap="truncate-end">
          The list refresh failed: {listError}
        </Text>
      )}
      {!options.watch && done && waiting > 0 && (
        <Text dimColor>
          Tip: <Text color={BRAND}>boo --watch</Text> waits for the CodeRabbit quota and retries by itself.
        </Text>
      )}
    </Box>
  );
}

interface ControlsProps {
  confirmation?: Confirmation;
  flash?: { text: string; color: string };
  registerButton: (id: string) => (node: DOMElement | null) => void;
  disabledCommands: boolean;
  revealed: boolean;
  hiddenCount: number;
  mode: Mode;
  panelOpen: boolean;
  /** The hint of the line that the user types in the settings panel. Undefined: the user types nothing. */
  editing: string | undefined;
  /** Show the keys only, for a narrow terminal. */
  short: boolean;
  shortBots: boolean;
  /** The reviewers of the selected pull request. */
  reviewers?: readonly ReviewerRef[] | undefined;
  /** The bots that the settings turn on. */
  bots: readonly Bot[];
  /** The local session that works on the selected pull request. */
  session?: LocalSession | undefined;
  /** The page of the cloud session of the selected pull request. */
  cloudSession?: string | undefined;
}

interface ButtonProps {
  id: string;
  hotkey: string;
  label: string;
  dim?: boolean | undefined;
  short?: boolean | undefined;
  register: ControlsProps['registerButton'];
}

function Button({ id, hotkey, label, dim, short, register }: ButtonProps) {
  return (
    <Box ref={register(id)} marginRight={short ? 1 : 2} flexShrink={0}>
      {/* The end of bold also ends dim, so the label sets dim on its own. */}
      <Text>
        <Text color={dim ? undefined : BRAND} dimColor={dim} bold>
          {hotkey}
        </Text>
        <Text dimColor={dim}>{short ? '' : ` ${label}`}</Text>
      </Text>
    </Box>
  );
}

function Group({ name }: { name: string }) {
  return (
    <Box marginRight={1} flexShrink={0}>
      <Text dimColor>{name}</Text>
    </Box>
  );
}

function hiddenLabel(revealed: boolean, hiddenCount: number): string {
  if (revealed) return 'hide inactive';
  return hiddenCount > 0 ? `show ${hiddenCount} hidden` : 'nothing hidden';
}

function ActionBar({
  registerButton,
  disabledCommands,
  revealed,
  hiddenCount,
  mode,
  short: shortMain,
  shortBots,
  reviewers,
  bots,
  session,
  cloudSession,
}: ControlsProps) {
  const short = mode === 'main' ? shortMain : shortBots;
  const button = (action: Action, dim?: boolean) => (
    <Button
      key={action.key}
      id={action.key}
      hotkey={action.key}
      label={action.label}
      dim={dim}
      short={short}
      register={registerButton}
    />
  );
  if (mode === 'bots') {
    return (
      <Box height={1} overflow="hidden">
        {bots.map((bot) => (
          <Button
            key={bot.name}
            id={bot.key}
            hotkey={bot.key}
            label={bot.name}
            dim={isAbsent(bot, reviewers)}
            short={short}
            register={registerButton}
          />
        ))}
        <Button id="back" hotkey="←" label="back" short={short} register={registerButton} />
      </Box>
    );
  }
  if (mode === 'agent') {
    return (
      <Box height={1} overflow="hidden">
        <Group name={session?.name ?? (cloudSession ? 'cloud session' : 'no session')} />
        {actionsOf('agent').map((action) =>
          button(action, action.openSession ? !cloudSession : disabledCommands || !session),
        )}
        <Button id="back" hotkey="←" label="back" short={short} register={registerButton} />
      </Box>
    );
  }
  if (mode !== 'main') {
    const dim = disabledCommands || isAbsent(mode, reviewers);
    return (
      <Box height={1} overflow="hidden">
        <Group name={mode.name} />
        {actionsOf(mode).map((action) => button(action, dim))}
        <Button id="back" hotkey="←" label="back" short={short} register={registerButton} />
      </Box>
    );
  }
  return (
    <Box height={1} overflow="hidden">
      <Button id="o" hotkey="⏎" label="open" short={short} register={registerButton} />
      <Button id="unfold" hotkey="e" label="expand" short={short} register={registerButton} />
      {actionsOf('main')
        .filter((action) => action.merge)
        .map((action) => button(action, disabledCommands))}
      <Button id="r" hotkey="r" label="refresh" short={short} register={registerButton} />
      <Button id="h" hotkey="h" label={hiddenLabel(revealed, hiddenCount)} short={short} register={registerButton} />
      <Button id="bots" hotkey="b" label="bots" short={short} register={registerButton} />
      <Button
        id="agent"
        hotkey="a"
        label="agent"
        dim={!session && !cloudSession}
        short={short}
        register={registerButton}
      />
      <Button id="," hotkey="," label="settings" short={short} register={registerButton} />
      <Text dimColor wrap="truncate-end">
        ↑↓ ←→ q
      </Text>
    </Box>
  );
}

function Question({ confirmation }: { confirmation: Confirmation }) {
  const { action, key, session } = confirmation;
  if (action.merge)
    return (
      <>
        Merge <Text bold>{key}</Text>?{'  '}
      </>
    );
  if (action.agent)
    return (
      <>
        Send <Text bold>"{action.label}"</Text> to <Text bold>{session?.name}</Text> for {key}?{'  '}
      </>
    );
  return (
    <>
      Send <Text bold>"{requestText(action.request!)}"</Text> on <Text bold>{key}</Text>?{'  '}
    </>
  );
}

function Controls(props: ControlsProps) {
  const { confirmation, flash, registerButton, panelOpen, editing } = props;
  return (
    <Box flexDirection="column" marginTop={1}>
      {confirmation ? (
        <>
          <Box>
            <Text wrap="truncate-end">
              <Question confirmation={confirmation} />
            </Text>
            <Button id="yes" hotkey="y / ⏎" label="yes" register={registerButton} />
            <Button id="no" hotkey="n / esc" label="no" register={registerButton} />
          </Box>
          {/* The prompt wraps: the user confirms the complete text that the session gets. */}
          {confirmation.warning || !confirmation.prompt ? (
            <Text color="yellow" wrap="truncate-end">
              {confirmation.warning ?? ' '}
            </Text>
          ) : undefined}
          {confirmation.prompt && <Text dimColor>{confirmation.prompt}</Text>}
        </>
      ) : (
        <>
          {panelOpen ? (
            <Text dimColor wrap="truncate-end">
              {editing ?? '↑↓ choose · space or ⏎ change · a automatic retry · d delete a bot · , or esc close'}
            </Text>
          ) : (
            <ActionBar {...props} />
          )}
          <Text color={flash?.color} wrap="truncate-end">
            {flash?.text ?? ' '}
          </Text>
        </>
      )}
    </Box>
  );
}

const AUTHORS_LINE = SETTINGS.length;
const FIRST_BOT_LINE = AUTHORS_LINE + 1;
const BACKSPACE = '\u007F';

/** The last line of the settings panel: the line that adds a review bot. */
const lastPanelLine = (settings: Settings) => FIRST_BOT_LINE + allBots(settings).length;

interface BotDraft {
  /** The fields that the user typed, in the order of BOT_FIELDS. */
  values: string[];
  text: string;
}

function editingHint(authorsDraft: string | undefined, botDraft: BotDraft | undefined): string | undefined {
  if (authorsDraft !== undefined) return 'type the authors, with a comma between two · ⏎ save · esc cancel';
  if (!botDraft) return undefined;
  const last = botDraft.values.length === BOT_FIELDS.length - 1;
  return `${BOT_FIELDS[botDraft.values.length]!.hint} · ⏎ ${last ? 'save' : 'next'} · esc cancel`;
}

function requestOf(bot: Bot): string {
  if (bot.reviewer) return 'review request';
  return bot.mention ?? '/command';
}

interface SettingsPanelProps {
  settings: Settings;
  cursor: number;
  authorsDraft: string | undefined;
  botDraft: BotDraft | undefined;
  registerButton: ControlsProps['registerButton'];
}

function SettingsPanel({ settings, cursor, authorsDraft, botDraft, registerButton }: SettingsPanelProps) {
  const bots = allBots(settings);
  const nameWidth = Math.max(...bots.map((bot) => bot.name.length)) + 2;
  const pointer = (line: number) => (
    <Box width={2} flexShrink={0}>
      <Text color={BRAND} bold>
        {line === cursor ? '❯' : ' '}
      </Text>
    </Box>
  );
  const box = (on: boolean) => (
    <Text color={on ? 'green' : undefined} dimColor={!on}>
      {on ? '[x]' : '[ ]'}
    </Text>
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Settings</Text>
      <Text dimColor>A narrow terminal hides more parts of a row.</Text>
      {SETTINGS.map(({ key, label }, index) => (
        <Box key={key} ref={registerButton(`setting:${key}`)}>
          <Box width={2} flexShrink={0}>
            <Text color={BRAND} bold>
              {index === cursor ? '❯' : ' '}
            </Text>
          </Box>
          <Text color={settings[key] ? 'green' : undefined} dimColor={!settings[key]}>
            {settings[key] ? '[x]' : '[ ]'}
          </Text>
          <Text wrap="truncate-end"> {label}</Text>
        </Box>
      ))}
      <Box ref={registerButton('setting:authors')}>
        {pointer(AUTHORS_LINE)}
        {authorsDraft === undefined ? (
          <Text wrap="truncate-end">
            Authors: {settings.authors.join(', ')}{' '}
            <Text dimColor>· a login, @me, or app/&lt;slug&gt; for a GitHub App</Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            Authors: <Text color={BRAND}>{authorsDraft}</Text>
            <Text inverse> </Text>
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text bold>Review bots</Text>
        <Text dimColor> · space turns a bot on or off · a turns its automatic retry on or off</Text>
      </Box>
      {bots.map((bot, index) => {
        const on = isEnabled(settings, bot);
        return (
          <Box key={bot.id}>
            <Box ref={registerButton(`bot:${bot.id}`)} flexShrink={0}>
              {pointer(FIRST_BOT_LINE + index)}
              {box(on)}
              <Box width={nameWidth + 1} flexShrink={0}>
                <Text dimColor={!on}> {bot.name}</Text>
              </Box>
              <Text color={on ? BRAND : undefined} dimColor={!on} bold>
                {bot.key}
              </Text>
            </Box>
            <Box ref={registerButton(`retry:${bot.id}`)} flexShrink={0} marginLeft={2}>
              {box(retriesOn(settings, bot))}
              <Text dimColor={!on}> retry</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {requestOf(bot)}
              {bot.logins.length > 0 && ` · ${bot.logins.join(', ')}`}
              {bot.custom && ' · yours, d deletes it'}
            </Text>
          </Box>
        );
      })}
      <Box ref={registerButton('bot:add')}>
        {pointer(FIRST_BOT_LINE + bots.length)}
        {botDraft ? (
          <Text wrap="truncate-end">
            New bot {botDraft.values.length + 1}/{BOT_FIELDS.length}
            {botDraft.values.length > 0 && <Text dimColor> ({botDraft.values.join(' · ')})</Text>}
            {' · '}
            {BOT_FIELDS[botDraft.values.length]!.label}: <Text color={BRAND}>{botDraft.text}</Text>
            <Text inverse> </Text>
          </Text>
        ) : (
          <Text color={BRAND}>+ add a review bot</Text>
        )}
      </Box>
    </Box>
  );
}

function sourceNote(source: QuotaSource | undefined, options: Options): string {
  if (!source) return '';
  const name = source.pr.startsWith(`${options.org}/`) ? source.pr.slice(options.org.length + 1) : source.pr;
  return ` · read on ${name} at ${formatTime(source.at)}`;
}

function formatDuration(ms: number, precise: boolean): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (precise) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatAgo(now: Date, at: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
