import { relayUrl } from '@sakuga-software/boo-core/relay';
import { withAbortReason } from '../relay/connection';

/** The key of the relay that the person chose, in the store of the phone. Missing: the relay of `app.json`. */
export const RELAY_URL_KEY = 'boo.relay.url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Reads the relay URL that a person types: no trailing slash, and https when the scheme is missing, as
 * in the CLI. The GitHub token of the user goes to this relay at the sign-in, so http is refused except
 * on this machine, as core does.
 */
export function checkRelayUrl(input: string): { url: string; error?: undefined } | { error: string } {
  if (!input.trim()) return { error: 'Type the URL of a relay.' };
  const url = relayUrl(input);
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    return { error: `${url} is not a URL.` };
  }
  if (address.protocol === 'http:' && !LOCAL_HOSTS.has(address.hostname))
    return { error: `${url} is not HTTPS: the GitHub authorization would travel in clear text. Use https://.` };
  if (address.username || address.password || address.search || address.hash)
    return { error: `${url} must have no user, no query and no fragment.` };
  return { url };
}

/** Reads a stored relay URL. A value that the check refuses gives `undefined`. */
export function parseStoredRelay(stored: string | null): string | undefined {
  if (!stored) return undefined;
  const checked = checkRelayUrl(stored);
  return checked.error === undefined ? checked.url : undefined;
}

/**
 * Asks the relay at `url` if it is a boo relay, before the app signs out of the current one. No token
 * goes with this call. Returns `undefined` for a boo relay, or the problem.
 */
export async function probeRelay(url: string, fetchFn: typeof fetch, timeoutMs = 15_000): Promise<string | undefined> {
  let response: Response;
  try {
    response = await withAbortReason(fetchFn)(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      return `${url} did not answer in ${timeoutMs / 1000} s.`;
    return `No relay answers at ${url}.`;
  }
  const body = (await response.json().catch(() => undefined)) as { name?: unknown; clientId?: unknown } | undefined;
  if (!response.ok || body?.name !== 'boo-relay' || typeof body.clientId !== 'string' || !body.clientId)
    return `${url} is not a boo relay.`;
  return undefined;
}
