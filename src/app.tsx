import { Box, Text, useApp, useInput, useStdin, useStdout, useWindowSize, type DOMElement } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { setTimeout as sleep } from "node:timers/promises";
import { actionForKey, actionsOf, BOT_BAR_WIDTH, BOTS, CODERABBIT, isAbsent, isCodeRabbit, moveSelection, parentOf, refusal, requestText, reselect, type Action, type Mode, type Request, type ReviewerRef } from "./actions.js";
import { BOT_LOGIN, botReplied, decide, quotaScope, quotaSignals, type Comment, type Decision, type QuotaSignal, type QuotaSource } from "./decide.js";
import * as github from "./github.js";
import type { PullRequest, PullRequestSnapshot } from "./github.js";
import { layoutFor, LABEL_WIDTH, rowHeight, type Layout } from "./layout.js";
import { createMouseParser, DISABLE_MOUSE, ENABLE_MOUSE, isMouseFragment } from "./mouse.js";
import { summarize, type Overall, type Reviewer, type ReviewerStatus, type Summary } from "./reviewers.js";
import { DEFAULT_SETTINGS, parseAuthors, SETTINGS, type SettingKey, type Settings } from "./settings.js";
import { planSync, type LeftStatus } from "./sync.js";
import { createReplyFilter, GHOST_PALETTES, type Background } from "./theme.js";
import { visibleRange } from "./viewport.js";

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
  activity?: "loading" | { posting: Request };
  posted?: { request: Request; url: string };
  error?: string;
  left?: LeftStatus;
  fetched?: Omit<PullRequestSnapshot, "status">;
}

export type GitHub = Pick<typeof github, "listPullRequests" | "fetchPullRequest" | "requestReview" | "openInBrowser" | "mergePullRequest">;

export interface Timing {
  replyPollMs: number;
  replyTimeoutMs: number;
  watchPollMs: number;
  listRefreshMs: number;
}

const DEFAULT_TIMING: Timing = { replyPollMs: 5_000, replyTimeoutMs: 90_000, watchPollMs: 30_000, listRefreshMs: 60_000 };
const REPOST_GUARD_MS = 15 * 60_000;
const BRAND = "#8B5CF6";
const isReviewRequest = (request: Request) => request.command === "review" || request.command === "full review";
const HIDING_SETTING: Record<LeftStatus, SettingKey> = { merged: "hideMerged", closed: "hideClosed", draft: "hideDrafts" };
// GitHub mergeable_state values that deserve a warning before a merge.
const MERGE_STATE_WARNINGS: Record<string, string> = {
  dirty: "conflicts with the base branch",
  blocked: "blocked by the branch protection rules",
  behind: "behind the base branch",
  unknown: "GitHub has not computed the merge state yet",
};
/** The height of the header: the crown and the three lines of the head. */
export const HEADER_LINES = 4;
// Lines outside the list in interactive mode: the header, the margin, the scroll hints and the footer.
const CHROME_LINES = HEADER_LINES + 8;

