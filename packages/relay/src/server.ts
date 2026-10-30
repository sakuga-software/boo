import type { IncomingMessage, ServerResponse } from 'node:http';
import { Access, SessionExpired } from './access.js';
import { changesAccess, changesOf } from './events.js';
import type { GitHubApi } from './github.js';
import { Hub, type RelayEvent, type Subscriber } from './hub.js';
import type { Session, SessionStore } from './sessions.js';
import { validSignature } from './signature.js';

export interface RelayOptions {
  gitHub: GitHubApi;
  store: SessionStore;
  webhookSecret: string;
  clientId: string;
  /** The slug of the App in its URL: `github.com/apps/<slug>`. */
  appSlug: string;
  accessTtlMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

// GitHub caps a webhook payload at 25 MB.
const MAX_BODY_BYTES = 26 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createRelay(options: RelayOptions) {
  const { gitHub, store, webhookSecret, clientId, appSlug, heartbeatMs = 25_000 } = options;
  const hub = new Hub(10_000, () => new Date((options.now ?? Date.now)()));
  const access = new Access(store, gitHub, options.accessTtlMs, options.now);
  const streams = new Map<ServerResponse, { session: Session; stop: () => void }>();

  /** Reads the access of the stream again if it is stale. A session that expired ends the stream. */
  function checkAccess(response: ServerResponse, session: Session): void {
    access.repos(session).catch((error: unknown) => {
      if (error instanceof SessionExpired) endStream(response, 'expired', error.message);
      else console.error(error);
    });
  }

  function refreshStreams(): void {
    for (const [response, { session }] of streams) checkAccess(response, session);
  }

  function endStream(response: ServerResponse, event: string, message: string): void {
    streams.get(response)?.stop();
    if (!response.writableEnded) response.end(`event: ${event}\ndata: ${JSON.stringify({ message })}\n\n`);
  }

  async function onWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (!validSignature(webhookSecret, body, header(request, 'x-hub-signature-256')))
      throw new HttpError(401, 'The signature does not match the webhook secret');
    const type = header(request, 'x-github-event') ?? '';
    const payload = parseJson<Record<string, unknown>>(body);
    if (changesAccess(type)) {
      access.invalidateAll();
      refreshStreams();
    }
    const changes = changesOf(type, payload);
    for (const change of changes) hub.publish(change);
    json(response, 202, { relayed: changes.length });
  }

