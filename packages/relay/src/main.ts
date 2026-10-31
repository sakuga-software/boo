import { createServer } from 'node:http';
import { join } from 'node:path';
import { gitHubApi } from './github.js';
import { createRelay } from './server.js';
import { SessionStore } from './sessions.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Set ${name}: see the README of packages/relay.`);
    process.exit(2);
  }
  return value;
}

const clientId = required('GITHUB_APP_CLIENT_ID');
const store = new SessionStore(
  join(process.env.RELAY_DATA_DIR || './data', 'sessions.json'),
  required('RELAY_ENCRYPTION_KEY'),
);
await store.load();

const { handle } = createRelay({
  gitHub: gitHubApi({ clientId, clientSecret: required('GITHUB_APP_CLIENT_SECRET') }),
  store,
  webhookSecret: required('GITHUB_WEBHOOK_SECRET'),
  clientId,
  appSlug: required('GITHUB_APP_SLUG'),
});

const port = Number(process.env.PORT || 3000);
const server = createServer(handle);
// An event stream stays open for hours. The default timeouts of Node would cut it.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(port, () => console.log(`boo-relay listens on port ${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
