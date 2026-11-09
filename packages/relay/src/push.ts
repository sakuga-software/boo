import type { WatchEvent } from '@sakuga-software/boo-core/events';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { PUSH_STATES, pushOn, type PushState } from '@sakuga-software/boo-core/settings';
import { SessionExpired } from './access.js';
import type { Reports, UserState } from './reports.js';
import type { Session } from './sessions.js';
import type { PushMark, StateStore } from './state-store.js';

/** The Expo push service. `EXPO_PUSH_URL` replaces it, for example with a fake service in a test. */
export const EXPO_URL = 'https://exp.host';

/** Expo takes at most 100 messages in one request. */
export const CHUNK_SIZE = 100;

/** Expo takes at most 1000 ids in one request of receipts. */
const RECEIPT_CHUNK_SIZE = 1000;

/**
 * How long Expo has to answer one request. No second try: a request that runs out of time can still
 * have been delivered, and a second send rings each phone twice.
 */
const TIMEOUT_MS = 15_000;

/** A push token of Expo, as `getExpoPushTokenAsync` gives it. */
export const PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[\w-]{1,200}\]$/;

/** One message for one phone, in the format of the Expo push service. */
export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  /** `url` is the screen that a tap opens. */
  data: { url: string; pr?: string; state?: PushState };
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** What a send gives: the tokens that Expo does not know, and the ids of the tickets to read later. */
export interface SendResult {
  accepted: number;
  unregistered: string[];
  /** The id of each ticket, with its token: the receipt of a ticket can say that the token is not registered. */
  tickets: Map<string, string>;
  errors: string[];
}

export interface ExpoPush {
  send(messages: readonly ExpoMessage[]): Promise<SendResult>;
  /** The tokens whose receipt says `DeviceNotRegistered`. */
  receipts(tickets: ReadonlyMap<string, string>): Promise<{ unregistered: string[]; errors: string[] }>;
}

const notRegistered = (ticket: Pick<ExpoTicket, 'details'> | undefined) =>
  ticket?.details?.error === 'DeviceNotRegistered';

/**
 * Sends the messages with a plain `fetch`, in chunks of 100. A failed chunk does not stop the next one,
 * and a send never throws: a push is a side effect of a change of state.
 */
