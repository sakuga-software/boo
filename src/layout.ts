import type { Settings } from './settings.js';

export interface Layout {
  /** The column with the name of the state, such as "ready to merge". Without it, the row shows the icon only. */
  label: boolean;
  checks: boolean;
  /** "12/12" in place of "✔ 12/12 checks". */
  shortChecks: boolean;
  /** The reviewers on head and the review count, in the details. */
  counts: boolean;
  lastReview: boolean;
  marks: boolean;
  /** The mark of the agent on the line of the pull request, and its line in the details. */
  agent: boolean;
  /** The name of the session or of the agent after its mark. */
  agentName: boolean;
  details: boolean;
  /** The place of the pull request in its stack, such as "on #921 · 2/3". */
  stack: boolean;
  /** The blank lines after each row. */
  gap: number;
  /** The width of the columns before the pull request name. The lines under a row start there. */
  indent: number;
  /** The action bar shows the key of each button and no label. */
  shortBar: boolean;
}

export const SELECTION_WIDTH = 2;
export const ICON_WIDTH = 3;
export const LABEL_WIDTH = 19;

/**
 * Picks the parts of a row that fit in the terminal width. The settings can turn a part off at any
 * width. A narrow terminal also drops parts, from the least useful:
 * - below 100 columns: the name of the state, the word "checks", the name after the mark of the agent,
 *   and the labels of the action bar;
 * - below 80 columns: the last reviewer and the place in the stack;
 * - below 60 columns: the checks.
 * A piped run has no width, so it shows every part that the settings allow.
 */
export function layoutFor(columns: number, settings: Settings, interactive: boolean): Layout {
  const width = interactive ? columns : Infinity;
  const label = width >= 100;
  return {
    label,
    checks: settings.checks && width >= 60,
    shortChecks: width < 100,
    counts: settings.counts,
    lastReview: settings.lastReview && width >= 80,
    marks: settings.marks,
    agent: settings.agent,
    agentName: width >= 100,
    details: settings.details,
    stack: width >= 80,
    gap: settings.compact ? 0 : 1,
    indent: (interactive ? SELECTION_WIDTH : 0) + ICON_WIDTH + (label ? LABEL_WIDTH : 0),
    shortBar: width < 100,
  };
}

export interface RowShape {
  /** The lines of the details that the row shows: none for a folded row. */
  details: number;
  posted: boolean;
}

/** The height of a row, in lines. The scroll range needs the same height as the rendered row. */
export function rowHeight(row: RowShape, layout: Layout): number {
  return 1 + row.details + (row.posted ? 1 : 0) + layout.gap;
}
