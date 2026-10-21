import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A Claude Code session that runs on this machine. Claude Code writes one record for each session in
 * ~/.claude/sessions/<pid>.json. This format and the inbox protocol below are internal to Claude Code:
 * a new version can change them, so each reader here gives up without an error.
 */
export interface LocalSession {
  pid: number;
  sessionId: string;
  name: string;
  /** busy, idle, waiting or shell, as Claude Code reports it. */
  status: string;
  /** What the session waits for, for example "input needed". */
  waitingFor?: string;
  cwd: string;
  /** The Unix socket of the inbox of the session. */
  socket: string;
}

/** The local session that works on a pull request: the live session that linked it last. */
export interface Owner {
  session: LocalSession;
  linkedAt: Date;
}

export const claudeHome = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Reads one session record. Returns undefined if the session has stopped or has no inbox. */
export function parseSession(value: unknown, alive: (pid: number) => boolean = isAlive): LocalSession | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { pid, sessionId, messagingSocketPath: socket, cwd } = record;
  if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof socket !== 'string' || !socket)
    return undefined;
  if (!alive(pid)) return undefined;
  const text = (field: unknown) => (typeof field === 'string' ? field : undefined);
  const waitingFor = text(record.waitingFor);
  return {
    pid,
    sessionId,
    name: text(record.name) || sessionId.slice(0, 8),
    status: text(record.status) ?? 'unknown',
    ...(waitingFor && { waitingFor }),
    cwd: text(cwd) ?? '',
    socket,
  };
}

export async function listSessions(home = claudeHome()): Promise<LocalSession[]> {
  const dir = join(home, 'sessions');
  const files = await readdir(dir).catch(() => []);
  const records = await Promise.all(
    files
      .filter((file) => /^\d+\.json$/.test(file))
      .map((file) =>
        readFile(join(dir, file), 'utf8')
          .then((text) => parseSession(JSON.parse(text)))
          .catch(() => undefined),
      ),
  );
  return records.filter((session) => session !== undefined);
}

const PR_LINK = '"type":"pr-link"';

/** Reads the pull request links in the complete lines of a part of a transcript. */
export function parseLinks(text: string): { pr: string; at: Date }[] {
  return text
    .split('\n')
    .filter((line) => line.includes(PR_LINK))
    .flatMap((line) => {
      try {
        const { prRepository, prNumber, timestamp } = JSON.parse(line) as Record<string, unknown>;
        const at = new Date(String(timestamp));
        if (typeof prRepository !== 'string' || typeof prNumber !== 'number' || Number.isNaN(at.getTime())) return [];
        return [{ pr: `${prRepository}#${prNumber}`, at }];
      } catch {
        return [];
      }
    });
}

// A transcript can weigh hundreds of megabytes. Claude Code writes a link again each time that the
// session looks at its pull request, so the last part of the file has the links that matter.
const FIRST_READ_BYTES = 64 * 1024 * 1024;

interface Transcript {
  path: string;
  /** The end of the last complete line that the index read. */
  offset: number;
  links: Map<string, Date>;
}

/** Keeps the pull request links of each transcript, and reads only the new lines at each update. */
export class LinkIndex {
  private readonly transcripts = new Map<string, Transcript>();

  constructor(private readonly home = claudeHome()) {}

  /** Returns the pull requests that the session linked, with the time of the last link. */
  async linksOf(sessionId: string): Promise<Map<string, Date>> {
    const transcript = this.transcripts.get(sessionId) ?? (await this.find(sessionId));
    if (!transcript) return new Map();
    await this.readNew(transcript).catch(() => {});
    return transcript.links;
  }

  private async find(sessionId: string): Promise<Transcript | undefined> {
    const projects = join(this.home, 'projects');
    for (const project of await readdir(projects).catch(() => [])) {
      const path = join(projects, project, `${sessionId}.jsonl`);
      const size = await stat(path).then(
        (stats) => stats.size,
        () => undefined,
      );
      if (size === undefined) continue;
      const transcript = { path, offset: Math.max(0, size - FIRST_READ_BYTES), links: new Map<string, Date>() };
      this.transcripts.set(sessionId, transcript);
      return transcript;
    }
    return undefined;
  }

