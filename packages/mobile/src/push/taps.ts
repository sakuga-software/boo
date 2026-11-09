/** The part of a notification that the relay fills: `url` is the screen that a tap opens. */
const SEGMENT = /^[\w.-]+$/;

/**
 * The screen of the app for the `url` of a notification of the relay: `boo://pull/<owner>/<repo>/<n>`
 * gives the pull request, `boo://` the list. Any other value gives `undefined`: a notification cannot
 * send the app to a screen that the relay does not name.
 */
export function pathOf(data: unknown): string | undefined {
  const url = typeof data === 'object' && data !== null ? (data as { url?: unknown }).url : undefined;
  if (typeof url !== 'string' || !url.startsWith('boo://')) return undefined;
  const parts = url.slice('boo://'.length).replace(/\/+$/, '').split('/').map(decode);
  if (parts.length === 1 && parts[0] === '') return '/';
  const [screen, owner, repo, number, ...rest] = parts;
  if (screen !== 'pull' || rest.length > 0 || !owner || !repo || !number) return undefined;
  const name = (part: string) => SEGMENT.test(part) && part !== '.' && part !== '..';
  if (!name(owner) || !name(repo) || !/^[1-9]\d{0,9}$/.test(number)) return undefined;
  return `/pull/${owner}/${repo}/${number}`;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A bad escape gives a segment that the check refuses.
    return '%';
  }
}
