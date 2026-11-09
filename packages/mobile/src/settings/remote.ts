import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import type { Settings } from '@sakuga-software/boo-core/settings';
import { withAbortReason } from '../relay/connection';

/** What the relay follows for the user (`GET /settings`): the settings file of boo, and the organization. */
export interface WatchConfig {
  /** The login of an organization or an account, or '' for every account where the App is installed. */
  org: string;
  settings: Settings;
}

/** The answer of the relay to a read or a write of the settings. */
export type SettingsResult =
  | { status: 'ok'; config: WatchConfig }
  /** The relay no longer knows the session (401). */
  | { status: 'expired' }
  | { status: 'failed'; message: string };

const TIMEOUT_MS = 15_000;

/**
 * Calls `/settings` of the relay with the session token. A redirect could send the token to another
 * host, so it is refused. A 401 is a session that the relay no longer knows; any other failure gives a
 * line for the person.
 */
async function call(
  connection: RelayConnection,
  fetchFn: typeof fetch,
  init: RequestInit,
  timeoutMs = TIMEOUT_MS,
): Promise<SettingsResult> {
  let response: Response;
  try {
    response = await withAbortReason(fetchFn)(`${connection.url}/settings`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${connection.session}` },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      return { status: 'failed', message: `The relay did not answer in ${timeoutMs / 1000} s.` };
    return { status: 'failed', message: 'The relay did not answer. Try again later.' };
  }
  if (response.status === 401) return { status: 'expired' };
  const body = (await response.json().catch(() => undefined)) as Partial<WatchConfig> & { error?: unknown };
  if (!response.ok)
    return {
      status: 'failed',
      message: `The relay refused the settings (${response.status})${typeof body?.error === 'string' ? `: ${body.error}` : '.'}`,
    };
  if (typeof body?.org !== 'string' || typeof body.settings !== 'object' || body.settings === null)
    return { status: 'failed', message: 'The answer of the relay is not a settings file.' };
  return { status: 'ok', config: { org: body.org, settings: body.settings } };
}

/** Reads what the relay follows for the user. With no config yet, the relay gives the defaults. */
export const readSettings = (connection: RelayConnection, fetchFn: typeof fetch, timeoutMs?: number) =>
  call(connection, fetchFn, { method: 'GET' }, timeoutMs);

/**
 * Replaces what the relay follows (D6: the settings live on the relay, and the last write wins). The
 * relay takes the whole settings file with `org` beside it, so the fields that this screen does not edit
 * go back as they came.
 */
export const writeSettings = (
  connection: RelayConnection,
  fetchFn: typeof fetch,
  { org, settings }: WatchConfig,
  timeoutMs?: number,
) =>
  call(
    connection,
    fetchFn,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, org }) },
    timeoutMs,
  );
