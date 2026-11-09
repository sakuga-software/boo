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

/** What a sub-agent does, from the last message of its transcript. */
export type SubAgentState = 'working' | 'done' | 'failed' | 'stopped';

/**
 * A sub-agent of a session. `description` is the task that the session gave to it. `error` tells why
 * a failed sub-agent stopped, for example "rate limit".
 */
export interface SubAgent {
  id: string;
  description?: string;
  state: SubAgentState;
  error?: string;
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

// Claude Code reports "shell" while the session runs a command.
export const isWorkingStatus = (status: string) => status === 'busy' || status === 'shell';

/** The sub-agent works on the pull request of the owner. If the owner has no sub-agent, the session works on it. */
export const ownerWorks = (owner: Owner) =>
  owner.subAgent ? owner.subAgent.state === 'working' : isWorkingStatus(owner.session.status);