const keyOf = (pr: PullRequest) => `${pr.repo}#${pr.number}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isHidden = (row: Row, settings: Settings, revealed: boolean) => Boolean(row.left) && !revealed && settings[HIDING_SETTING[row.left!]];

// A review or a check in progress changes soon. The watch reads such a row at each poll, even during a CodeRabbit quota wait.
const inProgress = (row: Row) =>
  Boolean(row.summary?.checks.pending) || Boolean(row.summary?.reviewers.some((reviewer) => reviewer.status === "reviewing"));

function needsWatch(row: Row, dryRun: boolean): boolean {
  if (row.left) return false;
  if (row.error || inProgress(row)) return true;
  switch (row.decision?.kind) {
    case "busy":
    case "pending":
    case "wait":
      return true;
    case "trigger":
      return !dryRun;
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
}

interface PostControls {
  post(pr: PullRequest, request: Request): Promise<void>;
  refresh(pr: PullRequest): Promise<unknown>;
}

interface AppProps {
  options: Options;
  gitHub?: GitHub;
  timing?: Timing;
  settings?: Settings;
  /** Stores the settings after a change in the settings panel. */
  saveSettings?: (settings: Settings) => Promise<void>;
}

export function App(props: AppProps) {
  // The workflow posts comments. If a new prop restarts it, it posts again and loses its repost guard.
  // Thus the component keeps the props of its first render.
  const [{ options, gitHub, timing, saveSettings }] = useState(() => ({
    options: props.options,
    gitHub: props.gitHub ?? github,
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
  const [mode, setMode] = useState<Mode>("main");
  const modeRef = useRef<Mode>("main");
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

  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;

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

    // The CodeRabbit quota belongs to the developer, so every row reads the quota signals of the rows
    // in the same quota scope (see quotaScope). A new fetch on one row can thus change the decision
    // of the others, with no API call.
    function redecide() {
      const now = new Date();
      const scopeOf = (row: Row) => quotaScope(row.pr.repo, row.fetched?.comments ?? [], row.fetched?.reviews ?? []);
      const signalsByScope = new Map<string, QuotaSignal[]>();
      for (const [key, row] of rowsRef.current) {
        if (!row.fetched) continue;
        const scope = scopeOf(row);
        signalsByScope.set(scope, [...(signalsByScope.get(scope) ?? []), ...quotaSignals(key, row.fetched.comments, row.fetched.reviews)]);
      }
      for (const [key, row] of rowsRef.current) {
        if (!row.fetched || row.left) continue;
        const quota = signalsByScope.get(scopeOf(row)) ?? [];
        const decision = decide({ ...row.fetched, now, pr: key, quota });
        rowsRef.current.set(key, { ...row, decision, summary: summarize({ ...row.fetched, now, coderabbit: decision }) });
      }
      setRows([...rowsRef.current.values()]);
    }

    async function refresh(pr: PullRequest): Promise<Decision | undefined> {
      update(pr, { activity: "loading" });
      try {
        const { status, ...state } = await gitHub.fetchPullRequest(pr);
        if (status !== "open") {
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
      } while (decision?.kind === "pending" && Date.now() < deadline);
      return decision;
    }

    async function send(pr: PullRequest, request: Request): Promise<boolean> {
      const commentsBefore = rowOf(pr).fetched?.comments ?? [];
      update(pr, { activity: { posting: request } });
      try {
        const url = await gitHub.requestReview(pr, request);
        if (isCodeRabbit(request) && isReviewRequest(request)) lastPosts.current.set(keyOf(pr), { at: Date.now(), before: commentsBefore });
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
        setFlash({ text: `Cannot post on ${keyOf(pr)}: this pull request is no longer open.`, color: "yellow" });
        return;
      }
      // Only CodeRabbit shares the quota clock of the queue. Another bot does not wait for a CodeRabbit retry.
      const sent = isCodeRabbit(request) ? await post(pr, request) : await send(pr, request);
      if (sent && !isCodeRabbit(request)) void refresh(pr);
      setFlash(
        sent
          ? { text: `Sent "${requestText(request)}" on ${keyOf(pr)}.`, color: "green" }
          : { text: `Could not send "${requestText(request)}" on ${keyOf(pr)}.`, color: "red" },
      );
    }

    controls.current = {
      refresh,
      post: (pr, request) =>
        (isCodeRabbit(request) ? exclusive(() => postOnce(pr, request)) : postOnce(pr, request)).catch((error) => {
          if (!signal.aborted) setFlash({ text: `Could not post on ${keyOf(pr)}: ${message(error)}`, color: "red" });
        }),
    };

    // A request of this session with no reply from CodeRabbit yet blocks a new one on the same pull request.
    // A reply, such as a refusal, ends the block: a later signal can then free the quota again.
    function unanswered(row: Row, last: { at: number; before: Comment[] } | undefined): boolean {
      if (!last || Date.now() - last.at >= REPOST_GUARD_MS) return false;
      return !botReplied(last.before, row.fetched?.comments ?? []);
    }

    async function triggerReady(prs: PullRequest[]) {
      if (options.dryRun) return;
      for (const pr of prs) {
        await exclusive(async () => {
          const row = rowOf(pr);
          // A row whose last fetch failed shows old data: its head and its status are not checked.
          if (row.left || row.error || row.decision?.kind !== "trigger") return;
          if (unanswered(row, lastPosts.current.get(keyOf(pr)))) return;
          if (await post(pr, { bot: CODERABBIT, command: "review" })) setTriggered((count) => count + 1);
        });
      }
    }

    function nextDelay(prs: PullRequest[]): number {
      const ends = prs
        .map((pr) => rowOf(pr).decision)
        .filter((decision) => decision?.kind === "wait")
        .map((decision) => decision.availableAt.getTime() + 2_000 - Date.now());
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
      for (const pr of added) rowsRef.current.set(keyOf(pr), { pr, activity: "loading" });
      setRows([...rowsRef.current.values()]);
      selectedRef.current ??= [...rowsRef.current.keys()][0];
      setSelected(selectedRef.current);
      await Promise.all([...added, ...plan.recheck.map((key) => rowsRef.current.get(key)!.pr)].map(refresh));
    }

    async function run() {
      await syncList();
      await triggerReady(tracked());
      if (!options.watch) return;

      let listedAt = Date.now();
      while (true) {
        const watched = tracked().filter((pr) => needsWatch(rowOf(pr), options.dryRun));
        const delay = nextDelay(watched);
        setNextCheckAt(new Date(Date.now() + delay));
        await sleep(delay, undefined, { signal });
        setNextCheckAt(undefined);

        if (Date.now() - listedAt >= timing.listRefreshMs) {
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
            return !row.left && !inProgress(row) && (!needsWatch(row, options.dryRun) || row.decision?.kind === "wait");
          });
          await Promise.all(quiet.map(refresh));
        }

        const due = watched.filter((pr) => {
          const row = rowOf(pr);
          if (row.left) return false;
          return inProgress(row) || row.decision?.kind !== "wait" || row.decision.availableAt.getTime() <= Date.now();
        });
        await Promise.all(due.map(refresh));
        await triggerReady(tracked());
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
    if (!options.watch) return;
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (done) exit(fatal ? new Error(fatal) : undefined);
  }, [done]);

  const allKeys = rows?.map((row) => keyOf(row.pr)) ?? [];
  const shownRows = (rows ?? []).filter((row) => !isHidden(row, settings, revealed));
  const keys = shownRows.map((row) => keyOf(row.pr));
  const selection = reselect(allKeys, keys, selected);
  const hiddenCount = allKeys.length - keys.length;

  // Several keys can arrive in one input chunk and run with the closure of one render.
  // The handlers below read and write these refs, so each key sees what the previous key did.
  function live() {
    const all = [...rowsRef.current.values()];
    const everyKey = all.map((row) => keyOf(row.pr));
    const shownKeys = all.filter((row) => !isHidden(row, settingsRef.current, revealedRef.current)).map((row) => keyOf(row.pr));
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
        ? { text: "Showing all the pull requests.", color: "gray" }
        : { text: `Hiding ${hideable} merged, closed or draft pull request${hideable === 1 ? "" : "s"}.`, color: "gray" },
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
    saveSettings?.(next).catch((error) => setFlash({ text: `Could not save the settings: ${message(error)}`, color: "red" }));
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
    const next = parseAuthors(text.split(","));
    if (!next) return setFlash({ text: "The list needs one author or more.", color: "yellow" });
    const live = next.join() === authorsRef.current.join();
    if (!live) {
      // A search with an unknown author fails. A saved list that fails stops each later start.
      checkingAuthors.current = true;
      setFlash({ text: "Checking the authors…", color: "blue" });
      try {
        await gitHub.listPullRequests({ ...options, authors: next });
      } catch (error) {
        return setFlash({ text: `Could not list these authors: ${message(error).split("\n")[0]}`, color: "red" });
      } finally {
        checkingAuthors.current = false;
      }
      setFlash({ text: `Listing the pull requests of ${next.join(", ")}.`, color: "green" });
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

  function typeAuthorsKey(char: string) {
    if (checkingAuthors.current) return;
    const draft = authorsDraftRef.current ?? "";
    if (char === "\r") void saveAuthors(draft);
    else if (char === "\u001B") draftAuthors(undefined);
    else if (char === BACKSPACE) draftAuthors(draft.slice(0, -1));
    else if (char >= " ") draftAuthors(draft + char);
  }

  function typePanelKey(char: string) {
    if (authorsDraftRef.current !== undefined) return typeAuthorsKey(char);
    const line = panelRef.current ?? 0;
    if (char === "k") openPanel(Math.max(0, line - 1));
    else if (char === "j") openPanel(Math.min(AUTHORS_LINE, line + 1));
    else if ((char === " " || char === "\r") && line === AUTHORS_LINE) draftAuthors(settingsRef.current.authors.join(", "));
    else if (char === " " || char === "\r") toggleSetting(SETTINGS[line]!.key);
    else if (char === "," || char === "q" || char === "\u001B") openPanel(undefined);
  }

  // An arrow or the mouse wheel moves the selection. In the authors line, it must not type a letter.
  function step(direction: "k" | "j") {
    if (confirmationRef.current || authorsDraftRef.current !== undefined) return;
    typeKey(direction);
  }

  function mergeWarning(row: Row): string | undefined {
    const warnings: string[] = [];
    const reviewers = row.summary?.reviewers ?? [];
    const requesting = reviewers.filter((reviewer) => reviewer.verdict === "changes requested").map((reviewer) => reviewer.name);
    if (requesting.length > 0) warnings.push(`${requesting.join(", ")} ${requesting.length === 1 ? "requests" : "request"} changes`);
    else if (!reviewers.some((reviewer) => reviewer.verdict === "approved")) warnings.push("no reviewer approves");
    const failed = row.summary?.checks.failed ?? [];
    if (failed.length > 0) warnings.push(`${failed.length} failing check${failed.length === 1 ? "" : "s"}`);
    if (row.summary?.checks.pending) warnings.push(`${row.summary.checks.pending} running check${row.summary.checks.pending === 1 ? "" : "s"}`);
    const state = MERGE_STATE_WARNINGS[row.fetched?.mergeState ?? "unknown"];
    if (state) warnings.push(state);
    return warnings.length > 0 ? `Warning: ${warnings.join(", ")}.` : undefined;
  }

  function targetOf(row: Row) {
    const reviewers = row.summary?.reviewers;
    return { left: row.left !== undefined, dryRun: options.dryRun, ...(reviewers && { reviewers }) };
  }

  function quotaWarning(row: Row, request: Request): string | undefined {
    if (!isReviewRequest(request)) return undefined;
    if (isCodeRabbit(request)) {
      return row.decision?.kind === "wait"
        ? `The CodeRabbit quota comes back at ${formatTime(row.decision.availableAt)}: CodeRabbit will likely refuse.`
        : undefined;
    }
    const reviewer = row.summary?.reviewers.find((candidate) => request.bot.logins.includes(candidate.login));
    if (reviewer?.status !== "quota") return undefined;
    const back = reviewer.until ? `comes back at ${formatTime(reviewer.until)}` : "has no known return time";
    return `The ${request.bot.name} quota ${back}: ${request.bot.name} will likely refuse.`;
  }

  function request(action: Action, key = live().key) {
    const row = key ? rowsRef.current.get(key) : undefined;
    if (!row || !key) return;
    const refused = refusal(action, targetOf(row));
    if (refused) {
      setFlash({ text: `Cannot ${action.label} ${key}: ${refused}.`, color: "yellow" });
      return;
    }
    if (action.merge) {
      const head = row.fetched?.head;
      if (!head) {
        setFlash({ text: `Cannot merge ${key}: its state is not fetched yet.`, color: "yellow" });
        return;
      }
      if (merging.current.has(key)) {
        setFlash({ text: `${key} is already merging.`, color: "yellow" });
        return;
      }
      setFlash(undefined);
      confirm({ key, action, warning: mergeWarning(row), head });
      return;
    }
    if (!action.request) {
      gitHub.openInBrowser(row.pr.url).then(
        () => setFlash({ text: `Opened ${key} in the browser.`, color: "green" }),
        (error) => setFlash({ text: `Could not open ${key}: ${message(error)}`, color: "red" }),
      );
      return;
    }
    setFlash(undefined);
    confirm({ key, action, warning: quotaWarning(row, action.request) });
  }

  function answer(yes: boolean) {
    const pending = confirmationRef.current;
    confirm(undefined);
    if (!pending?.action.request && !pending?.action.merge) return;
    const row = rowsRef.current.get(pending.key);
    if (!yes || !row) {
      setFlash({ text: "Cancelled.", color: "gray" });
      return;
    }
    // A list refresh can close the pull request while the prompt waits.
    const refused = refusal(pending.action, targetOf(row));
    if (refused) {
      setFlash({ text: `Cannot ${pending.action.label} ${pending.key}: ${refused}.`, color: "yellow" });
      return;
    }
    if (pending.action.merge) {
      const head = pending.head;
      if (!head || merging.current.has(pending.key)) return;
      merging.current.add(pending.key);
      setFlash({ text: `Merging ${pending.key}…`, color: "blue" });
      gitHub.mergePullRequest(row.pr, head).then(
        async () => {
          // With a merge queue or auto-merge, gh succeeds but the pull request stays open for a while.
          // A queue can also use another method than the one requested, so the messages name none.
          await controls.current?.refresh(row.pr);
          const after = rowsRef.current.get(pending.key);
          if (after?.left === "merged") setFlash({ text: `Merged ${pending.key}.`, color: "green" });
          else if (after?.error) {
            setFlash({ text: `GitHub accepted the merge of ${pending.key}, but its new status could not be read: ${after.error}`, color: "yellow" });
          } else setFlash({ text: `Merge of ${pending.key} requested: GitHub queued it or enabled auto-merge.`, color: "blue" });
        },
        (error) => setFlash({ text: `Could not merge ${pending.key}: ${message(error)}`, color: "red" }),
      ).finally(() => merging.current.delete(pending.key));
      return;
    }
    setFlash({ text: `Sending "${requestText(pending.action.request!)}" on ${pending.key}…`, color: "blue" });
    void controls.current?.post(row.pr, pending.action.request!);
  }

  function press(id: string) {
    if (id === "yes" || id === "no") return answer(id === "yes");
    if (confirmationRef.current) return;
    if (id === "setting:authors") {
      openPanel(AUTHORS_LINE);
      if (authorsDraftRef.current === undefined) draftAuthors(settingsRef.current.authors.join(", "));
      return;
    }
    if (id.startsWith("setting:")) {
      if (authorsDraftRef.current !== undefined) return;
      const key = id.slice("setting:".length) as SettingKey;
      openPanel(SETTINGS.findIndex((setting) => setting.key === key));
      return toggleSetting(key);
    }
    if (panelRef.current !== undefined) return;
    if (id === "h") return toggleHidden();
    if (id === ",") return openPanel(0);
    if (id === "bots") return switchMode("bots");
    if (id === "back") return switchMode(parentOf(modeRef.current));
    const bot = modeRef.current === "bots" ? BOTS.find((candidate) => candidate.key === id) : undefined;
    if (bot) return switchMode(bot);
    const action = actionForKey(id, modeRef.current);
    if (action) request(action);
  }

  function move(step: number) {
    const { shownKeys, key } = live();
    select(moveSelection(shownKeys, key, step));
  }

  function typeKey(char: string) {
    if (confirmationRef.current) {
      if (char === "y" || char === "\r") answer(true);
      else if (char === "n" || char === "\u001B") answer(false);
      return;
    }
    if (panelRef.current !== undefined) return typePanelKey(char);
    if (char === "k") move(-1);
    else if (char === "j") move(1);
    else if (char === "\r") press("o");
    else if (char === "q") exit();
    else if (char === " ") switchMode(modeRef.current === "main" ? "bots" : parentOf(modeRef.current));
    else if (char === "\u001B") switchMode("main");
    else press(char);
  }

  useInput(
    (input, key) => {
      if (isMouseFragment(input) || isLateReply.current(input)) return;
      // The raw stdin listener handles a lone "m": only the mouse parser knows if it ends a split report.
      if (input === "m") return;
      if (key.upArrow) return step("k");
      if (key.downArrow) return step("j");
      if (authorsDraftRef.current !== undefined) {
        if (key.backspace || key.delete) return typeKey(BACKSPACE);
        if (key.ctrl || key.meta || key.tab) return;
      }
      if (key.rightArrow) return confirmationRef.current || panelRef.current !== undefined ? undefined : modeRef.current === "main" ? switchMode("bots") : undefined;
      if (key.leftArrow) return confirmationRef.current || panelRef.current !== undefined ? undefined : switchMode(parentOf(modeRef.current));
      if (key.return) return typeKey("\r");
      // A terminal can split a mouse report after its Escape byte, and Ink then reports a lone Escape.
      // Wait a moment: if the rest of a mouse report follows, the Escape was part of it.
      if (key.escape) {
        clearTimeout(pendingEscape.current);
        const prompt = confirmationRef.current;
        pendingEscape.current = setTimeout(() => {
          if (!prompt || confirmationRef.current === prompt) typeKey("\u001B");
        }, 60);
        return;
      }
      // A paste must answer at most one prompt, and never a prompt that it opened itself.
      // The rest of the chunk stops when a key opens or closes a prompt.
      for (const char of input) {
        const hadPrompt = confirmationRef.current !== undefined;
        const hadDraft = authorsDraftRef.current !== undefined;
        typeKey(char);
        if (hadPrompt !== (confirmationRef.current !== undefined)) break;
        // The rest of a paste that saved the authors must not run as keys of the panel.
        if (hadDraft && authorsDraftRef.current === undefined) break;
      }
    },
    { isActive: options.interactive },
  );

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [flash]);

  const handlers = useRef({ press, move, select, typeKey, step });
  handlers.current = { press, move, select, typeKey, step };

  useEffect(() => {
    if (!options.interactive) return;
    const disable = () => stdout.write(DISABLE_MOUSE);
    stdout.write(ENABLE_MOUSE);
    process.once("exit", disable);
    const feed = createMouseParser((event) => {
      if (event.kind === "wheel") return handlers.current.step(event.direction === "up" ? "k" : "j");
      const button = hitTest(buttonNodes.current, event.x, event.y);
      if (button) return handlers.current.press(button);
      const row = hitTest(rowNodes.current, event.x, event.y);
      if (row) handlers.current.select(row);
    });
    const onData = (data: Buffer | string) => {
      const text = data.toString();
      if (text.startsWith("[<")) clearTimeout(pendingEscape.current);
      const endedSplitReport = feed(text);
      if (text === "m" && !endedSplitReport) handlers.current.typeKey("m");
    };
    stdin.on("data", onData);
    return () => {
      clearTimeout(pendingEscape.current);
      stdin.off("data", onData);
      process.off("exit", disable);
      disable();
    };
  }, []);

  const clock = options.watch ? now : new Date();
  const selectedIndex = selection ? keys.indexOf(selection) : 0;
  const views = new Map(shownRows.map((row) => [row, describe(row, clock, options)]));
  // In a terminal, only the selected row shows its details. A piped run shows them all.
  const expanded = (row: Row) => !options.interactive || keyOf(row.pr) === selection;
  const layout = layoutFor(columns, settings, options.interactive);
  const heightOf = (row: Row) =>
    rowHeight({ summary: Boolean(row.summary), detail: expanded(row) && Boolean(views.get(row)!.detail), posted: Boolean(row.posted) }, layout);
  const range = options.interactive
    ? visibleRange(shownRows.map(heightOf), selectedIndex, Math.max(3, screenRows - CHROME_LINES), scrollStart.current)
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
      <Header options={{ ...options, authors }} mood={fatal ? "failed" : done ? "done" : nextCheckAt ? "sleeping" : "checking"} now={clock} nextCheckAt={nextCheckAt} />
      {rows === null && !fatal && (
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>{" "}
          Searching pull requests…
        </Text>
      )}
      {rows?.length === 0 && (
        <Text dimColor>
          No open pull request by {authors.join(" or ")}{options.org ? ` in ${options.org}` : ""}{options.since ? ` since ${formatDay(options.since)}` : ""}.
        </Text>
      )}
      {panel !== undefined && <SettingsPanel settings={settings} cursor={panel} authorsDraft={authorsDraft} registerButton={registerButton} />}
      {rows && rows.length > 0 && panel === undefined && (
        <Box flexDirection="column" marginTop={1}>
          {options.interactive && (
            <Text dimColor>{range.start > 0 ? `  ↑ ${range.start} more` : " "}</Text>
          )}
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
              now={clock}
              expanded={expanded(row)}
              selected={options.interactive && keyOf(row.pr) === selection}
            />
          ))}
          {options.interactive && (
            <Text dimColor>{range.end < shownRows.length ? `  ↓ ${shownRows.length - range.end} more` : " "}</Text>
          )}
        </Box>
      )}
      {fatal && <Text color="red">✖ {fatal}</Text>}
      {options.interactive && <Box flexGrow={1} />}
      {rows && rows.length > 0 && (
        <Footer
          rows={rows}
          triggered={triggered}
          done={done}
          listError={listError}
          options={options}
        />
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
          editing={authorsDraft !== undefined}
          short={layout.shortBar}
          shortBots={layout.shortBar || columns - 2 < BOT_BAR_WIDTH}
          reviewers={selectedRow?.summary?.reviewers}
        />
      )}
    </Box>
  );
}

export type Mood = "checking" | "sleeping" | "done" | "failed";

const FACES: Record<Mood, { eyes: [string, string]; mouth: string }> = {
  checking: { eyes: ["ò", "ó"], mouth: "v" },
  sleeping: { eyes: ["-", "-"], mouth: "ᴗ" },
  done: { eyes: ["^", "^"], mouth: "v" },
  failed: { eyes: ["x", "x"], mouth: "~" },
};
interface HeaderProps {
  options: Options;
  mood: Mood;
  now: Date;
  nextCheckAt?: Date;
}

export function Ghost({ mood, background = "unknown" }: { mood: Mood; background?: Background | undefined }) {
  const { eyes: [left, right], mouth } = FACES[mood];
  const palette = GHOST_PALETTES[background];
  return (
    <Box flexDirection="column" width={10} flexShrink={0}>
      <Text color={palette.crown} bold>
        {"   wWw"}
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
  const status = !options.watch || mood === "done" || mood === "failed"
    ? " "
    : `${nextCheckAt ? `next check in ${formatDuration(nextCheckAt.getTime() - now.getTime(), true)}` : "checking…"}${options.interactive ? "" : " · Ctrl+C to quit"}`;
  const scope = [options.authors.join(" + "), options.org || "all organizations", options.since && `since ${formatDay(options.since)}`].filter(Boolean);
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
          {scope.join(" · ")}
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
  detail?: string;
}

const spinner = (color: string) => (
  <Text color={color}>
    <Spinner type="dots" />
  </Text>
);

const OVERALL_VIEWS: Record<Overall, Omit<View, "icon"> & { icon: () => ReactNode }> = {
  ready: { icon: () => <Text color="green">✔</Text>, label: "ready to merge", color: "green" },
  approved: { icon: () => <Text color="green">✔</Text>, label: "approved", color: "green" },
  "changes requested": { icon: () => <Text color="red">✎</Text>, label: "changes requested", color: "red" },
  "checks failing": { icon: () => <Text color="red">✖</Text>, label: "checks failing", color: "red" },
  conflicts: { icon: () => <Text color="red">⚠</Text>, label: "conflicts", color: "red" },
  reviewing: { icon: () => spinner("cyan"), label: "reviewing", color: "cyan" },
  reviewed: { icon: () => <Text color="cyan">●</Text>, label: "reviewed", color: "cyan" },
  quota: { icon: () => <Text color="yellow">◷</Text>, label: "quota", color: "yellow" },
  "awaiting review": { icon: () => <Text color="gray">○</Text>, label: "awaiting review", color: "gray" },
};

const LEFT_VIEWS: Record<LeftStatus, View> = {
  merged: { icon: <Text color="magenta">◆</Text>, label: "merged", color: "magenta" },
  closed: { icon: <Text color="red">○</Text>, label: "closed", color: "red" },
  draft: { icon: <Text color="gray">◌</Text>, label: "draft", color: "gray", detail: "watched again when it is ready for review" },
};

function coderabbitDetail(decision: Decision | undefined, now: Date, options: Options): string | undefined {
  switch (decision?.kind) {
    case "wait": {
      const remaining = decision.availableAt.getTime() - now.getTime();
      const guess = decision.delayGuessed ? " · unreadable delay, 1 h assumed" : "";
      const when = remaining > 0 ? `in ${formatDuration(remaining, options.watch)}` : "now, checking…";
      return `CodeRabbit quota back ${when} (at ${formatTime(decision.availableAt)})${guess}${sourceNote(decision.source, options)}`;
    }
    case "trigger": {
      const since = formatDuration(now.getTime() - decision.availableAt.getTime(), false);
      return `CodeRabbit quota back for ${since}${sourceNote(decision.source, options)}${options.dryRun ? " · dry run, nothing posted" : ", retry queued"}`;
    }
    case "pending":
      return `CodeRabbit asked at ${formatTime(decision.requestedAt)}, no reply yet`;
    case "skipped":
      return `CodeRabbit skipped the review: ${decision.reason}${options.interactive ? " · r requests one" : ""}`;
    case "paused":
      return `CodeRabbit reviews are paused${options.interactive ? " · r reviews it once" : ""}`;
    case "idle":
      return `CodeRabbit: ${decision.limitLifted ? "rate limit lifted" : "no rate limit"}, but the last commit has no review`;
    default:
      return undefined;
  }
}

function details(row: Row, now: Date, options: Options): string | undefined {
  const summary = row.summary;
  if (!summary) return undefined;
  const parts = [
    summary.checks.failed.length > 0 && `failing: ${summary.checks.failed.join(", ")}`,
    summary.checks.pending > 0 && `${summary.checks.pending} check${summary.checks.pending === 1 ? "" : "s"} running`,
    MERGE_STATE_WARNINGS[row.fetched?.mergeState ?? "unknown"],
    ...summary.reviewers
      .filter((reviewer) => reviewer.login !== BOT_LOGIN && reviewer.status === "quota")
      .map((reviewer) => `${reviewer.name} quota ${reviewer.until ? `back at ${formatTime(reviewer.until)}` : "with no return time"}`),
    coderabbitDetail(row.decision, now, options),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function describe(row: Row, now: Date, options: Options): View {
  if (typeof row.activity === "object") {
    const request = row.activity.posting;
    return {
      icon: spinner("blue"),
      label: isCodeRabbit(request) && request.command === "review" ? "retrying" : "posting",
      color: "blue",
      detail: `"${requestText(request)}"…`,
    };
  }
  if (row.left) return LEFT_VIEWS[row.left];
  if (row.error) return { icon: <Text color="red">✖</Text>, label: "error", color: "red", detail: row.error };
  if (!row.summary) return { icon: spinner("gray"), label: "checking", color: "gray" };
  const { icon, ...view } = OVERALL_VIEWS[row.summary.overall];
  const detail = details(row, now, options);
  return { ...view, icon: icon(), ...(detail && { detail }) };
}

const CHIPS: Record<ReviewerStatus, { icon: string; color: string }> = {
  approved: { icon: "✔", color: "green" },
  "changes requested": { icon: "✎", color: "red" },
  commented: { icon: "●", color: "cyan" },
  reviewing: { icon: "⟳", color: "cyan" },
  quota: { icon: "◷", color: "yellow" },
  "to retry": { icon: "↻", color: "blue" },
  requested: { icon: "○", color: "magenta" },
  stale: { icon: "◌", color: "gray" },
  skipped: { icon: "⊘", color: "gray" },
  paused: { icon: "‖", color: "gray" },
};

function chipSuffix(reviewer: Reviewer): string {
  if (reviewer.progress) return ` ${reviewer.progress.done}/${reviewer.progress.total}`;
  if (reviewer.status === "quota") return reviewer.until ? ` ${formatTime(reviewer.until)}` : "";
  if (reviewer.status === "stale" && reviewer.verdict && reviewer.verdict !== "commented") return ` ${CHIPS[reviewer.verdict].icon} old`;
  return "";
}

function ReviewerChip({ reviewer }: { reviewer: Reviewer }) {
  const chip = CHIPS[reviewer.status];
  const muted = reviewer.status === "stale" || reviewer.status === "skipped" || reviewer.status === "paused";
  return (
    <Box marginRight={2} flexShrink={0}>
      <Text dimColor={muted}>
        <Text color={chip.color}>{chip.icon}</Text> {reviewer.name}
        <Text dimColor>{chipSuffix(reviewer)}</Text>
      </Text>
    </Box>
  );
}

function ChecksBadge({ summary, short }: { summary: Summary; short: boolean }) {
  const { checks } = summary;
  const counted = checks.passed + checks.failed.length + checks.pending;
  const word = (text: string) => (short ? "" : ` ${text}`);
  if (checks.failed.length > 0) return <Text color="red">✖ {checks.failed.length}/{counted}{word("failing")}</Text>;
  if (checks.pending > 0) return <Text color="yellow">◌ {checks.pending}/{counted}{word("running")}</Text>;
  if (counted === 0) {
    if (checks.skipped > 0) return <Text dimColor>⊘ {checks.skipped}{word("skipped")}</Text>;
    if (checks.quota > 0) return <Text dimColor>◷ {checks.quota}{word("quota only")}</Text>;
    return <Text dimColor>{short ? "–" : "no checks"}</Text>;
  }
  return <Text color="green">✔ {checks.passed}/{counted}{word("checks")}</Text>;
}

interface RowViewProps {
  ref: (node: DOMElement | null) => void;
  row: Row;
  view: View;
  options: Options;
  layout: Layout;
  now: Date;
  expanded: boolean;
  selected: boolean;
}

function RowView({ ref, row, view, options, layout, now, expanded, selected }: RowViewProps) {
  const name = options.org && row.pr.repo.startsWith(`${options.org}/`) ? row.pr.repo.slice(options.org.length + 1) : row.pr.repo;
  const { indent } = layout;
  const summary = row.summary;
  return (
    <Box ref={ref} flexDirection="column" marginBottom={layout.gap}>
      <Box>
        {options.interactive && (
          <Box width={2} flexShrink={0}>
            <Text color={BRAND} bold>
              {selected ? "❯" : " "}
            </Text>
          </Box>
        )}
        <Box width={3} flexShrink={0}>
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
        {summary && !row.left && (layout.checks || layout.counts) && (
          <Box flexShrink={0} marginLeft={2}>
            {layout.checks && <ChecksBadge summary={summary} short={layout.shortChecks} />}
            {layout.counts && (
              <Text dimColor>
                {layout.checks && "  "}
                {summary.reviewers.length > 0 && `${summary.onHead}/${summary.reviewers.length} on head · `}
                {summary.reviews} review{summary.reviews === 1 ? "" : "s"}
              </Text>
            )}
          </Box>
        )}
      </Box>
      {summary && (layout.lastReview || layout.marks) && (
        <Box paddingLeft={indent}>
          {layout.lastReview && (
            <Box flexShrink={0} marginRight={2}>
              <Text dimColor>
                {summary.lastReview
                  ? `last ${summary.lastReview.name} ${formatAgo(now, summary.lastReview.at)}`
                  : summary.reviewers.length === 0 ? "no reviewer yet" : "no review yet"}
              </Text>
            </Box>
          )}
          {layout.marks && (
            <Box flexShrink={1} overflow="hidden">
              {summary.reviewers.map((reviewer) => (
                <ReviewerChip key={reviewer.login} reviewer={reviewer} />
              ))}
            </Box>
          )}
        </Box>
      )}
      {expanded && layout.details && view.detail && (
        <Box paddingLeft={indent}>
          <Text dimColor wrap="truncate-end">
            {view.detail}
          </Text>
        </Box>
      )}
      {row.posted && (
        <Box paddingLeft={indent}>
          <Text color="green" wrap="truncate-end">
            ↻ {requestText(row.posted.request)} → {row.posted.url}
          </Text>
        </Box>
      )}
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

const FOOTER_ORDER: Overall[] = ["ready", "approved", "changes requested", "checks failing", "conflicts", "reviewing", "reviewed", "quota", "awaiting review"];

function Footer({ rows, triggered, done, listError, options }: FooterProps) {
  const active = rows.filter((row) => !row.left);
  const countLeft = (status: LeftStatus) => rows.filter((row) => row.left === status).length;
  const waiting = active.filter((row) => row.decision?.kind === "wait").length;
  const parts: [number, string, string][] = [
    ...FOOTER_ORDER.map((overall): [number, string, string] => [
      active.filter((row) => row.summary?.overall === overall).length,
      OVERALL_VIEWS[overall].label,
      OVERALL_VIEWS[overall].color,
    ]),
    [triggered, "CodeRabbit retried", "blue"],
    [countLeft("merged"), "merged", "magenta"],
    [countLeft("closed"), "closed", "red"],
    [countLeft("draft"), "draft", "gray"],
  ];
  const shown = parts.filter(([amount]) => amount > 0);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {shown.length === 0
          ? "Nothing to show."
          : shown.map(([amount, label, color], index) => (
              <Text key={label}>
                {index > 0 && <Text dimColor> · </Text>}
                <Text color={color} bold>
                  {amount}
                </Text>{" "}
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
  /** The user changes the authors line of the settings panel. */
  editing: boolean;
  /** Show the keys only, for a narrow terminal. */
  short: boolean;
  shortBots: boolean;
  /** The reviewers of the selected pull request. */
  reviewers?: readonly ReviewerRef[] | undefined;
}

interface ButtonProps {
  id: string;
  hotkey: string;
  label: string;
  dim?: boolean | undefined;
  short?: boolean | undefined;
  register: ControlsProps["registerButton"];
}

function Button({ id, hotkey, label, dim, short, register }: ButtonProps) {
  return (
    <Box ref={register(id)} marginRight={short ? 1 : 2} flexShrink={0}>
      {/* The end of bold also ends dim, so the label sets dim on its own. */}
      <Text>
        <Text color={dim ? undefined : BRAND} dimColor={dim} bold>
          {hotkey}
        </Text>
        <Text dimColor={dim}>{short ? "" : ` ${label}`}</Text>
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

function ActionBar({ registerButton, disabledCommands, revealed, hiddenCount, mode, short: shortMain, shortBots, reviewers }: ControlsProps) {
  const short = mode === "main" ? shortMain : shortBots;
  const button = (action: Action, dim?: boolean) => (
    <Button key={action.key} id={action.key} hotkey={action.key} label={action.label} dim={dim} short={short} register={registerButton} />
  );
  if (mode === "bots") {
    return (
      <Box height={1} overflow="hidden">
        {BOTS.map((bot) => (
          <Button key={bot.name} id={bot.key} hotkey={bot.key} label={bot.name} dim={isAbsent(bot, reviewers)} short={short} register={registerButton} />
        ))}
        <Button id="back" hotkey="←" label="back" short={short} register={registerButton} />
      </Box>
    );
  }
  if (mode !== "main") {
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
      {actionsOf("main").map((action) => button(action, disabledCommands && action.merge))}
      <Button id="h" hotkey="h" label={revealed ? "hide inactive" : hiddenCount > 0 ? `show ${hiddenCount} hidden` : "nothing hidden"} short={short} register={registerButton} />
      <Button id="bots" hotkey="→" label="bots" short={short} register={registerButton} />
      <Button id="," hotkey="," label="settings" short={short} register={registerButton} />
      <Text dimColor wrap="truncate-end">↑↓ q</Text>
    </Box>
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
              {confirmation.action.merge ? (
                <>
                  Merge <Text bold>{confirmation.key}</Text>?{"  "}
                </>
              ) : (
                <>
                  Send <Text bold>"{requestText(confirmation.action.request!)}"</Text> on{" "}
                  <Text bold>{confirmation.key}</Text>?{"  "}
                </>
              )}
            </Text>
            <Button id="yes" hotkey="y / ⏎" label="yes" register={registerButton} />
            <Button id="no" hotkey="n / esc" label="no" register={registerButton} />
          </Box>
          <Text color="yellow" wrap="truncate-end">
            {confirmation.warning ?? " "}
          </Text>
        </>
      ) : (
        <>
          {panelOpen ? (
            <Text dimColor wrap="truncate-end">
              {editing ? "type the authors, with a comma between two · ⏎ save · esc cancel" : "↑↓ choose · space or ⏎ change · , or esc close"}
            </Text>
          ) : (
            <ActionBar {...props} />
          )}
          <Text color={flash?.color} wrap="truncate-end">
            {flash?.text ?? " "}
          </Text>
        </>
      )}
    </Box>
  );
}

const AUTHORS_LINE = SETTINGS.length;
const BACKSPACE = "\u007F";

interface SettingsPanelProps {
  settings: Settings;
  cursor: number;
  authorsDraft: string | undefined;
  registerButton: ControlsProps["registerButton"];
}

function SettingsPanel({ settings, cursor, authorsDraft, registerButton }: SettingsPanelProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Settings</Text>
      <Text dimColor>A narrow terminal hides more parts of a row.</Text>
      {SETTINGS.map(({ key, label }, index) => (
        <Box key={key} ref={registerButton(`setting:${key}`)}>
          <Box width={2} flexShrink={0}>
            <Text color={BRAND} bold>
              {index === cursor ? "❯" : " "}
            </Text>
          </Box>
          <Text color={settings[key] ? "green" : undefined} dimColor={!settings[key]}>
            {settings[key] ? "[x]" : "[ ]"}
          </Text>
          <Text wrap="truncate-end"> {label}</Text>
        </Box>
      ))}
      <Box ref={registerButton("setting:authors")}>
        <Box width={2} flexShrink={0}>
          <Text color={BRAND} bold>
            {cursor === AUTHORS_LINE ? "❯" : " "}
          </Text>
        </Box>
        {authorsDraft === undefined ? (
          <Text wrap="truncate-end">
            Authors: {settings.authors.join(", ")} <Text dimColor>· a login, @me, or app/&lt;slug&gt; for a GitHub App</Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            Authors: <Text color={BRAND}>{authorsDraft}</Text>
            <Text inverse> </Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

function sourceNote(source: QuotaSource | undefined, options: Options): string {
  if (!source) return "";
  const name = source.pr.startsWith(`${options.org}/`) ? source.pr.slice(options.org.length + 1) : source.pr;
  return ` · read on ${name} at ${formatTime(source.at)}`;
}

function formatDuration(ms: number, precise: boolean): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (precise) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatAgo(now: Date, at: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
