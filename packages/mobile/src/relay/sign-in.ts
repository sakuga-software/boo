import { closeRelaySession, connectRelay, type RelayConnection } from '@sakuga-software/boo-core/relay';

/** What the sign-in screen shows. */
export type SignInStep =
  | { step: 'starting' }
  /** The person types `userCode` on `verificationUri`. The relay polls GitHub meanwhile. */
  | { step: 'code'; userCode: string; verificationUri: string; opened: boolean }
  /** Signed in, but the user reads no installation of the App. The relay polls for one. */
  | { step: 'install'; installUrl: string }
  | { step: 'failed'; message: string };

export interface SignInDeps {
  relayUrl: string;
  githubUrl?: string;
  fetch: typeof fetch;
  /** Opens a page in the in-app browser. It must not wait for the browser to close. */
  openBrowser: (url: string) => void;
  copy: (text: string) => Promise<void>;
  onStep: (step: SignInStep) => void;
  /** The tests give a fake clock and fake timers. */
  now?: () => number;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  timeoutMs?: number;
}

export interface SignIn {
  /** Resolves with the connection, or with `undefined` after `cancel`. Rejects when the sign-in fails. */
  done: Promise<RelayConnection | undefined>;
  /** Copies the code and opens the page of GitHub where the person types it. */
  openGitHub(): Promise<void>;
  /** Opens the page that installs the App. */
  openInstall(): void;
  /** Stops the wait for an installation, and keeps the session. */
  later(): void;
  /** Stops the sign-in. A session that the relay opened meanwhile is deleted. */
  cancel(): void;
}

class Cancelled extends Error {}

/**
 * Runs the device flow of core (`connectRelay`) for a screen. The host functions of core map to the
 * screen: `onCode` shows the code; `open` of the GitHub page does nothing, because the person opens
 * it with a button; `open` of the install page shows the install step.
 */
export function startSignIn(deps: SignInDeps): SignIn {
  const now = deps.now ?? Date.now;
  const later = deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
  const clear = deps.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let step: SignInStep = { step: 'starting' };
  let cancelled = false;
  // `connectRelay` waits for an installation until its clock passes an end. `later` moves the clock to
  // the end: core then returns the connection, and says that no installation exists yet.
  let skipped = false;
  // A cancel after the relay opened the session also ends the wait: the session is deleted after it.
  const stopWait = () => skipped || (cancelled && step.step === 'install');
  const wakes = new Set<() => void>();
  const show = (next: SignInStep) => {
    step = next;
    deps.onStep(next);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      // A cancel during the code step stops the device flow: no session exists yet.
      if (cancelled && step.step !== 'install') return reject(new Cancelled());
      if (stopWait()) return resolve();
      const wake = () => {
        clear(timer);
        wakes.delete(wake);
        if (cancelled && step.step !== 'install') reject(new Cancelled());
        else resolve();
      };
      const timer = later(wake, ms);
      wakes.add(wake);
    });

  const wakeAll = () => [...wakes].forEach((wake) => wake());

  const done = (async () => {
    show(step);
    try {
      const connection = await connectRelay(deps.relayUrl, {
        fetch: deps.fetch,
        log: () => {},
        sleep,
        now: () => (stopWait() ? Number.POSITIVE_INFINITY : now()),
        onCode: ({ userCode, verificationUri }) => show({ step: 'code', userCode, verificationUri, opened: false }),
        open: async (url) => {
          if (step.step === 'code' && url === step.verificationUri) return;
          show({ step: 'install', installUrl: url });
        },
        ...(deps.githubUrl && { githubUrl: deps.githubUrl }),
        ...(deps.timeoutMs && { timeoutMs: deps.timeoutMs }),
      });
      if (!cancelled) return connection;
      // The person cancelled while the relay opened the session.
      await closeRelaySession(connection, { fetch: deps.fetch, log: () => {} });
      return undefined;
    } catch (error) {
      if (error instanceof Cancelled) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      show({ step: 'failed', message });
      throw error;
    }
  })();

  return {
    done,
    async openGitHub() {
      if (step.step !== 'code') return;
      const { userCode, verificationUri } = step;
      // The page asks for the code: the person pastes it.
      await deps.copy(userCode).catch(() => {});
      deps.openBrowser(verificationUri);
      if (step.step === 'code') show({ ...step, opened: true });
    },
    openInstall() {
      if (step.step === 'install') deps.openBrowser(step.installUrl);
    },
    later() {
      skipped = true;
      wakeAll();
    },
    cancel() {
      cancelled = true;
      wakeAll();
    },
  };
}
