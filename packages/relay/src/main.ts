import { createServer } from 'node:http';
import { join } from 'node:path';
import { gitHubApi } from './github.js';
import { installationReader } from './installations.js';
import { EXPO_URL, expoPush } from './push.js';
import { Reports } from './reports.js';
import { createRelay } from './server.js';
import { SessionStore } from './sessions.js';
import { StateStore } from './state-store.js';
import { pullReader, Tracker } from './tracker.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Set ${name}: see the README of packages/relay.`);
    process.exit(2);
  }
  return value;
}

const clientId = required('GITHUB_APP_CLIENT_ID');
const dataDir = process.env.RELAY_DATA_DIR || './data';
const store = new SessionStore(join(dataDir, 'sessions.json'), required('RELAY_ENCRYPTION_KEY'));
await store.load();

// The last state of the pull requests (#105) needs the key of the App: the reads use its
// installation tokens (D2). With no key, the relay only relays the webhooks.
const appId = process.env.GITHUB_APP_ID?.trim();
// A key in one line of an env file has "\n" in place of its line breaks.
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim().replaceAll('\\n', '\n');
const apiUrl = process.env.GITHUB_API_URL?.trim().replace(/\/+$/, '') || 'https://api.github.com';
const LIST_EVERY_MS = 10 * 60_000;
const PURGE_EVERY_MS = 60 * 60_000;
// The states that depend on time (a CodeRabbit wait that ends, a pull request that stalls) change
// with no webhook: the reports are computed again at this interval.
const REPORTS_EVERY_MS = 60_000;
let state: { store: StateStore; tracker: Tracker; reports: Reports } | undefined;
if (appId && privateKey) {
  const installations = installationReader({ appId, privateKey }, { apiUrl });
  const stateStore = new StateStore(join(dataDir, 'state.db'));
  const reports = new Reports(stateStore);
  const tracker = new Tracker({
    store: stateStore,
    reader: pullReader(installations, { apiUrl }),
    accounts: async () => [...(await installations.installations()).keys()],
    onRead: (pr) => reports.refreshFollowers(pr),
    onList: (login) => reports.refresh(login),
  });
  state = { store: stateStore, tracker, reports };
  setInterval(() => reports.refreshAll(), REPORTS_EVERY_MS).unref();
  const purge = () => {
    const deleted = stateStore.purge(Date.now());
    if (deleted > 0) console.log(`Deleted ${deleted} pull requests closed or unfollowed for 7 days`);
  };
  purge();
  setInterval(purge, PURGE_EVERY_MS).unref();
} else console.log('No GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY: the relay keeps no state of the pull requests.');

// #114: the push notifications go through the Expo push service. EXPO_ACCESS_TOKEN is needed only if
// the Expo project turns on the enhanced security of push.
const expoAccessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
const expo = expoPush({
  url: process.env.EXPO_PUSH_URL?.trim() || EXPO_URL,
  ...(expoAccessToken && { accessToken: expoAccessToken }),
});
const windowSetting = Number(process.env.RELAY_PUSH_WINDOW_MS);
const pushWindowMs = windowSetting > 0 ? windowSetting : undefined;

const { handle, push } = createRelay({
  gitHub: gitHubApi({ clientId, clientSecret: required('GITHUB_APP_CLIENT_SECRET') }, fetch, Date.now, apiUrl),
  store,
  webhookSecret: required('GITHUB_WEBHOOK_SECRET'),
  clientId,
  appSlug: required('GITHUB_APP_SLUG'),
  ...(state && { state, push: { expo, ...(pushWindowMs && { windowMs: pushWindowMs }) } }),
});

// The reads start after `createRelay`: the push notifications must see the first computation of the
// reports, to compare it with the last state that they saw before the stop.
if (state) {
  const { tracker } = state;
  // The first lists read every pull request again: a change during the stop gave no webhook.
  void tracker.refreshAll({ readAll: true });
  setInterval(() => void tracker.refreshAll(), LIST_EVERY_MS).unref();
}

const port = Number(process.env.PORT || 3000);
const server = createServer(handle);
// An event stream stays open for hours. The default timeouts of Node would cut it.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(port, () => console.log(`boo-relay listens on port ${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    push?.stop();
    state?.tracker.stop();
    state?.store.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
