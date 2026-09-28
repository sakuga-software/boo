import type { Settings } from "./settings.js";

export interface Layout {
  /** The column with the name of the state, such as "ready to merge". Without it, the row shows the icon only. */
  label: boolean;
  checks: boolean;
  /** "12/12" in place of "✔ 12/12 checks". */
  shortChecks: boolean;
  counts: boolean;
  lastReview: boolean;
  marks: boolean;
  details: boolean;
  /** The blank lines after each row. */
  gap: number;
  /** The width of the columns before the pull request name. The lines under a row start there. */
  indent: number;
  /** The action bar shows the key of each button and no label. */
  shortBar: boolean;
}

const SELECTION_WIDTH = 2;
const ICON_WIDTH = 3;
export const LABEL_WIDTH = 19;

/**
 * Picks the parts of a row that fit in the terminal width. The settings can turn a part off at any
 * width. A narrow terminal also drops parts, from the least useful:
 * - below 120 columns: the reviewers on head and the review count;
 * - below 100 columns: the name of the state, and the word "checks";
 * - below 80 columns: the last reviewer, and the labels of the action bar;
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
    counts: settings.counts && width >= 120,
    lastReview: settings.lastReview && width >= 80,
    marks: settings.marks,
    details: settings.details,
    gap: settings.compact ? 0 : 1,
    indent: (interactive ? SELECTION_WIDTH : 0) + ICON_WIDTH + (label ? LABEL_WIDTH : 0),
    shortBar: width < 80,
  };
}

export interface RowShape {
  summary: boolean;
  detail: boolean;
  posted: boolean;
}

/** The height of a row, in lines. The scroll range needs the same height as the rendered row. */
export function rowHeight(row: RowShape, layout: Layout): number {
  const reviewers = row.summary && (layout.lastReview || layout.marks);
  return 1 + (reviewers ? 1 : 0) + (row.detail && layout.details ? 1 : 0) + (row.posted ? 1 : 0) + layout.gap;
}
