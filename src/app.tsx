import { Box, Text, useApp, useInput, useStdin, useStdout, useWindowSize, type DOMElement } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { setTimeout as sleep } from "node:timers/promises";
import { ACTIONS, actionForKey, commandBody, moveSelection, refusal, reselect, type Action, type Command } from "./actions.js";
import { BOT_LOGIN, botReplied, decide, quotaScope, quotaSignals, type Comment, type Decision, type QuotaSignal, type QuotaSource } from "./decide.js";
import * as github from "./github.js";
import type { PullRequest, PullRequestSnapshot } from "./github.js";
import { createMouseParser, DISABLE_MOUSE, ENABLE_MOUSE, isMouseFragment } from "./mouse.js";
import { summarize, type Overall, type Reviewer, type ReviewerStatus, type Summary } from "./reviewers.js";
import { planSync, type LeftStatus } from "./sync.js";
import { visibleRange } from "./viewport.js";

export interface Options {
  org: string;
  author: string;
  since?: string;
  watch: boolean;
  dryRun: boolean;
  interactive: boolean;
}

interface Row {
  pr: PullRequest;
  /** The CodeRabbit decision, which drives the automatic retries. */
  decision?: Decision;
  summary?: Summary;
  activity?: "loading" | { posting: Command };
  posted?: { command: Command; url: string };
  error?: string;
  left?: LeftStatus;
  fetched?: Omit<PullRequestSnapshot, "status">;
}

export type GitHub = Pick<typeof github, "listPullRequests" | "fetchPullRequest" | "postCommand" | "openInBrowser" | "mergePullRequest">;

export interface Timing {
  replyPollMs: number;
  replyTimeoutMs: number;
  watchPollMs: number;
  listRefreshMs: number;
}

const DEFAULT_TIMING: Timing = { replyPollMs: 5_000, replyTimeoutMs: 90_000, watchPollMs: 30_000, listRefreshMs: 60_000 };
const REPOST_GUARD_MS = 15 * 60_000;
const BRAND = "#8B5CF6";
const REVIEW_COMMANDS: readonly Command[] = ["review", "full review"];
// GitHub mergeable_state values that deserve a warning before a merge.
const MERGE_STATE_WARNINGS: Record<string, string> = {
  dirty: "conflicts with the base branch",
  blocked: "blocked by the branch protection rules",
  behind: "behind the base branch",
  unknown: "GitHub has not computed the merge state yet",
};
// Lines outside the list in interactive mode: the header, the margin, the scroll hints and the footer.
const CHROME_LINES = 12;