export function expoPush({
  url = EXPO_URL,
  accessToken,
  fetch: request = fetch,
}: { url?: string; accessToken?: string; fetch?: typeof fetch } = {}): ExpoPush {
  const base = url.replace(/\/+$/, '');
  const post = (path: string, body: unknown) =>
    request(`${base}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(accessToken && { authorization: `Bearer ${accessToken}` }),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  return {
    async send(messages) {
      const result: SendResult = { accepted: 0, unregistered: [], tickets: new Map(), errors: [] };
      for (let start = 0; start < messages.length; start += CHUNK_SIZE) {
        const chunk = messages.slice(start, start + CHUNK_SIZE);
        let tickets: ExpoTicket[];
        try {
          const response = await post('/--/api/v2/push/send', chunk);
          if (!response.ok) {
            await response.body?.cancel();
            result.errors.push(`Expo answered ${response.status}`);
            continue;
          }
          tickets = ((await response.json()) as { data?: ExpoTicket[] }).data ?? [];
        } catch (error) {
          result.errors.push(`Expo failed: ${reason(error)}`);
          continue;
        }
        chunk.forEach(({ to }, index) => {
          const ticket = tickets[index];
          if (ticket?.status === 'ok') {
            result.accepted++;
            if (ticket.id) result.tickets.set(ticket.id, to);
            return;
          }
          if (notRegistered(ticket)) result.unregistered.push(to);
          result.errors.push(`Expo refused a phone: ${ticket?.details?.error ?? ticket?.message ?? 'no ticket'}`);
        });
      }
      return result;
    },
    async receipts(tickets) {
      const ids = [...tickets.keys()];
      const unregistered: string[] = [];
      const errors: string[] = [];
      for (let start = 0; start < ids.length; start += RECEIPT_CHUNK_SIZE) {
        try {
          const response = await post('/--/api/v2/push/getReceipts', {
            ids: ids.slice(start, start + RECEIPT_CHUNK_SIZE),
          });
          if (!response.ok) {
            await response.body?.cancel();
            errors.push(`Expo answered ${response.status}`);
            continue;
          }
          const receipts = ((await response.json()) as { data?: Record<string, ExpoTicket> }).data ?? {};
          for (const [id, receipt] of Object.entries(receipts)) {
            const token = tickets.get(id);
            if (token && notRegistered(receipt)) unregistered.push(token);
          }
        } catch (error) {
          errors.push(`Expo failed: ${reason(error)}`);
        }
      }
      return { unregistered, errors };
    },
  };
}

/** The states of a report that give a push notification, by the `state` of the report. */
const STATE_PUSHES: Readonly<Record<string, PushState>> = {
  'ready to merge': 'ready',
  'changes requested': 'changesRequested',
  'checks failing': 'checksFailing',
  conflicts: 'conflicts',
  merged: 'merged',
};

const LABELS = Object.fromEntries(PUSH_STATES.map(({ key, label }) => [key, label])) as Record<PushState, string>;

/**
 * The push of a change from `before` to `after`: the new state, if the state changed to one that
 * gives a push; else `stalled`, if the pull request starts to stall.
 */
export function pushOf(before: PushMark, after: PushMark): PushState | undefined {
  if (after.state !== before.state) {
    const push = STATE_PUSHES[after.state];
    if (push) return push;
  }
  return after.stalled && !before.stalled ? 'stalled' : undefined;
}

const markOf = (report: Pick<PullRequestReport, 'state' | 'stalled'>): PushMark => ({
  state: report.state,
  stalled: report.stalled,
});
const prOf = (report: Pick<PullRequestReport, 'repo' | 'number'>) => `${report.repo}#${report.number}`;
const sameMark = (a: PushMark, b: PushMark) => a.state === b.state && a.stalled === b.stalled;

/** The screen of the pull request in the app: `boo://pull/<owner>/<repo>/<number>`. */
export const pullUrl = ({ repo, number }: Pick<PullRequestReport, 'repo' | 'number'>) =>
  `boo://pull/${repo.split('/').map(encodeURIComponent).join('/')}/${number}`;

// A notification shows a few lines: a longer text is cut, and APNs refuses a payload over 4 kB.
const MAX_TEXT = 180;
const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/** A change of state to tell the user. */
interface Note {
  report: PullRequestReport;
  push: PushState;
}

/** More changes than this in one window give one notification that counts them. */
export const MAX_SINGLE = 3;

/** The messages of the changes of one window, for one phone. */
export function messagesOf(notes: readonly Note[], token: string): ExpoMessage[] {
  if (notes.length > MAX_SINGLE) {
    const lines = notes.slice(0, 5).map(({ report, push }) => `${LABELS[push]}: ${prOf(report)}`);
    if (notes.length > 5) lines.push(`and ${notes.length - 5} more`);
    return [
      {
        to: token,
        title: `${notes.length} pull requests changed`,
        body: lines.join('\n'),
        sound: 'default',
        data: { url: 'boo://' },
      },
    ];
  }
  return notes.map(({ report, push }) => {
    let details = '';
    if (push === 'checksFailing' && report.checks.failing.length > 0)
      details = `\nFailing: ${report.checks.failing.join(', ')}`;
    else if (push === 'merged' && report.mergedBy) details = `\nMerged by ${report.mergedBy}`;
    return {
      to: token,
      title: `${LABELS[push]}: ${prOf(report)}`,
      body: cut(`${report.title || prOf(report)}${details}`),
      sound: 'default',
      data: { url: pullUrl(report), pr: prOf(report), state: push },
    };
  });
}

export interface PushOptions {
  store: StateStore;
  reports: Pick<Reports, 'onChange'>;
  sessions: { get(id: string): Session | undefined };
  /** The repositories that a session reads: a phone gets only the pull requests that its user can read. */
  access: { repos(session: Session): Promise<Set<string>> };
  expo: ExpoPush;
  /** The changes of a user during this time go out together. */
  windowMs?: number;
  /** The time after a send when the relay reads the receipts of Expo. */
  receiptsAfterMs?: number;
  log?: (message: string) => void;
  error?: (error: unknown) => void;
}

/** A pull request that changed in the current window, and its mark before the window. */
interface Pending {
  report: PullRequestReport;
  before: PushMark | undefined;
}

/**
 * Sends a push notification to the phones of a user when one of their pull requests changes to a
 * state that the user turned on (#114).
 *
 * - **What changed.** `diffReports` of core, through the events of `Reports`: a `state` or `left`
 *   event, or a `snapshot` for a pull request that starts to stall.
 * - **No spam.** The changes of a user wait `windowMs`, then go out together: the last state of each
 *   pull request, one notification each, or one that counts them all above `MAX_SINGLE`. A pull
 *   request that goes back to its state of before the window gives nothing.
 * - **No duplicate.** The last state that the notifications saw is kept in SQLite for each user and
 *   each pull request (`push_marks`). A change gives a notification only if it differs from that
 *   mark, so a restart of the relay sends nothing twice. The first computation after a start compares
 *   each report with its mark: a change during the stop gives its notification once.
 */
export class PushNotifier {
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; prs: Map<string, Pending> }>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  private readonly windowMs: number;
  private readonly receiptsAfterMs: number;
  private readonly log: (message: string) => void;
  private readonly error: (error: unknown) => void;

  constructor(private readonly options: PushOptions) {
    this.windowMs = options.windowMs ?? 30_000;
    this.receiptsAfterMs = options.receiptsAfterMs ?? 15 * 60_000;
    this.log = options.log ?? ((message) => console.log(message));
    this.error = options.error ?? ((error) => console.error(error));
    this.unsubscribe = options.reports.onChange((login, before, after, events) => {
      // A listener that throws would stop the computation of the reports.
      try {
        this.onChange(login, before, after, events);
      } catch (error) {
        this.error(error);
      }
    });
  }

  private onChange(login: string, before: UserState | undefined, after: UserState, events: readonly WatchEvent[]) {
    const { store } = this.options;
    if (!before) {
      // The first computation of the user since the start of the relay gives no event: each report is
      // compared with its mark. A report with no mark is new to the notifications: it gives none.
      for (const report of after.reports) {
        const mark = store.pushMark(login, report);
        if (!mark) store.setPushMark(login, report, markOf(report));
        else if (!sameMark(mark, markOf(report))) this.add(login, report, undefined);
      }
      return;
    }
    const named = new Set(
      events
        .filter((event) => event.event === 'state' || event.event === 'left' || event.event === 'snapshot')
        .map((event) => event.pr),
    );
    // A pull request that the user no longer follows (new settings, closed with no read) gives nothing,
    // even if it changed earlier in the window.
    for (const event of events) if (event.event === 'left' && event.reason === 'unlisted') this.cancel(login, event.pr);
    const previous = new Map(before.reports.map((report) => [prOf(report), report]));
    for (const report of after.reports) {
      const old = previous.get(prOf(report));
      // A pull request that enters the list, or enters it again, starts from its state now: it is not
      // a change, and a mark of the time before it left must not hide the next change.
      if (!old) store.setPushMark(login, report, markOf(report));
      else if (named.has(prOf(report)) || old.stalled !== report.stalled) this.add(login, report, markOf(old));
    }
  }

  private cancel(login: string, pr: string): void {
    const window = this.pending.get(login);
    if (!window?.prs.delete(pr) || window.prs.size > 0) return;
    clearTimeout(window.timer);
    this.pending.delete(login);
  }

  private add(login: string, report: PullRequestReport, before: PushMark | undefined): void {
    let window = this.pending.get(login);
    if (!window) {
      const timer = setTimeout(() => this.flush(login), this.windowMs);
      timer.unref();
      window = { timer, prs: new Map() };
      this.pending.set(login, window);
    }
    const known = window.prs.get(prOf(report));
    window.prs.set(prOf(report), { report, before: known ? known.before : before });
  }

  /** Sends the changes of the window of `login` now. The tests and the stop of the relay call it. */
  flush(login: string): Promise<void> {
    const window = this.pending.get(login);
    if (!window) return Promise.resolve();
    clearTimeout(window.timer);
    this.pending.delete(login);
    const run = this.send(login, [...window.prs.values()])
      .catch((error: unknown) => this.error(error))
      .finally(() => this.running.delete(run));
    this.running.add(run);
    return run;
  }

  private async send(login: string, changed: readonly Pending[]): Promise<void> {
    const { store, sessions, access, expo } = this.options;
    const settings = store.config(login)?.settings;
    const notes: Note[] = [];
    for (const { report, before } of changed) {
      const mark = store.pushMark(login, report) ?? before;
      const after = markOf(report);
      store.setPushMark(login, report, after);
      const push = mark && pushOf(mark, after);
      if (push && settings && pushOn(settings, push)) notes.push({ report, push });
    }
    if (notes.length === 0) return;
    const bySession = new Map<string, string[]>();
    for (const { token, session } of store.devicesOf(login))
      bySession.set(session, [...(bySession.get(session) ?? []), token]);
    const outgoing: { session: string; message: ExpoMessage }[] = [];
    for (const [id, tokens] of bySession) {
      const session = sessions.get(id);
      if (!session) {
        store.removeSessionDevices(id);
        continue;
      }
      let repos: Set<string>;
      try {
        // In lower case, as `report.repo` below.
        repos = await access.repos(session);
      } catch (error) {
        // With no list of the repositories, the phone could get a pull request that its user cannot read.
        // The change is not sent again later: see the README (a second try could ring twice).
        if (error instanceof SessionExpired) store.removeSessionDevices(id);
        else this.error(error);
        continue;
      }
      const readable = notes.filter(({ report }) => repos.has(report.repo.toLowerCase()));
      if (readable.length > 0)
        for (const token of tokens)
          for (const message of messagesOf(readable, token)) outgoing.push({ session: id, message });
    }
    const total = { sent: 0, accepted: 0, tickets: new Map<string, string>() };
    for (let start = 0; start < outgoing.length; start += CHUNK_SIZE) {
      // The reads of the access and the earlier chunks take time: a phone can sign out, or sign in as
      // another user, meanwhile. Each token must still belong to the session that read the access.
      const chunk = outgoing
        .slice(start, start + CHUNK_SIZE)
        .filter(({ session, message }) => store.sessionOfDevice(message.to) === session && sessions.get(session))
        .map(({ message }) => message);
      if (chunk.length === 0) continue;
      const result = await expo.send(chunk);
      total.sent += chunk.length;
      total.accepted += result.accepted;
      for (const [id, token] of result.tickets) total.tickets.set(id, token);
      for (const error of result.errors) this.log(`Push: ${error}`);
      this.drop(result.unregistered);
    }
    if (total.sent === 0) return;
    this.log(`Push: ${total.accepted} of ${total.sent} notifications accepted by Expo for ${login}`);
    if (total.tickets.size > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        const run = expo
          .receipts(total.tickets)
          .then(({ unregistered, errors }) => {
            for (const error of errors) this.log(`Push: ${error}`);
            this.drop(unregistered);
          })
          .catch((error: unknown) => this.error(error))
          .finally(() => this.running.delete(run));
        this.running.add(run);
      }, this.receiptsAfterMs);
      timer.unref();
      this.timers.add(timer);
    }
  }

  private drop(unregistered: readonly string[]): void {
    // A phone gets one message for each pull request: Expo can refuse its token several times.
    const tokens = [...new Set(unregistered)];
    if (tokens.length === 0) return;
    this.options.store.removeTokens(tokens);
    this.log(`Push: removed ${tokens.length} tokens that Expo does not know any more (DeviceNotRegistered)`);
  }

  /** Waits for the sends and the reads of receipts that run. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running);
  }

  /** Stops the windows and the reads of receipts. The changes that wait are not sent. */
  stop(): void {
    this.unsubscribe();
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
