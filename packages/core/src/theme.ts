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