const keyOf = (pr: PullRequest) => `${pr.repo}#${pr.number}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const rowHeight = (row: Row, view: View, expanded: boolean) =>
  2 + (row.summary ? 1 : 0) + (expanded && view.detail ? 1 : 0) + (row.posted ? 1 : 0);

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
  post(pr: PullRequest, command: Command): Promise<void>;
  refresh(pr: PullRequest): Promise<unknown>;
}

interface AppProps {
  options: Options;
  gitHub?: GitHub;
  timing?: Timing;
}

export function App(props: AppProps) {
  // The workflow posts comments. If a new prop restarts it, it posts again and loses its repost guard.
  // Thus the component keeps the props of its first render.
  const [{ options, gitHub, timing }] = useState(() => ({
    options: props.options,
    gitHub: props.gitHub ?? github,
    timing: props.timing ?? DEFAULT_TIMING,
  }));
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const { rows: screenRows } = useWindowSize();
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
  const [hideLeft, setHideLeft] = useState(false);
  const hideLeftRef = useRef(false);
  const pendingEscape = useRef<NodeJS.Timeout>(undefined);
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
    const lastPosts = new Map<string, { at: number; before: Comment[] }>();
    let postLock = Promise.resolve();

    const update = (pr: PullRequest, patch: Partial<Row>) => {
      const key = keyOf(pr);
      rowsRef.current.set(key, { ...rowsRef.current.get(key)!, ...patch });
      setRows([...rowsRef.current.values()]);
    };
    const rowOf = (pr: PullRequest) => rowsRef.current.get(keyOf(pr))!;

    // The CodeRabbit quota belongs to the developer. Posts go one at a time. Each post waits until
    // reply polling finishes or times out. A new rate limit blocks the developer's other pull requests too.
    function exclusive(task: () => Promise<void>): Promise<void> {
      const run = postLock.then(() => {
        signal.throwIfAborted();
        return task();
      });
      postLock = run.catch(() => {});
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
        return rowOf(pr).decision;
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

    async function post(pr: PullRequest, command: Command): Promise<boolean> {
      const commentsBefore = rowOf(pr).fetched?.comments ?? [];
      update(pr, { activity: { posting: command } });
      try {
        const url = await gitHub.postCommand(pr, command);
        if (REVIEW_COMMANDS.includes(command)) lastPosts.set(keyOf(pr), { at: Date.now(), before: commentsBefore });
        update(pr, { activity: undefined, posted: { command, url } });
      } catch (error) {
        update(pr, { activity: undefined, error: message(error) });
        return false;
      }
      // The reply of CodeRabbit lands in the comments. The next redecide() applies it to every row.
      await waitForReply(pr);
      return true;
    }

    controls.current = {
      refresh,
      post: (pr, command) =>
        exclusive(async () => {
          // The post can wait in the queue for minutes. The pull request can close in that time.
          if (rowOf(pr).left) {
            setFlash({ text: `Cannot post on ${keyOf(pr)}: this pull request is no longer open.`, color: "yellow" });
            return;
          }
          const posted = await post(pr, command);
          setFlash(
            posted
              ? { text: `Posted "${commandBody(command)}" on ${keyOf(pr)}.`, color: "green" }
              : { text: `Could not post on ${keyOf(pr)}.`, color: "red" },
          );
        }).catch((error) => {
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
          if (unanswered(row, lastPosts.get(keyOf(pr)))) return;
          if (await post(pr, "review")) setTriggered((count) => count + 1);
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
      const listed = new Map((await gitHub.listPullRequests(options)).map((pr) => [keyOf(pr), pr]));
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
  const shownRows = hideLeft ? (rows ?? []).filter((row) => !row.left) : (rows ?? []);
  const keys = shownRows.map((row) => keyOf(row.pr));
  const selection = reselect(allKeys, keys, selected);
  const hiddenCount = allKeys.length - keys.length;

  // Several keys can arrive in one input chunk and run with the closure of one render.
  // The handlers below read and write these refs, so each key sees what the previous key did.
  function live() {
    const all = [...rowsRef.current.values()];
    const everyKey = all.map((row) => keyOf(row.pr));
    const shownKeys = all.filter((row) => !hideLeftRef.current || !row.left).map((row) => keyOf(row.pr));
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
  }, [rows, hideLeft]);

  function toggleHidden() {
    const inactive = [...rowsRef.current.values()].filter((row) => row.left).length;
    const hide = !hideLeftRef.current;
    hideLeftRef.current = hide;
    setHideLeft(hide);
    select(live().key);
    setFlash(
      hide
        ? { text: `Hiding ${inactive} merged, closed or draft pull request${inactive === 1 ? "" : "s"}.`, color: "gray" }
        : { text: "Showing all the pull requests.", color: "gray" },
    );
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
    const coderabbit = row.decision === undefined ? undefined : row.decision.kind !== "unseen";
    return { left: row.left !== undefined, dryRun: options.dryRun, ...(coderabbit !== undefined && { coderabbit }) };
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
    if (!action.command) {
      gitHub.openInBrowser(row.pr.url).then(
        () => setFlash({ text: `Opened ${key} in the browser.`, color: "green" }),
        (error) => setFlash({ text: `Could not open ${key}: ${message(error)}`, color: "red" }),
      );
      return;
    }
    const quota =
      REVIEW_COMMANDS.includes(action.command) && row.decision?.kind === "wait"
        ? `The CodeRabbit quota comes back at ${formatTime(row.decision.availableAt)}: CodeRabbit will likely refuse.`
        : undefined;
    setFlash(undefined);
    confirm({ key, action, warning: quota });
  }

  function answer(yes: boolean) {
    const pending = confirmationRef.current;
    confirm(undefined);
    if (!pending?.action.command && !pending?.action.merge) return;
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
    setFlash({ text: `Posting "${commandBody(pending.action.command!)}" on ${pending.key}…`, color: "blue" });
    void controls.current?.post(row.pr, pending.action.command!);
  }

  function press(id: string) {
    if (id === "yes" || id === "no") return answer(id === "yes");
    if (confirmationRef.current) return;
    if (id === "h") return toggleHidden();
    const action = actionForKey(id);
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
    if (char === "k") move(-1);
    else if (char === "j") move(1);
    else if (char === "\r") press("o");
    else if (char === "q") exit();
    else press(char);
  }

  useInput(
    (input, key) => {
      if (isMouseFragment(input)) return;
      // The raw stdin listener handles a lone "m": only the mouse parser knows if it ends a split report.
      if (input === "m") return;
      if (key.upArrow) return confirmationRef.current ? undefined : move(-1);
      if (key.downArrow) return confirmationRef.current ? undefined : move(1);
      if (key.return) return typeKey("\r");
      // A terminal can split a mouse report after its Escape byte, and Ink then reports a lone Escape.
      // Wait a moment: if the rest of a mouse report follows, the Escape was part of it.
      if (key.escape) {
        clearTimeout(pendingEscape.current);
        const prompt = confirmationRef.current;
        pendingEscape.current = setTimeout(() => {
          if (prompt && confirmationRef.current === prompt) typeKey("\u001B");
        }, 60);
        return;
      }
      // A paste must answer at most one prompt, and never a prompt that it opened itself.
      // The rest of the chunk stops when a key opens or closes a prompt.
      for (const char of input) {
        const hadPrompt = confirmationRef.current !== undefined;
        typeKey(char);
        if (hadPrompt !== (confirmationRef.current !== undefined)) break;
      }
    },
    { isActive: options.interactive },
  );

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [flash]);

  const handlers = useRef({ press, move, select, typeKey });
  handlers.current = { press, move, select, typeKey };

  useEffect(() => {
    if (!options.interactive) return;
    const disable = () => stdout.write(DISABLE_MOUSE);
    stdout.write(ENABLE_MOUSE);
    process.once("exit", disable);
    const feed = createMouseParser((event) => {
      if (event.kind === "wheel") return handlers.current.move(event.direction === "up" ? -1 : 1);
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
  const range = options.interactive
    ? visibleRange(shownRows.map((row) => rowHeight(row, views.get(row)!, expanded(row))), selectedIndex, Math.max(3, screenRows - CHROME_LINES), scrollStart.current)
    : { start: 0, end: shownRows.length };
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
    <Box flexDirection="column" paddingX={1}>
      <Header options={options} mood={fatal ? "failed" : done ? "done" : nextCheckAt ? "sleeping" : "checking"} now={clock} nextCheckAt={nextCheckAt} />
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
          No open pull request by {options.author}{options.org ? ` in ${options.org}` : ""}{options.since ? ` since ${formatDay(options.since)}` : ""}.
        </Text>
      )}
      {rows && rows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {options.interactive && (
            <Text dimColor>{range.start > 0 ? `  ↑ ${range.start} more` : " "}</Text>
          )}
          {shownRows.length === 0 && (
            <Text dimColor>
              All {rows.length} pull requests are hidden. Press h to show them.
            </Text>
          )}
          {shownRows.slice(range.start, range.end).map((row) => (
            <RowView
              key={keyOf(row.pr)}
              ref={registerRow(keyOf(row.pr))}
              row={row}
              view={views.get(row)!}
              options={options}
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
          hideLeft={hideLeft}
          hiddenCount={hiddenCount}
        />
      )}
    </Box>
  );
}

type Mood = "checking" | "sleeping" | "done" | "failed";

const FACES: Record<Mood, { eyes: [string, string]; mouth: string }> = {
  checking: { eyes: ["ò", "ó"], mouth: "v" },
  sleeping: { eyes: ["-", "-"], mouth: "ᴗ" },
  done: { eyes: ["^", "^"], mouth: "v" },
  failed: { eyes: ["x", "x"], mouth: "~" },
};
// Mid tones: the ghost must read on a dark and on a light terminal background.
const GHOST = { line: BRAND, crown: "#EAB308", face: "#6D28D9" };

interface HeaderProps {
  options: Options;
  mood: Mood;
  now: Date;
  nextCheckAt?: Date;
}

function Ghost({ mood }: { mood: Mood }) {
  const { eyes: [left, right], mouth } = FACES[mood];
  return (
    <Box flexDirection="column" width={10} flexShrink={0}>
      <Text color={GHOST.crown} bold>
        {"   wWw"}
      </Text>
      <Text color={GHOST.line}> ╭─────╮</Text>
      <Text color={GHOST.line}>
        (
        <Text color={GHOST.face} bold>
          {` ${left} ${mouth} ${right} `}
        </Text>
        )
      </Text>
      <Text color={GHOST.line}> ╰─────╯</Text>
    </Box>
  );
}

function Header({ options, mood, now, nextCheckAt }: HeaderProps) {
  const status = !options.watch || mood === "done" || mood === "failed"
    ? " "
    : `${nextCheckAt ? `next check in ${formatDuration(nextCheckAt.getTime() - now.getTime(), true)}` : "checking…"}${options.interactive ? "" : " · Ctrl+C to quit"}`;
  const scope = [options.author, options.org || "all organizations", options.since && `since ${formatDay(options.since)}`].filter(Boolean);
  return (
    <Box>
      <Ghost mood={mood} />
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
    const command = row.activity.posting;
    return {
      icon: spinner("blue"),
      label: command === "review" ? "retrying" : "posting",
      color: "blue",
      detail: `"${commandBody(command)}"…`,
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

function ChecksBadge({ summary }: { summary: Summary }) {
  const { checks } = summary;
  const counted = checks.passed + checks.failed.length + checks.pending;
  if (checks.failed.length > 0) return <Text color="red">✖ {checks.failed.length}/{counted} failing</Text>;
  if (checks.pending > 0) return <Text color="yellow">◌ {checks.pending}/{counted} running</Text>;
  if (counted === 0) {
    if (checks.skipped > 0) return <Text dimColor>⊘ {checks.skipped} skipped</Text>;
    return <Text dimColor>{checks.quota > 0 ? `◷ ${checks.quota} quota only` : "no checks"}</Text>;
  }
  return <Text color="green">✔ {checks.passed}/{counted} checks</Text>;
}

interface RowViewProps {
  ref: (node: DOMElement | null) => void;
  row: Row;
  view: View;
  options: Options;
  now: Date;
  expanded: boolean;
  selected: boolean;
}

function RowView({ ref, row, view, options, now, expanded, selected }: RowViewProps) {
  const name = options.org && row.pr.repo.startsWith(`${options.org}/`) ? row.pr.repo.slice(options.org.length + 1) : row.pr.repo;
  const indent = options.interactive ? 24 : 22;
  const summary = row.summary;
  return (
    <Box ref={ref} flexDirection="column" marginBottom={1}>
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
        <Box width={19} flexShrink={0}>
          <Text color={view.color} bold>
            {view.label}
          </Text>
        </Box>
        <Box flexShrink={0} marginRight={2}>
          <Text bold inverse={selected}>
            {name}#{row.pr.number}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{row.pr.title}</Text>
        </Box>
        {summary && !row.left && (
          <Box flexShrink={0} marginLeft={2}>
            <ChecksBadge summary={summary} />
            <Text dimColor>
              {"  "}
              {summary.reviewers.length > 0 && `${summary.onHead}/${summary.reviewers.length} on head · `}
              {summary.reviews} review{summary.reviews === 1 ? "" : "s"}
            </Text>
          </Box>
        )}
      </Box>
      {summary && (
        <Box paddingLeft={indent}>
          {summary.lastReview ? (
            <Box flexShrink={0} marginRight={2}>
              <Text dimColor>
                last {summary.lastReview.name} {formatAgo(now, summary.lastReview.at)}
              </Text>
            </Box>
          ) : (
            <Box flexShrink={0} marginRight={2}>
              <Text dimColor>{summary.reviewers.length === 0 ? "no reviewer yet" : "no review yet"}</Text>
            </Box>
          )}
          <Box flexShrink={1} overflow="hidden">
            {summary.reviewers.map((reviewer) => (
              <ReviewerChip key={reviewer.login} reviewer={reviewer} />
            ))}
          </Box>
        </Box>
      )}
      {expanded && view.detail && (
        <Box paddingLeft={indent}>
          <Text dimColor wrap="truncate-end">
            {view.detail}
          </Text>
        </Box>
      )}
      {row.posted && (
        <Box paddingLeft={indent}>
          <Text color="green" wrap="truncate-end">
            ↻ {commandBody(row.posted.command)} → {row.posted.url}
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
  hideLeft: boolean;
  hiddenCount: number;
}

function Button({ id, hotkey, label, dim, register }: { id: string; hotkey: string; label: string; dim?: boolean; register: ControlsProps["registerButton"] }) {
  return (
    <Box ref={register(id)} marginRight={2} flexShrink={0}>
      <Text dimColor={dim}>
        <Text color={dim ? undefined : BRAND} bold>
          {hotkey}
        </Text>{" "}
        {label}
      </Text>
    </Box>
  );
}

function Controls({ confirmation, flash, registerButton, disabledCommands, hideLeft, hiddenCount }: ControlsProps) {
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
                  Post <Text bold>"{commandBody(confirmation.action.command!)}"</Text> on{" "}
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
          <Box>
            {ACTIONS.filter((action) => !action.command).map((action) => (
              <Button key={action.key} id={action.key} hotkey={action.key} label={action.label} dim={disabledCommands && action.merge} register={registerButton} />
            ))}
            <Button
              id="h"
              hotkey="h"
              label={hideLeft ? `show ${hiddenCount} hidden` : "hide inactive"}
              register={registerButton}
            />
            <Box marginRight={1} flexShrink={0}>
              <Text dimColor>CodeRabbit</Text>
            </Box>
            {ACTIONS.filter((action) => action.command).map((action) => (
              <Button key={action.key} id={action.key} hotkey={action.key} label={action.label} dim={disabledCommands} register={registerButton} />
            ))}
            <Text dimColor wrap="truncate-end">↑↓ q</Text>
          </Box>
          <Text color={flash?.color} wrap="truncate-end">
            {flash?.text ?? " "}
          </Text>
        </>
      )}
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
