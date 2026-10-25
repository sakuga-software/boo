import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** A sub-agent of a session. `description` is the task that the session gave to it. */
export interface SubAgent {
  id: string;
  description?: string;
}

/**
 * The local session that works on a pull request: the live session that linked it last. `subAgent` is
 * the sub-agent of that session that changed the pull request last.
 */
export interface Owner {
  session: LocalSession;
  linkedAt: Date;
  subAgent?: SubAgent;
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

// Claude Code writes the pr-link lines only in the transcript of the session, also for a pull request
// of a sub-agent. The transcript of a sub-agent keeps the output of its commands: `gh pr create`,
// `edit` and `comment` print the URL of the pull request.
const PR_WRITE = /\bgh pr (?:create|edit|comment|ready|merge|review)\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

interface ContentPart {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: { command?: unknown };
  tool_use_id?: unknown;
  content?: unknown;
}

const partsOf = (line: string): { parts: ContentPart[]; at: Date } => {
  try {
    const { message, timestamp } = JSON.parse(line) as { message?: { content?: unknown }; timestamp?: unknown };
    const parts = Array.isArray(message?.content) ? (message.content as ContentPart[]) : [];
    return { parts, at: new Date(String(timestamp)) };
  } catch {
    return { parts: [], at: new Date(Number.NaN) };
  }
};

/**
 * Reads the pull requests that a sub-agent changed with `gh pr`, in the complete lines of a part of its
 * transcript. `commands` keeps the ids of the `gh pr` commands that have no output yet, from one part
 * to the next.
 */
export function parseSubAgentActions(text: string, commands: Set<string>): { pr: string; at: Date }[] {
  const actions: { pr: string; at: Date }[] = [];
  for (const line of text.split('\n')) {
    const use = line.includes('"tool_use"') && line.includes('gh pr ');
    const result = commands.size > 0 && line.includes('"tool_result"');
    if (!use && !result) continue;
    const { parts, at } = partsOf(line);
    for (const part of parts) {
      if (part.type === 'tool_use' && typeof part.id === 'string' && PR_WRITE.test(String(part.input?.command ?? '')))
        commands.add(part.id);
      if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string' || !commands.delete(part.tool_use_id))
        continue;
      // gh prints the URL of the pull request on the last line.
      const last = [...JSON.stringify(part.content ?? '').matchAll(PR_URL)].at(-1);
      if (last && !Number.isNaN(at.getTime())) actions.push({ pr: `${last[1]}#${last[2]}`, at });
    }
  }
  return actions;
}

// A transcript can weigh hundreds of megabytes. Claude Code writes a link again each time that the
// session looks at its pull request, so the last part of the file has the links that matter.
const FIRST_READ_BYTES = 64 * 1024 * 1024;

interface Tail {
  path: string;
  /** The end of the last complete line that the index read. */
  offset: number;
}

/** Returns the complete lines after `offset`, and moves `offset` after them. `reset` runs if the file got shorter. */
async function readNewLines(tail: Tail, reset: () => void): Promise<string | undefined> {
  const file = await open(tail.path);
  try {
    const { size } = await file.stat();
    // A shorter file is a new file: what the index read from the old one no longer counts.
    if (size < tail.offset) {
      tail.offset = 0;
      reset();
    }
    const length = size - tail.offset;
    if (length === 0) return undefined;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, tail.offset);
    const end = buffer.lastIndexOf(0x0a);
    if (end === -1) return undefined;
    tail.offset += end + 1;
    return buffer.subarray(0, end).toString('utf8');
  } finally {
    await file.close();
  }
}

const keepLast = (links: Map<string, Date>, pr: string, at: Date) => {
  const known = links.get(pr);
  if (!known || known < at) links.set(pr, at);
};

interface Transcript extends Tail {
  links: Map<string, Date>;
}