  async function onCreateSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = parseJson<{ accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown }>(
      await readBody(request),
    );
    if (typeof body.accessToken !== 'string' || !body.accessToken) throw new HttpError(400, 'accessToken is missing');
    const user = await gitHub.checkToken(body.accessToken);
    if (!user) throw new HttpError(401, 'The token does not belong to the GitHub App of this relay');
    const now = (options.now ?? Date.now)();
    const { token } = await store.create(user, {
      accessToken: body.accessToken,
      ...(typeof body.refreshToken === 'string' && { refreshToken: body.refreshToken }),
      ...(typeof body.expiresIn === 'number' && { expiresAt: now + body.expiresIn * 1000 }),
    });
    json(response, 201, { session: token, login: user.login });
  }

  async function onInstallations(session: Session, response: ServerResponse): Promise<void> {
    const installations = await access.withToken(session, (token) => gitHub.installations(token));
    json(response, 200, { installations, installUrl: installUrl(appSlug) });
  }

  async function onEvents(request: IncomingMessage, response: ServerResponse, session: Session): Promise<void> {
    // The client can leave during the read of its access. Then no stream starts.
    let left = false;
    let stop = () => {};
    response.once('close', () => {
      left = true;
      stop();
    });
    // If GitHub fails, the stream opens with no valid access: it gets no change, and each heartbeat
    // reads the access again. A session that expired gets its 401.
    await access.repos(session).catch((error: unknown) => {
      if (error instanceof SessionExpired) throw error;
      console.error(error);
    });
    if (left) return;
    // A DELETE of the session can come during the read of the access.
    if (!store.has(session.id)) {
      access.forget(session.id);
      throw new HttpError(401, 'The session was deleted');
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // A proxy must send each event at once, not hold it in a buffer.
      'x-accel-buffering': 'no',
    });
    const write = (event: RelayEvent) => {
      const { id, ...change } = event;
      response.write(`id: ${id}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`);
    };
    // While the access is not valid, the stream drops events. When the access is valid again, a
    // reset tells the watch to read all, because it cannot know what it missed.
    let dropped = false;
    const subscriber: Subscriber = {
      reads: (repo) => {
        const repos = access.kept(session.id);
        if (!repos) dropped = true;
        return repos?.has(repo.toLowerCase()) ?? false;
      },
      send: write,
    };
    const heartbeat = setInterval(() => {
      // An error in a timer stops the process: a stream that fails must stop alone.
      try {
        if (response.destroyed || response.writableEnded) return stop();
        if (dropped && access.kept(session.id)) {
          dropped = false;
          response.write('event: reset\ndata: {}\n\n');
        }
        response.write(': ping\n\n');
        checkAccess(response, session);
      } catch (error) {
        console.error(error);
        stop();
      }
    }, heartbeatMs);
    // `stop` exists before the subscription, so a failure after this line leaves no subscriber.
    stop = () => {
      clearInterval(heartbeat);
      hub.unsubscribe(subscriber);
      streams.delete(response);
    };
    streams.set(response, { session, stop });
    const lastEventId = header(request, 'last-event-id');
    const resumed = hub.subscribe(subscriber, lastEventId);
    response.write(`event: ready\ndata: ${JSON.stringify({ login: session.user.login })}\n\n`);
    // A resume with no valid access cannot know which missed events the session may read.
    if (resumed === 'reset' || (lastEventId && !access.kept(session.id))) response.write('event: reset\ndata: {}\n\n');
    else resumed.missed.forEach(write);
  }

  function authenticate(request: IncomingMessage): Session {
    const token = /^Bearer (.+)$/i.exec(header(request, 'authorization') ?? '')?.[1];
    const session = token && store.byToken(token);
    if (!session) throw new HttpError(401, 'No session: run boo setup-webhooks');
    return session;
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://relay').pathname;
    const route = `${request.method} ${path}`;
    switch (route) {
      case 'GET /':
        return json(response, 200, { name: 'boo-relay', clientId, installUrl: installUrl(appSlug) });
      case 'GET /healthz':
        return json(response, 200, { ok: true, streams: streams.size });
      case 'POST /webhooks':
        return onWebhook(request, response);
      case 'POST /sessions':
        return onCreateSession(request, response);
      case 'DELETE /sessions': {
        const session = authenticate(request);
        for (const [stream, open] of streams)
          if (open.session.id === session.id) endStream(stream, 'expired', 'The session was deleted');
        access.forget(session.id);
        await store.delete(session.id);
        response.writeHead(204).end();
        return;
      }
      case 'GET /installations':
        return onInstallations(authenticate(request), response);
      case 'GET /events':
        return onEvents(request, response, authenticate(request));
      default:
        throw new HttpError(404, `No route for ${route}`);
    }
  }

  function handle(request: IncomingMessage, response: ServerResponse): void {
    route(request, response).catch((error: unknown) => {
      const status = statusOf(error);
      const message = error instanceof Error && status !== 500 ? error.message : 'The relay failed';
      if (status === 500) console.error(error);
      if (response.headersSent) response.end();
      else json(response, status, { error: message });
    });
  }

  return { handle, hub };
}

function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof SessionExpired) return 401;
  return 500;
}

const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function parseJson<T>(body: Buffer): T {
  try {
    return JSON.parse(body.toString('utf8') || '{}') as T;
  } catch {
    throw new HttpError(400, 'The body is not valid JSON');
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'The body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
