import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const cacheDir = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'boo');

const fileName = (key: string) => `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

/**
 * A cache on disk that all the runs of boo on this machine share: a terminal watch, a scheduled run,
 * the watch of an agent. Each read or write that fails acts as a cache miss, so the cache never stops a run.
 */
export class DiskCache {
  constructor(private readonly dir = cacheDir()) {}

  /** Returns the value and its age, if the value is younger than `maxAgeMs`. */
  async get<T>(key: string, maxAgeMs: number, now = Date.now()): Promise<{ value: T; at: number } | undefined> {
    if (maxAgeMs <= 0) return undefined;
    try {
      const { at, value } = JSON.parse(await readFile(join(this.dir, fileName(key)), 'utf8')) as {
        at: number;
        value: T;
      };
      return typeof at === 'number' && now - at < maxAgeMs && now >= at ? { value, at } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Takes a claim that only one run gets, for `ttlMs`: the first run that creates the file wins. An
   * older claim expires. If the cache folder is not usable, every run gets the claim.
   */
  async claim(key: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    const path = join(this.dir, `${fileName(key)}.claim`);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      return true;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // "wx" fails if the file exists, so two runs cannot both create it.
        await (await open(path, 'wx', 0o600)).close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return true;
        const age = await stat(path).then(
          (stats) => now - stats.mtimeMs,
          () => Infinity,
        );
        if (age < ttlMs) return false;
        await rm(path, { force: true });
      }
    }
    return false;
  }

  /** Gives a claim back, for example after a failed post: the next run can take it at once. */
  async release(key: string): Promise<void> {
    await rm(join(this.dir, `${fileName(key)}.claim`), { force: true }).catch(() => {});
  }

  // Two runs can write one key at the same time. A rename replaces the file in one step, so a reader never sees half a file.
  async set(key: string, value: unknown, now = Date.now()): Promise<void> {
    const path = join(this.dir, fileName(key));
    const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // The entries hold the data of private repositories: only the owner of the files reads them.
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ at: now, value }), { mode: 0o600 });
      await rename(temporary, path);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

/** The part of a cache that `cachedRead` uses. */
export interface ReadCache {
  get<T>(key: string, maxAgeMs: number): Promise<{ value: T } | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Returns the cached value if it is younger than `maxAgeMs`. Else calls `read`, and caches its result. */
export async function cachedRead<T>(
  cache: ReadCache,
  key: string,
  maxAgeMs: number,
  read: () => Promise<T>,
): Promise<T> {
  const cached = await cache.get<T>(key, maxAgeMs);
  if (cached) return cached.value;
  const value = await read();
  await cache.set(key, value);
  return value;
}