interface SubAgentTranscript extends Tail {
  subAgent: SubAgent;
  commands: Set<string>;
  actions: Map<string, Date>;
}

/** The sub-agent that changed a pull request last, by "owner/repo#number". */
export type SubAgentActions = Map<string, { subAgent: SubAgent; at: Date }>;

/** Keeps the pull request links of each transcript, and reads only the new lines at each update. */
export class LinkIndex {
  private readonly transcripts = new Map<string, Transcript>();
  private readonly subAgents = new Map<string, SubAgentTranscript>();

  constructor(private readonly home = claudeHome()) {}

  /** Returns the pull requests that the session linked, with the time of the last link. */
  async linksOf(sessionId: string): Promise<Map<string, Date>> {
    const transcript = this.transcripts.get(sessionId) ?? (await this.find(sessionId));
    if (!transcript) return new Map();
    const text = await readNewLines(transcript, () => transcript.links.clear()).catch(() => undefined);
    for (const { pr, at } of parseLinks(text ?? '')) keepLast(transcript.links, pr, at);
    return transcript.links;
  }

  /** Returns the pull requests that the sub-agents of the session changed, with the sub-agent that changed each one last. */
  async subAgentsOf(sessionId: string): Promise<SubAgentActions> {
    const transcript = this.transcripts.get(sessionId) ?? (await this.find(sessionId));
    const actions: SubAgentActions = new Map();
    if (!transcript) return actions;
    const dir = join(dirname(transcript.path), sessionId, 'subagents');
    const files = (await readdir(dir).catch(() => [])).filter((file) => /^agent-[\w-]+\.jsonl$/.test(file));
    for (const file of files) {
      const path = join(dir, file);
      const agent = this.subAgents.get(path) ?? (await this.addSubAgent(path));
      const text = await readNewLines(agent, () => agent.actions.clear()).catch(() => undefined);
      for (const { pr, at } of parseSubAgentActions(text ?? '', agent.commands)) keepLast(agent.actions, pr, at);
      for (const [pr, at] of agent.actions) {
        const known = actions.get(pr);
        if (!known || known.at < at) actions.set(pr, { subAgent: agent.subAgent, at });
      }
    }
    return actions;
  }

  private async addSubAgent(path: string): Promise<SubAgentTranscript> {
    const id = path.replace(/^.*\/agent-|\.jsonl$/g, '');
    const description = await readFile(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')
      .then((text) => (JSON.parse(text) as { description?: unknown }).description)
      .catch(() => undefined);
    const subAgent = {
      id,
      ...(typeof description === 'string' && description.trim() && { description: description.trim() }),
    };
    const agent = { path, offset: 0, subAgent, commands: new Set<string>(), actions: new Map<string, Date>() };
    this.subAgents.set(path, agent);
    return agent;
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
}

/** Gives each pull request the live session that linked it last, and the sub-agent of that session that changed it last. */
export function pickOwners(
  links: readonly { session: LocalSession; links: Map<string, Date>; subAgents?: SubAgentActions }[],
): Map<string, Owner> {
  const owners = new Map<string, Owner>();
  for (const { session, links: linked, subAgents } of links) {
    for (const [pr, linkedAt] of linked) {
      const known = owners.get(pr);
      const subAgent = subAgents?.get(pr)?.subAgent;
      if (!known || known.linkedAt < linkedAt) owners.set(pr, { session, linkedAt, ...(subAgent && { subAgent }) });
    }
  }
  return owners;
}

/** Reads the local sessions, and returns the session that works on each pull request, by "owner/repo#number". */
export async function readOwners(index: LinkIndex, home = claudeHome()): Promise<Map<string, Owner>> {
  const sessions = await listSessions(home);
  return pickOwners(
    await Promise.all(
      sessions.map(async (session) => ({
        session,
        links: await index.linksOf(session.sessionId),
        subAgents: await index.subAgentsOf(session.sessionId).catch(() => new Map()),
      })),
    ),
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
