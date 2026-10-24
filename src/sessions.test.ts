import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  inboxFrames,
  LinkIndex,
  parseLinks,
  parseSession,
  pickOwners,
  sendToSession,
  type LocalSession,
} from './sessions.js';

const session = (patch: Partial<LocalSession> = {}): LocalSession => ({
  pid: 100,
  sessionId: '2cfd7a83-3513-4010-8817-eb44d1dddd28',
  name: 'suricarte',
  status: 'idle',
  cwd: '/work',
  socket: '/tmp/cc-socks/100.sock',
  ...patch,
});

const link = (pr: number, at: string) =>
  JSON.stringify({ type: 'pr-link', prNumber: pr, prRepository: 'acme/web', timestamp: at });

test('a session record gives a session only if it is live and has an inbox', () => {
  const record = { pid: 100, sessionId: 'abc', messagingSocketPath: '/tmp/s.sock', kind: 'interactive', name: 'web' };
  assert.equal(parseSession(record, () => true)?.name, 'web');
  assert.equal(parseSession({ ...record, kind: 'background' }, () => true)?.name, 'web');
  assert.equal(
    parseSession(record, () => false),
    undefined,
  );
  assert.equal(
    parseSession({ ...record, messagingSocketPath: '' }, () => true),
    undefined,
  );
  assert.equal(
    parseSession('broken', () => true),
    undefined,
  );
});

test('the links come from the pr-link lines only', () => {
  const text = [
    link(12, '2026-10-20T10:00:00Z'),
    '{"type":"assistant","message":"see \\"type\\":\\"pr-link\\""}',
    '{"type":"pr-link",',
    link(13, 'not a date'),
  ].join('\n');
  assert.deepEqual(parseLinks(text), [{ pr: 'acme/web#12', at: new Date('2026-10-20T10:00:00Z') }]);
});

test('each pull request goes to the session that linked it last', () => {
  const early = session({ name: 'early' });
  const late = session({ name: 'late' });
  const owners = pickOwners([
    { session: early, links: new Map([['acme/web#1', new Date('2026-10-20T10:00:00Z')]]) },
    {
      session: late,
      links: new Map([
        ['acme/web#1', new Date('2026-10-20T11:00:00Z')],
        ['acme/web#2', new Date('2026-10-20T09:00:00Z')],
      ]),
    },
  ]);
  assert.equal(owners.get('acme/web#1')?.session.name, 'late');
  assert.equal(owners.get('acme/web#2')?.session.name, 'late');
});

test('the index reads only the complete lines, then the new ones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boo-sessions-'));
  const id = session().sessionId;
  const path = join(home, 'projects', '-work', `${id}.jsonl`);
  await mkdir(join(home, 'projects', '-work'), { recursive: true });
  await writeFile(path, `${link(1, '2026-10-20T10:00:00Z')}\n${link(2, '2026-10-20T10:01:00Z').slice(0, 20)}`);
  const index = new LinkIndex(home);
  assert.deepEqual([...(await index.linksOf(id)).keys()], ['acme/web#1']);
  await appendFile(path, `${link(2, '2026-10-20T10:01:00Z').slice(20)}\n${link(1, '2026-10-20T12:00:00Z')}\n`);
  const links = await index.linksOf(id);
  assert.deepEqual([...links.keys()], ['acme/web#1', 'acme/web#2']);
  assert.deepEqual(links.get('acme/web#1'), new Date('2026-10-20T12:00:00Z'));
  await writeFile(path, `${link(3, '2026-10-20T13:00:00Z')}\n`);
  assert.deepEqual([...(await index.linksOf(id)).keys()], ['acme/web#3']);
  assert.equal((await index.linksOf('missing')).size, 0);
});

test('a message to a session sends the token of its inbox, then a user message for that session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boo-inbox-'));
  await mkdir(join(home, 'sessions'));
  await writeFile(join(home, 'sessions', '100.abc123.key'), JSON.stringify({ peerToken: 'secret' }));
  const socket = join(home, 'inbox.sock');
  const received = new Promise<string>((resolve) => {
    const server = createServer((connection) => {
      let data = '';
      connection.on('data', (chunk) => (data += chunk));
      connection.on('end', () => {
        server.close();
        resolve(data);
      });
    });
    server.listen(socket);
  });
  await sendToSession(session({ socket }), 'Rebase the branch.', home);
  const [auth, message] = (await received)
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(auth, { type: 'auth', token: 'secret' });
  assert.equal(message.type, 'user');
  assert.equal(message.session_id, session().sessionId);
  assert.equal(
    message.message.content,
    '<cross-session-message from-name="boo">\nRebase the branch.\n</cross-session-message>',
  );
});

test('a session with no inbox key gets no message', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boo-inbox-'));
  await mkdir(join(home, 'sessions'));
  await assert.rejects(sendToSession(session(), 'hello', home), /no inbox key/);
  const id = '00000000-0000-4000-8000-000000000000';
  assert.match(inboxFrames(session(), 't', 'hello', id), new RegExp(`"msg_id":"${id}"`));
});

test('a send ends after the write, even if the session keeps its side of the connection open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boo-inbox-'));
  await mkdir(join(home, 'sessions'));
  await writeFile(join(home, 'sessions', '100.abc123.key'), JSON.stringify({ peerToken: 'secret' }));
  const socket = join(home, 'inbox.sock');
  const connections: Socket[] = [];
  const server = createServer({ allowHalfOpen: true }, (connection) => void connections.push(connection));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const started = Date.now();
  await sendToSession(session({ socket }), 'hello', home);
  assert.ok(Date.now() - started < 2_000);
  for (const connection of connections) connection.destroy();
  server.close();
});
