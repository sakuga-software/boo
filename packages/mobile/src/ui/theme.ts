import type { Tone } from '@sakuga-software/boo-core/theme';

export interface Palette {
  scheme: 'light' | 'dark';
  background: string;
  surface: string;
  /** A second surface: the secondary buttons of a sheet. */
  surface2: string;
  text: string;
  text2: string;
  muted: string;
  /** The line between two rows of a card. */
  line: string;
  /** The tab bar and the action bar at the bottom of a screen. */
  bar: string;
  barLine: string;
  accent: string;
  onAccent: string;
  accentText: string;
  /** The eyes of the ghost. */
  ghostEye: string;
  /** The shadow of a card. Undefined: the card has none. */
  cardShadow: string | undefined;
  /** The track of a segmented control, and its selected segment. */
  track: string;
  segOn: string;
  segShadow: string | undefined;
  switchOff: string;
  /** An empty dot of a score. */
  pipOff: string;
  disabledBg: string;
  disabledFg: string;
  overlay: string;
  grabber: string;
  /** A notice: its text, its ground, and the ground of its button. */
  noticeText: string;
  noticeBg: string;
  noticeButton: string;
  /** The Merge pill of a row. */
  greenText: string;
  greenPill: string;
  /** The zZ badge of a stalled pull request. */
  zzBg: string;
  zzFg: string;
  toastBg: string;
  toastFg: string;
  toastAccent: string;
  avatarBg: string;
  avatarFg: string;
  /** The color of the mark of a Claude Code agent. */
  claude: string;
  /** The colors of the terminal tones that core gives to each state. */
  tones: Record<Tone, string>;
}

/**
 * The colors of the app, from the mockup "boo mobile, refonte". The tones are the colors of GitHub that
 * the terminal uses: each one gives 4.5:1 or more on `background` and on `surface`. On the light
 * background of the mockup, four tones of GitHub gave less: they are a little darker here.
 */
export const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    scheme: 'light',
    background: '#F2EFF7',
    surface: '#FFFFFF',
    surface2: '#EEEAF5',
    text: '#1C1726',
    text2: '#3F384D',
    muted: '#5F5870',
    line: '#EEEAF3',
    bar: '#FFFFFF',
    barLine: '#E2DCEB',
    accent: '#7C3AED',
    onAccent: '#FFFFFF',
    accentText: '#6D28D9',
    ghostEye: '#4C1D95',
    cardShadow: '0 1px 2px rgba(60,40,100,0.06)',
    track: '#E8E3F0',
    segOn: '#FFFFFF',
    segShadow: '0 1px 3px rgba(28,23,38,0.12)',
    switchOff: '#D9D3E3',
    pipOff: '#DDD7E6',
    disabledBg: '#E8E3F0',
    disabledFg: '#5F5870',
    overlay: 'rgba(28,23,38,0.42)',
    grabber: '#D9D3E3',
    noticeText: '#6E4A00',
    noticeBg: '#FBF1D9',
    noticeButton: '#F3E2B5',
    greenText: '#116329',
    greenPill: '#DDF4E3',
    zzBg: '#9A6700',
    zzFg: '#FFFFFF',
    toastBg: '#1C1726',
    toastFg: '#FFFFFF',
    toastAccent: '#C4B5FD',
    avatarBg: '#EDE7FB',
    avatarFg: '#6D28D9',
    claude: '#B4532F',
    tones: {
      green: '#1A7C36',
      red: '#CF222E',
      yellow: '#946300',
      cyan: '#1A7880',
      gray: '#59636E',
      magenta: '#7E4CDA',
      blue: '#0969DA',
    },
  },
  dark: {
    scheme: 'dark',
    background: '#120F18',
    surface: '#1B1724',
    surface2: '#252030',
    text: '#EEEAF6',
    text2: '#CFC8DC',
    muted: '#A59EB5',
    line: '#2A2436',
    bar: '#17131F',
    barLine: '#2F2940',
    accent: '#A78BFA',
    onAccent: '#120F18',
    accentText: '#C4B5FD',
    ghostEye: '#EDE9FE',
    cardShadow: undefined,
    track: '#221D2C',
    segOn: '#2E2740',
    segShadow: undefined,
    switchOff: '#3A3348',
    pipOff: '#3A3348',
    disabledBg: '#221D2C',
    disabledFg: '#968EAA',
    overlay: 'rgba(6,4,10,0.72)',
    grabber: '#3A3348',
    noticeText: '#E7C468',
    noticeBg: 'rgba(210,153,34,0.12)',
    noticeButton: 'rgba(210,153,34,0.2)',
    greenText: '#56D364',
    greenPill: 'rgba(63,185,80,0.16)',
    zzBg: '#D29922',
    zzFg: '#120F18',
    toastBg: '#EEEAF6',
    toastFg: '#120F18',
    toastAccent: '#6D28D9',
    avatarBg: '#2A2338',
    avatarFg: '#C4B5FD',
    claude: '#D77757',
    tones: {
      green: '#3FB950',
      red: '#F85149',
      yellow: '#D29922',
      cyan: '#39C5CF',
      gray: '#9198A1',
      magenta: '#AB7DF8',
      blue: '#4493F8',
    },
  },
};

/** `hex` (`#RRGGBB`) with the opacity `alpha`. */
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const WELL_ALPHA = { dark: { normal: 0.14, strong: 0.18 }, light: { normal: 0.1, strong: 0.12 } } as const;

/** The ground of an icon in the color `color`: a well, as the mockup draws it behind each state. */
export const well = (palette: Palette, color: string, strong = false) =>
  tint(color, WELL_ALPHA[palette.scheme][strong ? 'strong' : 'normal']);
