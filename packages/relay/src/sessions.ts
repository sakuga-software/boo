import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GitHubUser, Tokens } from './github.js';

export interface Session {
  /** The SHA-256 of the session token. The relay never keeps the token itself. */
  id: string;
  user: GitHubUser;
  tokens: Tokens;
  createdAt: string;
}

interface StoredSession extends Omit<Session, 'tokens'> {
  /** The tokens of the user, encrypted with AES-256-GCM: `iv.tag.data`, each in base64url. */
  tokens: string;
}

export const sessionId = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Keeps the sessions in one JSON file, with the GitHub tokens encrypted. A write goes to a temporary
 * file first, then replaces the file: a stop during a write keeps the last complete file.
 */
export class SessionStore {
  private readonly key: Buffer;
  private sessions = new Map<string, Session>();
  private writing = Promise.resolve();

  constructor(
    private readonly file: string,
    secret: string,
  ) {
    this.key = createHash('sha256').update(secret).digest();
  }

  async load(): Promise<void> {
    const text = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    });
    const stored = JSON.parse(text) as StoredSession[];
    this.sessions = new Map(
      stored.map((session) => [session.id, { ...session, tokens: this.decrypt(session.tokens) }]),
    );
  }

  /** Creates a session and returns its token. The caller gives the token to the watch once. */
  async create(user: GitHubUser, tokens: Tokens, now = new Date()): Promise<{ token: string; session: Session }> {
    const token = randomBytes(32).toString('base64url');
    const session = { id: sessionId(token), user, tokens, createdAt: now.toISOString() };
    this.sessions.set(session.id, session);
    try {
      await this.save();
    } catch (error) {
      // A session that the file does not keep must not work until the next restart.
      this.sessions.delete(session.id);
      throw error;
    }
    return { token, session };
  }

  get size(): number {
    return this.sessions.size;
  }

  byToken(token: string): Session | undefined {
    return this.sessions.get(sessionId(token));
  }

  async update(id: string, tokens: Tokens): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.tokens = tokens;
    await this.save();
  }

  async delete(id: string): Promise<void> {
    if (this.sessions.delete(id)) await this.save();
  }

  private save(): Promise<void> {
    const stored: StoredSession[] = [...this.sessions.values()].map((session) => ({
      ...session,
      tokens: this.encrypt(session.tokens),
    }));
    // The writes go one after the other, so an older write cannot replace a newer one. A write that
    // fails rejects only its own caller: the next write still runs.
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 });
        await rename(temporary, this.file);
      });
    return this.writing;
  }

  private encrypt(tokens: Tokens): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
  }

  private decrypt(value: string): Tokens {
    const [iv = '', tag = '', data = ''] = value.split('.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const text = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    return JSON.parse(text) as Tokens;
  }
}
