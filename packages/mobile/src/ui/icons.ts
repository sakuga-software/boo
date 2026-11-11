// The paths of the icons of the mockup "boo mobile, refonte", on a grid of 24.

export interface IconShape {
  d: string;
  /** Filled with the color of the icon, not stroked only. */
  filled?: boolean;
  dash?: string;
  circles?: readonly (readonly [number, number, number])[];
}

export const ICONS = {
  check: { d: 'M5 12.5l4.5 4.5L19 7.5' },
  x: { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' },
  pencil: { d: 'M4 20h4.5L19 9.5 14.5 5 4 15.5zM12.5 7l4.5 4.5' },
  warn: { d: 'M12 4L3 19.5h18zM12 10v4M12 17v.1' },
  reviewing: { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4' },
  dot: { d: 'M7 12a5 5 0 1 0 10 0a5 5 0 1 0-10 0z', filled: true },
  quota: { d: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0zM12 4v8h8' },
  ring: { d: 'M6 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0z' },
  stale: { d: 'M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0z', dash: '3 3.2' },
  merged: { d: 'M12 3.5l8.5 8.5-8.5 8.5L3.5 12z', filled: true },
  zz: { d: 'M4 10h5l-5 6h5M12 5h7l-7 8h7' },
  claude: { d: 'M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18' },
  chevronRight: { d: 'm9 6 6 6-6 6' },
  chevronLeft: { d: 'm15 6-6 6 6 6' },
  external: { d: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' },
  file: { d: 'M14 3H6v18h12V7zM14 3v4h4M9 12h6M12 9v6M9 17h6' },
  lock: { d: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3' },
  retry: { d: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5' },
  play: { d: 'M8 5v14l11-7z' },
  gauge: { d: 'M4 16a8 8 0 0 1 16 0M12 16l4-5' },
  laptop: { d: 'M5 6h14v9H5zM3 18.5h18' },
  stack: { d: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5' },
  wifiOff: { d: 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.3M19 12.5a10 10 0 0 0-3-2M12 20h.01' },
  readAll: { d: 'M2.5 12.5l4.5 4.5L17 7M11.5 16l1 1L22 7.5' },
  bellOff: { d: 'M6 8a6 6 0 0 1 9.5-4.9M18 8c0 7 3 9 3 9H7M3 3l18 18M10.3 21a1.9 1.9 0 0 0 3.4 0' },
  shield: { d: 'M12 3l8 4v5c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V7z' },
  building: { d: 'M4 20V8l8-4 8 4v12M9 20v-6h6v6' },
  people: {
    d: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6',
  },
  repo: { d: 'M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h4' },
  link: { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },
  tabPulls: {
    d: 'M6 8.2v7.6M18 15.8V10a3 3 0 0 0-3-3h-4m2-2-2 2 2 2',
    circles: [
      [6, 6, 2.2],
      [6, 18, 2.2],
      [18, 18, 2.2],
    ],
  },
  tabActivity: { d: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0' },
  tabSettings: {
    d: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12',
    circles: [
      [16, 6, 2],
      [10, 12, 2],
      [18, 18, 2],
    ],
  },
} as const satisfies Record<string, IconShape>;

export type IconName = keyof typeof ICONS;

/** The body of the ghost of boo, and its eyes. */
export const GHOST = {
  body: 'M4 21V11a8 8 0 0 1 16 0v10l-2.7-2-2.6 2L12 19l-2.7 2-2.6-2z',
  eyes: [
    [9.5, 11, 1.2],
    [14.5, 11, 1.2],
  ],
  /** The closed eyes of a ghost at rest: nothing needs the person. */
  restingEyes: 'M8.5 11.5c.6-.6 1.4-.6 2 0M13.5 11.5c.6-.6 1.4-.6 2 0',
} as const;

/** The icon of each mark of the terminal (core `theme.ts`). */
const OF_MARK: Record<string, IconName> = {
  '✔': 'check',
  '✎': 'pencil',
  '✖': 'x',
  '⚠': 'warn',
  '⟳': 'reviewing',
  '↻': 'reviewing',
  '●': 'dot',
  '◷': 'quota',
  '○': 'ring',
  '◆': 'merged',
  '◌': 'stale',
  '⊘': 'stale',
  '‖': 'stale',
};

/** The icon of a mark of the terminal. An unknown mark gets the ring of a pull request that waits. */
export const iconOfMark = (mark: string): IconName => OF_MARK[mark] ?? 'ring';
