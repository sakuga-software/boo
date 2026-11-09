import { DEFAULT_RELAY } from '@sakuga-software/boo-core/relay';

/** Where the app signs in. `app.json` gives the values in `expo.extra`; `app.config.js` lets the environment change them. */
export interface RelayConfig {
  relayUrl: string;
  /** Only for a local demo against a fake GitHub: core uses `https://github.com` when it is missing. */
  githubUrl?: string;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Reads `relayUrl` and `githubUrl` from `expo.extra`. With no `relayUrl`, the app uses the relay that Sakuga hosts. */
export function relayConfig(extra: Record<string, unknown> | undefined): RelayConfig {
  const githubUrl = text(extra?.githubUrl);
  return { relayUrl: text(extra?.relayUrl) ?? DEFAULT_RELAY, ...(githubUrl && { githubUrl }) };
}