  private async readNew(transcript: Transcript) {
    const file = await open(transcript.path);
    try {
      const { size } = await file.stat();
      // A shorter file is a new file: the links of the old one no longer count.
      if (size < transcript.offset) {
        transcript.offset = 0;
        transcript.links.clear();
      }
      const length = size - transcript.offset;
      if (length === 0) return;
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, transcript.offset);
      const end = buffer.lastIndexOf(0x0a);
      if (end === -1) return;
      for (const { pr, at } of parseLinks(buffer.subarray(0, end).toString('utf8'))) {
        const known = transcript.links.get(pr);
        if (!known || known < at) transcript.links.set(pr, at);
      }
      transcript.offset += end + 1;
    } finally {
      await file.close();
    }
  }
}

/** Gives each pull request the live session that linked it last. */
export function pickOwners(links: readonly { session: LocalSession; links: Map<string, Date> }[]): Map<string, Owner> {
  const owners = new Map<string, Owner>();
  for (const { session, links: linked } of links) {
    for (const [pr, linkedAt] of linked) {
      const known = owners.get(pr);
      if (!known || known.linkedAt < linkedAt) owners.set(pr, { session, linkedAt });
    }
  }
  return owners;
}

/** Reads the local sessions, and returns the session that works on each pull request, by "owner/repo#number". */
export async function readOwners(index: LinkIndex, home = claudeHome()): Promise<Map<string, Owner>> {
  const sessions = await listSessions(home);
  return pickOwners(
    await Promise.all(sessions.map(async (session) => ({ session, links: await index.linksOf(session.sessionId) }))),
  );
}

const MESSAGE_TAG = 'cross-session-message';

/** The two lines that put a message in the inbox of a session: the token of the inbox, then the message. */
export function inboxFrames(session: LocalSession, token: string, text: string, id = randomUUID()): string {
  // Claude Code shows the message as one from another session with this name. It has no reply address.
  const content = `<${MESSAGE_TAG} from-name="boo">\n${text}\n</${MESSAGE_TAG}>`;
  const message = {
    msgV: 1,
    msg_id: id,
    type: 'user',
    message: { role: 'user', content },
    priority: 'next',
    session_id: session.sessionId,
  };
  return `${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify(message)}\n`;
}

async function inboxToken(session: LocalSession, home: string): Promise<string> {
  const dir = join(home, 'sessions');
  const keys = (await readdir(dir)).filter((file) => file.startsWith(`${session.pid}.`) && file.endsWith('.key'));
  if (keys.length !== 1) throw new Error(`${session.name} has ${keys.length === 0 ? 'no' : 'more than one'} inbox key`);
  const { peerToken } = JSON.parse(await readFile(join(dir, keys[0]!), 'utf8')) as { peerToken?: unknown };
  if (typeof peerToken !== 'string') throw new Error(`the inbox key of ${session.name} has no token`);
  return peerToken;
}

/**
 * Puts a message in the inbox of a session. The session reads it after its current turn, as a message
 * from another session. Claude Code does not run a slash command that comes this way.
 */
export async function sendToSession(session: LocalSession, text: string, home = claudeHome()): Promise<void> {
  const frames = inboxFrames(session, await inboxToken(session, home), text);
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ path: session.socket });
    // The send succeeds after the write. A later timeout, close or error must not report a failure:
    // the session has the message, and a second send would put the prompt twice in the session.
    socket.setTimeout(5_000, () => socket.destroy(new Error(`${session.name} did not take the connection in time`)));
    socket.on('error', reject);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.write(frames, (error) => {
        if (error) return reject(error);
        resolve();
        // Claude Code waits 150 ms before it ends its own sends on macOS. boo does the same.
        setTimeout(() => socket.end(), 150);
      });
    });
  });
}
