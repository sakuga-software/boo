import type { Tone } from '@sakuga-software/boo-core/theme';

export interface Palette {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  tones: Record<Tone, string>;
}

/**
 * The colors of the app. The tones are the colors of the terminal that the list of boo uses (core
 * gives the tone of each state), in the colors of GitHub: each one gives 4.5:1 or more on `background`
 * and on `surface`.
 */
export const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    background: '#ffffff',
    surface: '#f6f8fa',
    text: '#1f2328',
    muted: '#59636e',
    accent: '#1f883d',
    border: '#d1d9e0',
    tones: {
      green: '#1a7f37',
      red: '#cf222e',
      yellow: '#9a6700',
      cyan: '#1b7c83',
      gray: '#59636e',
      magenta: '#8250df',
      blue: '#0969da',
    },
  },
  dark: {
    background: '#0d1117',
    surface: '#151b23',
    text: '#e6edf3',
    muted: '#9198a1',
    accent: '#238636',
    border: '#3d444d',
    tones: {
      green: '#3fb950',
      red: '#f85149',
      yellow: '#d29922',
      cyan: '#39c5cf',
      gray: '#9198a1',
      magenta: '#ab7df8',
      blue: '#4493f8',
    },
  },
};

/** The color of the mark of a Claude Code agent, as in the terminal. */
export const CLAUDE = '#D77757';
