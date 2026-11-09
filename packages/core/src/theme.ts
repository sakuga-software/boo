import type { Overall, ReviewerStatus } from './reviewers.js';

export type Background = 'dark' | 'light' | 'unknown';

export interface GhostPalette {
  line: string;
  face: string;
  crown: string;
}

// Each palette gives at least 4.4:1 on its background. The neutral one gives about 3.8:1 on both.
export const GHOST_PALETTES: Record<Background, GhostPalette> = {
  dark: { line: '#A78BFA', face: '#EDE9FE', crown: '#FACC15' },
  light: { line: '#7C3AED', face: '#4C1D95', crown: '#A16207' },
  unknown: { line: '#8B5CF6', face: '#8B5CF6', crown: '#A56F03' },
};

/** The colors of the terminal that the list of boo uses. The mobile app maps each one to a color of its theme. */
export type Tone = 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta' | 'blue';

/** A mark and its tone. `reviewing` turns a spinner in the terminal; its mark is for a screen that has none. */
export interface Mark {
  mark: string;
  tone: Tone;
}

/** The mark of each state of an open pull request. The labels are `OVERALL_LABELS` of report. */
export const OVERALL_MARKS: Record<Overall, Mark> = {
  ready: { mark: '✔', tone: 'green' },
  approved: { mark: '✔', tone: 'green' },
  'changes requested': { mark: '✎', tone: 'red' },
  'checks failing': { mark: '✖', tone: 'red' },
  'reviewer error': { mark: '⚠', tone: 'yellow' },
  conflicts: { mark: '⚠', tone: 'red' },
  reviewing: { mark: '⟳', tone: 'cyan' },
  reviewed: { mark: '●', tone: 'cyan' },
  quota: { mark: '◷', tone: 'yellow' },
  'awaiting review': { mark: '○', tone: 'gray' },
};

/** The mark of a pull request that left the list, and of a draft. */
export const LEFT_MARKS: Record<'merged' | 'closed' | 'draft', Mark> = {
  merged: { mark: '◆', tone: 'magenta' },
  closed: { mark: '○', tone: 'red' },
  draft: { mark: '◌', tone: 'gray' },
};

/** The mark of a pull request that the read failed to read. */
export const ERROR_MARK: Mark = { mark: '✖', tone: 'red' };

/** The mark of each reviewer status. */
export const REVIEWER_MARKS: Record<ReviewerStatus, Mark> = {
  approved: { mark: '✔', tone: 'green' },
  'changes requested': { mark: '✎', tone: 'red' },
  commented: { mark: '●', tone: 'cyan' },
  reviewing: { mark: '⟳', tone: 'cyan' },
  quota: { mark: '◷', tone: 'yellow' },
  'to retry': { mark: '↻', tone: 'blue' },
  requested: { mark: '○', tone: 'magenta' },
  stale: { mark: '◌', tone: 'gray' },
  skipped: { mark: '⊘', tone: 'gray' },
  paused: { mark: '‖', tone: 'gray' },
};
