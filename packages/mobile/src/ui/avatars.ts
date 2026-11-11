import { agentName } from '@sakuga-software/boo-core/agents';
import { displayName } from '@sakuga-software/boo-core/reviewers';

/** A round avatar: two letters on a color, or the mark of Claude. */
export interface Avatar {
  mono: string;
  claude: boolean;
  bg: string;
  fg: string;
  name: string;
}

type Scheme = 'light' | 'dark';
type Pair = Record<Scheme, readonly [bg: string, fg: string]>;

const GRAY: Pair = { dark: ['#2C3038', '#D5DAE0'], light: ['#E3E6EA', '#353B44'] };
const GREEN: Pair = { dark: ['#1E3A2E', '#8FE0B5'], light: ['#D9F0E3', '#1D5C3D'] };
const ORANGE: Pair = { dark: ['#3D2A1C', '#F5B985'], light: ['#FBE5D3', '#83400F'] };
const VIOLET: Pair = { dark: ['#2E2440', '#C9B5FB'], light: ['#ECE4FB', '#5B2BB5'] };
const BLUE: Pair = { dark: ['#1C2F45', '#8DBDF5'], light: ['#DDEBFA', '#0B4F99'] };

// The bots of the mockup keep their colors and their letters. Any other account gets a color from its name.
const KNOWN: Record<string, { mono: string; pair: Pair; name?: string }> = {
  copilot: { mono: 'Co', pair: GRAY },
  greptile: { mono: 'Gr', pair: GREEN },
  coderabbitai: { mono: 'CR', pair: ORANGE, name: 'coderabbit' },
  coderabbit: { mono: 'CR', pair: ORANGE },
  'sakuga-review': { mono: 'SR', pair: VIOLET },
  dependabot: { mono: 'De', pair: BLUE },
};
const CYCLE = [GRAY, GREEN, ORANGE, VIOLET, BLUE] as const;

/** Two letters for a name: the initials of `sakuga-review`, or the start of `greptile`. */
export function monogram(name: string): string {
  const parts = name.split(/[-_ .]+/).filter(Boolean);
  if (parts.length > 1) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  const word = parts[0] ?? '?';
  return word[0]!.toUpperCase() + (word[1] ?? '').toLowerCase();
}

function pairOf(name: string): Pair {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CYCLE[hash % CYCLE.length]!;
}

/** The avatar of a reviewer or of any GitHub account, by its login. */
export function accountAvatar(login: string, scheme: Scheme): Avatar {
  const name = displayName(login);
  const known = KNOWN[name.toLowerCase()];
  const [bg, fg] = (known?.pair ?? pairOf(name.toLowerCase()))[scheme];
  return { mono: known?.mono ?? monogram(name), claude: false, bg, fg, name: known?.name ?? name };
}

/**
 * The avatar of the agent of a pull request, by the id that core gives (`agent.kind`). Claude gets its
 * mark on a tint of `claude`, the color of its mark.
 */
export function agentAvatar(kind: string, scheme: Scheme, claude: string, claudeWell: string): Avatar {
  if (kind === 'claude') return { mono: '', claude: true, bg: claudeWell, fg: claude, name: 'Claude' };
  const name = agentName(kind);
  return { ...accountAvatar(name, scheme), name };
}
